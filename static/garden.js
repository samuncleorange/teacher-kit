/* Quiet Garden — shared rendering for student & teacher pages */
(function (global) {
  'use strict';

  const MAX_DB_DISPLAY = 120;

  // Build an SVG pine tree at the requested size level.
  function pineSvg(level) {
    const sizes = {
      1: { w: 60,  h: 90,  layers: 3, trunkH: 18 },
      2: { w: 85,  h: 130, layers: 4, trunkH: 24 },
      3: { w: 110, h: 175, layers: 5, trunkH: 32 },
      4: { w: 140, h: 220, layers: 6, trunkH: 40 },
    };
    const s = sizes[level] || sizes[1];
    const w = s.w, h = s.h;
    const trunkW = w * 0.18;
    const trunkX = (w - trunkW) / 2;
    const trunkY = h - s.trunkH;
    const foliageH = h - s.trunkH;
    const greens = ['#1f5f3f', '#2d7a4f', '#3a9560', '#52b788', '#74c69d'];

    let layersSvg = '';
    const layerCount = s.layers;
    const layerHeight = foliageH / (layerCount * 0.55 + 0.45);
    for (let i = 0; i < layerCount; i++) {
      const top = (i * layerHeight * 0.55);
      const bot = top + layerHeight;
      const widthRatio = 0.5 + (i * 0.5 / Math.max(1, layerCount - 1));
      const layerW = w * widthRatio;
      const xLeft = (w - layerW) / 2;
      const xRight = xLeft + layerW;
      const apex = w / 2;
      const color = greens[Math.min(i, greens.length - 1)];
      layersSvg +=
        `<polygon points="${apex},${top} ${xLeft},${bot} ${xRight},${bot}" ` +
        `fill="${color}" stroke="#0d3d2a" stroke-width="0.6" stroke-opacity="0.25"/>`;
    }

    return (
      `<svg class="tree-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">` +
        `<ellipse cx="${w/2}" cy="${h-3}" rx="${w*0.32}" ry="4" fill="rgba(0,0,0,0.18)"/>` +
        `<rect x="${trunkX}" y="${trunkY}" width="${trunkW}" height="${s.trunkH}" rx="2" fill="#7a4a2a"/>` +
        `<rect x="${trunkX}" y="${trunkY}" width="${trunkW * 0.35}" height="${s.trunkH}" rx="2" fill="#9a6238"/>` +
        layersSvg +
      `</svg>`
    );
  }

  // Render a tree list into a container element. Reuses existing nodes
  // by data-tree-id so animations only fire on real changes.
  // Idempotent renderer: never re-attaches an already-rendered tree
  // (re-attaching can restart the CSS grow animation in some browsers,
  // which made trees flicker on every SSE broadcast).
  function renderTrees(containerEl, trees) {
    const wantedIds = new Set(trees.map(t => t.id));

    // 1. Mark orphans for removal animation. Don't touch ones already removing.
    [...containerEl.children].forEach(el => {
      if (el.classList.contains('removing')) return;
      if (!wantedIds.has(el.dataset.treeId)) {
        el.classList.add('removing');
        setTimeout(() => {
          if (el.parentNode) el.parentNode.removeChild(el);
        }, 480);
      }
    });

    // 2. Build a map of currently live (non-removing) elements.
    const existing = new Map();
    [...containerEl.children].forEach(el => {
      if (!el.classList.contains('removing')) {
        existing.set(el.dataset.treeId, el);
      }
    });

    // 3. Append fresh trees; update level on existing ones if it changed.
    //    Critically: do NOT move/re-append existing in-place trees — that
    //    can restart their CSS animation in some browsers.
    trees.forEach(tree => {
      const el = existing.get(tree.id);
      if (!el) {
        const fresh = document.createElement('div');
        fresh.className = 'tree';
        fresh.dataset.treeId = tree.id;
        fresh.dataset.level = String(tree.level);
        fresh.innerHTML = pineSvg(tree.level);
        containerEl.appendChild(fresh);
      } else if (el.dataset.level !== String(tree.level)) {
        el.dataset.level = String(tree.level);
        el.innerHTML = pineSvg(tree.level);
      }
      // else: already in place at the right level — leave it alone.
    });
  }

  function updateStats(stats, trees) {
    const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    trees.forEach(t => { if (counts[t.level] != null) counts[t.level]++; });
    if (stats.small)  stats.small.textContent  = counts[1];
    if (stats.medium) stats.medium.textContent = counts[2];
    if (stats.large)  stats.large.textContent  = counts[3];
    if (stats.huge)   stats.huge.textContent   = counts[4];
  }

  function updateMarkers(meterEls, settings) {
    const q = clampInt(settings.quietTarget, 0, MAX_DB_DISPLAY, 40);
    const l = clampInt(settings.loudTarget, 0, MAX_DB_DISPLAY, 80);
    if (meterEls.quiet) meterEls.quiet.style.left = ((q / MAX_DB_DISPLAY) * 100) + '%';
    if (meterEls.loud)  meterEls.loud.style.left  = ((l / MAX_DB_DISPLAY) * 100) + '%';
  }

  function clampInt(v, lo, hi, fallback) {
    const n = parseInt(v, 10);
    if (isNaN(n)) return fallback;
    return Math.max(lo, Math.min(hi, n));
  }

  function fmtSecondsRemaining(elapsedMs, totalMs) {
    return Math.max(0, Math.ceil((totalMs - elapsedMs) / 1000));
  }

  global.QG = {
    MAX_DB_DISPLAY,
    pineSvg,
    renderTrees,
    updateStats,
    updateMarkers,
    clampInt,
    fmtSecondsRemaining,
  };
})(window);
