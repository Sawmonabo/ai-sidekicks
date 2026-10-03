// A fenced code block: the source is drawn at once and the daemon's colors are painted over the
// same text when they arrive. Colors are spans over text the block already holds, so nothing is
// parsed as markup. Only a settled block asks for colors, since an unfinished line's colors would
// ripple; a fence naming no colorable language stays plain.

import { resolveHighlightableLanguage } from "./highlight-languages.js";
import { HighlightedSource } from "./HighlightedSource.js";

/** What one fenced code block is drawn from. */
export interface CodeBlockProps {
  readonly source: string;
  /** The fence's info string, wire-verbatim. `null` for a fence that declared none. */
  readonly infoString: string | null | undefined;
  /** Whether the block has settled; a block still streaming is never colored. */
  readonly isSettled: boolean;
}

/** A fenced code block, colored by the daemon once it has settled. */
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
