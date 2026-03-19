/**
 * useFileDragDrop.ts
 * 文件拖拽处理 Hook
 *
 * 功能:
 * - 处理文件拖拽上传
 * - 处理文件夹拖拽上传
 * - 拖拽状态管理
 */

import { useState, useCallback } from 'react';
import type { UseMutationResult } from '@tanstack/react-query';
import { useFolderUpload } from '@/hooks/useFolderUpload';
import { useToast } from '@/components/ui/use-toast';
import { useQueryClient } from '@tanstack/react-query';

interface UploadMutationParams {
  file: File;
  parentId: string | null;
}

interface UseFileDragDropProps {
  folderId: string | null;
  uploadMutation: UseMutationResult<any, any, UploadMutationParams, any>;
  setUploadProgresses: React.Dispatch<React.SetStateAction<Record<string, number>>>;
}

export function useFileDragDrop({ folderId, uploadMutation, setUploadProgresses }: UseFileDragDropProps) {
  const [isDragActive, setIsDragActive] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { uploadFolderEntriesDirect } = useFolderUpload({
    currentFolderId: folderId ?? undefined,
    onFileStart: (name, key) => setUploadProgresses((p) => ({ ...p, [key]: 0 })),
    onFileProgress: (key, progress) => setUploadProgresses((p) => ({ ...p, [key]: progress })),
    onFileDone: (key) => {
      setUploadProgresses((p) => {
        const n = { ...p };
        delete n[key];
        return n;
      });
      toast({ title: '上传成功' });
    },
    onFileError: (key, e: any) => {
      setUploadProgresses((p) => {
        const n = { ...p };
        delete n[key];
        return n;
      });
      toast({ title: '上传失败', description: e?.response?.data?.error?.message, variant: 'destructive' });
    },
    onAllDone: () => {
      queryClient.invalidateQueries({ queryKey: ['files'] });
      queryClient.invalidateQueries({ queryKey: ['stats'] });
    },
  });

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragActive(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragActive(false);

      const items = e.dataTransfer.items;
      if (!items || items.length === 0) return;

      const entries: FileSystemEntry[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const entry = item?.webkitGetAsEntry?.();
        if (entry) entries.push(entry);
      }

      const hasFolder = entries.some((e) => e.isDirectory);

      if (hasFolder) {
        uploadFolderEntriesDirect(entries);
      } else {
        Array.from(e.dataTransfer.files).forEach((file) => {
          uploadMutation.mutate({ file, parentId: folderId || null });
        });
      }
    },
    [folderId, uploadMutation, uploadFolderEntriesDirect]
  );

  return {
    isDragActive,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  };
}
