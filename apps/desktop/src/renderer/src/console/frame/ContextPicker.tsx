// The context picker: what an auxiliary window shows before it has a subject.
//
// A person opens the timeline window from the Window menu. Nothing has been chosen
// yet, so the route is bare: `#/window/timeline` with no session id. That is not an
// error and not an empty state — the window works perfectly, it just does not know
// what to show. `Spec-023 §Console Design (Meridian)` §The surface set gives that
// case a picker.
//
// WHERE THE CANDIDATES COME FROM, AND WHY THERE IS NO "LOADING" STATE.
//
// There is no session-DIRECTORY read anywhere on the wire: no `SidekicksBridge`
// member lists the sessions on a node, and `Plan-023 §Console growth slate` carries
// no row for one either. The one session set this renderer can name is the set this
// window has open, which `SessionStoreRegistry` owns and answers SYNCHRONOUSLY.
//
// That is why the third state this file used to carry is gone rather than
// re-plumbed. It read its candidates off `context.sessionStore` — the store for the
// route's OWN session — which on a bare route is `undefined` by definition, so the
// picker rendered "Loading sessions" on the one route it exists for and stayed
// there for the life of the window. A read that cannot start is not a read in
// flight, and rendering one as the other is the conflation the five kinds of
// nothing exist to prevent. Two states remain, and both are reachable:
//
//   • This window has no session open → the "empty" kind, saying so and saying how
//     a window comes to have one.
//   • It has some → the picker.

import { Nothing } from "../primitives/index.js";
import { useOpenSessionIds, type SessionStoreRegistry } from "../store/index.js";
import {
  AUXILIARY_ROUTE_LABELS,
  type AuxiliaryRouteName,
} from "../../../../shared/auxiliary-routes.js";
import { OpenSessionList } from "./OpenSessionList.js";

export interface ContextPickerProps {
  readonly route: AuxiliaryRouteName;
  /** This window's open sessions — the only session set the console can offer. */
  readonly registry: SessionStoreRegistry;
  readonly onChoose: (sessionId: string) => void;
}

export function ContextPicker(props: ContextPickerProps): React.JSX.Element {
  // The label comes from the shared map, not a copy: the Window menu titles the
  // same route in the main process, and two maps in two processes drift silently
  // — a picker headed "Agent console" opened from a menu item reading something
  // else. `src/shared/auxiliary-routes.ts` names this exact pair as its reason.
  const routeNoun = AUXILIARY_ROUTE_LABELS[props.route].toLowerCase();
  const openSessionIds = useOpenSessionIds(props.registry);

  if (openSessionIds.length === 0) {
    return (
      <Nothing
        kind="empty"
        title="This window has no session open."
        detail={`The ${routeNoun} follows one session at a time, and the console can offer only the sessions this window has opened. A ${routeNoun} window opened from a session arrives with that session already chosen.`}
      />
    );
  }

  const question = `Which session should this ${routeNoun} follow?`;
  return (
    <section className="meridian-context-picker" aria-labelledby="meridian-context-picker-heading">
      <h1 className="meridian-context-picker__heading" id="meridian-context-picker-heading">
        {question}
      </h1>
      <OpenSessionList sessionIds={openSessionIds} onSelect={props.onChoose} label={question} />
    </section>
  );
}
