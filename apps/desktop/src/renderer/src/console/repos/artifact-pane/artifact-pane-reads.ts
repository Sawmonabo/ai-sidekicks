// The artifact pane's two wire legs, and what each answer reads as.
//
// A MODULE OF ITS OWN BECAUSE THE READER OWNS ONLY WHO ASKED. `artifact-reader.ts`
// says so in its own header: it owns when a read runs, what supersedes it, and how
// the two legs publish as one snapshot. What a served answer MEANS is a different
// question, and it is the one this file answers — for both legs, in one place, so a
// caller comparing the list arm against the bounds arm reads them side by side.
//
// NEITHER LEG CAN REJECT, which is what lets the reader join them rather than fuse
// them. Each goes through `readGrowthAnswer` (`repos/growth-call.ts`), so a bridge that
// dropped one call produces THAT leg's refusal instead of a rejection the join would
// have to catch — and a bounds outage costs exactly the bounds.
//
// AND THAT CLAIM IS ABOUT THE VALUE AS WELL AS THE CALL, which for a while it was
// not. `readGrowthAnswer` makes the call total and `growthAnswerReading` only asks
// whether a `value` member is PRESENT, so a served `artifactList` whose value was
// `null` or an object rejected on the `.map` below, the reader's `Promise.all`
// rejected with it, and the freshly-read bounds were thrown away — the join being a
// fuse on exactly the path this header says it is not. Both legs now read their
// served value through a guard and land a shape they cannot use on the pane's own
// `reply-unreadable`. The premise is this module's own: the fixture bridge is
// assembled behind a cast and the live port is one process boundary away, so what
// arrives is whatever was sent.

import type { ConsoleBridge } from "../../bridge/index.js";
import {
  artifactManifestRowFromSummary,
  type ArtifactsPanelState,
} from "../artifacts/artifact-model.js";
import { replyUnreadableRefusal } from "../growth-call.js";
import {
  SHIPPED_DEFAULT_ALLOWLIST,
  type ArtifactAllowlistReading,
} from "./artifact-pane-reading.js";
import { readGrowthAnswer } from "../growth-call.js";

/** What each leg calls its read, in the sentence a refusal shows. */
const ARTIFACT_LIST_LEG = "The artifact list";
const ALLOWLIST_LEG = "The attachment allow-list read";

/**
 * The session's manifests, or the refusal that says why there are none to show.
 *
 * `listed` WITH AN EMPTY ARRAY IS A DIFFERENT ARM FROM `not-checked`, and the reply's
 * own length is what decides between them — a read that found none is not a read
 * nobody made. That distinction is Rule 8's, and losing it would render an answered
 * empty session exactly like an unopened one.
 *
 * THE MAPPING LIVES ON THE MODEL AND NOT HERE. `GrowthArtifactSummary` mirrors
 * `api-payload-contracts.md §ArtifactManifest` member for member, so a served row
 * becomes a rendered row through `repos/artifacts/artifact-model.ts`'s own constructor beside
 * the vocabularies it fills. What a row IS is a model question; this leg owns only
 * that the list was asked for and what came back.
 */
export async function readArtifactList(
  bridge: ConsoleBridge,
  sessionId: string,
): Promise<ArtifactsPanelState> {
  const answer = await readGrowthAnswer("artifactList", ARTIFACT_LIST_LEG, () =>
    bridge.growth.artifactList({ sessionId }),
  );
  if (answer.status === "refused") {
    return { kind: "refused", refusal: answer.refusal };
  }
  if (!Array.isArray(answer.value)) {
    return {
      kind: "refused",
      refusal: replyUnreadableRefusal(ARTIFACT_LIST_LEG, "something other than a list"),
    };
  }
  return { kind: "listed", rows: answer.value.map(artifactManifestRowFromSummary) };
}

/**
 * Whether a served bounds reply carries the two members this leg reads.
 *
 * BOTH, AND BY TYPE. The allow-list is rendered as a list and the cap as a byte
 * figure, so a reply carrying one of them is not a reply this leg can half-use — it
 * would draw an effective bounds disclosure whose numbers came from nowhere.
 */
function carriesBounds(
  value: unknown,
): value is { readonly contentTypes: readonly string[]; readonly maximumByteLength: number } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { contentTypes?: unknown; maximumByteLength?: unknown };
  return Array.isArray(candidate.contentTypes) && typeof candidate.maximumByteLength === "number";
}

/**
 * The deployment's own bounds, or the shipped defaults and why they are showing.
 *
 * THE REFUSAL IS A DESIGNED ARM OF THIS READING AND NOT A FAILURE OF IT. A
 * deployment that does not serve its bounds is the ordinary case on this build —
 * the wire is unregistered — so the hint falls back to what the console ships and
 * says which of the two a participant is looking at. Reading the refusal off the
 * reply's own shape is what keeps it on that arm: read as served, it took the
 * whole pane read down with a `TypeError` and reported the console as broken.
 *
 * A REJECTED CALL LANDS ON THE SAME ARM, for the same reason and by the same door:
 * a deployment whose bounds read is refused and one whose bounds read never came
 * back are both deployments this pane has no bounds from, and both are cases where
 * the shipped defaults are what a participant is looking at.
 */
export async function readArtifactAllowlist(
  bridge: ConsoleBridge,
  sessionId: string,
): Promise<ArtifactAllowlistReading> {
  const answer = await readGrowthAnswer("artifactAllowlistRead", ALLOWLIST_LEG, () =>
    bridge.growth.artifactAllowlistRead({ sessionId }),
  );
  if (answer.status === "refused") {
    return { ...SHIPPED_DEFAULT_ALLOWLIST, refusal: answer.refusal };
  }
  if (!carriesBounds(answer.value)) {
    // The shipped defaults with the reason beside them, which is what every other
    // unusable bounds answer lands on: a participant is still told which of the two
    // lists they are looking at, and why.
    return {
      ...SHIPPED_DEFAULT_ALLOWLIST,
      refusal: replyUnreadableRefusal(ALLOWLIST_LEG, "no bounds this console can read"),
    };
  }
  return {
    source: "effective",
    mediaTypes: answer.value.contentTypes,
    maximumByteLength: answer.value.maximumByteLength,
    refusal: undefined,
  };
}
