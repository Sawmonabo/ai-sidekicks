// The `run` partition's projector: run-lifecycle events folded into run entities. It lives in
// `store/session-events/`, below every feature, because it reads wire member names (which the
// session store's entities do not) and the composition root registers it.
//
// The claimed kinds come from `SESSION_EVENT_CATEGORY_BY_TYPE` filtered to `run_lifecycle`, so a
// new run event cannot silently stop projecting. The body's members are derived, not hand-kept:
// `DurableRunMemberName` (`run-entity-body.ts`) is the key union of `RunStateChangeEvent` and
// `RunRolledBackEvent` (`packages/contracts/src/run-control.ts`) minus `runId`, `sessionId` and
// `timestamp`, plus `agentId`; a new member fails the reader table's `satisfies` until
// classified. Those are `run.subscribeState` shapes while this folds the durable rows off
// `session.subscribe`, so `PER_TYPE_RUN_BODY_MEMBER_READERS` holds the per-kind members neither
// declares, keyed by kind so a member is never read off another.
//
// `state` is written only where the payload names `newState`: a non-state event must not
// rewrite it, and `undefined` would erase it through the store's spread merge. A recognized
// transition must supply exactly the state it announces (`statedStateFailsKind`, using
// `runStateForTransitionKind`); the creation kind and forward, non-state rows announce none.
//
// The payload's `sessionId` is held to the envelope's once at entry, for every kind
// (`lib/wire-session-attribution.ts`); the durable row registers it, so omitting it is malformed.
//
// A projector is pure, because the apply path replays prefixes and a side effect would fire
// twice. A run event naming no `runId` yields no mutation rather than a throw; the timeline
// still records that it arrived.

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts";
import { runStateForTransitionKind } from "@renderer/store/session-events/run-state-kinds.js";
import { payloadNamesSession } from "@renderer/lib/wire-session-attribution.js";
import { readWireString } from "@renderer/lib/wire-strings.js";
import type {
  ProjectedSessionEvent,
  EntityMutation,
  EntityProjector,
  EntityProjectorTable,
} from "../session/entities/entities.js";
import { readRunEntityBody } from "./run-entity-body.js";

/** The event kinds this projector claims, derived from the shipped event-type taxonomy. */
export const RUN_LIFECYCLE_EVENT_KINDS: readonly string[] = [...SESSION_EVENT_CATEGORY_BY_TYPE]
  .filter(([, category]) => category === "run_lifecycle")
  .map(([eventType]) => eventType);

/**
 * Fold one run-lifecycle event into the run it names. Pure and total: a payload naming another
 * session, one it cannot key on, or one missing the state its kind announces yields no
 * mutations.
 */
export const projectRunLifecycleEvent: EntityProjector = (
  event: ProjectedSessionEvent,
): readonly EntityMutation[] => {
  const payload = event.payload;
  // The beat folds into the store it was delivered into, so another session's entity is refused.
  if (!payloadNamesSession(payload, event.sessionId)) {
    return [];
  }
  const runId = readWireString(payload?.["runId"]);
  if (runId === undefined) {
    return [];
  }
  const newState = readWireString(payload?.["newState"]);
  if (statedStateFailsKind(event.kind, newState)) {
    return [];
  }
  const body = readRunEntityBody(event.kind, payload);
  return [
    {
      operation: "upsert",
      entity: {
        kind: "run",
        id: runId,
        // A spread merge treats a present `undefined` as an erasure, so leave `state` off.
        ...(newState === undefined ? {} : { state: newState }),
        touchedAt: event.occurredAt,
        ...(event.actorId === undefined ? {} : { attributedTo: event.actorId }),
        ...(body === undefined ? {} : { body }),
      },
    },
  ];
};

/** The projector table the composition root gives `SessionStoreRegistry`: one fold per kind. */
export const RUN_LIFECYCLE_PROJECTORS: EntityProjectorTable = buildRunLifecycleProjectors();

/** The owner the run-lifecycle kinds are registered under, so a conflicting claim names it. */
export const RUN_LIFECYCLE_PROJECTOR_OWNER = "session-events";

function buildRunLifecycleProjectors(): EntityProjectorTable {
  const projectors: Record<string, EntityProjector> = {};
  for (const eventKind of RUN_LIFECYCLE_EVENT_KINDS) {
    projectors[eventKind] = projectRunLifecycleEvent;
  }
  return projectors;
}

/**
 * Does this payload fail to carry the run state its own kind announces?
 *
 * The payload schemas are tolerant, so a `run.running` beat carrying `newState: "failed"`, or
 * no readable state at all, arrives well-formed; the second would upsert the run while keeping
 * its previous state. A recognized kind therefore demands a string equal to what it announces.
 * Kinds that announce no transition are not checked.
 */
function statedStateFailsKind(eventKind: string, statedState: string | undefined): boolean {
  const announcedState = runStateForTransitionKind(eventKind);
  return announcedState !== undefined && statedState !== announcedState;
}
