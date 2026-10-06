// Main's one check that a value read from outside is a plain object whose members can be read.

/** Whether `value` is an object with readable members: not `null`, not an array. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
