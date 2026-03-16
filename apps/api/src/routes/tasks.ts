import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { getDb, uploadTasks, users, storageBuckets } from '../db';
import { authMiddleware } from '../middleware/auth';
import { ERROR_CODES, MAX_FILE_SIZE, UPLOAD_TASK_EXPIRY, MULTIPART_THRESHOLD, UPLOAD_CHUNK_SIZE } from '@osshelf/shared';
import type { Env, Variables } from '../types/env';
import { z } from 'zod';
import {
  s3PresignUrl,
  s3PresignUploadPart,
  s3CreateMultipartUpload,
  s3CompleteMultipartUpload,
  s3AbortMultipartUpload,
  s3ListParts,
  s3UploadPart,
  type MultipartPart,
} from '../lib/s3client';
import { resolveBucketConfig, updateBucketStats, checkBucketQuota } from '../lib/bucketResolver';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', authMiddleware);

const UPLOAD_EXPIRY = 3600;

const createTaskSchema = z.object({
  fileName: z.string().min(1, '文件名不能为空').max(1024),
  fileSize: z.number().int().min(1).max(MAX_FILE_SIZE),
  mimeType: z.string().optional().default('application/octet-stream'),
  parentId: z.string().nullable().optional(),
  bucketId: z.string().nullable().optional(),
});

const uploadPartSchema = z.object({
  taskId: z.string().min(1),
  partNumber: z.number().int().min(1).max(10000),
});

const completeTaskSchema = z.object({
  taskId: z.string().min(1),
  parts: z.array(z.object({
    partNumber: z.number().int().min(1),
    etag: z.string().min(1),
  })).min(1),
});

async function getUserOrFail(db: ReturnType<typeof getDb>, userId: string) {
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw new Error('用户不存在');
  return user;
}

app.post('/create', async (c) => {
  const userId = c.get('userId')!;
  const body = await c.req.json();
  const result = createTaskSchema.safeParse(body);
  if (!result.success) {
    return c.json({ success: false, error: { code: ERROR_CODES.VALIDATION_ERROR, message: result.error.errors[0].message } }, 400);
  }

  const { fileName, fileSize, mimeType, parentId, bucketId: requestedBucketId } = result.data;
  const db = getDb(c.env.DB);
  const encKey = c.env.JWT_SECRET || 'ossshelf-key';

  const user = await getUserOrFail(db, userId);
  if (user.storageUsed + fileSize > user.storageQuota) {
    return c.json({ success: false, error: { code: ERROR_CODES.STORAGE_EXCEEDED, message: '用户存储配额已满' } }, 400);
  }

  const bucketConfig = await resolveBucketConfig(db, userId, encKey, requestedBucketId, parentId);
  if (!bucketConfig) {
    return c.json({ success: false, error: { code: 'NO_STORAGE', message: '未配置存储桶' } }, 400);
  }

  const quotaErr = await checkBucketQuota(db, bucketConfig.id, fileSize);
  if (quotaErr) {
    return c.json({ success: false, error: { code: ERROR_CODES.STORAGE_EXCEEDED, message: quotaErr } }, 400);
  }

  const taskId = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  const r2Key = `files/${userId}/${fileId}/${encodeFilename(fileName)}`;
  const totalParts = Math.ceil(fileSize / UPLOAD_CHUNK_SIZE);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + UPLOAD_TASK_EXPIRY).toISOString();

  const uploadId = await s3CreateMultipartUpload(bucketConfig, r2Key, mimeType || 'application/octet-stream');

  await db.insert(uploadTasks).values({
    id: taskId,
    userId,
    fileName,
    fileSize,
    mimeType: mimeType || null,
    parentId: parentId || null,
    bucketId: bucketConfig.id,
    r2Key,
    uploadId,
    totalParts,
    uploadedParts: '[]',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    expiresAt,
  });

  const firstPartUrl = await s3PresignUploadPart(bucketConfig, r2Key, uploadId, 1, UPLOAD_EXPIRY);

  return c.json({
    success: true,
    data: {
      taskId,
      fileId,
      uploadId,
      r2Key,
      bucketId: bucketConfig.id,
      totalParts,
      partSize: UPLOAD_CHUNK_SIZE,
      firstPartUrl,
      expiresAt,
    },
  });
});

