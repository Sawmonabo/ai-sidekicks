// The schema's findings about one member, drawn where that member is.
//
// ONE LIST AND FOUR PLACES THAT DRAW IT — a scalar field's chrome, one entry of a list,
// the list itself, and a group's fieldset — which is why it is a module rather than the
// same markup written four times. The four differ in WHAT they are about; none of them
// differs in how a finding reads, and four copies would have drifted the first time one
// did. The two containers on that list are there for one reason: a schema addresses a
// collection and an object at their OWN paths, so a finding about either has no member
// inside it to be drawn against.
//
// THE SENTENCES ARE THE SCHEMA'S, VERBATIM. Nothing here paraphrases a validation
// message, ranks them, or shows only the first: a schema that says two things about one
// member said both of them, and a form that showed one would send a person round twice.
//
// IT RENDERS NOTHING WHEN NOTHING IS WRONG, which is what makes the caller's
// `aria-describedby` composition safe: the id it names exists exactly while findings do,
// and the platform drops an id pointing at no element.

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
      {props.issues.map((issue) => (
        <li key={issue}>{issue}</li>
      ))}
    </ul>
  );
}
