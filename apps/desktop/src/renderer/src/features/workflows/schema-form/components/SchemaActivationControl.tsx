// The control on a container's legend that says whether an optional group or collection is
// being answered at all. A required container is never handed it: the schema demands the
// member, so the caller draws no control rather than a disabled one.

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
