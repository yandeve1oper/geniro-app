import {
  MAX_ARTIFACT_ANSWER_NAME_LENGTH,
  MAX_ARTIFACT_ANSWERS_BYTES,
} from '../chat.types';
import { ARTIFACT_IMAGE_EXTENSIONS } from './artifact-html-images';

/**
 * The window event geniro's frame wrapper fires once it has written the host's
 * theme tokens onto the page — the one signal the runtime below re-themes on.
 */
export const ARTIFACT_THEME_EVENT = 'geniro:theme';

/**
 * The window event the runtime fires when the page saves an answer, carrying the
 * one it changed (`{name, value, seq}`, `value` null when it was forgotten, `seq`
 * counting this page's saves); the frame wrapper hands it to the host, which keeps
 * it for the agent.
 */
export const ARTIFACT_ANSWER_EVENT = 'geniro:answer';

/**
 * The window event the frame wrapper fires with the answers the host keeps for this
 * page (`{values, confirmed}`): as the page opens, after each of this page's own
 * saves lands — `confirmed` then names the `seq` each saved answer reached — and
 * whenever another frame of the page saves one.
 */
export const ARTIFACT_ANSWERS_EVENT = 'geniro:answers';

/**
 * A value naming a picture on the machine that published the page: an absolute
 * path or a `file:` address, the two spellings the store accepts in an `<img src>`.
 */
const LOCAL_PICTURE_PATTERN = `^(?:file:|/(?!/)).*\\.(?:jpeg|${ARTIFACT_IMAGE_EXTENSIONS.join('|')})$`;

/**
 * What every `--geniro-*` token falls back to when no host has supplied it —
 * the light theme's own values.
 *
 * ONE table feeding the runtime's `token()`, the component kit's `var()`
 * fallbacks, the Tailwind bridge and the frame wrapper's base style, so a page
 * drawn before the host's theme message lands (or opened as a file with no host
 * at all) is in one palette. Keyed by the token's name WITHOUT the `--geniro-`
 * prefix.
 *
 * TWIN PARSER: `THEME_TOKENS` in `apps/ui/src/renderer/chats/artifact-theme.ts`
 * names the same tokens and the app token each is read from, and
 * `apps/ui/src/renderer/styles/themes/light.css` holds the values.
 * `artifact-runtime.spec.ts` reads both and fails when this table disagrees.
 */
const FALLBACK: Record<string, string> = {
  fg: '#201f1a',
  muted: '#56534b',
  bg: '#f3f2ec',
  surface: '#fbfaf6',
  subtle: '#e9e7de',
  border: '#dfdcd1',
  primary: '#955e2e',
  'primary-fg': '#ffffff',
  success: '#4b7038',
  warning: '#8a6116',
  danger: '#a8492f',
  'chart-1': '#8e5829',
  'chart-2': '#4b7138',
  'chart-3': '#2e7067',
  'chart-4': '#555095',
  'chart-5': '#894d79',
  font: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  'font-mono':
    "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
  radius: '0.5rem',
};

/** Every token a page may read, without the `--geniro-` prefix. */
export const ARTIFACT_TOKEN_NAMES: readonly string[] = Object.keys(FALLBACK);

/** `var(--geniro-<name>, <fallback>)` — a token as page CSS should read it. */
export function themeVar(name: string): string {
  const fallback = FALLBACK[name];
  if (fallback === undefined) {
    throw new Error(`no fallback for the artifact token --geniro-${name}`);
  }
  return `var(--geniro-${name}, ${fallback})`;
}

/**
 * geniro's own helpers inside an artifact page, run BEFORE the page's script.
 *
 * The page loads its libraries from the CDNs its CSP admits; this is what makes
 * them look like part of the app without the agent restating the palette in
 * every option object. `geniro.chart(el, option)` creates an ECharts chart in
 * the app's theme and follows a theme switch; Chart.js gets the same defaults
 * and series palette the moment its UMD build assigns `window.Chart`; Mermaid
 * diagrams, Lucide icons and highlight.js blocks are themed and drawn on
 * DOMContentLoaded. Every adapter is a no-op when its library is absent, so a
 * page that uses none of them pays for a few kilobytes of dead code.
 *
 * It also repoints what a page's click-to-enlarge reads. The store copies a
 * picture in through its `<img src>` alone, so the same path left in the `href`
 * or `data-*` of the element holding that picture names a file the page's policy
 * refuses. Done here rather than in the store so a page already published is
 * mended too, and the served page does not carry each picture twice.
 *
 * It must not spell the frame's postMessage tags or the frame wrapper's own
 * markers: it also ships in the RAW document a saved file is built from, which
 * carries none of the frame plumbing.
 */
