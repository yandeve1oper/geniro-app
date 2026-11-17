// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_ARTIFACT_ANSWER_NAME_LENGTH,
  MAX_ARTIFACT_ANSWERS_BYTES,
} from '../chat.types';
import {
  ARTIFACT_ANSWER_EVENT,
  ARTIFACT_ANSWERS_EVENT,
  ARTIFACT_KIT_STYLE,
  ARTIFACT_LAYER_ORDER,
  ARTIFACT_RUNTIME_SCRIPT,
  ARTIFACT_TAILWIND_THEME,
  ARTIFACT_THEME_EVENT,
  ARTIFACT_TOKEN_NAMES,
  themeVar,
  withArtifactRuntime,
} from './artifact-runtime';

const RUNTIME_MARK = 'data-geniro="runtime"';

describe('withArtifactRuntime', () => {
  it('puts the runtime right after <head>, attributes and all, ahead of the page’s own script', () => {
    const html =
      '<!doctype html><html><head lang="en"><title>t</title><script src="https://cdnjs.cloudflare.com/x.js"></script></head><body><script>geniro.chart("#a", {})</script></body></html>';
    const out = withArtifactRuntime(html);

    expect(out).toContain('<head lang="en"><style data-geniro="kit">');
    expect(out.indexOf(RUNTIME_MARK)).toBeLessThan(out.indexOf('<title>'));
    expect(out.indexOf(RUNTIME_MARK)).toBeLessThan(out.indexOf('cdnjs'));
  });

  it.each([
    ['a bare doctype', '<!DOCTYPE html>\n<p>x</p>'],
    ['a doctype a comment precedes', '<!-- plan -->\n<!DOCTYPE html><p>x</p>'],
  ])(
    'goes after %s rather than before it, which would mean quirks mode',
    (_, html) => {
      const out = withArtifactRuntime(html);
      expect(out.indexOf(RUNTIME_MARK)).toBeGreaterThan(
        out.indexOf('<!DOCTYPE html>'),
      );
    },
  );

  it('leads a bare fragment, which is what a model usually sends', () => {
    const out = withArtifactRuntime(
      '<h1>Plan</h1><script>geniro.chart("#a", {})</script>',
    );
    expect(out.indexOf(RUNTIME_MARK)).toBeLessThan(out.indexOf('<h1>'));
  });

  it('does not splice into a script that merely CONTAINS the text <head>', () => {
    // A fragment with no head of its own can still carry the tag's text in a
    // string literal; splicing there would cut that script in two.
    const html = '<script>var t = "<head>";</script><p>x</p>';
    const out = withArtifactRuntime(html);
    expect(out).toContain('var t = "<head>";');
    expect(out.indexOf(RUNTIME_MARK)).toBeLessThan(out.indexOf('var t'));
  });

  it('does not splice into a COMMENT that mentions <head> before the real one', () => {
    // A runtime spliced inside `<!-- … -->` is commented out, and the page's
    // first `geniro.chart` call throws.
    const html =
      '<!doctype html><!-- layout: <head> then <body> --><html><head><title>t</title></head><body><script>geniro.chart("#a", {})</script></body></html>';
    const out = withArtifactRuntime(html);
    const parsed = new DOMParser().parseFromString(out, 'text/html');
    expect(
      parsed.querySelector('script[data-geniro="runtime"]'),
    ).not.toBeNull();
  });

  it('does not splice into a STYLESHEET that mentions <head> before the real one', () => {
    const html =
      '<style>/* <head> */ p { color: red }</style><head></head><p>x</p>';
    const out = withArtifactRuntime(html);
    expect(out).toContain('/* <head> */ p { color: red }');
    expect(out.indexOf(RUNTIME_MARK)).toBeLessThan(out.indexOf('<style>/*'));
  });

  it('still splices after <head> when a CLOSED comment comes first', () => {
    // A leading comment is not a hazard once it ends; only a <head> inside an
    // open one is.
    const out = withArtifactRuntime(
      '<!-- plan --><!DOCTYPE html><html><head><title>t</title></head></html>',
    );
    expect(out.indexOf(RUNTIME_MARK)).toBeGreaterThan(out.indexOf('<head>'));
  });

  it('does not read <header> as a head tag', () => {
    const out = withArtifactRuntime('<header>x</header>');
    expect(out.indexOf(RUNTIME_MARK)).toBeLessThan(out.indexOf('<header>'));
  });
});

