// Which links a terminal may open, and nothing else.
//
// Its own module rather than a section inside `xterm-adapter.ts`, for
// `renderer-pool.ts`'s reason: this is a pure rule over a string, it is one of the
// wrapper's five `Spec-023 §Console Libraries` constraints in its own right, and a
// security rule that can be driven with the strings an attack would use is worth
// more than one reachable only through a mouse event nobody can dispatch.
//
// A terminal renders whatever a process writes, so the printed text is
// attacker-controlled whenever the process is. That is why the allow-list is a
// closed set of two rather than a deny-list of the schemes anybody has thought of.

/** URL schemes a terminal link may be activated with. Closed, and short. */
export const TERMINAL_LINK_SCHEMES = ["http:", "https:"] as const;

/**
 * The href a terminal link may be opened at, or `undefined` for one that may not.
 *
 * Ours, beside the library's `allowNonHttpProtocols: false`. Two guards because a
 * program controls what it prints: the library setting decides which links reach
 * the handler, and this decides which the handler acts on.
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