export const ARTIFACT_RUNTIME_SCRIPT = `
(function () {
  if (window.geniro) return;
  var root = document.documentElement;
  var FALLBACK = ${JSON.stringify(FALLBACK)};
  var THEME_EVENT = ${JSON.stringify(ARTIFACT_THEME_EVENT)};

  // Whitespace collapsed: a font stack the host sends keeps its stylesheet's
  // line breaks, and an unnormalized value never equals the same theme read
  // again — which would redraw every diagram on the first theme message.
  function read(style, key) {
    var value = style.getPropertyValue('--geniro-' + key).replace(/\\s+/g, ' ').trim();
    return value || FALLBACK[key] || '';
  }

  function token(name) {
    var key = String(name).replace(/^--/, '').replace(/^geniro-/, '');
    return read(getComputedStyle(root), key);
  }

  function readPalette(style) {
    return [1, 2, 3, 4, 5].map(function (i) {
      return read(style, 'chart-' + i);
    });
  }

  function isDark(bg) {
    var match = /^#([0-9a-f]{6})$/i.exec(bg);
    if (!match) {
      return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    }
    var n = parseInt(match[1], 16);
    return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255) < 128;
  }

  function theme() {
    var style = getComputedStyle(root);
    var bg = read(style, 'bg');
    return {
      fg: read(style, 'fg'),
      muted: read(style, 'muted'),
      bg: bg,
      surface: read(style, 'surface'),
      subtle: read(style, 'subtle'),
      border: read(style, 'border'),
      primary: read(style, 'primary'),
      success: read(style, 'success'),
      warning: read(style, 'warning'),
      danger: read(style, 'danger'),
      palette: readPalette(style),
      font: read(style, 'font'),
      mono: read(style, 'font-mono'),
      radius: read(style, 'radius'),
      dark: isDark(bg)
    };
  }

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else setTimeout(fn, 0);
  }

  function attempt(label, fn) {
    try {
      fn();
    } catch (err) {
      console.warn('geniro: could not theme ' + label, err);
    }
  }

  // A library's UMD build assigns its global the moment it runs, and a page
  // uses it from a body script long before DOMContentLoaded — so anything
  // that must be in place before the page's first call is set up from an
  // accessor on that global rather than on a later event.
  function whenGlobal(name, callback) {
    if (window[name]) {
      callback(window[name]);
      return;
    }
    var held;
    Object.defineProperty(window, name, {
      configurable: true,
      enumerable: true,
      get: function () {
        return held;
      },
      set: function (value) {
        Object.defineProperty(window, name, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: value
        });
        held = value;
        callback(value);
      }
    });
  }

  // ---- ECharts ----
  function echartsTheme(t) {
    var axis = {
      axisLine: { lineStyle: { color: t.border } },
      axisTick: { lineStyle: { color: t.border } },
      axisLabel: { color: t.muted },
      splitLine: { lineStyle: { color: [t.border] } },
      nameTextStyle: { color: t.muted }
    };
    return {
      color: t.palette,
      backgroundColor: 'transparent',
      textStyle: { color: t.fg, fontFamily: t.font },
      title: { textStyle: { color: t.fg }, subtextStyle: { color: t.muted } },
      legend: { textStyle: { color: t.muted }, inactiveColor: t.border, pageTextStyle: { color: t.muted } },
      tooltip: {
        backgroundColor: t.surface,
        borderColor: t.border,
        textStyle: { color: t.fg, fontFamily: t.font }
      },
      categoryAxis: axis,
      valueAxis: axis,
      logAxis: axis,
      timeAxis: axis,
      line: { lineStyle: { width: 2 }, symbolSize: 6 },
      visualMap: { textStyle: { color: t.muted } },
      dataZoom: { textStyle: { color: t.muted } }
    };
  }

  var charts = [];
  function chart(target, option, opts) {
    var echarts = window.echarts;
    if (!echarts || !echarts.init) {
      throw new Error('geniro.chart needs ECharts: load its script tag above the script that calls it');
    }
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) throw new Error('geniro.chart found no element for ' + target);
    var instance = echarts.init(el, echartsTheme(theme()), opts);
    if (option) instance.setOption(option);
    charts.push(instance);
    if (typeof ResizeObserver === 'function') {
      var observer = new ResizeObserver(function () {
        if (instance.isDisposed && instance.isDisposed()) observer.disconnect();
        else instance.resize();
      });
      observer.observe(el);
    }
    return instance;
  }

  // ---- Chart.js ----
  // The colours this runtime last WROTE onto each dataset. A dataset is
  // recoloured on a theme switch only while it still holds them — one the page
  // coloured itself, before or after, is left alone.
  var written = new WeakMap();
  var PER_POINT = /^(pie|doughnut|polarArea)$/;

  function colourDatasets(instance) {
    var style = getComputedStyle(root);
    var palette = readPalette(style);
    var type = instance && instance.config ? instance.config.type : '';
    var sets = (instance && instance.data && instance.data.datasets) || [];
    for (var i = 0; i < sets.length; i++) {
      var ds = sets[i];
      var last = written.get(ds);
      var untouched = ds.backgroundColor === undefined && ds.borderColor === undefined;
      var stillOurs = last && ds.backgroundColor === last.background && ds.borderColor === last.border;
      if (!untouched && !stillOurs) {
        written.delete(ds);
        continue;
      }
      if (PER_POINT.test(type)) {
        var fills = [];
        for (var j = 0; j < (ds.data || []).length; j++) fills.push(palette[j % palette.length]);
        ds.backgroundColor = fills;
        ds.borderColor = read(style, 'surface');
      } else {
        ds.borderColor = palette[i % palette.length];
        ds.backgroundColor = palette[i % palette.length];
      }
      written.set(ds, { background: ds.backgroundColor, border: ds.borderColor });
    }
  }

  function chartJsDefaults(Chart) {
    var t = theme();
    Chart.defaults.color = t.muted;
    Chart.defaults.borderColor = t.border;
    if (Chart.defaults.font) Chart.defaults.font.family = t.font;
  }

  function setupChartJs(Chart) {
    if (!Chart || !Chart.defaults || !Chart.register || Chart.__geniro) return;
    Chart.__geniro = true;
    attempt('Chart.js', function () {
      chartJsDefaults(Chart);
      Chart.register({ id: 'geniroPalette', beforeInit: colourDatasets, beforeUpdate: colourDatasets });
    });
  }
  whenGlobal('Chart', setupChartJs);

  // ---- Mermaid ----
  // mermaid.initialize REPLACES the site config, so the page's own options are
  // recorded and merged under every call this runtime makes — otherwise its
  // securityLevel or flowchart settings would be wiped on the first redraw.
  var mermaidPage = {};
  var mermaidInit = null;

  function adoptMermaid(mermaid) {
    if (!mermaid || !mermaid.initialize || mermaid.__geniro) return;
    mermaid.__geniro = true;
    mermaidInit = mermaid.initialize;
    mermaid.initialize = function (config) {
      mermaidPage = config || {};
      return mermaidInit.call(mermaid, mermaidConfig(theme()));
    };
  }
  whenGlobal('mermaid', adoptMermaid);

  function mermaidConfig(t) {
    var ours = {
      startOnLoad: false,
      theme: 'base',
      fontFamily: t.font,
      themeVariables: {
        darkMode: t.dark,
        fontFamily: t.font,
        background: t.surface,
        primaryColor: t.subtle,
        primaryTextColor: t.fg,
        primaryBorderColor: t.border,
        secondaryColor: t.surface,
        secondaryTextColor: t.fg,
        secondaryBorderColor: t.border,
        tertiaryColor: t.bg,
        tertiaryTextColor: t.fg,
        tertiaryBorderColor: t.border,
        mainBkg: t.subtle,
        nodeBorder: t.border,
        lineColor: t.muted,
        textColor: t.fg,
        titleColor: t.fg,
        clusterBkg: t.bg,
        clusterBorder: t.border,
        edgeLabelBackground: t.surface,
        noteBkgColor: t.surface,
        noteTextColor: t.fg,
        noteBorderColor: t.border
      }
    };
    var config = {};
    var key;
    for (key in ours) config[key] = ours[key];
    for (key in mermaidPage) {
      if (key !== 'themeVariables') config[key] = mermaidPage[key];
    }
    // A page that picked a theme of its own gets that theme's variables, not
    // ours on top of it.
    var base = config.theme === 'base' ? ours.themeVariables : {};
    var variables = {};
    for (key in base) variables[key] = base[key];
    for (key in mermaidPage.themeVariables || {}) variables[key] = mermaidPage.themeVariables[key];
    config.themeVariables = variables;
    return config;
  }

  // Mermaid replaces a diagram's source with its SVG, so the source is kept
  // on the element — as markup, since a label may carry <br> — to draw it
  // again in a new theme.
  function renderMermaid(t) {
    var mermaid = window.mermaid;
    if (!mermaid || !mermaid.run) return;
    adoptMermaid(mermaid);
    if (!mermaidInit) return;
    var nodes = document.querySelectorAll('.mermaid');
    var pending = [];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      // Drawn already, from a source this runtime never saw (the page ran
      // mermaid itself): its markup is SVG now, not a diagram to redraw.
      if (node.hasAttribute('data-processed') && !node.hasAttribute('data-geniro-source')) continue;
      if (node.hasAttribute('data-geniro-source')) {
        node.removeAttribute('data-processed');
        node.innerHTML = node.getAttribute('data-geniro-source');
      } else {
        node.setAttribute('data-geniro-source', node.innerHTML);
      }
      pending.push(node);
    }
    mermaidInit.call(mermaid, mermaidConfig(t));
    if (pending.length === 0) return;
    var run = mermaid.run({ nodes: pending });
    if (run && run.catch) {
      run.catch(function (err) {
        console.warn('geniro: a mermaid diagram could not be drawn', err);
      });
    }
  }

  // ---- Lucide, highlight.js ----
  function icons() {
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  }
  function highlight() {
    if (window.hljs && window.hljs.highlightAll) window.hljs.highlightAll();
  }

  // ---- theme switches ----
  var listeners = [];
  function onTheme(callback) {
    listeners.push(callback);
  }

  var applied = null;
  function retheme() {
    var t = theme();
    var signature = JSON.stringify(t);
    if (signature === applied) return;
    applied = signature;
    for (var i = 0; i < charts.length; i++) {
      var instance = charts[i];
      if (instance.isDisposed && instance.isDisposed()) continue;
      if (instance.setTheme) {
        attempt('a chart', function () {
          instance.setTheme(echartsTheme(t));
        });
      }
    }
    var Chart = window.Chart;
    if (Chart && Chart.__geniro) {
      attempt('Chart.js', function () {
        chartJsDefaults(Chart);
        var all = Chart.instances || {};
        for (var key in all) {
          if (all[key] && all[key].update) all[key].update('none');
        }
      });
    }
    attempt('mermaid', function () {
      renderMermaid(t);
    });
    for (var k = 0; k < listeners.length; k++) {
      var listener = listeners[k];
      attempt('a page listener', function () {
        listener(t);
      });
    }
  }
  window.addEventListener(THEME_EVENT, retheme);

  // An element holding a second picture says nothing about which one its path meant.
  function repointPicturePaths() {
    var localPicture = new RegExp(${JSON.stringify(LOCAL_PICTURE_PATTERN)}, 'i');
    var images = document.querySelectorAll('img[src^="data:"]');
    for (var i = 0; i < images.length; i++) {
      var uri = images[i].getAttribute('src');
      var node = images[i];
      while (node && node.querySelectorAll('img').length <= 1) {
        for (var j = 0; j < node.attributes.length; j++) {
          var attribute = node.attributes[j];
          if (
            (attribute.name === 'href' || attribute.name.indexOf('data-') === 0) &&
            localPicture.test(attribute.value.trim())
          ) {
            attribute.value = uri;
          }
        }
        node = node.parentElement;
      }
    }
  }

  ready(function () {
    applied = JSON.stringify(theme());
    attempt('mermaid', function () {
      renderMermaid(theme());
    });
    attempt('icons', icons);
    attempt('code', highlight);
    attempt('picture paths', repointPicturePaths);
  });

  // ---- Answers ----
  // What the user picks on the page, kept by the app for the agent to read. A
  // control marked data-geniro-answer="<name>" is saved as it changes (a marked
  // button when it is pressed) and put back when the page opens; script saves with
  // geniro.saveAnswer and hears the kept answers through geniro.onAnswers. Each
  // save announces only the answer it changed, so two frames of one page never
  // undo each other's picks. Without a host nothing is kept.
  var ANSWER_EVENT = ${JSON.stringify(ARTIFACT_ANSWER_EVENT)};
  var ANSWERS_EVENT = ${JSON.stringify(ARTIFACT_ANSWERS_EVENT)};
  var MAX_ANSWERS = ${MAX_ARTIFACT_ANSWERS_BYTES};
  var MAX_NAME = ${MAX_ARTIFACT_ANSWER_NAME_LENGTH};
  var answers = {};
  var unconfirmed = {};
  var saves = 0;
  var answersRestored = false;
  var restoring = false;
  var answerListeners = [];

  function copyOf(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function saveAnswer(name, value) {
    var key = String(name);
    if (key === '' || key.length > MAX_NAME || key === '__proto__') {
      console.warn('geniro: an answer needs a name of 1 to ' + MAX_NAME + ' characters');
      return false;
    }
    var next = copyOf(answers);
    var kept = null;
    if (value !== undefined && value !== null) {
      var text;
      try {
        text = JSON.stringify(value);
      } catch (err) {
        console.warn('geniro: an answer must be JSON', err);
        return false;
      }
      if (text === undefined) return false;
      kept = JSON.parse(text);
      next[key] = kept;
    } else {
      delete next[key];
    }
    if (JSON.stringify(next).length > MAX_ANSWERS) {
      console.warn('geniro: the answers are over ' + MAX_ANSWERS + ' characters; not saved');
      return false;
    }
    answers = next;
    saves += 1;
    unconfirmed[key] = { value: kept, seq: saves };
    window.dispatchEvent(new CustomEvent(ANSWER_EVENT, { detail: { name: key, value: kept, seq: saves } }));
    return true;
  }

  function isFormControl(element) {
    return element.tagName === 'INPUT' || element.tagName === 'SELECT' || element.tagName === 'TEXTAREA';
  }

  function controlsNamed(name) {
    var all = document.querySelectorAll('[data-geniro-answer]');
    var found = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute('data-geniro-answer') === name) found.push(all[i]);
    }
    return found;
  }

  function pressedValue(element) {
    var value = element.getAttribute('value');
    return value === null ? (element.textContent || '').trim() : value;
  }

  function readControls(controls) {
    var first = controls[0];
    if (first.type === 'radio') {
      for (var i = 0; i < controls.length; i++) {
        if (controls[i].checked) return controls[i].value;
      }
      return null;
    }
    if (first.type === 'checkbox') {
      if (controls.length === 1) return first.checked;
      var picked = [];
      for (var j = 0; j < controls.length; j++) {
        if (controls[j].checked) picked.push(controls[j].value);
      }
      return picked;
    }
    if (first.tagName === 'SELECT' && first.multiple) {
      var chosen = [];
      for (var k = 0; k < first.options.length; k++) {
        if (first.options[k].selected) chosen.push(first.options[k].value);
      }
      return chosen;
    }
    return first.value;
  }

  function changed(control) {
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Sets each control to the answer, firing input and change only on a control
  // whose state moved — on a radio group, the one that became checked — as the
  // browser does for a user's pick.
  function writeControls(controls, value) {
    for (var i = 0; i < controls.length; i++) {
      var control = controls[i];
      if (!isFormControl(control)) {
        control.setAttribute('aria-pressed', String(value !== undefined && value !== null && pressedValue(control) === value));
      } else if (control.type === 'radio') {
        var checked = control.value === value;
        if (control.checked !== checked) {
          control.checked = checked;
          if (checked) changed(control);
        }
      } else if (control.type === 'checkbox') {
        var ticked = Array.isArray(value) ? value.indexOf(control.value) !== -1 : value === true;
        if (control.checked !== ticked) {
          control.checked = ticked;
          changed(control);
        }
      } else if (control.tagName === 'SELECT' && control.multiple) {
        var picked = Array.isArray(value) ? value : [];
        var moved = false;
        for (var j = 0; j < control.options.length; j++) {
          var selected = picked.indexOf(control.options[j].value) !== -1;
          if (control.options[j].selected !== selected) {
            control.options[j].selected = selected;
            moved = true;
          }
        }
        if (moved) changed(control);
      } else {
        var text = value === undefined || value === null ? '' : String(value);
        if (control.value !== text) {
          control.value = text;
          changed(control);
        }
      }
    }
  }

  function onControl(event) {
    if (restoring) return;
    var control = event.target;
    var name = control && control.getAttribute ? control.getAttribute('data-geniro-answer') : null;
    if (!name || !isFormControl(control)) return;
    var choice = control.type === 'radio' || control.type === 'checkbox' || control.tagName === 'SELECT';
    if (event.type === 'input' && choice) return;
    var controls = controlsNamed(name).filter(isFormControl);
    if (controls.length > 0) saveAnswer(name, readControls(controls));
  }

  // A press counts on a marked button-like element itself, never on a marked
  // container: a row marked as a whole would save its own text, not a pick.
  function onPress(event) {
    var node = event.target;
    var pressed = node && node.closest ? node.closest('button, a, [role="button"]') : null;
    if (!pressed || !pressed.hasAttribute('data-geniro-answer') || event.button !== 0) return;
    var name = pressed.getAttribute('data-geniro-answer');
    var value = pressedValue(pressed);
    if (saveAnswer(name, value)) writeControls(controlsNamed(name), value);
  }

  document.addEventListener('change', onControl, true);
  document.addEventListener('input', onControl, true);
  document.addEventListener('click', onPress, true);

  // The kept answers, from the host as the page opens, after each of this page's
  // saves lands, and whenever another frame of the page saves. A pick this page
  // made that the host has not confirmed yet stays over them; one it confirmed
  // gives way, so a newer pick from another frame shows.
  window.addEventListener(ANSWERS_EVENT, function (event) {
    var detail = event.detail;
    var kept = detail && detail.values;
    if (!kept || typeof kept !== 'object' || Array.isArray(kept)) return;
    var confirmed = detail.confirmed && typeof detail.confirmed === 'object' ? detail.confirmed : {};
    var merged = copyOf(kept);
    for (var key in unconfirmed) {
      if (typeof confirmed[key] === 'number' && confirmed[key] >= unconfirmed[key].seq) {
        delete unconfirmed[key];
      } else if (unconfirmed[key].value === null) {
        delete merged[key];
      } else {
        merged[key] = unconfirmed[key].value;
      }
    }
    var names = {};
    for (var before in answers) names[before] = true;
    for (var after in merged) names[after] = true;
    answers = merged;
    answersRestored = true;
    restoring = true;
    try {
      for (var name in names) {
        var controls = controlsNamed(name);
        if (controls.length > 0) {
          attempt('answer ' + name, function () {
            writeControls(controls, answers[name]);
          });
        }
      }
    } finally {
      restoring = false;
    }
    for (var i = 0; i < answerListeners.length; i++) {
      var listener = answerListeners[i];
      attempt('answers', function () {
        listener(copyOf(answers));
      });
    }
  });

  function onAnswers(callback) {
    answerListeners.push(callback);
    if (answersRestored) {
      setTimeout(function () {
        callback(copyOf(answers));
      }, 0);
    }
  }

  window.geniro = {
    token: token,
    theme: theme,
    palette: function () {
      return readPalette(getComputedStyle(root));
    },
    onTheme: onTheme,
    chart: chart,
    echartsTheme: function () {
      return echartsTheme(theme());
    },
    icons: icons,
    saveAnswer: saveAnswer,
    answers: function () {
      return copyOf(answers);
    },
    onAnswers: onAnswers
  };
})();
`.trim();

