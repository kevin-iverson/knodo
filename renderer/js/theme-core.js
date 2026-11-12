'use strict';
/**
 * 外观主题 · 数据与算法（经典脚本，必须在样式生效前同步执行）。
 *
 * 为什么不做成 ES module：module 默认 defer，首帧已经在 module 执行前画出来了，
 * 深色 / 石墨用户在启动时会先看到一帧雾灰浅色。这里包成普通脚本，配合 localstorage 缓存
 * 在 <head> 里同步把 data-theme / 三元组写进 :root，首帧就是对的颜色。
 *
 * 职责边界：
 *   · 本文件 = 6 套风格 × 明暗的配色表 + 补偿/护栏/scrim 的算法 + 把 token 写进 DOM
 *   · js/theme.js = 与主进程通信（读写配置、选图）、丢失兜底、给设置面板用的小工具
 *
 * 唯一公式（设计方案 4.2）：
 *   surface-alpha = 1 − (1 − styleBase) × (opacity ÷ 100)
 * 透明度调的是「背景透过面板的比例」，不是图片层的 opacity —— 后者会被主题底色洗成灰雾。
 */
(function () {
  /** 六套风格：只定义色相与饱和度；base = 图片全显时允许的最小面板不透明度 */
  const STYLES = {
    mist: {
      name: '雾灰', en: 'MIST', base: 0.72, swatch: '#4f7cff',
      light: {
        bg: '#f5f6f8', 'bg-panel': '#ffffff', 'bg-sidebar': '#fbfbfd', 'bg-hover': '#eef1f6', 'bg-active': '#e8eefc',
        text: '#1f2430', 'text-2': '#6b7280', 'text-3': '#9aa1ad', border: '#e6e8ee', primary: '#4f7cff', 'primary-strong': '#3a62e0',
      },
      dark: {
        bg: '#15181f', 'bg-panel': '#1d212a', 'bg-sidebar': '#181b22', 'bg-hover': '#262b36', 'bg-active': '#2c3444',
        text: '#e7eaf0', 'text-2': '#9aa3b2', 'text-3': '#6c7482', border: '#2a2f3a', primary: '#6b90ff', 'primary-strong': '#5278e8',
      },
    },
    graphite: {
      name: '石墨', en: 'GRAPHITE', base: 0.74, swatch: '#41618f',
      light: {
        bg: '#e9ecf1', 'bg-panel': '#f7f8fa', 'bg-sidebar': '#f1f3f7', 'bg-hover': '#dfe4ec', 'bg-active': '#d7e0ef',
        text: '#141821', 'text-2': '#5b6472', 'text-3': '#8d96a4', border: '#dde2ea', primary: '#41618f', 'primary-strong': '#34507a',
      },
      dark: {
        bg: '#0f1216', 'bg-panel': '#171c22', 'bg-sidebar': '#13171d', 'bg-hover': '#1f262f', 'bg-active': '#24303f',
        text: '#e3e8ef', 'text-2': '#98a3b1', 'text-3': '#6b7684', border: '#262d36', primary: '#6f95d6', 'primary-strong': '#5478b5',
      },
    },
    moss: {
      name: '苔绿', en: 'MOSS', base: 0.72, swatch: '#4a7c43',
      light: {
        bg: '#eef2e9', 'bg-panel': '#fbfcf8', 'bg-sidebar': '#f5f7f0', 'bg-hover': '#e3eadd', 'bg-active': '#dcebd6',
        text: '#1e261c', 'text-2': '#5d6a58', 'text-3': '#8c978a', border: '#dde4d6', primary: '#4a7c43', 'primary-strong': '#3a6435',
      },
      dark: {
        bg: '#131a14', 'bg-panel': '#1a231a', 'bg-sidebar': '#161e17', 'bg-hover': '#233024', 'bg-active': '#283a28',
        text: '#e4ebdf', 'text-2': '#9caf9a', 'text-3': '#6f7d6e', border: '#26301f', primary: '#7fb070', 'primary-strong': '#5f9155',
      },
    },
    sepia: {
      name: '宣纸', en: 'SEPIA', base: 0.70, swatch: '#a5642c',
      light: {
        bg: '#f6f0e4', 'bg-panel': '#fdf8ee', 'bg-sidebar': '#faf5ea', 'bg-hover': '#efe6d5', 'bg-active': '#f2e4c9',
        text: '#2c2418', 'text-2': '#6d6150', 'text-3': '#9c9080', border: '#e8dcc8', primary: '#a5642c', 'primary-strong': '#85501f',
      },
      dark: {
        bg: '#1b1610', 'bg-panel': '#241d15', 'bg-sidebar': '#1e1912', 'bg-hover': '#2e251a', 'bg-active': '#3a2d1e',
        text: '#eee3d1', 'text-2': '#b3a48c', 'text-3': '#827664', border: '#33291d', primary: '#d99a5b', 'primary-strong': '#b87d42',
      },
    },
    sakura: {
      name: '樱粉', en: 'SAKURA', base: 0.72, swatch: '#d4677f',
      light: {
        bg: '#fbf1f3', 'bg-panel': '#fffafb', 'bg-sidebar': '#fdf5f7', 'bg-hover': '#f7e5ea', 'bg-active': '#f9dfe6',
        text: '#2b2026', 'text-2': '#6f5b64', 'text-3': '#a08e96', border: '#f0dde2', primary: '#d4677f', 'primary-strong': '#b44b64',
      },
      dark: {
        bg: '#1a1417', 'bg-panel': '#241a1e', 'bg-sidebar': '#1e171a', 'bg-hover': '#2e2227', 'bg-active': '#3a2a31',
        text: '#f0e4e7', 'text-2': '#b8a2a9', 'text-3': '#8a737b', border: '#33242a', primary: '#ec8ba0', 'primary-strong': '#d07087',
      },
    },
    contrast: {
      name: '高对比', en: 'CONTRAST', base: 0.86, swatch: '#111111',
      light: {
        bg: '#ffffff', 'bg-panel': '#ffffff', 'bg-sidebar': '#ffffff', 'bg-hover': '#eaeaea', 'bg-active': '#d7d7d7',
        text: '#000000', 'text-2': '#333333', 'text-3': '#5a5a5a', border: '#767676', primary: '#0033cc', 'primary-strong': '#0026a3',
      },
      dark: {
        bg: '#000000', 'bg-panel': '#0a0a0a', 'bg-sidebar': '#050505', 'bg-hover': '#1e1e1e', 'bg-active': '#2e2e2e',
        text: '#ffffff', 'text-2': '#d0d0d0', 'text-3': '#a0a0a0', border: '#8a8a8a', primary: '#66b3ff', 'primary-strong': '#8fc9ff',
      },
    },
  };

  const ORDER = ['mist', 'graphite', 'moss', 'sepia', 'sakura', 'contrast'];

  /**
   * 出厂默认 = 宣纸（与主进程 main/theme.js 的 DEFAULT_THEME 必须一致）。
   * 只有「从来没存过主题」才落到这里：normalize 对缺失 / 非法 style 的兜底值就是它，
   * 所以老版本只存过 'light' / 'dark' 字符串的用户，也会得到宣纸而不是纯白雾灰。
   */
  const DEFAULTS = {
    mode: 'system',
    style: 'sepia',
    backdrop: {
      type: 'none', image: '', opacity: 60, blur: 0, fit: 'cover',
      scrim: 'auto', glass: true, luma: 0.5, missing: false,
    },
    // 桌面浮窗材质：0–100 不透明度百分比。浮窗贴在别人窗口上，太透会和下面的
    // 内容糊成一片，所以默认比主窗口面板块更实（95）。底色不走固定白，
    // 而是取当前风格的 panel 色 —— 换宣纸 / 樱粉浮窗跟着变。
    desktop: { opacity: 95 },
  };

  /** 语义 token → CSS 变量名（三元组） */
  const CSS_VAR = {
    bg: '--bg-rgb',
    'bg-panel': '--panel-rgb',
    'bg-sidebar': '--sidebar-rgb',
    'bg-hover': '--hover-rgb',
    'bg-active': '--active-rgb',
    text: '--text-rgb',
    'text-2': '--text2-rgb',
    'text-3': '--text3-rgb',
    border: '--border-rgb',
    primary: '--primary-rgb',
    'primary-strong': '--primary-strong-rgb',
  };

  const CACHE_KEY = 'knodo.theme.cache';
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

  /** '#4f7cff' → '79 124 255' */
  function triple(hex) {
    const h = String(hex || '').replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(full, 16) || 0;
    return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
  }

  function rgbOf(hex) {
    return triple(hex).split(' ').map(Number);
  }

  /** 感知亮度（0–1），与主进程算图片平均亮度同一套权重（scrim 用它，别用 WCAG 的线性化值） */
  function lumaOf(rgb) {
    const [r, g, b] = rgb;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  /** sRGB 通道 → 线性光度（WCAG 对比度必须先线性化，否则浅底会算出假低对比） */
  function toLinear(v) {
    const c = Math.min(255, Math.max(0, v)) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }

  function relLum(rgb) {
    return 0.2126 * toLinear(rgb[0]) + 0.7152 * toLinear(rgb[1]) + 0.0722 * toLinear(rgb[2]);
  }

  /** WCAG 对比度 */
  function contrastRatio(a, b) {
    const la = relLum(a);
    const lb = relLum(b);
    const hi = Math.max(la, lb);
    const lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }

  function normalize(raw) {
    let src = raw;
    if (typeof src === 'string') {
      try { src = JSON.parse(src); } catch (e) { src = src; }
    }
    if (typeof src === 'string') {
      // 老版本：settings 里只有 'system' / 'light' / 'dark'
      return {
        ...DEFAULTS,
        backdrop: { ...DEFAULTS.backdrop },
        desktop: { ...DEFAULTS.desktop },
        mode: ['system', 'light', 'dark'].includes(src) ? src : 'system',
      };
    }
    if (!src || typeof src !== 'object') {
      return { ...DEFAULTS, backdrop: { ...DEFAULTS.backdrop }, desktop: { ...DEFAULTS.desktop } };
    }
    const bd = src.backdrop && typeof src.backdrop === 'object' ? src.backdrop : {};
    const dk = src.desktop && typeof src.desktop === 'object' ? src.desktop : {};
    const image = String(bd.image || '');
    const num = (v, fb) => (Number.isFinite(Number(v)) ? Number(v) : fb);
    return {
      mode: ['system', 'light', 'dark'].includes(src.mode) ? src.mode : 'system',
      style: STYLES[src.style] ? src.style : DEFAULTS.style,
      desktop: {
        // 5 的整数倍 + 55 起：再透下去浮窗里的正文就压不住任何壁纸了
        opacity: clamp(Math.round(num(dk.opacity, DEFAULTS.desktop.opacity) / 5) * 5, 55, 100),
      },
      backdrop: {
        type: image ? (bd.type === 'none' ? 'none' : 'image') : 'none',
        image,
        opacity: clamp(Math.round(num(bd.opacity, 60) / 5) * 5, 0, 100),
        blur: [0, 8, 16].includes(num(bd.blur, 0)) ? num(bd.blur, 0) : 0,
        fit: ['cover', 'contain', 'repeat'].includes(bd.fit) ? bd.fit : 'cover',
        scrim: ['auto', 'none', 'weak', 'mid', 'strong'].includes(bd.scrim) ? bd.scrim : 'auto',
        glass: bd.glass !== false,
        luma: clamp(num(bd.luma, 0.5), 0, 1),
        missing: !!bd.missing,
      },
    };
  }

  function resolveMode(theme) {
    const t = theme || DEFAULTS;
    if (t.mode === 'light' || t.mode === 'dark') return t.mode;
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (e) {
      return 'light';
    }
  }

  /** 背景图相对路径 → todo-media:/// URL（CSP 里没有 file://） */
  function mediaUrl(rel) {
    const clean = String(rel || '').replace(/^\/+/, '');
    if (!clean) return '';
    return `todo-media:///${clean.split('/').map(encodeURIComponent).join('/')}`;
  }

  /**
   * 算出这一份主题的全部派生值。
   * @returns {{mode:string,style:string,tokens:object,opacity:number,alpha:number,
   *   guardPct:number,scrim:number,glass:boolean,hasImage:boolean,url:string,blur:number,fit:string}}
   */
  function resolve(raw) {
    const theme = normalize(raw);
    const mode = resolveMode(theme);
    const styleId = theme.style;
    const style = STYLES[styleId] || STYLES[DEFAULTS.style];
    const tokens = style[mode] || style.light;
    const bd = theme.backdrop;

    const hasImage = bd.type === 'image' && !!bd.image && !bd.missing;
    // 高对比风格锁 30%：无障碍优先，滑块置灰（设计方案 · 协同规则）
    const opacity = hasImage
      ? (styleId === 'contrast' ? Math.min(bd.opacity, 30) : bd.opacity)
      : 0;

    let alpha = 1 - (1 - style.base) * (opacity / 100);
    let guardPct = 0;

    if (hasImage && opacity > 0) {
      // 可读性护栏：最危险的不是卡片（卡片 alpha 高），而是「内容区地面」——
      // 分组标题、筛选条、视图说明这些字直接坐在 0.45 × alpha 的地面上，壁纸一深就糊。
      // 所以按地面合成色算对比度，不足 4.5:1 就往上垫 alpha（最多 +12%），并报出垫了多少。
      const bg = rgbOf(tokens.bg);
      const panel = rgbOf(tokens['bg-panel']);
      const text = rgbOf(tokens.text);
      const behind = bd.luma * 255;
      const worst = (a) => {
        const groundA = a * 0.45;
        const ground = bg.map((c) => c * groundA + behind * (1 - groundA));
        const card = panel.map((c) => c * a + behind * (1 - a));
        return Math.min(contrastRatio(ground, text), contrastRatio(card, text));
      };
      let need = 0;
      for (let add = 0; add <= 0.1201; add += 0.02) {
        need = add;
        if (worst(Math.min(1, alpha + add)) >= 4.5) break;
      }
      // 极端组合（纯白壁纸 + 浅色文字主题）垫满 12% 也压不住时，仍然如实报出留痕
      guardPct = Math.round(need * 100);
      alpha = Math.min(1, alpha + need);
    }

    // scrim 自动档：把图片平均亮度拉向当前模式的基准（浅 0.72 / 深 0.28）
    const target = mode === 'light' ? 0.72 : 0.28;
    let scrim;
    if (styleId === 'contrast') {
      scrim = 0.05;
    } else if (bd.scrim === 'auto') {
      scrim = Math.min(0.35, Math.abs(bd.luma - target) * 0.5);
    } else {
      scrim = { none: 0, weak: 0.12, mid: 0.22, strong: 0.34 }[bd.scrim] || 0;
    }

    // 滑块拉到 0 = 不渲染图片层（省内存），不是把 opacity 设成 0 空转
    const showImage = hasImage && opacity > 0;
    const blur = bd.blur > 0 ? bd.blur : 0;

    return {
      mode,
      style: styleId,
      tokens,
      /** 浮窗材质不透明度（0–1）：desktop.css 里 --dw-bg 的 alpha 直接取它 */
      desktopAlpha: Math.round((theme.desktop.opacity / 100) * 100) / 100,
      opacity,
      alpha: Math.round(alpha * 1000) / 1000,
      guardPct: styleId === 'contrast' ? 0 : guardPct,
      scrim: Math.round(scrim * 100) / 100,
      glass: bd.glass !== false && styleId !== 'contrast',
      hasImage,
      url: showImage ? mediaUrl(bd.image) : '',
      blur,
      fit: bd.fit,
      luma: bd.luma,
      missing: !!bd.missing,
    };
  }

  /** 把解析结果写进 DOM（幂等，可反复调用） */
  function paint(raw) {
    const r = resolve(raw);
    const root = document.documentElement;
    root.setAttribute('data-theme', r.mode);
    root.setAttribute('data-style', r.style);
    root.setAttribute('data-glass', r.glass ? '1' : '0');
    Object.keys(CSS_VAR).forEach((k) => {
      root.style.setProperty(CSS_VAR[k], triple(r.tokens[k]));
    });
    root.style.setProperty('--surface-alpha', String(r.alpha));
    // 桌面浮窗（desktop.html）也加载本文件：不透明度走同一个变量，
    // 换风格时底色自然跟着 --panel-rgb 变，不需要另外同步一套
    root.style.setProperty('--dw-alpha', String(r.desktopAlpha));
    root.style.setProperty('--glass', r.glass ? '1' : '0');
    root.style.setProperty('--bd-scrim', String(r.scrim));
    root.style.setProperty('--bd-blur', `${r.blur}px`);
    root.style.setProperty('--bd-scale', r.blur > 0 ? '1.06' : '1');
    root.style.setProperty('--bd-image', r.url ? `url("${r.url}")` : 'none');
    root.style.setProperty('--bd-fit', r.fit === 'repeat' ? 'auto' : r.fit);
    root.style.setProperty('--bd-repeat', r.fit === 'repeat' ? 'repeat' : 'no-repeat');
    const layer = document.getElementById('app-backdrop');
    if (layer) layer.hidden = !r.url;
    return r;
  }

  function cache(raw) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(normalize(raw))); } catch (e) { /* 隐私模式 */ }
  }

  function cached() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  window.KnodoTheme = {
    STYLES,
    ORDER,
    DEFAULTS,
    CACHE_KEY,
    triple,
    rgbOf,
    lumaOf,
    contrastRatio,
    normalize,
    resolveMode,
    resolve,
    mediaUrl,
    paint,
    cache,
    cached,
  };

  // 首帧对齐：module 脚本（js/theme.js）拿到主进程真值后会再 paint 一次，
  // 这里只是让首帧就是对的颜色。**没有缓存也要画** —— 新装用户走的是 DEFAULTS（宣纸），
  // 不画的话首帧会落到 styles.css :root 的静态值上，白闪一下再变暖（用户报过「怎么是白的」）。
  try { paint(cached() || DEFAULTS); } catch (e) { /* 缓存坏了就当没有，反正 theme.js 会补 */ }

  // 侧栏宽度同理：自绘标题栏（.titlebar::before）要靠 --sidebar-width 决定侧栏色段的宽度。
  // 等 sidebar-resize.js（module，defer）跑起来才写就晚了 —— 首帧会按 220px 画一次再跳。
  try {
    const w = parseInt(localStorage.getItem('ui.sidebarWidth'), 10);
    if (w >= 180 && w <= 420) document.documentElement.style.setProperty('--sidebar-width', `${w}px`);
  } catch (e) { /* 隐私模式 / 无缓存：用 CSS 兜底的 220px */ }
})();
