// The `run` partition's projector: run-lifecycle events folded into run entities.
//
// `SessionStoreRegistry` has taken a projector registry since it was written and
// the composition root registered NONE, so `useSessionPartition(store, "run")`
// answered an empty map on every session however many `run.*` events had landed —
// a sidebar that renders a live session's runs as "no runs", indistinguishable
// from a session that has none.
//
// WHY IT LIVES IN `frame/` AND NOT IN `store/` OR IN A VIEW FAMILY
//
// Two constraints meet, and only one home satisfies both. It reads WIRE member
// names off an event payload, which `store/` deliberately does not do —
// `store/entities.ts` frames `ConsoleSessionEvent` as a renderer-local projection
// contract precisely so the store family holds no wire knowledge, the same reason
// `session-event-binder.ts` states for living here. And it is REGISTERED by the
// composition root, which puts it at or below `frame/` in the family DAG: a view
// family sits above the frame, so a projector owned there could not be handed to
// the registry the frame constructs. `frame/` is where those two meet.
//
// WHAT IT DERIVES RATHER THAN DECLARES
//
// The kinds it claims are read from `SESSION_EVENT_CATEGORY_BY_TYPE` filtered to
// `run_lifecycle`, never from a list written here. A hand list is how a console
// silently stops projecting the day the taxonomy grows a fourteenth run event: the
// new kind lands in the timeline, contributes no entity, and nothing fails.
//
// WHAT IT READS OFF A PAYLOAD, AND WHAT IT REFUSES TO INVENT
//
// `Spec-006 §Run Lifecycle (run_lifecycle)` gives the nine state transitions one shape —
// `{sessionId, runId, runVersion, previousState, newState, ...}` — with `agentId?`
// on `run.queued` for orchestration-created runs, and gives the four forward,
// non-state kinds (`run.rolled_back`, `run.provider_initialized`,
// `run.turn_started`, `run.worker_shutdown`) per-type payloads that carry no
// states at all. So `state` is written only where the payload names `newState`:
// writing one for a non-state event would have a turn boundary silently rewrite
// the run's state, and writing `undefined` would be worse still — the store's
// entity merge is a spread, so a present-but-undefined key ERASES what the last
// transition established.
//
// A PROJECTOR IS PURE, AND THAT DECIDES THE MALFORMED CASE. It may read the event
// and nothing else — no store, no clock, no tripwire — because the apply path
// replays prefixes and a side effect there would fire twice. A run event whose
// payload names no `runId` therefore yields NO mutation rather than a throw or a
// report: it names no entity to key on, the event is still admitted, and the
// timeline is the ledger that records it arrived.

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts";

import type {
  ConsoleSessionEvent,
  EntityMutation,
  EntityProjector,
  EntityProjectorRegistry,
} from "../store/index.js";

/**
 * The event kinds this projector claims, derived from the shipped taxonomy.
 *
 * Filtered from the census rather than restated, so the set is whatever the
 * contract says it is at build time.
 */
export const RUN_LIFECYCLE_EVENT_KINDS: readonly string[] = [...SESSION_EVENT_CATEGORY_BY_TYPE]
  .filter(([, category]) => category === "run_lifecycle")
  .map(([eventType]) => eventType);

/**
 * The body a run entity carries, as the registered payloads spell their members.
 *
 * Every member is optional because every one of them is optional on some kind in
 * the family: the four non-state events carry no states, and `agentId` rides
 * `run.queued` alone. The store merges an entity's body one level deep, so a run
 * keeps the agent its `run.queued` named across every later transition rather
 * than losing it to the first event that does not repeat it.
 */
export interface RunEntityBody {
  /**
   * The index signature is what makes this a `ConsoleEntity` body at all: the
   * store holds a body as an open record, and a closed shape is not assignable to
   * one. The named members below are the documentation a reader needs; the
   * signature is the assignability the substrate needs.
   */
  readonly [member: string]: unknown;
  /** The run aggregate's progression counter, as `Spec-006` spells it. */
  readonly runVersion?: number;
  /** The state the run left, absent on `run.queued` and on the non-state kinds. */
  readonly previousState?: string;
  /** The state the run entered. Absent on the four forward, non-state kinds. */
  readonly newState?: string;
  /** The agent the run was created for, carried by `run.queued`. */
  readonly agentId?: string;
}

/**
 * Fold one run-lifecycle event into the run it names.
 *
 * Pure and total: it reads the event and answers with mutations, and every path
 * through it answers — a payload it cannot key on answers with none.
 */
export const projectRunLifecycleEvent: EntityProjector = (
  event: ConsoleSessionEvent,
): readonly EntityMutation[] => {
  const payload = event.payload;
  const runId = readWireString(payload, "runId");
  if (runId === undefined) {
    return [];
  }
  const newState = readWireString(payload, "newState");
  const body = readRunEntityBody(payload);
  return [
    {
      operation: "upsert",
      entity: {
        kind: "run",
        id: runId,
        // Present only where the payload names one. A spread merge treats a
        // present `undefined` as an erasure, so absence has to be absence.
        ...(newState === undefined ? {} : { state: newState }),
        touchedAt: event.occurredAt,
        ...(event.actorParticipantId === undefined
          ? {}
          : { attributedTo: event.actorParticipantId }),
        ...(body === undefined ? {} : { body }),
      },
    },
  ];
};

/**
 * The projector registry the composition root hands `SessionStoreRegistry`.
 *
 * One function under every kind in the family rather than one function per kind:
 * the fold is the same for all thirteen, and thirteen near-copies is how the
 * fourteenth gets a subtly different one.
 */
export const RUN_LIFECYCLE_PROJECTORS: EntityProjectorRegistry = buildRunLifecycleProjectors();

function buildRunLifecycleProjectors(): EntityProjectorRegistry {
  const projectors: Record<string, EntityProjector> = {};
  for (const eventKind of RUN_LIFECYCLE_EVENT_KINDS) {
    projectors[eventKind] = projectRunLifecycleEvent;
  }
  return projectors;
}

/** The body members this payload names, or `undefined` when it names none. */
function readRunEntityBody(
  payload: Readonly<Record<string, unknown>> | undefined,
): RunEntityBody | undefined {
  const runVersion = readWireNumber(payload, "runVersion");
  const previousState = readWireString(payload, "previousState");
  const newState = readWireString(payload, "newState");
  const agentId = readWireString(payload, "agentId");
  const body: RunEntityBody = {
    ...(runVersion === undefined ? {} : { runVersion }),
    ...(previousState === undefined ? {} : { previousState }),
    ...(newState === undefined ? {} : { newState }),
    ...(agentId === undefined ? {} : { agentId }),
  };
  return Object.keys(body).length === 0 ? undefined : body;
}

/**
 * One string member, or `undefined` when the payload does not carry one.
 *
 * A wrong-typed member reads as absent rather than as itself: the payload is
 * `unknown` until something checks it, and a number rendered where a state string
 * belongs looks exactly as confident as the real thing.
 */
function readWireString(
  payload: Readonly<Record<string, unknown>> | undefined,
  member: string,
): string | undefined {
  const value = payload?.[member];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** One numeric member, on the same terms. Non-finite values read as absent. */
function readWireNumber(
  payload: Readonly<Record<string, unknown>> | undefined,
  member: string,
): number | undefined {
  const value = payload?.[member];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
