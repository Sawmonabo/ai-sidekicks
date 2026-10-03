/**
 * One row of a keyed table, looked up by a wire-verbatim string.
 *
 * Uses `Object.hasOwn` because a wire key such as `"constructor"` would otherwise answer with
 * something off `Object.prototype`.
 */
export function readFrozenRecord<Row>(
  table: Readonly<Record<string, Row>>,
  key: string,
): Row | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
