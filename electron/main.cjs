// Polyfill Promise.try for dependencies that use it (not available in Node < 22)
if (!Promise.try) {
  Promise.try = function(fn) {
    return new Promise((resolve, reject) => {
      try { resolve(fn()); } catch (e) { reject(e); }
    });
  };
}

const { app, BrowserWindow, Menu, Tray, shell, dialog, ipcMain } = require('electron');
const path = require('path');

// Handle Squirrel events for Windows installer
try { if (require('electron-squirrel-startup')) app.quit(); } catch (e) { /* not using squirrel */ }

let mainWindow;
let tray;
const isDev = !app.isPackaged;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'OpenClaw Books',
    icon: path.join(__dirname, '..', 'public', 'icon.png'),
    backgroundColor: '#0f0f1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    // Clean, modern look — no default menu bar clutter
    autoHideMenuBar: true,
    show: false,
  });

  // Load the app
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    // Open DevTools in dev mode
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // Show window when ready (avoids white flash)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // F12 / Ctrl+Shift+I toggles DevTools in any build (for debugging)
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    const devKeys =
      input.key === 'F12' ||
      (input.control && input.shift && input.key === 'I');
    if (devKeys) mainWindow.webContents.toggleDevTools();
  });

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Minimize to tray instead of closing
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  try {
    const iconPath = isDev
      ? path.join(__dirname, '..', 'public', 'icon.png')
      : path.join(process.resourcesPath, 'public', 'icon.png');

    tray = new Tray(iconPath);
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Open OpenClaw Books',
        click: () => {
          mainWindow.show();
          mainWindow.focus();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.isQuitting = true;
          if (mainWindow) mainWindow.destroy();
          app.quit();
        },
      },
    ]);
    tray.setToolTip('OpenClaw Books');
    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => {
      mainWindow.show();
      mainWindow.focus();
    });
  } catch (e) {
    // Tray icon is optional — don't crash if it fails
    console.log('Tray creation skipped:', e.message);
  }
}

// Build a minimal application menu
function createMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'About OpenClaw Books',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About OpenClaw Books',
              message: 'OpenClaw Books v1.0.0',
              detail: 'Schedule C Bookkeeping for Self-Employed\n\nTrack income, expenses, mileage, invoices, contractors, and export for TurboTax.\n\nAll data stored locally on your machine.',
            });
          },
        },
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            app.isQuitting = true;
            app.quit();
          },
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];

  // Add DevTools option in dev mode
  if (isDev) {
    template[1].submenu.push({ type: 'separator' }, { role: 'toggleDevTools' });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Auto-updater ──────────────────────────────────────────────────────────────
// Saved when the real update-downloaded event fires; used to launch the
// installer directly instead of relying on quitAndInstall() internal state.
let _downloadedInstallerPath = null;

// ── IPC handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.on('install-update', () => {
  app.isQuitting = true;

  if (_downloadedInstallerPath) {
    // Best path: launch the installer file directly, then quit.
    // This works even when quitAndInstall() fails due to self-signed cert
    // verification hanging and leaving the updater's internal state unset.
    console.log('[updater] Launching installer directly:', _downloadedInstallerPath);
    const { spawn } = require('child_process');
    spawn(_downloadedInstallerPath, [], { detached: true, stdio: 'ignore' }).unref();
    if (mainWindow) mainWindow.destroy();
    app.quit();
  } else {
    // Fallback: try the standard quitAndInstall path.
    try {
      require('electron-updater').autoUpdater.quitAndInstall(false, true);
    } catch (e) {
      console.error('[updater] quitAndInstall failed:', e.message);
      // Last resort: just quit — autoInstallOnAppQuit may still handle it.
      if (mainWindow) mainWindow.destroy();
      app.quit();
    }
  }
});
ipcMain.on('check-for-update', () => {
  try { require('electron-updater').autoUpdater.checkForUpdates().catch(() => {}); } catch (_) {}
});

function setupAutoUpdater(win) {
  let updater;
  try { updater = require('electron-updater').autoUpdater; } catch (_) {
    // Not available in dev / unpackaged — skip silently
    return;
  }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;

  let pendingVersion = null;
  let downloadedFired = false;
  let fallbackTimer = null;

  updater.on('update-available', (info) => {
    pendingVersion = info.version;
    downloadedFired = false;
    _downloadedInstallerPath = null;
    win.webContents.send('update-available', { version: info.version });
  });

  updater.on('update-not-available', () =>
    win.webContents.send('update-not-available'));

  updater.on('download-progress', (p) => {
    win.webContents.send('update-progress', p);
    // If download reaches 100% but update-downloaded never fires (signature
    // verification hang on self-signed certs), force the event after 20s
    if (p.percent >= 99.9 && !downloadedFired && !fallbackTimer) {
      fallbackTimer = setTimeout(() => {
        if (!downloadedFired) {
          console.log('[updater] Forcing update-downloaded after 100% timeout');
          win.webContents.send('update-downloaded', { version: pendingVersion || 'latest' });
        }
      }, 20000);
    }
  });

  updater.on('update-downloaded', (info) => {
    downloadedFired = true;
    if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
    // Save the installer path so install-update can launch it directly
    if (info.downloadedFile) {
      _downloadedInstallerPath = info.downloadedFile;
      console.log('[updater] Installer saved at:', _downloadedInstallerPath);
    }
    win.webContents.send('update-downloaded', { version: info.version });
  });

  updater.on('error', (err) => {
    if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
    if (app.isPackaged) win.webContents.send('update-error', err.message);
  });

  // Delay first check so window finishes rendering
  setTimeout(() => updater.checkForUpdatesAndNotify().catch(() => {}), 5000);
}

// App lifecycle
app.whenReady().then(() => {
  createWindow();
  createMenu();
  createTray();
  setupAutoUpdater(mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // On Windows/Linux, quit when all windows are closed and we're not hiding to tray
  if (process.platform !== 'darwin' && app.isQuitting) app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
