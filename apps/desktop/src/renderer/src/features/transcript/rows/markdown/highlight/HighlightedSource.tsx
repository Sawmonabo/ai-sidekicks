// A code block's source with the daemon's color spans painted over it. Spans paint as classes that
// read theme tokens, so a scheme switch repaints in place; text between spans stays text, so
// nothing moves when the colors arrive.

import {
  HIGHLIGHT_SPAN_CLASSES,
  HIGHLIGHT_SPAN_WIDTH,
  type HighlightLanguage,
} from "@ai-sidekicks/contracts";

import { useCodeSpans } from "./hooks/useCodeSpans.js";

/** What one colored source is drawn from. */
export interface HighlightedSourceProps {
  readonly source: string;
  readonly language: HighlightLanguage;
}

/** The source with its color spans painted, or plain until the spans arrive. */
export function HighlightedSource(props: HighlightedSourceProps): React.JSX.Element {
  const spans = useCodeSpans(props.source, props.language);
  return <>{spans === undefined ? props.source : paintSpans(props.source, spans)}</>;
}

/**
 * The source cut at its spans' edges, each span wrapped in its class.
 *
 * Offsets and lengths count UTF-16 code units, the unit `slice` cuts in, so a character
 * outside the basic plane before a span moves nothing after it.
 */
function paintSpans(source: string, spans: Uint32Array): React.ReactNode[] {
  const painted: React.ReactNode[] = [];
  let cursor = 0;
  for (let index = 0; index < spans.length; index += HIGHLIGHT_SPAN_WIDTH) {
    const offset = spans[index] ?? 0;
    const end = offset + (spans[index + 1] ?? 0);
    const spanClass = HIGHLIGHT_SPAN_CLASSES[spans[index + 2] ?? 0];
    if (offset > cursor) {
      painted.push(source.slice(cursor, offset));
    }
    painted.push(
      // The index is the span's identity: the list is replaced whole, never reordered.
      <span key={index} className={`meridian-code__${String(spanClass)}`}>
        {source.slice(offset, end)}
      </span>,
    );
    cursor = end;
  }
  if (cursor < source.length) {
    painted.push(source.slice(cursor));
  }
  return painted;
}