/**
 * The component kit: a handful of classes that make a page look like part of
 * the app with no CSS of its own — cards, stat tiles, badges, tables, a kanban
 * board, buttons — plus a highlight.js palette taken from the chart tokens.
 *
 * Every selector is wrapped in `:where()`, which has ZERO specificity, and
 * {@link withArtifactRuntime} puts the whole kit in a cascade layer of its own,
 * so the page's own CSS wins whatever order the two arrive in — and so do
 * Tailwind's utilities, which live in a layer declared after it.
 *
 * The ONE exception is the edge margins inside a kit box (`g-card`,
 * `g-callout`, `g-step-body`, `g-disclosure-body`): those are `!important`, so
 * a page's own `h3 { margin: 24px 0 8px }` cannot push the first heading away
 * from its box's top or its step number — the misalignment a survey of agents'
 * pages found where a heading came first in a padded box. A page opts in to it
 * only by using the class.
 */
export const ARTIFACT_KIT_STYLE = `
:where(.g-card) { background: ${themeVar('surface')}; border: 1px solid ${themeVar('border')}; border-radius: ${themeVar('radius')}; padding: 16px; min-width: 0; }
:where(.g-card-title) { margin: 0 0 12px; font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
:where(.g-muted) { color: ${themeVar('muted')}; }
:where(.g-grid) { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
:where(.g-row) { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
:where(.g-stat) { display: flex; flex-direction: column; gap: 2px; padding: 12px 14px; background: ${themeVar('surface')}; border: 1px solid ${themeVar('border')}; border-radius: ${themeVar('radius')}; min-width: 0; }
:where(.g-stat-label) { font-size: 12px; color: ${themeVar('muted')}; }
:where(.g-stat-value) { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
:where(.g-delta) { font-size: 12px; color: ${themeVar('muted')}; font-variant-numeric: tabular-nums; }
:where(.g-delta-good) { color: ${themeVar('success')}; }
:where(.g-delta-bad) { color: ${themeVar('danger')}; }
:where(.g-badge) { display: inline-flex; align-items: center; gap: 4px; padding: 0 8px; border-radius: 999px; font-size: 11px; font-weight: 500; line-height: 20px; white-space: nowrap; background: ${themeVar('subtle')}; color: ${themeVar('muted')}; }
:where(.g-badge-success) { background: color-mix(in srgb, ${themeVar('success')} 15%, transparent); color: ${themeVar('success')}; }
:where(.g-badge-warning) { background: color-mix(in srgb, ${themeVar('warning')} 15%, transparent); color: ${themeVar('warning')}; }
:where(.g-badge-danger) { background: color-mix(in srgb, ${themeVar('danger')} 15%, transparent); color: ${themeVar('danger')}; }
:where(.g-badge-info) { background: color-mix(in srgb, ${themeVar('primary')} 15%, transparent); color: ${themeVar('primary')}; }
:where(.g-table-wrap) { overflow-x: auto; }
:where(.g-table) { width: 100%; border-collapse: collapse; font-size: 13px; }
:where(.g-table th) { text-align: left; font-size: 12px; font-weight: 500; color: ${themeVar('muted')}; padding: 8px 10px; border-bottom: 1px solid ${themeVar('border')}; white-space: nowrap; }
:where(.g-table td) { padding: 8px 10px; border-bottom: 1px solid ${themeVar('border')}; vertical-align: top; }
:where(.g-table tr:last-child td) { border-bottom: 0; }
:where(.g-num) { text-align: right; font-variant-numeric: tabular-nums; }
:where(.g-kanban) { display: grid; gap: 12px; grid-auto-flow: column; grid-auto-columns: minmax(220px, 1fr); overflow-x: auto; }
:where(.g-kanban-col) { display: flex; flex-direction: column; gap: 8px; padding: 10px; min-width: 0; background: ${themeVar('subtle')}; border-radius: ${themeVar('radius')}; }
:where(.g-kanban-head) { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: ${themeVar('muted')}; }
:where(.g-kanban-list) { display: flex; flex-direction: column; gap: 8px; min-height: 40px; }
:where(.g-kanban-card) { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 10px; font-size: 13px; background: ${themeVar('surface')}; border: 1px solid ${themeVar('border')}; border-radius: calc(${themeVar('radius')} - 2px); cursor: grab; }
:where(.sortable-ghost) { opacity: 0.4; }
:where(.g-callout) { padding: 12px 14px; background: ${themeVar('surface')}; border: 1px solid ${themeVar('border')}; border-left: 3px solid ${themeVar('primary')}; border-radius: ${themeVar('radius')}; min-width: 0; }
:where(.g-callout-success) { border-left-color: ${themeVar('success')}; }
:where(.g-callout-warning) { border-left-color: ${themeVar('warning')}; }
:where(.g-callout-danger) { border-left-color: ${themeVar('danger')}; }
:where(.g-step) { display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 12px; align-items: baseline; }
:where(.g-step + .g-step) { margin-top: 24px; }
:where(.g-step-num) { position: relative; top: -1.5px; display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 999px; background: ${themeVar('primary')}; color: ${themeVar('primary-fg')}; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
:where(.g-step-body) { min-width: 0; }
:where(.g-disclosure) { background: ${themeVar('surface')}; border: 1px solid ${themeVar('border')}; border-radius: ${themeVar('radius')}; min-width: 0; }
:where(.g-disclosure + .g-disclosure) { margin-top: 8px; }
:where(.g-disclosure > summary) { padding: 10px 14px; font-weight: 600; }
:where(.g-disclosure[open] > summary) { border-bottom: 1px solid ${themeVar('border')}; }
:where(.g-disclosure-body) { padding: 12px 14px; }
:where(.g-card, .g-callout, .g-step-body, .g-disclosure-body) > :where(:first-child) { margin-top: 0 !important; }
:where(.g-card, .g-callout, .g-step-body, .g-disclosure-body) > :where(:last-child) { margin-bottom: 0 !important; }
:where(.g-kv) { display: grid; grid-template-columns: fit-content(40%) minmax(0, 1fr); gap: 6px 16px; margin: 0; }
:where(.g-kv dt) { color: ${themeVar('muted')}; font-weight: 400; }
:where(.g-kv dd) { margin: 0; min-width: 0; }
:where(.g-nowrap) { white-space: nowrap; }
:where(.g-btn) { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; font: inherit; font-size: 13px; font-weight: 500; border-radius: calc(${themeVar('radius')} - 2px); border: 1px solid transparent; background: ${themeVar('primary')}; color: ${themeVar('primary-fg')}; cursor: pointer; }
:where(.g-btn-secondary) { background: ${themeVar('surface')}; color: ${themeVar('fg')}; border-color: ${themeVar('border')}; }
:where(.g-btn:focus-visible, .g-kanban-card:focus-visible) { outline: 2px solid ${themeVar('primary')}; outline-offset: 2px; }
:where(svg.lucide) { width: 1em; height: 1em; flex: none; }
:where(code, kbd, pre:not(.mermaid)) { font-family: ${themeVar('font-mono')}; }
:where(:not(pre) > code) { font-size: 0.92em; padding: 1px 4px; border-radius: 4px; background: color-mix(in srgb, ${themeVar('fg')} 10%, transparent); }
:where(pre:not(.mermaid)) { padding: 12px; overflow-x: auto; font-size: 12.5px; line-height: 1.5; background: ${themeVar('subtle')}; border-radius: ${themeVar('radius')}; }
:where(pre.mermaid) { margin: 0; overflow-x: auto; background: transparent; }
:where(.hljs-comment, .hljs-quote) { color: ${themeVar('muted')}; font-style: italic; }
:where(.hljs-keyword, .hljs-selector-tag, .hljs-built_in, .hljs-type) { color: ${themeVar('chart-4')}; }
:where(.hljs-string, .hljs-regexp, .hljs-addition) { color: ${themeVar('chart-2')}; }
:where(.hljs-number, .hljs-literal, .hljs-symbol) { color: ${themeVar('chart-1')}; }
:where(.hljs-title, .hljs-section, .hljs-function) { color: ${themeVar('chart-3')}; }
:where(.hljs-attr, .hljs-attribute, .hljs-variable, .hljs-template-variable) { color: ${themeVar('chart-5')}; }
:where(.hljs-deletion) { color: ${themeVar('danger')}; }
`.trim();

