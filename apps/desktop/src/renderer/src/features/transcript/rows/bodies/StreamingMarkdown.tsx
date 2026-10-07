// Mounts the markdown pipeline for one body: the block segmenter, two-pass footnote resolution and
// footnote registration. Pass one reads each block alone, once, as it settles, for the footnotes
// it defines; pass two parses a block against the whole body's definitions when it is drawn, so
// `cite[^1]` in one block references `[^1]: ...` in another.
// The published text arrives as a prop rather than a reveal-engine subscription, so a settled
// message, which has no reveal stream, renders through the same path. A long body inside a
// transcript viewport is drawn as a window over its blocks; any other is drawn whole.

import { useContext } from "react";

import { type FootnoteRegistry } from "../markdown/footnotes/registry.js";
import { MarkdownWindowViewportContext } from "../markdown/block-window/context.js";
import { useFootnoteDefinitionRegistration } from "./hooks/useFootnoteDefinitionRegistration.js";
import { useMarkdownBodyBlocks } from "./hooks/useMarkdownBodyBlocks.js";
import { useMarkdownRenderContexts } from "./hooks/useMarkdownRenderContexts.js";
import { SettledBlock } from "./SettledBlock.js";
import { VolatileBlock } from "./VolatileBlock.js";
import { WindowedMarkdown } from "./WindowedMarkdown.js";

/** What one markdown body is drawn from. */
export interface StreamingMarkdownProps {
  /**
   * The text the reveal engine has published for this body, cumulative. Never the raw source:
   * the reveal gate decides what is safe to show, and an incomplete construct must not mount.
   */
  readonly publishedText: string;
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
  /** Whether each code block carries its own Copy: an agent's reply does, a person's does not. */
  readonly offersCodeCopy: boolean;
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
  const contexts = useMarkdownRenderContexts(
    blocks.definedFootnoteIdentifiers,
    props.isComplete,
    props.offersCodeCopy,
  );
  const viewport = useContext(MarkdownWindowViewportContext);

  if (viewport !== undefined && props.publishedText.length >= WINDOWED_BODY_MIN_CHARACTERS) {
    return (
      <WindowedMarkdown
        // A replaced history remounts the window with its measurements.
        key={blocks.generation}
        blocks={blocks}
        contexts={contexts}
        viewport={viewport}
        rowKey={props.sourceId}
      />
    );
  }
  return (
    <div className="meridian-markdown">
      {blocks.settledBlocks.map((block) => (
        <SettledBlock
          key={block.key}
          source={block.source}
          definitionPreamble={blocks.definitionPreamble}
          context={contexts.settled}
        />
      ))}
      {blocks.volatileTail === "" ? null : (
        <VolatileBlock
          source={blocks.volatileTail}
          definitionPreamble={blocks.definitionPreamble}
          context={contexts.volatile}
        />
      )}
    </div>
  );
}
