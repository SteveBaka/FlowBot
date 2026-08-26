/* ═══════════════════════════════════════════════════════════════════════════════
   Liquid Glass 边沿折射引擎 — 移植自 liquid-glass-react (index.tsx / shader-utils.ts)
   零依赖。流程：
     1. canvas 上用 rounded-rect SDF 生成置换贴图（中心恒等、边缘平滑增强）
     2. 注入共享 SVG 滤镜 #lg-liquid-glass（R/G/B 三路位移产生色散，边缘遮罩限定生效区）
     3. html 加 lg-svg 类后，style.css 通过 backdrop-filter 链尾追加 url() 引用
        → 内容与文字永不变形（等效 liquid-glass-react 的 "user content stays sharp"）
   仅 Chromium 启用；Firefox/Safari 保持纯 blur+saturate 降级（与源码 isFirefox 策略一致）。
   可用 window.LIQUID_GLASS_CONFIG = { displacementScale, aberrationIntensity, size } 覆写。
   ═══════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__LG_REFRACTION__) return;
  window.__LG_REFRACTION__ = true;

  var cfg = Object.assign(
    { displacementScale: 100, aberrationIntensity: 2, size: 256 },
    window.LIQUID_GLASS_CONFIG || {}
  );

  var ua = navigator.userAgent.toLowerCase();
  var isFirefox = ua.indexOf('firefox') !== -1;
  var isChromium = !!(window.chrome) || ua.indexOf('chromium') !== -1 || ua.indexOf('edg/') !== -1;
  if (isFirefox || !isChromium) return;

  /* ── 置换贴图生成（shader-utils.ts 同公式） ─────────────────────────────── */
  function smoothStep(a, b, t) {
    t = Math.max(0, Math.min(1, (t - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }
  function roundedRectSDF(x, y, w, h, r) {
    var qx = Math.abs(x) - w + r;
    var qy = Math.abs(y) - h + r;
    return Math.min(Math.max(qx, qy), 0) +
      Math.sqrt(Math.max(qx, 0) * Math.max(qx, 0) + Math.max(qy, 0) * Math.max(qy, 0)) - r;
  }

  function buildDisplacementMap() {
    var S = cfg.size;
    var canvas = document.createElement('canvas');
    canvas.width = S;
    canvas.height = S;
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(S, S);
    var data = img.data;
    var raw = new Float32Array(S * S * 2);
    var maxScale = 0;
    var i = 0;
    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; x++) {
        var ix = x / S - 0.5;
        var iy = y / S - 0.5;
        var dist = roundedRectSDF(ix, iy, 0.3, 0.2, 0.6);
        var scaled = smoothStep(0, 1, smoothStep(0.8, 0, dist - 0.15));
        var dx = (ix * scaled + 0.5) * S - x;
        var dy = (iy * scaled + 0.5) * S - y;
        var ad = Math.max(Math.abs(dx), Math.abs(dy));
        if (ad > maxScale) maxScale = ad;
        raw[i++] = dx;
        raw[i++] = dy;
      }
    }
    if (maxScale < 1) maxScale = 1;
    i = 0;
    for (var p = 0; p < S * S; p++) {
      var px = p % S;
      var py = (p / S) | 0;
      var ddx = raw[i++];
      var ddy = raw[i++];
      /* 贴图边缘 2px 平滑，防止硬过渡 (shader-utils.ts edgeFactor) */
      var edgeFactor = Math.min(1, Math.min(px, py, S - px - 1, S - py - 1) / 2);
      ddx *= edgeFactor;
      ddy *= edgeFactor;
      var r = ddx / maxScale + 0.5;
      var g = ddy / maxScale + 0.5;
      var q = p * 4;
      data[q] = Math.max(0, Math.min(255, r * 255));
      data[q + 1] = Math.max(0, Math.min(255, g * 255));
      data[q + 2] = data[q + 1]; /* B 复用 Y 位移 — 滤镜 yChannelSelector="B" */
      data[q + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL('image/png');
  }

  /* ── SVG 滤镜链（index.tsx GlassFilter 同构） ───────────────────────────── */
  function injectFilter(mapURL) {
    var NS = 'http://www.w3.org/2000/svg';
    var XLINK = 'http://www.w3.org/1999/xlink';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'lg-filter-defs');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    var defs = document.createElementNS(NS, 'defs');
    var filter = document.createElementNS(NS, 'filter');
    filter.setAttribute('id', 'lg-liquid-glass');
    filter.setAttribute('x', '-35%');
    filter.setAttribute('y', '-35%');
    filter.setAttribute('width', '170%');
    filter.setAttribute('height', '170%');
    filter.setAttribute('colorInterpolationFilters', 'sRGB');

    function el(name, attrs) {
      var node = document.createElementNS(NS, name);
      for (var k in attrs) node.setAttribute(k, attrs[k]);
      filter.appendChild(node);
      return node;
    }

    var ab = cfg.aberrationIntensity;
    var base = cfg.displacementScale;

    el('feImage', {
      x: '0', y: '0', width: '100%', height: '100%',
      preserveAspectRatio: 'xMidYMid slice',
      result: 'DISPLACEMENT_MAP', href: mapURL
    }).setAttributeNS(XLINK, 'xlink:href', mapURL);

    el('feColorMatrix', {
      in: 'DISPLACEMENT_MAP', type: 'matrix',
      values: '0.3 0.3 0.3 0 0  0.3 0.3 0.3 0 0  0.3 0.3 0.3 0 0  0 0 0 1 0',
      result: 'EDGE_INTENSITY'
    });
    var edgeMask = el('feComponentTransfer', { in: 'EDGE_INTENSITY', result: 'EDGE_MASK' });
    var edgeFunc = document.createElementNS(NS, 'feFuncA');
    edgeFunc.setAttribute('type', 'discrete');
    edgeFunc.setAttribute('tableValues', '0 ' + (0.1 + ab * 0.06) + ' 1');
    edgeMask.appendChild(edgeFunc);

    el('feOffset', { in: 'SourceGraphic', dx: '0', dy: '0', result: 'CENTER_ORIGINAL' });

    /* R/G/B 三路位移 — scale 逐通道递减产生色散 */
    var channels = [
      { scale: base, keep: '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0', result: 'RED_CHANNEL' },
      { scale: base * (1 - ab * 0.05), keep: '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0', result: 'GREEN_CHANNEL' },
      { scale: base * (1 - ab * 0.1), keep: '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0', result: 'BLUE_CHANNEL' }
    ];
    channels.forEach(function (ch) {
      el('feDisplacementMap', {
        in: 'SourceGraphic', in2: 'DISPLACEMENT_MAP',
        scale: String(ch.scale), xChannelSelector: 'R', yChannelSelector: 'B',
        result: ch.result + '_DISPLACED'
      });
      el('feColorMatrix', { in: ch.result + '_DISPLACED', type: 'matrix', values: ch.keep, result: ch.result });
    });

    el('feBlend', { in: 'GREEN_CHANNEL', in2: 'BLUE_CHANNEL', mode: 'screen', result: 'GB_COMBINED' });
    el('feBlend', { in: 'RED_CHANNEL', in2: 'GB_COMBINED', mode: 'screen', result: 'RGB_COMBINED' });
    el('feGaussianBlur', { in: 'RGB_COMBINED', stdDeviation: String(Math.max(0.1, 0.5 - ab * 0.1)), result: 'ABERRATED_BLURRED' });
    el('feComposite', { in: 'ABERRATED_BLURRED', in2: 'EDGE_MASK', operator: 'in', result: 'EDGE_ABERRATION' });

    /* 中心保持原图 */
    var inv = el('feComponentTransfer', { in: 'EDGE_MASK', result: 'INVERTED_MASK' });
    var feFuncA = document.createElementNS(NS, 'feFuncA');
    feFuncA.setAttribute('type', 'table');
    feFuncA.setAttribute('tableValues', '1 0');
    inv.appendChild(feFuncA);
    el('feComposite', { in: 'CENTER_ORIGINAL', in2: 'INVERTED_MASK', operator: 'in', result: 'CENTER_CLEAN' });
    el('feComposite', { in: 'EDGE_ABERRATION', in2: 'CENTER_CLEAN', operator: 'over' });

    defs.appendChild(filter);
    svg.appendChild(defs);
    (document.body || document.documentElement).appendChild(svg);

    /* 下一帧再加类，确保样式解析时滤镜已就位 */
    requestAnimationFrame(function () {
      document.documentElement.classList.add('lg-svg');
      injectWarpLayers();
    });
  }

  /* ── warp 层注入（liquid-glass-react 原架构）─────────────────────────
     blur+url 塞进同一个 backdrop-filter 列表会被 Chromium 打折（探针实测）。
     正确做法：容器内 prepend 一个空 warp 层，backdrop-filter 只含 blur()
     纯函数，filter: url() 单独一条扭曲该层合成结果。内容 z-index>0 不变形。 */
  var WARP_SELECTOR = [
    '.card', '.stat-card', '.bot-card', '.log-box', '.hint-card',
    '.disclaimer-banner', '.port-item', '.login-card', '.modal',
    '.bot-config-panel', '.chain-bar', '.health-banner', '.bp-alert-banner'
  ].join(',');

  function injectWarpLayers(root) {
    var scope = root || document;
    var targets = scope.querySelectorAll(WARP_SELECTOR);
    for (var i = 0; i < targets.length; i++) {
      var el = targets[i];
      if (el.__lgWarp) continue;
      if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
      var warp = document.createElement('span');
      warp.className = 'glass-warp';
      el.__lgWarp = true;
      el.insertBefore(warp, el.firstChild);
    }
  }

  function observeWarp() {
    injectWarpLayers();
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        if (muts[i].addedNodes.length) {
          /* 动态插入的卡片（队列项、toasts 等）也补 warp */
          setTimeout(function () { injectWarpLayers(); }, 0);
          break;
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  function boot() {
    try {
      injectFilter(buildDisplacementMap());
      observeWarp();
    } catch (e) {
      /* canvas/SVG 不可用时静默降级为纯 blur */
    }
  }
  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
