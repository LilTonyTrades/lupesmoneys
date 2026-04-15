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
// Saved when the real update-downloaded event fires.
let _downloadedInstallerPath = null;

// Scan electron-updater's cache directories for the newest installer .exe.
// Used when _downloadedInstallerPath is null (update-downloaded never fired).
function findUpdaterInstaller() {
  const fs = require('fs');

  // 1. Best: explicitly saved path from the real update-downloaded event
  if (_downloadedInstallerPath) {
    try { if (fs.existsSync(_downloadedInstallerPath)) return _downloadedInstallerPath; } catch (_) {}
  }

  // 2. Scan electron-updater's pending directory.
  //    electron-updater stores files at: <userData>/<appName>-updater/pending/
  //    Try several name-casing variants since it depends on app.getName() vs package name.
  const userData = app.getPath('userData');
  const appName = app.getName();  // "OpenClaw Books" in packaged build
  const candidateDirs = [
    path.join(userData, appName + '-updater', 'pending'),
    path.join(userData, 'openclaw-books-updater', 'pending'),
    path.join(process.env.LOCALAPPDATA || '', appName + '-updater', 'pending'),
    path.join(process.env.LOCALAPPDATA || '', 'openclaw-books-updater', 'pending'),
  ];

  for (const dir of candidateDirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      const exes = fs.readdirSync(dir)
        .filter(f => f.toLowerCase().endsWith('.exe'))
        .map(f => { const full = path.join(dir, f); return { full, mtime: fs.statSync(full).mtimeMs }; })
        .sort((a, b) => b.mtime - a.mtime);
      if (exes.length) {
        console.log('[updater] Found installer via scan:', exes[0].full);
        return exes[0].full;
      }
    } catch (_) {}
  }
  return null;
}


// Verify Authenticode signature on a .exe via PowerShell. Synchronous so we
// can gate spawn() on the result. Returns { ok, reason, signer }.
function verifyInstallerSignature(filePath) {
  // Skip on non-Windows (no Authenticode) — we only build NSIS for win32 today.
  if (process.platform !== 'win32') return { ok: true, reason: 'non-win32', signer: 'n/a' };
  try {
    const { execFileSync } = require('child_process');
    // PowerShell returns Status (Valid/NotSigned/...) and SignerCertificate.Subject
    const cmd = `(Get-AuthenticodeSignature -FilePath '${filePath.replace(/'/g, "''")}') | Select-Object -Property Status,@{Name='Signer';Expression={$_.SignerCertificate.Subject}} | ConvertTo-Json -Compress`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 10000, encoding: 'utf8' });
    const info = JSON.parse(out.trim() || '{}');
    if (info.Status !== 'Valid') return { ok: false, reason: 'Status=' + info.Status, signer: info.Signer || '' };
    // Require the configured publisher name to appear in the signer subject.
    // Mirrors the publisherName field in package.json's electron-builder config.
    const required = 'LilTonyTrades';
    if (!info.Signer || !info.Signer.includes(required)) {
      return { ok: false, reason: 'Signer mismatch: ' + (info.Signer || '<none>'), signer: info.Signer || '' };
    }
    return { ok: true, reason: 'valid', signer: info.Signer };
  } catch (e) {
    return { ok: false, reason: 'verify error: ' + e.message, signer: '' };
  }
}

// ── IPC handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.on('install-update', (event) => {
  // #14 — Verify sender frame is our top-level window. Stops malicious iframe
  // (in case CSP ever fails) or compromised renderer subframe from triggering
  // an installer launch.
  if (!mainWindow || event.senderFrame !== mainWindow.webContents.mainFrame) {
    console.warn('[updater] install-update rejected: sender frame mismatch');
    return;
  }
  app.isQuitting = true;

  const installerPath = findUpdaterInstaller();

  if (installerPath) {
    // #3 — Verify the installer is signed by our publisher before launching.
    // electron-updater's downloads can in principle be tampered with by another
    // local process between download and execution, so we re-check signature.
    const verifyResult = verifyInstallerSignature(installerPath);
    if (!verifyResult.ok) {
      console.error('[updater] REFUSING to spawn unsigned/invalid installer:', verifyResult.reason);
      try { mainWindow?.webContents.send('update-error', 'Installer signature verification failed: ' + verifyResult.reason); } catch (_) {}
      app.isQuitting = false; // Allow the user to keep using the app
      return;
    }
    // Spawn the installer as a completely independent process, then exit.
    console.log('[updater] Spawning installer:', installerPath, '(signed by:', verifyResult.signer + ')');
    try {
      require('child_process').spawn(installerPath, [], { detached: true, stdio: 'ignore' }).unref();
    } catch (e) {
      console.error('[updater] spawn failed:', e.message);
    }
  } else {
    // File not on disk — try the built-in quitAndInstall.
    // NOTE: quitAndInstall may return without throwing even when it does nothing,
    // so we do NOT rely on it quitting the app — we force-exit below regardless.
    console.log('[updater] No installer file found, trying quitAndInstall');
    try { require('electron-updater').autoUpdater.quitAndInstall(false, true); } catch (e) {
      console.error('[updater] quitAndInstall failed:', e.message);
    }
  }

  // Always force-close the app after a short delay so the spawned installer
  // has time to start. app.exit() bypasses all lifecycle hooks — guaranteed.
  setTimeout(() => {
    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy(); } catch (_) {}
    app.exit(0);
  }, 400);
});
ipcMain.on('check-for-update', (event) => {
  if (!mainWindow || event.senderFrame !== mainWindow.webContents.mainFrame) {
    console.warn('[updater] check-for-update rejected: sender frame mismatch');
    return;
  }
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

  updater.on('update-not-available', () => {
    if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
    win.webContents.send('update-not-available');
  });

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
