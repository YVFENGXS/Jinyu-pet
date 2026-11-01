const { app, BrowserWindow, ipcMain, globalShortcut, screen, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const WEB_ROOT = path.join(__dirname, '..', 'prototype-webview', 'web');
const LOG_DIR = path.join(process.env.TEMP || '.', 'rp-pet-electron');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'host.log');
const log = (...parts) => {
  try {
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + parts.join(' ') + '\n');
  } catch { /* logging must never break the pet */ }
};

log('main start', process.argv.slice(1).join(' '));

const HISTORY_LIMIT = 120;   // 面板显示的条数
const HISTORY_KEEP = 400;    // 文件里最多保留的条数

function historyFile() {
  return path.join(app.getPath('userData'), 'chat-history.jsonl');
}

/** 读本地聊天记录；坏行跳过，只返回最后 limit 条。 */
function readHistory(limit = HISTORY_LIMIT) {
  try {
    const raw = fs.readFileSync(historyFile(), 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        const role = item && item.role;
        const text = item && item.text;
        if ((role === 'me' || role === 'pet') && typeof text === 'string' && text) {
          out.push({ ts: String(item.ts || ''), role, text });
        }
      } catch { /* 跳过损坏的行 */ }
    }
    return out.slice(-limit);
  } catch {
    return [];
  }
}

/** 追加一条对话到本地文件；超过体积上限后压缩为最近 HISTORY_KEEP 条。 */
function appendHistory(role, text) {
  if (role !== 'me' && role !== 'pet') return;
  const body = String(text || '').trim().slice(0, 1000);
  if (!body) return;
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.appendFileSync(historyFile(),
      JSON.stringify({ ts: new Date().toISOString(), role, text: body }) + '\n');
    if (fs.statSync(historyFile()).size > 256 * 1024) {
      const keep = readHistory(HISTORY_KEEP)
        .map((e) => JSON.stringify(e)).join('\n');
      fs.writeFileSync(historyFile(), keep ? keep + '\n' : '');
    }
  } catch (e) {
    log('history write failed', e && e.message);
  }
}

const CURSOR_MS = 16;
const LEASE_MS = 1500;
const STILL = process.argv.includes('--still');
const SELF_TEST = process.argv.includes('--self-test');

function argValue(flag) {
  const eq = flag + '=';
  const joined = process.argv.find((a) => typeof a === 'string' && a.startsWith(eq));
  if (joined) return joined.slice(eq.length);
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] || '') : '';
}
// 没带参数时默认指向本机 8787（宿主会自己拉起 SSH 隧道）。
// 只有显式给了 URL / --desktop-auto 才自动连；直接 npm start 时保持离线，右键菜单可随时一键连上。
const DEFAULT_DESKTOP_URL = 'ws://127.0.0.1:8787/desktop/v1/ws';
const DESKTOP_URL = process.env.RP_DESKTOP_URL || argValue('--desktop-url') || DEFAULT_DESKTOP_URL;
const DESKTOP_TOKEN = process.env.RP_DESKTOP_TOKEN || argValue('--desktop-token');
const DESKTOP_AUTO = !!(process.env.RP_DESKTOP_URL || argValue('--desktop-url')
  || process.argv.includes('--desktop-auto'));

const TUNNEL_PORT = 8787;
// 主机与私钥属于本机环境，不能进仓库：优先环境变量，其次 ~/.rp-pet/config.json，
// 密钥文件默认放 ~/.rp-pet/deploy_key。三者都缺时就不开隧道，只在本地假回复。
const PET_HOME = path.join(process.env.USERPROFILE || '', '.rp-pet');
const PET_CONFIG = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PET_HOME, 'config.json'), 'utf8')) || {};
  } catch {
    return {};
  }
})();
const TUNNEL_HOST = process.env.RP_TUNNEL_HOST || PET_CONFIG.tunnelHost || '';
const TUNNEL_KEYS = [
  process.env.RP_DEPLOY_KEY,
  PET_CONFIG.deployKey,
  path.join(PET_HOME, 'deploy_key')
].filter(Boolean);

