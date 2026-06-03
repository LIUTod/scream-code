const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const STATE_FILE = path.join(os.tmpdir(), 'scream-pet-state.json');

let win, tray;

// Kill macOS menu bar so nothing shows in the top bar.
Menu.setApplicationMenu(null);

function createWindow() {
  win = new BrowserWindow({
    width: 128,
    height: 128,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    type: 'panel',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile('pet.html');

  const { screen } = require('electron');
  const s = screen.getPrimaryDisplay().workAreaSize;
  const x = Math.floor(Math.random() * (s.width - 128));
  win.setPosition(x, s.height - 200);
}

function createTray() {
  const iconPath = path.join(__dirname, 'img', 'idle_1.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip('Scream Pet');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '退出', click: () => { app.quit(); } },
  ]));
}

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();  // hide the giant Electron dock icon
  createTray();
  createWindow();
});

app.on('window-all-closed', () => {
  try { fs.unlinkSync(STATE_FILE); } catch { /* ignore */ }
  app.quit();
});
