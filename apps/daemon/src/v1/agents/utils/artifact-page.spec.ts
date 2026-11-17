// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  ARTIFACT_FRAME_SOURCE,
  ARTIFACT_HOST_SOURCE,
  ARTIFACT_PAGE_CSP,
  ARTIFACT_SERVED_PAGE_CSP,
  renderArtifactDocument,
  renderArtifactPage,
  withInlineImages,
} from './artifact-page';
import { ARTIFACT_LAYER_ORDER, ARTIFACT_THEME_EVENT } from './artifact-runtime';

describe('ARTIFACT_PAGE_CSP', () => {
  const directive = (name: string): string | undefined =>
    ARTIFACT_PAGE_CSP.split('; ').find((part) => part.startsWith(`${name} `));

  it('denies everything by default, which is what makes the page safe to run', () => {
    expect(directive('default-src')).toBe("default-src 'none'");
  });

  it('gives page script NO channel to talk back', () => {
    // Agent script runs and can load a library, but it cannot send anything:
    // `default-src 'none'` covers connect/frame/worker/object, and none of them
    // may be re-opened by a directive of its own.
    for (const opened of [
      'connect-src',
      'frame-src',
      'worker-src',
      'object-src',
      'child-src',
      'manifest-src',
      'prefetch-src',
    ]) {
      expect(directive(opened), `${opened} re-opened`).toBeUndefined();
    }
    expect(ARTIFACT_PAGE_CSP).not.toContain('*');
  });

  it('reaches out only to the fixed library CDNs, and only over https', () => {
    const remote = ARTIFACT_PAGE_CSP.split(/[;\s]+/).filter((token) =>
      /^[a-z]+:\/\//i.test(token),
    );
    expect(remote.length).toBeGreaterThan(0);
    for (const source of remote) {
      expect(
        [
          'https://cdnjs.cloudflare.com',
          'https://cdn.jsdelivr.net/npm/',
          'https://unpkg.com',
          'https://fonts.googleapis.com',
          'https://fonts.gstatic.com',
        ],
        `${source} is not an allowed host`,
      ).toContain(source);
    }
  });

  it('lets scripts come inline or from the CDNs, and nowhere else', () => {
    expect(directive('script-src')).toBe(
      "script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com",
    );
  });

  it('lets stylesheets come inline, from Google Fonts or from the CDNs', () => {
    expect(directive('style-src')).toBe(
      "style-src 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com",
    );
  });

  it('scopes jsDelivr to its npm path, which serves published packages only', () => {
    // A bare `https://cdn.jsdelivr.net` would also admit its `/gh/` path — any
    // file from any GitHub repository, published by nobody.
    expect(ARTIFACT_PAGE_CSP).not.toMatch(
      /https:\/\/cdn\.jsdelivr\.net(?!\/npm\/)/,
    );
  });

  it('does not allow eval, which nothing in a static page needs', () => {
    expect(ARTIFACT_PAGE_CSP).not.toContain('unsafe-eval');
  });

  it('allows only inline data for images and media in the portable policy a share or a saved file carries', () => {
    expect(directive('img-src')).toBe('img-src data:');
    expect(directive('media-src')).toBe('media-src data:');
  });

  it('serves the framed page the same policy with its own origin added for media alone', () => {
    expect(ARTIFACT_SERVED_PAGE_CSP).toBe(
      ARTIFACT_PAGE_CSP.replace('media-src data:', "media-src data: 'self'"),
    );
    expect(ARTIFACT_SERVED_PAGE_CSP).toContain("media-src data: 'self';");
    expect(ARTIFACT_SERVED_PAGE_CSP.match(/'self'/g)).toHaveLength(1);
  });

  it('takes fonts inline, from Google Fonts or from the CDNs', () => {
    expect(directive('font-src')).toBe(
      'font-src data: https://fonts.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com',
    );
  });

  it('pins base-uri and form-action, which default-src does NOT cover', () => {
    // Without the first a <base> tag re-points every relative URL in the
    // document; without the second a form can POST the page's contents even
    // though script cannot reach the network.
    expect(directive('base-uri')).toBe("base-uri 'none'");
    expect(directive('form-action')).toBe("form-action 'none'");
  });
});