/**
 * The cascade-layer order the kit is placed in. Tailwind v4 declares `theme,
 * base, components, utilities`; stating the whole order FIRST puts the kit
 * above Tailwind's reset and below its utilities, so `class="g-card p-2"` takes
 * the `p-2`. `geniro-base` is the frame wrapper's own floor (body padding, the
 * link colour), BELOW the kit, so `<a class="g-btn">` keeps the button's text
 * colour. `geniro-elements` (how a bare `h2`, `table` or `summary` looks) is
 * the lowest of all, under Tailwind's preflight, so a Tailwind page keeps the
 * reset its utilities assume. Without Tailwind its layers are simply empty, and
 * any CSS the page writes outside a layer outranks all of them.
 *
 * TWIN PARSER: `ARTIFACT_LAYER_ORDER` in
 * `apps/ui/src/renderer/chats/artifact-export.ts` restates this for the saved
 * file, whose theme block comes first; its spec reads this file.
 */
export const ARTIFACT_LAYER_ORDER =
  '@layer geniro-elements, theme, base, geniro-base, geniro, components, utilities;';

/**
 * Tailwind v4's browser build reads every `<style type="text/tailwindcss">` in
 * the document, so this maps the geniro tokens onto utilities (`bg-surface`,
 * `text-muted`, `border-border`, `text-chart-2`, …). The browser itself ignores
 * a style element of that type, so a page that loads no Tailwind pays nothing.
 */
