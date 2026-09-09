// The one mark that says a member is required, wherever a member is named.
//
// HOISTED ON THE THIRD NAME AND NOT WRITTEN A THIRD TIME. A field's label and a
// collection's legend had each spelled the same span and the same class inline, and a
// group's legend was about to be the third — at which point the wording, the class, and
// the leading space would have been three copies of one decision, drifting in the
// direction where the drift is silent: a form where one member's mark reads differently
// from another's, with nothing failing.
//
// IT IS A READING OF THE SCHEMA AND NOT AN ENFORCEMENT. It says what the schema declared;
// whether an answer satisfies it is the compiled validator's verdict, arriving as an issue
// on that same member. Which is why it renders as quiet prose beside the name rather than
// in the refusal hue — nothing is wrong with a member nobody has answered yet.
//
// AND IT RENDERS NOTHING RATHER THAN AN EMPTY SPAN where the member is optional, so a
// surface asking whether the mark is present gets an answer about the schema instead of
// about the markup.

/** Whether this member is one the schema demands. */
export interface SchemaRequiredMarkProps {
  readonly isRequired: boolean;
}

/** The word beside a required member's name, or nothing beside an optional one's. */
export function SchemaRequiredMark(props: SchemaRequiredMarkProps): React.JSX.Element | null {
  return props.isRequired ? (
    <span className="meridian-schema-field__required"> required</span>
  ) : null;
}
