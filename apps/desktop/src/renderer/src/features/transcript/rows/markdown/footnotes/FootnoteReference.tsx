// A footnote marker: a plain `<sup>` that takes no press. It reads as not yet defined while its
// definition has not arrived, as when the block carrying `[^1]` settles before the one
// carrying `[^1]: ...`.

/** What one footnote marker shows and whether its definition has arrived. */
export interface FootnoteReferenceProps {
  /** What the marker shows: the author's label where there is one, else the identifier. */
  readonly label: string;
  /** Whether this message declared a definition under that identifier. */
  readonly isDefined: boolean;
}

/** One footnote marker, labeled and flagged with whether its definition has arrived. */
export function FootnoteReference(props: FootnoteReferenceProps): React.JSX.Element {
  return (
    <sup
      className="meridian-markdown__footnote"
      data-defined={props.isDefined ? "true" : "false"}
      aria-label={`Footnote ${props.label}`}
    >
      {props.label}
    </sup>
  );
}
