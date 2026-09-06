// The parts of a run-stream projection that every arm shares.
//
// `run-stream-projection.ts` beside it answers WHICH arm a beat travels on and what
// that arm composes. This answers what all three arms do identically: the outcome
// they return, the envelope-against-payload session cross-check none of them may
// skip, the single parse every composed candidate leaves through, and the two
// refusal constructors that name the beat a reader has to go and find. The two were
// one file until it passed this package's size ceiling, and the seam they split on
// is that one changes when an ARM changes and this one changes when the shape of a
// refusal does.
//
// The two types live HERE rather than beside the arms because the dependency runs
// one way: every helper below returns a `RunStreamProjection`, so declaring them in
// the arms module would close an import cycle `structure:layering` rejects. Nothing
// re-exports them, and nothing needs to — `projectRunStreamDelivery` is the only
// symbol read from outside this family, and it is read from the module declaring it.

import type {
  QueueItemSummary,
  RunRolledBackEvent,
  RunStateChangeEvent,
} from "@ai-sidekicks/contracts";
import type { ZodType } from "zod";

import { readWireString } from "../../core/index.js";
import type { ConsoleSessionEvent } from "../../store/index.js";

/** One registered payload a narrowed run stream delivers. */
export type RunStreamDelivery = RunStateChangeEvent | RunRolledBackEvent | QueueItemSummary;

/**
 * What one beat projects to on one narrowed stream.
 *
 * A returned outcome rather than a thrown error, per `core/refusal.ts`: returning a
 * refusal is the console's default and an exception is the exception. The bridge is
 * what turns `unprojectable` into the named rejection a caller sees, because the
 * refusal VOCABULARY belongs to the bridge boundary and the projection rule belongs
 * here — the same split the scenario engine and the bridge already keep for a
 * scripted reply that never came due.
 */
export type RunStreamProjection =
  | { readonly status: "projected"; readonly delivery: RunStreamDelivery }
  | { readonly status: "unprojectable"; readonly detail: string };

/**
 * The envelope-against-payload session cross-check, for every arm of both run streams.
 *
 * A fact about this BEAT that no schema can make, and one none of the three arms can
 * skip. `Spec-006` gives every one of these payloads a required `sessionId`, so a beat
 * delivered on session A whose payload names session B is not a beat that omitted a
 * check: it is a frame no daemon produces. The state and queue arms then compound it,
 * because neither registered stream shape carries a `sessionId` member at all — the
 * projection drops the disagreeing value on the floor and the narrowed subscriber
 * receives a valid-looking update about a session it never asked for, with nothing on
 * the delivered payload left to notice it by.
 *
 * ONE GUARD RATHER THAN THREE COPIES, because three copies of one comparison drift
 * and the gate goes green: the rollback arm carried this rule alone for one round and
 * the two arms beside it were the ones that could hide the mismatch afterwards.
 *
 * A non-string `sessionId` refuses on the same arm as an absent one. It cannot be
 * compared to the envelope's, and admitting it here would leave the state and queue
 * arms delivering on an identifier nothing ever checked.
 *
 * Returns the refusal, or `undefined` when the beat agrees with its envelope — the
 * guard shape a caller reads as "nothing to say" without a second status vocabulary.
 */
export function refuseSessionDisagreement(
  event: ConsoleSessionEvent,
  payload: Readonly<Record<string, unknown>>,
): RunStreamProjection | undefined {
  const statedSessionId = readWireString(payload["sessionId"]);
  if (statedSessionId === undefined) {
    return unprojectableFor(
      event,
      "names no `sessionId`, which every registered run payload requires and which no other member of these shapes can stand in for",
    );
  }
  if (statedSessionId !== event.sessionId) {
    return unprojectableFor(
      event,
      `is delivered on session "${event.sessionId}" and names ${JSON.stringify(statedSessionId)} in its payload; outer attribution and payload cannot disagree about which session a beat is about`,
    );
  }
  return undefined;
}

/**
 * Parse one composed candidate through the shape the corpus registers for it.
 *
 * The single delivery gate: nothing leaves this module without passing the schema a
 * live subscriber would be handed values against. A failure names every failing
 * member by its own path, so a scenario author reads which member is wrong rather
 * than that something is.
 */
export function projectThroughRegisteredShape<Delivery extends RunStreamDelivery>(
  registeredShape: ZodType<Delivery>,
  event: ConsoleSessionEvent,
  candidate: Readonly<Record<string, unknown>>,
): RunStreamProjection {
  const parsed = registeredShape.safeParse(candidate);
  if (!parsed.success) {
    return unprojectableFor(
      event,
      `does not satisfy its registered shape — ${parsed.error.issues.map(describeIssue).join("; ")}`,
    );
  }
  return { status: "projected", delivery: parsed.data };
}

/** One parse issue as a sentence fragment: which member, and what is wrong with it. */
function describeIssue(issue: {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}): string {
  const member = issue.path.length === 0 ? "the payload" : issue.path.map(String).join(".");
  return `${member}: ${issue.message}`;
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
export function unprojectableFor(event: ConsoleSessionEvent, fault: string): RunStreamProjection {
  return unprojectable(
    `the "${event.kind}" beat at sequence ${String(event.sequence)} ${fault}. ` +
      "Script what the registered projection reads — the beat's own registered payload, and the " +
      "row read it projects from — rather than letting the stream deliver a partial shape.",
  );
}

/** The refusal arm, spelled once. */
export function unprojectable(detail: string): RunStreamProjection {
  return { status: "unprojectable", detail };
}