app.get('/list', async (c) => {
  const userId = c.get('userId')!;
  const db = getDb(c.env.DB);

  const tasks = await db.select().from(uploadTasks)
    .where(eq(uploadTasks.userId, userId))
    .all();

  const activeTasks = tasks.filter((t) => t.status !== 'completed' && t.status !== 'expired');
  const now = new Date();
  const validTasks = activeTasks.filter((t) => new Date(t.expiresAt) > now);

  return c.json({
    success: true,
    data: validTasks.map((t) => ({
      ...t,
      uploadedParts: JSON.parse(t.uploadedParts || '[]'),
    })),
  });
});

app.get('/:taskId', async (c) => {
  const userId = c.get('userId')!;
  const taskId = c.req.param('taskId');
  const db = getDb(c.env.DB);
  const encKey = c.env.JWT_SECRET || 'ossshelf-key';

  const task = await db.select().from(uploadTasks)
    .where(and(eq(uploadTasks.id, taskId), eq(uploadTasks.userId, userId)))
    .get();

  if (!task) {
    return c.json({ success: false, error: { code: ERROR_CODES.NOT_FOUND, message: '任务不存在' } }, 404);
  }

  if (task.status === 'completed') {
    return c.json({ success: true, data: { ...task, uploadedParts: JSON.parse(task.uploadedParts || '[]') } });
  }

  if (new Date(task.expiresAt) < new Date()) {
    await db.update(uploadTasks).set({ status: 'expired', updatedAt: new Date().toISOString() }).where(eq(uploadTasks.id, taskId));
    return c.json({ success: false, error: { code: ERROR_CODES.TASK_EXPIRED, message: '上传任务已过期' } }, 410);
  }

  const bucketConfig = await resolveBucketConfig(db, userId, encKey, task.bucketId, null);
  if (!bucketConfig) {
    return c.json({ success: false, error: { code: 'NO_STORAGE', message: '存储桶配置不存在' } }, 400);
  }

  let uploadedParts: number[] = [];
  try {
    const parts = await s3ListParts(bucketConfig, task.r2Key, task.uploadId);
    uploadedParts = parts.map((p) => p.partNumber);
    await db.update(uploadTasks)
      .set({ uploadedParts: JSON.stringify(uploadedParts), status: 'uploading', updatedAt: new Date().toISOString() })
      .where(eq(uploadTasks.id, taskId));
  } catch (e) {
    console.error('List parts error:', e);
  }

  return c.json({
    success: true,
    data: {
      ...task,
      uploadedParts,
    },
  });
});

app.post('/part', async (c) => {
  const userId = c.get('userId')!;
  const body = await c.req.json();
  const result = uploadPartSchema.safeParse(body);
  if (!result.success) {
    return c.json({ success: false, error: { code: ERROR_CODES.VALIDATION_ERROR, message: result.error.errors[0].message } }, 400);
  }

  const { taskId, partNumber } = result.data;
  const db = getDb(c.env.DB);
  const encKey = c.env.JWT_SECRET || 'ossshelf-key';

  const task = await db.select().from(uploadTasks)
    .where(and(eq(uploadTasks.id, taskId), eq(uploadTasks.userId, userId)))
    .get();

  if (!task) {
    return c.json({ success: false, error: { code: ERROR_CODES.NOT_FOUND, message: '任务不存在' } }, 404);
  }

  if (task.status === 'completed') {
    return c.json({ success: false, error: { code: ERROR_CODES.VALIDATION_ERROR, message: '任务已完成' } }, 400);
  }

  if (new Date(task.expiresAt) < new Date()) {
    return c.json({ success: false, error: { code: ERROR_CODES.TASK_EXPIRED, message: '上传任务已过期' } }, 410);
  }

  const bucketConfig = await resolveBucketConfig(db, userId, encKey, task.bucketId, null);
  if (!bucketConfig) {
    return c.json({ success: false, error: { code: 'NO_STORAGE', message: '存储桶配置不存在' } }, 400);
  }

  const partUrl = await s3PresignUploadPart(bucketConfig, task.r2Key, task.uploadId, partNumber, UPLOAD_EXPIRY);

  return c.json({ success: true, data: { partUrl, partNumber, expiresIn: UPLOAD_EXPIRY } });
});

