// One settled markdown block, memoized and parsed when drawn. Its record, text reader, preamble and
// context are referentially stable across frames, so the comparison skips the whole subtree, a code
// block's span-cache lookups included; an unmounted block holds no tree.

import { memo } from "react";

import {
  MarkdownNodes,
  type MarkdownRenderContext,
} from "#renderer/components/Markdown/MarkdownNodes.js";
import { type SettledMarkdownBlock } from "../markdown/body-blocks.js";
import { useSettledBlockNodes } from "./hooks/useSettledBlockNodes.js";

/** What one settled block is drawn from. */
export interface SettledBlockProps {
  readonly block: SettledMarkdownBlock;
  /** Cuts the block's text from its body's, for the parse alone. */
  readonly readBlockSource: (block: SettledMarkdownBlock) => string;
  /** The definitions the whole body declares, which the block is parsed after. */
  readonly definitionPreamble: string;
  readonly context: MarkdownRenderContext;
}

/** One settled block, drawn once and held across the frames that follow it. */
export const SettledBlock: React.MemoExoticComponent<
  (props: SettledBlockProps) => React.JSX.Element
> = memo((props: SettledBlockProps): React.JSX.Element => {
  const nodes = useSettledBlockNodes(props.block, props.readBlockSource, props.definitionPreamble);
  return <MarkdownNodes nodes={nodes} context={props.context} />;
});
SettledBlock.displayName = "SettledBlock";
