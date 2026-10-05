// Reads one wire-supplied member as a string or a finite number. The store holds entity bodies
// wire-verbatim, so every member arrives `unknown`; this is the one rule for what counts as
// present, shared because features never import one another. It imports nothing and parses no
// registered shape. The empty string is absent: every consumer renders it as missing.

/**
 * One wire-supplied value as a non-empty string, or `undefined` for anything else. Takes the
 * value, not a `(body, member)` pair, so a caller with an optional body can index at the call site.
 */
export function readWireString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * One wire-supplied value as a finite number, or `undefined` for anything else. `NaN` and the
 * infinities are not figures a view may render as though they were readings.
 */
export function readWireNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
