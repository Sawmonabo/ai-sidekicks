// The one rule every web address the app opens is held to: only `http:` and `https:`. A user name
// or a password in the authority is part of an address as typed and is not refused. Only an
// already parsed `URL` is judged; turning typed text into an address is the caller's parsing.
import { WEB_ADDRESS_SCHEMES, type WebAddressFault } from "../generated/web-address.js";

/**
 * Judges one parsed address against the rule and answers the fault, or `null` when the address
 * passes. The fault names the class of the problem and never echoes the address, so it is safe
 * to log.
 */
export function webAddressFault(address: URL): WebAddressFault | null {
  return (WEB_ADDRESS_SCHEMES as readonly string[]).includes(address.protocol) ? null : "scheme";
}

/**
 * Whether `origin` is exactly a web address's origin, `scheme://host[:port]` and nothing more:
 * it parses, passes {@link webAddressFault}, and is its own `URL.origin`.
 */
export function isSiteOrigin(origin: string): boolean {
  const address = URL.parse(origin);
  return address !== null && webAddressFault(address) === null && address.origin === origin;
}
