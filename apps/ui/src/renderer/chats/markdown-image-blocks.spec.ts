import { describe, expect, it } from 'vitest';

import { type HastNode, markdownImageBlocks } from './markdown-image-blocks';

const text = (value: string): HastNode => ({ type: 'text', value });
const element = (tagName: string, children: HastNode[] = []): HastNode => ({
  type: 'element',
  tagName,
  children,
});
const image = (): HastNode => element('img');

/** Runs the plugin over one paragraph holding `children`; returns them after. */
function paragraphAfter(...children: HastNode[]): HastNode[] {
  const tree: HastNode = { type: 'root', children: [element('p', children)] };
  markdownImageBlocks()(tree);
  return tree.children?.[0]?.children ?? [];
}

describe('markdownImageBlocks', () => {
  it('takes the whitespace off the text on both sides of an image', () => {
    expect(paragraphAfter(text('a \n'), image(), text(' \tb'))).toEqual([
      text('a'),
      image(),
      text('b'),
    ]);
  });

  it('leaves whitespace that touches no image as the writer wrote it', () => {
    expect(
      paragraphAfter(
        text('  a  b  '),
        element('strong', [text(' s ')]),
        text(' '),
        image(),
        text(' c  d  '),
      ),
    ).toEqual([
      text('  a  b  '),
      element('strong', [text(' s ')]),
      image(),
      text('c  d  '),
    ]);
  });

  it('drops a text node the image left empty', () => {
    expect(paragraphAfter(text(' \n'), image())).toEqual([image()]);
  });

  it('trims the text beside a link that wraps an image', () => {
    expect(
      paragraphAfter(text('x\n'), element('a', [image()]), text('\ny')),
    ).toEqual([text('x'), element('a', [image()]), text('y')]);
  });

  it('trims an image inside a link that carries other text too', () => {
    expect(
      paragraphAfter(element('a', [text('x '), image(), text(' y')])),
    ).toEqual([element('a', [text('x'), image(), text('y')])]);
  });

  it('leaves preformatted and code text alone', () => {
    expect(
      paragraphAfter(
        element('code', [text(' '), image(), text(' ')]),
        element('pre', [text('\n'), image(), text('\n')]),
      ),
    ).toEqual([
      element('code', [text(' '), image(), text(' ')]),
      element('pre', [text('\n'), image(), text('\n')]),
    ]);
  });

  it('reaches an image nested under other elements', () => {
    const tree: HastNode = {
      type: 'root',
      children: [element('div', [element('li', [text('a '), image()])])],
    };

    markdownImageBlocks()(tree);

    expect(tree.children?.[0]?.children?.[0]?.children).toEqual([
      text('a'),
      image(),
    ]);
  });

  it('changes nothing in a paragraph with no image', () => {
    expect(paragraphAfter(text(' a '))).toEqual([text(' a ')]);
  });
});
