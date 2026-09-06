// The context picker: what an auxiliary window shows before it has a subject.
//
// A person opens the timeline window from the Window menu. Nothing has been chosen
// yet, so the route is bare: `#/window/timeline` with no session id. That is not an
// error and not an empty state — the window works perfectly, it just does not know
// what to show. `Spec-023 §Console Design (Meridian)` §The surface set gives that
// case a picker.
//
// HOW MANY THINGS THE PICKER COLLECTS IS THE GRAMMAR'S ANSWER, NOT THIS FILE'S.
//
// `src/shared/auxiliary-routes.ts` declares what context each route carries, and it
// declares it ALL-OR-NOTHING: a timeline follows a session, and a detached agent
// console follows an agent inside one, so the agent id arrives with its session or
// not at all. This picker used to collect the session and navigate — which on the
// agent-console route built a target with a session and no agent, and the route's
// own hash writer handed that to the shared producer, which refused it by throwing
// outside any surface's boundary. Choosing a session in an agent-console window
// crashed navigation.
//
// The fix is at the source of the partial target rather than around the throw: the
// picker collects a session and then, on a route whose grammar takes one, an agent,
// and it hands its caller an `AuxiliaryRouteTarget` — a type with no partial arm,
// so a half-supplied context is unrepresentable at this seam rather than merely
// refused one layer later. The grammar stays strict; nothing here relaxes it.
//
// WHERE THE CANDIDATES COME FROM.
//
// Sessions: two sets, offered as their union. The node's sessions come from the
// growth port's directory read — a wire the corpus has not registered, served by
// the fixture and refused by the live bridge — and this window's own open sessions
// come from `SessionStoreRegistry`, which answers synchronously.
//
// Agents: the session's own store, opened through the same registry the rest of the
// window opens sessions through, and read through the same partition selector every
// other surface reads entities through. There is no second source and no second
// wire: a session whose store cannot be initialised has no agents this console can
// name, and the picker says exactly that rather than reporting a session with none.
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

import { useState } from "react";

import { isUnbuiltWireRefusal, type GrowthPort } from "../bridge/index.js";
import type { ConsoleRefusal } from "../core/index.js";
import { Nothing, WireChoiceList, WireFigure } from "../primitives/index.js";
import { useOpenSessionIds, type SessionStore, type SessionStoreRegistry } from "../store/index.js";
import { AgentChoice } from "./AgentChoice.js";
import { offeredSessionIds, useSessionDirectory } from "../seats/index.js";
import { useActiveSessionStore } from "./session-lifecycle.js";
import {
  AUXILIARY_ROUTE_LABELS,
  auxiliaryRouteTargetFor,
  type AuxiliaryRouteName,
  type AuxiliaryRouteTarget,
  type PartialAuxiliaryContext,
} from "../../../../shared/auxiliary-routes.js";

export interface ContextPickerProps {
  readonly route: AuxiliaryRouteName;
  /** This window's open sessions — one half of what the picker can offer. */
  readonly registry: SessionStoreRegistry;
  /** The seam the node's session directory is read through — the other half. */
  readonly growth: GrowthPort;
  /**
   * Called with a COMPLETE target and never before.
   *
   * The type is the guarantee: `AuxiliaryRouteTarget` has no arm carrying a
   * session without the agent its route requires, so a caller cannot be handed
   * the half-built context that used to reach the hash writer.
   */
  readonly onChoose: (target: AuxiliaryRouteTarget) => void;
}

interface AgentStep {
  /** Set when the registry can perform no read at all, so no store initialises. */
  readonly readRefusal: ConsoleRefusal | undefined;
  readonly store: SessionStore | undefined;
  readonly routeNoun: string;
  readonly label: string;
  readonly onChoose: (agentId: string) => void;
}

