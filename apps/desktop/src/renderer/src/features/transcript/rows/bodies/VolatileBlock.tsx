// The unfinished end of a body: everything after its drawn settled blocks, drawn from the newest
// tree its body's tail parser has landed. Nothing is drawn before the first one lands.

import type { RootContent } from "mdast";

import {
  MarkdownNodes,
  type MarkdownRenderContext,
} from "#renderer/components/Markdown/MarkdownNodes.js";

/** What the unfinished end of a body is drawn from. */
export interface VolatileBlockProps {
  /** The tail's nodes, or `undefined` before its first tree lands. */
  readonly nodes: readonly RootContent[] | undefined;
  readonly context: MarkdownRenderContext;
}

/** The body's volatile tail, drawn from its newest tree; nothing before the first one lands. */
export function VolatileBlock(props: VolatileBlockProps): React.JSX.Element | null {
  return props.nodes === undefined || props.nodes.length === 0 ? null : (
    <MarkdownNodes nodes={props.nodes} context={props.context} />
  );
}
