// Which links a terminal may open: a pure rule over a string, so it can be driven with the
// strings an attack would use. Printed text is attacker-controlled whenever the process is,
// so the allow-list is a closed set of two rather than a deny-list.

/** URL schemes a terminal link may be opened with. */
export const TERMINAL_LINK_SCHEMES = ["http:", "https:"] as const;

/**
 * The normalized href a terminal link may be opened at, or `undefined` when it does not parse or
 * its scheme is not allowed. Runs beside the library's `allowNonHttpProtocols: false`: that
 * setting decides which links reach the handler, this decides which the handler acts on.
 */
export function allowedTerminalLinkHref(text: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return undefined;
  }
  return TERMINAL_LINK_SCHEMES.some((scheme) => scheme === parsed.protocol)
    ? parsed.href
    : undefined;
}