let tunnelProc = null;

/** 本机端口是否已有人监听：已经有隧道或服务在本地跑，就不再开第二条。 */
function portOpen(port, timeout = 600) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/** 后台拉起 SSH 隧道；windowsHide 让它不弹黑窗口。 */
function startTunnel() {
  if (tunnelProc) return true;
  if (!TUNNEL_HOST) {
    log('tunnel skipped: no host');
    return false;
  }
  const key = TUNNEL_KEYS.find((p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  });
  if (!key) {
    log('tunnel skipped: no ssh key');
    return false;
  }
  const ssh = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
  const bin = fs.existsSync(ssh) ? ssh : 'ssh';
  try {
    tunnelProc = spawn(bin, [
      '-N', '-i', key,
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-L', `127.0.0.1:${TUNNEL_PORT}:127.0.0.1:${TUNNEL_PORT}`,
      TUNNEL_HOST
    ], { windowsHide: true, stdio: 'ignore' });
    tunnelProc.on('exit', (code) => {
      log('tunnel exit', code);
      tunnelProc = null;
    });
    tunnelProc.on('error', (e) => {
      log('tunnel error', e && e.message);
      tunnelProc = null;
    });
    log('tunnel start', TUNNEL_HOST, key);
    return true;
  } catch (e) {
    log('tunnel spawn failed', e && e.message);
    tunnelProc = null;
    return false;
  }
}

function stopTunnel() {
  if (!tunnelProc) return;
  try { tunnelProc.kill(); } catch { /* already gone */ }
  tunnelProc = null;
  log('tunnel stop');
}

let desktopSocket = null;
let desktopReady = false;
let desktopSeq = 0;
let desktopPending = null;
let desktopTimer = null;
let desktopRetry = 0;
let desktopClosed = true;
let desktopWanted = false;

let win = null;
let server = null;
let pageUrl = '';
let displayId = null;
let pressing = false;
let interactive = false;
let interactiveUntil = 0;
let cursorTimer = null;
let hidden = false;
let quitting = false;
let lastInteractiveLogged = null;
let applyingBounds = false;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg'
};

function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      try {
        let rel = decodeURIComponent((req.url || '/').split('?')[0]);
        if (rel === '/' || rel === '') rel = '/index.html';
        rel = rel.replace(/^([/\\])+/, '');
        if (rel.includes('..')) { res.writeHead(403); res.end('forbidden'); return; }
        const file = path.join(WEB_ROOT, rel);
        fs.readFile(file, (err, data) => {
          if (err) { res.writeHead(404); res.end('not found'); return; }
          res.writeHead(200, {
            'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store'
          });
          res.end(data);
        });
      } catch {
        res.writeHead(500); res.end('error');
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      pageUrl = `http://127.0.0.1:${server.address().port}/index.html`;
      log('server', pageUrl, 'web=' + WEB_ROOT);
      resolve();
    });
  });
}

function currentDisplay() {
  return screen.getAllDisplays().find((d) => d.id === displayId) || screen.getPrimaryDisplay();
}

function applyDisplay(d) {
  if (!win || win.isDestroyed()) return null;
  const wa = d.workArea;
  const old = win.getBounds();
  const from = screen.getDisplayMatching(old);
  applyingBounds = true;
  try {
    // Windows 跨不同缩放的显示器时，先缩成 1x1 再设目标矩形，避免用旧屏的缩放算新尺寸
    if (process.platform === 'win32' && from.id !== d.id && from.scaleFactor !== d.scaleFactor) {
      win.setBounds({ x: wa.x, y: wa.y, width: 1, height: 1 });
    }
    displayId = d.id;
    win.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
  } finally {
    setTimeout(() => { applyingBounds = false; }, 150);
  }
  return { x: old.x - wa.x, y: old.y - wa.y, w: wa.width, h: wa.height };
}