export const ARTIFACT_TAILWIND_THEME = `
@theme inline {
${(
  [
    ['color-fg', 'fg'],
    ['color-muted', 'muted'],
    ['color-bg', 'bg'],
    ['color-surface', 'surface'],
    ['color-subtle', 'subtle'],
    ['color-border', 'border'],
    ['color-primary', 'primary'],
    ['color-primary-fg', 'primary-fg'],
    ['color-success', 'success'],
    ['color-warning', 'warning'],
    ['color-danger', 'danger'],
    ['color-chart-1', 'chart-1'],
    ['color-chart-2', 'chart-2'],
    ['color-chart-3', 'chart-3'],
    ['color-chart-4', 'chart-4'],
    ['color-chart-5', 'chart-5'],
    ['font-sans', 'font'],
    ['font-mono', 'font-mono'],
  ] satisfies [string, string][]
)
  .map(([tailwind, geniro]) => `  --${tailwind}: ${themeVar(geniro)};`)
  .join('\n')}
}
`.trim();

/**
 * Where geniro's runtime block goes: right after the document's own `<head>`
 * tag, ahead of every script the page carries, so `geniro.chart` exists by the
 * time the page's code calls it.
 *
 * The head tag is trusted only when no `<script` or `<style` comes before it
 * and it is not inside a still-open comment — the text `<head>` can also sit
 * inside a script, a stylesheet or a comment, and splicing there would cut that
 * element in two or put the runtime inside the comment.
 */
