// BUSHFIRE desktop: a window pointed at the local proxy (proxy.js), which does all the online/offline juggling.
const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const { createProxy } = require('./proxy');

// FIXED on purpose: localStorage (career token, settings, account login) is per origin,
// so a different port = a fresh nobody every launch
const PORT = 47820;
const LOCAL = `http://127.0.0.1:${PORT}/`;

app.commandLine.appendSwitch('ignore-gpu-blocklist'); // school laptop iGPUs are often on Chrome's naughty list
app.commandLine.appendSwitch('force_high_performance_gpu'); // gaming laptops: the Nvidia/AMD chip, not the iGPU Chrome defaults to

// FPS UNLOCKER (Settings, v1.40.1): no vsync, no 60/120/144 cap, the game draws as fast as the GPU goes. These are
// launch switches, so the choice lives in userData/shell.json and flipping it relaunches the app (preload.js -> ipc)
const SHELL_CFG = path.join(app.getPath('userData'), 'shell.json');
const shellCfg = (() => { try { return JSON.parse(fs.readFileSync(SHELL_CFG, 'utf8')); } catch (e) { return {}; } })();
if (shellCfg.fpsUnlock) {
  app.commandLine.appendSwitch('disable-frame-rate-limit');
  app.commandLine.appendSwitch('disable-gpu-vsync');
}
ipcMain.handle('fps-unlock:get', () => !!shellCfg.fpsUnlock);
ipcMain.handle('fps-unlock:set', (e, on) => {
  if (!!shellCfg.fpsUnlock === on) return false;
  shellCfg.fpsUnlock = on;
  try { fs.writeFileSync(SHELL_CFG, JSON.stringify(shellCfg)); } catch (err) { return false; }
  setTimeout(() => { app.relaunch(); app.exit(0); }, 400); // the page saved its run on the way out (it's a reload as far as it knows)
  return true;
});

