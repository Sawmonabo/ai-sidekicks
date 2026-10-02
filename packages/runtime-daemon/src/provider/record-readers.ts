/** Readers that narrow an untrusted JSON value from a provider, a stored row or the wire. */

/** The one meaning of "an object" on a parse path; arrays are excluded. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string field with at least one character, or `undefined` for anything else. */
export function readNonEmptyString(
  source: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
