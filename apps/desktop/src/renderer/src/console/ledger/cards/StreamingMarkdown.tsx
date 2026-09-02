// Streaming markdown — the committed-and-volatile split, mounted.
//
// `Spec-023 §Console Design (Meridian)` §5.14: "Markdown renders through a committed and
// volatile split: the committed prefix is memoized and stable, the volatile tail is the
// reveal engine's, and an incomplete construct never mounts."
//
// WHAT THIS COMPONENT IS AND IS NOT. It is the mount point for the pipeline under
// `markdown/`, and it holds exactly three things: the segmenter, whose split has to
// survive across frames; the two-pass footnote resolution, which is here because only
// this file sees every block of one body at once; and the footnote registration effect.
// Every decision — where a block ends, what settles, what `remend` closes, which fence
// is deferred, what a preamble looks like — belongs to a module there, so this file has
// no rule of its own to get wrong.
//
// THE TWO PASSES, AND WHY THERE ARE TWO. A block is parsed as its own document, so a
// footnote is the one construct whose meaning is not local to it: `[^1]` resolves only
// against a definition in the SAME parse, and in a long message the citation settles
// blocks before `[^1]: …` arrives. Pass one reads each block alone and collects what the
// body declares; pass two re-reads each block with those identifiers restated ahead of
// it. A body with no footnotes has an empty preamble and pass two IS pass one.
//
// IT DOES NOT SUBSCRIBE TO THE REVEAL ENGINE. `ledger/frame/reveal-engine.ts` publishes
// text per lane and the ledger's viewport is what reads it; a card that subscribed would
// be a second subscriber to one fact and would re-render on frames its own text did not
// change in. The published text arrives as a prop, which is also what lets a settled
// message — one with no lane at all — render through the identical path.
//
// THE MEMOISATION IS WHERE IT PAYS. A settled block's parse is cached by its own text, so
// its node array is referentially stable across every later frame and `SettledBlock`'s
// comparison is a pointer check that skips the whole subtree. Under
// `Spec-023 §References` D.2's measurements that is the difference between 0.30–1.31 ms
// per frame and a re-parse linear in the whole message.
//
// THE KEY RULE, WHICH THE MEMOISATION RESTS ON. A settled block is keyed by its POSITION
// in the committed prefix together with its own text. The position is what makes the key
// unique — a message that repeats a paragraph or a command snippet, which is the ordinary
// case for logs, would otherwise give two siblings one key and React would warn and reuse
// one subtree for both. The text is what makes it CONTENT-ADDRESSED, so a rebase, which
// re-derives the whole prefix from a different history, remounts rather than pouring new
// content into the old message's elements.
//
// AND THE PROPERTY BOTH HALVES BUY: a settled block's key never changes as blocks move
// from the volatile tail into the prefix. The prefix is append-only — the segmenter grows
// `#completeBlocks` at the end and slices from the front — so block N stays at index N for
// as long as the message does, and the settling of a later block moves nothing.

import type { RootContent } from "mdast";
import { memo, useEffect, useMemo, useRef } from "react";

import {
  FootnotePopoverHost,
  MarkdownBlockSegmenter,
  MarkdownNodes,
  collectFootnoteDefinitions,
  collectFootnoteReferences,
  footnoteDefinitionPreamble,
  parseSettledBlock,
  parseVolatileTail,
  type FootnoteRegistry,
  type MarkdownRenderContext,
} from "./markdown/index.js";

/**
 * The empty node list, once.
 *
 * A fresh `[]` per render would give the volatile mapper a new prop identity on every
 * frame of a body that has no tail — which is exactly the memo defeat this file is
 * arranged to avoid. A frozen empty array is a value, not the module-level mutable state
 * `apps/desktop/AGENTS.md` rejects.
 */
const NO_NODES: readonly RootContent[] = Object.freeze([]);

/** No uncited definitions, once — a streaming body allocates none asking. */
const NO_IDENTIFIERS: readonly string[] = Object.freeze([]);

