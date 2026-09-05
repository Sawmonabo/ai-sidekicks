// The artifact pane's two wire legs, and what each answer reads as.
//
// A MODULE OF ITS OWN BECAUSE THE READER OWNS ONLY WHO ASKED. `artifact-reader.ts`
// says so in its own header: it owns when a read runs, what supersedes it, and how
// the two legs publish as one snapshot. What a served answer MEANS is a different
// question, and it is the one this file answers — for both legs, in one place, so a
// caller comparing the list arm against the bounds arm reads them side by side.
//
// NEITHER LEG CAN REJECT, which is what lets the reader join them rather than fuse
// them. Each goes through `readGrowthAnswer` (`growth-call.ts`), so a bridge that
// dropped one call produces THAT leg's refusal instead of a rejection the join would
// have to catch — and a bounds outage costs exactly the bounds.

import type { ConsoleBridge } from "../../bridge/index.js";
import {
  artifactManifestRowFromSummary,
  type ArtifactsPanelState,
} from "../artifacts/artifact-model.js";
import {
  SHIPPED_DEFAULT_ALLOWLIST,
  type ArtifactAllowlistReading,
} from "./artifact-pane-reading.js";
import { readGrowthAnswer } from "./growth-call.js";

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
  const answer = await readGrowthAnswer("The artifact list", () =>
    bridge.growth.artifactList({ sessionId }),
  );
  if (answer.status === "refused") {
    return { kind: "refused", refusal: answer.refusal };
  }
  return { kind: "listed", rows: answer.value.map(artifactManifestRowFromSummary) };
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
  const answer = await readGrowthAnswer("The attachment allow-list read", () =>
    bridge.growth.artifactAllowlistRead({ sessionId }),
  );
  if (answer.status === "refused") {
    return { ...SHIPPED_DEFAULT_ALLOWLIST, refusal: answer.refusal };
  }
  return {
    source: "effective",
    mediaTypes: answer.value.contentTypes,
    maximumByteLength: answer.value.maximumByteLength,
    refusal: undefined,
  };
}
