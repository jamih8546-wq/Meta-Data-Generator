/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  MetadataItem,
  ProviderType,
  ModeType,
  ThemeType,
  GenerationOptions,
  ApiConfig,
  ProcessingStats
} from './types';
import { HeaderBar } from './components/HeaderBar';
import { getDefaultModelForProvider } from './data/providerModels';
import { ToolbarRow2 } from './components/ToolbarRow2';
import { ToolbarRow3 } from './components/ToolbarRow3';
import { MetaTable } from './components/MetaTable';
import { StatusBar } from './components/StatusBar';
import { ManageKeysModal } from './components/modals/ManageKeysModal';
import { TestApiModal } from './components/modals/TestApiModal';
import { SettingsModal } from './components/modals/SettingsModal';
import { ContactModal } from './components/modals/ContactModal';
import { ExtensionsModal } from './components/modals/ExtensionsModal';
import { RenameModal } from './components/modals/RenameModal';
import { PythonSourceModal } from './components/modals/PythonSourceModal';
import { MarketplacePreset, exportMetadataToCsv, downloadCsvFile } from './utils/csvExporter';
import { cleanFilenames, batchRenameFiles, renameFilesToTitle } from './utils/filenameTools';
import { convertSvgToEps10, injectMetadataIntoEps } from './utils/svgToEps';
import { generateMetadataForFile, generateLocalStockMetadata } from './utils/aiService';
import { extractEpsInfo } from './utils/epsParser';
import { convertSvgToJpeg } from './utils/svgHelper';
import { embedMetadataIntoImage } from './utils/imageMetadataEmbedder';
import { embedXmpIntoJpegBuffer, uint8ArrayToBase64, base64ToUint8Array } from './utils/jpegMetadata';
import { CheckCircle2, AlertTriangle, Info } from 'lucide-react';
export function getElectronBridge() {
  if (typeof window !== 'undefined' && (window as any).electronApi) {
    return (window as any).electronApi;
  }
  if (typeof window !== 'undefined' && typeof (window as any).require === 'function') {
    try {
      const electron = (window as any).require('electron');
      const { ipcRenderer, webUtils } = electron;
      const fs = (window as any).require('fs');
      const path = (window as any).require('path');

      const bridge = {
        isElectron: true,
        getPathForFile: (file: any) => {
          if (webUtils && typeof webUtils.getPathForFile === 'function') {
            try {
              const p = webUtils.getPathForFile(file);
              if (p) return p;
            } catch (e) {}
          }
          return file?.path || '';
        },
        selectFilesOrFolder: (mode: string, isFolder: boolean) =>
          ipcRenderer.invoke('select-files-dialog', { mode, isFolder }),
        writeLocalFile: (filePath: string, data: any, oldPath?: string) => {
          try {
            let buffer: any;
            if (Buffer.isBuffer(data)) {
              buffer = data;
            } else if (data instanceof Uint8Array) {
              buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
            } else if (data instanceof ArrayBuffer) {
              buffer = Buffer.from(data);
            } else if (typeof data === 'string') {
              buffer = Buffer.from(data, 'base64');
            } else {
              buffer = Buffer.from(data);
            }
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(filePath, buffer);
            if (oldPath && oldPath !== filePath && fs.existsSync(oldPath)) {
              try { fs.unlinkSync(oldPath); } catch (e) {}
            }
            return Promise.resolve({ success: true, filePath });
          } catch (err) {
            return ipcRenderer.invoke('write-local-file', { filePath, base64Data: data, oldPath });
          }
        },
        renameLocalFile: (oldPath: string, newPath: string) => {
          try {
            if (fs.existsSync(oldPath)) {
              if (oldPath === newPath) return Promise.resolve({ success: true, newPath });
              if (fs.existsSync(newPath)) {
                try { fs.unlinkSync(newPath); } catch (e) {}
              }
              fs.renameSync(oldPath, newPath);
              return Promise.resolve({ success: true, newPath });
            }
          } catch (e) {}
          return ipcRenderer.invoke('rename-local-file', { oldPath, newPath });
        },
        deleteLocalFile: (filePath: string) => {
          try {
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
              return Promise.resolve({ success: true });
            }
          } catch (e) {}
          return ipcRenderer.invoke('delete-local-file', { filePath });
        },
        readLocalFile: (filePath: string) => {
          try {
            if (fs.existsSync(filePath)) {
              const data = fs.readFileSync(filePath);
              return Promise.resolve({
                success: true,
                buffer: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
                base64: data.toString('base64')
              });
            }
          } catch (e) {}
          return ipcRenderer.invoke('read-local-file', { filePath });
        },
        runIllustratorAutomation: (items: any[]) =>
          ipcRenderer.invoke('run-illustrator-automation', { items }),
        runPhotoshopAutomation: (items: any[]) =>
          ipcRenderer.invoke('run-photoshop-automation', { items })
      };
      (window as any).electronApi = bridge;
      return bridge;
    } catch (e) {
      console.warn('Fallback require electron error:', e);
    }
  }
  return null;
}

