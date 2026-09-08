// The one control that says whether an optional CONTAINER is being answered at all.
//
// ONE COMPONENT FOR BOTH CONTAINERS, because there is one question. A group and a
// collection are the two members of this form that have no control of their own — a
// section has nothing but its legend, and an empty array is indistinguishable from an
// array somebody emptied — so both need a way to say "this member is present" that is not
// a value inside it. Written twice, the button, its two labels, and its class would have
// been two spellings of one act, and the first of them to change would have changed it
// for one container only.
//
// IT LIVES ON THE LEGEND, which is where the container is NAMED. A reader moving down the
// form meets the member and the question of whether to answer it in one place, and the
// legend already carries the required mark the same rule is read from.
//
// A REQUIRED CONTAINER IS NEVER HANDED THIS CONTROL. The schema demands the member, so
// there is no state the control could reach: "absent, not disabled" — a control that
// could never do anything is not drawn greyed out, it is not drawn. The caller decides
// that, because the caller is what holds the descriptor.
//
// AND THE LABELS ARE ABOUT THE ANSWER RATHER THAN ABOUT THE CONTAINER'S SHAPE. "Answer
// this section" reads the same over a group of controls and over a collection of them,
// which is the point: what the press does is identical, and a second pair of words for
// the collection would be this form describing one act two ways.

/** What the control on an unanswered container's legend reads. */
export const ACTIVATE_LABEL = "Answer this section";

/** What it reads once the container is being answered. */
export const DEACTIVATE_LABEL = "Leave unanswered";

export interface SchemaActivationControlProps {
  /** Whether somebody is answering this container. */
  readonly isActive: boolean;
  /** Answer this container, or leave it unanswered. */
  readonly onChangeActive: (isActive: boolean) => void;
}

/** Answer this container, or leave it unanswered. */
export function SchemaActivationControl(props: SchemaActivationControlProps): React.JSX.Element {
  return (
    <button
      type="button"
      className="meridian-schema-activation"
      onClick={() => {
        props.onChangeActive(!props.isActive);
      }}
    >
      {props.isActive ? DEACTIVATE_LABEL : ACTIVATE_LABEL}
    </button>
  );
}
