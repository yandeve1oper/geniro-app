import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_IMAGE_FILE,
  imageTagsAreWhole,
  isArtifactImageExtension,
  isLocalSource,
  mapImageSources,
  mapMediaSources,
  mediaTagsAreWhole,
} from './artifact-html-images';

describe('mapMediaSources', () => {
  it('maps the src of audio, video and source tags, and leaves images and srcset alone', () => {
    const html =
      '<audio src="/tmp/a.mp3"></audio><video controls src=/tmp/v.mp4></video>' +
      '<video><source src="/tmp/w.webm" type="video/webm"></video>' +
      '<img src="/tmp/p.png"><picture><source srcset="/tmp/s.png"></picture>' +
      '<audiox src="/tmp/no.mp3">';
    const seen: string[] = [];

    const out = mapMediaSources(html, (src) => {
      seen.push(src);
      return `media/${seen.length}`;
    });

    expect(seen).toEqual(['/tmp/a.mp3', '/tmp/v.mp4', '/tmp/w.webm']);
    expect(out).toBe(
      '<audio src="media/1"></audio><video controls src=media/2></video>' +
        '<video><source src="media/3" type="video/webm"></video>' +
        '<img src="/tmp/p.png"><picture><source srcset="/tmp/s.png"></picture>' +
        '<audiox src="/tmp/no.mp3">',
    );
  });

  it('leaves image tags to mapImageSources', () => {
    const html = '<img src="/tmp/p.png"><audio src="/tmp/a.mp3">';

    expect(mapImageSources(html, () => 'images/x.png')).toBe(
      '<img src="images/x.png"><audio src="/tmp/a.mp3">',
    );
  });
});

describe('mediaTagsAreWhole', () => {
  it('accepts closed media tags and refuses an unclosed one or a `>` inside a quoted value', () => {
    expect(mediaTagsAreWhole('<video src="/tmp/v.mp4" controls></video>')).toBe(
      true,
    );
    expect(mediaTagsAreWhole('<audio src="/tmp/a.mp3">')).toBe(true);
    expect(mediaTagsAreWhole('<audio title="a > b" src="/tmp/a.mp3">')).toBe(
      false,
    );
    expect(mediaTagsAreWhole('<p>x</p><video src="/tmp/v.mp4')).toBe(false);
  });

  it('ignores an unclosed image tag, which imageTagsAreWhole judges', () => {
    expect(mediaTagsAreWhole('<p>x</p><img src="/tmp/a.png')).toBe(true);
  });
});

describe('mapImageSources', () => {
  it('replaces the src of every image tag, whatever its quoting', () => {
    const html =
      '<img src="/tmp/a.png"> <img src=\'/tmp/b.png\'> <img alt=x src=/tmp/c.png>';
    const seen: string[] = [];

    const out = mapImageSources(html, (src) => {
      seen.push(src);
      return `images/${seen.length}.png`;
    });

    expect(seen).toEqual(['/tmp/a.png', '/tmp/b.png', '/tmp/c.png']);
    expect(out).toBe(
      '<img src="images/1.png"> <img src=\'images/2.png\'> <img alt=x src=images/3.png>',
    );
  });

  it('leaves data-src, srcset and every byte outside an image tag as written', () => {
    const html =
      '<p>see src="/tmp/no.png"</p><img data-src="/tmp/x.png" srcset="/tmp/y.png 2x" src="/tmp/z.png" width="40">';

    const out = mapImageSources(html, () => 'images/z.png');

    expect(out).toBe(
      '<p>see src="/tmp/no.png"</p><img data-src="/tmp/x.png" srcset="/tmp/y.png 2x" src="images/z.png" width="40">',
    );
  });

  it('reads no src out of a tag whose quoted value holds a `>`, and leaves it as written', () => {
    // The tag ends at that `>`, so the source after it is not in the text the scanner
    // reads. imageTagsAreWhole refuses such a page; nothing is guessed here.
    const html = '<img alt="a > b" src="/tmp/x.png">';
    const seen: string[] = [];
    const out = mapImageSources(html, (src) => {
      seen.push(src);
      return 'images/x.png';
    });

    expect(seen).toEqual([]);
    expect(out).toBe(html);
  });

  it('does not take a src= that opens a quoted alt text for the src', () => {
    const seen: string[] = [];
    const out = mapImageSources(
      '<img alt="src=/tmp/nope.png" src="/tmp/y.png">',
      (src) => {
        seen.push(src);
        return 'images/y.png';
      },
    );

    expect(seen).toEqual(['/tmp/y.png']);
    expect(out).toBe('<img alt="src=/tmp/nope.png" src="images/y.png">');
  });

  it('maps only the first src, which is the one a browser shows', () => {
    const seen: string[] = [];
    const out = mapImageSources(
      '<img src="/tmp/a.png" src="/tmp/b.png">',
      (src) => {
        seen.push(src);
        return 'images/a.png';
      },
    );

    expect(seen).toEqual(['/tmp/a.png']);
    expect(out).toBe('<img src="images/a.png" src="/tmp/b.png">');
  });

  it('leaves a tag whose src has no value alone', () => {
    const html = '<img src alt="x">';
    expect(mapImageSources(html, () => 'images/x.png')).toBe(html);
  });

  it('writes a source back untouched, quoting and all, when the mapping keeps it', () => {
    const html = '<img src=/tmp/c.png>';
    expect(mapImageSources(html, (src) => src)).toBe(html);
  });
});