/**
 * The two absences that are not facts about one store, and the component for when
 * neither holds.
 *
 * A plain function rather than a component, and it subscribes to nothing: both
 * arms below are answered before any store exists to read, which is exactly why
 * they cannot live inside `AgentChoice` — React forbids a conditional hook, so a
 * component that rendered these would be subscribing on a store it may not have.
 */
function renderAgentStep(step: AgentStep): React.ReactNode {
  if (step.readRefusal !== undefined) {
    // The registry carries a refusal instead of a reader, so no store it opens
    // will ever reach a base state and this session's agents are a question the
    // console cannot put. "Not checked", never "none".
    return (
      <Nothing
        kind="not-checked"
        title="The console cannot read this session's agents."
        detail={step.readRefusal.detail}
      />
    );
  }
  if (step.store === undefined) {
    // One frame: the session was chosen in this render and the effect that opens
    // it has not run. The honest rendering of that frame is a read in flight,
    // which is what `RouteSurface` says about the same gap one level up.
    return (
      <Nothing kind="not-loaded" title={`Opening the session this ${step.routeNoun} follows.`} />
    );
  }
  return (
    <AgentChoice
      store={step.store}
      routeNoun={step.routeNoun}
      label={step.label}
      onChoose={step.onChoose}
    />
  );
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
  // The session chosen but not yet navigated to. Local to the picker on purpose:
  // it is not a place the window IS, so writing it to the frame store would put a
  // half-supplied context into the route — which is the defect this step exists to
  // remove — and would publish it to the address bar on the way.
  const [pendingSessionId, setPendingSessionId] = useState<string | undefined>(undefined);
  // Opening the pending session is the read: the agents are entities in its store,
  // and the registry is idempotent, so this is the same store the navigation would
  // resolve a moment later rather than a second one.
  const pendingSessionStore = useActiveSessionStore(props.registry, pendingSessionId);

  /**
   * Navigate on a complete target, or take the next step towards one.
   *
   * The grammar decides which of those it is: `null` means the route still wants
   * context this call did not carry, and the only context collected in a second
   * step is the agent — so the session is held and the picker stays up. A third
   * key on some later route lands here too, and lands SAFELY: the picker keeps
   * asking rather than navigating something the producer would throw on.
   */
  const advance = (context: PartialAuxiliaryContext & { readonly sessionId: string }): void => {
    const target = auxiliaryRouteTargetFor(props.route, context);
    if (target === null) {
      setPendingSessionId(context.sessionId);
      return;
    }
    props.onChoose(target);
  };

  if (pendingSessionId !== undefined) {
    const question = `Which agent should this ${routeNoun} follow?`;
    return (
      <section
        className="meridian-context-picker"
        aria-labelledby="meridian-context-picker-heading"
      >
        <h1 className="meridian-context-picker__heading" id="meridian-context-picker-heading">
          {question}
        </h1>
        <p className="meridian-context-picker__subject">
          In session <WireFigure value={pendingSessionId} />
        </p>
        {renderAgentStep({
          readRefusal: props.registry.readRefusal,
          store: pendingSessionStore,
          routeNoun,
          label: question,
          onChoose: (agentId) => {
            advance({ sessionId: pendingSessionId, agentId });
          },
        })}
        <button
          type="button"
          className="meridian-context-picker__back"
          onClick={() => {
            setPendingSessionId(undefined);
          }}
        >
          Choose a different session
        </button>
      </section>
    );
  }

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
    if (!isUnbuiltWireRefusal(directory.refusal)) {
      // The read was PUT and it failed, which is not the same fact as never having
      // asked — so the daemon's own code and sentence reach the screen verbatim
      // rather than a console sentence claiming it did not look. Rule 9 fixes what a
      // refusal shows at exactly those two.
      return (
        <Nothing kind="error" title={directory.refusal.code} detail={directory.refusal.detail} />
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
      <WireChoiceList
        values={sessionIds}
        onSelect={(sessionId) => {
          advance({ sessionId });
        }}
        label={question}
      />
    </section>
  );
}
