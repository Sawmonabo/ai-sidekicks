// A checked daemon value's bytes put back in place: the wire carries each byte member as a
// `{"$bytes": n}` placeholder beside the JSON, and the generated check reads it from the
// attachments, so once checked the value takes each attachment where its placeholder stood.

/**
 * `value` with each `{"$bytes": n}` member replaced by attachment `n`. Call it only on a value its
 * generated check admitted with the same `attachments`, which proves every placeholder names one.
 */
export function withBytesPlaced(value: unknown, attachments: readonly Uint8Array[]): unknown {
  if (attachments.length === 0 || typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((element: unknown) => withBytesPlaced(element, attachments));
  }
  const index = (value as { $bytes?: unknown }).$bytes;
  if (Number.isInteger(index) && Object.keys(value).length === 1) {
    return attachments[index as number];
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, member]) => [key, withBytesPlaced(member, attachments)]),
  );
}
