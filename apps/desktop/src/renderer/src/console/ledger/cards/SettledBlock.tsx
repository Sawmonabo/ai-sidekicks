// One settled markdown block, memoised.
//
// Its own module for the one-component rule, and the boundary it draws is the reason
// the streaming body stays cheap: a settled block's nodes and context are
// referentially stable across every later frame, so the comparison skips the whole
// subtree — including a code block that would otherwise re-consult the highlight cache
// on every token that arrives after it. `memo` earns its place here and would not on
// the volatile tail, which is re-parsed by construction.

import type { RootContent } from "mdast";
import { memo } from "react";

import { MarkdownNodes, type MarkdownRenderContext } from "./markdown/index.js";

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
