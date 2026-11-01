import { createBody } from './vendor/coopanion/kit/body.js';
import { createWhaleFigure } from './vendor/coopanion/whale/figure.js';
import { createSfx } from './vendor/coopanion/sound.js';

/* ---------- 与宿主通信 ---------- */

const bridge = window.chrome?.webview ?? window.petBridge ?? null;

function post(message) {
  try {
    bridge?.postMessage(message);
  } catch (e) {
    // 宿主不在（例如直接在浏览器里预览）时忽略
  }
}

function log(text) {
  post({ type: 'log', text: String(text) });
}

/** 把一轮对话交给宿主追加到本地记录（宿主没有时静默丢弃）。 */
function record(role, text) {
  const body = String(text || '').trim();
  if (!body) return;
  post({ type: 'history', action: 'append', role, text: body });
}

window.addEventListener('error', (e) => log(`error ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => log(`rejection ${e.reason?.stack || e.reason}`));

/* ---------- 元素 ---------- */

const scene = document.getElementById('scene');
const stage = document.getElementById('stage');
const meal = document.getElementById('meal');
const bubble = document.getElementById('bubble');
const bubbleText = document.getElementById('bubble-text');
const hint = document.getElementById('hint');
const capsule = document.getElementById('capsule');
const input = document.getElementById('input');
const menu = document.getElementById('menu');
const menuQuiet = document.getElementById('menu-quiet');
const menuServer = document.getElementById('menu-server');
const historyPanel = document.getElementById('history');
const histList = document.getElementById('hist-list');
const histClose = document.getElementById('hist-close');
const histPath = document.getElementById('hist-path');
const dots = document.getElementById('dots');
const toastEl = document.getElementById('toast');
const feedEl = document.getElementById('feed');
const feedName = document.getElementById('feed-name');
const errorBox = document.getElementById('error');
const errorText = document.getElementById('error-text');
const errorQuit = document.getElementById('error-quit');

/* ---------- 声音 ---------- */

const sfx = createSfx({ volume: .55 });
sfx.setShown(true);

/* ---------- 状态 ---------- */

const SCHEMES = ['deepseek', 'harness', 'chatgpt', 'claude', 'gemini', 'qwen', 'kimi', 'minimax'];
const SCHEME_NAMES = {
  deepseek: 'DeepSeek', harness: 'DeepSeek Harness', chatgpt: 'ChatGPT', claude: 'Claude',
  gemini: 'Gemini', qwen: '千问', kimi: 'Kimi', minimax: 'MiniMax'
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let body = null;
let figure = null;
let ready = false;
let quiet = false;
let serverOnline = false;
let sleeping = false;
let schemeIndex = 0;
let layoutCache = null;
let lastActivity = Date.now();
let pressing = false;
let uiWish = false;
let uiWishAt = 0;
let feeding = false;
let feedResult = null;
let lastLocal = { x: 0, y: 0 };
let hintUntil = 0;
let bubbleHover = false;
let bubblePinUntil = 0;
let bubbleToken = 0;
let currentText = '';
let toastTimer = null;
let lastHitJson = '';
let lastHitAt = 0;
let lastLayoutLog = '';
let historyEntries = [];
let historyFile = '';

const queue = [];
let playing = false;
let thinking = false;
let chatTimer = 0;
let lastChatText = '';

const SERVER_ACTION = {
  idle: 'stand', wave: 'wave', nod: 'nod', shake: 'shake', headpat: 'nod',
  sleep: 'sleep', think: 'look', celebrate: 'hop', peek: 'look', hide: 'stand'
};
const SERVER_EMOTION = { curious: 'surprised', worried: 'worried' };

function mapServerEmotion(emotion) {
  return SERVER_EMOTION[emotion] || emotion || 'neutral';
}

function inRect(p, el) {
  if (!el || el.classList.contains('hidden')) return false;
  const r = el.getBoundingClientRect();
  return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
}

/** 光标是否落在需要接收鼠标的区域（鲸鱼或任何可见的界面元素）。 */
function overUi(p) {
  return inRect(p, hint) || inRect(p, bubble) || inRect(p, capsule) || inRect(p, menu)
    || inRect(p, feedEl) || inRect(p, historyPanel);
}

/**
 * 让宿主在光标离开鲸鱼后恢复点击穿透；宿主按租约失效，页面每 500ms 续一次。
 */
function setUiInteractive(on) {
  const now = performance.now();
  if (uiWish === on && (!on || now - uiWishAt < 400)) return;
  uiWish = on;
  uiWishAt = now;
  post({ type: 'interactive', on });
}

/* ---------- 舞台尺寸 ---------- */

function bounds() {
  const W = Math.max(200, document.documentElement.clientWidth || window.innerWidth);
  const H = Math.max(240, document.documentElement.clientHeight || window.innerHeight);
  const S = clamp(H / 480, .72, 1.05);
  return { W, H, floorY: H - 24, S };
}

/* ---------- 启动 ---------- */

async function boot() {
  try {
    figure = await createWhaleFigure(undefined, { scheme: 'deepseek-maid' });
    body = createBody({
      root: scene,
      bounds,
      emit: (kind, detail) => {
        if (kind === 'mode') {
          const mode = detail?.mode;
          if (mode && mode !== 'sleep' && mode !== 'sit') sleeping = false;
        }
      },
      sound: (name, kind, ...args) => sfx.play(name, kind, ...args),
      start: { enter: 'drop', facing: 1 }
    }, {
      figure,
      roam: 'calm',
      startX: bounds().W * .72
    });

    body.resize();
    body.set({ roam: 'calm' });
    ready = true;
    post({ type: 'boot' });
    log('大肥鱼就绪');
  } catch (err) {
    fatal(err);
  }
}

function fatal(err) {
  log('启动失败: ' + (err?.stack || err));
  errorText.textContent = String(err?.message || err || '未知错误');
  errorBox.classList.remove('hidden');
  hint.classList.add('hidden');
  bubble.classList.add('hidden');
  postHitmap(true);
}

/* ---------- 每帧 ---------- */

let lastFrame = performance.now();

function frame(now) {
  requestAnimationFrame(frame);

  const dt = Math.min(.05, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;

  if (body) {
    body.step(dt);
    layoutCache = body.layout();
    positionOverlays(layoutCache);
    updateHint(now);
    if (uiWish && now - uiWishAt > 500) {
      uiWishAt = now;
      post({ type: 'interactive', on: true });
    }
    if (ready && !lastLayoutLog) {
      lastLayoutLog = 'ready';
      log(`viewport ${innerWidth}x${innerHeight} dpr ${devicePixelRatio} box ${JSON.stringify(layoutCache.box)} hit ${JSON.stringify(layoutCache.hit)}`);
    }
  }

  if (ready && now - lastHitAt > 100) {
    lastHitAt = now;
    postHitmap(false);
  }
}

function updateHint(now) {
  const L = layoutCache;
  if (!L) return;
  const want = ready
    && now < hintUntil
    && !pressing
    && !feeding
    && capsule.classList.contains('hidden')
    && menu.classList.contains('hidden')
    && historyPanel.classList.contains('hidden')
    && feedEl.classList.contains('hidden')
    && errorBox.classList.contains('hidden');
  if (want === !hint.classList.contains('hidden')) return;
  hint.classList.toggle('hidden', !want);
  postHitmap(true);
}

function positionOverlays(L) {
  const W = innerWidth;
  const H = innerHeight;
  const a = L.bubble;

  if (!bubble.classList.contains('hidden')) {
    const half = Math.max(80, bubble.offsetWidth / 2);
    const left = clamp(a.x, half + 8, W - half - 8);
    bubble.style.left = `${left.toFixed(1)}px`;
    bubble.style.bottom = `${(H - a.y + 10).toFixed(1)}px`;
    bubble.style.setProperty('--tail-x', `${clamp(a.x - left, -half + 18, half - 18).toFixed(1)}px`);
  }

  if (!capsule.classList.contains('hidden')) {
    const half = Math.max(80, capsule.offsetWidth / 2);
    const left = clamp(a.x, half + 8, W - half - 8);
    capsule.style.left = `${left.toFixed(1)}px`;
    capsule.style.bottom = `${(H - a.y + 10).toFixed(1)}px`;
  }

  if (!feedEl.classList.contains('hidden')) {
    feedEl.style.left = `${clamp(a.x, 96, W - 96).toFixed(1)}px`;
    feedEl.style.bottom = `${(H - a.y + 14).toFixed(1)}px`;
  }

  if (!meal.classList.contains('hidden')) {
    const b = L.box;
    meal.style.left = `${(b.x + b.w / 2).toFixed(1)}px`;
    meal.style.bottom = `${(H - (b.y + b.h - 10)).toFixed(1)}px`;
  }

  dots.style.left = `${a.x.toFixed(1)}px`;
  dots.style.top = `${(a.y - 34).toFixed(1)}px`;

  const box = L.box;
  hint.style.left = `${clamp(box.x + box.w + 4, 8, W - 36).toFixed(1)}px`;
  hint.style.top = `${clamp(box.y + 30, 8, H - 36).toFixed(1)}px`;
}

/* ---------- 命中区域 ---------- */

function overlayRects() {
  const rects = [];
  const pushes = [
    bubble, hint, capsule, menu, historyPanel, errorBox
  ];
  for (const el of pushes) {
    if (el.classList.contains('hidden')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    rects.push({ x: +r.left.toFixed(1), y: +r.top.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) });
  }
  return rects;
}

function postHitmap(force) {
  const circles = [];
  if (layoutCache?.hit) {
    for (const c of layoutCache.hit) {
      circles.push({ x: +c.x.toFixed(1), y: +c.y.toFixed(1), r: +c.r.toFixed(1) });
    }
  }
  const payload = { type: 'hitmap', circles, rects: overlayRects() };
  const json = JSON.stringify(payload);
  if (!force && json === lastHitJson) return;
  lastHitJson = json;
  post(payload);
}

function hitWhale(p) {
  if (!layoutCache?.hit) return false;
  return layoutCache.hit.some((c) => Math.hypot(p.x - c.x, p.y - c.y) <= c.r);
}

function hintVisible() {
  return !hint.classList.contains('hidden');
}

/* ---------- 气泡发言 ---------- */

function hideBubble() {
  bubbleToken++;
  bubble.classList.add('hidden');
  bubbleText.textContent = '';
  bubblePinUntil = 0;
  currentText = '';
}

async function say(text, emotion) {
  if (!text) return;
  if (quiet) return;

  currentText = text;
  const token = ++bubbleToken;
  bubbleText.textContent = '';
  bubble.classList.remove('hidden');
  postHitmap(true);

  if (emotion && body) body.do(emotion);

  const chars = Array.from(text);
  const per = clamp(1400 / Math.max(1, chars.length), 18, 90);

  for (let i = 0; i < chars.length; i++) {
    if (token !== bubbleToken) return;
    bubbleText.textContent += chars[i];
    body?.talk();
    if (i % 2 === 0) sfx.babble(chars[i]);
    await sleep(per);
  }

  let remain = clamp(3000 + text.length * 70, 3800, 11000);
  let last = performance.now();
  while (remain > 0) {
    await sleep(100);
    if (token !== bubbleToken) return;
    const now = performance.now();
    if (!bubbleHover && now >= bubblePinUntil) remain -= now - last;
    last = now;
  }

  if (token === bubbleToken) {
    bubble.classList.add('hidden');
    postHitmap(true);
  }
}

function enqueue(message) {
  if (!message?.bubbles?.length) return;
  if (message.priority === 3) queue.unshift(message);
  else queue.push(message);
  if (!playing) runQueue();
}

async function runQueue() {
  if (playing) return;
  playing = true;
  try {
    while (queue.length) {
      const msg = queue.shift();
      if (quiet && msg.priority !== 3) continue;
      lastActivity = Date.now();
      body?.set({ hold: 10 });
      if (msg.action === 'eat') playEatAction();
      else if (msg.action) body?.do(msg.action);
      for (let i = 0; i < msg.bubbles.length; i++) {
        const b = msg.bubbles[i];
        if (i > 0 && b.delay_ms) await sleep(b.delay_ms);
        if (quiet && msg.priority !== 3) break;
        await say(b.text, b.emotion);
      }
      await sleep(250);
    }
  } finally {
    playing = false;
  }
}

/* ---------- 回复 ---------- */

function replyFor(text) {
  if (/累|加班|忙|烦|压力/.test(text)) {
    return { bubbles: [{ text: '那就先歇一会儿吧，我在这儿。', emotion: 'shy' }], action: 'nod' };
  }
  if (/晚安|睡|困|做梦/.test(text)) {
    return { bubbles: [{ text: '晚安，做个好梦。', emotion: 'sleepy' }], action: 'nod' };
  }
  if (/你好|在吗|在不在|嗨|hello/i.test(text)) {
    return {
      bubbles: [
        { text: '在呢。', emotion: 'happy' },
        { text: '今天也要好好吃饭哦。', emotion: 'shy', delay_ms: 800 }
      ],
      action: 'wave'
    };
  }
  if (/吃|饿|饭|零食/.test(text)) {
    return { bubbles: [{ text: '我也想吃。', emotion: 'happy' }, { text: '分我一口嘛。', emotion: 'pout', delay_ms: 800 }], action: 'flap' };
  }
  if (/喜欢|可爱|好看|漂亮/.test(text)) {
    return { bubbles: [{ text: '唔…谢谢。', emotion: 'shy' }, { text: '你这么说，我会当真的。', emotion: 'shy', delay_ms: 900 }], action: 'nod' };
  }
  if (/摸|抱|亲/.test(text)) {
    return { bubbles: [{ text: '嘿嘿。', emotion: 'love' }, { text: '再摸一下也不是不行。', emotion: 'shy', delay_ms: 800 }], action: 'hop' };
  }
  if (/配色|换装|衣服/.test(text)) {
    return { bubbles: [{ text: '右键点我，菜单里有换配色。', emotion: 'happy' }], action: 'nod' };
  }

  const lines = [
    { bubbles: [{ text: '唔，我记下了。', emotion: 'neutral' }], action: 'nod' },
    { bubbles: [{ text: '你这么说，我就当真了。', emotion: 'shy' }], action: 'nod' },
    { bubbles: [{ text: '再讲一点？', emotion: 'confused' }], action: 'look' }
  ];
  return lines[Math.floor(Math.random() * lines.length)];
}

/* ---------- 输入胶囊 ---------- */

function openCapsule() {
  if (!ready) return;
  hideMenu();
  hideHistory();
  hideBubble();
  hintUntil = 0;
  feedEl.classList.add('hidden');
  sleeping = false;
  body?.set({ hold: 90 });
  body?.do('stand');
  body?.do('surprised');
  capsule.classList.remove('hidden');
  post({ type: 'focusInput' });
  postHitmap(true);
  setTimeout(() => input.focus(), 40);
  lastActivity = Date.now();
}

function closeCapsule() {
  if (capsule.classList.contains('hidden')) return;
  capsule.classList.add('hidden');
  input.blur();
  postHitmap(true);
}

function autoGrow() {
  input.style.height = '24px';
  input.style.height = `${Math.min(72, input.scrollHeight)}px`;
}

function finishThinking() {
  thinking = false;
  dots.classList.add('hidden');
  postHitmap(true);
}

function localReply() {
  if (!thinking || !lastChatText) return;
  if (chatTimer) {
    clearTimeout(chatTimer);
    chatTimer = 0;
  }
  finishThinking();
  const reply = replyFor(lastChatText);
  enqueue({ ...reply, priority: 1 });
  if (!quiet) for (const b of reply.bubbles) record('pet', b.text);
}

function sendText() {
  const text = input.value.trim();
  if (!text) return;
  sfx.unlock();
  input.value = '';
  autoGrow();
  closeCapsule();
  lastActivity = Date.now();
  lastChatText = text;
  record('me', text);

  thinking = true;
  dots.classList.remove('hidden');
  body?.do('thinking');
  postHitmap(true);

  if (chatTimer) clearTimeout(chatTimer);
  chatTimer = setTimeout(() => {
    chatTimer = 0;
    if (!thinking) return;
    log('chat fallback: no host reply');
    localReply();
  }, 1600);

  post({ type: 'chat', text });
}

async function playEatAction() {
  if (feeding) return;
  feeding = true;
  body?.set({ hold: 15 });
  body?.do('stand');
  showMeal();
  await sleep(320);
  body?.do('surprised');
  for (let i = 0; i < 10; i++) {
    if (!feeding) break;
    body?.talk();
    await sleep(75);
  }
  body?.do('happy');
  await sleep(900);
  hideMeal();
  feeding = false;
}

/* ---------- 菜单与提示 ---------- */

function showMenu() {
  if (!layoutCache) return;
  hideHistory();
  const box = layoutCache.box;
  const w = 188;
  let left = box.x - w - 8;
  if (left < 8) left = box.x + box.w + 8;
  left = clamp(left, 8, innerWidth - w - 8);
  menu.style.left = `${left}px`;
  menu.classList.remove('hidden');
  const h = menu.offsetHeight || 214;
  menu.style.top = `${clamp(box.y + 20, 8, innerHeight - h - 8)}px`;
  menuQuiet.textContent = quiet ? '取消勿扰' : '静音 / 勿扰';
  menuServer.textContent = serverOnline ? '断开服务器' : '连接服务器';
  postHitmap(true);
}

function hideMenu() {
  if (menu.classList.contains('hidden')) return;
  menu.classList.add('hidden');
  postHitmap(true);
}

/* ---------- 聊天记录 ---------- */

function pad2(n) {
  return String(n).padStart(2, '0');
}

function histDayLabel(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function histTimeLabel(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function renderHistory() {
  histList.textContent = '';
  histPath.textContent = historyFile ? `记录保存在：${historyFile}` : '';
  histPath.title = historyFile || '';

  const entries = historyEntries.slice(-120);
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'hist-empty';
    empty.textContent = '还没有聊过。点鲸鱼旁的「…」输入一句话，这里就会留下记录。';
    histList.appendChild(empty);
    return;
  }

  let lastDay = '';
  for (const e of entries) {
    const day = histDayLabel(e.ts);
    if (day && day !== lastDay) {
      lastDay = day;
      const label = document.createElement('div');
      label.className = 'hist-day';
      label.textContent = day;
      histList.appendChild(label);
    }
    const row = document.createElement('div');
    row.className = `hist-item ${e.role === 'me' ? 'me' : 'pet'}`;
    const who = document.createElement('span');
    who.className = 'hist-who';
    who.textContent = e.role === 'me' ? '我' : '瑾瑜';
    const text = document.createElement('span');
    text.className = 'hist-text';
    text.textContent = e.text;
    const time = document.createElement('time');
    time.className = 'hist-time';
    time.textContent = histTimeLabel(e.ts);
    row.append(who, text, time);
    histList.appendChild(row);
  }
  histList.scrollTop = histList.scrollHeight;
}

function showHistory() {
  if (!layoutCache) return;
  hideMenu();
  hideBubble();
  closeCapsule();
  hintUntil = 0;

  const box = layoutCache.box;
  const w = 300;
  const maxH = Math.min(380, innerHeight - 96);
  let left = box.x - w - 8;
  if (left < 8) left = box.x + box.w + 8;
  left = clamp(left, 8, innerWidth - w - 8);
  historyPanel.style.width = `${w}px`;
  historyPanel.style.maxHeight = `${maxH}px`;
  historyPanel.style.left = `${left}px`;
  historyPanel.classList.remove('hidden');
  renderHistory();
  const h = historyPanel.offsetHeight || 240;
  historyPanel.style.top = `${clamp(box.y + 20, 8, innerHeight - h - 8)}px`;
  lastActivity = Date.now();
  postHitmap(true);
}

function hideHistory() {
  if (historyPanel.classList.contains('hidden')) return;
  historyPanel.classList.add('hidden');
  histList.scrollTop = 0;
  postHitmap(true);
}

function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 1600);
}

function cycleScheme() {
  schemeIndex = (schemeIndex + 1) % SCHEMES.length;
  const id = SCHEMES[schemeIndex];
  try {
    body?.setScheme(`${id}-maid`, { fade: .35 });
  } catch (err) {
    log('换配色失败: ' + (err?.stack || err));
  }
  toast(`配色：${SCHEME_NAMES[id]}`);
  body?.do('happy');
  hideMenu();
  lastActivity = Date.now();
}

function toggleQuiet() {
  quiet = !quiet;
  sfx.set(!quiet);
  menuQuiet.textContent = quiet ? '取消勿扰' : '静音 / 勿扰';
  if (quiet) {
    queue.length = 0;
    hideBubble();
    body?.do('neutral');
    body?.set({ roam: 'off' });
  } else {
    body?.set({ roam: 'calm' });
    sfx.unlock();
  }
  toast(quiet ? '已静音' : '已恢复');
  hideMenu();
}

/* ---------- 窗口事件 ---------- */

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !historyPanel.classList.contains('hidden')) {
    e.preventDefault();
    hideHistory();
  }
});

window.addEventListener('resize', () => {
  if (!body) return;
  body.resize();
  layoutCache = body.layout();
  hideHistory();
  positionOverlays(layoutCache);
  postHitmap(true);
});

window.addEventListener('pointerdown', (e) => {
  if (e.button === 2) return;
  sfx.unlock();
  lastActivity = Date.now();

  const p = { x: e.clientX, y: e.clientY, t: e.timeStamp };
  lastLocal = p;

  // 菜单里的按下不能先 hideMenu：按钮一旦被隐藏，后续 click 就落不到按钮上了
  if (menu.contains(e.target)) return;
  hideMenu();

  if (capsule.contains(e.target)) return;
  if (hint.contains(e.target)) return;
  if (bubble.contains(e.target)) return;
  if (historyPanel.contains(e.target)) return;
  if (!ready || !hitWhale(p)) return;

  sleeping = false;
  pressing = true;
  try {
    body.pointer('down', p);
    stage.setPointerCapture(e.pointerId);
  } catch (err) {
    log('pointer down: ' + err);
  }
  post({ type: 'press', on: true });
  setUiInteractive(true);
  e.preventDefault();
}, true);

window.addEventListener('pointermove', (e) => {
  const p = { x: e.clientX, y: e.clientY, t: e.timeStamp };
  lastLocal = p;

  // 移动与拖拽位置统一由宿主的 cursor 消息驱动，避免页面命中区域变化时指针事件中断
  stage.style.cursor = pressing ? 'grabbing' : (hitWhale(p) ? 'grab' : '');

  if (hitWhale(p)) {
    hintUntil = Date.now() + 1500;
    lastActivity = Date.now();
  } else if (hintVisible()) {
    const r = hint.getBoundingClientRect();
    if (p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom) {
      hintUntil = Date.now() + 1500;
    }
  }

  setUiInteractive(pressing || hitWhale(p) || overUi(p));
});

function endPress(e) {
  if (!pressing) return;
  const p = {
    x: e?.clientX ?? lastLocal.x,
    y: e?.clientY ?? lastLocal.y,
    t: e?.timeStamp ?? performance.now()
  };
  pressing = false;
  try {
    body?.pointer('up', p);
  } catch (err) {
    log('pointer up: ' + err);
  }
  post({ type: 'press', on: false });
  setUiInteractive(false);
  stage.style.cursor = '';
}

window.addEventListener('pointerup', endPress);
window.addEventListener('pointercancel', endPress);
window.addEventListener('pointerleave', () => {
  stage.style.cursor = '';
  if (!pressing && ready) body?.pointer('leave', {});
});

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  lastActivity = Date.now();
  if (bubble.contains(e.target)) {
    copyBubbleText();
    return;
  }
  if (historyPanel.contains(e.target)) return;
  const p = { x: e.clientX, y: e.clientY };
  if (hitWhale(p)) showMenu();
 });

bubble.addEventListener('pointerenter', () => { bubbleHover = true; });
bubble.addEventListener('pointerleave', () => { bubbleHover = false; });
bubble.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (bubblePinUntil > Date.now()) bubblePinUntil = 0;
  else bubblePinUntil = Date.now() + 30000;
});
bubble.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
  copyBubbleText();
});

function copyBubbleText() {
  if (!currentText) return;
  post({ type: 'copy', text: currentText });
  toast('已复制');
}

hint.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  openCapsule();
});

menu.addEventListener('pointerdown', (e) => e.stopPropagation());
menu.addEventListener('click', (e) => {
  const button = e.target.closest('button');
  if (!button) return;
  const act = button.dataset.act;
  if (act === 'palette') cycleScheme();
  else if (act === 'history') showHistory();
  else if (act === 'server') {
    post({ type: 'server', action: serverOnline ? 'disconnect' : 'connect' });
    toast(serverOnline ? '正在断开服务器…' : '正在连接服务器…');
    hideMenu();
  }
  else if (act === 'quiet') toggleQuiet();
  else if (act === 'hide') post({ type: 'hide' });
  else if (act === 'quit') post({ type: 'quit' });
});

historyPanel.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  lastActivity = Date.now();
});

histClose.addEventListener('click', (e) => {
  e.stopPropagation();
  hideHistory();
});

errorQuit.addEventListener('click', () => post({ type: 'quit' }));

input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeCapsule();
    return;
  }
  if ((e.key === 'Enter' || e.keyCode === 13 || e.which === 13) && !e.shiftKey) {
    e.preventDefault();
    sendText();
  }
});

input.addEventListener('input', autoGrow);
input.addEventListener('blur', () => setTimeout(closeCapsule, 120));

document.getElementById('send').addEventListener('click', sendText);

/* ---------- 喂食 ---------- */

let mealHideTimer = 0;

function showMeal() {
  clearTimeout(mealHideTimer);
  meal.classList.remove('hidden');
  requestAnimationFrame(() => meal.classList.add('eating'));
}

function hideMeal() {
  meal.classList.remove('eating');
  clearTimeout(mealHideTimer);
  mealHideTimer = setTimeout(() => meal.classList.add('hidden'), 280);
}

function setFeedHover(message) {
  if (!message?.on) {
    feedEl.classList.add('hidden');
    return;
  }
  if (!ready || feeding) return;

  const name = message.name || '图标';
  feedName.textContent = message.count > 1 ? `${name} 等 ${message.count} 个` : name;
  feedEl.classList.remove('hidden');
  hintUntil = 0;
  lastActivity = Date.now();

  if (typeof message.x === 'number' && typeof message.y === 'number') {
    lastLocal = { x: message.x, y: message.y };
    try {
      body?.pointer('move', { x: message.x, y: message.y });
    } catch (err) {
      log('feed move: ' + err);
    }
  }
}

async function runFeed(message) {
  if (!ready || feeding) return;
  feeding = true;
  feedResult = null;
  feedEl.classList.add('hidden');
  hintUntil = 0;
  closeCapsule();
  hideMenu();
  hideBubble();
  sleeping = false;
  lastActivity = Date.now();
  body?.set({ hold: 15 });
  body?.do('stand');
  showMeal();
  await sleep(350);
  body?.do('surprised');
  await sleep(200);

  for (let i = 0; i < 12; i++) {
    if (!feeding) break;
    body?.talk();
    await sleep(70);
  }
  body?.do('happy');

  const t0 = performance.now();
  while (!feedResult && performance.now() - t0 < 1500) await sleep(60);
  const result = feedResult;
  feeding = false;
  hideMeal();

  const name = message.names?.[0] || '图标';
  const count = message.count || 1;
  let text;
  if (result?.ok) {
    text = count > 1 ? `吃掉啦：${count} 个图标都送进回收站了。` : `${name} 吃掉啦，回收站里还能找回来。`;
  } else if (result) {
    text = `唔…没吃掉：${result.error || '出错了'}`;
  } else {
    text = count > 1 ? `${count} 个图标吞下去了。` : `${name} 吞下去了。`;
  }

  enqueue({
    bubbles: [{ text, emotion: result?.ok === false ? 'sad' : 'happy' }],
    action: 'nod',
    priority: 2
  });
}

/* ---------- 拖文件喂食（Electron 宿主直接走 DOM 拖放） ---------- */

const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (hitWhale({ x: e.clientX, y: e.clientY })) {
    const f = e.dataTransfer.files[0];
    setFeedHover({ on: true, name: f?.name || '图标', count: e.dataTransfer.files.length, x: e.clientX, y: e.clientY });
  }
}, true);

window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const p = { x: e.clientX, y: e.clientY };
  if (hitWhale(p)) {
    e.dataTransfer.dropEffect = 'move';
    const f = e.dataTransfer.files[0];
    setFeedHover({ on: true, name: f?.name || '图标', count: e.dataTransfer.files.length, x: p.x, y: p.y });
  } else {
    e.dataTransfer.dropEffect = 'none';
    setFeedHover({ on: false });
  }
}, true);

window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget) return;
  setFeedHover({ on: false });
}, true);

window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  setFeedHover({ on: false });

  const p = { x: e.clientX, y: e.clientY };
  if (!hitWhale(p)) return;

  const files = Array.from(e.dataTransfer.files || []);
  const paths = files
    .map((f) => window.petFiles?.pathForFile?.(f))
    .filter((v) => typeof v === 'string' && v.length > 0);
  if (!paths.length) return;

  const names = paths.map((v) => v.split(/[\\/]/).pop());
  runFeed({ names, count: paths.length });
  post({ type: 'feed', paths });
}, true);

/* ---------- 宿主消息 ---------- */

function onHostMessage(message) {
  switch (message?.type) {
    case 'cursor': {
      const p = { x: message.x, y: message.y };
      if (message.inside || pressing) lastLocal = p;

      if (ready && !feeding) {
        if (message.inside || pressing) {
          try {
            body?.pointer('move', p);
          } catch (err) {
            log('cursor move: ' + err);
          }
        } else {
          body?.pointer('leave', {});
        }
      }

      if (pressing && message.down === false) {
        endPress({ clientX: message.x, clientY: message.y });
      }

      if (message.inside && hitWhale(p)) {
        hintUntil = Date.now() + 1500;
        lastActivity = Date.now();
      }

      const ui = message.inside && (hitWhale(p) || overUi(p));
      setUiInteractive(pressing || ui);
      break;
    }
    case 'feedHover': {
      setFeedHover(message);
      break;
    }
    case 'serverSay': {
      if (chatTimer) { clearTimeout(chatTimer); chatTimer = 0; }
      finishThinking();
      const bubbles = (Array.isArray(message.bubbles) ? message.bubbles : [])
        .filter((b) => b && typeof b.text === 'string' && b.text)
        .map((b) => ({
          text: b.text,
          emotion: mapServerEmotion(b.emotion),
          delay_ms: Number(b.delay_ms) || 0
        }));
      const action = Array.isArray(message.actions) && message.actions.length ? message.actions[0] : '';
      const mappedAction = action === 'eat' ? 'eat' : (SERVER_ACTION[action] || action);
      if (bubbles.length) {
        enqueue({
          bubbles,
          action: mappedAction || null,
          priority: typeof message.priority === 'number' ? message.priority : 1
        });
        if (!quiet) for (const b of bubbles) record('pet', b.text);
        lastActivity = Date.now();
      } else if (action === 'eat') {
        playEatAction();
      } else if (action) {
        body?.do(SERVER_ACTION[action] || action);
      }
      log(`serverSay bubbles=${bubbles.length} action=${action || '-'}`);
      break;
    }
    case 'chatPending': {
      if (chatTimer) { clearTimeout(chatTimer); chatTimer = 0; }
      break;
    }
    case 'chatFallback': {
      if (thinking) localReply();
      break;
    }
    case 'debugChat': {
      if (!ready) break;
      const text = String(message.text || '');
      if (!text) break;
      lastChatText = text;
      record('me', text);
      thinking = true;
      dots.classList.remove('hidden');
      body?.do('thinking');
      postHitmap(true);
      if (chatTimer) clearTimeout(chatTimer);
      chatTimer = setTimeout(() => {
        chatTimer = 0;
        if (thinking) localReply();
      }, 1600);
      post({ type: 'chat', text });
      break;
    }
    case 'historyList': {
      historyEntries = Array.isArray(message.entries) ? message.entries : [];
      historyFile = typeof message.file === 'string' ? message.file : '';
      if (!historyPanel.classList.contains('hidden')) renderHistory();
      log(`history loaded ${historyEntries.length}`);
      break;
    }
    case 'serverStatus': {
      serverOnline = !!message.on;
      toast(message.on ? '已连接瑾瑜的记忆服务器' : '记忆服务器已断开，先用本地回复');
      break;
    }
    case 'feed': {
      runFeed(message);
      break;
    }
    case 'feedDone': {
      feedResult = message;
      break;
    }
    case 'roam': {
      if (ready) body?.set({ roam: message.on ? 'calm' : 'off' });
      break;
    }
    case 'recall': {
      lastActivity = Date.now();
      if (ready && !quiet) {
        enqueue({
          bubbles: [{ text: '我来啦。', emotion: 'happy' }],
          action: 'wave',
          priority: 2
        });
      }
      break;
    }
    case 'follow': {
      try {
        body?.shift?.(message.dx, message.dy);
      } catch (err) {
        log('follow shift: ' + err);
      }
      const p = { x: message.x, y: message.y, t: performance.now() };
      requestAnimationFrame(() => {
        if (!ready) return;
        try {
          body?.pointer('move', p);
        } catch (err) {
          log('follow move: ' + err);
        }
        postHitmap(true);
      });
      break;
    }
    case 'blur': {
      if (pressing) {
        pressing = false;
        try {
          body?.pointer('up', { x: lastLocal.x, y: lastLocal.y, t: performance.now() });
        } catch (err) {
          log('blur end press: ' + err);
        }
        post({ type: 'press', on: false });
      }
      setUiInteractive(false);
      closeCapsule();
      hideMenu();
      hideHistory();
      break;
    }
  }
}

bridge?.addEventListener('message', (e) => onHostMessage(e.data));

/* ---------- 空闲行为 ---------- */

setInterval(() => {
  const L = layoutCache;
  if (!ready || !L) return;
  if (L.mode === 'sleep' || L.mode === 'sit') sleeping = true;

  const now = Date.now();
  if (sleeping || quiet || thinking || playing || feeding) return;
  if (!capsule.classList.contains('hidden') || !menu.classList.contains('hidden')
    || !historyPanel.classList.contains('hidden') || !feedEl.classList.contains('hidden')) return;
  if (now - lastActivity < 5 * 60 * 1000) return;

  sleeping = true;
  body?.do('sleep');
}, 10000);

setInterval(() => {
  if (!ready || quiet || sleeping || thinking || playing || feeding) return;
  if (!capsule.classList.contains('hidden') || !historyPanel.classList.contains('hidden')
    || !feedEl.classList.contains('hidden')) return;
  if (Date.now() - lastActivity < 25000) return;
  if (Math.random() > .5) return;

  const lines = [
    { text: '今天也要加油哦。', emotion: 'happy', action: 'hop' },
    { text: '要不要摸摸我的鲸鳍？', emotion: 'shy', action: 'look' },
    { text: '我一直在这儿。', emotion: 'neutral' },
    { text: '唔…有点无聊。', emotion: 'pout', action: 'look' }
  ];
  const line = lines[Math.floor(Math.random() * lines.length)];
  enqueue({ bubbles: [{ text: line.text, emotion: line.emotion }], action: line.action, priority: 1 });
}, 15000);

/* ---------- 开始 ---------- */

postHitmap(true);
requestAnimationFrame(frame);
boot();
