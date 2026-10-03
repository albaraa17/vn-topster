/* VN Topster — a Topsters-style chart maker for visual novels.
 * Data source: VNDB Kana API (https://api.vndb.org/kana).
 * The chart is drawn on a <canvas> so the editor preview and the exported PNG
 * are pixel-identical. Covers are loaded through the local /img proxy so the
 * canvas isn't tainted by cross-origin images.
 */
(() => {
  'use strict';

  const API = 'https://api.vndb.org/kana';
  const STORE_KEY = 'vntopster.v1';
  const MAX_ITEMS = 100;
  const VN_FIELDS = 'title,alttitle,released,rating,votecount,image.url,image.thumbnail,image.sexual,image.violence,developers.name';

  const DEFAULTS = {
    title: 'My Top Visual Novels',
    layout: 'collage',
    rows: 4,
    cols: 5,
    aspect: '1.5',
    coverSize: 180,
    titles: 'side',
    showNumbers: false,
    numberTitles: true,
    showYear: true,
    showDev: false,
    origTitle: false,
    nsfw: 'explicit',
    bg: '#101015',
    text: '#f2f2f7',
    accent: '#ff5d8f',
    empty: '#1e1e28',
    bgImage: null,
    bgDim: 40,
    font: 'Inter',
    gap: 10,
    padding: 40,
    radius: 4,
    shadow: false,
    showEmpty: true,
  };

  const PRESETS = [
    { name: 'Midnight', bg: '#101015', text: '#f2f2f7', accent: '#ff5d8f', empty: '#1e1e28' },
    { name: 'Paper', bg: '#f4efe6', text: '#2b2620', accent: '#b5523b', empty: '#e3dccf' },
    { name: 'Sakura', bg: '#ffe4ec', text: '#4a2233', accent: '#e0457b', empty: '#f7cbd8' },
    { name: 'Neon', bg: '#0b0820', text: '#e9e6ff', accent: '#00e5ff', empty: '#1b1640' },
    { name: 'Matcha', bg: '#e8efe0', text: '#24331f', accent: '#5d8a3a', empty: '#d3dfc6' },
    { name: 'Mono', bg: '#000000', text: '#ffffff', accent: '#ffffff', empty: '#161616' },
    { name: 'Textbox', bg: '#1a2340', text: '#ffffff', accent: '#ffd166', empty: '#26325a' },
    { name: 'Sepia', bg: '#2b2118', text: '#f1e3cf', accent: '#e0a458', empty: '#3a2d22' },
  ];

  const TIERS = {
    top40: [5, 5, 6, 6, 6, 6, 6],
    top42: [4, 4, 5, 5, 6, 6, 6, 6],
    top100: [5, 5, 6, 6, 7, 7, 8, 8, 8, 10, 10, 10, 10],
  };

  // ---------------------------------------------------------------- helpers
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const uid = () => Math.random().toString(36).slice(2, 10);

  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), ms);
  }

  function normalizeVN(v) {
    return {
      id: v.id,
      title: v.title,
      alttitle: v.alttitle || null,
      released: v.released || null,
      rating: v.rating ?? null,
      dev: v.developers && v.developers.length ? v.developers[0].name : null,
      image: v.image ? {
        url: v.image.url,
        thumb: v.image.thumbnail || v.image.url,
        sexual: v.image.sexual ?? 0,
        violence: v.image.violence ?? 0,
      } : null,
    };
  }

  function shouldBlur(item, s = state) {
    if (!item || !item.image) return false;
    const sx = item.image.sexual || 0;
    if (s.nsfw === 'explicit') return sx >= 1.3;
    if (s.nsfw === 'suggestive') return sx >= 0.5;
    return false;
  }

  const yearOf = (it) => (it.released && /^\d{4}/.test(it.released) ? it.released.slice(0, 4) : (it.released === 'TBA' ? 'TBA' : ''));
  const titleOf = (it, s = state) => (s.origTitle && it.alttitle ? it.alttitle : it.title);
  const metaOf = (it, s = state) => [s.showYear && yearOf(it), s.showDev && it.dev].filter(Boolean).join(' · ');

  // ---------------------------------------------------------------- storage
  let store = loadStore();
  let state = store.charts[store.current];

  function freshChart(overrides = {}) {
    return { ...DEFAULTS, items: Array(MAX_ITEMS).fill(null), created: Date.now(), ...overrides };
  }

  function sanitizeChart(c) {
    const out = { ...DEFAULTS, ...c };
    out.items = Array.from({ length: MAX_ITEMS }, (_, i) => (c.items && c.items[i]) || null);
    return out;
  }

  function loadStore() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY));
      if (raw && raw.charts && Object.keys(raw.charts).length) {
        for (const k of Object.keys(raw.charts)) raw.charts[k] = sanitizeChart(raw.charts[k]);
        if (!raw.charts[raw.current]) raw.current = Object.keys(raw.charts)[0];
        return raw;
      }
    } catch { /* ignore corrupt storage */ }
    const id = uid();
    return { current: id, charts: { [id]: freshChart() } };
  }

  let saveTimer;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(store));
      } catch (e) {
        toast('Could not save — browser storage is full (try a smaller background image).', 4000);
      }
    }, 250);
  }

  // ---------------------------------------------------------------- images
  const imgCache = new Map();
  let taintedImages = false;

  function getImage(url) {
    if (!url) return null;
    let e = imgCache.get(url);
    if (e) return e;
    e = { img: new Image(), ok: false, err: false, tainted: false, blurred: null };
    e.promise = new Promise((resolve) => {
      e.img.crossOrigin = 'anonymous';
      e.img.onload = () => { e.ok = true; scheduleRender(); resolve(); };
      e.img.onerror = () => {
        // Proxy unavailable (e.g. opened as a static file) — fall back to a
        // direct load. Preview works, but PNG export will be blocked.
        const direct = new Image();
        direct.onload = () => { e.img = direct; e.ok = true; e.tainted = true; taintedImages = true; scheduleRender(); resolve(); };
        direct.onerror = () => { e.err = true; scheduleRender(); resolve(); };
        direct.src = url;
      };
      e.img.src = '/img?u=' + encodeURIComponent(url);
    });
    imgCache.set(url, e);
    return e;
  }

  // Heavily downscaled copy used to "blur" explicit covers on the canvas.
  // Works in every browser (ctx.filter isn't supported everywhere).
  function blurredOf(e) {
    if (e.blurred) return e.blurred;
    const small = document.createElement('canvas');
    const w = 12, h = Math.max(1, Math.round(12 * e.img.naturalHeight / e.img.naturalWidth));
    small.width = w; small.height = h;
    const c = small.getContext('2d');
    c.drawImage(e.img, 0, 0, w, h);
    e.blurred = small;
    return small;
  }

  const bgImageCache = { src: null, entry: null };
  function getBgImage() {
    if (!state.bgImage) return null;
    if (bgImageCache.src !== state.bgImage) {
      const img = new Image();
      const entry = { img, ok: false };
      img.onload = () => { entry.ok = true; scheduleRender(); };
      img.src = state.bgImage;
      bgImageCache.src = state.bgImage;
      bgImageCache.entry = entry;
    }
    return bgImageCache.entry;
  }

  // ---------------------------------------------------------------- layout
  const fontSpec = (weight, size, s = state) => `${weight} ${size}px "${s.font}", "Noto Sans JP", system-ui, sans-serif`;

  function rowsFor(s) {
    if (TIERS[s.layout]) return TIERS[s.layout];
    return Array(clamp(+s.rows || 1, 1, 10)).fill(clamp(+s.cols || 1, 1, 10));
  }
  const slotCount = (s = state) => rowsFor(s).reduce((a, b) => a + b, 0);

  function fitText(ctx, text, maxW) {
    if (maxW <= 0) return '';
    if (ctx.measureText(text).width <= maxW) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1;
    }
    return lo ? text.slice(0, lo).trimEnd() + '…' : '';
  }

  function computeLayout(s, ctx) {
    const rows = rowsFor(s);
    const gap = +s.gap, P = +s.padding, ar = +s.aspect || 1.5;
    const base = +s.coverSize;
    const gridW = base * rows[0] + gap * (rows[0] - 1);

    const L = { slots: [], lines: [], rows };
    L.titleSize = Math.round(clamp(gridW * 0.045, 22, 54));
    const hasTitle = !!(s.title && s.title.trim());
    const headerH = hasTitle ? Math.round(L.titleSize * 1.75) : 0;
    const gridX = P, gridY = P + headerH;

    const metaOn = s.showYear || s.showDev;
    let y = gridY, idx = 0;
    const rowTops = [];
    rows.forEach((n, r) => {
      const w = (gridW - gap * (n - 1)) / n;
      const h = w * ar;
      const lf = Math.round(clamp(w * 0.075, 10, 20));
      const labelH = s.titles === 'below' ? Math.ceil(6 + lf * 1.3 + (metaOn ? lf * 0.85 * 1.3 : 0)) : 0;
      rowTops.push(y);
      for (let c = 0; c < n; c++) {
        L.slots.push({ index: idx++, row: r, x: gridX + c * (w + gap), y, w, h, labelH, labelFont: lf });
      }
      y += h + labelH + gap;
    });
    const gridBottom = y - gap;

    let width = gridX + gridW + P;
    let listBottom = 0;

    if (s.titles === 'side') {
      const fs = Math.round(clamp(gridW * 0.016, 12, 18));
      const lineH = Math.round(fs * 1.5);
      const groupGap = Math.round(fs * 0.8);
      const maxW = Math.max(220, Math.min(560, gridW * 0.6));
      const sideX = gridX + gridW + Math.max(gap * 2, 28);
      let cursor = gridY, widest = 0;
      L.sideFont = fs;
      rows.forEach((n, r) => {
        const rowSlots = L.slots.filter((sl) => sl.row === r && s.items[sl.index]);
        if (!rowSlots.length) return;
        let gy = Math.max(cursor, rowTops[r]);
        rowSlots.forEach((sl, k) => {
          const it = s.items[sl.index];
          ctx.font = fontSpec(700, fs, s);
          const num = s.numberTitles ? `${sl.index + 1}. ` : '';
          const numW = num ? ctx.measureText(num).width : 0;
          ctx.font = fontSpec(400, fs, s);
          const meta = metaOf(it, s);
          const metaText = meta ? `  ${meta}` : '';
          const metaW = metaText ? ctx.measureText(metaText).width : 0;
          const title = fitText(ctx, titleOf(it, s), maxW - numW - metaW);
          const tW = ctx.measureText(title).width;
          widest = Math.max(widest, numW + tW + metaW);
          L.lines.push({ x: sideX, y: gy + k * lineH, num, numW, title, tW, meta: metaText });
        });
        cursor = gy + rowSlots.length * lineH + groupGap;
      });
      if (L.lines.length) {
        width = sideX + Math.ceil(widest) + P;
        listBottom = cursor - groupGap;
      }
    }

    if (hasTitle) {
      ctx.font = fontSpec(800, L.titleSize, s);
      width = Math.max(width, P * 2 + Math.ceil(ctx.measureText(s.title).width));
    }

    L.width = Math.ceil(Math.max(width, 200));
    L.height = Math.ceil(Math.max(gridBottom, listBottom) + P);
    L.headerY = P;
    L.hasTitle = hasTitle;
    return L;
  }

  // ---------------------------------------------------------------- drawing
  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    r = Math.min(r, w / 2, h / 2);
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }

  function drawCoverImage(ctx, source, sw, sh, x, y, w, h) {
    // object-fit: cover
    const sAr = sh / sw, tAr = h / w;
    let sx = 0, sy = 0, cw = sw, ch = sh;
    if (sAr > tAr) { ch = sw * tAr; sy = (sh - ch) / 2; }
    else { cw = sh / tAr; sx = (sw - cw) / 2; }
    ctx.drawImage(source, sx, sy, cw, ch, x, y, w, h);
  }

  function wrapLines(ctx, text, maxW, maxLines) {
    const words = text.split(/(\s+)/);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const test = cur + w;
      if (ctx.measureText(test).width > maxW && cur.trim()) {
        lines.push(cur.trim());
        cur = w.trimStart();
        if (lines.length === maxLines) break;
      } else cur = test;
    }
    if (lines.length < maxLines && cur.trim()) lines.push(cur.trim());
    if (lines.length === maxLines) lines[maxLines - 1] = fitText(ctx, lines[maxLines - 1], maxW);
    return lines.map((l) => fitText(ctx, l, maxW));
  }

  function drawSlot(ctx, s, sl, item, opts) {
    const { x, y, w, h } = sl;
    const r = +s.radius;
    const editing = !opts.export;

    if (!item) {
      if (editing || s.showEmpty) {
        ctx.fillStyle = s.empty;
        roundRectPath(ctx, x, y, w, h, r);
        ctx.fill();
        if (editing) {
          ctx.fillStyle = s.text;
          ctx.globalAlpha = 0.18;
          ctx.font = fontSpec(700, Math.round(clamp(w * 0.16, 10, 28)), s);
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(sl.index + 1), x + w / 2, y + h / 2);
          ctx.globalAlpha = 1;
        }
      }
      return;
    }

    const faded = editing && opts.dragFrom === sl.index && opts.dragging;
    if (faded) ctx.globalAlpha = 0.25;

    if (s.shadow) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = Math.max(6, w * 0.06);
      ctx.shadowOffsetY = Math.max(2, w * 0.02);
      ctx.fillStyle = s.empty;
      roundRectPath(ctx, x, y, w, h, r);
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    roundRectPath(ctx, x, y, w, h, r);
    ctx.clip();
    const e = item.image ? getImage(item.image.url) : null;
    if (e && e.ok) {
      if (shouldBlur(item, s)) {
        const b = blurredOf(e);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        drawCoverImage(ctx, b, b.width, b.height, x, y, w, h);
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(x, y, w, h);
      } else {
        ctx.imageSmoothingQuality = 'high';
        drawCoverImage(ctx, e.img, e.img.naturalWidth, e.img.naturalHeight, x, y, w, h);
      }
    } else {
      // Placeholder: no cover (yet) — show the title instead.
      ctx.fillStyle = s.empty;
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = s.text;
      const fs = Math.round(clamp(w * 0.09, 9, 18));
      ctx.font = fontSpec(600, fs, s);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const lines = wrapLines(ctx, titleOf(item, s), w - 12, 4);
      const lh = fs * 1.25;
      lines.forEach((l, i) => ctx.fillText(l, x + w / 2, y + h / 2 + (i - (lines.length - 1) / 2) * lh));
    }
    ctx.restore();

    if (s.showNumbers) {
      const bs = Math.round(clamp(w * 0.15, 14, 34));
      const bx = x + Math.max(4, w * 0.04), by = y + Math.max(4, w * 0.04);
      ctx.fillStyle = s.accent;
      roundRectPath(ctx, bx, by, bs, bs, bs * 0.3);
      ctx.fill();
      ctx.fillStyle = contrastOn(s.accent);
      ctx.font = fontSpec(800, Math.round(bs * (sl.index >= 99 ? 0.42 : 0.55)), s);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(sl.index + 1), bx + bs / 2, by + bs / 2 + 1);
    }

    if (s.titles === 'below') {
      const lf = sl.labelFont;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = s.text;
      ctx.font = fontSpec(600, lf, s);
      const prefix = s.numberTitles ? `${sl.index + 1}. ` : '';
      ctx.fillText(fitText(ctx, prefix + titleOf(item, s), w), x + w / 2, y + h + 6);
      const meta = metaOf(item, s);
      if (meta) {
        ctx.globalAlpha = (faded ? 0.25 : 1) * 0.6;
        ctx.font = fontSpec(400, Math.round(lf * 0.85), s);
        ctx.fillText(fitText(ctx, meta, w), x + w / 2, y + h + 6 + lf * 1.3);
      }
    }
    ctx.globalAlpha = 1;
  }

  function contrastOn(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? '#111111' : '#ffffff';
  }

  function drawChart(ctx, L, s, opts = {}) {
    // Background
    ctx.fillStyle = s.bg;
    ctx.fillRect(0, 0, L.width, L.height);
    const bgi = getBgImage();
    if (bgi && bgi.ok) {
      drawCoverImage(ctx, bgi.img, bgi.img.naturalWidth, bgi.img.naturalHeight, 0, 0, L.width, L.height);
      ctx.globalAlpha = (+s.bgDim) / 100;
      ctx.fillStyle = s.bg;
      ctx.fillRect(0, 0, L.width, L.height);
      ctx.globalAlpha = 1;
    }

    // Header
    if (L.hasTitle) {
      ctx.fillStyle = s.text;
      ctx.font = fontSpec(800, L.titleSize, s);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(s.title, +s.padding, L.headerY);
    }

    // Slots
    for (const sl of L.slots) drawSlot(ctx, s, sl, s.items[sl.index], opts);

    // Drop target highlight
    if (!opts.export && opts.dropTarget != null) {
      const sl = L.slots[opts.dropTarget];
      if (sl) {
        ctx.strokeStyle = s.accent;
        ctx.lineWidth = 3;
        roundRectPath(ctx, sl.x - 1.5, sl.y - 1.5, sl.w + 3, sl.h + 3, +s.radius + 1.5);
        ctx.stroke();
      }
    }

    // Side list
    if (L.lines.length) {
      const fs = L.sideFont;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      for (const ln of L.lines) {
        let x = ln.x;
        if (ln.num) {
          ctx.font = fontSpec(700, fs, s);
          ctx.fillStyle = s.accent;
          ctx.fillText(ln.num, x, ln.y);
          x += ln.numW;
        }
        ctx.font = fontSpec(400, fs, s);
        ctx.fillStyle = s.text;
        ctx.fillText(ln.title, x, ln.y);
        x += ln.tW;
        if (ln.meta) {
          ctx.globalAlpha = 0.55;
          ctx.fillText(ln.meta, x, ln.y);
          ctx.globalAlpha = 1;
        }
      }
    }

    // Drag ghost
    if (!opts.export && opts.dragging && opts.dragFrom != null && opts.dragPos) {
      const src = L.slots[opts.dragFrom];
      const item = s.items[opts.dragFrom];
      if (src && item) {
        const gw = src.w * 0.85, gh = src.h * 0.85;
        const ghost = { ...src, x: opts.dragPos.x - gw / 2, y: opts.dragPos.y - gh / 2, w: gw, h: gh, labelH: 0 };
        ctx.save();
        ctx.globalAlpha = 0.9;
        ctx.shadowColor = 'rgba(0,0,0,.5)';
        ctx.shadowBlur = 20;
        drawSlot(ctx, { ...s, titles: 'none', showNumbers: false, shadow: true }, ghost, item, { export: true });
        ctx.restore();
      }
    }
  }

  // ---------------------------------------------------------------- editor canvas
  const canvas = $('#chart');
  const cctx = canvas.getContext('2d');
  const wrap = $('#canvasWrap');
  let L = null;
  const ui = { dropTarget: null, dragFrom: null, dragging: false, dragPos: null };
  let renderQueued = false;
  let lastFontKey = '';

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  function ensureFonts() {
    // Make sure glyphs used on the chart (incl. Japanese subsets) are loaded.
    const texts = [state.title || ''];
    for (let i = 0; i < slotCount(); i++) {
      const it = state.items[i];
      if (it) texts.push(titleOf(it), metaOf(it));
    }
    const joined = texts.join(' ') + '0123456789.';
    const key = state.font + '|' + joined;
    if (key === lastFontKey) return Promise.resolve();
    lastFontKey = key;
    const loads = [400, 600, 700, 800].map((w) => document.fonts.load(fontSpec(w, 16), joined).catch(() => {}));
    return Promise.all(loads).then(() => scheduleRender());
  }

  function render() {
    L = computeLayout(state, cctx);
    const maxW = wrap.clientWidth || L.width;
    const maxH = wrap.clientHeight || L.height;
    let k = Math.min(1, maxW / L.width, maxH / L.height);
    // Don't shrink tall charts into a sliver — let the wrap scroll instead.
    k = Math.max(k, Math.min(1, (maxW * 0.55) / L.width));
    const pr = clamp((window.devicePixelRatio || 1) * k, 1, 2);
    const cw = Math.round(L.width * pr), ch = Math.round(L.height * pr);
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    canvas.style.width = Math.round(L.width * k) + 'px';
    canvas.style.height = Math.round(L.height * k) + 'px';
    cctx.setTransform(pr, 0, 0, pr, 0, 0);
    drawChart(cctx, L, state, ui);
    ensureFonts();
  }

  new ResizeObserver(() => scheduleRender()).observe(wrap);
  document.fonts.addEventListener('loadingdone', () => scheduleRender());

  function toLayout(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (L.width / rect.width),
      y: (e.clientY - rect.top) * (L.height / rect.height),
      inside: e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom,
    };
  }

  function hitTest(p, forgiving = false) {
    if (!L) return null;
    const pad = forgiving ? (+state.gap) / 2 : 0;
    for (const sl of L.slots) {
      if (p.x >= sl.x - pad && p.x <= sl.x + sl.w + pad && p.y >= sl.y - pad && p.y <= sl.y + sl.h + sl.labelH + pad) return sl.index;
    }
    return null;
  }

  // ---------------------------------------------------------------- chart mutations
  function commit() {
    save();
    scheduleRender();
    markResults();
  }

  function placeItem(idx, item) {
    const existing = state.items.findIndex((i) => i && i.id === item.id);
    if (existing === idx) return;
    if (existing >= 0) {
      [state.items[existing], state.items[idx]] = [state.items[idx], state.items[existing]];
    } else {
      state.items[idx] = item;
    }
    commit();
  }

  function addToNext(item) {
    const n = slotCount();
    const existing = state.items.findIndex((i) => i && i.id === item.id);
    if (existing >= 0 && existing < n) return toast(`“${item.title}” is already on the chart (#${existing + 1}).`);
    const idx = state.items.slice(0, n).findIndex((i) => !i);
    if (idx < 0) return toast('The chart is full — drag onto a slot to replace a cover.');
    if (existing >= 0) state.items[existing] = null;
    state.items[idx] = item;
    commit();
  }

  function removeAt(idx) {
    if (!state.items[idx]) return;
    state.items[idx] = null;
    commit();
  }

  // ---------------------------------------------------------------- canvas interactions
  let dragVN = null; // item being dragged from search results
  let pd = null;     // pointer-drag inside the chart
  const tooltip = $('#tooltip');

  function showTooltip(e, idx) {
    const it = idx != null ? state.items[idx] : null;
    if (!it) { tooltip.classList.add('hidden'); return; }
    tooltip.innerHTML = '';
    const t = document.createElement('div');
    t.textContent = `#${idx + 1} · ${it.title}`;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = [it.alttitle, yearOf(it), it.dev].filter(Boolean).join(' · ');
    tooltip.append(t, sub);
    tooltip.style.left = e.clientX + 14 + 'px';
    tooltip.style.top = e.clientY + 14 + 'px';
    tooltip.classList.remove('hidden');
  }

  canvas.addEventListener('dragover', (e) => {
    if (!dragVN) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const t = hitTest(toLayout(e), true);
    if (t !== ui.dropTarget) { ui.dropTarget = t; scheduleRender(); }
  });
  canvas.addEventListener('dragleave', () => { ui.dropTarget = null; scheduleRender(); });
  canvas.addEventListener('drop', (e) => {
    e.preventDefault();
    const t = hitTest(toLayout(e), true);
    ui.dropTarget = null;
    if (dragVN && t != null) placeItem(t, dragVN);
    dragVN = null;
    scheduleRender();
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const p = toLayout(e);
    const idx = hitTest(p);
    if (idx == null || !state.items[idx]) return;
    pd = { idx, sx: e.clientX, sy: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = toLayout(e);
    if (pd) {
      if (!ui.dragging && Math.hypot(e.clientX - pd.sx, e.clientY - pd.sy) > 6) {
        ui.dragging = true;
        ui.dragFrom = pd.idx;
        canvas.classList.add('grabbing');
        tooltip.classList.add('hidden');
      }
      if (ui.dragging) {
        ui.dragPos = p;
        ui.dropTarget = p.inside ? hitTest(p, true) : null;
        scheduleRender();
      }
      return;
    }
    const idx = hitTest(p);
    const filled = idx != null && state.items[idx];
    canvas.classList.toggle('pointer', !!filled);
    showTooltip(e, filled ? idx : null);
  });

  function endPointerDrag(e, cancelled) {
    if (!pd) return;
    if (ui.dragging && !cancelled) {
      const p = toLayout(e);
      if (!p.inside) {
        removeAt(pd.idx);
      } else if (ui.dropTarget != null && ui.dropTarget !== pd.idx) {
        const a = pd.idx, b = ui.dropTarget;
        [state.items[a], state.items[b]] = [state.items[b], state.items[a]];
        commit();
      }
    }
    pd = null;
    ui.dragging = false;
    ui.dragFrom = null;
    ui.dragPos = null;
    ui.dropTarget = null;
    canvas.classList.remove('grabbing');
    scheduleRender();
  }
  canvas.addEventListener('pointerup', (e) => endPointerDrag(e, false));
  canvas.addEventListener('pointercancel', (e) => endPointerDrag(e, true));
  canvas.addEventListener('pointerleave', () => { if (!pd) tooltip.classList.add('hidden'); });

  canvas.addEventListener('contextmenu', (e) => {
    const idx = hitTest(toLayout(e));
    if (idx != null && state.items[idx]) {
      e.preventDefault();
      removeAt(idx);
      tooltip.classList.add('hidden');
    }
  });

  canvas.addEventListener('dblclick', (e) => {
    const idx = hitTest(toLayout(e));
    const it = idx != null && state.items[idx];
    if (it && !it.external) window.open(`https://vndb.org/${it.id}`, '_blank', 'noopener');
  });

  // ---------------------------------------------------------------- VNDB API
  async function api(path, body, signal) {
    const res = await fetch(API + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    if (res.status === 429) throw new Error('VNDB rate limit reached — wait a minute and try again.');
    if (!res.ok) throw new Error(`VNDB error ${res.status}: ${(await res.text()).slice(0, 140)}`);
    return res.json();
  }

  // ---------------------------------------------------------------- search
  const search = { q: '', page: 1, more: false, ctrl: null, results: [] };
  const resultsEl = $('#results');
  const statusEl = $('#searchStatus');
  const loadMoreBtn = $('#loadMore');

  function buildQuery(q, sort, page) {
    const body = { fields: VN_FIELDS, results: 30, page };
    const filters = [];
    const idMatch = q.match(/^(?:https?:\/\/vndb\.org\/)?(v\d+)\/?$/i);
    if (idMatch) filters.push(['id', '=', idMatch[1].toLowerCase()]);
    else if (q) filters.push(['search', '=', q]);

    if (sort === 'relevance') {
      if (q && !idMatch) body.sort = 'searchrank';
      else { body.sort = 'votecount'; body.reverse = true; }
    } else if (sort === 'votecount') { body.sort = 'votecount'; body.reverse = true; }
    else if (sort === 'rating') {
      body.sort = 'rating'; body.reverse = true;
      if (!q) filters.push(['votecount', '>=', 100]);
    } else if (sort === 'released') {
      body.sort = 'released'; body.reverse = true;
      filters.push(['released', '<=', new Date().toISOString().slice(0, 10)]);
    }
    if (filters.length === 1) body.filters = filters[0];
    else if (filters.length > 1) body.filters = ['and', ...filters];
    return body;
  }

  async function doSearch(reset) {
    if (search.ctrl) search.ctrl.abort();
    const ctrl = new AbortController();
    search.ctrl = ctrl;
    if (reset) {
      search.page = 1;
      search.results = [];
      resultsEl.innerHTML = '<div class="skeleton"></div>'.repeat(9);
    } else {
      search.page++;
    }
    statusEl.textContent = 'Searching…';
    loadMoreBtn.classList.add('hidden');
    try {
      const data = await api('/vn', buildQuery(search.q, $('#searchSort').value, search.page), ctrl.signal);
      if (ctrl !== search.ctrl) return;
      const items = data.results.map(normalizeVN);
      search.results.push(...items);
      search.more = data.more;
      if (reset) resultsEl.innerHTML = '';
      items.forEach((it) => resultsEl.appendChild(resultCard(it)));
      markResults();
      statusEl.textContent = search.results.length ? `${search.results.length}${search.more ? '+' : ''} results` : 'No results';
      loadMoreBtn.classList.toggle('hidden', !search.more);
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (reset) resultsEl.innerHTML = '';
      statusEl.textContent = '';
      toast(err.message, 4000);
    }
  }

  function resultCard(it) {
    const el = document.createElement('div');
    el.className = 'result';
    el.draggable = true;
    el.dataset.id = it.id;
    el.title = [it.title, it.alttitle].filter(Boolean).join('\n') + '\nClick to add · drag onto the chart';
    const cover = document.createElement('div');
    cover.className = 'cover';
    if (it.image) cover.style.backgroundImage = `url("${it.image.thumb}")`;
    else cover.textContent = 'No cover';
    if (shouldBlur(it)) cover.classList.add('blur');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = titleOf(it);
    const s = document.createElement('div');
    s.className = 's';
    s.textContent = [yearOf(it), it.rating ? `★ ${(it.rating / 10).toFixed(2)}` : ''].filter(Boolean).join(' · ');
    meta.append(t, s);
    el.append(cover, meta);
    el._item = it;

    el.addEventListener('click', () => addToNext(it));
    el.addEventListener('dragstart', (e) => {
      dragVN = it;
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', it.id);
      if (it.image) getImage(it.image.url); // warm the cache
    });
    el.addEventListener('dragend', () => { dragVN = null; ui.dropTarget = null; scheduleRender(); });
    return el;
  }

  function markResults() {
    const ids = new Set(state.items.slice(0, slotCount()).filter(Boolean).map((i) => i.id));
    for (const el of resultsEl.children) {
      if (!el._item) continue;
      el.classList.toggle('in-chart', ids.has(el.dataset.id));
      el.querySelector('.cover').classList.toggle('blur', shouldBlur(el._item));
      el.querySelector('.t').textContent = titleOf(el._item);
    }
  }

  let searchTimer;
  $('#searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      search.q = e.target.value.trim();
      doSearch(true);
    }, 350);
  });
  $('#searchSort').addEventListener('change', () => doSearch(true));
  loadMoreBtn.addEventListener('click', () => doSearch(false));

  // ---------------------------------------------------------------- settings UI
  const NUMERIC = new Set(['rows', 'cols', 'coverSize', 'gap', 'padding', 'radius', 'bgDim']);

  function syncUI() {
    for (const el of $$('[data-key]')) {
      const k = el.dataset.key;
      if (el.type === 'checkbox') el.checked = !!state[k];
      else el.value = state[k] ?? '';
    }
    for (const el of $$('[data-val]')) el.textContent = state[el.dataset.val];
    $('#collageDims').classList.toggle('hidden', state.layout !== 'collage');
    refreshChartSelect();
  }

  for (const el of $$('[data-key]')) {
    el.addEventListener('input', () => {
      const k = el.dataset.key;
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (NUMERIC.has(k)) {
        v = Number(v);
        if (k === 'rows' || k === 'cols') {
          if (!v) return; // allow the field to be temporarily empty while typing
          v = clamp(Math.round(v), 1, 10);
        }
      }
      state[k] = v;
      const span = document.querySelector(`[data-val="${k}"]`);
      if (span) span.textContent = v;
      if (k === 'layout') $('#collageDims').classList.toggle('hidden', v !== 'collage');
      if (k === 'title') refreshChartSelect();
      if (k === 'font') document.fonts.load(fontSpec(800, 20)).then(scheduleRender);
      commit();
    });
  }

  // Presets
  const presetsEl = $('#presets');
  for (const p of PRESETS) {
    const b = document.createElement('div');
    b.className = 'preset';
    b.textContent = p.name;
    b.style.background = `linear-gradient(135deg, ${p.bg} 60%, ${p.accent} 60%)`;
    b.style.color = p.text;
    b.addEventListener('click', () => {
      Object.assign(state, { bg: p.bg, text: p.text, accent: p.accent, empty: p.empty });
      syncUI();
      commit();
    });
    presetsEl.appendChild(b);
  }

  // Background image (downscaled to keep localStorage happy)
  $('#bgImageInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      const max = 1800;
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      state.bgImage = c.toDataURL('image/jpeg', 0.85);
      URL.revokeObjectURL(img.src);
      commit();
    };
    img.src = URL.createObjectURL(file);
    e.target.value = '';
  });
  $('#bgImageClear').addEventListener('click', () => { state.bgImage = null; commit(); });

  $('#clearChart').addEventListener('click', () => {
    if (!confirm('Remove all covers from this chart?')) return;
    state.items = Array(MAX_ITEMS).fill(null);
    commit();
  });

  // Tabs
  for (const b of $$('.tabs button')) {
    b.addEventListener('click', () => {
      $$('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
      $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + b.dataset.tab));
    });
  }

  // ---------------------------------------------------------------- multiple charts
  const chartSelect = $('#chartSelect');

  function refreshChartSelect() {
    const ids = Object.keys(store.charts).sort((a, b) => (store.charts[a].created || 0) - (store.charts[b].created || 0));
    chartSelect.innerHTML = '';
    for (const id of ids) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = (store.charts[id].title || '').trim() || 'Untitled chart';
      chartSelect.appendChild(o);
    }
    chartSelect.value = store.current;
  }

  function switchTo(id) {
    store.current = id;
    state = store.charts[id];
    syncUI();
    commit();
  }

  chartSelect.addEventListener('change', () => switchTo(chartSelect.value));
  $('#newChart').addEventListener('click', () => {
    const id = uid();
    const { bg, text, accent, empty, font } = state;
    store.charts[id] = freshChart({ title: 'New chart', bg, text, accent, empty, font });
    switchTo(id);
  });
  $('#dupChart').addEventListener('click', () => {
    const id = uid();
    store.charts[id] = sanitizeChart({ ...JSON.parse(JSON.stringify(state)), title: (state.title || 'Chart') + ' (copy)', created: Date.now() });
    switchTo(id);
  });
  $('#deleteChart').addEventListener('click', () => {
    if (!confirm(`Delete “${state.title || 'Untitled chart'}”?`)) return;
    delete store.charts[store.current];
    const ids = Object.keys(store.charts);
    if (!ids.length) {
      const id = uid();
      store.charts[id] = freshChart();
      ids.push(id);
    }
    switchTo(ids[0]);
  });

  // ---------------------------------------------------------------- import from VNDB list
  $('#importBtn').addEventListener('click', async () => {
    const statusEl2 = $('#importStatus');
    const btn = $('#importBtn');
    const q = $('#importUser').value.trim();
    if (!q) return;
    btn.disabled = true;
    statusEl2.textContent = 'Looking up user…';
    try {
      let uidStr = /^u\d+$/i.test(q) ? q.toLowerCase() : null;
      let uname = q;
      if (!uidStr) {
        const u = await api('/user?q=' + encodeURIComponent(q));
        const hit = Object.values(u)[0];
        if (!hit) throw new Error(`No VNDB user named “${q}”.`);
        uidStr = hit.id;
        uname = hit.username;
      }
      statusEl2.textContent = `Fetching ${uname}'s list…`;
      const fields = VN_FIELDS.split(',').map((f) => 'vn.' + f).join(',') + ',vote';
      const data = await api('/ulist', {
        user: uidStr,
        fields,
        filters: ['label', '=', Number($('#importLabel').value)],
        sort: 'vote',
        reverse: true,
        results: 100,
      });
      const items = data.results.map((r) => normalizeVN({ id: r.id, ...r.vn }));
      if (!items.length) throw new Error('That list is empty or private.');
      const n = slotCount();
      if ($('#importMode').value === 'replace') {
        state.items = Array(MAX_ITEMS).fill(null);
        items.slice(0, n).forEach((it, i) => { state.items[i] = it; });
      } else {
        const have = new Set(state.items.filter(Boolean).map((i) => i.id));
        let i = 0;
        for (const it of items) {
          if (have.has(it.id)) continue;
          while (i < n && state.items[i]) i++;
          if (i >= n) break;
          state.items[i] = it;
        }
      }
      commit();
      statusEl2.textContent = `Imported ${Math.min(items.length, n)} of ${items.length} VNs from ${uname}.`;
    } catch (err) {
      statusEl2.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  // ---------------------------------------------------------------- JSON backup
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const slug = (s) => (s || 'vn-chart').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'vn-chart';

  $('#exportJson').addEventListener('click', () => {
    download(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }), slug(state.title) + '.json');
  });
  // ---- topsters.org (.topster) import
  // File format: base64( "120,156,..." ) -> bytes -> zlib -> JSON { <uuid>: { timestamp, data } }
  async function decodeTopster(text) {
    const csv = atob(text.trim());
    const bytes = Uint8Array.from(csv.split(',').map(Number));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return JSON.parse(await new Response(stream).text());
  }

  const normTitle = (t) => (t || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');
  const imgKey = (u) => (u || '').replace(/^https?:\/\/t\.vndb\.org\/cv(?:\.t)?\//, '');

  // Match a topsters.org entry to a VNDB entry (by cover URL, then exact title).
  async function resolveTopsterItem(it) {
    const external = () => ({
      id: 'x-' + normTitle(it.title).slice(0, 40) + '-' + uid().slice(0, 4),
      title: it.title, alttitle: null, released: null, rating: null,
      dev: it.creator || null,
      image: it.coverURL ? { url: it.coverURL, thumb: it.coverURL, sexual: 0, violence: 0 } : null,
      external: true,
    });
    try {
      const data = await api('/vn', {
        filters: ['search', '=', it.title], fields: VN_FIELDS, sort: 'searchrank', results: 8,
      });
      const cands = data.results.map(normalizeVN);
      const byCover = it.coverURL && cands.find((c) => c.image && imgKey(c.image.url) === imgKey(it.coverURL));
      const want = normTitle(it.title);
      const byTitle = cands.find((c) => normTitle(c.title) === want || normTitle(c.alttitle) === want);
      return byCover || byTitle || external();
    } catch (err) {
      if (/rate limit/i.test(err.message)) throw err;
      return external();
    }
  }

  async function chartFromTopster(d, onProgress) {
    const cols = clamp(+(d.size && d.size.x) || 5, 1, 10);
    const rows = clamp(+(d.size && d.size.y) || 4, 1, 10);
    const n = cols * rows;
    const items = Array(MAX_ITEMS).fill(null);
    const src = (d.items || []).slice(0, n);

    let done = 0, next = 0;
    const work = async () => {
      while (next < src.length) {
        const i = next++;
        const it = src[i];
        if (it && it.title) items[i] = await resolveTopsterItem(it);
        onProgress(++done, src.length);
      }
    };
    await Promise.all([work(), work(), work(), work()]);

    const fontMap = { monospace: 'Space Mono', serif: 'Playfair Display', 'sans-serif': 'Inter' };
    const hex = (c, def) => (/^#[0-9a-f]{6}$/i.test(c) ? c : def);
    return sanitizeChart({
      title: d.title || 'Imported chart',
      layout: 'collage', rows, cols,
      showNumbers: !!d.showNumbers,
      titles: d.showTitles ? 'side' : 'none',
      gap: clamp(+d.gap || 0, 0, 40),
      font: fontMap[d.font] || DEFAULTS.font,
      bg: hex(d.backgroundColor, DEFAULTS.bg),
      text: hex(d.textColor, DEFAULTS.text),
      shadow: !!d.shadows,
      radius: d.roundCorners ? 12 : 0,
      items,
      created: Date.now(),
    });
  }

  $('#importJson').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    let loaded = 0, lastId = null;
    for (const file of files) {
      try {
        const text = await file.text();
        let data = null;
        try { data = JSON.parse(text); } catch { /* maybe a .topster file */ }
        if (data && Array.isArray(data.items)) {
          // Native VN Topster JSON
          lastId = uid();
          store.charts[lastId] = sanitizeChart({ ...data, created: Date.now() });
          loaded++;
          continue;
        }
        if (!data) data = await decodeTopster(text);
        const entries = Object.values(data).filter((v) => v && v.data && Array.isArray(v.data.items));
        if (!entries.length) throw new Error('no charts');
        for (const entry of entries) {
          toast(`Importing “${entry.data.title || file.name}”…`, 60000);
          const chart = await chartFromTopster(entry.data, (d, t) => toast(`Importing “${entry.data.title || file.name}”: matching ${d}/${t} on VNDB…`, 60000));
          lastId = uid();
          store.charts[lastId] = chart;
          loaded++;
        }
      } catch (err) {
        console.error(err);
        toast(`“${file.name}” is not a valid chart file${err.message && !/no charts/.test(err.message) ? ` (${err.message})` : ''}.`, 4500);
      }
    }
    if (lastId) {
      switchTo(lastId);
      toast(`Imported ${loaded} chart${loaded === 1 ? '' : 's'}.`);
    }
  });

  // ---------------------------------------------------------------- PNG export
  $('#exportBtn').addEventListener('click', async () => {
    const btn = $('#exportBtn');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Rendering…';
    try {
      const n = slotCount();
      const waits = [];
      for (let i = 0; i < n; i++) {
        const it = state.items[i];
        if (it && it.image) waits.push(getImage(it.image.url).promise);
      }
      const timeout = new Promise((r) => setTimeout(r, 15000));
      await Promise.race([Promise.all(waits), timeout]);
      await ensureFonts();
      await document.fonts.ready;

      const scale = Number($('#exportScale').value) || 1;
      const off = document.createElement('canvas');
      const octx = off.getContext('2d');
      const EL = computeLayout(state, octx);
      off.width = Math.round(EL.width * scale);
      off.height = Math.round(EL.height * scale);
      octx.scale(scale, scale);
      drawChart(octx, EL, state, { export: true });
      const blob = await new Promise((resolve, reject) => {
        try { off.toBlob((b) => (b ? resolve(b) : reject(new Error('empty'))), 'image/png'); }
        catch (e) { reject(e); }
      });
      download(blob, slug(state.title) + '.png');
    } catch (err) {
      console.error(err);
      toast(taintedImages
        ? 'Export blocked: covers could not be loaded through the image proxy. Run the app with `node server.js`.'
        : 'Export failed: ' + err.message, 5000);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  // ---------------------------------------------------------------- boot
  syncUI();
  render();
  doSearch(true); // show popular VNs initially
})();
