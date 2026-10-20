// BUSHFIRE desktop: a window pointed at the local proxy (proxy.js), which does all the online/offline juggling.
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { createProxy } = require('./proxy');

// FIXED on purpose: localStorage (career token, settings, account login) is per origin,
// so a different port = a fresh nobody every launch
const PORT = 47820;
const LOCAL = `http://127.0.0.1:${PORT}/`;

app.commandLine.appendSwitch('ignore-gpu-blocklist'); // school laptop iGPUs are often on Chrome's naughty list
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
    win = new BrowserWindow({
      width: 1600, height: 900, show: false, title: 'BUSHFIRE', backgroundColor: '#14170f',
      icon: path.join(__dirname, 'icon.png'),
      webPreferences: { backgroundThrottling: false },
    });
    win.once('ready-to-show', () => { win.maximize(); win.show(); });
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
