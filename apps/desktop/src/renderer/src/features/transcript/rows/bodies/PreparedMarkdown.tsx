// A message's markdown as its row's preparation published it: the text, whether it is finished,
// and the reader of its blocks the preparation read it with, so the body draws on the frame the
// row is listed, from the blocks its row waited on.

import { useContext, useSyncExternalStore } from "react";

import { PreparedBodiesContext } from "../prepared-bodies.js";
import { type FootnoteRegistry } from "../markdown/footnotes/registry.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";

/** Props for `PreparedMarkdown`. */
export interface PreparedMarkdownProps {
  /** The row whose published markdown to draw. */
  readonly sourceId: string;
  readonly footnotes: FootnoteRegistry;
  /** Whether each block offers its own copy control: a reply's do, a person's message's do not. */
  readonly offersBlockCopy: boolean;
}

/**
 * The row's markdown, as its preparation published and read it; empty while none is published.
 * Throws outside a feed, where nothing prepares it.
 */
export function PreparedMarkdown(props: PreparedMarkdownProps): React.JSX.Element | null {
  const preparedBodies = useContext(PreparedBodiesContext);
  if (preparedBodies === undefined) {
    throw new Error(
      "A message's markdown is drawn only inside a transcript feed, which prepares it.",
    );
  }
  const { sourceId } = props;
  const markdownBody = useSyncExternalStore(preparedBodies.subscribe, () =>
    preparedBodies.markdownBodyOf(sourceId),
  );
  if (markdownBody === undefined) {
    return null;
  }
  return (
    <StreamingMarkdown
      publishedText={markdownBody.text}
      sourceId={sourceId}
      footnotes={props.footnotes}
      isComplete={markdownBody.isComplete}
      bodyBlocks={markdownBody.blocks}
      offersBlockCopy={props.offersBlockCopy}
    />
  );
}
