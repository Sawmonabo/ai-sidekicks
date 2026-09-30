// How a park card reaches the form that ends its wait, where the caller can offer one.
// The route type is declared here, with its consumer, because declaring it on the badge would
// make this module import it back and close a cycle.

/**
 * How this card reaches the form that ends its wait: press to open it, already open, or no
 * handle to open it with. The last two stay apart because "you are already here" and "this
 * cannot be answered from this build" are different messages.
 */
export type WorkflowParkFormRoute =
  | { readonly kind: "openable"; readonly openForm: () => void }
  | { readonly kind: "open" }
  | { readonly kind: "unaddressable"; readonly detail: string };

/** The route's own line: a control, or the sentence saying why there is none. */
export function ParkFormRoute(props: { readonly route: WorkflowParkFormRoute }): React.JSX.Element {
  const { route } = props;
  if (route.kind === "openable") {
    return (
      <button type="button" className="meridian-park__form-action" onClick={route.openForm}>
        Open this phase&apos;s form
      </button>
    );
  }
  return (
    <p className="meridian-park__form-state">
      {route.kind === "open" ? "This phase\u2019s form is open below." : route.detail}
    </p>
  );
}
