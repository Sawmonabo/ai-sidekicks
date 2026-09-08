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
//
// AND THE LEGEND SAYS WHETHER THE GROUP IS REQUIRED, through the one mark a field's label
// and a collection's legend also render. A group is a member of the level above it like
// any other, so a form where the scalars said "required" and the fieldset holding three
// more of them said nothing was reporting the schema unevenly.
//
// AND A FINDING CAN BE ABOUT THE GROUP RATHER THAN ABOUT ANYTHING IN IT. A schema that
// requires this object reports the absence at the group's own path — a member that is
// missing has no child to hang the sentence on — so the fieldset draws its own findings
// exactly as the list fieldset draws the collection's. Left to the leaves, a required
// group whose children are all optional read clean while the report said otherwise.
//
// AN OPTIONAL SECTION IS ANSWERED OR LEFT UNANSWERED, AND THAT IS ONE CONTROL ON THE
// LEGEND. A group the answer may leave out has no state a set of child controls can show:
// seeded through its children, an optional section holding a required member opened
// already answered and could never be taken back out, so a schema that accepts or
// requires its ABSENCE was unsatisfiable through this form. The legend is where the
// group is NAMED, so it is where the group is answered — beside the same required mark a
// field's label and a collection's legend render, rather than a second marker somewhere
// else saying the same thing differently. An inactive section draws no members at all:
// controls under a section nobody is answering would be controls whose values reach
// nothing.
//
// A REQUIRED GROUP OFFERS NO SUCH CONTROL, because there is no state for it to reach —
// the schema demands the object, so the section is answered from the mount. "Absent, not
// disabled": a control that could never do anything is not drawn greyed out, it is not
// drawn.

import { useId } from "react";

import { SchemaFieldIssues } from "./SchemaFieldIssues.js";
import { SchemaRequiredMark } from "./SchemaRequiredMark.js";
import { describedByOf } from "./schema-field-control.js";
import type { SchemaGroupDescriptor, SchemaLeafEntry } from "./schema-fields.js";
import { encodeMemberPointer } from "../../bridge/index.js";

export interface SchemaFieldGroupProps {
  readonly group: SchemaGroupDescriptor;
  /** How one leaf inside this group is drawn, composed once by the form's root. */
  readonly renderLeaf: (entry: SchemaLeafEntry) => React.ReactNode;
  /** The schema's findings about the group itself, rather than about one of its members. */
  readonly issues: readonly string[];
  /** Whether somebody is answering this section. A required one is always answered. */
  readonly isActive: boolean;
  /** Answer this section, or leave it unanswered. */
  readonly onChangeActive: (isActive: boolean) => void;
}

/** What the control on an unanswered section's legend reads. */
const ACTIVATE_LABEL = "Answer this section";

/** What it reads once the section is being answered. */
const DEACTIVATE_LABEL = "Leave unanswered";

/** A named set of controls, one level deep, under whatever the schema said about it. */
export function SchemaFieldGroup(props: SchemaFieldGroupProps): React.JSX.Element {
  const { group, issues } = props;
  const issuesId = useId();
  return (
    <fieldset
      className="meridian-schema-group"
      aria-describedby={describedByOf([issues.length === 0 ? undefined : issuesId])}
    >
      <legend className="meridian-schema-group__legend">
        {group.label}
        <SchemaRequiredMark isRequired={group.isRequired} />
        {group.isRequired ? null : (
          <button
            type="button"
            className="meridian-schema-group__action"
            onClick={() => {
              props.onChangeActive(!props.isActive);
            }}
          >
            {props.isActive ? DEACTIVATE_LABEL : ACTIVATE_LABEL}
          </button>
        )}
      </legend>
      {group.description === undefined ? null : (
        <p className="meridian-schema-field__description">{group.description}</p>
      )}
      {!props.isActive
        ? null
        : group.entries.map((entry) => (
            <div
              className="meridian-schema-group__entry"
              key={encodeMemberPointer(
                (entry.form === "field" ? entry.field : entry.list).memberPath,
              )}
            >
              {props.renderLeaf(entry)}
            </div>
          ))}
      <SchemaFieldIssues issues={issues} issuesId={issuesId} />
    </fieldset>
  );
}
