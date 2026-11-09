// A daemon value's bytes moved out of and back into place: the wire carries each byte member as a
// `{"$bytes": n}` placeholder beside the JSON, and the generated check reads it from the
// attachments. A request's bytes are taken out before it is checked and sent; once a reply is
// checked, it takes each attachment where its placeholder stood.

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

/** `value` with each `Uint8Array` in it taken into `attachments` and left as its placeholder. */
export function withBytesTaken(value: unknown, attachments: Uint8Array[]): unknown {
  if (value instanceof Uint8Array) {
    attachments.push(value);
    return { $bytes: attachments.length - 1 };
  }
  if (Array.isArray(value)) {
    return value.map((element: unknown) => withBytesTaken(element, attachments));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [key, withBytesTaken(member, attachments)]),
    );
  }
  return value;
}