export interface StreamingMarkdownProps {
  /**
   * The text the reveal engine has published for this body, cumulative.
   *
   * Never the raw source: what is safe to show is the reveal gate's decision, and a card
   * that reached past it would mount the incomplete constructs §5.14 forbids.
   */
  readonly publishedText: string;
  /** The row this body belongs to — the footnote registry's first key half. */
  readonly sourceId: string;
  /** Where this message's footnote definitions are recorded. */
  readonly footnotes: FootnoteRegistry;
  /**
   * Whether the body is finished.
   *
   * A finished body has no volatile tail: every block settles, so math typesets and
   * highlighting runs. A streaming body keeps its tail volatile even when the tail
   * happens to end at a block boundary, because the next character can still change what
   * that boundary means.
   */
  readonly isComplete: boolean;
}

export function StreamingMarkdown(props: StreamingMarkdownProps): React.JSX.Element {
  const segmentation = useBlockSegmentation(props.publishedText, props.isComplete);

  // PASS ONE — what the body DECLARES, from each block read on its own.
  //
  // A definition is discoverable in its own block with nothing in scope: `[^1]: …` is a
  // definition wherever it lands. A REFERENCE is not — GFM leaves `[^1]` as literal
  // characters in a block holding no matching definition — which is why there is a
  // second pass at all rather than one walk over these same trees.
  const declaredSettledNodeLists = segmentation.settledBlocks.map(
    (block) => parseSettledBlock(block).children,
  );
  const declaredVolatileNodes = useMemo(
    () =>
      segmentation.volatileTail === ""
        ? NO_NODES
        : parseVolatileTail(segmentation.volatileTail).children,
    [segmentation.volatileTail],
  );

  // Keyed on the published text rather than on the node arrays: the text determines both
  // splits, and the arrays are rebuilt per render even when their contents are the cached
  // ones, so depending on them would recompute the set — and every context below it — on
  // every frame.
  const definedFootnoteIdentifiers = useMemo(
    () => collectDefinedIdentifiers(declaredSettledNodeLists, declaredVolatileNodes),
    [props.publishedText, declaredVolatileNodes],
  );
  const definitionPreamble = useMemo(
    () => footnoteDefinitionPreamble(definedFootnoteIdentifiers),
    [definedFootnoteIdentifiers],
  );

  // PASS TWO — the same blocks read against the WHOLE body's definitions, which is what
  // makes `cite[^1]` in one block a reference to `[^1]: …` in another. A body declaring
  // no footnotes has an empty preamble, so these are the pass-one arrays unchanged: same
  // cache entries, same identities, same cost.
  const settledNodeLists =
    definitionPreamble === ""
      ? declaredSettledNodeLists
      : segmentation.settledBlocks.map(
          (block) => parseSettledBlock(block, definitionPreamble).children,
        );
  const volatileNodes = useMemo(
    () =>
      definitionPreamble === "" || segmentation.volatileTail === ""
        ? declaredVolatileNodes
        : parseVolatileTail(segmentation.volatileTail, definitionPreamble).children,
    [segmentation.volatileTail, definitionPreamble, declaredVolatileNodes],
  );

  // Asked of a FINISHED body only. On a streaming one a definition ahead of its own
  // reference is the ordinary case, so the answer would be wrong — and the walk is deep,
  // unlike the definition walk beside it, so asking per frame would be the re-parse the
  // committed-and-volatile split exists to avoid.
  const uncitedFootnoteIdentifiers = useMemo(
    () =>
      props.isComplete ? uncitedIdentifiersOf(settledNodeLists, volatileNodes) : NO_IDENTIFIERS,
    // `settledNodeLists` is rebuilt per render from a cache and is deliberately not a
    // dependency, for the reason the registration effect below gives.
    [props.publishedText, volatileNodes, props.isComplete],
  );

  const settledContext = useMemo<MarkdownRenderContext>(
    () => ({ isSettled: true, definedFootnoteIdentifiers }),
    [definedFootnoteIdentifiers],
  );
  const volatileContext = useMemo<MarkdownRenderContext>(
    () => ({ isSettled: props.isComplete, definedFootnoteIdentifiers }),
    [props.isComplete, definedFootnoteIdentifiers],
  );

  // Registration is an effect and not a render, so the mapper stays a pure function of the
  // parse and no render mutates a registry two cards share.
  const { footnotes, sourceId } = props;
  useEffect(() => {
    for (const nodes of [...settledNodeLists, volatileNodes]) {
      for (const definition of collectFootnoteDefinitions(nodes).definitions) {
        footnotes.register({
          sourceId,
          identifier: definition.identifier,
          bodyNodes: definition.children,
        });
      }
    }
    // `settledNodeLists` is rebuilt per render from a cache, so it is deliberately NOT a
    // dependency: depending on it would run this effect every frame. The published text is
    // what decides its contents, and that is the dependency this effect keys on.
  }, [props.publishedText, volatileNodes, footnotes, sourceId, settledNodeLists]);

  return (
    <FootnotePopoverHost
      sourceId={props.sourceId}
      footnotes={props.footnotes}
      uncitedIdentifiers={uncitedFootnoteIdentifiers}
    >
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
    </FootnotePopoverHost>
  );
}

