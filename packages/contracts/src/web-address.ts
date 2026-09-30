// The two rules every web address the app opens is held to, wherever it is opened:
// only `http:` and `https:`, and never a username or a password in the authority.
//
// Preview asserts them at both ends of its wire: the pane refuses a typed address
// on its own line before sending it, and the daemon refuses it again where the
// request arrives. The desktop's own window navigation holds links to the same two
// rules before handing one to the system browser. Stating them once here keeps the
// three from drifting.
//
// Only an already parsed `URL` is judged. Turning typed text into an address (a
// bare port, a bare host, a path on the current page) is the address line's own
// parsing, and text that parses to no address at all is that parser's refusal.

/**
 * The schemes a web address may carry, in `URL.protocol` form, which the WHATWG
 * parser always writes in lower case.
 */
export const WEB_ADDRESS_SCHEMES: readonly string[] = Object.freeze(["http:", "https:"]);

/**
 * Why a parsed address is not a web address the app opens.
 *
 * - `credentials`: the authority carries a username or a password
 *   (`https://app@evil.test`), a phishing shape no legitimate address needs.
 * - `scheme`: the scheme is neither `http:` nor `https:`.
 */
export type WebAddressFault = "credentials" | "scheme";

/** Every {@link WebAddressFault}, in the order they are checked. */
export const WEB_ADDRESS_FAULTS: readonly WebAddressFault[] = Object.freeze([
  "credentials",
  "scheme",
]);

/**
 * Judges one parsed address against the two rules, credentials first, and answers
 * the fault or `null` when the address passes both. The fault names the class of
 * the problem and never echoes the address, so it is safe to log.
 */
export function webAddressFault(address: URL): WebAddressFault | null {
  if (address.username !== "" || address.password !== "") {
    return "credentials";
  }
  if (!WEB_ADDRESS_SCHEMES.includes(address.protocol)) {
    return "scheme";
  }
  return null;
}
