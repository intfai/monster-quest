/* Monster Quest — 打怪闯关
 * 零依赖 Canvas 动作游戏：3 关 + Boss，键盘 / 触屏。
 * MIT License.
 */
(() => {
  'use strict';

  const W = 960;
  const H = 540;
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const overlay = document.getElementById('overlay');
  const hint = document.getElementById('hint');

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const rand = (a, b) => a + Math.random() * (b - a);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const TAU = Math.PI * 2;

  /* ---------------- 音效 ---------------- */
  let actx = null;
  function beep(freq, dur, type = 'square', gain = 0.05) {
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.value = gain;
      o.connect(g).connect(actx.destination);
      const t = actx.currentTime;
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.start(t);
      o.stop(t + dur);
    } catch (_) { /* 无音频权限时静默 */ }
  }

  /* ---------------- 输入 ---------------- */
  const keys = new Set();
  const touchVec = { x: 0, y: 0 };
  let touchAttack = false;

  addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
    keys.add(e.key.toLowerCase());
    if (e.key === 'Enter') {
      if (state === 'title' || state === 'dead' || state === 'win') startGame();
    }
    if (e.key === 'j' || e.key === ' ') tryAttack();
  }, { passive: false });

  addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

  addEventListener('blur', () => keys.clear());

  function setupTouch() {
    const stick = document.getElementById('stick');
    const knob = document.getElementById('knob');
    const btn = document.getElementById('btnAtk');
    if (!stick) return;

    let active = null;
    const center = () => {
      const r = stick.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, max: r.width * 0.38 };
    };

    const move = (t) => {
      const c = center();
      let dx = t.clientX - c.x;
      let dy = t.clientY - c.y;
      const len = Math.hypot(dx, dy);
      const capped = Math.min(len, c.max);
      const nx = len ? (dx / len) * capped : 0;
      const ny = len ? (dy / len) * capped : 0;
      knob.style.transform = `translate(${nx}px, ${ny}px)`;
      touchVec.x = len ? dx / Math.max(len, c.max) : 0;
      touchVec.y = len ? dy / Math.max(len, c.max) : 0;
      const l = Math.hypot(touchVec.x, touchVec.y);
      if (l > 1) { touchVec.x /= l; touchVec.y /= l; }
    };

    stick.addEventListener('pointerdown', (e) => { active = e.pointerId; stick.setPointerCapture(e.pointerId); move(e); });
    stick.addEventListener('pointermove', (e) => { if (e.pointerId === active) move(e); });
    const end = (e) => {
      if (e.pointerId !== active) return;
      active = null;
      touchVec.x = touchVec.y = 0;
      knob.style.transform = 'translate(0,0)';
    };
    stick.addEventListener('pointerup', end);
    stick.addEventListener('pointercancel', end);

    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); touchAttack = true; tryAttack(); });
    btn.addEventListener('pointerup', () => { touchAttack = false; });

    addEventListener('touchstart', () => document.body.classList.add('touch'), { once: true });
  }

  /* ---------------- 实体 ---------------- */
  const player = {
    x: W / 2, y: H / 2, r: 15, speed: 236,
    hp: 5, maxHp: 5, face: -Math.PI / 2,
    atkCd: 0, atkAnim: 0, invuln: 0,
  };

  const ENEMY_TYPES = {
    slime: { hp: 2, speed: 58, r: 17, dmg: 1, score: 100, color: '#4ade80', dark: '#166534' },
    bat:   { hp: 1, speed: 128, r: 13, dmg: 1, score: 150, color: '#c084fc', dark: '#6b21a8' },
    brute: { hp: 5, speed: 44, r: 25, dmg: 2, score: 300, color: '#f87171', dark: '#7f1d1d' },
    boss:  { hp: 22, speed: 74, r: 42, dmg: 2, score: 2000, color: '#fb923c', dark: '#7c2d12' },
  };

  const LEVELS = [
    { name: '第一章 · 史莱姆巢穴', wave: [['slime', 3]] },
    { name: '第二章 · 洞窟回响', wave: [['slime', 4], ['bat', 3]] },
    { name: '第三章 · 深渊之口', wave: [['slime', 2], ['brute', 2], ['boss', 1]] },
  ];

  let enemies = [];
  let particles = [];
  let floaters = [];
  let portal = null;
  let state = 'title';
  let level = 1;
  let score = 0;
  let best = Number(localStorage.getItem('mq_best') || 0);
  let shake = 0;
  let elapsed = 0;
  let banner = { text: '', t: 0 };
  let flash = 0;

  function spawnWave(levelIndex) {
    enemies = [];
    const spec = LEVELS[levelIndex].wave;
    spec.forEach(([type, count]) => {
      for (let i = 0; i < count; i++) {
        const t = ENEMY_TYPES[type];
        let x, y, tries = 0;
        do {
          x = rand(80, W - 80);
          y = rand(90, H - 70);
          tries++;
        } while (Math.hypot(x - player.x, y - player.y) < 220 && tries < 60);
        enemies.push({
          type, x, y, r: t.r, hp: t.hp, maxHp: t.hp,
          vx: 0, vy: 0, hitT: 0, phase: rand(0, TAU),
          chargeCd: rand(1.6, 3.2), charging: 0,
        });
      }
    });
  }

  function startGame() {
    player.x = W / 2; player.y = H / 2;
    player.hp = player.maxHp;
    player.invuln = 0; player.atkCd = 0; player.atkAnim = 0;
    level = 1; score = 0; elapsed = 0;
    particles = []; floaters = []; portal = null;
    spawnWave(0);
    state = 'playing';
    overlay.classList.add('hidden');
    setBanner(LEVELS[0].name);
  }

  function setBanner(text) {
    banner.text = text;
    banner.t = 2.2;
  }

  function tryAttack() {
    if (state !== 'playing' || player.atkCd > 0) return;
    player.atkCd = 0.30;
    player.atkAnim = 0.16;
    beep(320, 0.06, 'square', 0.03);

    const reach = 68;
    const half = 1.15;
    let hitAny = false;
    for (const e of enemies) {
      const d = dist(player, e);
      if (d > reach + e.r) continue;
      const ang = Math.atan2(e.y - player.y, e.x - player.x);
      let diff = Math.abs(((ang - player.face + Math.PI * 3) % TAU) - Math.PI);
      if (diff <= half) {
        damageEnemy(e, 1);
        hitAny = true;
      }
    }
    if (hitAny) {
      shake = Math.max(shake, 5);
      beep(160, 0.05, 'sawtooth', 0.04);
    }
  }

  function damageEnemy(e, amount) {
    e.hp -= amount;
    e.hitT = 0.16;
    for (let i = 0; i < 5; i++) {
      particles.push({
        x: e.x, y: e.y, vx: rand(-160, 160), vy: rand(-160, 160),
        life: rand(0.2, 0.45), max: 0.45, color: ENEMY_TYPES[e.type].color, size: rand(2, 4),
      });
    }
    if (e.hp <= 0) {
      const t = ENEMY_TYPES[e.type];
      score += t.score;
      floaters.push({ x: e.x, y: e.y, text: '+' + t.score, life: 0.9, max: 0.9 });
      for (let i = 0; i < 16; i++) {
        particles.push({
          x: e.x, y: e.y, vx: rand(-240, 240), vy: rand(-240, 240),
          life: rand(0.3, 0.7), max: 0.7, color: t.color, size: rand(2, 5),
        });
      }
      beep(e.type === 'boss' ? 90 : 220, 0.16, 'triangle', 0.05);
      enemies = enemies.filter((x) => x !== e);
    }
  }

  function hurtPlayer(amount) {
    if (player.invuln > 0 || state !== 'playing') return;
    player.hp -= amount;
    player.invuln = 1.0;
    shake = 12;
    flash = 0.18;
    beep(110, 0.2, 'sawtooth', 0.06);
    for (let i = 0; i < 18; i++) {
      particles.push({
        x: player.x, y: player.y, vx: rand(-260, 260), vy: rand(-260, 260),
        life: rand(0.25, 0.6), max: 0.6, color: '#ef4444', size: rand(2, 4),
      });
    }
    if (player.hp <= 0) {
      player.hp = 0;
      state = 'dead';
      if (score > best) { best = score; localStorage.setItem('mq_best', String(best)); }
      showOverlay('你倒下了', `本局得分 <b>${score}</b> · 最高 <b>${best}</b>`, '按 Enter 再来一局');
    }
  }

  function showOverlay(title, sub, hintText) {
    overlay.innerHTML = `<h1>${title}</h1><p class="sub">${sub}</p><p id="hint">${hintText}</p>`;
    overlay.classList.remove('hidden');
  }

  /* ---------------- 更新 ---------------- */
  function update(dt) {
    if (state !== 'playing') {
      particles.forEach((p) => { p.life -= dt; });
      particles = particles.filter((p) => p.life > 0);
      return;
    }

    elapsed += dt;
    player.atkCd = Math.max(0, player.atkCd - dt);
    player.atkAnim = Math.max(0, player.atkAnim - dt);
    player.invuln = Math.max(0, player.invuln - dt);
    shake = Math.max(0, shake - dt * 40);
    flash = Math.max(0, flash - dt);

    let dx = 0, dy = 0;
    if (keys.has('a') || keys.has('arrowleft')) dx -= 1;
    if (keys.has('d') || keys.has('arrowright')) dx += 1;
    if (keys.has('w') || keys.has('arrowup')) dy -= 1;
    if (keys.has('s') || keys.has('arrowdown')) dy += 1;
    dx += touchVec.x;
    dy += touchVec.y;

    const len = Math.hypot(dx, dy);
    if (len > 0) {
      dx /= len; dy /= len;
      player.x += dx * player.speed * dt;
      player.y += dy * player.speed * dt;
      player.face = Math.atan2(dy, dx);
    }
    player.x = clamp(player.x, player.r + 8, W - player.r - 8);
    player.y = clamp(player.y, player.r + 8, H - player.r - 8);

    for (const e of enemies) {
      e.hitT = Math.max(0, e.hitT - dt);
      const t = ENEMY_TYPES[e.type];
      let ax = player.x - e.x;
      let ay = player.y - e.y;
      const d = Math.hypot(ax, ay) || 1;
      ax /= d; ay /= d;

      if (e.type === 'bat') {
        e.phase += dt * 6;
        const px = -ay, py = ax;
        e.x += (ax * t.speed + px * Math.sin(e.phase) * 90) * dt;
        e.y += (ay * t.speed + py * Math.sin(e.phase) * 90) * dt;
      } else if (e.type === 'boss') {
        e.chargeCd -= dt;
        if (e.chargeCd <= 0 && e.charging <= 0) {
          e.charging = 0.6;
          e.chargeCd = rand(2.6, 3.8);
          beep(70, 0.25, 'sawtooth', 0.05);
        }
        if (e.charging > 0) {
          e.charging -= dt;
          e.x += ax * t.speed * 4.2 * dt;
          e.y += ay * t.speed * 4.2 * dt;
          if (Math.random() < 0.6) {
            particles.push({
              x: e.x, y: e.y, vx: rand(-40, 40), vy: rand(-40, 40),
              life: 0.3, max: 0.3, color: '#fbbf24', size: 3,
            });
          }
        } else {
          e.x += ax * t.speed * dt;
          e.y += ay * t.speed * dt;
        }
      } else {
        e.x += ax * t.speed * dt;
        e.y += ay * t.speed * dt;
      }

      e.x = clamp(e.x, e.r, W - e.r);
      e.y = clamp(e.y, e.r, H - e.r);

      if (dist(player, e) < player.r + e.r && player.invuln <= 0) hurtPlayer(t.dmg);
    }

    // 敌人之间简单分离，避免完全重叠
    for (let i = 0; i < enemies.length; i++) {
      for (let j = i + 1; j < enemies.length; j++) {
        const a = enemies[i], b = enemies[j];
        const d = dist(a, b);
        const min = a.r + b.r;
        if (d > 0 && d < min) {
          const push = (min - d) / 2;
          const nx = (b.x - a.x) / d, ny = (b.y - a.y) / d;
          a.x -= nx * push; a.y -= ny * push;
          b.x += nx * push; b.y += ny * push;
        }
      }
    }

    particles.forEach((p) => {
      p.life -= dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.94; p.vy *= 0.94;
    });
    particles = particles.filter((p) => p.life > 0);
    floaters.forEach((f) => { f.life -= dt; f.y -= 26 * dt; });
    floaters = floaters.filter((f) => f.life > 0);
    if (banner.t > 0) banner.t -= dt;

    if (enemies.length === 0 && !portal) {
      portal = { x: W / 2, y: H / 2, t: 0 };
      beep(660, 0.18, 'sine', 0.05);
    }

    if (portal) {
      portal.t += dt;
      if (dist(player, portal) < 46) {
        if (level >= LEVELS.length) {
          state = 'win';
          if (score > best) { best = score; localStorage.setItem('mq_best', String(best)); }
          showOverlay('通关！', `最终得分 <b>${score}</b> · 用时 ${elapsed.toFixed(1)}s`, '按 Enter 再来一次');
        } else {
          level++;
          portal = null;
          spawnWave(level - 1);
          setBanner(LEVELS[level - 1].name);
          beep(520, 0.2, 'sine', 0.05);
        }
      }
    }
  }

  /* ---------------- 渲染 ---------------- */
  function drawArena() {
    const g = ctx.createRadialGradient(W / 2, H / 2, 80, W / 2, H / 2, 620);
    g.addColorStop(0, '#141d2b');
    g.addColorStop(1, '#080b11');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(120, 160, 210, 0.06)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= W; x += 48) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y <= H; y += 48) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(120, 170, 230, 0.16)';
    ctx.lineWidth = 2;
    ctx.strokeRect(6, 6, W - 12, H - 12);
  }

  function drawPlayer() {
    const blink = player.invuln > 0 && Math.floor(player.invuln * 14) % 2 === 0;
    ctx.save();
    ctx.globalAlpha = blink ? 0.35 : 1;

    ctx.beginPath();
    ctx.ellipse(player.x, player.y + 12, 16, 6, 0, 0, TAU);
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(player.x, player.y, player.r, 0, TAU);
    ctx.fillStyle = '#60a5fa';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#dbeafe';
    ctx.stroke();

    // 朝向指示
    ctx.beginPath();
    ctx.moveTo(player.x, player.y);
    ctx.lineTo(
      player.x + Math.cos(player.face) * (player.r + 8),
      player.y + Math.sin(player.face) * (player.r + 8),
    );
    ctx.strokeStyle = '#bfdbfe';
    ctx.lineWidth = 4;
    ctx.stroke();

    ctx.restore();

    if (player.atkAnim > 0) {
      const p = 1 - player.atkAnim / 0.16;
      ctx.beginPath();
      ctx.arc(player.x, player.y, 68, player.face - 1.15, player.face + 1.15);
      ctx.strokeStyle = `rgba(253, 224, 71, ${0.85 * (1 - p)})`;
      ctx.lineWidth = 7 * (1 - p) + 1;
      ctx.stroke();
    }
  }

  function drawEnemy(e) {
    const t = ENEMY_TYPES[e.type];
    const flash = e.hitT > 0;
    ctx.save();

    ctx.beginPath();
    ctx.ellipse(e.x, e.y + e.r * 0.72, e.r * 0.9, e.r * 0.34, 0, 0, TAU);
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.fill();

    if (e.type === 'bat') {
      const flap = Math.sin(e.phase * 1.6) * 10;
      ctx.beginPath();
      ctx.moveTo(e.x, e.y);
      ctx.lineTo(e.x - e.r * 2.2, e.y - flap);
      ctx.lineTo(e.x - e.r * 1.1, e.y + e.r * 0.7);
      ctx.closePath();
      ctx.moveTo(e.x, e.y);
      ctx.lineTo(e.x + e.r * 2.2, e.y - flap);
      ctx.lineTo(e.x + e.r * 1.1, e.y + e.r * 0.7);
      ctx.closePath();
      ctx.fillStyle = flash ? '#fff' : t.dark;
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(e.x, e.y, e.r, 0, TAU);
    ctx.fillStyle = flash ? '#ffffff' : t.color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = flash ? '#fff' : t.dark;
    ctx.stroke();

    // 眼睛
    const ex = e.r * 0.32;
    ctx.fillStyle = '#0b0f17';
    ctx.beginPath(); ctx.arc(e.x - ex, e.y - e.r * 0.18, e.r * 0.17, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(e.x + ex, e.y - e.r * 0.18, e.r * 0.17, 0, TAU); ctx.fill();

    // 血条
    if (e.hp < e.maxHp) {
      const w = e.r * 2;
      const p = Math.max(0, e.hp / e.maxHp);
      ctx.fillStyle = 'rgba(0,0,0,.6)';
      ctx.fillRect(e.x - w / 2, e.y - e.r - 12, w, 5);
      ctx.fillStyle = p > 0.5 ? '#4ade80' : p > 0.25 ? '#facc15' : '#ef4444';
      ctx.fillRect(e.x - w / 2, e.y - e.r - 12, w * p, 5);
    }

    if (e.type === 'boss') {
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r + 8 + Math.sin(performance.now() / 240) * 3, 0, TAU);
      ctx.strokeStyle = 'rgba(251, 146, 60, .45)';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawPortal() {
    const t = portal.t;
    for (let i = 0; i < 3; i++) {
      const r = 26 + i * 12 + Math.sin(t * 3 + i) * 5;
      ctx.beginPath();
      ctx.arc(portal.x, portal.y, r, 0, TAU);
      ctx.strokeStyle = `rgba(56, 189, 248, ${0.55 - i * 0.13})`;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(portal.x, portal.y, 18, 0, TAU);
    const g = ctx.createRadialGradient(portal.x, portal.y, 0, portal.x, portal.y, 18);
    g.addColorStop(0, 'rgba(224, 242, 254, .95)');
    g.addColorStop(1, 'rgba(56, 189, 248, .05)');
    ctx.fillStyle = g;
    ctx.fill();

    ctx.fillStyle = 'rgba(224, 242, 254, .9)';
    ctx.font = '600 15px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(level >= LEVELS.length ? '进入传送门 · 通关' : '进入传送门', portal.x, portal.y + 62);
  }

  function drawHUD() {
    // 生命
    for (let i = 0; i < player.maxHp; i++) {
      const x = 26 + i * 30;
      const y = 30;
      ctx.beginPath();
      ctx.moveTo(x, y + 6);
      ctx.bezierCurveTo(x, y - 2, x + 12, y - 2, x + 12, y + 6);
      ctx.bezierCurveTo(x + 12, y + 13, x, y + 18, x, y + 18);
      ctx.bezierCurveTo(x, y + 18, x - 12, y + 13, x - 12, y + 6);
      ctx.bezierCurveTo(x - 12, y - 2, x, y - 2, x, y + 6);
      ctx.fillStyle = i < player.hp ? '#ef4444' : 'rgba(255,255,255,.12)';
      ctx.fill();
    }

    ctx.textAlign = 'right';
    ctx.fillStyle = '#e6edf3';
    ctx.font = '700 22px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(String(score), W - 26, 38);
    ctx.font = '500 12px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = '#8b949e';
    ctx.fillText('分数', W - 26, 56);

    ctx.textAlign = 'left';
    ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = '#8b949e';
    ctx.fillText(LEVELS[level - 1].name, 26, 66);
    ctx.fillText(`敌人 ${enemies.length}`, 26, 86);

    if (banner.t > 0) {
      const a = Math.min(1, banner.t / 0.5);
      ctx.save();
      ctx.globalAlpha = a;
      ctx.textAlign = 'center';
      ctx.font = '700 30px ui-sans-serif, system-ui, sans-serif';
      ctx.fillStyle = '#f0883e';
      ctx.fillText(banner.text, W / 2, 120);
      ctx.restore();
    }
  }

  function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (shake > 0) {
      ctx.translate(rand(-shake, shake), rand(-shake, shake));
    }

    drawArena();
    if (portal) drawPortal();
    enemies.forEach(drawEnemy);
    if (state !== 'dead') drawPlayer();

    particles.forEach((p) => {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    });
    ctx.globalAlpha = 1;

    floaters.forEach((f) => {
      ctx.globalAlpha = Math.max(0, f.life / f.max);
      ctx.fillStyle = '#fde047';
      ctx.font = '700 18px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(f.text, f.x, f.y);
    });
    ctx.globalAlpha = 1;

    if (state === 'playing') drawHUD();

    if (flash > 0) {
      ctx.fillStyle = `rgba(239, 68, 68, ${flash * 1.6})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  /* ---------------- 主循环 ---------------- */
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt);
    render();
    requestAnimationFrame(frame);
  }

  setupTouch();
  hint.innerHTML = `<kbd>Enter</kbd> 开始　·　最高分 ${best}`;
  requestAnimationFrame(frame);

  // 便于演示与自动化截图：?start=1 直接开局
  if (new URLSearchParams(location.search).has('start')) startGame();

  // 便于自动化测试/调试
  window.__mq = {
    get state() { return state; },
    get score() { return score; },
    get level() { return level; },
    get enemies() { return enemies.length; },
    get x() { return player.x; },
    get y() { return player.y; },
    get hp() { return player.hp; },
    get enemyList() { return enemies.map((e) => ({ x: e.x, y: e.y, hp: e.hp, type: e.type })); },
    start: startGame,
  };
})();
