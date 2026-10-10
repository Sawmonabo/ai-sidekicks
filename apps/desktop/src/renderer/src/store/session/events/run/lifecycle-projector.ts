// The `run` partition's projector: run-lifecycle events folded into run entities' bodies, and the
// entity a read's record of a live run seeds in their place. It sits below every feature because
// it reads wire member names, and the composition root registers it.
//
// The claimed kinds and the body's members are derived from the contract, so a new run event or
// member fails to compile until it is classified. A run's `state` is no member here: it is written
// with the run's facts by `facts.ts`, and a state change naming another state than it announces
// changes nothing. The projector is pure, because the apply path rebuilds from prefixes; a run
// event naming no `runId` yields no mutation rather than a throw.

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts/event/session";
import type { SessionLiveRun } from "@ai-sidekicks/contracts/session/methods";
import { transcriptOwnRunIdOf } from "@ai-sidekicks/contracts/transcript/run-attribution";
import { isMisstatedStateChange } from "@ai-sidekicks/contracts/transcript/run-facts";
import { payloadNamesSession } from "#renderer/lib/wire/session-attribution.js";
import type {
  ProjectedSessionEvent,
  EntityMutation,
  EntityProjector,
  EntityProjectorTable,
  StoredEntity,
} from "../../entities/vocabulary.js";
import { readRunEntityBody } from "./entity-body.js";
import { runEntityOfFacts } from "./facts.js";

/** The event kinds this projector claims, derived from the shipped event-type taxonomy. */
export const RUN_LIFECYCLE_EVENT_KINDS: readonly string[] = [...SESSION_EVENT_CATEGORY_BY_TYPE]
  .filter(([, category]) => category === "run_lifecycle")
  .map(([eventType]) => eventType);

/**
 * Fold one run-lifecycle event into the body of the run it names. Pure and total: a payload naming
 * another session, one it cannot key on, or one missing the state its kind announces yields no
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
  const runId = transcriptOwnRunIdOf(payload);
  if (runId === undefined) {
    return [];
  }
  if (isMisstatedStateChange({ type: event.kind, payload })) {
    return [];
  }
  const body = readRunEntityBody(event.kind, payload);
  return [
    {
      operation: "upsert",
      entity: {
        kind: "run",
        id: runId,
        touchedAt: event.occurredAt,
        // A spread merge treats a present `undefined` as an erasure, so leave `body` off.
        ...(body === undefined ? {} : { body }),
      },
    },
  ];
};

/** The projector table the composition root gives `SessionStoreRegistry`: one fold per kind. */
export const RUN_LIFECYCLE_PROJECTORS: EntityProjectorTable = buildRunLifecycleProjectors();

/** The owner the run-lifecycle kinds are registered under, so a conflicting claim names it. */
export const RUN_LIFECYCLE_PROJECTOR_OWNER = "session";

/**
 * The run entity a read's record of a run not yet ended establishes: the state the run is in now,
 * as facts holding through `readThroughSequence`, the log position the record was read at; when its
 * newest run event occurred; and the body members the record carries, its agent among them. A
 * window opened below a run's events learns these here rather than from the events it never read.
 */
export function projectLiveRun(run: SessionLiveRun, readThroughSequence: number): StoredEntity {
  return {
    ...runEntityOfFacts(run.runId, {
      stateEventType: `run.${run.state}`,
      isRewound: false,
      foldedThroughSequence: readThroughSequence,
    }),
    touchedAt: run.touchedAt,
    body: {
      runVersion: run.runVersion,
      ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
      agentId: run.agentId,
    },
  };
}

function buildRunLifecycleProjectors(): EntityProjectorTable {
  const projectors: Record<string, EntityProjector> = {};
  for (const eventKind of RUN_LIFECYCLE_EVENT_KINDS) {
    projectors[eventKind] = projectRunLifecycleEvent;
  }
  return projectors;
}