function snapIfNeeded() {
  if (!win || win.isDestroyed() || applyingBounds) return;
  const b = win.getBounds();
  const d = screen.getDisplayMatching(b);
  const wa = d.workArea;
  const near = Math.abs(b.x - wa.x) <= 2 && Math.abs(b.y - wa.y) <= 2 &&
    Math.abs(b.width - wa.width) <= 2 && Math.abs(b.height - wa.height) <= 2;
  if (near) {
    displayId = d.id;
    return;
  }
  log('snap window', JSON.stringify(b), '->', JSON.stringify(wa), 'scale', d.scaleFactor);
  applyDisplay(d);
}

function createWindow() {
  const d = screen.getPrimaryDisplay();
  displayId = d.id;
  const wa = d.workArea;
  const displayList = screen.getAllDisplays().map((x) => ({
    id: x.id, bounds: x.bounds, work: x.workArea, scale: x.scaleFactor
  }));
  log('displays', JSON.stringify(displayList));
  log('primary work', JSON.stringify(wa), 'scale', d.scaleFactor);

  win = new BrowserWindow({
    x: wa.x, y: wa.y, width: wa.width, height: wa.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    title: '瑾瑜',
    ...(process.platform === 'win32' ? { type: 'toolbar' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: false });
  win.on('move', snapIfNeeded);
  win.on('resize', snapIfNeeded);

  win.once('ready-to-show', () => {
    win.showInactive();
    hidden = false;
    log('shown', JSON.stringify(win.getBounds()));
  });
  win.on('blur', () => send({ type: 'blur' }));
  win.on('closed', () => {
    win = null;
  });
  win.webContents.on('did-finish-load', () => {
    try { win.webContents.setZoomLevel(0); } catch { /* noop */ }
    log('page loaded');
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => log('page fail', code, desc, url));
  win.webContents.on('render-process-gone', (_e, details) => log('render gone', JSON.stringify(details)));
  win.webContents.on('before-input-event', (event, input) => {
    if ((input.control || input.meta) && (['-', '_', '=', '+', '0'].includes(input.key) || ['NumpadAdd', 'NumpadSubtract', 'Numpad0'].includes(input.code))) {
      event.preventDefault();
    }
  });

  win.loadURL(pageUrl);
}

function send(payload) {
  if (!win || win.isDestroyed()) return;
  try { win.webContents.send('pet:host', payload); } catch { /* window closing */ }
}

function newId() {
  return require('crypto').randomUUID().replace(/-/g, '');
}

let cachedDeviceId = null;
function deviceId() {
  if (cachedDeviceId) return cachedDeviceId;
  try {
    const file = path.join(app.getPath('userData'), 'device.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && typeof data.device_id === 'string' && data.device_id) {
      cachedDeviceId = data.device_id;
      return cachedDeviceId;
    }
  } catch { /* first run */ }
  cachedDeviceId = 'dev_' + newId().slice(0, 12);
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(path.join(app.getPath('userData'), 'device.json'), JSON.stringify({ device_id: cachedDeviceId }));
  } catch { /* device id is still usable for this run */ }
  return cachedDeviceId;
}

function desktopDown(reason) {
  const wasReady = desktopReady;
  desktopReady = false;
  desktopClosed = true;
  if (desktopPending) {
    desktopPending = null;
    if (desktopTimer) clearTimeout(desktopTimer);
    desktopTimer = null;
    send({ type: 'chatFallback' });
  }
  if (wasReady) send({ type: 'serverStatus', on: false });
  log('desktop down', reason || '');
  if (desktopWanted && !quitting) {
    const delay = Math.min(30000, 1000 * Math.pow(2, desktopRetry++));
    setTimeout(startDesktop, delay);
  }
}

/** 连服务器：先确保隧道在，再建 WebSocket；重连也走这一条。 */
let desktopStarting = false;
async function startDesktop() {
  if (!DESKTOP_URL || desktopStarting) return;
  if (desktopWanted && desktopSocket) return;
  desktopStarting = true;
  try {
    if (!(await portOpen(TUNNEL_PORT))) {
      startTunnel();
      const t0 = Date.now();
      while (Date.now() - t0 < 6000) {
        if (await portOpen(TUNNEL_PORT, 300)) break;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    connectDesktop();
  } finally {
    desktopStarting = false;
  }
}

/** 一键断开：关 WebSocket 并停掉自己拉起的隧道。 */
function stopDesktop() {
  desktopWanted = false;
  desktopClosed = true;
  if (desktopSocket) {
    try { desktopSocket.close(); } catch { /* noop */ }
    desktopSocket = null;
  }
  stopTunnel();
  const wasReady = desktopReady;
  desktopReady = false;
  if (wasReady) send({ type: 'serverStatus', on: false });
  log('desktop stopped by user');
}

function connectDesktop() {
  if (desktopClosed === false && desktopSocket) return;
  if (!DESKTOP_URL) {
    desktopWanted = false;
    log('desktop disabled (no RP_DESKTOP_URL / --desktop-url)');
    return;
  }
  if (typeof WebSocket !== 'function') {
    desktopWanted = false;
    log('desktop disabled (WebSocket unavailable)');
    return;
  }

  desktopWanted = true;
  let url;
  try {
    url = new URL(DESKTOP_URL);
    if (DESKTOP_TOKEN) url.searchParams.set('token', DESKTOP_TOKEN);
  } catch (e) {
    desktopWanted = false;
    log('desktop bad url', e && e.message);
    return;
  }

  try {
    desktopSocket = new WebSocket(url.toString());
  } catch (e) {
    desktopSocket = null;
    log('desktop ws failed', e && e.message);
    return;
  }
  const socket = desktopSocket;
  desktopClosed = false;

  socket.addEventListener('open', () => {
    log('desktop ws open', url.origin + url.pathname);
    const hello = {
      v: 1,
      id: newId(),
      type: 'hello',
      ts: Date.now(),
      seq: 0,
      payload: {
        protocol: 'desktop-v1',
        device_id: deviceId(),
        device_name: require('os').hostname(),
        client_version: '0.1.0',
        capabilities: ['bubble.v1', 'presence.report'],
        presence: 'active'
      }
    };
    try { socket.send(JSON.stringify(hello)); } catch (e) { log('desktop hello failed', e && e.message); }
  });

  socket.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(typeof event.data === 'string' ? event.data : ''); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'hello.ack') {
      desktopReady = true;
      desktopRetry = 0;
      log('desktop ready', msg.payload && msg.payload.session);
      send({ type: 'serverStatus', on: true });
      return;
    }
    if (msg.type === 'pet.say') {
      desktopReady = true;
      if (desktopPending) {
        desktopPending = null;
        if (desktopTimer) clearTimeout(desktopTimer);
        desktopTimer = null;
      }
      const payload = msg.payload || {};
      log('desktop say bubbles=' + (Array.isArray(payload.bubbles) ? payload.bubbles.length : 0));
      send({
        type: 'serverSay',
        bubbles: Array.isArray(payload.bubbles) ? payload.bubbles : [],
        actions: Array.isArray(payload.actions) ? payload.actions : [],
        priority: typeof payload.priority === 'number' ? payload.priority : 1
      });
      try {
        socket.send(JSON.stringify({
          v: 1, id: newId(), type: 'ack', ts: Date.now(), seq: 0,
          payload: { ref_id: msg.id, status: 'rendered' }
        }));
      } catch { /* ack is best effort */ }
      return;
    }
    if (msg.type === 'ping') {
      try {
        socket.send(JSON.stringify({ v: 1, id: newId(), type: 'pong', ts: Date.now(), seq: 0, payload: {} }));
      } catch { /* noop */ }
      return;
    }
    if (msg.type === 'error') {
      log('desktop error message', JSON.stringify(msg.payload || {}));
      try { socket.close(); } catch { /* close follows */ }
    }
  });

  socket.addEventListener('close', (event) => {
    if (desktopSocket === socket) desktopSocket = null;
    desktopDown('closed ' + (event.code || ''));
  });

  socket.addEventListener('error', () => {
    log('desktop ws error');
  });
}

function applyInteractive() {
  if (!win || win.isDestroyed()) return;
  try {
    win.setIgnoreMouseEvents(!interactive, { forward: false });
    if (lastInteractiveLogged !== interactive) {
      lastInteractiveLogged = interactive;
      log('interactive', interactive);
    }
  } catch { /* window closing */ }
}

function sendCursor() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  const pt = screen.getCursorScreenPoint();
  let b = win.getBounds();

  if (pressing) {
    const inside = pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height;
    if (!inside) {
      const target = screen.getDisplayNearestPoint(pt);
      if (target.id !== displayId) {
        const old = win.getBounds();
        const moved = applyDisplay(target);
        if (moved) {
          b = win.getBounds();
          send({
            type: 'follow',
            x: pt.x - b.x,
            y: pt.y - b.y,
            w: b.width,
            h: b.height,
            dx: old.x - b.x,
            dy: old.y - b.y
          });
          log('follow display', target.id, JSON.stringify(b));
        }
      }
    }
  }

  b = win.getBounds();
  const x = pt.x - b.x;
  const y = pt.y - b.y;
  send({
    type: 'cursor',
    x, y,
    inside: x >= 0 && y >= 0 && x < b.width && y < b.height,
    screenX: pt.x,
    screenY: pt.y
  });

  if (interactive && Date.now() > interactiveUntil) {
    interactive = false;
    applyInteractive();
  }
}

