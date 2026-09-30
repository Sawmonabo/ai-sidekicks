// A fenced code block.
//
// A code block is legible the instant it arrives: its source is drawn at once in the
// code face, and the daemon's colors are painted over the same text when they come.
// Nothing here parses the source as markup — the colors arrive as spans over text the
// block already holds — so there is no `dangerouslySetInnerHTML` on this path and
// nothing to sanitize.
//
// TWO KINDS OF BLOCK NEVER ASK. A block still streaming changes with every frame, and
// the colors of an unfinished line would ripple as the grammar's reading of it changed
// under the reader, so only a settled block asks. And a block whose fence names no
// language the daemon colors stays plain and asks nothing.

import { resolveHighlightableLanguage } from "./highlight-languages.js";
import { HighlightedSource } from "./HighlightedSource.js";

export interface CodeBlockProps {
  readonly source: string;
  /** The fence's info string, wire-verbatim. `null` for a fence that declared none. */
  readonly infoString: string | null | undefined;
  /** Whether the block has settled; a block still streaming is never colored. */
  readonly isSettled: boolean;
}

export function CodeBlock(props: CodeBlockProps): React.JSX.Element {
  const language = props.isSettled ? resolveHighlightableLanguage(props.infoString) : undefined;
  return (
    <pre className="meridian-code" data-language={props.infoString ?? undefined}>
      <code>
        {language === undefined ? (
          props.source
        ) : (
          <HighlightedSource source={props.source} language={language} />
        )}
      </code>
    </pre>
  );
}
