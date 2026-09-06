// One footnote definition's body, mapped out of the nodes the registry recorded.
//
// Its own module for the one-component rule, and the split is where the popup's one
// honest absence stops being buried inside the host that opens it: a definition the
// bound eviction has taken is a settled empty result, and that sentence is the whole
// of what this file decides.

import type { RootContent } from "mdast";

import { Nothing } from "../../../primitives/index.js";
import { MarkdownNodes, type MarkdownRenderContext } from "./MarkdownNodes.js";

export interface DefinitionBodyProps {
  readonly bodyNodes: readonly RootContent[] | undefined;
  readonly context: MarkdownRenderContext;
}

/**
 * The definition the open marker points at, or the sentence for one that is gone.
 *
 * The registry answers `undefined` for a reference whose definition has not arrived, and
 * a marker is only a button once the message has declared one — so reaching that arm
 * means the definition left the registry between the press and the render, which is what
 * the bound eviction can do to the oldest entries. Saying so beats an empty popup.
 *
 * A marker inside this body opens the SAME popup, because the host provider is above it
 * and the payload is the identifier alone: pressing `[^b]` inside `[^a]` swaps the popup
 * to `b`, and pressing `[^a]` inside `[^a]` re-opens `a` — a note that cites itself
 * shows itself, which is the honest answer and needs no special case.
 */
export function DefinitionBody(props: DefinitionBodyProps): React.JSX.Element {
  if (props.bodyNodes === undefined) {
    return (
      <Nothing
        kind="empty"
        placement="inline"
        title="This footnote's definition is no longer held."
      />
    );
  }
  return <MarkdownNodes nodes={props.bodyNodes} context={props.context} />;
}
