/** A filesystem error's `code` (`ENOENT`, `EACCES`, …), safe to log or hand to a model; `unknown error` when it has none. */
export function fsErrorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : 'unknown error';
}
