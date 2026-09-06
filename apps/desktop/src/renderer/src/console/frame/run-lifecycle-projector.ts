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
// WHAT IT READS OFF A PAYLOAD, AND WHERE THAT LIST COMES FROM
//
// The body used to keep four members — `runVersion`, the two state strings, and
// `agentId` — while claiming every kind in the family. Everything else the
// registered payloads carry was dropped on the floor: `executionPosture` off
// `run.running`, the stop-condition `trigger`, the orchestration linkage, the
// admission stamps, and the rollback `targetPosition`. Those values stayed in the
// raw timeline and never reached the `run` partition, so a surface reading the
// run body — the composer's posture chip among them — found nothing and rendered
// as though the run had never carried one.
//
// So the member list is DERIVED rather than hand-kept. `RunStateChangeEvent` and
// `RunRolledBackEvent` (`packages/contracts/src/runControl.ts`) are the two
// registered run shapes, and `DurableRunMemberName` below is their key union
// minus the four members the durable row does not carry under those names, plus
// the two the durable payload carries alone. A member added to either registered
// shape lands in that union and fails the reader table's `satisfies` until
// someone classifies it, which is the whole point: a hand list is how a body
// silently stops carrying the member a surface was built to read.
//
// AND THE DERIVATION IS NOT THE WHOLE PAYLOAD, WHICH IS THE SECOND TABLE'S
// SUBJECT. Those two shapes are both `run.subscribeState` projections, and this
// projector folds the DURABLE rows off `session.subscribe`. Four of the thirteen
// kinds register per-type members that neither projection declares and that
// `packages/contracts` therefore holds no schema for at all — `SessionEventSchema`
// registers no run-lifecycle payload variant, so there is nothing to derive them
// from. Treating the two subscription shapes as exhaustive dropped every one of
// them: the run's creation lost its orchestration `linkType`, its admission-
// resolved `effectiveRunConfig`, and the account it was admitted against, and the
// three forward, non-state rows lost the whole of what they carry — the provider
// and model an initialization reports, the position a turn opened at, the reason a
// worker shut down. Each reached the timeline and none reached the `run` partition
// a pane reads. `UNDECLARED_RUN_BODY_MEMBER_READERS` is those four rows, keyed by
// the kind that registers them so the parse is PER TYPE — a member registered on
// one kind is never read off another — and typed against the census so a
// misspelled kind fails to compile rather than reading a payload no daemon sends.
// The day a contracts shape declares one of these members, it enters
// `DurableRunMemberName`, the base table classifies it, and the co-located test's
// no-second-spelling case fails until the entry here is deleted.
//
// THE TWO SHAPES ARE NOT ONE SHAPE, and the exclusions are where that is stated.
// That module says so itself: the `run.subscribeState` projection is
// "deliberately distinct from the durable `run_lifecycle` payload of `Spec-006
// §Run Lifecycle (run_lifecycle)` (`{sessionId, runId, runVersion,
// previousState, newState, channelId?, ...}`)", where "the canonical wire member
// is `currentState`" on the stream and `newState` on the durable row. `sessionId`
// and `timestamp` are excluded because the envelope already carries both —
// `event.sessionId` and `event.occurredAt`, the latter stored as `touchedAt` —
// and `runId` because it is the entity's own id. `agentId` is the one member no
// registered shape names, and it is `Spec-006`'s: `run.queued` carries it for
// orchestration-created runs.
//
// `state` is written only where the payload names `newState`: writing one for a
// non-state event would have a turn boundary silently rewrite the run's state,
// and writing `undefined` would be worse still — the store's entity merge is a
// spread, so a present-but-undefined key ERASES what the last transition
// established.
//
// AND A RECOGNIZED TRANSITION MUST SUPPLY THE STATE IT ANNOUNCES — equality, not
// merely non-contradiction. `statedStateFailsKind` below states the rule and the
// two readings it refuses to choose between: the loud one, a `run.running` beat
// carrying `newState: "failed"`, and the quiet one, the same beat carrying no
// readable state at all, which upserted the run while PRESERVING the state its last
// transition established. Nothing above the fold catches either.
//
// The kind's announced state is `bridge/daemon/session-event-streams.ts`'s
// `runStateForTransitionKind`, read rather than re-derived — that module is the
// one authority on which kind announces which state, and a second copy here is
// exactly the drift it was written to end. Its domain is the eight transitions the
// state stream carries, so the requirement is scoped to those: the creation kind and
// the three forward, non-state rows are not transitions, that mapping deliberately
// claims none of them, and inventing a state for them here to widen the check
// would be minting the second mapping this reads one to avoid.
//
// AND THE PAYLOAD IS HELD TO THE ENVELOPE'S SESSION, once at the fold's entry and
// for every kind at once, because they all key one partition off one envelope and a
// per-arm check is how the fourteenth kind arrives without one.
// `payloadNamesThisSession` below states that rule and why nothing above can.
//
// A PROJECTOR IS PURE, AND THAT DECIDES THE MALFORMED CASE. It may read the event
// and nothing else — no store, no clock, no tripwire — because the apply path
// replays prefixes and a side effect there would fire twice. A run event whose
// payload names no `runId` therefore yields NO mutation rather than a throw or a
// report: it names no entity to key on, the event is still admitted, and the
// timeline is the ledger that records it arrived.

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts";