/**
 * One settled block's identity among its siblings. See this file's header for the rule.
 *
 * The position comes first so the cheap half of the comparison decides most of them: two
 * keys differ at their first character unless the blocks are at the same index, and only
 * then does the block's own text have to be walked.
 */
function settledBlockKey(block: string, positionInPrefix: number): string {
  return `${String(positionInPrefix)}:${block}`;
}

/**
 * The split for this snapshot, from a segmenter that survives the frame.
 *
 * A hook rather than a `useRef` in the component body, because
 * `apps/desktop/AGENTS.md` puts construction in a class or a hook and never in a render.
 * The segmenter's own `segment` is idempotent for a repeated snapshot, which is what
 * makes calling it during render safe under a double-invoked render.
 */
function useBlockSegmentation(
  publishedText: string,
  isComplete: boolean,
): ReturnType<MarkdownBlockSegmenter["segment"]> {
  const segmenterRef = useRef<MarkdownBlockSegmenter | undefined>(undefined);
  segmenterRef.current ??= new MarkdownBlockSegmenter();
  return segmenterRef.current.segment(publishedText, { isFinal: isComplete });
}

/**
 * The definitions this body declared that nothing in it points at.
 *
 * Both halves are read from the same nodes in one pass over the body, so the two sets
 * can never be answers about different snapshots — which is the same reason the
 * definitions and the defined-identifier set are collected by one walk.
 */
function uncitedIdentifiersOf(
  settledNodeLists: readonly (readonly RootContent[])[],
  volatileNodes: readonly RootContent[],
): readonly string[] {
  const defined = collectDefinedIdentifiers(settledNodeLists, volatileNodes);
  if (defined.size === 0) {
    return NO_IDENTIFIERS;
  }
  const referenced = new Set<string>();
  for (const nodes of [...settledNodeLists, volatileNodes]) {
    for (const identifier of collectFootnoteReferences(nodes)) {
      referenced.add(identifier);
    }
  }
  return [...defined].filter((identifier) => !referenced.has(identifier));
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

/**
 * One settled block, memoised.
 *
 * `memo` earns its place here and would not on the volatile tail: a settled block's nodes
 * and context are referentially stable across every later frame, so the comparison skips
 * the whole subtree — including a code block that would otherwise re-consult the
 * highlight cache on every token that arrives after it.
 */
const SettledBlock = memo(function SettledBlock(props: {
  readonly nodes: readonly RootContent[];
  readonly context: MarkdownRenderContext;
}): React.JSX.Element {
  return <MarkdownNodes nodes={props.nodes} context={props.context} />;
});
