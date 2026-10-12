// One settled markdown block, memoized and drawn from the tree its body holds for it. Its nodes and
// context are referentially stable across frames, so the comparison skips the whole subtree, a code
// block's span-cache lookups included. A block is drawn only once its tree has landed, so nothing
// unparsed and no empty box is ever shown.

import type { RootContent } from "mdast";
import { memo } from "react";

import {
  MarkdownNodes,
  type MarkdownRenderContext,
} from "#renderer/components/Markdown/MarkdownNodes.js";

/** What one settled block is drawn from. */
export interface SettledBlockProps {
  /** The block's nodes, from the newest tree of it its body holds. */
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