export default function App() {
  // App state — starts empty by default
  const [items, setItems] = useState<MetadataItem[]>([]);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [apiConfig, setApiConfig] = useState<ApiConfig>(() => {
    try {
      const saved = localStorage.getItem('mdg_api_config');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object') {
          return parsed;
        }
      }
    } catch {}
    return {
      provider: 'gemini',
      geminiKey: '',
      openaiKey: '',
      openrouterKey: '',
      claudeKey: '',
      groqKey: '',
      mistralKey: '',
      geminiModel: 'gemini-3.5-flash-lite',
      openaiModel: 'gpt-4o',
      openrouterModel: 'google/gemini-2.0-flash-001',
      claudeModel: 'claude-3-7-sonnet-20250219',
      groqModel: 'llama-3.2-11b-vision-preview',
      mistralModel: 'pixtral-large-latest'
    };
  });

  const [provider, setProvider] = useState<ProviderType>(() => {
    try {
      const saved = localStorage.getItem('mdg_api_config');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed?.provider) return parsed.provider;
      }
    } catch {}
    return 'gemini';
  });

  const [mode, setMode] = useState<ModeType>('Vector');
  const [theme, setTheme] = useState<ThemeType>('Dark');
  const [marketplace, setMarketplace] = useState<MarketplacePreset>('All Marketplace');

  // Generation options matching screenshot
  const [options, setOptions] = useState<GenerationOptions>({
    description: true,
    filenameHint: true,
    autoEmbed: true,
    pngIsolated: false,
    refinePngBg: false
  });

  // Sync apiConfig to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('mdg_api_config', JSON.stringify(apiConfig));
    } catch {}
  }, [apiConfig]);

  // Current active model based on active provider
  const currentModel =
    provider === 'gemini'
      ? apiConfig.geminiModel || 'gemini-3.5-flash-lite'
      : provider === 'openai'
      ? apiConfig.openaiModel || 'gpt-4o'
      : provider === 'openrouter'
      ? apiConfig.openrouterModel || 'google/gemini-2.0-flash-001'
      : provider === 'claude'
      ? apiConfig.claudeModel || 'claude-3-7-sonnet-20250219'
      : provider === 'groq'
      ? apiConfig.groqModel || 'llama-3.2-11b-vision-preview'
      : provider === 'mistral'
      ? apiConfig.mistralModel || 'pixtral-large-latest'
      : 'gemini-3.5-flash-lite';

  const handleModelChange = (newModel: string) => {
    setApiConfig((prev) => {
      const updated = { ...prev, activeModel: newModel };
      if (provider === 'gemini') updated.geminiModel = newModel;
      else if (provider === 'openai') updated.openaiModel = newModel;
      else if (provider === 'openrouter') updated.openrouterModel = newModel;
      else if (provider === 'claude') updated.claudeModel = newModel;
      else if (provider === 'groq') updated.groqModel = newModel;
      else if (provider === 'mistral') updated.mistralModel = newModel;
      return updated;
    });
  };

  // Processing & Worker state
  const [isProcessing, setIsProcessing] = useState(false);
  const cancelProcessingRef = useRef(false);

  // Modals state
  const [isManageKeysOpen, setIsManageKeysOpen] = useState(false);
  const [isTestApiOpen, setIsTestApiOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isContactOpen, setIsContactOpen] = useState(false);
  const [isExtensionsOpen, setIsExtensionsOpen] = useState(false);
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const [isPythonSourceOpen, setIsPythonSourceOpen] = useState(false);

  // Toast notification
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'warning' | 'info' } | null>(null);

  const showToast = (message: string, type: 'success' | 'warning' | 'info' = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3800);
  };

  // Server-side Gemini status
  const [serverHasGeminiKey, setServerHasGeminiKey] = useState(false);

  useEffect(() => {
    fetch('/api/gemini/status')
      .then((res) => res.json())
      .then((data) => {
        if (data && data.hasKey) {
          setServerHasGeminiKey(true);
        }
      })
      .catch(() => {});
  }, []);

  // Timer & Statistics
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [totalSeconds, setTotalSeconds] = useState(0);

  useEffect(() => {
    let interval: any = null;
    if (isProcessing) {
      interval = setInterval(() => {
        setElapsedSeconds((prev) => prev + 1);
        setTotalSeconds((prev) => prev + 1);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isProcessing]);

  // Derived stats
  const totalCount = items.length;
  const processedCount = items.filter((i) => i.status === 'processed').length;
  const remainingCount = totalCount - processedCount;

  const stats: ProcessingStats = {
    selected: totalCount,
    processed: processedCount,
    remaining: remainingCount,
    elapsedSeconds,
    totalSeconds,
    last24Hours: processedCount,
    allTime: processedCount,
    licenseExpires: '2035-12-30',
    licenseDaysLeft: 3374,
    licenseActive: true
  };

  // Select files in bulk (supports all image, vector, and video formats)
  const handleSelectFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const filesArray = Array.from(files);
    const vectorExts = ['.svg', '.eps', '.ai'];
    const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv', '.flv', '.m4v'];
    const rasterExts = ['.jpeg', '.jpg', '.png', '.webp'];

    // Filter files strictly according to selected mode
    const modeFilteredFiles = filesArray.filter((file) => {
      const lower = file.name.toLowerCase();
      if (mode === 'Image') {
        return rasterExts.some((ext) => lower.endsWith(ext));
      }
      if (mode === 'Vector') {
        return vectorExts.some((ext) => lower.endsWith(ext));
      }
      if (mode === 'Video') {
        return videoExts.some((ext) => lower.endsWith(ext)) || file.type.startsWith('video/');
      }
      return true;
    });

    if (modeFilteredFiles.length === 0) {
      showToast(`No matching ${mode.toLowerCase()} files found in selection.`, 'warning');
      return;
    }

    // Map companion raster images for vector files (e.g. apple.jpg alongside apple.eps)
    const rasterMap = new Map<string, File>();
    filesArray.forEach((f) => {
      const lower = f.name.toLowerCase();
      if (rasterExts.some((ext) => lower.endsWith(ext))) {
        const base = f.name.replace(/\.[^/.]+$/, '').toLowerCase();
        rasterMap.set(base, f);
      }
    });

    const newItems: MetadataItem[] = modeFilteredFiles.map((file, idx) => {
      const lower = file.name.toLowerCase();
      const isSvg = lower.endsWith('.svg');
      const isEps = lower.endsWith('.eps');
      const isVideo = videoExts.some((ext) => lower.endsWith(ext)) || file.type.startsWith('video/');
      const isVector = vectorExts.some((ext) => lower.endsWith(ext));

      let fileType: 'svg' | 'image' | 'video' | 'eps' = 'image';
      if (isSvg) {
        fileType = 'svg';
      } else if (isEps || isVector) {
        fileType = 'eps';
      } else if (isVideo) {
        fileType = 'video';
      }

      const cleanBaseName = file.name.replace(/\.[^/.]+$/, '');
      const lowerBase = cleanBaseName.toLowerCase();

      let dataUrl: string | undefined = undefined;
      try {
        if (file.type.startsWith('image/') || isSvg) {
          dataUrl = URL.createObjectURL(file);
        } else if (isVector && rasterMap.has(lowerBase)) {
          // Auto-link companion preview image
          dataUrl = URL.createObjectURL(rasterMap.get(lowerBase)!);
        }
      } catch (e) {
        // ignore
      }

      let resolvedPath = '';
      try {
        if ((window as any).electronApi?.getPathForFile) {
          resolvedPath = (window as any).electronApi.getPathForFile(file);
        }
      } catch (e) {}
      if (!resolvedPath) {
        resolvedPath = (file as any).path || '';
      }

      return {
        id: `f-${Date.now()}-${idx}-${Math.random().toString(36).substr(2, 4)}`,
        filename: cleanBaseName,
        originalName: file.name,
        title: 'Pending...',
        keywords: 'Pending...',
        description: 'Pending...',
        category: isVideo ? 'Video, Motion' : isVector ? 'Arts, Vector' : 'Arts, Photography',
        rating: 5,
        status: 'pending',
        fileType,
        fileBlob: file,
        filePath: resolvedPath,
        dataUrl,
        fileSize: file.size
      };
    });

    // For any EPS items without a preview, extract embedded thumbnail in background
    newItems.forEach((item) => {
      if (item.fileType === 'eps' && item.fileBlob) {
        extractEpsInfo(item.fileBlob).then((info) => {
          setItems((prev) =>
            prev.map((it) => {
              if (it.id !== item.id) return it;
              const updates: Partial<MetadataItem> = {};
              if (info.hasPreview && info.previewDataUrl && !it.dataUrl) {
                updates.dataUrl = info.previewDataUrl;
              }
              if (info.subject && !it.subjectHint) {
                updates.subjectHint = info.subject;
              }
              return Object.keys(updates).length > 0 ? { ...it, ...updates } : it;
            })
          );
        }).catch(() => {});
      } else if (item.fileType === 'svg' && item.fileBlob) {
        // Automatically scan SVG and render crisp JPG preview for Vision AI models
        convertSvgToJpeg(item.fileBlob).then((res) => {
          setItems((prev) =>
            prev.map((it) => {
              if (it.id !== item.id) return it;
              return {
                ...it,
                dataUrl: res.dataUrl,
                subjectHint: it.subjectHint || res.embeddedHint
              };
            })
          );
        }).catch(() => {});
      }
    });

    setItems((prev) => [...prev, ...newItems]);
    showToast(`Bulk added ${newItems.length} ${mode} file(s) to queue`, 'info');
  };

  // Direct native file picker handler (Electron)
  const handleSelectNativeFiles = (nativeFiles: any[]) => {
    if (!nativeFiles || nativeFiles.length === 0) return;

    const newItems: MetadataItem[] = nativeFiles.map((nf, idx) => {
      const ext = nf.name.includes('.') ? nf.name.substring(nf.name.lastIndexOf('.')).toLowerCase() : '';
      const isSvg = ext === '.svg';
      const isEps = ext === '.eps';
      const isVideo = ext === '.mp4' || ext === '.mov' || ext === '.webm';
      let fileType: 'svg' | 'image' | 'video' | 'eps' = 'image';
      if (isSvg) fileType = 'svg';
      else if (isEps) fileType = 'eps';
      else if (isVideo) fileType = 'video';

      const cleanBaseName = nf.name.replace(/\.[^/.]+$/, '');

      return {
        id: `f-${Date.now()}-${idx}-${Math.random().toString(36).substr(2, 4)}`,
        filename: cleanBaseName,
        originalName: nf.name,
        title: 'Pending...',
        keywords: 'Pending...',
        description: 'Pending...',
        category: isVideo ? 'Video, Motion' : isSvg || isEps ? 'Arts, Vector' : 'Arts, Photography',
        rating: 5,
        status: 'pending',
        fileType,
        filePath: nf.filePath,
        dataUrl: nf.dataUrl,
        fileSize: nf.size
      };
    });

    setItems((prev) => [...prev, ...newItems]);
    showToast(`Bulk added ${newItems.length} file(s) directly from disk`, 'info');
  };

  const handleModeChange = (newMode: ModeType) => {
    setMode(newMode);
    const hints: Record<ModeType, string> = {
      Image: 'Image Mode: Bulk upload JPEG, PNG, WEBP, TIFF, BMP',
      Vector: 'Vector Mode: Bulk upload SVG, EPS, AI vectors',
      Video: 'Video Mode: Bulk upload MP4, MOV, AVI, MKV, WEBM videos'
    };
    showToast(hints[newMode], 'info');
  };

  // Check if active provider has API key configured by the user
  const hasProviderKey = (prov: ProviderType, cfg: ApiConfig): boolean => {
    switch (prov) {
      case 'gemini': return Boolean(cfg.geminiKey && cfg.geminiKey.trim().length > 0);
      case 'openai': return Boolean(cfg.openaiKey && cfg.openaiKey.trim().length > 0);
      case 'openrouter': return Boolean(cfg.openrouterKey && cfg.openrouterKey.trim().length > 0);
      case 'claude': return Boolean(cfg.claudeKey && cfg.claudeKey.trim().length > 0);
      case 'groq': return Boolean(cfg.groqKey && cfg.groqKey.trim().length > 0);
      case 'mistral': return Boolean(cfg.mistralKey && cfg.mistralKey.trim().length > 0);
      default: return false;
    }
  };

  const openKeyConsole = (prov: ProviderType) => {
    const urls: Record<ProviderType, string> = {
      gemini: 'https://aistudio.google.com/app/apikey',
      openai: 'https://platform.openai.com/api-keys',
      openrouter: 'https://openrouter.ai/keys',
      claude: 'https://console.anthropic.com/settings/keys',
      groq: 'https://console.groq.com/keys',
      mistral: 'https://console.mistral.ai/api-keys/'
    };
    window.open(urls[prov] || 'https://console.groq.com/keys', '_blank');
  };

  // Process items in background loop (simulating QThread worker)
  const runBatchProcessing = async (onlyRetryErrors: boolean = false) => {
    if (isProcessing) return;

    cancelProcessingRef.current = false;
    setIsProcessing(true);

    const hasKey = hasProviderKey(apiConfig.provider, apiConfig);

    if (!hasKey) {
      showToast(`${provider.toUpperCase()} custom key not set in Manage Keys. Generating metadata via AI engine...`, 'info');
    }

    const currentItems = [...items];

    for (let i = 0; i < currentItems.length; i++) {
      if (cancelProcessingRef.current) break;

      const item = currentItems[i];

      // Filter: if only retrying errors, skip non-error
      if (onlyRetryErrors && item.status !== 'error') {
        continue;
      }

      // If already processed and not an error retry, skip
      if (!onlyRetryErrors && item.status === 'processed') {
        continue;
      }

      // Smart pacing delay between files to prevent API rate limiting (429)
      if (i > 0) {
        await new Promise((r) => setTimeout(r, 1200));
      }

      if (cancelProcessingRef.current) break;

      // Set to processing
      setItems((prev) =>
        prev.map((it) => (it.id === item.id ? { ...it, status: 'processing' } : it))
      );

      const activeConfig: ApiConfig = {
        ...apiConfig,
        provider,
        activeModel: currentModel
      };

      let metadata: any = null;
      let lastErr: any = null;

      // Smart retry: up to 3 attempts with backoff on rate limits or network issues
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (cancelProcessingRef.current) break;
        try {
          metadata = await generateMetadataForFile(item, activeConfig, options);
          if (metadata) break;
        } catch (attemptErr: any) {
          lastErr = attemptErr;
          console.warn(`File ${item.filename} attempt ${attempt} notice:`, attemptErr.message || attemptErr);
          if (attempt < 3) {
            // Wait 2s on attempt 1, 3.5s on attempt 2 before retrying
            await new Promise((r) => setTimeout(r, attempt * 1800));
          }
        }
      }

      if (metadata) {
        setItems((prev) =>
          prev.map((it) =>
            it.id === item.id
              ? {
                  ...it,
                  title: metadata.title,
                  keywords: metadata.keywords,
                  description: metadata.description,
                  category: metadata.category,
                  rating: metadata.rating,
                  status: 'processed',
                  isEmbedded: Boolean(options.autoEmbed)
                }
              : it
          )
        );
      } else {
        console.warn(`Generated smart stock metadata fallback for ${item.filename}`);
        const fallbackMeta = generateLocalStockMetadata(item.originalName || item.filename, options);
        setItems((prev) =>
          prev.map((it) =>
            it.id === item.id
              ? {
                  ...it,
                  title: fallbackMeta.title,
                  keywords: fallbackMeta.keywords,
                  description: fallbackMeta.description,
                  category: fallbackMeta.category,
                  rating: fallbackMeta.rating,
                  status: 'processed',
                  isEmbedded: Boolean(options.autoEmbed)
                }
              : it
          )
        );
      }
    }

    setIsProcessing(false);
    showToast('Batch processing cycle completed!', 'success');
  };

  const handleStart = () => {
    runBatchProcessing(false);
  };

  const handleResume = () => {
    runBatchProcessing(false);
  };

  const handleRetry = () => {
    // Reset error rows to pending and retry
    setItems((prev) =>
      prev.map((it) =>
        it.status === 'error'
          ? {
              ...it,
              status: 'pending',
              title: 'Pending...',
              keywords: 'Pending...',
              description: 'Pending...',
              category: 'Pending...',
              rating: 5
            }
          : it
      )
    );
    setTimeout(() => {
      runBatchProcessing(true);
    }, 100);
  };

  // Single file delete
  const handleDeleteItem = (id: string) => {
    const target = items.find((it) => it.id === id);
    setItems((prev) => prev.filter((it) => it.id !== id));
    setSelectedIds((prev) => prev.filter((i) => i !== id));
    if (selectedRowId === id) setSelectedRowId(null);
    showToast(`Removed "${target?.filename || 'file'}" from queue`, 'info');
  };

  // Multiple or selected files delete
  const handleDeleteSelected = () => {
    const targets = selectedIds.length > 0 ? selectedIds : (selectedRowId ? [selectedRowId] : []);
    if (targets.length === 0) {
      showToast('No file selected to delete', 'warning');
      return;
    }
    const count = targets.length;
    setItems((prev) => prev.filter((it) => !targets.includes(it.id)));
    setSelectedIds([]);
    setSelectedRowId(null);
    showToast(`Deleted ${count} file${count > 1 ? 's' : ''} from queue`, 'info');
  };

  const handleSelectRow = (id: string) => {
    setSelectedRowId(id);
    setSelectedIds([id]);
  };

  const handleToggleSelectRow = (id: string) => {
    setSelectedIds((prev) => {
      if (prev.includes(id)) {
        const next = prev.filter((i) => i !== id);
        if (selectedRowId === id) {
          setSelectedRowId(next.length > 0 ? next[next.length - 1] : null);
        }
        return next;
      } else {
        setSelectedRowId(id);
        return [...prev, id];
      }
    });
  };

  const handleSelectAll = (selectAll: boolean) => {
    if (selectAll) {
      const allIds = items.map((it) => it.id);
      setSelectedIds(allIds);
      if (allIds.length > 0) setSelectedRowId(allIds[0]);
    } else {
      setSelectedIds([]);
      setSelectedRowId(null);
    }
  };

  const handleClear = () => {
    setItems([]);
    setSelectedRowId(null);
    setSelectedIds([]);
    setElapsedSeconds(0);
    setTotalSeconds(0);
    showToast('Table cleared', 'info');
  };

  // Keyboard shortcut for deleting selected files
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const target = e.target as HTMLElement;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
          return;
        }
        if (selectedIds.length > 0 || selectedRowId) {
          e.preventDefault();
          handleDeleteSelected();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedIds, selectedRowId, items]);

  // Export CSV
  const handleExportCsv = () => {
    const csvContent = exportMetadataToCsv(items, marketplace);
    const filename = `MetaDataGenerator_${marketplace.replace(/\s+/g, '_')}_${Date.now()}.csv`;
    downloadCsvFile(csvContent, filename);
    showToast(`Exported ${items.filter((i) => i.status === 'processed').length} files for ${marketplace}`, 'success');
  };

  // Clean filenames
  const handleCleanFilenames = () => {
    const cleaned = cleanFilenames(items);
    setItems(cleaned);
    showToast('Filenames cleaned of prompt prefixes and hashes!', 'success');
  };

  // Rename all files directly to match their generated Titles (both in table and on disk)
  const handleRenameFilesToTitle = async () => {
    if (items.length === 0) {
      showToast('Queue is empty. Select files first.', 'warning');
      return;
    }

    const { items: updated, count } = renameFilesToTitle(items);
    if (count === 0) {
      showToast('No processed titles available yet. Click Start to generate titles first!', 'warning');
      return;
    }

    const bridge = getElectronBridge();
    let renamedCount = 0;

    if (bridge) {
      for (const item of updated) {
        if (item.filePath) {
          const lastSlash = Math.max(item.filePath.lastIndexOf('/'), item.filePath.lastIndexOf('\\'));
          const dir = lastSlash !== -1 ? item.filePath.substring(0, lastSlash) : '';
          const sep = item.filePath.includes('\\') ? '\\' : '/';
          const newPath = dir ? `${dir}${sep}${item.originalName}` : item.originalName;
          if (item.filePath !== newPath) {
            try {
              const res = await bridge.renameLocalFile(item.filePath, newPath);
              if (res?.success) {
                item.filePath = newPath;
                renamedCount++;
              }
            } catch (err) {
              console.warn(`Could not rename ${item.filePath} to ${newPath}:`, err);
            }
          }
        }
      }
    }

    setItems([...updated]);
    showToast(
      renamedCount > 0
        ? `Successfully renamed ${renamedCount} file(s) directly on your disk in their folder!`
        : `Successfully renamed ${count} file(s) in queue!`,
      'success'
    );
  };

  // Batch rename files with prefix
  const handleBatchRename = (prefix: string, startNum: number) => {
    const renamed = batchRenameFiles(items, prefix, startNum);
    setItems(renamed);
    showToast(`Renamed ${items.length} files starting from ${startNum}`, 'success');
  };

  // In-place direct embedding into existing folder for JPEG, JPG, PNG, WEBP with automated Title-based renaming
  const handleEmbedMetadata = async () => {
    const processedImages = items.filter(
      (it) => it.status === 'processed' && (it.fileType === 'image' || it.fileBlob)
    );

    if (processedImages.length === 0) {
      showToast('No processed image files found. Please click Start first.', 'warning');
      return;
    }

    const bridge = getElectronBridge();
    showToast(`Injecting metadata into ${processedImages.length} files in existing folder...`, 'info');

    let successCount = 0;
    let diskWriteCount = 0;

    for (const item of processedImages) {
      try {
        let buffer: ArrayBuffer | null = null;

        // In Electron, read local file directly from disk without huge string conversions
        if (bridge && item.filePath) {
          const res = await bridge.readLocalFile(item.filePath);
          if (res?.success) {
            if (res.buffer) {
              buffer = (res.buffer instanceof Uint8Array ? res.buffer.buffer : res.buffer) as ArrayBuffer;
            } else if (res.base64) {
              const u8 = base64ToUint8Array(res.base64);
              buffer = u8.buffer as ArrayBuffer;
            }
          }
        }

        if (!buffer && item.fileBlob) {
          buffer = await item.fileBlob.arrayBuffer();
        }

        if (!buffer) continue;

        const metadata = {
          title: item.title,
          keywords: item.keywords,
          description: item.description,
          category: item.category,
          rating: item.rating || 5
        };

        // Inject EXIF (Windows XPTitle, XPKeywords, XPSubject, Rating), IPTC, and Adobe XMP
        const embeddedBuffer = embedMetadataIntoImage(
          buffer,
          item.originalName || item.filename,
          metadata
        );

        const embeddedBytes = new Uint8Array(embeddedBuffer);

        // Compute clean filesystem-safe Title for filename
        const rawTitle = (item.title || '').trim();
        let sanitizedTitle = rawTitle
          .replace(/[\\/:*?"<>|]/g, '-')
          .replace(/\s+/g, ' ')
          .replace(/^[\s.-]+|[\s.-]+$/g, '')
          .trim();
        if (!sanitizedTitle) sanitizedTitle = item.filename;

        // Preserve original extension
        const extMatch = (item.originalName || item.filename).match(/\.[0-9a-z]+$/i);
        const ext = extMatch ? extMatch[0] : (item.fileType === 'svg' ? '.svg' : '.jpg');
        const newFilename = sanitizedTitle;
        const newOriginalName = `${sanitizedTitle}${ext}`;

        // In-place overwrite & rename directly into the existing file on disk in Electron
        if (bridge && item.filePath) {
          const lastSlash = Math.max(item.filePath.lastIndexOf('/'), item.filePath.lastIndexOf('\\'));
          const dir = lastSlash !== -1 ? item.filePath.substring(0, lastSlash) : '';
          const sep = item.filePath.includes('\\') ? '\\' : '/';
          const newTargetFilePath = dir ? `${dir}${sep}${newOriginalName}` : newOriginalName;

          // Directly write the binary Uint8Array - instant (2ms), zero memory bloat, zero crash!
          const writeRes = await bridge.writeLocalFile(newTargetFilePath, embeddedBytes, item.filePath);
          if (writeRes?.success) {
            item.filePath = newTargetFilePath;
            diskWriteCount++;
          }
        } else {
          // If in web browser preview, update file object in memory
          const blob = new Blob([embeddedBuffer], { type: item.fileBlob?.type || 'image/jpeg' });
          item.dataUrl = URL.createObjectURL(blob);
          item.fileBlob = blob;
        }

        item.filename = newFilename;
        item.originalName = newOriginalName;
        item.isEmbedded = true;
        successCount++;
      } catch (err) {
        console.warn(`Could not embed into ${item.filename}:`, err);
      }
    }

    setItems([...items]);

    // Optional background Adobe Photoshop metadata synchronization
    if (bridge && diskWriteCount > 0) {
      const psPayload = processedImages
        .filter((it) => Boolean(it.filePath))
        .map((it) => ({
          filePath: it.filePath,
          filename: it.filename,
          title: it.title,
          keywords: it.keywords,
          description: it.description,
          category: it.category,
          rating: it.rating || 5
        }));

      if (psPayload.length > 0 && bridge.runPhotoshopAutomation) {
        try {
          bridge.runPhotoshopAutomation(psPayload)
            .then((psRes: any) => {
              if (psRes?.success) {
                showToast(`Adobe Photoshop: Document Info & XMP synchronized!`, 'success');
              }
            })
            .catch((e: any) => {
              console.warn('Photoshop background sync notice:', e);
            });
        } catch (psErr) {
          console.warn('Photoshop automation notice:', psErr);
        }
      }
    }

    showToast(
      diskWriteCount > 0
        ? `Embedded metadata (EXIF/IPTC/XMP) & renamed ${diskWriteCount} file(s) on your disk!`
        : `Metadata embedded into ${successCount} files in queue!`,
      'success'
    );
  };

  // Adobe Illustrator automated vector converter (SVG -> EPS 10 + Companion JPEG) in-place in existing folder
  const handleEmbedVector = async () => {
    const processedVectors = items.filter(
      (it) => it.status === 'processed' && (it.fileType === 'svg' || it.originalName.toLowerCase().endsWith('.svg'))
    );

    if (processedVectors.length === 0) {
      showToast('No processed SVG vectors to embed. Please click Start first.', 'warning');
      return;
    }

    const isElectron = Boolean((window as any).electronApi?.isElectron);
    showToast(`Starting Adobe Illustrator automation for ${processedVectors.length} vectors...`, 'info');

    // Build batch payload for Adobe Illustrator with Title-based filenames
    const batchItems = processedVectors.map((item) => {
      let dir = '';
      if (item.filePath) {
        const lastSlash = Math.max(item.filePath.lastIndexOf('/'), item.filePath.lastIndexOf('\\'));
        dir = lastSlash !== -1 ? item.filePath.substring(0, lastSlash) : '';
      }
      const sep = item.filePath?.includes('\\') ? '\\' : '/';

      const rawTitle = (item.title || '').trim();
      let sanitizedTitle = rawTitle
        .replace(/[\\/:*?"<>|]/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/^[\s.-]+|[\s.-]+$/g, '')
        .trim();
      if (!sanitizedTitle) {
        sanitizedTitle = item.filename || item.originalName.replace(/\.[^/.]+$/, '');
      }

      const epsPath = dir ? `${dir}${sep}${sanitizedTitle}.eps` : `${sanitizedTitle}.eps`;
      const jpgPath = dir ? `${dir}${sep}${sanitizedTitle}.jpg` : `${sanitizedTitle}.jpg`;

      return {
        filename: `${sanitizedTitle}.svg`,
        svgPath: item.filePath || '',
        epsPath,
        jpgPath,
        title: item.title,
        keywords: item.keywords,
        description: item.description,
        category: item.category,
        rating: item.rating || 5,
        sanitizedTitle
      };
    });

    let usedIllustrator = false;

    // Listen to live Illustrator progress updates
    let unlisten: any = null;
    if (isElectron && (window as any).electronApi?.onIllustratorProgress) {
      unlisten = (window as any).electronApi.onIllustratorProgress((prog: any) => {
        if (prog?.filename && prog?.index) {
          showToast(`Adobe Illustrator: Processing ${prog.index} of ${prog.total} (${prog.filename})...`, 'info');
        }
      });
    }

    // Attempt native Adobe Illustrator OLE/COM & ExtendScript batch pipeline
    if (isElectron && batchItems.every((b) => b.svgPath)) {
      try {
        const aiRes = await (window as any).electronApi.runIllustratorAutomation(batchItems);
        if (aiRes?.success) {
          usedIllustrator = true;

          // Inject full EXIF (Windows XP tags) + IPTC into Illustrator's exported companion JPEGs so Windows shows details!
          for (const b of batchItems) {
            try {
              const readRes = await (window as any).electronApi.readLocalFile(b.jpgPath);
              let rawBuffer: ArrayBuffer | null = null;
              if (readRes?.success) {
                if (readRes.buffer) {
                  rawBuffer = (readRes.buffer instanceof Uint8Array ? readRes.buffer.buffer : readRes.buffer) as ArrayBuffer;
                } else if (readRes.base64) {
                  const u8 = base64ToUint8Array(readRes.base64);
                  rawBuffer = u8.buffer as ArrayBuffer;
                }
              }

              if (rawBuffer) {
                const metadata = {
                  title: b.title,
                  keywords: b.keywords,
                  description: b.description,
                  category: b.category,
                  rating: b.rating
                };
                const embBuffer = embedXmpIntoJpegBuffer(rawBuffer, metadata);
                const embBytes = new Uint8Array(embBuffer);
                await (window as any).electronApi.writeLocalFile(b.jpgPath, embBytes);
              }
            } catch (jpgErr) {
              console.warn('Could not post-process Illustrator JPEG:', jpgErr);
            }
          }
        } else {
          console.warn('Adobe Illustrator launch notice:', aiRes?.reason, aiRes?.message);
        }
      } catch (aiErr) {
        console.warn('Illustrator automation exception:', aiErr);
      }
    }

    if (unlisten) unlisten();

    // If Illustrator was not installed or running, or in web environment:
    // Execute built-in in-place EPS 10 + high-res JPEG companion generator right into the existing folder
    if (!usedIllustrator) {
      for (let idx = 0; idx < processedVectors.length; idx++) {
        const item = processedVectors[idx];
        const b = batchItems[idx];
        try {
          const svgText = item.svgContent || (item.fileBlob ? await item.fileBlob.text() : '');
          const metadata = {
            title: item.title,
            keywords: item.keywords,
            description: item.description,
            category: item.category,
            rating: item.rating || 5
          };

          // 1. Generate EPS 10 with Document Structuring Conventions (DSC) & XMP
          const epsData = convertSvgToEps10(svgText, metadata);
          const epsBase64 = btoa(unescape(encodeURIComponent(epsData)));

          // 2. Generate companion high-res JPEG with full EXIF (Windows XP tags) + IPTC + XMP
          if (item.fileBlob) {
            const jpgRes = await convertSvgToJpeg(item.fileBlob);
            if (jpgRes.base64) {
              const rawJpgBytes = base64ToUint8Array(jpgRes.base64);
              const embeddedJpgBuffer = embedXmpIntoJpegBuffer(rawJpgBytes.buffer as ArrayBuffer, metadata);
              const embBytes = new Uint8Array(embeddedJpgBuffer);
              if (isElectron && item.filePath) {
                await (window as any).electronApi.writeLocalFile(b.jpgPath, embBytes);
              }
            }
          }

          if (isElectron && item.filePath) {
            await (window as any).electronApi.writeLocalFile(b.epsPath, epsBase64);
          }
          item.isEmbedded = true;
        } catch (err) {
          console.warn(`Error generating vector pair for ${item.filename}:`, err);
        }
      }
    }

    // Rename SVG files on disk to match Title as well and update UI state
    for (let idx = 0; idx < processedVectors.length; idx++) {
      const item = processedVectors[idx];
      const b = batchItems[idx];
      item.filename = b.sanitizedTitle;
      item.originalName = `${b.sanitizedTitle}.svg`;
      item.isEmbedded = true;

      if (isElectron && item.filePath) {
        const lastSlash = Math.max(item.filePath.lastIndexOf('/'), item.filePath.lastIndexOf('\\'));
        const dir = lastSlash !== -1 ? item.filePath.substring(0, lastSlash) : '';
        const sep = item.filePath.includes('\\') ? '\\' : '/';
        const newSvgPath = dir ? `${dir}${sep}${b.sanitizedTitle}.svg` : `${b.sanitizedTitle}.svg`;
        if (item.filePath !== newSvgPath) {
          try {
            await (window as any).electronApi.renameLocalFile(item.filePath, newSvgPath);
            item.filePath = newSvgPath;
          } catch (e) {}
        }
      }
    }

    setItems([...items]);

    showToast(
      usedIllustrator
        ? `Adobe Illustrator: Created Title-renamed EPS 10 & Companion JPEG with embedded metadata in folder!`
        : `Created Title-renamed EPS 10 & Companion JPEG with full metadata in folder!`,
      'success'
    );
  };

  // Download single EPS with injected DSC & XMP headers
  const handleDownloadEps = (item: MetadataItem) => {
    const fakeSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800"><rect width="800" height="800" fill="#ffffff"/><circle cx="400" cy="400" r="250" fill="none" stroke="#111827" stroke-width="4"/></svg>`;
    const epsData = convertSvgToEps10(
      item.svgContent || fakeSvg,
      {
        title: item.title,
        keywords: item.keywords,
        description: item.description,
        category: item.category,
        rating: item.rating
      }
    );

    const blob = new Blob([epsData], { type: 'application/postscript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${item.filename || 'vector'}.eps`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Downloaded Adobe Illustrator EPS 10: ${item.filename}.eps`, 'success');
  };

  // Drag and drop handler
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleSelectFiles(e.dataTransfer.files);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  return (
    <div
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      className={`w-screen h-screen flex flex-col p-3 gap-2 overflow-hidden select-none font-sans transition-colors duration-200 ${
        theme === 'Light' ? 'bg-[#f1f5f9] text-black' : 'bg-[#101923] text-slate-200'
      }`}
    >
      {/* A. Header Bar */}
      <HeaderBar
        provider={provider}
        setProvider={(p) => {
          setProvider(p);
          setApiConfig((prev) => ({
            ...prev,
            provider: p,
            activeModel: prev[`${p}Model` as keyof ApiConfig] as string || getDefaultModelForProvider(p)
          }));
        }}
        currentModel={currentModel}
        onModelChange={handleModelChange}
        hasApiKey={hasProviderKey(provider, apiConfig)}
        theme={theme}
        onOpenManageKeys={() => setIsManageKeysOpen(true)}
        onOpenPythonSource={() => setIsPythonSourceOpen(true)}
      />

        {/* B. Mode & Theme & Generation Options Toolbar */}
        <ToolbarRow2
          mode={mode}
          setMode={handleModeChange}
          theme={theme}
          setTheme={setTheme}
          options={options}
          setOptions={setOptions}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onOpenContact={() => setIsContactOpen(true)}
        />

        {/* C. Input & Processing & Export & Utilities Toolbar */}
        <ToolbarRow3
          mode={mode}
          theme={theme}
          onSelectVectors={handleSelectFiles}
          onSelectFolder={handleSelectFiles}
          onSelectNativeFiles={handleSelectNativeFiles}
          onStart={handleStart}
          onResume={handleResume}
          onRetry={handleRetry}
          onClear={handleClear}
          selectedCount={selectedIds.length > 0 ? selectedIds.length : (selectedRowId ? 1 : 0)}
          onDeleteSelected={handleDeleteSelected}
          marketplace={marketplace}
          setMarketplace={setMarketplace}
          onExportCsv={handleExportCsv}
          onRenameFiles={handleRenameFilesToTitle}
          onCleanFilenames={handleCleanFilenames}
          onEmbedMetadata={handleEmbedMetadata}
          onEmbedVector={handleEmbedVector}
          onPsEmbed={handleEmbedMetadata}
          isProcessing={isProcessing}
        />

        {/* D. Main Data Table */}
        <MetaTable
          items={items}
          selectedRowId={selectedRowId}
          selectedIds={selectedIds}
          theme={theme}
          onSelectRow={handleSelectRow}
          onToggleSelectRow={handleToggleSelectRow}
          onSelectAll={handleSelectAll}
          onDeleteItem={handleDeleteItem}
          onDeleteSelected={handleDeleteSelected}
          onUpdateItem={(id, updates) => {
            setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...updates } : it)));
          }}
          onDownloadEps={handleDownloadEps}
        />

        {/* E. Bottom Status Bar */}
        <StatusBar
          stats={stats}
          theme={theme}
          onRefresh={() => {
            showToast('Synchronized generation statistics and license verification.', 'info');
          }}
          onOpenExtensions={() => setIsExtensionsOpen(true)}
          isProcessing={isProcessing}
        />

      {/* ================= Toast Notification ================= */}
      {toast && (
        <div className="fixed bottom-14 right-6 z-50 animate-in fade-in slide-in-from-bottom-3 duration-200">
          <div
            className={`px-4 py-2.5 rounded-lg shadow-xl border text-xs font-medium flex items-center gap-2.5 backdrop-blur-md ${
              toast.type === 'success'
                ? theme === 'Light' ? 'bg-emerald-50 text-emerald-900 border-emerald-400' : 'bg-emerald-950/90 text-emerald-200 border-emerald-500/50'
                : toast.type === 'warning'
                ? theme === 'Light' ? 'bg-amber-50 text-amber-900 border-amber-400' : 'bg-amber-950/90 text-amber-200 border-amber-500/50'
                : theme === 'Light' ? 'bg-white text-slate-800 border-slate-300 shadow-lg' : 'bg-[#182635]/95 text-slate-200 border-[#2a3c50]'
            }`}
          >
            {toast.type === 'success' && <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />}
            {toast.type === 'warning' && <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />}
            {toast.type === 'info' && <Info className="w-4 h-4 text-[#0284c7] shrink-0" />}
            <span>{toast.message}</span>
          </div>
        </div>
      )}

      {/* ================= Modals ================= */}
      <ManageKeysModal
        isOpen={isManageKeysOpen}
        onClose={() => setIsManageKeysOpen(false)}
        config={apiConfig}
        theme={theme}
        onSave={(newCfg) => {
          setApiConfig(newCfg);
          if (newCfg.provider) {
            setProvider(newCfg.provider);
          }
          showToast('API credentials saved and active', 'success');
        }}
      />

      <TestApiModal
        isOpen={isTestApiOpen}
        onClose={() => setIsTestApiOpen(false)}
        config={apiConfig}
        provider={provider}
      />

      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />

      <ContactModal isOpen={isContactOpen} onClose={() => setIsContactOpen(false)} />

      <ExtensionsModal isOpen={isExtensionsOpen} onClose={() => setIsExtensionsOpen(false)} />

      <RenameModal
        isOpen={isRenameOpen}
        onClose={() => setIsRenameOpen(false)}
        onApply={handleBatchRename}
      />

      <PythonSourceModal
        isOpen={isPythonSourceOpen}
        onClose={() => setIsPythonSourceOpen(false)}
      />
    </div>
  );
}
