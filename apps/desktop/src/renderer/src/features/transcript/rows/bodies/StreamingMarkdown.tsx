// Mounts the markdown pipeline for one body: the block segmenter, two-pass footnote resolution
// and footnote registration. Block boundaries and settling are decided in the shared renderer,
// `components/Markdown/`.
// The published text arrives as a prop rather than a reveal-engine subscription, so a settled
// message, which has no reveal stream, renders through the same path.

import type { RootContent } from "mdast";
import { useEffect, useMemo, useRef } from "react";

import { collectFootnoteDefinitions } from "#renderer/components/Markdown/footnotes/footnote-collection.js";
import { type FootnoteRegistry } from "../markdown/footnotes/footnote-registry.js";
import {
  MarkdownNodes,
  type MarkdownRenderContext,
} from "#renderer/components/Markdown/MarkdownNodes.js";
import { MarkdownBlockSegmenter } from "../markdown/parse/block-segmenter.js";
import {
  footnoteDefinitionPreamble,
  parseSettledBlock,
  parseVolatileTail,
} from "#renderer/components/Markdown/parse/markdown-parse.js";
import { useCodeSpanReader } from "#renderer/services/highlight/hooks/useCodeSpanReader.js";
import { SettledBlock } from "./SettledBlock.js";

/**
 * The empty node list, once: a fresh `[]` per render would give a body with no tail a new prop
 * identity on every frame and defeat the memoization below.
 */
const NO_NODES: readonly RootContent[] = Object.freeze([]);

/** The registration state of a freshly mounted body. */
const NO_NODE_LISTS: readonly (readonly RootContent[])[] = Object.freeze([]);

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
}

/** Renders a markdown body incrementally: settled blocks memoized, the tail re-parsed. */
export function StreamingMarkdown(props: StreamingMarkdownProps): React.JSX.Element {
  const segmentation = useBlockSegmentation(props.publishedText, props.isComplete);

  // Pass one, what the body declares, reading each block alone. A definition is found in its
  // own block, but GFM leaves `[^1]` literal in a block with no matching definition, hence
  // pass two.
  const declaredSettledNodeLists = useMemo(
    () => segmentation.settledBlocks.map((block) => parseSettledBlock(block).children),
    [segmentation.settledBlocks],
  );
  const declaredVolatileNodes = useMemo(
    () =>
      segmentation.volatileTail === ""
        ? NO_NODES
        : parseVolatileTail(segmentation.volatileTail).children,
    [segmentation.volatileTail],
  );

  const definedFootnoteIdentifiers = useMemo(
    () => collectDefinedIdentifiers(declaredSettledNodeLists, declaredVolatileNodes),
    [declaredSettledNodeLists, declaredVolatileNodes],
  );
  const definitionPreamble = useMemo(
    () => footnoteDefinitionPreamble(definedFootnoteIdentifiers),
    [definedFootnoteIdentifiers],
  );

  // Pass two: the same blocks read against the whole body's definitions, so `cite[^1]` in one
  // block references `[^1]: ...` in another. With no footnotes the preamble is empty and these
  // are the pass-one arrays.
  const settledNodeLists = useMemo(
    () =>
      definitionPreamble === ""
        ? declaredSettledNodeLists
        : segmentation.settledBlocks.map(
            (block) => parseSettledBlock(block, definitionPreamble).children,
          ),
    [definitionPreamble, declaredSettledNodeLists, segmentation.settledBlocks],
  );
  const volatileNodes = useMemo(
    () =>
      definitionPreamble === "" || segmentation.volatileTail === ""
        ? declaredVolatileNodes
        : parseVolatileTail(segmentation.volatileTail, definitionPreamble).children,
    [segmentation.volatileTail, definitionPreamble, declaredVolatileNodes],
  );

  const codeSpanReader = useCodeSpanReader();
  const settledContext = useMemo<MarkdownRenderContext>(
    () => ({ isSettled: true, definedFootnoteIdentifiers, codeSpanReader }),
    [definedFootnoteIdentifiers, codeSpanReader],
  );
  const volatileContext = useMemo<MarkdownRenderContext>(
    () => ({ isSettled: props.isComplete, definedFootnoteIdentifiers, codeSpanReader }),
    [props.isComplete, definedFootnoteIdentifiers, codeSpanReader],
  );

  // An effect, not a render, so no render mutates a registry that two cards share.
  useFootnoteDefinitionRegistration({
    settledNodeLists,
    volatileNodes,
    footnotes: props.footnotes,
    sourceId: props.sourceId,
  });

  return (
    <div className="meridian-markdown">
      {segmentation.settledBlocks.map((block, index) => (
        <SettledBlock
          key={settledBlockKey(block, index)}
          nodes={settledNodeLists[index] ?? NO_NODES}
          context={settledContext}
        />
      ))}
      {volatileNodes.length === 0 ? null : (
        <MarkdownNodes nodes={volatileNodes} context={volatileContext} />
      )}
    </div>
  );
}

