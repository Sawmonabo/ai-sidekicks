// A long markdown body drawn as a window over its blocks: only the blocks near the conversation's
// viewport are mounted, so the body's elements stay bounded however long it grows. Each drawn
// block sits in flow in a plain wrapper, so it looks and selects exactly as the whole body draws
// it; an empty spacer holds the room of each run of blocks that is not drawn.

import { type MarkdownRenderContexts } from "./hooks/useMarkdownRenderContexts.js";
import { useBlockWindow } from "./hooks/useBlockWindow.js";
import { type MarkdownBodyBlocksSnapshot } from "../markdown/body-blocks.js";
import { type MarkdownWindowViewport } from "../markdown/block-window/context.js";
import {
  MARKDOWN_BLOCK_INDEX_ATTRIBUTE,
  MARKDOWN_FINAL_BLOCK_ATTRIBUTE,
} from "../markdown/block-window/markers.js";
import { SettledBlock } from "./SettledBlock.js";
import { VolatileBlock } from "./VolatileBlock.js";

/** What a windowed body is drawn from. */
export interface WindowedMarkdownProps {
  readonly blocks: MarkdownBodyBlocksSnapshot;
  readonly contexts: MarkdownRenderContexts;
  /** The viewport the body is drawn in; held for the body's life. */
  readonly viewport: MarkdownWindowViewport;
  /** The row the body belongs to; held for the body's life. */
  readonly rowKey: string;
}

/** A long body, drawn block by block where the reader can see it. */
export function WindowedMarkdown(props: WindowedMarkdownProps): React.JSX.Element {
  const { blocks, contexts } = props;
  const blockWindow = useBlockWindow(blocks, props.viewport, props.rowKey);
  return (
    <div className="meridian-markdown" ref={blockWindow.attachBody}>
      {blockWindow.rows.map((row) => {
        if (row.kind === "spacer") {
          return <div key={row.key} aria-hidden="true" style={{ height: `${row.heightPx}px` }} />;
        }
        const block = blocks.settledBlocks[row.index];
        return (
          <div
            key={row.key}
            ref={blockWindow.attachBlock}
            {...{ [MARKDOWN_BLOCK_INDEX_ATTRIBUTE]: row.index }}
            {...(row.isFinal ? { [MARKDOWN_FINAL_BLOCK_ATTRIBUTE]: "" } : {})}
          >
            {block === undefined ? (
              <VolatileBlock
                source={blocks.volatileTail}
                definitionPreamble={blocks.definitionPreamble}
                context={contexts.volatile}
              />
            ) : (
              <SettledBlock
                block={block}
                readBlockSource={blocks.readBlockSource}
                definitionPreamble={blocks.definitionPreamble}
                context={contexts.settled}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
