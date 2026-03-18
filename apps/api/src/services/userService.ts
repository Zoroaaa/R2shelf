/**
 * services/user.service.ts
 * 用户服务层
 *
 * 功能:
 * - 用户CRUD操作封装
 * - 密码管理
 * - 会话管理
 * - 权限验证
 */

import { eq, and } from 'drizzle-orm';
import { getDb, users, webdavSessions, loginAttempts, auditLogs } from '../db';
import { hashPassword, verifyPassword, createJWT, verifyJWT } from '../lib/crypto';
import type { Env } from '../types/env';

type DbType = ReturnType<typeof getDb>;

export interface UserCreateParams {
  email: string;
  password: string;
  name?: string;
  role?: string;
}

export interface UserUpdateParams {
  name?: string;
  email?: string;
  role?: string;
  storageQuota?: number;
}

export interface LoginResult {
  success: boolean;
  user?: {
    id: string;
    email: string;
    name: string | null;
    role: string;
  };
  token?: string;
  error?: string;
}

export class UserService {
  private db: DbType;
  private jwtSecret: string;

  constructor(env: Env) {
    this.db = getDb(env.DB);
    this.jwtSecret = env.JWT_SECRET;
  }

  async findById(userId: string) {
    return this.db.select().from(users).where(eq(users.id, userId)).get();
  }

  async findByEmail(email: string) {
    return this.db.select().from(users).where(eq(users.email, email.toLowerCase())).get();
  }

  async create(params: UserCreateParams) {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    const existing = await this.findByEmail(params.email);
    if (existing) {
      throw new Error('邮箱已被注册');
    }

    const hashedPassword = await hashPassword(params.password);

    const [newUser] = await this.db
      .insert(users)
      .values({
        id,
        email: params.email.toLowerCase(),
        passwordHash: hashedPassword,
        name: params.name ?? null,
        role: params.role ?? 'user',
        storageUsed: 0,
        storageQuota: 10737418240,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return newUser;
  }

  async update(userId: string, params: UserUpdateParams) {
    const now = new Date().toISOString();
    const updateData: Record<string, unknown> = { updatedAt: now };

    if (params.name !== undefined) updateData.name = params.name;
    if (params.email !== undefined) updateData.email = params.email.toLowerCase();
    if (params.role !== undefined) updateData.role = params.role;
    if (params.storageQuota !== undefined) updateData.storageQuota = params.storageQuota;

    const [updated] = await this.db.update(users).set(updateData).where(eq(users.id, userId)).returning();

    return updated;
  }

  async login(email: string, password: string, clientIp?: string, userAgent?: string): Promise<LoginResult> {
    const user = await this.findByEmail(email);

    if (!user) {
      await this.recordLoginAttempt(email, clientIp, false, userAgent);
      return { success: false, error: '邮箱或密码错误' };
    }

    const isLocked = await this.checkLoginLock(email);
    if (isLocked) {
      return { success: false, error: '账户已锁定，请稍后再试' };
    }

    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
      await this.recordLoginAttempt(email, clientIp, false, userAgent);
      return { success: false, error: '邮箱或密码错误' };
    }

    await this.recordLoginAttempt(email, clientIp, true, userAgent);

    const token = await createJWT(
      {
        userId: user.id,
        email: user.email,
        role: user.role,
      },
      this.jwtSecret,
    );

    return {
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      token,
    };
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<{ success: boolean; error?: string }> {
    const user = await this.findById(userId);
    if (!user) {
      return { success: false, error: '用户不存在' };
    }

    const isValid = await verifyPassword(oldPassword, user.passwordHash);
    if (!isValid) {
      return { success: false, error: '原密码错误' };
    }

    const hashedPassword = await hashPassword(newPassword);
    const now = new Date().toISOString();

    await this.db.update(users).set({ passwordHash: hashedPassword, updatedAt: now }).where(eq(users.id, userId));

    return { success: true };
  }

  async updateStorageUsed(userId: string, deltaBytes: number) {
    const user = await this.findById(userId);
    if (!user) return;

    const newStorageUsed = Math.max(0, user.storageUsed + deltaBytes);
    const now = new Date().toISOString();

    await this.db.update(users).set({ storageUsed: newStorageUsed, updatedAt: now }).where(eq(users.id, userId));
  }

  async verifyToken(token: string) {
    return verifyJWT(token, this.jwtSecret);
  }

  private async checkLoginLock(email: string): Promise<boolean> {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const attempts = await this.db
      .select()
      .from(loginAttempts)
      .where(and(eq(loginAttempts.email, email.toLowerCase()), eq(loginAttempts.success, false)))
      .all();

    const recentFailures = attempts.filter((a) => a.createdAt >= fiveMinutesAgo);

    return recentFailures.length >= 5;
  }

  private async recordLoginAttempt(email: string, clientIp?: string, success: boolean, userAgent?: string) {
    const now = new Date().toISOString();

    await this.db.insert(loginAttempts).values({
      id: crypto.randomUUID(),
      email: email.toLowerCase(),
      ipAddress: clientIp ?? 'unknown',
      success,
      userAgent: userAgent ?? null,
      createdAt: now,
    });
  }
}

export function createUserService(env: Env): UserService {
  return new UserService(env);
}
