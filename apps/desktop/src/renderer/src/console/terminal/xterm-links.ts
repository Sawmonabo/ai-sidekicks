// The two ways a link reaches a person from a terminal, and the one gate both pass.
//
// Its own module rather than a section inside `xterm-adapter.ts`, on
// `link-guard.ts`'s reason: this is `Spec-023 §Console Libraries` constraint 4 in
// its own right — **every activatable link passes the scheme guard** — and both
// halves of it are built here, so the guard cannot be on one path and missing from
// the other.
//
// TWO WAYS, because there are two kinds of link in a terminal and xterm.js handles
// exactly one of them itself. `linkHandler` governs OSC 8 hyperlinks — text a
// program explicitly marked as a link — and governs nothing else, so an ordinary
// `https://…` a shell simply PRINTED was inert: no link provider was registered, and
// a provider is the only thing that turns printed text into something clickable.
// That is the common case, and it was the one that did nothing.
//
// `@xterm/addon-web-links` is the xterm.js project's own answer to it and is ADOPTED
// here rather than reimplemented: its provider carries the buffer index back-mapping
// a hand-written one would have to get right — wrapped lines, early-wrapped wide
// characters, the 2048-character expansion bound — and its default matcher admits
// `http://` and `https://` only, which is the same closed set `link-guard.ts` allows,
// so it decorates nothing the guard would then refuse. The addon's own default
// handler (`window.open`) is never used; the builder below passes its own, and that
// handler runs the guard.

import { WebLinksAddon } from "@xterm/addon-web-links";
import type { ITerminalOptions } from "@xterm/xterm";

import { allowedTerminalLinkHref } from "./link-guard.js";

/** Where an allowed link goes. Absent means links render and never activate. */
export type TerminalLinkSink = ((url: string) => void) | undefined;

/**
 * The OSC 8 half: what the library hands a hyperlink a program marked.
 *
 * `allowNonHttpProtocols` stays false beside the guard rather than in place of it —
 * the library setting decides which links reach the handler, and the guard decides
 * which the handler acts on.
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
 * The printed-URL half: the provider that turns text a shell wrote into a link.
 *
 * Built only for a surface that HAS somewhere to send one — the caller gates on the
 * sink the way it gates `onData` on the writer, because a surface with nowhere to
 * send a link would otherwise underline printed URLs and swallow the click, which is
 * an affordance that lies. The addon is returned rather than held: nothing calls it
 * again, and an addon kept as a field keeps the emulator reachable past disposal,
 * while `Terminal.dispose()` disposes what it loaded.
 */
export function buildTerminalWebLinksAddon(onActivateLink: (url: string) => void): WebLinksAddon {
  return new WebLinksAddon((_event: MouseEvent, uri: string): void => {
    activateAllowedLink(uri, onActivateLink);
  });
}

/**
 * The one place a link reaches the surface that owns the opener.
 *
 * Both paths above end here, so the scheme allow-list is run once against one rule.
 * Two call sites each running their own check is the shape `apps/desktop/AGENTS.md`
 * names: two copies of one normalization that agree until somebody edits one.
 *
 * The href handed on is the PARSED one, so what the opener receives is a normalized
 * URL rather than whatever a program happened to print.
 */
function activateAllowedLink(text: string, onActivateLink: TerminalLinkSink): void {
  const href = allowedTerminalLinkHref(text);
  if (href !== undefined) {
    onActivateLink?.(href);
  }
}
