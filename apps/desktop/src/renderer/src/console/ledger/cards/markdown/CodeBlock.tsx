// A fenced code block, and the console's own span renderer for it.
//
// `Spec-023 §Console Libraries` puts "own span renderer" on the syntax-highlighting row
// and AVOIDs every library whose output is an HTML string. Both halves are the same
// decision: a highlighter that hands back markup has to be trusted or sanitised, and the
// one thing this console will not do with model output is parse it as markup. Tokens are
// data — content and a family — and the spans are built from them, so there is no
// `dangerouslySetInnerHTML` on this path and nothing to sanitise.
//
// THE STATES A BLOCK PASSES THROUGH, and why none of them is a spinner. A code block is
// legible the instant it arrives; highlighting is an improvement on legible text, not a
// precondition for it. So the block renders its source immediately, in mono, and the
// spans are swapped in when the tokens arrive. A reader never sees an empty box, and a
// block that is never highlighted — an unknown language, a huge paste, a host with no
// workers — is not degraded at all in the only sense that matters.

import { useEffect, useState } from "react";

import type { CodeTokenLine, HighlightableLanguage } from "./code-tokenizer.js";
import { resolveHighlightableLanguage } from "./code-tokenizer.js";
import {
  consoleCodeHighlightScheduler,
  type CodeHighlightScheduler,
} from "./highlight-scheduler.js";

export interface CodeBlockProps {
  readonly source: string;
  /** The fence's info string, wire-verbatim. `null` for a fence that declared none. */
  readonly infoString: string | null | undefined;
  /**
   * Whether the block has settled.
   *
   * A volatile block is NOT highlighted: its text changes every frame, so each pass
   * would be a cache miss whose tokens are evicted before they are read again, and the
   * colours would ripple as the grammar's interpretation of an unfinished line changed
   * under the reader. `Spec-023 §Console Libraries`' streaming-markdown row — "settled
   * blocks parse once with a two-block settle lag" — applied to the one thing in a card
   * that is expensive.
   */
  readonly isSettled: boolean;
  /** Injected so a test drives its own scheduler rather than the process-wide one. */
  readonly scheduler?: CodeHighlightScheduler;
}

export function CodeBlock(props: CodeBlockProps): React.JSX.Element {
  const language = resolveHighlightableLanguage(props.infoString);
  const scheduler = props.scheduler ?? consoleCodeHighlightScheduler;
  const tokenLines = useHighlightedLines(props.source, language, props.isSettled, scheduler);

  return (
    <pre className="meridian-code" data-language={props.infoString ?? undefined}>
      <code>
        {tokenLines === undefined
          ? props.source
          : tokenLines.map((line, lineIndex) => (
              // The index IS the identity here: a code block's lines have no other,
              // and the array is replaced wholesale rather than reordered, so the usual
              // objection to an index key — reconciliation across a reorder — cannot
              // arise on this list.
              <span className="meridian-code__line" key={lineIndex}>
                {line.map((token, tokenIndex) => (
                  <span
                    // Same reasoning, one level down.
                    key={tokenIndex}
                    style={
                      token.colorReference === undefined
                        ? undefined
                        : { color: token.colorReference }
                    }
                  >
                    {token.content}
                  </span>
                ))}
                {"\n"}
              </span>
            ))}
      </code>
    </pre>
  );
}

/**
 * The tokens for this block, or `undefined` while there are none to show.
 *
 * A hook rather than an inline effect, because the rule the component must not break is
 * that it renders and nothing else. The effect is cancelled by a mounted flag rather
 * than an `AbortController`: the work is already running in another thread and there is
 * nothing to abort — what has to be prevented is a state write after unmount, which is
 * exactly what the flag prevents.
 */
function useHighlightedLines(
  source: string,
  language: HighlightableLanguage | undefined,
  isSettled: boolean,
  scheduler: CodeHighlightScheduler,
): readonly CodeTokenLine[] | undefined {
  const shouldHighlight = isSettled && language !== undefined;
  const cached = shouldHighlight ? scheduler.cachedTokens(source, language) : undefined;
  const [lines, setLines] = useState<readonly CodeTokenLine[] | undefined>(cached);

  useEffect(() => {
    if (!shouldHighlight || language === undefined) {
      setLines(undefined);
      return;
    }
    let isMounted = true;
    void scheduler.requestTokens(source, language).then((outcome) => {
      if (isMounted) {
        setLines(outcome.status === "highlighted" ? outcome.lines : undefined);
      }
    });
    return () => {
      isMounted = false;
    };
  }, [source, language, shouldHighlight, scheduler]);

  return lines;
}
