// Streaming markdown — the committed-and-volatile split, mounted.
//
// `Spec-023 §Console Design (Meridian)` §5.14: "Markdown renders through a committed and
// volatile split: the committed prefix is memoized and stable, the volatile tail is the
// reveal engine's, and an incomplete construct never mounts."
//
// WHAT THIS COMPONENT IS AND IS NOT. It is the mount point for the pipeline under
// `markdown/`, and it holds exactly two things: the segmenter, whose split has to survive
// across frames, and the footnote registration effect. Every decision — where a block
// ends, what settles, what `remend` closes, which fence is deferred — belongs to a module
// there, so this file has no rule of its own to get wrong.
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

import type { RootContent } from "mdast";
import { memo, useEffect, useMemo, useRef } from "react";

import {
  MarkdownBlockSegmenter,
  MarkdownNodes,
  collectFootnoteDefinitions,
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
  const segmentation = useBlockSegmentation(props.publishedText);

  const settledNodeLists = segmentation.settledBlocks.map(
    (block) => parseSettledBlock(block).children,
  );
  const volatileNodes = useMemo(
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
    () => collectDefinedIdentifiers(settledNodeLists, volatileNodes),
    [props.publishedText, volatileNodes],
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
    <div className="meridian-markdown">
      {segmentation.settledBlocks.map((block, index) => (
        <SettledBlock
          key={block}
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
 * The split for this snapshot, from a segmenter that survives the frame.
 *
 * A hook rather than a `useRef` in the component body, because
 * `apps/desktop/AGENTS.md` puts construction in a class or a hook and never in a render.
 * The segmenter's own `segment` is idempotent for a repeated snapshot, which is what
 * makes calling it during render safe under a double-invoked render.
 */
function useBlockSegmentation(
  publishedText: string,
): ReturnType<MarkdownBlockSegmenter["segment"]> {
  const segmenterRef = useRef<MarkdownBlockSegmenter | undefined>(undefined);
  segmenterRef.current ??= new MarkdownBlockSegmenter();
  return segmenterRef.current.segment(publishedText);
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
