// The parts of a run-stream projection that every arm shares: the outcome type, the
// envelope-against-payload session cross-check, the single registered-shape parse, and the refusal
// constructors. `run-stream-projection.fixture.ts` decides which arm a beat travels on; this file
// changes only when the shape of a refusal does. The two types live here, not beside the arms,
// because every helper returns a `RunStreamProjection` and declaring them in the arms module would
// close an import cycle.

import type { QueueItemSummary } from "@ai-sidekicks/contracts/run-queue";
import type { RunRolledBackEvent, RunStateChangeEvent } from "@ai-sidekicks/contracts/run-control";
import type { ZodType } from "zod";

import { readWireString } from "@renderer/lib/wire-strings.js";
import type { ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";

/** One registered payload a narrowed run stream delivers. */
export type RunStreamDelivery = RunStateChangeEvent | RunRolledBackEvent | QueueItemSummary;

/**
 * What one beat projects to on one narrowed stream. An outcome is returned rather than thrown,
 * per `lib/refusal.ts`; the bridge turns `unprojectable` into the named rejection, since the
 * refusal vocabulary belongs to the bridge boundary and the projection rule to this module.
 */
export type RunStreamProjection =
  | { readonly status: "projected"; readonly delivery: RunStreamDelivery }
  | { readonly status: "unprojectable"; readonly detail: string };

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
): RunStreamProjection | undefined {
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
 * Parses one composed candidate through the shape the corpus registers for it. This is the single
 * delivery gate, and a failure names every failing member by path.
 */
export function projectThroughRegisteredShape<Delivery extends RunStreamDelivery>(
  registeredShape: ZodType<Delivery>,
  event: ProjectedSessionEvent,
  candidate: Readonly<Record<string, unknown>>,
): RunStreamProjection {
  const parsed = registeredShape.safeParse(candidate);
  if (!parsed.success) {
    return unprojectableFor(
      event,
      `does not satisfy its registered shape — ` +
        `${parsed.error.issues.map(describeIssue).join("; ")}`,
    );
  }
  return { status: "projected", delivery: parsed.data };
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
export function unprojectableFor(event: ProjectedSessionEvent, fault: string): RunStreamProjection {
  return unprojectable(
    `the "${event.kind}" beat at sequence ${String(event.sequence)} ${fault}. ` +
      "Script what the registered projection reads " +
      "— the beat's own registered payload, and the " +
      "row read it projects from — rather than letting the stream deliver a partial shape.",
  );
}

/** The refusal arm, spelled once. */
export function unprojectable(detail: string): RunStreamProjection {
  return { status: "unprojectable", detail };
}

/** One parse issue as a sentence fragment: which member, and what is wrong with it. */
function describeIssue(issue: {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}): string {
  const member = issue.path.length === 0 ? "the payload" : issue.path.map(String).join(".");
  return `${member}: ${issue.message}`;
}
