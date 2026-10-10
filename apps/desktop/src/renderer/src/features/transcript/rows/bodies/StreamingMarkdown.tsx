// Mounts the markdown pipeline for one body: the block segmenter, two-pass footnote resolution and
// footnote registration. Pass one reads each block alone, once, as it settles, for the footnotes
// it defines; pass two parses a block against the whole body's definitions when it is drawn, so
// `cite[^1]` in one block references `[^1]: ...` in another.
// The published text arrives as a prop rather than a reveal-engine subscription, so a settled
// message, which has no reveal stream, renders through the same path: a handle over a lane's text
// or over a settled string, read in ranges and never held whole. A long body inside a
// transcript viewport is drawn as a window over its blocks, any other whole; a long table in
// either, inside a viewport, is drawn as a window over its rows.

import { useContext } from "react";

import { type MarkdownTableOffer } from "#renderer/components/Markdown/table-offer.js";
import { type PublishedText } from "../../reveal/published-text.js";
import { type FootnoteRegistry } from "../markdown/footnotes/registry.js";
import { MarkdownWindowViewportContext } from "../markdown/block-window/context.js";
import {
  MarkdownBlockIndexContext,
  TableWindowBodyContext,
} from "../markdown/table-window/context.js";
import { useFlowBodyPlacement } from "./hooks/useFlowBodyPlacement.js";
import { useFootnoteDefinitionRegistration } from "./hooks/useFootnoteDefinitionRegistration.js";
import { useMarkdownBodyBlocks } from "./hooks/useMarkdownBodyBlocks.js";
import { useMarkdownRenderContexts } from "./hooks/useMarkdownRenderContexts.js";
import { SettledBlock } from "./SettledBlock.js";
import { VolatileBlock } from "./VolatileBlock.js";
import { WindowedMarkdown } from "./WindowedMarkdown.js";
import { WindowedTable } from "./WindowedTable.js";

/** What one markdown body is drawn from. */
export interface StreamingMarkdownProps {
  /**
   * The text the reveal engine has published for this body, cumulative, through its handle. Never
   * the raw source: the reveal gate decides what is safe to show, and an incomplete construct
   * must not mount.
   */
  readonly publishedText: PublishedText;
  /** The row this body belongs to: the footnote registry's first key half. */
  readonly sourceId: string;
  /** Where this message's footnote definitions are recorded. */
  readonly footnotes: FootnoteRegistry;
  /**
   * Whether the body is finished. A finished body has no volatile tail, so math typesets and
   * highlighting runs; a streaming tail stays volatile even at a block boundary, since the next
   * character can change what it means.
   */
  readonly isComplete: boolean;
  /**
   * Whether code and diagram blocks carry their own copies: an agent's reply does, a person's does
   * not.
   */
  readonly offersBlockCopy: boolean;
}

/**
 * The length from which a body is drawn as a window over its blocks, in characters. Measured, a
 * reply drawn whole holds about 59 elements per thousand characters and a windowed one 100 to 150
 * however long it is, so from 8 KB, some 480 elements, the window draws under a third of them. A
 * shorter body is drawn whole, where the window would spare too little to be worth its wrappers.
 */
const WINDOWED_BODY_MIN_CHARACTERS = 8_192;

/** Renders a markdown body incrementally: settled blocks memoized, the tail parsed per frame. */
export function StreamingMarkdown(props: StreamingMarkdownProps): React.JSX.Element {
  const blocks = useMarkdownBodyBlocks(props.publishedText, props.isComplete);
  // An effect, not a render, so no render mutates a registry that two cards share.
  useFootnoteDefinitionRegistration(blocks, props.footnotes, props.sourceId);
  const viewport = useContext(MarkdownWindowViewportContext);
  const isWindowed =
    viewport !== undefined && props.publishedText.length >= WINDOWED_BODY_MIN_CHARACTERS;
  const contexts = useMarkdownRenderContexts(
    blocks.definedFootnoteIdentifiers,
    props.isComplete,
    props.offersBlockCopy,
    viewport === undefined ? undefined : renderWindowedTable,
  );
  const flowTableBody = useFlowBodyPlacement(
    viewport,
    props.sourceId,
    blocks,
    props.publishedText.length,
  );

  if (isWindowed) {
    return (
      <WindowedMarkdown
        // A replaced history remounts the window with its measurements.
        key={blocks.generation}
        blocks={blocks}
        bodyTextLength={props.publishedText.length}
        contexts={contexts}
        viewport={viewport}
        rowKey={props.sourceId}
      />
    );
  }
  const wholeBody = (
    <div className="meridian-markdown" ref={flowTableBody?.attachBody}>
      {blocks.settledBlocks.map((block, index) => (
        <MarkdownBlockIndexContext key={block.key} value={index}>
          <SettledBlock
            block={block}
            readBlockSource={blocks.readBlockSource}
            definitionPreamble={blocks.definitionPreamble}
            context={contexts.settled}
          />
        </MarkdownBlockIndexContext>
      ))}
      {blocks.volatileTail === "" ? null : (
        <MarkdownBlockIndexContext value={blocks.settledBlocks.length}>
          <VolatileBlock
            source={blocks.volatileTail}
            definitionPreamble={blocks.definitionPreamble}
            context={contexts.volatile}
          />
        </MarkdownBlockIndexContext>
      )}
    </div>
  );
  return flowTableBody === undefined ? (
    wholeBody
  ) : (
    <TableWindowBodyContext value={flowTableBody.tableBody}>{wholeBody}</TableWindowBodyContext>
  );
}

/** A table in a transcript viewport's body, which windows its rows once it is long. */
function renderWindowedTable(offer: MarkdownTableOffer): React.JSX.Element {
  return <WindowedTable offer={offer} />;
}