describe('renderArtifactPage', () => {
  it('passes the agent’s document through untouched', () => {
    // Not parsed, not sanitized, not rewritten — the sandbox is what makes the
    // contents moot, and a rewrite would break pages for no security gain.
    const html =
      '<!doctype html><html><head><style>b{color:red}</style></head><body><p onclick="go()">hi</p><script>var x=1<2;</script></body></html>';
    const page = renderArtifactPage(html);
    expect(page).toContain('<p onclick="go()">hi</p>');
    expect(page).toContain('var x=1<2;');
    expect(page).toContain('b{color:red}');
  });

  it('puts geniro’s block INSIDE the body, before its close', () => {
    const page = renderArtifactPage('<body><p>hi</p></body>');
    expect(page.indexOf(ARTIFACT_FRAME_SOURCE)).toBeLessThan(
      page.indexOf('</body>'),
    );
  });

  it('still wraps a bare FRAGMENT, which is what a model usually sends', () => {
    const page = renderArtifactPage('<h1>Plan</h1><p>step one</p>');
    expect(page).toContain('<h1>Plan</h1>');
    expect(page).toContain(ARTIFACT_FRAME_SOURCE);
  });

  it.each([
    ['</body>', '</body>'],
    ['</BODY>', '</BODY>'],
    ['</body >', '</body >'],
  ])(
    'matches %s whatever case or spacing it was written in',
    (_name, close) => {
      // Asserted against the index of the literal close tag. An earlier version
      // compared against `lastIndexOf('</')`, which lands on the block's own
      // appended `</script>` and so held whether the tag matched or not.
      const page = renderArtifactPage(`<body><p>hi</p>${close}`);
      expect(page.indexOf(ARTIFACT_FRAME_SOURCE)).toBeLessThan(
        page.indexOf(close),
      );
    },
  );

  it('splices at the LAST </body>, not an earlier one inside the page’s own script', () => {
    // A page that emits markup from its own script contains the tag before the
    // real one. Splicing there ends that script element on the block's own
    // closing tag and breaks the page, taking the wrapper with it.
    const html =
      '<body><script>var t = "<p>x</p></body>";</script><p>real</p></body>';
    const page = renderArtifactPage(html);

    // The decoy inside the string literal is untouched…
    expect(page).toContain('var t = "<p>x</p></body>";');
    // …and the block lands after the page's own script, before the real close.
    expect(page.indexOf(ARTIFACT_FRAME_SOURCE)).toBeGreaterThan(
      page.indexOf('var t ='),
    );
    expect(page.indexOf(ARTIFACT_FRAME_SOURCE)).toBeLessThan(
      page.lastIndexOf('</body>'),
    );
  });

  it('does not read a `$` in the agent’s document as a replacement pattern', () => {
    // `String.replace` expands `$&` and `$1` in a string replacement; the
    // block is inserted through a function replacer so it cannot.
    const page = renderArtifactPage('<body><p>cost: $& and $1</p></body>');
    expect(page).toContain('<p>cost: $& and $1</p>');
  });

  it('puts its base style in the layer BELOW the kit and Tailwind’s utilities', () => {
    // Unlayered, `a { color }` outranked `:where(.g-btn)` and every Tailwind
    // utility: a link styled as a button had primary text on a primary ground.
    const page = renderArtifactPage('<p>x</p>');
    expect(page).toMatch(
      /<style data-geniro="base">@layer geniro-base \{\n[\s\S]*html, body \{ background: transparent; \}/,
    );
  });

  it('paints transparent so the app’s own background shows through', () => {
    expect(renderArtifactPage('<p>x</p>')).toContain(
      'html, body { background: transparent; }',
    );
  });

  it('centres a body capped narrower than the frame, from `html` so a page’s `margin: 0` cannot undo it', () => {
    // Agents cap `body` with `max-width` beside `margin: 0`; a `margin-inline:
    // auto` floor loses to that, so the flex row on `html` does the centring.
    const page = renderArtifactPage('<p>x</p>');
    expect(page).toContain('html { display: flex; justify-content: center; }');
    expect(page).toMatch(/body \{\n\s*flex: 1 1 auto;\n\s*min-width: 0;/);
  });

  it('gives every theme token a fallback, so the page reads before any message', () => {
    const page = renderArtifactPage('<p>x</p>');
    for (const token of ['--geniro-fg', '--geniro-font', '--geniro-primary']) {
      expect(page).toMatch(new RegExp(`var\\(${token},[^)]+\\)`));
    }
  });

  it('is idempotent in the only sense that matters — one wrapper per render', () => {
    const page = renderArtifactPage('<body><p>x</p></body>');
    expect(page.split(ARTIFACT_HOST_SOURCE)).toHaveLength(2);
  });

  it('carries the page runtime AHEAD of the page’s own script', () => {
    // The page's script calls `geniro.chart`, so the runtime has to have run.
    const page = renderArtifactPage(
      '<html><head></head><body><script>geniro.chart("#a", {})</script></body></html>',
    );
    expect(page.indexOf('data-geniro="runtime"')).toBeGreaterThan(-1);
    expect(page.indexOf('data-geniro="runtime"')).toBeLessThan(
      page.indexOf('geniro.chart("#a"'),
    );
  });
});

describe('the element floor', () => {
  const elementsOf = (page: string): string =>
    /<style data-geniro="elements">@layer geniro-elements \{\n([\s\S]*?)\n\}<\/style>/.exec(
      page,
    )?.[1] ?? '';

  it('sits in the LOWEST layer, under Tailwind’s preflight and every rule the page writes', () => {
    // Above `base`, it would undo the reset a Tailwind page's utilities are
    // written against (`ul` with bullets back, `h1` sized up again).
    expect(elementsOf(renderArtifactPage('<p>x</p>'))).toContain('h2 {');
    const order = ARTIFACT_LAYER_ORDER.replace(/^@layer |;$/g, '').split(', ');
    expect(order[0]).toBe('geniro-elements');
    expect(order.indexOf('geniro-elements')).toBeLessThan(
      order.indexOf('base'),
    );
  });

  it('gives a bare details, table, control and focus ring the app’s look', () => {
    const css = elementsOf(renderArtifactPage('<p>x</p>'));
    expect(css).toMatch(/summary::marker \{ color: var\(--geniro-muted, /);
    expect(css).toMatch(/th, td \{ padding: 6px 10px;/);
    expect(css).toMatch(/:root \{ accent-color: var\(--geniro-primary, /);
    expect(css).toMatch(
      /:focus-visible \{ outline: 2px solid var\(--geniro-primary, /,
    );
    expect(css).toMatch(
      /select:not\(\[class\]\), textarea:not\(\[class\]\) \{[^}]*background-color: var\(--geniro-surface, /,
    );
  });

  it('GUARDS a hanging disclosure marker and a mid-token break, even against the page’s own CSS', () => {
    // `!important` in the lowest layer outranks every normal declaration
    // anywhere — the only way a floor holds against an agent's
    // `list-style-position: outside` or `word-break: break-all`.
    const css = elementsOf(renderArtifactPage('<p>x</p>'));
    expect(css).toContain(
      'summary { list-style-position: inside !important; }',
    );
    expect(css).toContain('code { word-break: normal !important; }');
    // Every other rule stays a default the page can override.
    expect(css.match(/!important/g)).toHaveLength(2);
  });

  it('reads every token with a fallback, so the floor holds before the theme lands', () => {
    const css = elementsOf(renderArtifactPage('<p>x</p>'));
    expect(css).toContain('var(--geniro-border, ');
    expect(css).not.toMatch(/var\(--geniro-[a-z0-9-]+\)/);
  });

  it('travels into a saved page unchanged', () => {
    const framed = elementsOf(renderArtifactPage('<body><p>x</p></body>'));
    expect(framed.length).toBeGreaterThan(0);
    expect(elementsOf(renderArtifactDocument('<body><p>x</p></body>'))).toBe(
      framed,
    );
  });
});

describe('renderArtifactDocument', () => {
  it('carries the runtime the page’s script calls, and none of the frame plumbing', () => {
    const doc = renderArtifactDocument('<head></head><p>x</p>');
    expect(doc).toContain('data-geniro="runtime"');
    expect(doc).toContain('data-geniro="kit"');
    expect(doc).not.toContain(ARTIFACT_HOST_SOURCE);
    expect(doc).not.toContain(ARTIFACT_FRAME_SOURCE);
  });

  it('carries the SAME base style the frame does, so a saved page looks as it did in the app', () => {
    // Without it a saved page lost the font, size, padding, box-sizing and
    // centring the framed one had, and opened in the browser's defaults.
    const baseOf = (page: string): string =>
      /<style data-geniro="base">@layer geniro-base \{\n([\s\S]*?)\n\}<\/style>/.exec(
        page,
      )?.[1] ?? '';
    const framed = baseOf(renderArtifactPage('<body><p>x</p></body>'));
    const saved = baseOf(renderArtifactDocument('<body><p>x</p></body>'));
    expect(saved).toContain('html { display: flex; justify-content: center; }');
    expect(saved).toContain('font-size: 14px;');
    expect(framed).toBe(`html, body { background: transparent; }\n${saved}`);
  });

  it('leaves out the frame’s transparent ground, which would undo the file’s own', () => {
    // The export bakes the theme's background into the head; this block comes
    // later in the same layer, so a transparent ground here would win and put
    // a dark-theme page on the browser's white.
    const doc = renderArtifactDocument('<body><p>x</p></body>');
    const base = doc.slice(doc.indexOf('<style data-geniro="base">'));
    expect(base).toContain('@layer geniro-base');
    expect(base).not.toContain('html, body { background: transparent; }');
  });

  it('puts the base style before the document’s last `</body>`', () => {
    const doc = renderArtifactDocument('<html><body><p>x</p></body></html>');
    expect(doc.indexOf('data-geniro="base"')).toBeLessThan(
      doc.lastIndexOf('</body>'),
    );
    expect(doc.indexOf('data-geniro="base"')).toBeGreaterThan(
      doc.indexOf('<p>x</p>'),
    );
  });
});

describe('withInlineImages', () => {
  const FILE = `${'a'.repeat(64)}.png`;
  const PICTURE = Buffer.from('picture-bytes');
  const uriOf = (bytes: Buffer): string =>
    `data:image/png;base64,${bytes.toString('base64')}`;

  it('writes a picture the store holds into the page as a data URI', () => {
    const out = withInlineImages(`<img src="images/${FILE}">`, () => ({
      mediaType: 'image/png',
      bytes: PICTURE,
    }));
    expect(out).toBe(`<img src="${uriOf(PICTURE)}">`);
  });

  it('leaves a reference the store does not hold exactly as written', () => {
    // A null answer must keep the relative reference, not write the word "null"
    // into the page where the picture should be.
    const html = `<img src="images/${FILE}" alt="gone">`;
    expect(withInlineImages(html, () => null)).toBe(html);
  });

  it('asks the store once per file, yet every reference still carries the picture', () => {
    const asked: string[] = [];
    const out = withInlineImages(
      `<img src="images/${FILE}"><p>between</p><img src="images/${FILE}">`,
      (file) => {
        asked.push(file);
        return { mediaType: 'image/png', bytes: PICTURE };
      },
    );
    expect(asked).toEqual([FILE]);
    expect(out).toBe(
      `<img src="${uriOf(PICTURE)}"><p>between</p><img src="${uriOf(PICTURE)}">`,
    );
  });

  it('remembers a file the store does not hold, so a missing picture is not looked up again', () => {
    let asks = 0;
    const html = `<img src="images/${FILE}"><img src="images/${FILE}">`;
    expect(
      withInlineImages(html, () => {
        asks += 1;
        return null;
      }),
    ).toBe(html);
    expect(asks).toBe(1);
  });

  it('asks only about a name this store writes, and leaves every other source as written', () => {
    const asked: string[] = [];
    const html = [
      '<img src="https://example.com/a.png">',
      '<img src="images/notes.txt">',
      '<img src="/tmp/shot.png">',
      `<img src="images/${FILE.toUpperCase()}">`,
    ].join('');
    expect(
      withInlineImages(html, (file) => {
        asked.push(file);
        return { mediaType: 'image/png', bytes: PICTURE };
      }),
    ).toBe(html);
    expect(asked).toEqual([]);
  });
});

/**
 * The injected wrapper, RUN rather than read.
 *
 * Its previous pins were `toContain` over the script's own source, which fail
 * in both directions: a reformatted guard reddens with behaviour unchanged,
 * and a flipped comparison inside it stays green while the frame never grows.
 * These execute the script the page actually carries and observe what it
 * posts and writes.
 */
describe('the injected wrapper script', () => {
  /** The script exactly as `renderArtifactPage` emits it. */
  const wrapperScript = (): string => {
    const page = renderArtifactPage('<p>x</p>');
    const match = /<script>([\s\S]*?)<\/script>/.exec(page);
    if (match?.[1] === undefined) {
      throw new Error('the rendered page carried no wrapper script');
    }
    return match[1];
  };

  type Recorded = [
    EventTarget,
    string,
    EventListenerOrEventListenerObject,
    boolean | AddEventListenerOptions | undefined,
  ];

  /** Messages the script posted to its parent, newest last. */
  let posted: Record<string, unknown>[];
  /** Every listener added to the window or the document, to remove after the test. */
  let listeners: Recorded[];

  /**
   * Run the wrapper once, recording the listeners it installs so they can be
   * removed again — the document is shared across this file's tests, and a
   * leaked listener would answer the next test's messages too.
   */
  const runWrapper = (): void => {
    const addOnWindow = window.addEventListener.bind(window);
    const addOnDocument = document.addEventListener.bind(document);
    window.addEventListener = ((
      type: string,
      handler: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      listeners.push([window, type, handler, options]);
      addOnWindow(type, handler, options);
    }) as typeof window.addEventListener;
    document.addEventListener = ((
      type: string,
      handler: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      listeners.push([document, type, handler, options]);
      addOnDocument(type, handler, options);
    }) as typeof document.addEventListener;
    try {
      new Function(wrapperScript())();
    } finally {
      window.addEventListener = addOnWindow;
      document.addEventListener = addOnDocument;
    }
  };

  const sendFromHost = (data: unknown): void => {
    window.dispatchEvent(
      new MessageEvent('message', { data, source: window.parent }),
    );
  };

  /**
   * jsdom delivers `postMessage` on a later task, so anything the script POSTS
   * is unobservable in the turn that triggered it. The theme assertions need
   * no flush — those read a synchronous `setProperty`.
   */
  const flush = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

  afterEach(() => {
    for (const [target, type, handler, options] of listeners) {
      target.removeEventListener(type, handler, options);
    }
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('style');
  });

  const setup = (bodyHeight = 400): void => {
    posted = [];
    listeners = [];
    // jsdom lays nothing out, so the height the script measures is stubbed.
    Object.defineProperty(document.body, 'scrollHeight', {
      value: bodyHeight,
      configurable: true,
    });
    Object.defineProperty(document.body, 'offsetHeight', {
      value: bodyHeight,
      configurable: true,
    });
    const collect = (event: Event): void => {
      const data: unknown = (event as MessageEvent).data;
      if (
        typeof data === 'object' &&
        data !== null &&
        (data as { source?: unknown }).source === ARTIFACT_FRAME_SOURCE
      ) {
        posted.push(data as Record<string, unknown>);
      }
    };
    window.addEventListener('message', collect);
    listeners = [[window, 'message', collect, undefined]];
    runWrapper();
  };

  it('announces itself to the host as soon as it runs', async () => {
    // The host answers `ready` with the theme; without it a page opened before
    // the frame's load event would never be themed.
    setup();
    await flush();
    expect(posted.map((m) => m.type)).toContain('ready');
  });

  it('applies the theme values the host sends', () => {
    setup();
    sendFromHost({
      source: ARTIFACT_HOST_SOURCE,
      type: 'theme',
      vars: { '--geniro-fg': 'rgb(1, 2, 3)' },
    });
    expect(document.documentElement.style.getPropertyValue('--geniro-fg')).toBe(
      'rgb(1, 2, 3)',
    );
  });

  it('announces the new theme to the page once its tokens are written', () => {
    // The page runtime re-themes its charts on this event, and reads the
    // tokens back — so they must already be on the root when it fires.
    setup();
    const seen: string[] = [];
    const onTheme = (): void => {
      seen.push(document.documentElement.style.getPropertyValue('--geniro-fg'));
    };
    window.addEventListener(ARTIFACT_THEME_EVENT, onTheme);
    try {
      sendFromHost({
        source: ARTIFACT_HOST_SOURCE,
        type: 'theme',
        vars: { '--geniro-fg': 'rgb(4, 5, 6)' },
      });
    } finally {
      window.removeEventListener(ARTIFACT_THEME_EVENT, onTheme);
    }
    expect(seen).toEqual(['rgb(4, 5, 6)']);
  });

  it('ignores a message that is not tagged as the host’s', () => {
    setup();
    sendFromHost({
      source: 'something-else',
      type: 'theme',
      vars: { '--geniro-fg': 'red' },
    });
    expect(document.documentElement.style.getPropertyValue('--geniro-fg')).toBe(
      '',
    );
  });

  it('ignores a message that did not come from its own parent', () => {
    setup();
    const foreign = document.createElement('iframe');
    document.body.appendChild(foreign);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          source: ARTIFACT_HOST_SOURCE,
          type: 'theme',
          vars: { '--geniro-fg': 'red' },
        },
        source: foreign.contentWindow,
      }),
    );
    expect(document.documentElement.style.getPropertyValue('--geniro-fg')).toBe(
      '',
    );
    foreign.remove();
  });

  it('survives a theme value the document will not take', () => {
    // The try/catch around `setProperty` — a defensive branch worth a test
    // that enters it. One bad token must not stop the rest being applied.
    setup();
    sendFromHost({
      source: ARTIFACT_HOST_SOURCE,
      type: 'theme',
      vars: { 'not a custom property': 'x', '--geniro-fg': 'rgb(9, 9, 9)' },
    });
    expect(document.documentElement.style.getPropertyValue('--geniro-fg')).toBe(
      'rgb(9, 9, 9)',
    );
  });

  it('reports the height it measures', async () => {
    setup(400);
    sendFromHost({ source: ARTIFACT_HOST_SOURCE, type: 'theme', vars: {} });
    await flush();
    const heights = posted
      .filter((m) => m.type === 'height')
      .map((m) => m.height);
    expect(heights).toContain(400);
  });

  it('does NOT re-post a height that has not changed', async () => {
    // The dedupe. Its absence floods the host with a message per frame; its
    // INVERSION (`!==`) posts nothing at all and the frame never grows past
    // its initial height — and neither is visible in the script's source.
    setup(400);
    sendFromHost({ source: ARTIFACT_HOST_SOURCE, type: 'theme', vars: {} });
    await flush();
    const before = posted.filter((m) => m.type === 'height').length;
    expect(before).toBeGreaterThan(0);

    sendFromHost({ source: ARTIFACT_HOST_SOURCE, type: 'theme', vars: {} });
    sendFromHost({ source: ARTIFACT_HOST_SOURCE, type: 'theme', vars: {} });
    await flush();

    // Two further theme messages, the measured height unchanged: nothing more
    // is posted.
    expect(posted.filter((m) => m.type === 'height')).toHaveLength(before);
  });

  it('reports again once the height has actually moved', async () => {
    // The other side of the dedupe — without this the test above is satisfied
    // by a script that reports once and never again.
    setup(400);
    sendFromHost({ source: ARTIFACT_HOST_SOURCE, type: 'theme', vars: {} });
    await flush();

    Object.defineProperty(document.body, 'scrollHeight', {
      value: 900,
      configurable: true,
    });
    Object.defineProperty(document.body, 'offsetHeight', {
      value: 900,
      configurable: true,
    });
    sendFromHost({ source: ARTIFACT_HOST_SOURCE, type: 'theme', vars: {} });
    await flush();

    expect(
      posted.filter((m) => m.type === 'height').map((m) => m.height),
    ).toContain(900);
  });

  /**
   * Clicks the element `targetId` inside `markup`, as a reader's click lands,
   * and reports whether the script stopped the click's default action.
   */
  const click = (markup: string, targetId: string, button = 0): boolean => {
    document.body.innerHTML = markup;
    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button,
    });
    document.getElementById(targetId)!.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it('hands a web link to the host, and stops the frame navigating to it', async () => {
    setup();
    const prevented = click(
      '<a id="link" href="https://example.com/a">link</a>',
      'link',
    );
    await flush();
    expect(prevented).toBe(true);
    expect(posted).toContainEqual({
      source: ARTIFACT_FRAME_SOURCE,
      type: 'link',
      href: 'https://example.com/a',
    });
  });

  it('still relays a link whose own handler stops the click from bubbling', async () => {
    // The relay listens in the capture phase, ahead of any handler on the link, so
    // a page that stops propagation cannot keep the link from reaching the host.
    setup();
    document.body.innerHTML =
      '<a id="link" href="https://example.com/a">link</a>';
    const link = document.getElementById('link')!;
    link.addEventListener('click', (event) => event.stopPropagation());
    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    link.dispatchEvent(event);
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(posted).toContainEqual({
      source: ARTIFACT_FRAME_SOURCE,
      type: 'link',
      href: 'https://example.com/a',
    });
  });

  it('hands a mail link to the host the same way', async () => {
    setup();
    const prevented = click(
      '<a id="link" href="mailto:someone@example.com">mail</a>',
      'link',
    );
    await flush();
    expect(prevented).toBe(true);
    expect(posted).toContainEqual({
      source: ARTIFACT_FRAME_SOURCE,
      type: 'link',
      href: 'mailto:someone@example.com',
    });
  });

  it('leaves a same-page anchor alone, so it can still scroll', async () => {
    setup();
    const prevented = click('<a id="link" href="#top">top</a>', 'link');
    await flush();
    expect(prevented).toBe(false);
    expect(posted.some((m) => m.type === 'link')).toBe(false);
  });

  it('stops a relative or script link from navigating the frame, and leaves the host to refuse it', async () => {
    setup();
    expect(click('<a id="link" href="other.html">other</a>', 'link')).toBe(
      true,
    );
    expect(
      click('<a id="link" href="javascript:alert(1)">run</a>', 'link'),
    ).toBe(true);
    await flush();
    expect(posted.filter((m) => m.type === 'link').map((m) => m.href)).toEqual([
      'other.html',
      'javascript:alert(1)',
    ]);
  });

  it('treats a click on something inside a link as a click on the link', async () => {
    // A link wrapping `<code>` or an image takes its click on the child, and
    // only the walk up to the anchor finds the link the reader meant.
    setup();
    const prevented = click(
      '<a href="https://example.com/b"><span id="inner">label</span></a>',
      'inner',
    );
    await flush();
    expect(prevented).toBe(true);
    expect(posted).toContainEqual({
      source: ARTIFACT_FRAME_SOURCE,
      type: 'link',
      href: 'https://example.com/b',
    });
  });

  it('treats an image-map area as a link too', async () => {
    setup();
    const prevented = click(
      '<map name="m"><area id="area" href="https://example.com/area" shape="rect" coords="0,0,9,9"></map>',
      'area',
    );
    await flush();
    expect(prevented).toBe(true);
    expect(posted).toContainEqual({
      source: ARTIFACT_FRAME_SOURCE,
      type: 'link',
      href: 'https://example.com/area',
    });
  });

  it('leaves a right-click on a link to the browser', async () => {
    setup();
    const prevented = click(
      '<a id="link" href="https://example.com/c">link</a>',
      'link',
      2,
    );
    await flush();
    expect(prevented).toBe(false);
    expect(posted.some((m) => m.type === 'link')).toBe(false);
  });
});