import { runStateForTransitionKind } from "../bridge/index.js";
import { readWireString } from "../core/index.js";
import type { ConsoleEntityProjectorRegistry } from "../store/index.js";
import type {
  ConsoleSessionEvent,
  EntityMutation,
  EntityProjector,
  EntityProjectorRegistry,
} from "../store/index.js";
import { readRunEntityBody } from "./run-entity-body.js";

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
 * Fold one run-lifecycle event into the run it names.
 *
 * Pure and total: it reads the event and answers with mutations, and every path
 * through it answers — a payload naming another session, a payload it cannot key
 * on, and a payload that does not carry the state its kind announces, each answer
 * with none.
 */
export const projectRunLifecycleEvent: EntityProjector = (
  event: ConsoleSessionEvent,
): readonly EntityMutation[] => {
  const payload = event.payload;
  // First, and for every kind at once: the beat is folded into the store it was
  // delivered into, so a payload that names another session names an entity this
  // store must not hold.
  if (!payloadNamesThisSession(payload, event.sessionId)) {
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
        // Present only where the payload names one. A spread merge treats a
        // present `undefined` as an erasure, so absence has to be absence.
        ...(newState === undefined ? {} : { state: newState }),
        touchedAt: event.occurredAt,
        ...(event.actorId === undefined ? {} : { attributedTo: event.actorId }),
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

/** The name this family claims its event kinds under, so a conflict names it. */
const RUN_LIFECYCLE_PROJECTOR_OWNER = "frame";

/**
 * The frame's own claim on the run-lifecycle kinds.
 *
 * Called from the seat board beside `registerLegacySurfaces` and
 * `registerConsolePanes`, and for their reason: a composition names every board it
 * writes into at one site. The frame is a family here like any other — it happens to
 * be the family that has a projector today, and the registry has no notion of a
 * privileged one.
 *
 * Registration rather than a constant handed to the store plumbing is the whole
 * change: with a constant, `approval`, `workflow-run`, `browser-page`, `artifact`
 * and every other partition `store/entities.ts` declares could be projected by
 * nobody, because the table was closed one family below the families that own those
 * surfaces.
 */
export function registerRunLifecycleProjectors(registry: ConsoleEntityProjectorRegistry): void {
  registry.registerAll(RUN_LIFECYCLE_PROJECTORS, RUN_LIFECYCLE_PROJECTOR_OWNER);
}

function buildRunLifecycleProjectors(): EntityProjectorRegistry {
  const projectors: Record<string, EntityProjector> = {};
  for (const eventKind of RUN_LIFECYCLE_EVENT_KINDS) {
    projectors[eventKind] = projectRunLifecycleEvent;
  }
  return projectors;
}

/**
 * Does this payload fail to carry the run state its own kind announces?
 *
 * The one cross-member rule in the fold, and it is here because nothing above it
 * can be: `SessionEventSchema` registers no run-lifecycle payload variant, so the
 * strict layer never sees the pair at all, and the envelope schema is
 * payload-tolerant by design. A `run.running` beat carrying `newState: "failed"`
 * therefore arrives well-formed and reports two states at once.
 *
 * EQUALITY, NOT NON-CONTRADICTION. A missing or wrong-typed `newState` reaches this
 * function as absence, and absence used to pass — which let a `run.running` beat
 * carrying no state at all upsert the run with the state its LAST transition
 * established. That is the same disagreement as the loud case and harder to see: the
 * timeline reports the new kind while the partition still reports the old state, and
 * a preserved reading is indistinguishable from a fresh one. So a recognized kind
 * demands its own state, spelled as a string and equal to what the kind announces.
 *
 * SCOPED TO THE KINDS THE MAPPING CLAIMS, which is the eight transitions
 * `run.subscribeState` carries. A kind it answers nothing for announces no
 * transition — the creation row and the three forward, non-state rows — and
 * deciding what those "should" say would mean minting the second kind-to-state
 * mapping this function reads one to avoid. Those kinds still carry whatever state
 * they spell, or none, exactly as before.
 */
function statedStateFailsKind(eventKind: string, statedState: string | undefined): boolean {
  const announcedState = runStateForTransitionKind(eventKind);
  return announcedState !== undefined && statedState !== announcedState;
}

/**
 * Does this payload name the session its envelope was delivered on?
 *
 * `sessionId` is a registered member of the durable `run_lifecycle` row, so a beat
 * that omits it is malformed rather than terse, and one that names a different
 * session is a claim about another store. Neither may key a mutation here: the fold
 * writes into the run partition of the store the envelope was routed to, so either
 * would land session B's run in session A's partition, and no layer above rejects
 * either — the envelope schema admits the payload whole and the strict event union
 * registers no run-lifecycle variant at all.
 *
 * The comparison is against the raw member rather than a read one, so a payload
 * naming a non-string `sessionId` fails here instead of being read as absence.
 * `bridge/run-streams/run-stream-projection.ts` holds the rollback payload to the same rule for
 * the same reason; this is that rule applied to the durable fold.
 */
function payloadNamesThisSession(
  payload: Readonly<Record<string, unknown>> | undefined,
  envelopeSessionId: string,
): boolean {
  return payload?.["sessionId"] === envelopeSessionId;
}
