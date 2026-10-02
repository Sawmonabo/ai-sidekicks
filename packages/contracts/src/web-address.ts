// The one rule every web address the app opens is held to: only `http:` and `https:`. A user
// name or a password in the authority is part of an address as typed and is not refused. Stated
// once so the preview pane and the desktop's window navigation cannot drift. Only an already
// parsed `URL` is judged; turning typed text into an address is the caller's parsing.

/**
 * The schemes a web address may carry, in `URL.protocol` form, which the WHATWG
 * parser always writes in lower case.
 */
export const WEB_ADDRESS_SCHEMES: readonly string[] = Object.freeze(["http:", "https:"]);

/**
 * Why a parsed address is not a web address the app opens.
 *
 * - `scheme`: the scheme is neither `http:` nor `https:`.
 */
export type WebAddressFault = "scheme";

/** Every {@link WebAddressFault}. */
export const WEB_ADDRESS_FAULTS: readonly WebAddressFault[] = Object.freeze(["scheme"]);

/**
 * Judges one parsed address against the rule and answers the fault, or `null` when the address
 * passes. The fault names the class of the problem and never echoes the address, so it is safe
 * to log.
 */
export function webAddressFault(address: URL): WebAddressFault | null {
  if (!WEB_ADDRESS_SCHEMES.includes(address.protocol)) {
    return "scheme";
  }
  return null;
}