/**
 * One settled block's key: its position in the committed prefix plus its own text. Position
 * keeps a repeated paragraph unique among siblings; the text makes the key content-addressed,
 * so a rebase remounts instead of pouring new content into old elements. The prefix is
 * append-only, so a block's key never changes as later blocks settle.
 */
function settledBlockKey(block: string, positionInPrefix: number): string {
  return `${String(positionInPrefix)}:${block}`;
}

/**
 * The split for this snapshot, from a segmenter that survives the frame.
 *
 * A hook because construction belongs in a hook, not a render body. `segment` is idempotent for
 * a repeated snapshot, so calling it in render is safe; memoizing on the snapshot keeps every
 * derived identity stable across re-renders the text did not change in.
 */
function useBlockSegmentation(
  publishedText: string,
  isComplete: boolean,
): ReturnType<MarkdownBlockSegmenter["segment"]> {
  const segmenterRef = useRef<MarkdownBlockSegmenter | undefined>(undefined);
  segmenterRef.current ??= new MarkdownBlockSegmenter();
  const segmenter = segmenterRef.current;
  return useMemo(
    () => segmenter.segment(publishedText, { isFinal: isComplete }),
    [segmenter, publishedText, isComplete],
  );
}

/**
 * Records every footnote definition this body declares. It runs when the content changes, not on
 * every render, and re-walks only the settled blocks whose node arrays differ from last time;
 * the volatile tail is re-parsed each frame, so it is always walked.
 */
function useFootnoteDefinitionRegistration(input: {
  readonly settledNodeLists: readonly (readonly RootContent[])[];
  readonly volatileNodes: readonly RootContent[];
  readonly footnotes: FootnoteRegistry;
  readonly sourceId: string;
}): void {
  const { footnotes, settledNodeLists, sourceId, volatileNodes } = input;
  const registeredSettledNodeLists = useRef<readonly (readonly RootContent[])[]>(NO_NODE_LISTS);
  useEffect(() => {
    const alreadyRegistered = registeredSettledNodeLists.current;
    for (const [index, nodes] of settledNodeLists.entries()) {
      if (alreadyRegistered[index] === nodes) {
        continue;
      }
      registerDefinitionsIn(nodes, footnotes, sourceId);
    }
    registeredSettledNodeLists.current = settledNodeLists;
    registerDefinitionsIn(volatileNodes, footnotes, sourceId);
  }, [settledNodeLists, volatileNodes, footnotes, sourceId]);
}

/** One block's definitions, into the registry under this body's own source. */
function registerDefinitionsIn(
  nodes: readonly RootContent[],
  footnotes: FootnoteRegistry,
  sourceId: string,
): void {
  for (const definition of collectFootnoteDefinitions(nodes).definitions) {
    footnotes.register({
      sourceId,
      identifier: definition.identifier,
      bodyNodes: definition.children,
    });
  }
}

/** Every footnote identifier defined anywhere in this body. */
function collectDefinedIdentifiers(
  settledNodeLists: readonly (readonly RootContent[])[],
  volatileNodes: readonly RootContent[],
): ReadonlySet<string> {
  const identifiers = new Set<string>();
  for (const nodes of [...settledNodeLists, volatileNodes]) {
    for (const identifier of collectFootnoteDefinitions(nodes).definedIdentifiers) {
      identifiers.add(identifier);
    }
  }
  return identifiers;
}
