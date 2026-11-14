// A field whose value the screen collects and never reads back (a token, a header or variable
// value, an address that may carry a password) is held only by the field itself, outside any
// React state, until the one handler that sends it reads it.

/**
 * Read a write-only field once and clear it in the same step, so the value lives only in the
 * handler that sends it: never in component state, a `FormData` entry or the field.
 */
export function takeWriteOnlyValue(field: HTMLInputElement | null): string {
  const value = field?.value ?? "";
  if (field !== null) {
    field.value = "";
  }
  return value;
}
