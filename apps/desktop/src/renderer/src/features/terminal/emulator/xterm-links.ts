// The two ways a link reaches a person from a terminal, and the one gate both pass.
//
// `linkHandler` governs only OSC 8 hyperlinks a program marked; a URL a shell merely printed
// needs a link provider. `@xterm/addon-web-links` supplies one (it handles wrapped lines and
// wide characters and matches only `http://` and `https://`, the set `link-guard.ts` allows),
// with its default `window.open` handler replaced so both paths run the scheme guard.

import { WebLinksAddon } from "@xterm/addon-web-links";
import type { ITerminalOptions } from "@xterm/xterm";

import { allowedTerminalLinkHref } from "./link-guard.js";

/** Where an allowed link goes; `undefined` means links render and never activate. */
export type TerminalLinkSink = ((url: string) => void) | undefined;

/**
 * The OSC 8 half: the library's handler for hyperlinks a program marked. `allowNonHttpProtocols`
 * stays false beside the guard: it decides which links reach the handler, the guard which the
 * handler acts on.
 */
export function buildTerminalLinkHandler(
  onActivateLink: TerminalLinkSink,
): NonNullable<ITerminalOptions["linkHandler"]> {
  return {
    // The library's own gate: a non-HTTP link never reaches `activate`.
    allowNonHttpProtocols: false,
    activate: (_event: MouseEvent, text: string): void => {
      activateAllowedLink(text, onActivateLink);
    },
  };
}

/**
 * The printed-URL half: a link provider for text a shell wrote, built only for a terminal that
 * has somewhere to send a link (otherwise printed URLs would be underlined and their clicks
 * swallowed). Returned rather than stored: `Terminal.dispose()` disposes what it loaded, and a
 * kept reference would hold the emulator past disposal.
 */
export function buildTerminalWebLinksAddon(onActivateLink: (url: string) => void): WebLinksAddon {
  return new WebLinksAddon((_event: MouseEvent, uri: string): void => {
    activateAllowedLink(uri, onActivateLink);
  });
}

/**
 * The one place a link reaches the opener, so the scheme allow-list runs once for both paths.
 * The href handed on is the parsed, normalized one, not the printed text.
 */
function activateAllowedLink(text: string, onActivateLink: TerminalLinkSink): void {
  const href = allowedTerminalLinkHref(text);
  if (href !== undefined) {
    onActivateLink?.(href);
  }
}
