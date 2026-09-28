// One footnote definition's body, mapped out of the nodes the registry recorded.
//
// Its own module for the one-component rule: a definition the registry's bound eviction
// has taken is a settled empty result, and that sentence is the whole of what this file
// decides.

import type { RootContent } from "mdast";

import { Nothing } from "../../../../primitives/index.js";
import { MarkdownNodes, type MarkdownRenderContext } from "../nodes/MarkdownNodes.js";

export interface DefinitionBodyProps {
  readonly bodyNodes: readonly RootContent[] | undefined;
  readonly context: MarkdownRenderContext;
}

/**
 * The recorded definition, or the sentence for one that is gone.
 *
 * The registry answers `undefined` for a definition that has not arrived or that the bound
 * eviction took from the oldest entries. Saying so beats an empty region.
 *
 * @consumedBy the definition drawn at the foot of a reply
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
