// The parts of a run-stream projection that every arm shares: the outcome type, the
// envelope-against-payload session cross-check, the single registered-shape check, and the refusal
// constructors. `projection.fixture.ts` decides which arm a beat travels on; this file
// changes only when the shape of a refusal does. The types live here, not beside the arms, because
// every helper returns one and declaring them in the arms module would close an import cycle.

import type {
  AgentRunRolledBackEvent,
  RunStateChangeEvent,
} from "@ai-sidekicks/contracts/run/control";
import type { QueueItemSummary } from "@ai-sidekicks/contracts/run/queue";
import type { SchemaCheck } from "@ai-sidekicks/contracts/schema-check";

import { checkFaultPaths } from "#renderer/services/daemon/wire/fault-path.js";

import { readWireString } from "#renderer/lib/wire/strings.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";

/** One registered payload a narrowed run stream delivers inside a frame's change. */
export type RunStreamDelivery = RunStateChangeEvent | AgentRunRolledBackEvent | QueueItemSummary;

/** A beat its stream cannot deliver, and why in words a scenario author can act on. */
export interface RunStreamUnprojectable {
  readonly status: "unprojectable";
  readonly detail: string;
}

/**
 * What one beat projects to on one narrowed stream, narrowed to the payloads its arm registers.
 * An outcome is returned rather than thrown, per `lib/refusal/contract.ts`; the bridge turns
 * `unprojectable` into the named rejection, since the refusal vocabulary belongs to the bridge
 * boundary and the projection rule to this module.
 */
export type RunStreamProjection<Delivery extends RunStreamDelivery = RunStreamDelivery> =
  | { readonly status: "projected"; readonly delivery: Delivery }
  | RunStreamUnprojectable;

/**
 * The envelope-against-payload session cross-check for every arm of both run streams. A beat
 * delivered on session A whose payload names session B is a frame no daemon produces, and the
 * state and queue stream shapes carry no `sessionId`, so the mismatch would otherwise reach a
 * subscriber unnoticed. It is one guard, not three copies that could drift. A non-string
 * `sessionId` refuses like an absent one, since it cannot be compared.
 *
 * Returns the refusal, or `undefined` when the beat agrees with its envelope.
 */
export function refuseSessionDisagreement(
  event: ProjectedSessionEvent,
  payload: Readonly<Record<string, unknown>>,
): RunStreamUnprojectable | undefined {
  const statedSessionId = readWireString(payload["sessionId"]);
  if (statedSessionId === undefined) {
    return unprojectableFor(
      event,
      "names no `sessionId`, which every registered run payload requires " +
        "and which no other member of these shapes can stand in for",
    );
  }
  if (statedSessionId !== event.sessionId) {
    return unprojectableFor(
      event,
      `is delivered on session "${event.sessionId}" and names ` +
        `${JSON.stringify(statedSessionId)} in its payload; outer attribution ` +
        `and payload cannot disagree about which session a beat is about`,
    );
  }
  return undefined;
}

/**
 * Checks one composed candidate with the generated check of the shape it is delivered as. This is
 * the single delivery gate, and a failure names the failing member by path and the rule it broke.
 */
export function projectThroughRegisteredShape<Delivery extends RunStreamDelivery>(
  registeredCheck: SchemaCheck<Delivery>,
  event: ProjectedSessionEvent,
  candidate: Readonly<Record<string, unknown>>,
): RunStreamProjection<Delivery> {
  if (!registeredCheck(candidate)) {
    const [fault] = registeredCheck.errors ?? [];
    const [faultPath] = checkFaultPaths(registeredCheck, candidate);
    const member =
      faultPath === undefined || faultPath.path.length === 0
        ? "the payload"
        : faultPath.path.map(String).join(".");
    return unprojectableFor(
      event,
      `does not satisfy its registered shape — ${member} breaks the schema's ` +
        `"${fault?.keyword ?? "unknown"}" rule`,
    );
  }
  return { status: "projected", delivery: candidate };
}

/** Every carried optional member the payload actually supplies, wire-verbatim. */
export function carriedOptionalMembers(
  payload: Readonly<Record<string, unknown>>,
  carriedMembers: Readonly<Record<string, true>>,
): Readonly<Record<string, unknown>> {
  const carried: Record<string, unknown> = {};
  for (const member of Object.keys(carriedMembers)) {
    const value = payload[member];
    if (value !== undefined) {
      carried[member] = value;
    }
  }
  return carried;
}

/** A refusal naming the beat it is about, so a scenario author can find it. */
export function unprojectableFor(
  event: ProjectedSessionEvent,
  fault: string,
): RunStreamUnprojectable {
  return unprojectable(
    `the "${event.kind}" beat at sequence ${String(event.sequence)} ${fault}. ` +
      "Script what the registered projection reads " +
      "— the beat's own registered payload, and the " +
      "row read it projects from — rather than letting the stream deliver a partial shape.",
  );
}

/** The refusal arm, spelled once. */
export function unprojectable(detail: string): RunStreamUnprojectable {
  return { status: "unprojectable", detail };
}
