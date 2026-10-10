// The unfinished end of a body: everything after its settled blocks, parsed again each frame the
// reveal releases text, extending the last parse where the new text only appends to it.

import {
  MarkdownNodes,
  type MarkdownRenderContext,
} from "#renderer/components/Markdown/MarkdownNodes.js";
import { useVolatileTailNodes } from "./hooks/useVolatileTailNodes.js";

/** What the unfinished end of a body is drawn from. */
export interface VolatileBlockProps {
  readonly source: string;
  /** The definitions the whole body declares, which the tail is parsed after. */
  readonly definitionPreamble: string;
  readonly context: MarkdownRenderContext;
}

/** The body's volatile tail, every character the reveal released drawn on the frame it arrived. */
export function VolatileBlock(props: VolatileBlockProps): React.JSX.Element | null {
  const nodes = useVolatileTailNodes(props.source, props.definitionPreamble);
  return nodes.length === 0 ? null : <MarkdownNodes nodes={nodes} context={props.context} />;
}
