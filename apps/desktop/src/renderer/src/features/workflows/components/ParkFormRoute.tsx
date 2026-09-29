// How a park card reaches the form that ends its wait, where the caller can offer one.
//
// A SIBLING RATHER THAN A SECOND COMPONENT IN `ParkBadge.tsx`, for the reason
// `ParkSchedule.tsx` beside it states: one component per `.tsx`, reached by a deep
// relative import from its host and published through no door line.
//
// THE ROUTE TYPE IS DECLARED HERE, WITH THE COMPONENT THAT CONSUMES IT, rather than in
// the badge that merely passes it through. Declared on the badge it would have to be
// imported back by this module, which closes a cycle the layering gate rejects; every
// other reader — the badge's own props, and the pane surface that builds one — reaches
// the one declaration from here.

/**
 * How this card reaches the form that ends its wait, where the caller can offer one.
 *
 * Three arms because the operator's next move differs: press this to answer the phase,
 * nothing to press because this phase's form is already the one open, and nothing to
 * press because the run did not report the handle it would be answered through. A
 * boolean plus a detail string would collapse the last two, and they are the difference
 * between "you are already here" and "this cannot be answered from this build".
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
