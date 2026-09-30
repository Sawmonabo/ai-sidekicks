// The mark that says a member is required, shared by every label and legend. It reads the
// schema and enforces nothing (the validator's verdict is an issue on the member), so it is
// quiet prose. It renders nothing for an optional member.

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