describe('the component kit', () => {
  it('has ZERO specificity, so every rule the page writes wins', () => {
    // A kit rule outside `:where()` would beat the page's own class rule of
    // equal specificity whenever it came later in the document.
    const rules = ARTIFACT_KIT_STYLE.split('\n').filter((line) => line.trim());
    expect(rules.length).toBeGreaterThan(10);
    for (const rule of rules) {
      expect(rule, rule).toMatch(/^:where\([^{]*\) \{/);
    }
  });

  it('gives every token it reads a fallback, so a hostless page still reads', () => {
    for (const css of [ARTIFACT_KIT_STYLE, ARTIFACT_TAILWIND_THEME]) {
      expect(css).not.toMatch(/var\(--geniro-[a-z0-9-]+\)/);
      expect(css).not.toContain('undefined');
    }
  });

  it('sits in a layer ABOVE Tailwind’s reset and BELOW its utilities', () => {
    // Unlayered, the kit outranks every Tailwind utility: `class="g-card p-2"`
    // would keep the kit's 16px.
    const out = withArtifactRuntime('<head></head>');
    const kit = /<style data-geniro="kit">([\s\S]*?)<\/style>/.exec(out)![1]!;
    expect(kit.startsWith(ARTIFACT_LAYER_ORDER)).toBe(true);
    expect(ARTIFACT_LAYER_ORDER).toMatch(
      /base, geniro-base, geniro, components, utilities/,
    );
    expect(kit).toContain(`@layer geniro {\n${ARTIFACT_KIT_STYLE}\n}`);
  });

  it('holds only the edge margins inside its boxes against the page, nothing else', () => {
    // A page's `h3 { margin: 24px 0 8px }` otherwise pushed a step's heading
    // a line below its number; every other kit value stays the page's to beat.
    const important = ARTIFACT_KIT_STYLE.split('\n').filter((line) =>
      line.includes('!important'),
    );
    expect(important).toEqual([
      ':where(.g-card, .g-callout, .g-step-body, .g-disclosure-body) > :where(:first-child) { margin-top: 0 !important; }',
      ':where(.g-card, .g-callout, .g-step-body, .g-disclosure-body) > :where(:last-child) { margin-bottom: 0 !important; }',
    ]);
  });

  it('falls back to exactly the light theme’s value of the token each name maps to', () => {
    // A TWIN of the renderer's THEME_TOKENS and of light.css: a token renamed
    // or recoloured there would otherwise leave a hostless page on stale values.
    const ui = join(__dirname, '../../../../../ui/src/renderer');
    const mapping = readFileSync(join(ui, 'chats/artifact-theme.ts'), 'utf8');
    const light = readFileSync(join(ui, 'styles/themes/light.css'), 'utf8');
    const pairs = [
      ...mapping.matchAll(/'--geniro-([a-z0-9-]+)': '(--[a-z0-9-]+)'/g),
    ];
    expect(pairs).toHaveLength(ARTIFACT_TOKEN_NAMES.length);
    for (const [, name, source] of pairs) {
      const declared = new RegExp(`^\\s*${source}:\\s*([^;]+);`, 'm').exec(
        light,
      );
      expect(declared, `${source} not in light.css`).not.toBeNull();
      const value = declared![1]!.replace(/\s+/g, ' ').trim();
      expect(themeVar(name!)).toBe(`var(--geniro-${name}, ${value})`);
    }
  });

  it('maps the tokens onto Tailwind utilities', () => {
    expect(ARTIFACT_TAILWIND_THEME).toContain(
      '--color-surface: var(--geniro-surface,',
    );
    expect(ARTIFACT_TAILWIND_THEME).toContain(
      '--color-chart-3: var(--geniro-chart-3,',
    );
  });
});

/**
 * The runtime, RUN rather than read: each test executes the exact script a
 * page carries against libraries stubbed on `window`.
 */
describe('the page runtime', () => {
  type Win = Window & Record<string, unknown>;
  const win = window as unknown as Win;
  const GLOBALS = [
    'geniro',
    'echarts',
    'Chart',
    'mermaid',
    'lucide',
    'hljs',
    'ResizeObserver',
  ];

  const run = (): void => {
    new Function(ARTIFACT_RUNTIME_SCRIPT)();
  };
  const flush = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));
  const geniro = (): {
    token: (name: string) => string;
    palette: () => string[];
    chart: (target: unknown, option?: unknown) => unknown;
    onTheme: (cb: (theme: { fg: string }) => void) => void;
  } => win.geniro as never;
  const retheme = (): void => {
    window.dispatchEvent(new Event(ARTIFACT_THEME_EVENT));
  };

  let listeners: [string, EventListenerOrEventListenerObject][];
  let documentListeners: [
    string,
    EventListenerOrEventListenerObject,
    boolean,
  ][];
  beforeEach(() => {
    listeners = [];
    documentListeners = [];
    const add = window.addEventListener.bind(window);
    vi.spyOn(window, 'addEventListener').mockImplementation(((
      type: string,
      handler: EventListenerOrEventListenerObject,
    ) => {
      listeners.push([type, handler]);
      add(type, handler);
    }) as typeof window.addEventListener);
    const addToDocument = document.addEventListener.bind(document);
    vi.spyOn(document, 'addEventListener').mockImplementation(((
      type: string,
      handler: EventListenerOrEventListenerObject,
      capture?: boolean,
    ) => {
      documentListeners.push([type, handler, capture === true]);
      addToDocument(type, handler, capture);
    }) as typeof document.addEventListener);
  });

  afterEach(async () => {
    // The runtime's DOMContentLoaded work is queued on a timer; drained here so
    // it cannot fire inside the next test against that test's stubs.
    await flush();
    vi.restoreAllMocks();
    for (const [type, handler] of listeners) {
      window.removeEventListener(type, handler);
    }
    for (const [type, handler, capture] of documentListeners) {
      document.removeEventListener(type, handler, capture);
    }
    for (const name of GLOBALS) {
      Reflect.deleteProperty(win, name);
    }
    document.documentElement.removeAttribute('style');
    document.body.innerHTML = '';
  });

  it('reads a token the host sent, and the light value when none was sent', () => {
    run();
    expect(geniro().token('fg')).toBe('#201f1a');
    document.documentElement.style.setProperty('--geniro-fg', 'sentinel-fg');
    expect(geniro().token('fg')).toBe('sentinel-fg');
    expect(geniro().token('--geniro-fg')).toBe('sentinel-fg');
  });

  it('reads a multi-line token as one line, the way the fallback is written', () => {
    // The host sends a font stack with its stylesheet's line breaks; read
    // verbatim it would never equal the same theme read again.
    run();
    document.documentElement.style.setProperty(
      '--geniro-font',
      'ui-sans-serif,\n    system-ui',
    );
    expect(geniro().token('font')).toBe('ui-sans-serif, system-ui');
  });

  it('does not replace a `geniro` the page defined for itself', () => {
    win.geniro = { mine: true };
    run();
    expect(win.geniro).toEqual({ mine: true });
  });

  describe('answers', () => {
    interface Answers {
      saveAnswer: (name: string, value: unknown) => boolean;
      answers: () => Record<string, unknown>;
      onAnswers: (cb: (answers: Record<string, unknown>) => void) => void;
    }
    const api = (): Answers => win.geniro as never;
    let announced: Record<string, unknown>[];
    const hear = (event: Event): void => {
      announced.push((event as CustomEvent<Record<string, unknown>>).detail);
    };
    const restore = (
      values: Record<string, unknown>,
      confirmed: Record<string, number> | null = null,
    ): void => {
      window.dispatchEvent(
        new CustomEvent(ARTIFACT_ANSWERS_EVENT, {
          detail: { values, confirmed },
        }),
      );
    };
    const changed = (element: Element | null, type = 'change'): void => {
      element?.dispatchEvent(new Event(type, { bubbles: true }));
    };

    beforeEach(() => {
      announced = [];
      window.addEventListener(ARTIFACT_ANSWER_EVENT, hear);
    });

    it('announces each answer it saves on its own, and forgets one saved as null', () => {
      run();

      expect(api().saveAnswer('call-1', 'agree')).toBe(true);
      expect(api().saveAnswer('note', { why: 'cheaper' })).toBe(true);
      api().saveAnswer('call-1', null);

      expect(announced).toEqual([
        { name: 'call-1', value: 'agree', seq: 1 },
        { name: 'note', value: { why: 'cheaper' }, seq: 2 },
        { name: 'call-1', value: null, seq: 3 },
      ]);
      expect(api().answers()).toEqual({ note: { why: 'cheaper' } });
    });

    it('refuses an answer that is not JSON, or one that takes the answers past their limit, and announces nothing', () => {
      run();
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      expect(api().saveAnswer('n', 10n)).toBe(false);
      expect(
        api().saveAnswer('long', 'x'.repeat(MAX_ARTIFACT_ANSWERS_BYTES)),
      ).toBe(false);
      expect(api().saveAnswer('', 'x')).toBe(false);
      expect(
        api().saveAnswer('n'.repeat(MAX_ARTIFACT_ANSWER_NAME_LENGTH + 1), 'x'),
      ).toBe(false);
      expect(api().saveAnswer('__proto__', 'x')).toBe(false);

      expect(announced).toEqual([]);
      expect(api().answers()).toEqual({});
    });

    it('saves a marked control as the user changes it: a radio group by its choice, checkboxes as a list, one checkbox as true or false, a select and a text field by value', () => {
      document.body.innerHTML = `
        <input type="radio" name="c1" value="agree" data-geniro-answer="call-1">
        <input type="radio" name="c1" value="disagree" data-geniro-answer="call-1" id="no">
        <input type="checkbox" value="a" data-geniro-answer="picks" id="pa">
        <input type="checkbox" value="b" data-geniro-answer="picks" id="pb">
        <input type="checkbox" data-geniro-answer="ok" id="ok">
        <select data-geniro-answer="size" id="size"><option value="s">S</option><option value="m">M</option></select>
        <select multiple data-geniro-answer="tags" id="tags"><option value="x">X</option><option value="y">Y</option></select>
        <textarea data-geniro-answer="why" id="why"></textarea>`;
      run();

      const no = document.getElementById('no') as HTMLInputElement;
      no.checked = true;
      changed(no);
      (document.getElementById('pb') as HTMLInputElement).checked = true;
      changed(document.getElementById('pb'));
      (document.getElementById('ok') as HTMLInputElement).checked = true;
      changed(document.getElementById('ok'));
      (document.getElementById('size') as HTMLSelectElement).value = 'm';
      changed(document.getElementById('size'));
      const tags = document.getElementById('tags') as HTMLSelectElement;
      tags.options[1]!.selected = true;
      changed(tags);
      (document.getElementById('why') as HTMLTextAreaElement).value =
        'too slow';
      changed(document.getElementById('why'), 'input');

      expect(api().answers()).toEqual({
        'call-1': 'disagree',
        picks: ['b'],
        ok: true,
        size: 'm',
        tags: ['y'],
        why: 'too slow',
      });
    });

    it('saves a marked button by its value when pressed, and marks it pressed among its group', () => {
      document.body.innerHTML = `
        <button value="agree" data-geniro-answer="row-1" id="yes">Agree</button>
        <button value="disagree" data-geniro-answer="row-1" id="no">Disagree</button>
        <button data-geniro-answer="row-2" id="text">Skip</button>`;
      run();

      (document.getElementById('no') as HTMLButtonElement).click();
      (document.getElementById('text') as HTMLButtonElement).click();

      expect(announced).toEqual([
        { name: 'row-1', value: 'disagree', seq: 1 },
        { name: 'row-2', value: 'Skip', seq: 2 },
      ]);
      expect(document.getElementById('no')!.getAttribute('aria-pressed')).toBe(
        'true',
      );
      expect(document.getElementById('yes')!.getAttribute('aria-pressed')).toBe(
        'false',
      );
    });

    it('saves nothing for a click inside a marked container that is not itself a button', () => {
      document.body.innerHTML = `
        <div data-geniro-answer="row-1"><span>Call 1</span>
          <button value="agree" id="yes">Agree</button></div>`;
      run();

      (document.getElementById('yes') as HTMLButtonElement).click();

      expect(announced).toEqual([]);
    });

    it('lets its own pick give way, once the host confirms it, to a newer one another frame saved', () => {
      document.body.innerHTML = `<input data-geniro-answer="why" id="why">`;
      run();
      restore({});
      api().saveAnswer('why', 'mine');

      restore({ why: 'mine' }, { why: 1 });
      restore({ why: 'theirs' });

      expect((document.getElementById('why') as HTMLInputElement).value).toBe(
        'theirs',
      );
      expect(api().answers()).toEqual({ why: 'theirs' });
    });

    it('keeps a pick the host has not confirmed yet over a set another frame saved', () => {
      document.body.innerHTML = `<input data-geniro-answer="why" id="why">`;
      run();
      restore({});
      api().saveAnswer('why', 'first');
      api().saveAnswer('why', 'second');

      restore({ why: 'first' }, { why: 1 });

      expect(api().answers()).toEqual({ why: 'second' });
    });

    it('keeps a pick made before the kept answers arrive, over them, and does not save it again', () => {
      document.body.innerHTML = `
        <input type="radio" name="c2" value="agree" data-geniro-answer="call-2" id="c2yes">
        <input type="radio" name="c2" value="disagree" data-geniro-answer="call-2">`;
      run();

      api().saveAnswer('call-1', 'disagree');
      api().saveAnswer('note', null);
      restore({ 'call-1': 'agree', 'call-2': 'agree', note: 'old' });

      expect(api().answers()).toEqual({
        'call-1': 'disagree',
        'call-2': 'agree',
      });
      expect(announced).toHaveLength(2);
      expect(
        (document.getElementById('c2yes') as HTMLInputElement).checked,
      ).toBe(true);
    });

    it('restores the kept answers into every kind of marked control and to its listeners, without saving them again', async () => {
      document.body.innerHTML = `
        <input type="radio" name="c1" value="agree" data-geniro-answer="call-1" id="yes">
        <input type="radio" name="c1" value="disagree" data-geniro-answer="call-1">
        <input type="checkbox" value="a" data-geniro-answer="picks" id="pa">
        <input type="checkbox" value="b" data-geniro-answer="picks" id="pb">
        <select multiple data-geniro-answer="tags" id="tags"><option value="x">X</option><option value="y">Y</option></select>
        <button value="later" data-geniro-answer="row-1" id="later">Later</button>
        <input data-geniro-answer="why" id="why">`;
      run();
      const early: Record<string, unknown>[] = [];
      api().onAnswers((answers) => early.push(answers));

      const values = {
        'call-1': 'agree',
        picks: ['b'],
        tags: ['x'],
        'row-1': 'later',
        why: 'fine',
      };
      restore(values);
      const late: Record<string, unknown>[] = [];
      api().onAnswers((answers) => late.push(answers));
      await flush();

      const tags = document.getElementById('tags') as HTMLSelectElement;
      expect((document.getElementById('yes') as HTMLInputElement).checked).toBe(
        true,
      );
      expect((document.getElementById('pa') as HTMLInputElement).checked).toBe(
        false,
      );
      expect((document.getElementById('pb') as HTMLInputElement).checked).toBe(
        true,
      );
      expect([tags.options[0]!.selected, tags.options[1]!.selected]).toEqual([
        true,
        false,
      ]);
      expect(
        document.getElementById('later')!.getAttribute('aria-pressed'),
      ).toBe('true');
      expect((document.getElementById('why') as HTMLInputElement).value).toBe(
        'fine',
      );
      expect(early).toEqual([values]);
      expect(late).toEqual([values]);
      expect(announced).toEqual([]);
    });

    it('fires change on a restored radio group only on the one that became checked, as the browser does', () => {
      document.body.innerHTML = `
        <input type="radio" name="c1" value="agree" data-geniro-answer="call-1" id="yes">
        <input type="radio" name="c1" value="disagree" data-geniro-answer="call-1" id="no">`;
      run();
      const heard: string[] = [];
      document.body.addEventListener('change', (event) => {
        heard.push((event.target as HTMLInputElement).value);
      });

      restore({ 'call-1': 'agree' });

      expect(heard).toEqual(['agree']);
    });

    it('takes a later set from another frame of the page in place of its own', () => {
      document.body.innerHTML = `<input data-geniro-answer="why" id="why">`;
      run();
      restore({ why: 'first' });

      restore({});

      expect((document.getElementById('why') as HTMLInputElement).value).toBe(
        '',
      );
      expect(api().answers()).toEqual({});
    });
  });

  describe('geniro.chart (ECharts)', () => {
    const fakeEcharts = () => {
      const instance = {
        setOption: vi.fn(),
        setTheme: vi.fn(),
        resize: vi.fn(),
        isDisposed: () => false,
      };
      const init = vi.fn(() => instance);
      win.echarts = { init };
      return { init, instance };
    };

    it('creates the chart in the app’s palette and hands it the option', () => {
      const { init, instance } = fakeEcharts();
      document.documentElement.style.setProperty(
        '--geniro-chart-1',
        'sentinel-1',
      );
      document.body.innerHTML = '<div id="c"></div>';
      run();

      const option = { series: [] };
      expect(geniro().chart('#c', option)).toBe(instance);

      const [el, theme] = init.mock.calls[0] as unknown as [
        Element,
        { color: string[]; backgroundColor: string },
      ];
      expect(el.id).toBe('c');
      expect(theme.color[0]).toBe('sentinel-1');
      expect(theme.color).toHaveLength(5);
      expect(theme.backgroundColor).toBe('transparent');
      expect(instance.setOption).toHaveBeenCalledWith(option);
    });

    it('re-themes the chart when the host’s theme changes, and only then', async () => {
      const { instance } = fakeEcharts();
      document.body.innerHTML = '<div id="c"></div>';
      run();
      geniro().chart('#c', {});
      await flush();

      retheme();
      expect(instance.setTheme).not.toHaveBeenCalled();

      document.documentElement.style.setProperty(
        '--geniro-chart-1',
        'sentinel-dark',
      );
      retheme();
      expect(instance.setTheme).toHaveBeenCalledTimes(1);
      const [theme] = instance.setTheme.mock.calls[0] as unknown as [
        { color: string[] },
      ];
      expect(theme.color[0]).toBe('sentinel-dark');
    });

    it('says what is missing when ECharts was never loaded', () => {
      document.body.innerHTML = '<div id="c"></div>';
      run();
      expect(() => geniro().chart('#c', {})).toThrow(/ECharts/);
    });

    it('says so when the target matches nothing', () => {
      fakeEcharts();
      run();
      expect(() => geniro().chart('#nowhere', {})).toThrow(/#nowhere/);
    });

    it('resizes with its element, and lets go of it once the chart is disposed', () => {
      let onResize: () => void = () => undefined;
      const disconnect = vi.fn();
      (win as Record<string, unknown>).ResizeObserver = class {
        constructor(callback: () => void) {
          onResize = callback;
        }
        observe(): void {}
        disconnect = disconnect;
      };
      const { instance } = fakeEcharts();
      let disposed = false;
      instance.isDisposed = () => disposed;
      document.body.innerHTML = '<div id="c"></div>';
      run();
      geniro().chart('#c', {});

      onResize();
      expect(instance.resize).toHaveBeenCalledTimes(1);

      disposed = true;
      onResize();
      expect(instance.resize).toHaveBeenCalledTimes(1);
      expect(disconnect).toHaveBeenCalledTimes(1);
    });

    it('does not re-theme a chart the page disposed', () => {
      const { instance } = fakeEcharts();
      document.body.innerHTML = '<div id="c"></div>';
      run();
      geniro().chart('#c', {});
      instance.isDisposed = () => true;

      document.documentElement.style.setProperty(
        '--geniro-chart-1',
        'sentinel-dark',
      );
      retheme();

      expect(instance.setTheme).not.toHaveBeenCalled();
    });
  });

  describe('Chart.js', () => {
    const fakeChart = () => ({
      defaults: {
        color: 'default',
        borderColor: 'default',
        font: { family: 'default' },
      },
      register: vi.fn(),
      instances: {} as Record<string, { update: (mode: string) => void }>,
    });
    type Plugin = {
      beforeInit: (chart: unknown) => void;
      beforeUpdate: (chart: unknown) => void;
    };

    it('recolours what it coloured when the theme changes, never what the page coloured', () => {
      document.documentElement.style.setProperty('--geniro-chart-1', 'light-1');
      document.documentElement.style.setProperty('--geniro-chart-2', 'light-2');
      run();
      const Chart = fakeChart();
      win.Chart = Chart;
      const plugin = Chart.register.mock.calls[0]![0] as Plugin;
      const ours: Record<string, unknown> = { data: [1] };
      const later: Record<string, unknown> = { data: [2] };
      const chart = {
        config: { type: 'bar' },
        data: { datasets: [ours, later] },
      };
      plugin.beforeInit(chart);
      // The page highlights a series itself after the chart exists.
      later.backgroundColor = 'page-highlight';

      document.documentElement.style.setProperty('--geniro-chart-1', 'dark-1');
      document.documentElement.style.setProperty('--geniro-chart-2', 'dark-2');
      plugin.beforeUpdate(chart);

      expect(ours.backgroundColor).toBe('dark-1');
      expect(later.backgroundColor).toBe('page-highlight');
    });

    it('takes the app’s defaults the moment the library assigns its global', () => {
      // A page builds its chart in a body script, before DOMContentLoaded —
      // the defaults have to be in place by then.
      document.documentElement.style.setProperty(
        '--geniro-muted',
        'sentinel-muted',
      );
      run();
      const Chart = fakeChart();
      win.Chart = Chart;

      expect(win.Chart).toBe(Chart);
      expect(Chart.defaults.color).toBe('sentinel-muted');
      expect(Chart.register).toHaveBeenCalledTimes(1);
    });

    it('colours the datasets the page left uncoloured, and only those', () => {
      document.documentElement.style.setProperty(
        '--geniro-chart-1',
        'sentinel-1',
      );
      document.documentElement.style.setProperty(
        '--geniro-chart-2',
        'sentinel-2',
      );
      run();
      const Chart = fakeChart();
      win.Chart = Chart;
      const plugin = Chart.register.mock.calls[0]![0] as Plugin;

      const mine = { data: [1], borderColor: 'page-own' };
      const blank: Record<string, unknown> = { data: [1] };
      const third: Record<string, unknown> = { data: [2] };
      plugin.beforeInit({
        config: { type: 'line' },
        data: { datasets: [blank, mine, third] },
      });

      // The colour follows the dataset's POSITION, so a series keeps its colour
      // whichever of its neighbours the page coloured itself.
      expect(blank.borderColor).toBe('sentinel-1');
      expect(mine.borderColor).toBe('page-own');
      expect(third.borderColor).toBe('#2e7067');
    });

    it('gives a pie one colour per slice', () => {
      document.documentElement.style.setProperty(
        '--geniro-chart-2',
        'sentinel-2',
      );
      run();
      const Chart = fakeChart();
      win.Chart = Chart;
      const plugin = Chart.register.mock.calls[0]![0] as Plugin;

      const slices: Record<string, unknown> = { data: [3, 2, 1] };
      plugin.beforeInit({
        config: { type: 'doughnut' },
        data: { datasets: [slices] },
      });

      expect(slices.backgroundColor).toEqual([
        '#8e5829',
        'sentinel-2',
        '#2e7067',
      ]);
    });

    it('updates every chart when the theme changes', () => {
      run();
      const Chart = fakeChart();
      win.Chart = Chart;
      const update = vi.fn();
      Chart.instances = { 0: { update } };

      document.documentElement.style.setProperty(
        '--geniro-muted',
        'sentinel-dark',
      );
      retheme();

      expect(Chart.defaults.color).toBe('sentinel-dark');
      expect(update).toHaveBeenCalledWith('none');
    });
  });

  describe('Mermaid', () => {
    type MermaidConfig = {
      startOnLoad: boolean;
      theme: string;
      securityLevel?: string;
      themeVariables: { textColor?: string; darkMode?: boolean };
    };
    const fakeMermaid = () => {
      // Held apart from the object: the runtime wraps `initialize` to keep the
      // page's own options, and these record what reaches the library.
      const initialize = vi.fn();
      const run = vi.fn(() => Promise.resolve());
      win.mermaid = { initialize, run };
      return { initialize, run };
    };
    const lastConfig = (initialize: ReturnType<typeof vi.fn>): MermaidConfig =>
      initialize.mock.calls.at(-1)![0] as MermaidConfig;

    it('draws the page’s diagrams in the app’s theme once the page is loaded', async () => {
      const { initialize, run: draw } = fakeMermaid();
      document.body.innerHTML =
        '<pre class="mermaid">flowchart LR\n A --> B</pre>';
      run();
      await flush();

      const config = lastConfig(initialize);
      expect(config.startOnLoad).toBe(false);
      expect(config.theme).toBe('base');
      expect(config.themeVariables.textColor).toBe('#201f1a');
      expect(config.themeVariables.darkMode).toBe(false);
      const [arg] = draw.mock.calls[0] as unknown as [{ nodes: Element[] }];
      expect(arg.nodes).toHaveLength(1);
    });

    it('tells Mermaid the ground is dark when the host’s theme is', async () => {
      const { initialize } = fakeMermaid();
      document.documentElement.style.setProperty('--geniro-bg', '#141312');
      document.body.innerHTML = '<pre class="mermaid">flowchart LR\n A</pre>';
      run();
      await flush();
      expect(lastConfig(initialize).themeVariables.darkMode).toBe(true);
    });

    it('asks the OS whether it is dark when the ground is not a hex colour', async () => {
      // A host token like `oklch(…)` has no luminance this runtime can read,
      // so the ground's darkness falls back to the media query.
      const { initialize } = fakeMermaid();
      const matchMedia = vi.fn(() => ({ matches: true }));
      win.matchMedia = matchMedia as never;
      document.documentElement.style.setProperty('--geniro-bg', 'sentinel-bg');
      document.body.innerHTML = '<pre class="mermaid">flowchart LR\n A</pre>';
      run();
      await flush();
      expect(matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
      expect(lastConfig(initialize).themeVariables.darkMode).toBe(true);
      Reflect.deleteProperty(win, 'matchMedia');
    });

    it('logs a diagram Mermaid could not draw instead of leaving the rejection unhandled', async () => {
      const { run: draw } = fakeMermaid();
      const failure = new Error('Parse error on line 1');
      draw.mockImplementation(() => Promise.reject(failure));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      document.body.innerHTML = '<pre class="mermaid">not a diagram</pre>';
      run();
      await flush();
      await flush();
      expect(warn).toHaveBeenCalledWith(
        'geniro: a mermaid diagram could not be drawn',
        failure,
      );
    });

    it('draws a diagram again from its SOURCE when the theme changes, markup included', async () => {
      const { run: draw } = fakeMermaid();
      document.body.innerHTML =
        '<pre class="mermaid">flowchart LR\n A["one<br>two"] --> B</pre>';
      run();
      await flush();
      const node = document.querySelector('.mermaid')!;
      const source = node.innerHTML;
      // What mermaid itself does to a drawn diagram.
      node.innerHTML = '<svg></svg>';
      node.setAttribute('data-processed', 'true');

      document.documentElement.style.setProperty('--geniro-fg', 'sentinel-fg');
      retheme();

      // The label's <br> survives: a textContent copy would have drawn "onetwo".
      expect(node.innerHTML).toBe(source);
      expect(node.innerHTML).toContain('<br>');
      expect(node.hasAttribute('data-processed')).toBe(false);
      expect(draw).toHaveBeenCalledTimes(2);
    });

    it('keeps the page’s own Mermaid options under the theme', async () => {
      const { initialize } = fakeMermaid();
      document.body.innerHTML = '<pre class="mermaid">flowchart LR\n A</pre>';
      run();
      // The page's own body script, after the library loaded.
      (win.mermaid as { initialize: (c: unknown) => void }).initialize({
        securityLevel: 'loose',
      });
      await flush();

      const config = lastConfig(initialize);
      expect(config.securityLevel).toBe('loose');
      expect(config.theme).toBe('base');
    });

    it('gives a page that picked its own Mermaid theme that theme, and its own variables', async () => {
      const { initialize } = fakeMermaid();
      document.body.innerHTML = '<pre class="mermaid">flowchart LR\n A</pre>';
      run();
      (win.mermaid as { initialize: (c: unknown) => void }).initialize({
        theme: 'dark',
        themeVariables: { textColor: 'page-text' },
      });
      await flush();

      const config = lastConfig(initialize) as MermaidConfig & {
        themeVariables: Record<string, unknown>;
      };
      expect(config.theme).toBe('dark');
      expect(config.themeVariables.textColor).toBe('page-text');
      expect(config.themeVariables.primaryColor).toBeUndefined();
    });

    it('leaves a diagram the page drew itself alone rather than redraw its SVG', async () => {
      const { run: draw } = fakeMermaid();
      document.body.innerHTML =
        '<pre class="mermaid" data-processed="true"><svg></svg></pre>';
      run();
      await flush();

      const node = document.querySelector('.mermaid')!;
      expect(node.hasAttribute('data-geniro-source')).toBe(false);
      expect(draw).not.toHaveBeenCalled();
    });
  });

  it('turns Lucide placeholders into icons and highlights code once loaded', async () => {
    const createIcons = vi.fn();
    const highlightAll = vi.fn();
    win.lucide = { createIcons };
    win.hljs = { highlightAll };
    run();
    await flush();
    expect(createIcons).toHaveBeenCalledTimes(1);
    expect(highlightAll).toHaveBeenCalledTimes(1);
  });

  describe('a local path beside a copied picture', () => {
    const URI = 'data:image/png;base64,AAAA';
    const OTHER = 'data:image/png;base64,BBBB';
    const shown = async (html: string): Promise<HTMLElement> => {
      document.body.innerHTML = html;
      run();
      await flush();
      return document.getElementById('held')!;
    };

    it('repoints the link around the picture, which a lightbox reads on click', async () => {
      const link = await shown(
        `<a id="held" href="/tmp/shots/a.png"><img src="${URI}"></a>`,
      );
      expect(link.getAttribute('href')).toBe(URI);
    });

    it('repoints a data attribute, on a wrapper further out or on the picture itself', async () => {
      const wrapper = await shown(
        `<div id="held" data-src="file:///tmp/a.JPEG"><span><img data-full=" /tmp/a.webp " src="${URI}"></span></div>`,
      );
      expect(wrapper.dataset['src']).toBe(URI);
      expect(wrapper.querySelector('img')!.dataset['full']).toBe(URI);
    });

    it('leaves alone an element holding two pictures, whose path could mean either', async () => {
      const wrapper = await shown(
        `<a id="held" href="/tmp/a.png"><img src="${URI}"><img src="${OTHER}"></a>`,
      );
      expect(wrapper.getAttribute('href')).toBe('/tmp/a.png');
    });

    it('leaves alone what names no local picture', async () => {
      const wrapper = await shown(
        `<a id="held" href="/tmp/report.pdf" data-web="https://example.com/a.png" data-cdn="//example.com/a.png"><img src="${URI}"></a>`,
      );
      expect(wrapper.getAttribute('href')).toBe('/tmp/report.pdf');
      expect(wrapper.dataset['web']).toBe('https://example.com/a.png');
      expect(wrapper.dataset['cdn']).toBe('//example.com/a.png');
    });

    it('leaves alone other attributes, and a picture that was not copied in', async () => {
      const wrapper = await shown(
        `<a id="held" title="/tmp/a.png"><img src="${URI}"></a><a id="plain" href="/tmp/b.png"><img src="https://example.com/b.png"></a>`,
      );
      expect(wrapper.getAttribute('title')).toBe('/tmp/a.png');
      expect(document.getElementById('plain')!.getAttribute('href')).toBe(
        '/tmp/b.png',
      );
    });
  });

  it('tells a page listener about the new theme, and survives one that throws', () => {
    run();
    const seen: string[] = [];
    geniro().onTheme(() => {
      throw new Error('page bug');
    });
    geniro().onTheme((theme) => seen.push(theme.fg));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    document.documentElement.style.setProperty('--geniro-fg', 'sentinel-fg');
    retheme();

    expect(seen).toEqual(['sentinel-fg']);
  });
});
