// How loudly the stuck badge speaks, given the daemon's own answer.
//
// `Spec-023 §Console Design (Meridian)` §Diagnostics and health: the stuck badge
// appears "at the 60 second threshold and escalat[es] in presentation at 5 minutes".
// Both numbers are about PRESENTATION and neither is about the verdict: whether a run
// is stuck is `health.stuckRunInspect`'s answer, and this console composes no verdict
// of its own — the same section forbids it in as many words.
//
// SO THE DAEMON'S SIGNAL IS THE GATE AND THE DURATION IS ONLY THE VOLUME. A run the
// daemon reports `healthy` renders no badge however long its quiet interval is, which
// is the fail-closed direction: this module can make a warning louder and can never
// invent one. A run the daemon reports `stuck-suspected` renders a badge even below
// the notice bound, because refusing to draw the daemon's own warning would be
// exactly the "hides a failed run to keep the surface calm" the section prohibits —
// what the bound buys there is a quieter sentence, not a hidden one.
//
// THE QUIET INTERVAL IS MEASURED ONCE, AT READ SETTLEMENT, AND NEVER TICKS. The read
// stamps the clock's instant beside the reply and the tier is a pure function of the
// pair, so a badge changes tone when a read lands and at no other moment. A tier that
// re-derived on a timer would be the interval polling this page may not do, wearing a
// presentation rule's clothes.

import { parseInstant, STUCK_RUN_ESCALATION_MS, STUCK_RUN_NOTICE_MS } from "../../../core/index.js";

/**
 * The three volumes, in the order they escalate.
 *
 * `quiet` is the badge below the notice bound — the daemon is suspicious and the run
 * has only just gone still, which is a different sentence from a run that has been
 * still for six minutes and is not worth the same emphasis.
 */
export const STALL_TIERS = ["quiet", "noticed", "escalated"] as const;

/** One such tier. Derived, so the set is declared exactly once. */
export type StallTier = (typeof STALL_TIERS)[number];

/**
 * The tier for one quiet interval.
 *
 * `undefined` for an interval this console could not measure — an unparseable
 * `lastProgressAt`, or a stamp ahead of the reading clock — because a tier chosen
 * from a duration nobody could compute would be emphasis composed out of nothing.
 * The caller renders the badge without the interval in that case, which is the honest
 * shape: the daemon's warning survives and this console's embellishment does not.
 */
export function stallTierFor(quietMilliseconds: number | undefined): StallTier | undefined {
  if (quietMilliseconds === undefined || !Number.isFinite(quietMilliseconds)) {
    return undefined;
  }
  if (quietMilliseconds < 0) {
    // A progress stamp in the future of the clock that read it. Two honest causes —
    // a node whose clock runs ahead of this window's, and a fixture advanced past a
    // scripted instant — and in both the interval is not a duration anybody can
    // stand behind, so none is reported.
    return undefined;
  }
  if (quietMilliseconds >= STUCK_RUN_ESCALATION_MS) {
    return "escalated";
  }
  return quietMilliseconds >= STUCK_RUN_NOTICE_MS ? "noticed" : "quiet";
}

/**
 * How long the run has been making no progress, as of the instant it was read.
 *
 * `undefined` where the daemon's stamp could not be read at all, which the tier above
 * turns into a badge with no interval rather than a badge with a made-up one.
 *
 * THE CLOCK IS THE CONSOLE'S AND THE STAMP IS THE DAEMON'S, and that is the honest
 * limit of this figure: two machines' clocks can disagree, so this is how long the
 * run has been quiet BY THIS WINDOW'S RECKONING. The page says so where it renders
 * it, because a duration presented as the node's own would be a claim this side of
 * the wire cannot make.
 */
export function quietMillisecondsSince(
  lastProgressAt: string,
  readAtMilliseconds: number,
): number | undefined {
  const lastProgress = parseInstant(lastProgressAt);
  if (lastProgress.kind === "malformed") {
    return undefined;
  }
  return readAtMilliseconds - lastProgress.epochMilliseconds;
}
