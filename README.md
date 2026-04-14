# OpenClaw Books — Windows Desktop App

Schedule C bookkeeping software for self-employed individuals.
Track income, expenses, mileage, invoices, contractors, and export for TurboTax.

---

## Prerequisites

You need **Node.js** installed on your Windows machine.

1. Download Node.js (LTS version) from: https://nodejs.org
2. Run the installer — accept all defaults (this also installs npm)
3. Restart your terminal after installation

To verify it's installed, open **Command Prompt** or **PowerShell** and run:
```
node --version
npm --version
```

Both should print version numbers.

---

## Quick Start (5 minutes)

### Step 1: Extract the project files

Extract/copy the `openclaw-books` folder to somewhere convenient, like:
```
C:\Users\YourName\Desktop\openclaw-books
```

### Step 2: Install dependencies

Open **Command Prompt** or **PowerShell**, navigate to the project folder, and run:

```bash
cd C:\Users\YourName\Desktop\openclaw-books
npm install
```

This downloads all required libraries (~200MB, takes 1-3 minutes).

### Step 3: Test it (optional)

To test the app in development mode (opens in a browser):
```bash
npm run dev
```
Then open http://localhost:5173 in your browser.

To test with the Electron desktop window:
```bash
npm run electron:dev
```

### Step 4: Build the Windows installer

```bash
npm run electron:build
```

This will:
1. Build the React app into optimized static files
2. Package everything with Electron
3. Create a Windows installer in the `release/` folder

When done, you'll find your installer at:
```
release\OpenClaw Books Setup 1.0.0.exe
```

---

## Build Options

| Command | Output |
|---------|--------|
| `npm run electron:build` | NSIS installer (.exe) — standard "Next → Next → Install" |
| `npm run electron:build:portable` | Portable .exe — no install needed, runs directly |

---

## What the installer does

The NSIS installer (`OpenClaw Books Setup 1.0.0.exe`):

- Shows a standard Windows install wizard
- Lets the user choose the install directory
- Creates a **Desktop shortcut**
- Creates a **Start Menu shortcut**
- Adds an **uninstaller** in Windows Settings → Apps
- Installs to `C:\Users\YourName\AppData\Local\Programs\OpenClaw Books\`

---

## Customization

### Change the app icon

Replace `public/icon.png` with your own 256×256 PNG icon.

For the best Windows experience, also create an `.ico` file:
1. Use a tool like https://convertio.co/png-ico/ to convert your PNG to ICO
2. Save as `public/icon.ico`
3. Update `package.json` — change `"icon": "public/icon.png"` to `"icon": "public/icon.ico"`

### Change the app name

Edit `package.json`:
- `"productName"` — the name shown in the installer and taskbar
- `"appId"` — unique identifier (reverse domain, e.g., `com.yourname.books`)
- `"shortcutName"` — name of the desktop/start menu shortcut

### Change the version

Edit `"version"` in `package.json`. The installer filename includes the version.

---

## Project Structure

```
openclaw-books/
├── electron/
│   └── main.cjs          # Electron main process (creates the window)
├── public/
│   └── icon.png           # App icon
├── src/
│   ├── App.jsx            # The full bookkeeping application
│   └── main.jsx           # React entry point
├── index.html             # HTML shell
├── package.json           # Dependencies + build config
├── vite.config.js         # Vite bundler config
└── README.md              # This file
```

---

## Data Storage

All data is stored locally in **IndexedDB** inside the Electron app.
Nothing is sent to any server. Your financial data never leaves your machine.

Data location (Windows):
```
C:\Users\YourName\AppData\Roaming\openclaw-books\
```

---

## Troubleshooting

**"npm is not recognized"**
→ Node.js isn't installed or your terminal needs to be restarted after installing.

**Build fails with Python/Visual Studio errors**
→ Some Electron dependencies need build tools. Run:
```bash
npm install --global windows-build-tools
```
Or install Visual Studio Build Tools from https://visualstudio.microsoft.com/visual-cpp-build-tools/

**"electron-builder: command not found"**
→ Run `npm install` again to make sure all dev dependencies are installed.

**App shows a white screen**
→ Make sure `base: './'` is in `vite.config.js` (it's already set).

**Want to update the app after changes?**
→ Just run `npm run electron:build` again. The new installer will overwrite the old installation.
