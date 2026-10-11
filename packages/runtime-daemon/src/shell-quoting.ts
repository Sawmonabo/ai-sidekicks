// A value written into a POSIX shell command line exactly, whatever bytes it holds.

/**
 * `value` single-quoted for a POSIX shell. Nothing inside `'...'` is interpreted, so an embedded
 * `'` is written as `'\''`: close, an escaped quote, reopen.
 */
export function quoteForPosixShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
