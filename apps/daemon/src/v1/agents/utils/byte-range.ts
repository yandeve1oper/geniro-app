/** The inclusive byte span one `Range` request asks for. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * The span a `Range` header asks for out of a file of `size` bytes: null for the
 * whole file (no header, or one this does not read), `'unsatisfiable'` for a span
 * that starts past the end.
 *
 * Only one span is served. A media element asks for one at a time, and a header
 * naming several — or a unit other than bytes — is answered with the whole file,
 * which a server may always do.
 */
export function parseByteRange(
  header: string | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (header === undefined) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) {
    return null;
  }
  const [, from = '', to = ''] = match;
  if (from === '' && to === '') {
    return null;
  }
  if (from === '') {
    const suffix = Number(to);
    if (suffix === 0 || size === 0) {
      return 'unsatisfiable';
    }
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(from);
  if (start >= size) {
    return 'unsatisfiable';
  }
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  return end < start ? null : { start, end };
}
