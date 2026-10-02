// The schema's findings about one member, drawn where that member is. Sentences are shown
// verbatim and all of them. It renders nothing when nothing is wrong, so a caller's
// `aria-describedby` id exists exactly while findings do.

/** One member's findings, addressed by the id the described control names. */
export interface SchemaFieldIssuesProps {
  /** The schema's findings about this member, in the order it reported them. */
  readonly issues: readonly string[];
  /** The id a control's `aria-describedby` points at, so a reader reaches the list. */
  readonly issuesId: string;
}

/** What the schema found, or nothing at all. */
export function SchemaFieldIssues(props: SchemaFieldIssuesProps): React.ReactNode {
  if (props.issues.length === 0) {
    return null;
  }
  return (
    <ul className="meridian-schema-field__issues" id={props.issuesId}>
      {props.issues.map((issue, index) => (
        // The schema may report one sentence twice for a member, so the position joins the key.
        <li key={`${String(index)}:${issue}`}>{issue}</li>
      ))}
    </ul>
  );
}
