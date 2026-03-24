/**
 * ShareFilePreview.tsx
 * 分享页面文件预览组件
 *
 * 功能:
 * - 图片/视频/音频预览
 * - PDF文档预览
 * - 文本/代码预览
 * - Markdown 渲染预览
 * - Office文档预览（Word/Excel本地渲染）
 * - 缩放控制和窗口尺寸切换
 * - 支持单文件分享和文件夹分享中的子文件预览
 */

import { useEffect, useState, useRef, useCallback } from 'react';
import { renderAsync } from 'docx-preview';
import * as XLSX from 'xlsx';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  X,
  Download,
  FileText,
  Volume2,
  FileSpreadsheet,
  Presentation,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Minimize2,
  RotateCcw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FileIcon } from '@/components/ui/FileIcon';
import { shareApi } from '@/services/api';
import { formatBytes, decodeFileName } from '@/utils';
import { cn } from '@/utils';

interface PreviewInfo {
  id: string;
  name: string;
  size: number;
  mimeType: string | null;
  previewType: string;
  canPreview: boolean;
}

interface ShareFilePreviewProps {
  shareId: string;
  file: {
    id: string;
    name: string;
    size: number;
    mimeType: string | null;
  };
  password?: string;
  isChildFile?: boolean;
  onClose: () => void;
  onDownload: () => void;
}

type WindowSize = 'small' | 'medium' | 'large' | 'fullscreen';

const WINDOW_SIZE_CONFIG: Record<WindowSize, { width: string; height: string; maxWidth: string }> = {
  small: { width: '60vw', height: '70vh', maxWidth: '800px' },
  medium: { width: '80vw', height: '85vh', maxWidth: '1200px' },
  large: { width: '90vw', height: '90vh', maxWidth: '1600px' },
  fullscreen: { width: '100vw', height: '100vh', maxWidth: '100vw' },
};

