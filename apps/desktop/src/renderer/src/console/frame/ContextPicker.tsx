// The context picker: what an auxiliary window shows before it has a subject.
//
// A person opens the timeline window from the Window menu. Nothing has been chosen
// yet, so the route is bare: `#/window/timeline` with no session id. That is not an
// error and not an empty state — the window works perfectly, it just does not know
// what to show. `Spec-023 §Console Design (Meridian)` §The surface set gives that
// case a picker.
//
// Getting this wrong is the difference between a window that feels finished and one
// that feels broken, so the distinctions are worth stating:
//
//   • No sessions have loaded yet → the "not loaded" kind of nothing.
//   • Sessions loaded and there are none → the "empty" kind, with the action that
//     would create one.
//   • Sessions loaded and there are some → the picker.
//
// A single "nothing to show" state for all three would be the conflation the five
// kinds of nothing exist to prevent.

import { Nothing } from "../primitives/index.js";
import {
  AUXILIARY_ROUTE_LABELS,
  type AuxiliaryRouteName,
} from "../../../../shared/auxiliary-routes.js";

export interface ContextCandidate {
  readonly sessionId: string;
  readonly title: string;
  readonly detail: string;
}

export interface ContextPickerProps {
  readonly route: AuxiliaryRouteName;
  /** `undefined` means the session list has not loaded — a different state from empty. */
  readonly candidates: readonly ContextCandidate[] | undefined;
  readonly onChoose: (sessionId: string) => void;
}

export function ContextPicker(props: ContextPickerProps): React.JSX.Element {
  // The label comes from the shared map, not a copy: the Window menu titles the
  // same route in the main process, and two maps in two processes drift silently
  // — a picker headed "Agent console" opened from a menu item reading something
  // else. `src/shared/auxiliary-routes.ts` names this exact pair as its reason.
  const routeTitle = AUXILIARY_ROUTE_LABELS[props.route];

  if (props.candidates === undefined) {
    return (
      <Nothing kind="not-loaded" title={`Loading sessions for the ${routeTitle.toLowerCase()}.`} />
    );
  }

  if (props.candidates.length === 0) {
    return (
      <Nothing
        kind="empty"
        title="No sessions yet."
        detail={`The ${routeTitle.toLowerCase()} follows one session at a time. Start a session in the main window and it will appear here.`}
      />
    );
  }

  return (
    <section className="meridian-context-picker" aria-labelledby="meridian-context-picker-heading">
      <h1 className="meridian-context-picker__heading" id="meridian-context-picker-heading">
        Which session should this {routeTitle.toLowerCase()} follow?
      </h1>
      <ul className="meridian-context-picker__list">
        {props.candidates.map((candidate) => (
          <li key={candidate.sessionId}>
            <button
              type="button"
              className="meridian-context-picker__choice"
              onClick={() => {
                props.onChoose(candidate.sessionId);
              }}
            >
              <span className="meridian-context-picker__title">{candidate.title}</span>
              <span className="meridian-context-picker__detail">{candidate.detail}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
