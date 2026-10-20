# BUSHFIRE desktop

The WW3-in-the-Australian-bush shooter from [ww3.bin-chicken.org](https://ww3.bin-chicken.org), as a Windows app.

## Download

Grab it from **[Releases](../../releases/latest)**:

- `Bushfire-Setup.exe` installs for just you (no admin needed) and adds a Start menu shortcut.
- `Bushfire-Portable.exe` is a single file you can run from anywhere, USB stick included.

Windows will say **"Windows protected your PC"** because the exe isn't code-signed (that costs real money).
Click **More info → Run anyway**.

## What it does

The whole game ships inside the app. When you launch it:

1. It connects to `ww3.bin-chicken.org` like the website does.
2. If that's blocked, it tries a backup direct route to the server.
3. If neither works, you can still play **solo**. Progress won't save, and the leaderboards show
   whatever they were the last time you were online.

While online, it checks the server for changed game files and downloads only those, so the app stays
current without reinstalling.

Your career lives on the server, so **log in** (top-right of the menu) to carry an account over from the website.

Keys: **F11** fullscreen, **F12** dev tools.

## Building

```
npm install
npm run dist      # seeds the offline copy from the server, then builds dist/*.exe
```

`seed.js` pulls every game file from the server, so the bundled ETags match it. Files: `main.js` (window),
`proxy.js` (local server: cache, upstream picking, websocket splice), `direct-cert.pem` (the pinned
self-signed cert of the direct route).
