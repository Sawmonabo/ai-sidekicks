// A footnote marker: the mark a reply carries where it cites a note.
//
// A reference whose own message declared a definition reads as defined, and one whose
// definition has not arrived — the streaming case, where the block carrying `[^1]` settled
// before the block carrying `[^1]: …` — reads as not yet defined. The marker is a plain
// `<sup>` either way and takes no press.

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
