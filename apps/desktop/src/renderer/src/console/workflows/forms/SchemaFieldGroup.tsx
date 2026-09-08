// One level of nesting, drawn as a group of controls under one heading.
//
// ONE LEVEL, AND THE TYPE IS WHAT SAYS SO. This component takes a group descriptor whose
// entries are leaves — a control or a list of one — so there is no arm here that could
// render a group inside a group. A schema nesting twice never reaches this component at
// all: the mapper sends it to the raw editor, which is the honest answer for a shape
// this form has no layout for.
//
// A `fieldset` AND A `legend`, because that is what a group of controls with one name IS.
// A heading and a div would look the same and would leave a person navigating by control
// unable to hear which group the control they landed on belongs to.

import type { SchemaGroupDescriptor, SchemaLeafEntry } from "./schema-fields.js";

export interface SchemaFieldGroupProps {
  readonly group: SchemaGroupDescriptor;
  /** How one leaf inside this group is drawn, composed once by the form's root. */
  readonly renderLeaf: (entry: SchemaLeafEntry) => React.ReactNode;
}

/** A named set of controls, one level deep. */
export function SchemaFieldGroup(props: SchemaFieldGroupProps): React.JSX.Element {
  const { group } = props;
  return (
    <fieldset className="meridian-schema-group">
      <legend className="meridian-schema-group__legend">{group.label}</legend>
      {group.description === undefined ? null : (
        <p className="meridian-schema-field__description">{group.description}</p>
      )}
      {group.entries.map((entry) => (
        <div
          className="meridian-schema-group__entry"
          key={(entry.form === "field" ? entry.field : entry.list).memberPath.join(".")}
        >
          {props.renderLeaf(entry)}
        </div>
      ))}
    </fieldset>
  );
}