function isProtectedPath(p) {
  try {
    const full = path.resolve(p);
    const root = path.parse(full).root;
    if (full === root) return true;
    const desktop = app.getPath('desktop');
    const home = app.getPath('home');
    if (full === desktop || full === home) return true;
    const windows = process.env.WINDIR;
    if (windows && full.toLowerCase().startsWith(path.resolve(windows).toLowerCase() + path.sep)) return true;
    return false;
  } catch { return true; }
}

async function handleFeed(paths) {
  const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p.length > 0).slice(0, 100) : [];
  const names = list.map((p) => path.basename(p));
  const errors = [];

  for (const p of list) {
    try {
      const full = path.resolve(p);
      if (isProtectedPath(full)) { errors.push(`${path.basename(full)}：不能吃`); continue; }
      if (!fs.existsSync(full)) { errors.push(`${path.basename(full)}：已经不在原处`); continue; }
      await shell.trashItem(full);
    } catch (e) {
      const raw = e && e.message ? e.message : String(e);
      const friendly = /unauthorized|access is denied|access denied|拒绝访问|0x80070005/i.test(raw)
        ? 'Windows 拒绝访问（请允许 electron.exe 修改桌面，或确认安全软件没有锁定这个文件）'
        : raw;
      errors.push(`${path.basename(p)}：${friendly}`);
    }
  }

  const ok = errors.length === 0;
  send({ type: 'feedDone', ok, names, count: list.length, error: ok ? null : errors.join('；') });
  log('feed', list.join(' | '), ok ? 'ok' : 'failed ' + errors.join('；'));
}

