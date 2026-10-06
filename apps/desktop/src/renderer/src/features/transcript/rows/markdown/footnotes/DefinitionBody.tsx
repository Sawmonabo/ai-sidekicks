// One footnote definition's body, or the sentence for one the registry has evicted.

import type { RootContent } from "mdast";

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import {
  MarkdownNodes,
  type MarkdownRenderContext,
} from "#renderer/components/Markdown/MarkdownNodes.js";

/** What one footnote definition is drawn from. */
export interface DefinitionBodyProps {
  readonly bodyNodes: readonly RootContent[] | undefined;
  readonly context: MarkdownRenderContext;
}

/**
 * The recorded definition, or the sentence for one that is gone.
 *
 * The registry answers `undefined` for a definition that has not arrived or was evicted.
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
