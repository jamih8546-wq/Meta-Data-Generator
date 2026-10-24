import { app, BrowserWindow, shell, ipcMain, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure Windows taskbar correctly groups and displays the application icon
if (process.platform === 'win32') {
  app.setAppUserModelId('com.metadatagenerator.app');
}

let mainWindow = null;

function getAppIcon() {
  const icoCandidate = path.join(__dirname, '../public/icon.ico');
  const pngCandidate = path.join(__dirname, '../public/icon.png');
  if (process.platform === 'win32' && fs.existsSync(icoCandidate)) {
    return icoCandidate;
  }
  if (fs.existsSync(pngCandidate)) {
    return pngCandidate;
  }
  return icoCandidate;
}

function createWindow() {
  const appIcon = getAppIcon();

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: 'Meta Data Generator',
    icon: appIcon,
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      preload: path.join(__dirname, 'preload.cjs')
    },
    show: false,
  });

  // Handle external link clicks safely in the user's default web browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  const isDev = !app.isPackaged && process.env.ELECTRON_DEV === 'true';
  const distIndexPath = path.join(__dirname, '../dist/index.html');

  if (isDev) {
    const devServerUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:3000';
    mainWindow.loadURL(devServerUrl);
  } else if (fs.existsSync(distIndexPath)) {
    mainWindow.loadFile(distIndexPath);
  } else {
    mainWindow.loadURL('http://localhost:3000');
  }

  // Crash recovery - reload instead of staying black if renderer ever crashes
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process gone:', details);
    if (mainWindow && details.reason !== 'clean-exit') {
      mainWindow.reload();
    }
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('Renderer became unresponsive');
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ================= IPC Handlers for In-Place Local File Injection =================

// 1. Direct local file overwrite / creation (with optional oldPath cleanup if renamed)
ipcMain.handle('write-local-file', async (_event, { filePath, base64Data, oldPath }) => {
  try {
    let buffer;
    if (Buffer.isBuffer(base64Data)) {
      buffer = base64Data;
    } else if (base64Data instanceof Uint8Array) {
      buffer = Buffer.from(base64Data.buffer, base64Data.byteOffset, base64Data.byteLength);
    } else if (typeof base64Data === 'string') {
      buffer = Buffer.from(base64Data, 'base64');
    } else {
      buffer = Buffer.from(base64Data);
    }
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, buffer);

    // If file was renamed, safely remove the old file
    if (oldPath && oldPath !== filePath && fs.existsSync(oldPath)) {
      try {
        fs.unlinkSync(oldPath);
      } catch (delErr) {
        console.warn('Could not delete old file after rename:', delErr);
      }
    }

    return { success: true, filePath };
  } catch (err) {
    console.error('Error writing local file:', err);
    return { success: false, error: err.message };
  }
});

// 1b. Rename local file on disk
ipcMain.handle('rename-local-file', async (_event, { oldPath, newPath }) => {
  try {
    if (!fs.existsSync(oldPath)) {
      return { success: false, error: 'Source file does not exist' };
    }
    if (oldPath === newPath) {
      return { success: true, newPath };
    }
    if (fs.existsSync(newPath)) {
      try { fs.unlinkSync(newPath); } catch (e) {}
    }
    fs.renameSync(oldPath, newPath);
    return { success: true, newPath };
  } catch (err) {
    console.error('Error renaming local file:', err);
    return { success: false, error: err.message };
  }
});