ipcMain.on('pet:message', (e, msg) => {
  if (!win || e.sender !== win.webContents || !msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'interactive':
      interactive = !!msg.on;
      interactiveUntil = Date.now() + LEASE_MS;
      applyInteractive();
      break;
    case 'press':
      pressing = !!msg.on;
      break;
    case 'focusInput':
      log('focus input');
      if (!win) break;
      win.show();
      hidden = false;
      win.focus();
      break;
    case 'hide':
      if (win) { win.hide(); hidden = true; }
      break;
    case 'quit':
      quitting = true;
      app.quit();
      break;
    case 'copy':
      if (typeof msg.text === 'string') clipboard.writeText(msg.text);
      break;
    case 'history':
      if (msg.action === 'append') appendHistory(msg.role, msg.text);
      else if (msg.action === 'list') {
        send({ type: 'historyList', entries: readHistory(), file: historyFile() });
      }
      break;
    case 'server':
      if (msg.action === 'connect') startDesktop();
      else if (msg.action === 'disconnect') stopDesktop();
      break;
    case 'feed':
      handleFeed(msg.paths);
      break;
    case 'chat': {
      const text = String(msg.text || '').trim();
      if (!text) break;
      log('chat request len=' + text.length + ' ready=' + desktopReady);
      if (desktopReady && desktopSocket && desktopSocket.readyState === 1) {
        desktopPending = text;
        send({ type: 'chatPending' });
        const seq = ++desktopSeq;
        try {
          desktopSocket.send(JSON.stringify({
            v: 1, id: newId(), type: 'event.text', ts: Date.now(), seq,
            payload: { text, source: 'keyboard' }
          }));
          if (desktopTimer) clearTimeout(desktopTimer);
          desktopTimer = setTimeout(() => {
            if (!desktopPending) return;
            desktopPending = null;
            send({ type: 'chatFallback' });
          }, 25000);
        } catch (e) {
          desktopPending = null;
          log('desktop chat send failed', e && e.message);
          send({ type: 'chatFallback' });
        }
      } else {
        send({ type: 'chatFallback' });
      }
      break;
    }
    case 'boot':
      log('page boot', 'history=' + historyFile());
      send({ type: 'historyList', entries: readHistory(), file: historyFile() });
      if (STILL) setTimeout(() => send({ type: 'roam', on: false }), 500);
      if (SELF_TEST) {
        setTimeout(() => send({ type: 'debugChat', text: '饿' }), 900);
      }
      break;
    case 'log':
      log('web:', String(msg.text ?? ''));
      break;
    case 'hitmap':
      break;
    default:
      break;
  }
});

