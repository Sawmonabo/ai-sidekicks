/**
 * One row of a keyed table, looked up by a wire-verbatim string.
 *
 * `Object.hasOwn` rather than an indexed read: the key arrived off the wire, so
 * `"constructor"` and `"toString"` reach the lookup exactly as a real key does, and an
 * indexed read would answer them with something off `Object.prototype` where the caller
 * asks whether the table has the row at all.
 */
export function readFrozenRecord<Row>(
  table: Readonly<Record<string, Row>>,
  key: string,
): Row | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