export function ShareFilePreview({
  shareId,
  file,
  password,
  isChildFile = false,
  onClose,
  onDownload,
}: ShareFilePreviewProps) {
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [previewInfo, setPreviewInfo] = useState<PreviewInfo | null>(null);
  const [officeLoading, setOfficeLoading] = useState(false);
  const [officeError, setOfficeError] = useState<string | null>(null);
  const [excelData, setExcelData] = useState<XLSX.WorkSheet | null>(null);
  const [excelLoading, setExcelLoading] = useState(false);
  const [excelWorkbook, setExcelWorkbook] = useState<XLSX.WorkBook | null>(null);
  const [activeSheetName, setActiveSheetName] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const docxContainerRef = useRef<HTMLDivElement>(null);

  const [zoomLevel, setZoomLevel] = useState(100);
  const [windowSize, setWindowSize] = useState<WindowSize>('medium');

  const mimeType = file.mimeType;
  const isImage = mimeType?.startsWith('image/');
  const isVideo = mimeType?.startsWith('video/');
  const isAudio = mimeType?.startsWith('audio/');
  const isPdf = mimeType === 'application/pdf';
  const isMarkdown = mimeType === 'text/markdown' || file.name.endsWith('.md');
  const isText =
    mimeType?.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml' ||
    mimeType === 'application/javascript' ||
    mimeType === 'application/typescript';
  const isWord =
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimeType === 'application/msword';
  const isExcel =
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.ms-excel';
  const isPpt =
    mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    mimeType === 'application/vnd.ms-powerpoint';
  const isOffice = isWord || isExcel || isPpt;

  const canPreview = isImage || isVideo || isAudio || isPdf || isText || isMarkdown || isOffice;

  useEffect(() => {
    setLoadError(false);
    setTextContent(null);
    setPreviewInfo(null);
    setOfficeLoading(false);
    setOfficeError(null);
    setExcelData(null);
    setExcelLoading(false);
    setExcelWorkbook(null);
    setActiveSheetName(null);
    setZoomLevel(100);
    setWindowSize('medium');
  }, [shareId, file.id, password]);

  useEffect(() => {
    if ((!isText && !isMarkdown) || !canPreview) return;

    const fetchTextContent = async () => {
      try {
        const res = isChildFile
          ? await shareApi.getChildRawContent(shareId, file.id, password)
          : await shareApi.getRawContent(shareId, password);
        if (res.data.data?.content) {
          setTextContent(res.data.data.content);
        }
      } catch {
        setLoadError(true);
      }
    };

    fetchTextContent();
  }, [shareId, file.id, password, isText, isMarkdown, canPreview, isChildFile]);

  const getPreviewUrl = () => {
    if (isChildFile) {
      if (isVideo || isAudio) {
        return shareApi.childStreamUrl(shareId, file.id, password);
      }
      return shareApi.childPreviewUrl(shareId, file.id, password);
    }
    if (isVideo || isAudio) {
      return shareApi.streamUrl(shareId, password);
    }
    return shareApi.previewUrl(shareId, password);
  };

  const loadDocxPreview = useCallback(async () => {
    if (!isWord || !docxContainerRef.current) return;

    setOfficeLoading(true);
    setOfficeError(null);

    try {
      const response = await fetch(getPreviewUrl());
      if (!response.ok) {
        throw new Error(`文件加载失败: ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();

      if (!docxContainerRef.current) {
        throw new Error('容器不可用');
      }

      if (arrayBuffer.byteLength === 0) {
        throw new Error('文件内容为空');
      }

      docxContainerRef.current.innerHTML = '';

      await renderAsync(arrayBuffer, docxContainerRef.current, undefined, {
        className: 'docx-preview-wrapper',
        inWrapper: true,
        ignoreWidth: false,
        ignoreHeight: false,
        ignoreFonts: false,
        breakPages: true,
        ignoreLastRenderedPageBreak: true,
        experimental: false,
        trimXmlDeclaration: true,
        useBase64URL: true,
        renderHeaders: true,
        renderFooters: true,
        renderFootnotes: true,
        renderEndnotes: true,
      });

      const renderedContent = docxContainerRef.current.querySelector('.docx-preview-wrapper');
      if (!renderedContent || docxContainerRef.current.children.length === 0) {
        throw new Error('文档渲染结果为空');
      }
    } catch (err) {
      console.error('DOCX preview error:', err);
      setOfficeError(err instanceof Error ? err.message : '文档预览失败，请下载查看');
    } finally {
      setOfficeLoading(false);
    }
  }, [isWord, shareId, file.id, password, isChildFile]);

  const loadExcelPreview = useCallback(async () => {
    if (!isExcel) return;

    setExcelLoading(true);
    try {
      const response = await fetch(getPreviewUrl());
      if (!response.ok) {
        throw new Error(`文件加载失败: ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer, { type: 'array' });
      setExcelWorkbook(workbook);
      const firstSheetName = workbook.SheetNames[0];
      if (firstSheetName) {
        setActiveSheetName(firstSheetName);
        const worksheet = workbook.Sheets[firstSheetName] || null;
        setExcelData(worksheet);
      } else {
        setLoadError(true);
      }
    } catch (err) {
      console.error('Excel preview error:', err);
      setLoadError(true);
    } finally {
      setExcelLoading(false);
    }
  }, [isExcel, shareId, file.id, password, isChildFile]);

  const handleSheetChange = useCallback(
    (sheetName: string) => {
      if (!excelWorkbook) return;
      setActiveSheetName(sheetName);
      const worksheet = excelWorkbook.Sheets[sheetName] || null;
      setExcelData(worksheet);
    },
    [excelWorkbook]
  );

  const handleZoomIn = useCallback(() => {
    setZoomLevel((prev) => Math.min(prev + 25, 200));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoomLevel((prev) => Math.max(prev - 25, 50));
  }, []);

  const handleZoomReset = useCallback(() => {
    setZoomLevel(100);
  }, []);

  const handleToggleFullscreen = useCallback(() => {
    setWindowSize((prev) => (prev === 'fullscreen' ? 'medium' : 'fullscreen'));
  }, []);

  const cycleWindowSize = useCallback(() => {
    setWindowSize((prev) => {
      const sizes: WindowSize[] = ['small', 'medium', 'large', 'fullscreen'];
      const currentIndex = sizes.indexOf(prev);
      const nextIndex = (currentIndex + 1) % sizes.length;
      return sizes[nextIndex] as WindowSize;
    });
  }, []);

  useEffect(() => {
    if (isWord) {
      loadDocxPreview();
    }
  }, [isWord, loadDocxPreview]);

  useEffect(() => {
    if (isExcel) {
      loadExcelPreview();
    }
  }, [isExcel, loadExcelPreview]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const getOfficeIcon = () => {
    if (!mimeType) return <FileText className="h-6 w-6" />;
    if (mimeType.includes('word') || mimeType.includes('document')) return <FileText className="h-6 w-6" />;
    if (mimeType.includes('excel') || mimeType.includes('sheet')) return <FileSpreadsheet className="h-6 w-6" />;
    if (mimeType.includes('powerpoint') || mimeType.includes('presentation'))
      return <Presentation className="h-6 w-6" />;
    return <FileText className="h-6 w-6" />;
  };

  const getOfficeTypeName = () => {
    if (isWord) return 'Word 文档';
    if (isExcel) return 'Excel 表格';
    if (isPpt) return 'PowerPoint 演示文稿';
    return 'Office 文档';
  };

  const renderExcelTable = () => {
    if (!excelData) return null;
    const html = XLSX.utils.sheet_to_html(excelData, { editable: false });
    const styledHtml = html
      .replace('<table>', '<table style="border-collapse: collapse; width: 100%; font-size: 13px;">')
      .replace(
        /<td/g,
        '<td style="border: 1px solid #e5e7eb; padding: 6px 10px; text-align: left; vertical-align: top;"'
      )
      .replace(
        /<th/g,
        '<th style="border: 1px solid #d1d5db; padding: 8px 10px; background-color: #f3f4f6; font-weight: 600; text-align: left;"'
      );
    return (
      <div
        className="w-full h-full overflow-auto bg-white dark:bg-gray-900 p-4"
        style={{ transform: `scale(${zoomLevel / 100})`, transformOrigin: 'top left' }}
      >
        <div dangerouslySetInnerHTML={{ __html: styledHtml }} />
      </div>
    );
  };

  const renderOfficeFallback = (message?: string) => (
    <div className="flex items-center justify-center h-full">
      <div className="text-center py-12 px-6 space-y-4">
        <div className="w-16 h-16 mx-auto rounded-xl bg-primary/10 flex items-center justify-center">
          {getOfficeIcon()}
        </div>
        <div>
          <p className="font-medium">{decodeFileName(file.name)}</p>
          <p className="text-sm text-muted-foreground mt-1">{getOfficeTypeName()}</p>
          <p className="text-xs text-muted-foreground mt-2">{message || '暂不支持在线预览，请下载查看'}</p>
        </div>
        <Button onClick={onDownload}>
          <Download className="h-4 w-4 mr-2" />
          下载文件
        </Button>
      </div>
    </div>
  );

  const sizeConfig = WINDOW_SIZE_CONFIG[windowSize];
  const showZoomControls = isText || isMarkdown || isExcel || isWord;
  const showSheetTabs = isExcel && excelWorkbook && excelWorkbook.SheetNames.length > 1;

  return (
    <div
      ref={overlayRef}
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm',
        windowSize === 'fullscreen' ? 'p-0' : 'p-4'
      )}
      onClick={(e) => e.target === overlayRef.current && onClose()}
    >
      <div
        className={cn(
          'relative flex flex-col bg-card border rounded-xl shadow-2xl overflow-hidden transition-all duration-300',
          windowSize === 'fullscreen' ? 'rounded-none' : ''
        )}
        style={{
          width: sizeConfig.width,
          height: sizeConfig.height,
          maxWidth: sizeConfig.maxWidth,
        }}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b flex-shrink-0">
          <FileIcon mimeType={mimeType} isFolder={false} size="sm" />
          <div className="flex-1 min-w-0">
            <p className="font-medium truncate text-sm">{decodeFileName(file.name)}</p>
            <p className="text-xs text-muted-foreground">
              {formatBytes(file.size)}
              {previewInfo?.previewType && previewInfo.previewType !== 'unknown' && (
                <span className="ml-2 opacity-60">({previewInfo.previewType})</span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {showZoomControls && (
              <div className="flex items-center gap-0.5 mr-2 px-2 py-1 bg-muted/50 rounded-md">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  title="缩小"
                  onClick={handleZoomOut}
                  disabled={zoomLevel <= 50}
                >
                  <ZoomOut className="h-3.5 w-3.5" />
                </Button>
                <span className="text-xs min-w-[40px] text-center">{zoomLevel}%</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  title="放大"
                  onClick={handleZoomIn}
                  disabled={zoomLevel >= 200}
                >
                  <ZoomIn className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="h-6 w-6" title="重置缩放" onClick={handleZoomReset}>
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              title={windowSize === 'fullscreen' ? '退出全屏' : '全屏'}
              onClick={handleToggleFullscreen}
            >
              {windowSize === 'fullscreen' ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" title="切换窗口大小" onClick={cycleWindowSize}>
              <span className="text-xs font-medium">
                {windowSize === 'small' ? 'S' : windowSize === 'medium' ? 'M' : windowSize === 'large' ? 'L' : 'F'}
              </span>
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" title="下载" onClick={onDownload}>
              <Download className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" title="关闭" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {showSheetTabs && (
          <div className="flex items-center gap-1 px-4 py-2 border-b bg-muted/30 overflow-x-auto flex-shrink-0">
            {excelWorkbook.SheetNames.map((name) => (
              <button
                key={name}
                onClick={() => handleSheetChange(name)}
                className={cn(
                  'px-3 py-1.5 text-xs rounded-md whitespace-nowrap transition-colors',
                  activeSheetName === name
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted hover:bg-muted/80 text-muted-foreground'
                )}
              >
                {name}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 overflow-auto min-h-0">
          {loadError ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center py-12 text-muted-foreground px-6">
                <FileText className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <p>预览加载失败</p>
              </div>
            </div>
          ) : !canPreview ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center py-12 px-6 space-y-4">
                <FileIcon mimeType={mimeType} size="lg" className="mx-auto" />
                <div>
                  <p className="font-medium">{decodeFileName(file.name)}</p>
                  <p className="text-sm text-muted-foreground mt-1">{formatBytes(file.size)}</p>
                  <p className="text-sm text-muted-foreground">{mimeType || '未知类型'}</p>
                </div>
                <Button onClick={onDownload}>
                  <Download className="h-4 w-4 mr-2" />
                  下载文件
                </Button>
              </div>
            </div>
          ) : isImage ? (
            <div className="flex items-center justify-center h-full overflow-auto p-4">
              <img
                src={getPreviewUrl()}
                alt={decodeFileName(file.name)}
                className="max-w-full max-h-full object-contain"
                style={{ transform: `scale(${zoomLevel / 100})` }}
                onError={() => setLoadError(true)}
              />
            </div>
          ) : isVideo ? (
            <div className="flex items-center justify-center h-full">
              <video
                src={getPreviewUrl()}
                controls
                className="max-w-full max-h-full"
                onError={() => setLoadError(true)}
              />
            </div>
          ) : isAudio ? (
            <div className="flex items-center justify-center h-full">
              <div className="p-8 w-full max-w-md space-y-4">
                <div className="flex items-center justify-center">
                  <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
                    <Volume2 className="h-10 w-10 text-primary" />
                  </div>
                </div>
                <p className="text-center font-medium">{decodeFileName(file.name)}</p>
                <audio src={getPreviewUrl()} controls className="w-full" onError={() => setLoadError(true)} />
              </div>
            </div>
          ) : isPdf ? (
            <iframe
              src={getPreviewUrl()}
              className="w-full h-full border-0"
              title={decodeFileName(file.name)}
              onError={() => setLoadError(true)}
            />
          ) : isMarkdown ? (
            <div
              className="w-full h-full overflow-auto p-6 prose dark:prose-invert max-w-none"
              style={{ fontSize: `${zoomLevel}%` }}
            >
              {textContent !== null ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{textContent}</ReactMarkdown>
              ) : (
                <div className="flex items-center justify-center h-full">
                  <p className="text-center text-muted-foreground text-sm py-8">加载中...</p>
                </div>
              )}
            </div>
          ) : isText ? (
            <div className="w-full h-full overflow-auto p-4" style={{ fontSize: `${zoomLevel}%` }}>
              {textContent !== null ? (
                <pre
                  className={cn(
                    'text-xs font-mono whitespace-pre-wrap leading-relaxed',
                    previewInfo?.previewType === 'code' ? 'text-green-600 dark:text-green-400' : 'text-foreground/80'
                  )}
                >
                  {textContent}
                </pre>
              ) : (
                <div className="flex items-center justify-center h-full">
                  <p className="text-center text-muted-foreground text-sm py-8">加载中...</p>
                </div>
              )}
            </div>
          ) : isOffice ? (
            <div className="w-full h-full flex flex-col relative">
              {isWord ? (
                <>
                  {officeLoading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-white/80 dark:bg-gray-900/80 z-10">
                      <div className="text-muted-foreground text-sm">正在渲染文档...</div>
                    </div>
                  )}
                  {officeError && (
                    <div className="absolute inset-0 flex items-center justify-center z-10">
                      {renderOfficeFallback(officeError)}
                    </div>
                  )}
                  <div
                    ref={docxContainerRef}
                    className={cn(
                      'w-full h-full overflow-auto bg-white dark:bg-gray-900',
                      officeLoading || officeError ? 'opacity-0' : 'opacity-100'
                    )}
                    style={{ transform: `scale(${zoomLevel / 100})`, transformOrigin: 'top left' }}
                  />
                </>
              ) : isExcel ? (
                <>
                  {excelLoading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-white/80 dark:bg-gray-900/80 z-10">
                      <div className="text-muted-foreground text-sm">正在加载表格...</div>
                    </div>
                  )}
                  {loadError ? (
                    <div className="absolute inset-0 flex items-center justify-center z-10">
                      {renderOfficeFallback('Excel 加载失败')}
                    </div>
                  ) : (
                    renderExcelTable()
                  )}
                </>
              ) : isPpt ? (
                renderOfficeFallback('PowerPoint 暂不支持在线预览')
              ) : (
                renderOfficeFallback()
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