if (!app.requestSingleInstanceLock()) {
  log('single instance lock failed');
  app.quit();
} else {
  log('single instance lock ok');
  app.whenReady().then(async () => {
    log('app ready');
    await startServer();
    createWindow();
    cursorTimer = setInterval(sendCursor, CURSOR_MS);
    if (DESKTOP_AUTO) startDesktop();

    const ok = globalShortcut.register('Control+Alt+J', () => {
      if (!win) return;
      if (win.isVisible()) {
        win.hide();
        hidden = true;
        log('hotkey hide');
      } else {
        win.showInactive();
        hidden = false;
        send({ type: 'recall' });
        log('hotkey show');
      }
    });
    if (!ok) log('hotkey register failed');
  });

  // 显卡进程崩溃后 WebGL 画布会留下白块（页面还在，但鲸鱼没了）：等 GPU 进程重启后自动刷新一次
  let gpuReloadAt = 0;
  app.on('child-process-gone', (_event, details) => {
    log('child gone', details.type, details.reason, details.exitCode);
    if (details.type !== 'GPU') return;
    if (Date.now() - gpuReloadAt < 60000) return;
    gpuReloadAt = Date.now();
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      log('reload after gpu crash');
      win.reload();
    }, 1200);
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    desktopWanted = false;
    if (desktopSocket) {
      try { desktopSocket.close(); } catch { /* noop */ }
    }
    stopTunnel();
    if (cursorTimer) clearInterval(cursorTimer);
    globalShortcut.unregisterAll();
    if (server) server.close();
  });
}

process.on('uncaughtException', (e) => log('uncaught', e && e.stack ? e.stack : e));
process.on('exit', () => {
  if (tunnelProc) {
    try { tunnelProc.kill(); } catch { /* noop */ }
  }
});
