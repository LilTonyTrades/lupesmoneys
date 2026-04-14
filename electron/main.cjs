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

// ── IPC handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.on('install-update', () => {
  try { require('electron-updater').autoUpdater.quitAndInstall(); } catch (_) {}
});
ipcMain.on('check-for-update', () => {
  try { require('electron-updater').autoUpdater.checkForUpdates().catch(() => {}); } catch (_) {}
});

// ── Auto-updater ──────────────────────────────────────────────────────────────
function setupAutoUpdater(win) {
  let updater;
  try { updater = require('electron-updater').autoUpdater; } catch (_) {
    // Not available in dev / unpackaged — skip silently
    return;
  }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('update-available', (info) =>
    win.webContents.send('update-available', { version: info.version }));
  updater.on('update-not-available', () =>
    win.webContents.send('update-not-available'));
  updater.on('update-downloaded', (info) =>
    win.webContents.send('update-downloaded', { version: info.version }));
  updater.on('download-progress', (p) =>
    win.webContents.send('update-progress', p));
  updater.on('error', (err) => {
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