describe('isLocalSource', () => {
  it('admits absolute and relative paths, and refuses schemes, protocol-relative hosts and empty sources', () => {
    expect(isLocalSource('/tmp/a.png')).toBe(true);
    expect(isLocalSource('shots/a.png')).toBe(true);
    expect(isLocalSource('data:image/png;base64,AAAA')).toBe(false);
    expect(isLocalSource('https://example.com/a.png')).toBe(false);
    expect(isLocalSource('//cdn.example.com/a.png')).toBe(false);
    expect(isLocalSource('   ')).toBe(false);
  });

  it('takes a file: address as a local picture, and leaves a fragment or query alone', () => {
    expect(isLocalSource('file:///tmp/a.png')).toBe(true);
    expect(isLocalSource('#top')).toBe(false);
    expect(isLocalSource('?v=2')).toBe(false);
  });
});

describe('mapImageSources, as a browser reads a tag', () => {
  it('reads an unquoted source to whitespace or `>`, so a quote inside it is part of the path', () => {
    // A browser keeps the apostrophe: the value is /tmp/it's.png, and the text after
    // the tag is not part of it.
    const seen: string[] = [];
    const out = mapImageSources(
      "<img src=/tmp/it's.png><p>don't</p>",
      (src) => {
        seen.push(src);
        return 'images/x.png';
      },
    );

    expect(seen).toEqual(["/tmp/it's.png"]);
    expect(out).toBe("<img src=images/x.png><p>don't</p>");
  });

  it('matches the tag name and the attribute name without regard to case', () => {
    const out = mapImageSources('<IMG SRC="/tmp/a.png">', () => 'images/a.png');
    expect(out).toBe('<IMG SRC="images/a.png">');
  });

  it('leaves a tag whose name only begins with img alone', () => {
    const html = '<imgx src="/tmp/a.png"><img-x src="/tmp/b.png">';
    expect(mapImageSources(html, () => 'images/a.png')).toBe(html);
  });

  it('stops at the first tag that is never closed, as a browser drops the rest of the page', () => {
    // The first picture is rewritten; the second tag has no `>`, so the page is
    // written back from it on, as the agent wrote it.
    const html = '<img src="/tmp/a.png"><img src="/tmp/b.png';
    expect(mapImageSources(html, () => 'images/a.png')).toBe(
      '<img src="images/a.png"><img src="/tmp/b.png',
    );
  });

  it('reads a page of many unclosed tags in linear time, not in time that grows with its square', () => {
    // A page of 512KB of unclosed openers once cost about a minute of CPU on the
    // daemon's one thread. The bound is generous: a linear pass takes milliseconds.
    const html = '<img alt="x" '.repeat(45_000);
    const started = performance.now();
    const out = mapImageSources(html, () => 'images/a.png');
    const elapsed = performance.now() - started;

    expect(out).toBe(html);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('imageTagsAreWhole', () => {
  it('accepts a page whose image tags close, with a `>` written as &gt; or quotes inside a value', () => {
    expect(imageTagsAreWhole('<img alt="a &gt; b" src="/tmp/x.png">')).toBe(
      true,
    );
    expect(imageTagsAreWhole(`<img alt='say "hi"' src="/tmp/x.png">`)).toBe(
      true,
    );
    expect(imageTagsAreWhole('<p>no pictures, and a > here</p>')).toBe(true);
  });

  it('does not take a tag such as <img-x for an image tag', () => {
    expect(imageTagsAreWhole('<img-x src="/tmp/a.png"')).toBe(true);
  });

  it('accepts an apostrophe inside an unquoted value, which a browser keeps as part of it', () => {
    expect(imageTagsAreWhole("<img src=/tmp/it's.png><p>don't</p>")).toBe(true);
  });

  it('refuses a `>` inside a quoted value, which a browser reads as the tag ending early', () => {
    expect(imageTagsAreWhole('<img alt="a > b" src="/tmp/x.png">')).toBe(false);
  });

  it('refuses a tag that never closes at the end of the page', () => {
    expect(
      imageTagsAreWhole('<img src="/tmp/a.png"><img src="/tmp/b.png'),
    ).toBe(false);
  });

  it('checks a page of many closed tags in linear time', () => {
    const html = '<img alt="x" src="/tmp/a.png">'.repeat(20_000);
    const started = performance.now();
    const whole = imageTagsAreWhole(html);
    const elapsed = performance.now() - started;

    expect(whole).toBe(true);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('isArtifactImageExtension', () => {
  it('admits the five stored formats and nothing else', () => {
    for (const extension of ['png', 'jpg', 'webp', 'gif', 'avif']) {
      expect(isArtifactImageExtension(extension)).toBe(true);
    }
    for (const extension of ['svg', 'PNG', 'jpeg', '', 'png.exe']) {
      expect(isArtifactImageExtension(extension)).toBe(false);
    }
  });
});

describe('ARTIFACT_IMAGE_FILE', () => {
  it('names a stored picture by the hash of its bytes and one of the listed formats', () => {
    const hash = 'a'.repeat(64);
    expect(ARTIFACT_IMAGE_FILE.test(`${hash}.png`)).toBe(true);
    expect(ARTIFACT_IMAGE_FILE.test(`${hash}.avif`)).toBe(true);
  });

  it('refuses an svg, a name that is not a hash, and a path', () => {
    const hash = 'a'.repeat(64);
    expect(ARTIFACT_IMAGE_FILE.test(`${hash}.svg`)).toBe(false);
    expect(ARTIFACT_IMAGE_FILE.test('notes.png')).toBe(false);
    expect(ARTIFACT_IMAGE_FILE.test(`../${hash}.png`)).toBe(false);
  });
});
