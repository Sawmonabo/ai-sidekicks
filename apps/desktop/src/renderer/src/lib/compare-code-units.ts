// The one string order that is the same on every host: by UTF-16 code unit, never collated.

/**
 * Orders two strings by code unit, for a sort whose result must not change with the host's
 * locale, as `localeCompare` would.
 */
export function compareCodeUnits(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
