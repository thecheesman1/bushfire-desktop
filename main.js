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
app.commandLine.appendSwitch('force_high_performance_gpu'); // gaming laptops: the Nvidia/AMD chip, not the iGPU Chrome defaults to

// a newer app build on GitHub? (the game itself self-updates through proxy.js, this is only for the shell)
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
    win = new BrowserWindow({
      width: 1600, height: 900, show: false, title: 'BUSHFIRE', backgroundColor: '#14170f',
      icon: path.join(__dirname, 'icon.png'),
      webPreferences: { backgroundThrottling: false },
    });
    win.once('ready-to-show', () => { win.maximize(); win.show(); if (!process.env.BF_SHOT) setTimeout(() => checkForUpdate(win), 5000); });
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