// 1c. Delete local file from disk
ipcMain.handle('delete-local-file', async (_event, { filePath }) => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return { success: true };
    }
    return { success: false, error: 'File does not exist' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 2. Read local file as buffer & base64
ipcMain.handle('read-local-file', async (_event, { filePath }) => {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'File not found on disk' };
    }
    const data = fs.readFileSync(filePath);
    return {
      success: true,
      buffer: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      base64: data.toString('base64')
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 3. Adobe Illustrator Live Automation Pipeline
ipcMain.handle('run-illustrator-automation', async (event, { items }) => {
  if (!items || items.length === 0) {
    return { success: false, error: 'No items provided for automation' };
  }

  const tempDir = os.tmpdir();
  const progressPath = path.join(tempDir, `mdg_ai_progress_${Date.now()}.json`);
  const jsxPath = path.join(tempDir, `mdg_illustrator_batch_${Date.now()}.jsx`);
  const vbsPath = path.join(tempDir, `mdg_runner_${Date.now()}.vbs`);

  const itemsJson = JSON.stringify(items, null, 2);

  // Adobe Illustrator ExtendScript (.jsx) for opening and saving one-by-one
  const jsxScript = `// Adobe Illustrator Batch Processor
#target illustrator

(function() {
    var items = ${itemsJson};
    var progressFile = new File("${progressPath.replace(/\\/g, '\\\\')}");

    function logProgress(idx, total, name, step) {
        try {
            progressFile.open("w");
            progressFile.write(JSON.stringify({ index: idx, total: total, filename: name, step: step }));
            progressFile.close();
        } catch(e) {}
    }

    try {
        app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
    } catch(e) {}

    var xmpLoaded = false;
    try {
        if (ExternalObject.AdobeXMPScript == undefined) {
            ExternalObject.AdobeXMPScript = new ExternalObject("lib:AdobeXMPScript");
        }
        xmpLoaded = (ExternalObject.AdobeXMPScript != undefined);
    } catch(e) { xmpLoaded = false; }

    for (var i = 0; i < items.length; i++) {
        var it = items[i];
        logProgress(i + 1, items.length, it.filename, "processing");

        var svgFile = new File(it.svgPath);
        if (!svgFile.exists) continue;

        var doc = null;
        try {
            doc = app.open(svgFile);

            if (xmpLoaded && doc) {
                try {
                    var xmp = new XMPMeta(doc.XMPString);
                    xmp.deleteProperty(XMPConst.NS_DC, "title");
                    xmp.appendArrayItem(XMPConst.NS_DC, "title", it.title, 0, XMPConst.PROP_IS_ARRAY);

                    xmp.deleteProperty(XMPConst.NS_DC, "description");
                    xmp.appendArrayItem(XMPConst.NS_DC, "description", it.description || it.title, 0, XMPConst.PROP_IS_ARRAY);

                    xmp.deleteProperty(XMPConst.NS_DC, "subject");
                    var tags = it.keywords.split(",");
                    for (var k = 0; k < tags.length; k++) {
                        var tag = tags[k].replace(/^\\s+|\\s+$/g, "");
                        if (tag.length > 0) {
                            xmp.appendArrayItem(XMPConst.NS_DC, "subject", tag, 0, XMPConst.PROP_IS_ARRAY);
                        }
                    }

                    xmp.setProperty(XMPConst.NS_PHOTOSHOP, "Category", it.category || "Arts, Objects");
                    xmp.setProperty(XMPConst.NS_PHOTOSHOP, "Credit", "Developed By Neimor Rahim");
                    doc.XMPString = xmp.serialize();
                } catch(xmpErr) {}
            }

            // Save EPS 10 in existing folder
            var epsFile = new File(it.epsPath);
            var epsOpts = new EPSSaveOptions();
            epsOpts.compatibility = Compatibility.ILLUSTRATOR10;
            epsOpts.embedAllFonts = true;
            epsOpts.embedLinkedFiles = true;
            epsOpts.includeDocumentThumbnails = true;
            doc.saveAs(epsFile, epsOpts);

            // Export High-Res JPEG in existing folder
            var jpgFile = new File(it.jpgPath);
            var exportOpts = new ExportOptionsJPEG();
            exportOpts.antiAliasing = true;
            exportOpts.qualitySetting = 100;
            doc.exportFile(jpgFile, ExportType.JPEG, exportOpts);

            doc.close(SaveOptions.DONOTSAVECHANGES);
            doc = null;
        } catch(err) {
            if (doc != null) {
                try { doc.close(SaveOptions.DONOTSAVECHANGES); } catch(cErr) {}
            }
        }
    }

    logProgress(items.length, items.length, "Complete", "done");
})();
`;

  // Windows VBScript to trigger Illustrator COM
  const vbsScript = `' VBScript runner for Adobe Illustrator
On Error Resume Next
Set appRef = CreateObject("Illustrator.Application")
If Err.Number <> 0 Then
    WScript.Echo "ERROR_NO_AI"
    WScript.Quit 1
End If
appRef.UserInteractionLevel = -1
appRef.DoJavaScriptFile "${jsxPath.replace(/\\/g, '\\\\')}"
If Err.Number <> 0 Then
    WScript.Echo "ERROR: " & Err.Description
    WScript.Quit 2
End If
WScript.Echo "SUCCESS"
WScript.Quit 0
`;

  fs.writeFileSync(jsxPath, jsxScript, 'utf8');
  fs.writeFileSync(vbsPath, vbsScript, 'utf8');

  // Interval to poll progress and send to renderer
  const pollInterval = setInterval(() => {
    try {
      if (fs.existsSync(progressPath)) {
        const raw = fs.readFileSync(progressPath, 'utf8');
        const parsed = JSON.parse(raw);
        event.sender.send('illustrator-progress', parsed);
      }
    } catch (e) {}
  }, 400);

  return new Promise((resolve) => {
    exec(`cscript //nologo "${vbsPath}"`, { windowsHide: true, timeout: 45000 }, (error, stdout) => {
      clearInterval(pollInterval);

      // Clean up temp files
      try {
        if (fs.existsSync(jsxPath)) fs.unlinkSync(jsxPath);
        if (fs.existsSync(vbsPath)) fs.unlinkSync(vbsPath);
        if (fs.existsSync(progressPath)) fs.unlinkSync(progressPath);
      } catch (e) {}

      if (stdout.includes('ERROR_NO_AI') || (error && error.code === 1)) {
        resolve({
          success: false,
          reason: 'illustrator_not_installed',
          message: 'Adobe Illustrator could not be launched. Using built-in high-precision vector engine.'
        });
      } else if (error) {
        resolve({
          success: false,
          reason: 'automation_error',
          message: stdout || error.message
        });
      } else {
        resolve({
          success: true,
          count: items.length
        });
      }
    });
  });
});

// 4. Native Windows Dialog for Absolute File and Folder Paths
ipcMain.handle('select-files-dialog', async (_event, { mode, isFolder }) => {
  try {
    const properties = isFolder ? ['openDirectory'] : ['openFile', 'multiSelections'];
    let filters = [];
    if (!isFolder) {
      if (mode === 'Image') {
        filters = [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff'] }];
      } else if (mode === 'Vector') {
        filters = [{ name: 'Vectors', extensions: ['svg', 'eps', 'ai'] }];
      } else if (mode === 'Video') {
        filters = [{ name: 'Videos', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm'] }];
      } else {
        filters = [{ name: 'All Files', extensions: ['*'] }];
      }
    }

    const result = await dialog.showOpenDialog(mainWindow, {
      title: isFolder ? 'Select Folder' : 'Select Files',
      properties,
      filters
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { canceled: true, files: [] };
    }

    const filePaths = [];
    if (isFolder) {
      for (const folderPath of result.filePaths) {
        function walkDir(dir) {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              walkDir(fullPath);
            } else {
              const ext = path.extname(entry.name).toLowerCase().replace('.', '');
              const allowed = ['jpg', 'jpeg', 'png', 'webp', 'svg', 'eps', 'ai', 'mp4', 'mov', 'webm', 'bmp', 'tiff'];
              if (allowed.includes(ext)) {
                filePaths.push(fullPath);
              }
            }
          }
        }
        try {
          walkDir(folderPath);
        } catch (e) {
          console.warn('walkDir error:', e);
        }
      }
    } else {
      filePaths.push(...result.filePaths);
    }

    const files = [];
    for (const fp of filePaths) {
      try {
        const stats = fs.statSync(fp);
        const name = path.basename(fp);
        const ext = path.extname(fp).toLowerCase();
        let mime = 'image/jpeg';
        if (ext === '.png') mime = 'image/png';
        else if (ext === '.webp') mime = 'image/webp';
        else if (ext === '.svg') mime = 'image/svg+xml';
        else if (ext === '.eps') mime = 'application/postscript';
        else if (ext === '.mp4') mime = 'video/mp4';

        const buf = fs.readFileSync(fp);
        const base64 = buf.toString('base64');
        const dataUrl = `data:${mime};base64,${base64}`;

        files.push({
          filePath: fp,
          name,
          size: stats.size,
          mime,
          base64,
          dataUrl
        });
      } catch (err) {
        console.warn('Error reading selected file:', fp, err);
      }
    }

    return { canceled: false, files };
  } catch (err) {
    return { canceled: true, error: err.message, files: [] };
  }
});

// 5. Adobe Photoshop Live Metadata Automation Pipeline
ipcMain.handle('run-photoshop-automation', async (event, { items }) => {
  if (!items || items.length === 0) {
    return { success: false, error: 'No items provided for Photoshop automation' };
  }

  const tempDir = os.tmpdir();
  const progressPath = path.join(tempDir, `mdg_ps_progress_${Date.now()}.json`);
  const jsxPath = path.join(tempDir, `mdg_photoshop_batch_${Date.now()}.jsx`);
  const vbsPath = path.join(tempDir, `mdg_ps_runner_${Date.now()}.vbs`);

  const itemsJson = JSON.stringify(items, null, 2);

  const jsxScript = `// Adobe Photoshop Batch Metadata Embedder
#target photoshop

(function() {
    var items = ${itemsJson};
    var progressFile = new File("${progressPath.replace(/\\/g, '\\\\')}");

    function logProgress(idx, total, name, step) {
        try {
            progressFile.open("w");
            progressFile.write(JSON.stringify({ index: idx, total: total, filename: name, step: step }));
            progressFile.close();
        } catch(e) {}
    }

    try {
        app.displayDialogs = DialogModes.NO;
    } catch(e) {}

    var xmpLoaded = false;
    try {
        if (ExternalObject.AdobeXMPScript == undefined) {
            ExternalObject.AdobeXMPScript = new ExternalObject("lib:AdobeXMPScript");
        }
        xmpLoaded = (ExternalObject.AdobeXMPScript != undefined);
    } catch(e) { xmpLoaded = false; }

    for (var i = 0; i < items.length; i++) {
        var it = items[i];
        logProgress(i + 1, items.length, it.filename, "processing");

        var imgFile = new File(it.filePath);
        if (!imgFile.exists) continue;

        var doc = null;
        try {
            doc = app.open(imgFile);

            // 1. Set native document info (visible in Photoshop File -> File Info)
            try {
                doc.info.title = it.title;
                doc.info.author = "Developed By Neimor Rahim";
                doc.info.caption = it.description || it.title;
                doc.info.category = it.category || "Arts, Photography";
                doc.info.credit = "Developed By Neimor Rahim";
                doc.info.copyrighted = CopyrightedType.COPYRIGHTEDWORK;
                doc.info.copyrightNotice = "Developed By Neimor Rahim";

                var rawTags = it.keywords.split(",");
                var cleanTags = [];
                for (var t = 0; t < rawTags.length; t++) {
                    var ct = rawTags[t].replace(/^\\s+|\\s+$/g, "");
                    if (ct.length > 0) cleanTags.push(ct);
                }
                doc.info.keywords = cleanTags;
            } catch(infoErr) {}

            // 2. Set XMP Metadata raw packet
            if (xmpLoaded && doc) {
                try {
                    var xmp = new XMPMeta(doc.xmpMetadata.raw);
                    xmp.deleteProperty(XMPConst.NS_DC, "title");
                    xmp.appendArrayItem(XMPConst.NS_DC, "title", it.title, 0, XMPConst.PROP_IS_ARRAY);

                    xmp.deleteProperty(XMPConst.NS_DC, "description");
                    xmp.appendArrayItem(XMPConst.NS_DC, "description", it.description || it.title, 0, XMPConst.PROP_IS_ARRAY);

                    xmp.deleteProperty(XMPConst.NS_DC, "subject");
                    for (var k = 0; k < cleanTags.length; k++) {
                        xmp.appendArrayItem(XMPConst.NS_DC, "subject", cleanTags[k], 0, XMPConst.PROP_IS_ARRAY);
                    }

                    xmp.setProperty(XMPConst.NS_XMP, "Rating", String(it.rating || 5));
                    xmp.setProperty(XMPConst.NS_PHOTOSHOP, "Category", it.category || "Arts, Photography");
                    xmp.setProperty(XMPConst.NS_PHOTOSHOP, "Credit", "Developed By Neimor Rahim");
                    doc.xmpMetadata.raw = xmp.serialize();
                } catch(xmpErr) {}
            }

            // Save and close in-place
            doc.save();
            doc.close(SaveOptions.DONOTSAVECHANGES);
            doc = null;
        } catch(err) {
            if (doc != null) {
                try { doc.close(SaveOptions.DONOTSAVECHANGES); } catch(cErr) {}
            }
        }
    }

    logProgress(items.length, items.length, "Complete", "done");
})();
`;

  const vbsScript = `' VBScript runner for Adobe Photoshop
On Error Resume Next
Set appRef = CreateObject("Photoshop.Application")
If Err.Number <> 0 Then
    WScript.Echo "ERROR_NO_PS"
    WScript.Quit 1
End If
appRef.DisplayDialogs = 3
appRef.DoJavaScriptFile "${jsxPath.replace(/\\/g, '\\\\')}"
If Err.Number <> 0 Then
    WScript.Echo "ERROR: " & Err.Description
    WScript.Quit 2
End If
WScript.Echo "SUCCESS"
WScript.Quit 0
`;

  fs.writeFileSync(jsxPath, jsxScript, 'utf8');
  fs.writeFileSync(vbsPath, vbsScript, 'utf8');

  const pollInterval = setInterval(() => {
    try {
      if (fs.existsSync(progressPath)) {
        const raw = fs.readFileSync(progressPath, 'utf8');
        const parsed = JSON.parse(raw);
        event.sender.send('photoshop-progress', parsed);
      }
    } catch (e) {}
  }, 400);

  return new Promise((resolve) => {
    exec(`cscript //nologo "${vbsPath}"`, { windowsHide: true, timeout: 25000 }, (error, stdout) => {
      clearInterval(pollInterval);
      try {
        if (fs.existsSync(jsxPath)) fs.unlinkSync(jsxPath);
        if (fs.existsSync(vbsPath)) fs.unlinkSync(vbsPath);
        if (fs.existsSync(progressPath)) fs.unlinkSync(progressPath);
      } catch (e) {}

      if (stdout.includes('ERROR_NO_PS') || (error && error.code === 1)) {
        resolve({
          success: false,
          reason: 'photoshop_not_installed',
          message: 'Adobe Photoshop could not be launched. Used built-in high-precision engine.'
        });
      } else if (error) {
        resolve({
          success: false,
          reason: 'automation_error_or_timeout',
          message: stdout || error.message || 'Photoshop automation timed out. Built-in metadata injector completed.'
        });
      } else {
        resolve({ success: true, count: items.length });
      }
    });
  });
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
