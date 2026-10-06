// Reading the request a computed reply was handed, which arrives as `unknown` and is read member
// by member rather than trusted to a shape.

/** A request read as a record, or an empty one. */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** One member of a request. */
export function readMember(value: unknown, key: string): unknown {
  return asRecord(value)[key];
}

/** One string member of a request, or an empty string. */
export function readString(value: unknown, key: string): string {
  const member = readMember(value, key);
  return typeof member === "string" ? member : "";
}
