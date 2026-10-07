// Relay payloads several contracts tests parse.

/** A valid `relay.pin_refused` payload: the relay host and the two 8-byte key prefixes. */
export const RELAY_PIN_REFUSED_PAYLOAD: Readonly<Record<string, unknown>> = {
  relayHost: "relay.example.com",
  pinnedSpkiPrefix: "3f3f3f3f3f3f3f3f",
  presentedSpkiPrefix: "0123456789abcdef",
};