const HEAD_OPEN = /<head(?:\s[^>]*)?>/i;
const BEFORE_HEAD_HAZARD = /<script|<style/i;
const DOCTYPE = /^\s*(?:<!--[\s\S]*?-->\s*)*<!doctype[^>]*>/i;

/** Whether `text` ends inside an HTML comment it opened and never closed. */
function inOpenComment(text: string): boolean {
  return text.lastIndexOf('<!--') > text.lastIndexOf('-->');
}

/** The agent's document with geniro's runtime, kit and Tailwind bridge in front of it. */
export function withArtifactRuntime(html: string): string {
  return atHeadStart(
    html,
    `<style data-geniro="kit">${ARTIFACT_LAYER_ORDER}\n@layer geniro {\n${ARTIFACT_KIT_STYLE}\n}</style>` +
      `<style type="text/tailwindcss" data-geniro="tailwind">${ARTIFACT_TAILWIND_THEME}</style>` +
      `<script data-geniro="runtime">${ARTIFACT_RUNTIME_SCRIPT}</script>`,
  );
}

/** `block` placed where {@link withArtifactRuntime} places the runtime. */
export function atHeadStart(html: string, block: string): string {
  const head = HEAD_OPEN.exec(html);
  const before = head === null ? '' : html.slice(0, head.index);
  if (
    head !== null &&
    !BEFORE_HEAD_HAZARD.test(before) &&
    !inOpenComment(before)
  ) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}${block}${html.slice(at)}`;
  }
  // After a doctype rather than before it: anything ahead of the doctype puts
  // the page in quirks mode.
  const doctype = DOCTYPE.exec(html);
  if (doctype !== null) {
    const at = doctype[0].length;
    return `${html.slice(0, at)}${block}${html.slice(at)}`;
  }
  return `${block}${html}`;
}
