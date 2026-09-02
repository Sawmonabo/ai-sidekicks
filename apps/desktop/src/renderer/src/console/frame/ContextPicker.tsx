// The context picker: what an auxiliary window shows before it has a subject.
//
// A person opens the timeline window from the Window menu. Nothing has been chosen
// yet, so the route is bare: `#/window/timeline` with no session id. That is not an
// error and not an empty state — the window works perfectly, it just does not know
// what to show. `Spec-023 §Console Design (Meridian)` §The surface set gives that
// case a picker.
//
// WHERE THE CANDIDATES COME FROM.
//
// Two sets, offered as their union. The node's sessions come from the growth port's
// directory read — a wire the corpus has not registered, served by the fixture and
// refused by the live bridge — and this window's own open sessions come from
// `SessionStoreRegistry`, which answers synchronously.
//
// A "loading" state exists again, and it is a real one this time. The state this
// file used to carry read its candidates off `context.sessionStore` — the store for
// the route's OWN session — which on a bare route is `undefined` by definition, so
// the picker rendered "Loading sessions" on the one route it exists for and stayed
// there for the life of the window. That was a read that could not start being
// rendered as a read in flight. The directory read genuinely is one, and it
// settles. Four states, and every one of them reachable:
//
//   • The directory read is in flight → `not-loaded`.
//   • It was refused and this window has nothing open → `not-checked`: the console
//     did not ask the node, and says so rather than reporting an empty node.
//   • It answered and there are none → `empty`, saying how a window comes to have
//     one.
//   • There is something to offer → the picker.

import type { GrowthPort } from "../bridge/index.js";
import { Nothing } from "../primitives/index.js";
import { useOpenSessionIds, type SessionStoreRegistry } from "../store/index.js";
import { offeredSessionIds, useSessionDirectory } from "./session-directory.js";
import {
  AUXILIARY_ROUTE_LABELS,
  type AuxiliaryRouteName,
} from "../../../../shared/auxiliary-routes.js";
import { OpenSessionList } from "./OpenSessionList.js";

export interface ContextPickerProps {
  readonly route: AuxiliaryRouteName;
  /** This window's open sessions — one half of what the picker can offer. */
  readonly registry: SessionStoreRegistry;
  /** The seam the node's session directory is read through — the other half. */
  readonly growth: GrowthPort;
  readonly onChoose: (sessionId: string) => void;
}

export function ContextPicker(props: ContextPickerProps): React.JSX.Element {
  // The label comes from the shared map, not a copy: the Window menu titles the
  // same route in the main process, and two maps in two processes drift silently
  // — a picker headed "Agent console" opened from a menu item reading something
  // else. `src/shared/auxiliary-routes.ts` names this exact pair as its reason.
  const routeNoun = AUXILIARY_ROUTE_LABELS[props.route].toLowerCase();
  const openSessionIds = useOpenSessionIds(props.registry);
  const directory = useSessionDirectory(props.growth);
  const sessionIds = offeredSessionIds(directory, openSessionIds);

  if (sessionIds.length === 0) {
    if (directory.status === "reading") {
      return (
        <Nothing kind="not-loaded" title={`Reading the sessions this ${routeNoun} could follow.`} />
      );
    }
    if (directory.status === "served") {
      return (
        <Nothing
          kind="empty"
          title="There are no sessions on this node yet."
          detail={`The ${routeNoun} follows one session at a time. A ${routeNoun} window opened from a session arrives with that session already chosen.`}
        />
      );
    }
    return (
      <Nothing
        kind="not-checked"
        title="This window has no session open."
        detail={`The ${routeNoun} follows one session at a time, and the console has not asked the node for the rest. ${directory.refusal.detail}`}
      />
    );
  }

  const question = `Which session should this ${routeNoun} follow?`;
  return (
    <section className="meridian-context-picker" aria-labelledby="meridian-context-picker-heading">
      <h1 className="meridian-context-picker__heading" id="meridian-context-picker-heading">
        {question}
      </h1>
      <OpenSessionList sessionIds={sessionIds} onSelect={props.onChoose} label={question} />
    </section>
  );
}
