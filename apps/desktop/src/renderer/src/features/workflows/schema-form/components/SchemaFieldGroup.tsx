// One level of nesting, drawn as a fieldset under one legend. Its entries are leaves, so a
// group inside a group cannot render; the mapper sends such a schema to the raw editor.
// Findings about the group itself draw here: a schema reports a missing object at the
// group's own path, with no child to hang the sentence on.

import { useId } from "react";

import { SchemaActivationControl } from "./SchemaActivationControl.js";
import { SchemaFieldIssues } from "./SchemaFieldIssues.js";
import { SchemaRequiredMark } from "./SchemaRequiredMark.js";
import { describedByOf } from "./field-control-props.js";
import type { SchemaGroupDescriptor, SchemaLeafEntry } from "../plan/schema-fields.js";
import { encodeMemberPointer } from "../schema-member-path.js";

/** The props of a group's fieldset. */
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

/** A named set of controls, one level deep, under whatever the schema said about it. */
export function SchemaFieldGroup(props: SchemaFieldGroupProps): React.JSX.Element {
  const { group, issues } = props;
  const descriptionId = useId();
  const issuesId = useId();
  return (
    <fieldset
      className="meridian-schema-group"
      aria-describedby={describedByOf([
        group.description === undefined ? undefined : descriptionId,
        issues.length === 0 ? undefined : issuesId,
      ])}
    >
      <legend className="meridian-schema-group__legend">
        {group.label}
        <SchemaRequiredMark isRequired={group.isRequired} />
        {group.isRequired ? null : (
          <SchemaActivationControl
            isActive={props.isActive}
            onChangeActive={props.onChangeActive}
          />
        )}
      </legend>
      {group.description === undefined ? null : (
        <p className="meridian-schema-field__description" id={descriptionId}>
          {group.description}
        </p>
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