// a newer app build on GitHub? (the game itself self-updates through proxy.js, this is only for the shell)
// Installed copy: electron-updater pulls it down in the background and swaps it in silently when you quit, so the
// next launch is simply the new version. The portable exe can't patch itself, so it gets the "it's out" popup.
const PORTABLE = !!process.env.PORTABLE_EXECUTABLE_DIR;
function startUpdater(win, log) {
  if (PORTABLE) { setTimeout(() => checkForUpdate(win), 5000); return; }
  if (!app.isPackaged && !process.env.BF_UPDATE_URL) return; // dev runs don't update themselves
  autoUpdater.logger = { info: (m) => log(`updater: ${m}`), warn: (m) => log(`updater warn: ${m}`), error: (m) => log(`updater error: ${m}`), debug: () => {} };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  if (process.env.BF_UPDATE_URL) { // test feed: BF_UPDATE_URL=http://localhost:8099/ serving a latest.yml + the exe
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.setFeedURL({ provider: 'generic', url: process.env.BF_UPDATE_URL });
  }
  autoUpdater.on('update-downloaded', (info) => {
    log(`update ${info.version} downloaded`);
    toast(win, `BUSHFIRE DESKTOP v${info.version} IS READY // IT INSTALLS ITSELF WHEN YOU CLOSE THE GAME`);
  });
  autoUpdater.on('error', (e) => log(`updater: ${e.message}`)); // offline / GitHub blocked: next launch
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);
}
// a little bar in the corner of the game, gone after 15 s
function toast(win, text) {
  win.webContents.executeJavaScript(`(() => { const d = document.createElement('div'); d.textContent = ${JSON.stringify(text)};
    d.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;padding:10px 16px;background:#f2c14ee6;color:#14120c;font:13px "Share Tech Mono",monospace;letter-spacing:1px;pointer-events:none';
    document.body.appendChild(d); setTimeout(() => d.remove(), 15000); })()`).catch(() => {});
}
async function checkForUpdate(win) {
  try {
    const r = await fetch('https://api.github.com/repos/thecheesman1/bushfire-desktop/releases/latest', { signal: AbortSignal.timeout(8000) });
    const tag = (await r.json()).tag_name || '';
    const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
    if (!newer(tag.replace(/^v/, ''), app.getVersion())) return;
    const { response } = await dialog.showMessageBox(win, { type: 'info', title: 'BUSHFIRE', buttons: ['DOWNLOAD', 'LATER'], defaultId: 0,
      message: `BUSHFIRE desktop ${tag} is out (you've got v${app.getVersion()}).`, detail: 'Grab the new installer, run it, done. Your career and settings stay.' });
    if (response === 0) shell.openExternal('https://github.com/thecheesman1/bushfire-desktop/releases/latest');
  } catch (e) { /* offline / GitHub blocked: whatever, next launch */ }
}
app.userAgentFallback = `${app.userAgentFallback} BushfireDesktop/${app.getVersion()}`; // hides the "download da app" bar

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    const userData = app.getPath('userData');
    const logFile = path.join(userData, 'proxy.log');
    try { if (fs.statSync(logFile).size > 2e6) fs.unlinkSync(logFile); } catch (e) { /* no log yet */ }
    const log = (msg) => { const line = `${new Date().toISOString()} ${msg}`; console.log(line); fs.appendFile(logFile, line + '\n', () => {}); };

    const proxy = createProxy({
      port: PORT,
      cacheDir: path.join(userData, 'cache'),
      seedDir: path.join(__dirname, 'seed'),
      cert: fs.readFileSync(path.join(__dirname, 'direct-cert.pem')),
      stateFile: path.join(userData, 'state.json'),
      log,
    });
    try {
      await proxy.listen();
    } catch (e) {
      dialog.showErrorBox('BUSHFIRE', `Port ${PORT} is taken by something else, so the game can't start.\n\n${e.message}`);
      app.quit();
      return;
    }
    proxy.probe();

    Menu.setApplicationMenu(null);
    const off = !!process.env.BF_OFFSCREEN; // tests: parked off-screen, never focused, no taskbar button
    win = new BrowserWindow({
      width: 1600, height: 900, show: false, title: 'BUSHFIRE', backgroundColor: '#14170f',
      icon: path.join(__dirname, 'icon.png'), skipTaskbar: off, focusable: !off,
      webPreferences: { backgroundThrottling: false, preload: path.join(__dirname, 'preload.js') },
    });
    if (off) win.webContents.setAudioMuted(true); // test runs never make noise on the user's machine
    win.once('ready-to-show', () => {
      if (off) { win.setPosition(-4000, -4000); win.showInactive(); } else { win.maximize(); win.show(); }
      if (!process.env.BF_SHOT || process.env.BF_UPDATE_URL) startUpdater(win, log);
    });
    win.on('page-title-updated', (e) => e.preventDefault());
    // our own pages (editor, changelog) open in-app, everything else in the real browser
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(LOCAL)) return { action: 'allow' };
      shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith(LOCAL)) { e.preventDefault(); shell.openExternal(url); }
    });
    win.webContents.on('before-input-event', (e, i) => {
      if (i.type !== 'keyDown') return;
      if (i.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
      if (i.key === 'F12' || (i.control && i.shift && i.key === 'I')) { win.webContents.toggleDevTools(); e.preventDefault(); }
    });
    win.loadURL(LOCAL + (process.env.BF_PATH || '')); // BF_PATH='?test=menu' for test runs
    // BF_SHOT=out.png: screenshot after a few seconds and quit (headless-ish smoke test)
    if (process.env.BF_SHOT) {
      if (process.env.BF_SHOT_JS) setTimeout(() => win.webContents.executeJavaScript(process.env.BF_SHOT_JS, true).catch((e) => log(`shot js: ${e.message}`)), 6000);
      setTimeout(async () => {
        fs.writeFileSync(process.env.BF_SHOT, (await win.webContents.capturePage()).toPNG());
        log(`shot: route ${proxy.status()}, title "${await win.webContents.executeJavaScript('document.title')}"`);
        app.quit();
      }, +process.env.BF_SHOT_MS || 12000);
    }
  });

  app.on('window-all-closed', () => app.quit());
}
