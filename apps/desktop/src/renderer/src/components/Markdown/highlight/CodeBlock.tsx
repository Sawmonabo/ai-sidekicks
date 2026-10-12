// A fenced code block in a hairline frame: the source is drawn at once and the daemon's colors are
// painted over the same text when they arrive. Colors are spans over text the block already
// holds, so nothing is parsed as markup. Only a settled block asks for colors, since an
// unfinished line's colors would ripple; a fence naming no colorable language stays plain. The
// frame's corner carries the fence's language word and, where the body offers one, the block's
// own Copy. The word is drawn by the sheet from an attribute, so a selection never copies it.

import "./CodeBlock.css";

import type { BlockCopyRenderer } from "../block-copy-offer.js";
import type { CodeSpanReader } from "./code-span-reader.js";
import { resolveHighlightableLanguage } from "./languages.js";
import { HighlightedSource } from "./HighlightedSource.js";

/** What one fenced code block is drawn from. */
export interface CodeBlockProps {
  readonly source: string;
  /** The fence's info string, wire-verbatim. `null` for a fence that declared none. */
  readonly infoString: string | null | undefined;
  /** Whether the block has settled; a block still streaming is never colored. */
  readonly isSettled: boolean;
  /** Where the block's colors come from. */
  readonly codeSpanReader: CodeSpanReader;
  /**
   * Draws the block's Copy, which copies `source` alone as plain text, or `undefined` where the
   * body offers none. An empty block copies nothing, so it draws no Copy.
   */
  readonly renderCopy: BlockCopyRenderer | undefined;
}

/** A fenced code block, colored by the daemon once it has settled. */
export function CodeBlock(props: CodeBlockProps): React.JSX.Element {
  const language = props.isSettled ? resolveHighlightableLanguage(props.infoString) : undefined;
  const languageWord =
    props.infoString === null || props.infoString === undefined || props.infoString === ""
      ? undefined
      : props.infoString;
  const copy =
    props.renderCopy === undefined || props.source === ""
      ? undefined
      : props.renderCopy({ label: "Copy", content: () => ({ text: props.source }) });
  return (
    <div className="meridian-code-block">
      {languageWord === undefined && copy === undefined ? null : (
        <div className="meridian-code-block__corner" data-language={languageWord}>
          {copy === undefined ? null : <span className="meridian-code-block__copy">{copy}</span>}
        </div>
      )}
      <pre className="meridian-code" data-language={props.infoString ?? undefined}>
        <code>
          {language === undefined ? (
            props.source
          ) : (
            <HighlightedSource
              source={props.source}
              language={language}
              codeSpanReader={props.codeSpanReader}
            />
          )}
        </code>
      </pre>
    </div>
  );
}
