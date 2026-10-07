// One settled markdown block, memoized and parsed when drawn. Its text, preamble and context are
// referentially stable across frames, so the comparison skips the whole subtree, a code block's
// span-cache lookups included; an unmounted block holds no tree.

import { memo } from "react";

import {
  MarkdownNodes,
  type MarkdownRenderContext,
} from "#renderer/components/Markdown/MarkdownNodes.js";
import { useSettledBlockNodes } from "./hooks/useSettledBlockNodes.js";

/** What one settled block is drawn from. */
export interface SettledBlockProps {
  readonly source: string;
  /** The definitions the whole body declares, which the block is parsed after. */
  readonly definitionPreamble: string;
  readonly context: MarkdownRenderContext;
}

/** One settled block, drawn once and held across the frames that follow it. */
export const SettledBlock: React.MemoExoticComponent<
  (props: SettledBlockProps) => React.JSX.Element
> = memo((props: SettledBlockProps): React.JSX.Element => {
  const nodes = useSettledBlockNodes(props.source, props.definitionPreamble);
  return <MarkdownNodes nodes={nodes} context={props.context} />;
});
SettledBlock.displayName = "SettledBlock";
