// Where a footnote reference finds the host it opens into.
//
// A reference is rendered deep inside a parsed tree, by a mapper that is a pure function
// of that parse and takes no props of its own. The host is one element per card. So the
// two have to meet somewhere, and the choices are a member on `MarkdownRenderContext` or
// a React context.
//
// IT IS A REACT CONTEXT, AND THE REASON IS THE MEMOISATION. `MarkdownRenderContext` is a
// value threaded down as a prop, and `SettledBlock` skips a whole subtree by comparing
// it. Putting the host on it would give every settled block a new context object the
// moment the host changed, which is the one thing that arrangement exists to prevent. A
// React context reaches past `memo` to its own consumers alone — the references — and
// leaves the rest of the tree unrendered.
//
// AND IT IS OPTIONAL. A body rendered with no host around it — the mapper's own tests do
// exactly that — gets `undefined` here and renders the marker inert, which is the honest
// answer: with no host there is nothing to open.

import type { Popover } from "@base-ui/react/popover";
import { createContext, useContext } from "react";

/** What one card's footnote host offers the references inside it. */
export interface FootnoteHostBinding {
  /** The row these definitions were declared in — the registry's first key half. */
  readonly sourceId: string;
  /**
   * The one popup this card opens every definition into.
   *
   * Named here rather than minted per reference because a reference has to point at it
   * with `aria-describedby`, and §5.14 puts ONE host on the surface: a popup per marker
   * would be a host per marker.
   */
  readonly popupId: string;
  /** The handle the host's popup and every reference in the card share. */
  readonly handle: Popover.Handle<string>;
}

const FootnoteHostContext = createContext<FootnoteHostBinding | undefined>(undefined);

/** The provider the host mounts. Exported for it and for nothing else. */
export const FootnoteHostProvider: React.Provider<FootnoteHostBinding | undefined> =
  FootnoteHostContext.Provider;

/** The host around this reference, or `undefined` where a body renders without one. */
export function useFootnoteHost(): FootnoteHostBinding | undefined {
  return useContext(FootnoteHostContext);
}