app.post('/part-proxy', async (c) => {
  const userId = c.get('userId')!;
  const contentType = c.req.header('Content-Type') || '';

  if (!contentType.includes('multipart/form-data')) {
    return c.json({ success: false, error: { code: ERROR_CODES.VALIDATION_ERROR, message: '请使用 multipart/form-data 格式' } }, 400);
  }

  const formData = await c.req.formData();
  const taskId = formData.get('taskId') as string;
  const partNumber = parseInt(formData.get('partNumber') as string, 10);
  const chunk = formData.get('chunk') as File | null;

  if (!taskId || !partNumber || !chunk) {
    return c.json({ success: false, error: { code: ERROR_CODES.VALIDATION_ERROR, message: '缺少必要参数' } }, 400);
  }

  const db = getDb(c.env.DB);
  const encKey = c.env.JWT_SECRET || 'ossshelf-key';

  const task = await db.select().from(uploadTasks)
    .where(and(eq(uploadTasks.id, taskId), eq(uploadTasks.userId, userId)))
    .get();

  if (!task) {
    return c.json({ success: false, error: { code: ERROR_CODES.NOT_FOUND, message: '任务不存在' } }, 404);
  }

  if (new Date(task.expiresAt) < new Date()) {
    return c.json({ success: false, error: { code: ERROR_CODES.TASK_EXPIRED, message: '上传任务已过期' } }, 410);
  }

  const bucketConfig = await resolveBucketConfig(db, userId, encKey, task.bucketId, null);
  if (!bucketConfig) {
    return c.json({ success: false, error: { code: 'NO_STORAGE', message: '存储桶配置不存在' } }, 400);
  }

  const chunkBuffer = await chunk.arrayBuffer();
  const etag = await s3UploadPart(bucketConfig, task.r2Key, task.uploadId, partNumber, chunkBuffer);

  const uploadedParts = JSON.parse(task.uploadedParts || '[]');
  if (!uploadedParts.includes(partNumber)) {
    uploadedParts.push(partNumber);
    await db.update(uploadTasks)
      .set({ uploadedParts: JSON.stringify(uploadedParts), status: 'uploading', updatedAt: new Date().toISOString() })
      .where(eq(uploadTasks.id, taskId));
  }

  return c.json({ success: true, data: { partNumber, etag } });
});

