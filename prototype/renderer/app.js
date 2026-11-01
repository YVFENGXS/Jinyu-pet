(() => {
  const api = window.petAPI;

  const pet = document.getElementById('pet');
  const g = document.getElementById('whale-g');
  const mouth = document.getElementById('mouth');
  const pupil = document.getElementById('pupil');
  const bubble = document.getElementById('bubble');
  const bubbleText = document.getElementById('bubble-text');
  const dots = document.getElementById('dots');
  const capsule = document.getElementById('capsule');
  const input = document.getElementById('input');
  const menu = document.getElementById('menu');
  const toastEl = document.getElementById('toast');
  const hint = document.getElementById('hint');
  const quietBtn = document.getElementById('menu-quiet');

  const MOUTHS = {
    neutral: 'M134 94 Q142 99 150 94',
    happy: 'M132 90 Q142 102 152 90',
    shy: 'M136 93 Q142 98 148 93',
    sad: 'M134 98 Q142 91 150 98',
    sleepy: 'M136 96 Q142 96 148 96',
    curious: 'M134 94 Q142 99 150 94',
    angry: 'M133 97 Q142 92 151 97',
    worried: 'M134 97 Q142 93 150 97'
  };

  const ACT_CLASSES = ['act-wave', 'act-nod', 'act-squash', 'act-shake', 'act-eat', 'act-celebrate', 'act-peek'];
  const ACT_MAP = {
    wave: 'act-wave',
    nod: 'act-nod',
    shake: 'act-shake',
    headpat: 'act-squash',
    squash: 'act-squash',
    eat: 'act-eat',
    celebrate: 'act-celebrate',
    peek: 'act-peek',
    hide: 'act-peek'
  };

  let interactive = false;
  let dragging = false;
  let lastMouse = { x: 190, y: 300 };
  let lastClick = 0;
  let hoverBubble = false;
  let pinnedUntil = 0;
  let quiet = false;
  let sleeping = false;
  let lastActivity = Date.now();
  let toastTimer = null;
  let currentText = '';

  const queue = [];
  let playing = false;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function setEmotion(name) {
    const key = MOUTHS[name] ? name : 'neutral';
    pet.dataset.emotion = key;
    mouth.setAttribute('d', MOUTHS[key]);
  }

  function playAction(name) {
    const cls = ACT_CLASSES.includes(name) ? name : ACT_MAP[name];
    if (!cls) return;
    g.classList.remove(...ACT_CLASSES);
    void g.getBoundingClientRect();
    g.classList.add(cls);
    setTimeout(() => g.classList.remove(cls), 900);
  }

  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 1600);
  }

  function updateInteractive() {
    const el = document.elementFromPoint(lastMouse.x, lastMouse.y);
    const hit = dragging || !!(el && el.closest('.hit'));
    if (hit !== interactive) {
      interactive = hit;
      api.setInteractive(hit);
    }
  }

  function gaze(e) {
    const rect = pet.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + 92;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    const len = Math.hypot(dx, dy) || 1;
    const k = Math.min(1, len / 220);
    pupil.style.transform = `translate(${(dx / len) * 3 * k}px, ${(dy / len) * 2.4 * k}px)`;
  }

  function wake() {
    if (!sleeping) return;
    sleeping = false;
    pet.classList.remove('sleepy');
    setEmotion('neutral');
  }

  function touch() {
    lastActivity = Date.now();
    wake();
  }

  window.addEventListener('mousemove', (e) => {
    lastMouse = { x: e.clientX, y: e.clientY };
    updateInteractive();
    gaze(e);
    if (pet.contains(e.target)) touch();
  });

  // 5 分钟后进入睡眠
  setInterval(() => {
    if (!sleeping && Date.now() - lastActivity > 5 * 60 * 1000) {
      sleeping = true;
      pet.classList.add('sleepy');
      setEmotion('sleepy');
    }
  }, 10000);

  // 眨眼
  setInterval(() => {
    if (sleeping || document.hidden) return;
    if (Math.random() < 0.7) {
      pet.classList.add('blinking');
      setTimeout(() => pet.classList.remove('blinking'), 150);
    }
  }, 4200);

  // ---------- 气泡 ----------

  async function showBubble(text, emotion) {
    currentText = text;
    bubbleText.textContent = '';
    bubble.classList.remove('hidden');
    setEmotion(emotion || 'neutral');

    const per = Math.min(25, 1200 / Math.max(1, text.length));
    for (let i = 0; i < text.length; i++) {
      bubbleText.textContent += text[i];
      await sleep(per);
      if (i > 60) {
        bubbleText.textContent = text;
        break;
      }
    }
    bubbleText.textContent = text;

    let remain = Math.max(5000, Math.min(12000, 4000 + text.length * 50));
    let last = Date.now();
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        const now = Date.now();
        const dt = now - last;
        last = now;
        const paused = hoverBubble || now < pinnedUntil;
        if (!paused) remain -= dt;
        if (remain <= 0) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });

    bubble.classList.add('hidden');
    pinnedUntil = 0;
  }

  bubble.addEventListener('mouseenter', () => { hoverBubble = true; });
  bubble.addEventListener('mouseleave', () => { hoverBubble = false; });
  bubble.addEventListener('click', () => {
    if (pinnedUntil > Date.now()) pinnedUntil = 0;
    else pinnedUntil = Date.now() + 30000;
  });
  bubble.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.copy(currentText);
    toast('已复制');
  });

  function enqueue(payload) {
    if (!payload || !payload.bubbles || !payload.bubbles.length) return;
    if (payload.priority === 3) queue.unshift(payload);
    else queue.push(payload);
    if (!playing) runQueue();
  }

  async function runQueue() {
    playing = true;
    while (queue.length) {
      const msg = queue.shift();
      if (quiet && msg.priority !== 3) continue;
      touch();
      if (msg.actions && msg.actions.length) playAction(msg.actions[0]);
      for (let i = 0; i < msg.bubbles.length; i++) {
        const b = msg.bubbles[i];
        if (quiet && msg.priority !== 3) break;
        if (i > 0 && b.delay_ms) await sleep(b.delay_ms);
        await showBubble(b.text, b.emotion);
      }
    }
    playing = false;
  }

  // ---------- 输入胶囊 ----------

  function openCapsule() {
    hideMenu();
    touch();
    bubble.classList.add('hidden');
    capsule.classList.remove('hidden');
    api.setInteractive(true);
    interactive = true;
    api.focusInput(true);
    setTimeout(() => input.focus(), 50);
    setEmotion('curious');
  }

  function closeCapsule() {
    capsule.classList.add('hidden');
    input.blur();
    api.focusInput(false);
    if (!sleeping) setEmotion('neutral');
    updateInteractive();
  }

  function think(on) {
    dots.classList.toggle('hidden', !on);
    if (!sleeping) setEmotion(on ? 'curious' : 'neutral');
  }

  function replyFor(text) {
    if (/累|加班|忙/.test(text)) {
      return { bubbles: [{ text: '那就先歇一会儿吧，我在这儿。', emotion: 'shy' }], actions: ['headpat'] };
    }
    if (/晚安|睡|困/.test(text)) {
      return { bubbles: [{ text: '晚安，做个好梦。', emotion: 'sleepy' }], actions: ['nod'] };
    }
    if (/你好|在吗|在不在/.test(text)) {
      return {
        bubbles: [
          { text: '在呢。', emotion: 'happy' },
          { text: '你今天来得比平时晚一点。', emotion: 'shy', delay_ms: 900 }
        ],
        actions: ['wave']
      };
    }
    if (/吃|饿/.test(text)) {
      return { bubbles: [{ text: '我也想吃。', emotion: 'happy' }], actions: ['eat'] };
    }
    const lines = [
      { bubbles: [{ text: '唔，我记下了。', emotion: 'neutral' }], actions: ['nod'] },
      { bubbles: [{ text: '你这么说，我就当真了。', emotion: 'shy' }], actions: ['nod'] },
      { bubbles: [{ text: '再讲一点？', emotion: 'curious' }], actions: ['peek'] }
    ];
    return lines[Math.floor(Math.random() * lines.length)];
  }

  function sendText() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = '24px';
    closeCapsule();
    think(true);
    setTimeout(() => {
      think(false);
      const reply = replyFor(text);
      enqueue({ bubbles: reply.bubbles, actions: reply.actions, priority: 1 });
    }, 1200 + Math.random() * 600);
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeCapsule();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendText();
    }
  });

  input.addEventListener('input', () => {
    input.style.height = '24px';
    input.style.height = `${Math.min(72, input.scrollHeight)}px`;
  });

  document.getElementById('send').addEventListener('click', sendText);
  document.getElementById('mic').addEventListener('click', () => toast('语音输入在原型里还没接'));

  // ---------- 戳、拖拽 ----------

  function poke() {
    touch();
    playAction('squash');
    setTimeout(() => {
      if (quiet) return;
      if (Math.random() < 0.6) {
        const lines = ['唔…你戳我。', '在呢，别闹。', '再戳就要生气了。'];
        enqueue({
          bubbles: [{ text: lines[Math.floor(Math.random() * lines.length)], emotion: 'shy' }],
          actions: ['shake'],
          priority: 1
        });
      }
    }, 450);
  }

  pet.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (hint.contains(e.target)) return;
    e.preventDefault();
    touch();
    hideMenu();

    const sx = e.screenX;
    const sy = e.screenY;
    let moved = false;
    dragging = false;
    api.dragStart({ screenX: sx, screenY: sy });

    const onMove = (ev) => {
      if (!moved && Math.abs(ev.screenX - sx) + Math.abs(ev.screenY - sy) > 5) {
        moved = true;
        dragging = true;
        pet.classList.add('dragging');
        api.setInteractive(true);
        interactive = true;
      }
      if (moved) api.dragMove({ screenX: ev.screenX, screenY: ev.screenY });
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      api.dragEnd();
      if (moved) {
        dragging = false;
        pet.classList.remove('dragging');
        playAction('squash');
        updateInteractive();
        return;
      }
      const now = performance.now();
      if (now - lastClick < 300) {
        lastClick = 0;
        poke();
        openCapsule();
      } else {
        lastClick = now;
        poke();
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  hint.addEventListener('mousedown', (e) => e.stopPropagation());
  hint.addEventListener('click', (e) => {
    e.stopPropagation();
    openCapsule();
  });

  // ---------- 菜单 ----------

  function showMenu() {
    menu.classList.remove('hidden');
    api.setInteractive(true);
    interactive = true;
  }

  function hideMenu() {
    menu.classList.add('hidden');
  }

  pet.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    touch();
    showMenu();
  });

  menu.addEventListener('mousedown', (e) => e.stopPropagation());
  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    hideMenu();

    if (act === 'palette') {
      pet.classList.toggle('alt');
      toast('已换配色');
      return;
    }
    if (act === 'quiet') {
      quiet = !quiet;
      pet.classList.toggle('quiet', quiet);
      quietBtn.textContent = quiet ? '取消勿扰' : '静音 / 勿扰';
      toast(quiet ? '已进入勿扰' : '已恢复');
      return;
    }
    if (act === 'hide') {
      api.hide();
      toast('已隐藏，Ctrl+Alt+J 召回');
      return;
    }
    if (act === 'quit') api.quit();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideMenu();
      if (!capsule.classList.contains('hidden')) closeCapsule();
    }
  });

  // ---------- 全局热键 ----------

  api.onShortcut(() => {
    if (capsule.classList.contains('hidden')) openCapsule();
    else closeCapsule();
  });

  // ---------- 初始状态 ----------

  setEmotion('neutral');
  setTimeout(() => {
    enqueue({
      bubbles: [
        { text: '你回来啦。', emotion: 'happy' },
        { text: '今天……还好吗？', emotion: 'shy', delay_ms: 900 }
      ],
      actions: ['wave'],
      priority: 0
    });
  }, 1200);
})();
