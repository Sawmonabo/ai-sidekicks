// The four facts the participant card shows, and where each one comes from.
//
// `Spec-023 §The surface set` puts a card behind a cast chip carrying "role, presence
// since, current run, paying account". TWO OF THE FOUR HAVE A READER IN THIS CONSOLE
// and two do not, and this module is where that is settled once rather than in the
// component:
//
//   • **Role** — the roster entry in the session's own `participant` partition, read
//     through `membershipRoleOf`, which is the console's one narrowing for that member.
//     Absent where the partition holds no entry for this participant or the entry
//     carries no parseable role — never defaulted, because a role rendered as `viewer`
//     hides a control an owner is entitled to and one rendered as `owner` offers a
//     control the daemon will refuse.
//   • **Current run** — the session store's `run` partition, narrowed to the rows this
//     participant is attributed with and to the states that are still going. It is a
//     projection of the run stream the console already holds; nothing is read for it.
//   • **Presence since** — NOT CHECKED. No presence read reaches this console:
//     `presence.read` / `presence.subscribe` are registered on no transport the bridge
//     carries and the growth slate holds no row for either, which `cast-bar-model.ts`
//     already records about the chip's own presence glyph. The card says so rather
//     than substituting the newest row's instant, which answers a different question.
//   • **Paying account** — NOT CHECKED. The bar's one cost reading is
//     `orchestrationBudgetRead`, which serves the committed figure and no
//     decomposition; the per-paying-account axis lives on the receipt, which this
//     surface deliberately does not call (`cast-bar-readings.ts` says why). A label
//     composed from anything else would be the renderer deciding who pays.
//
// THE TWO ABSENCES ARE STATED HERE AND RENDERED AS ABSENCES, never as blanks: a card
// that simply omitted them would read as "this participant has no paying account".

import { membershipRoleOf } from "../../bridge/index.js";
import { useSessionEntity, useSessionPartition, type ConsoleEntity } from "../../store/index.js";
import { compareInstants, parseInstant } from "../../core/index.js";

/**
 * The run states that mean a run is still going.
 *
 * Deliberately the LIVE half rather than the terminal half: a state this build does
 * not carry is not a live run, so an unrecognized state answers "no current run"
 * rather than being shown as one. `RunsSection.tsx` groups the same union for a
 * different question and neither reads the other's table — one is about what a person
 * should look at, this is about what is happening right now.
 */
const LIVE_RUN_STATES: ReadonlySet<string> = new Set([
  "queued",
  "starting",
  "running",
  "paused",
  "waiting_for_approval",
  "waiting_for_input",
]);

/** What one participant card renders. Every member is a reading or a stated absence. */
export interface ParticipantCardReading {
  /** The roster's own role string, or `undefined` where no entry answered. */
  readonly role: string | undefined;
  /** The newest still-going run attributed to this participant, or `undefined`. */
  readonly currentRun: ConsoleEntity | undefined;
}

/**
 * Read one participant's card facts out of the session store.
 *
 * Called only while the card is OPEN, because the card is mounted only then — Base
 * UI's tooltip renders no popup while it is closed, so a bar of eight chips holds one
 * subscription per open card and none otherwise.
 */
export function useParticipantCardReading(
  sessionStore: Parameters<typeof useSessionPartition>[0],
  participantId: string,
): ParticipantCardReading {
  const rosterEntry = useSessionEntity(sessionStore, { kind: "participant", id: participantId });
  const runsById = useSessionPartition(sessionStore, "run");
  return {
    role: membershipRoleOf(rosterEntry),
    currentRun: newestLiveRunFor(Object.values(runsById), participantId),
  };
}

/**
 * The newest still-going run this participant is attributed with.
 *
 * A single pass rather than a sort: the card shows one run, so building an ordered
 * list of the rest is work nothing renders.
 */
function newestLiveRunFor(
  runs: readonly ConsoleEntity[],
  participantId: string,
): ConsoleEntity | undefined {
  let newest: ConsoleEntity | undefined;
  for (const run of runs) {
    if (run.attributedTo !== participantId || !LIVE_RUN_STATES.has(run.state ?? "")) {
      continue;
    }
    if (newest === undefined || isStrictlyNewerRun(run, newest)) {
      newest = run;
    }
  }
  return newest;
}

/**
 * Whether one run row was touched strictly later than the run already held.
 *
 * Ordered as MOMENTS through the console's one instant comparison, because lexical
 * order agrees with instant order only while every stamp carries the same offset —
 * a `+01:00` stamp sorts after the `Z` stamp it precedes. An unreadable stamp on
 * either side answers `false` and keeps the held run, which is the fail-closed
 * direction: the alternative lets a stamp the console cannot read displace a
 * reading it can. The same shape `bridge/queue/queue-order.ts` ranks rows with.
 */
function isStrictlyNewerRun(candidate: ConsoleEntity, held: ConsoleEntity): boolean {
  const candidateInstant = parseInstant(candidate.touchedAt ?? "");
  const heldInstant = parseInstant(held.touchedAt ?? "");
  if (candidateInstant.kind === "malformed" || heldInstant.kind === "malformed") {
    return false;
  }
  return compareInstants(candidateInstant, heldInstant, "newest-first") < 0;
}
