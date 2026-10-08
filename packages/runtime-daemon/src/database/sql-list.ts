// A closed set of words written into a statement as a SQL list.

/**
 * `values` as a SQL list of quoted strings, for an `IN` or a `CHECK`. Each value is a member of a
 * closed set the code declares, never input, and holds no quote.
 */
export function sqlListOf(values: Iterable<string>): string {
  return Array.from(values, (value) => `'${value}'`).join(", ");
}
