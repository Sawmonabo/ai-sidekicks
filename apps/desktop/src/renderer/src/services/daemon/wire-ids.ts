// Widens an app-held id string to the branded id a registered request declares. Held ids are
// plain strings (route params, scenario data, rendered rows), so a caller widens where a held id
// meets a request. `callDaemon` parses the whole request through the contracts schema that owns the
// brand, so a malformed id is refused as `request-unsendable`; a cast anywhere else would carry no
// such check. Branding a row's id for a callback is deliberately not served, because nothing
// checks it.

/**
 * Widens one held id string to the branded id a request member declares. The brand is inferred
 * from the member being filled, so a held id offered where a different id is wanted still fails to
 * compile.
 */
export function heldIdAsWireId<TWireId extends string>(heldId: string): TWireId {
  return heldId as TWireId;
}
