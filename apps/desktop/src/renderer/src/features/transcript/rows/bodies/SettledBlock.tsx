// One settled markdown block, memoized. Its nodes and context are referentially stable across
// frames, so the comparison skips the whole subtree, including a code block's span-cache lookups.

import type { RootContent } from "mdast";
import { memo } from "react";

import { MarkdownNodes, type MarkdownRenderContext } from "../markdown/nodes/MarkdownNodes.js";

/** What one settled block is drawn from. */
export interface SettledBlockProps {
  readonly nodes: readonly RootContent[];
  readonly context: MarkdownRenderContext;
}

/** One settled block, drawn once and held across the frames that follow it. */
export const SettledBlock: React.MemoExoticComponent<
  (props: SettledBlockProps) => React.JSX.Element
> = memo(
  (props: SettledBlockProps): React.JSX.Element => (
    <MarkdownNodes nodes={props.nodes} context={props.context} />
  ),
);
SettledBlock.displayName = "SettledBlock";