app.post('/complete', async (c) => {
  const userId = c.get('userId')!;
  const body = await c.req.json();
  const result = completeTaskSchema.safeParse(body);
  if (!result.success) {
    return c.json({ success: false, error: { code: ERROR_CODES.VALIDATION_ERROR, message: result.error.errors[0].message } }, 400);
  }

  const { taskId, parts } = result.data;
  const db = getDb(c.env.DB);
  const encKey = c.env.JWT_SECRET || 'ossshelf-key';

  const task = await db.select().from(uploadTasks)
    .where(and(eq(uploadTasks.id, taskId), eq(uploadTasks.userId, userId)))
    .get();

  if (!task) {
    return c.json({ success: false, error: { code: ERROR_CODES.NOT_FOUND, message: '任务不存在' } }, 404);
  }

  if (task.status === 'completed') {
    return c.json({ success: true, data: { message: '任务已完成', taskId } });
  }

  if (new Date(task.expiresAt) < new Date()) {
    return c.json({ success: false, error: { code: ERROR_CODES.TASK_EXPIRED, message: '上传任务已过期' } }, 410);
  }

  const bucketConfig = await resolveBucketConfig(db, userId, encKey, task.bucketId, task.parentId);
  if (!bucketConfig) {
    return c.json({ success: false, error: { code: 'NO_STORAGE', message: '存储桶配置不存在' } }, 400);
  }

  const fileId = crypto.randomUUID();
  const now = new Date().toISOString();
  const path = task.parentId ? `${task.parentId}/${task.fileName}` : `/${task.fileName}`;

  await s3CompleteMultipartUpload(bucketConfig, task.r2Key, task.uploadId, parts as MultipartPart[]);

  const { files } = await import('../db');
  await db.insert(files).values({
    id: fileId,
    userId,
    parentId: task.parentId,
    name: task.fileName,
    path,
    type: 'file',
    size: task.fileSize,
    r2Key: task.r2Key,
    mimeType: task.mimeType,
    hash: null,
    isFolder: false,
    bucketId: task.bucketId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (user) {
    await db.update(users)
      .set({ storageUsed: user.storageUsed + task.fileSize, updatedAt: now })
      .where(eq(users.id, userId));
  }

  await updateBucketStats(db, task.bucketId!, task.fileSize, 1);

  await db.update(uploadTasks)
    .set({ status: 'completed', updatedAt: now })
    .where(eq(uploadTasks.id, taskId));

  return c.json({
    success: true,
    data: {
      id: fileId,
      name: task.fileName,
      size: task.fileSize,
      mimeType: task.mimeType,
      path,
      bucketId: task.bucketId,
      createdAt: now,
    },
  });
});

app.post('/abort', async (c) => {
  const userId = c.get('userId')!;
  const body = await c.req.json();
  const taskId = body.taskId as string;

  if (!taskId) {
    return c.json({ success: false, error: { code: ERROR_CODES.VALIDATION_ERROR, message: '缺少任务ID' } }, 400);
  }

  const db = getDb(c.env.DB);
  const encKey = c.env.JWT_SECRET || 'ossshelf-key';

  const task = await db.select().from(uploadTasks)
    .where(and(eq(uploadTasks.id, taskId), eq(uploadTasks.userId, userId)))
    .get();

  if (!task) {
    return c.json({ success: false, error: { code: ERROR_CODES.NOT_FOUND, message: '任务不存在' } }, 404);
  }

  if (task.status === 'completed') {
    return c.json({ success: false, error: { code: ERROR_CODES.VALIDATION_ERROR, message: '任务已完成，无法中止' } }, 400);
  }

  const bucketConfig = await resolveBucketConfig(db, userId, encKey, task.bucketId, null);
  if (bucketConfig) {
    try {
      await s3AbortMultipartUpload(bucketConfig, task.r2Key, task.uploadId);
    } catch (e) {
      console.error('Abort multipart upload error:', e);
    }
  }

  await db.update(uploadTasks)
    .set({ status: 'failed', updatedAt: new Date().toISOString() })
    .where(eq(uploadTasks.id, taskId));

  return c.json({ success: true, data: { message: '上传已中止' } });
});

app.delete('/:taskId', async (c) => {
  const userId = c.get('userId')!;
  const taskId = c.req.param('taskId');
  const db = getDb(c.env.DB);

  const task = await db.select().from(uploadTasks)
    .where(and(eq(uploadTasks.id, taskId), eq(uploadTasks.userId, userId)))
    .get();

  if (!task) {
    return c.json({ success: false, error: { code: ERROR_CODES.NOT_FOUND, message: '任务不存在' } }, 404);
  }

  await db.delete(uploadTasks).where(eq(uploadTasks.id, taskId));

  return c.json({ success: true, data: { message: '任务已删除' } });
});

function encodeFilename(name: string): string {
  return name.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
}

export default app;
