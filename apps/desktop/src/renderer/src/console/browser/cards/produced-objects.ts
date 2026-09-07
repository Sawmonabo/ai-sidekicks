// What this session's browser has produced, folded out of the log.
//
// `Spec-023 §Console Design (Meridian)` 12.6: "A capture, a completed download, and a
// bundled asset set each land as an artifact row in the timeline … The pane's overflow
// control shows the session's recent browser-produced artifacts with a
// reveal-in-file-manager action on each local one."
//
// ONE FOLD, NOT A SECOND STORE. The rows come off the session store's own timeline,
// which is already bounded and already the console's single copy of the log — so this
// module holds no cache, no subscription, and no state. It is a pure reduction, which
// is also what makes it drivable from a test without a bridge.
//
// WHY THE ARTIFACT EVENTS ARE THE SOURCE AND NOT A BROWSER EVENT. There is no
// browser-shaped event on the wire and there is deliberately not going to be one: the
// browser is one more caller of the ingest pipeline three other surfaces already use,
// so its produced objects arrive as ordinary `artifact.*` events. That is the
// one-pipeline rule showing through, and it is why this fold reads a registered event
// family rather than waiting for a namespace.
//
// AND WHY THAT MAKES PROVENANCE A SEPARATE QUESTION. The same rule that gives the
// browser a registered family gives it NO way to be told apart inside one: the
// `artifact_publication` payload is `{sessionId, artifactId?, runId?, diffArtifactId?,
// visibility?, state}` plus the relay's additive members, and neither
// `docs/specs/006-session-event-taxonomy-and-audit-log.md` nor the `ArtifactPublish` /
// `ArtifactRead` shapes in `docs/architecture/contracts/api-payload-contracts.md`
// carry a producer, an origin, or anything else naming what made the object — the
// manifest's `createdBy` names the publishing PARTICIPANT and not a surface. So a
// fold that accepted every readable artifact beat was not folding browser output at
// all — a repository attachment published from the same session is that exact shape,
// and it listed under "Produced objects" as though this window had made it.
//
// `produced-provenance.ts` answers it, and this fold takes its set: the daemon says
// which artifacts came out of the browser, this window adds the ones its own capture
// acts minted, and the log supplies the one thing neither can — the state each object
// has since reached. Never a heuristic on media type or file name, and never the
// renderer's own card register, which knows only the acts this window performed and
// forgets those the moment the pane remounts.
//
// AND WHY THE PAYLOAD IS READ DEFENSIVELY. `packages/contracts` registers the three
// artifact event TYPES and no payload variant for any of them, so the store carries
// the payload as an open record and there is no schema to narrow it with. The reader
// below therefore checks each member it uses and DROPS a beat it cannot read, rather
// than coercing one — a row keyed by an absent id would be a row for an artifact that
// does not exist, and a state read off a value that is not one of the three would put
// an unrenderable arm into a total table.
//
// LAST WRITE WINS, PER ARTIFACT. A capture appears three times in a browsing session —
// pending, published, then superseded by a retake — and it is one object each time. A
// fold that appended would show the same capture three times in a shelf whose whole
// density rule is one row per produced object.

import type { ConsoleSessionEvent } from "../../store/index.js";
import type { BrowserCaptureCardProps } from "./CaptureCard.js";
import type { BrowserDownloadCardProps } from "./DownloadCard.js";
import { isProducedArtifactState, type ProducedArtifactState } from "./produced-artifact-state.js";

/**
 * The artifact event types this fold reads, and the only ones.
 *
 * `artifact.visibility_updated` is among them because a visibility change is a fact
 * about a row this shelf is already showing — dropping it would leave the row
 * rendering a visibility the log has since moved. It carries no state transition, so
 * the state it contributes is whatever the beat states.
 */
const PRODUCED_ARTIFACT_EVENT_KINDS: readonly string[] = [
  "artifact.published",
  "artifact.superseded",
  "artifact.visibility_updated",
];

/** One produced object, as the log knows it: identity, state, attribution. */
export interface ProducedArtifact {
  readonly artifactId: string;
  readonly state: ProducedArtifactState;
  /** The run that produced it, where the beat named one. */
  readonly runId: string | undefined;
  /** The visibility class the beat carried, where it carried one. Wire-verbatim. */
  readonly visibility: string | undefined;
  /** The position of the newest beat about this artifact. The shelf's sort key. */
  readonly latestSequence: number;
}

/**
 * One produced object the shelf may list, and what this window can say about it.
 *
 * Declared here rather than beside the shelf that renders it, because the register
 * that MAKES cards, the ledger that names the rest, and the component that renders
 * both all need it.
 *
 * THREE ARMS, AND THE THIRD IS THE ONE THAT MAKES THIS A LEDGER. The first two are
 * cards for the acts this window performed. `named` is an object the WIRE named as
 * browser output that this window did not make — an agent's capture, a completed
 * download, a bundled asset set, anything produced before this pane's mount — and it
 * carries an artifact id and nothing else, because inventing a media type or a byte
 * length for bytes this window never held is the fabrication the identity row exists
 * to avoid. `produced-provenance.ts` owns where each arm comes from.
 *
 * THE LIFECYCLE STATE IS SUBTRACTED FROM ALL THREE, and that subtraction is the type
 * saying where each half of a row comes from. A card is composed out of what the
 * producing act answered with — an artifact id, a media type, a byte length — and the
 * act cannot answer with a state it has not reached yet. The state is the LOG's,
 * joined on at the shelf, so a register that tried to hold one would be a second and
 * staler answer to a question `foldProducedArtifacts` already answers.
 */
export type ProducedObjectCard =
  | { readonly kind: "capture"; readonly props: Omit<BrowserCaptureCardProps, "state"> }
  | { readonly kind: "download"; readonly props: Omit<BrowserDownloadCardProps, "state"> }
  | { readonly kind: "named"; readonly props: { readonly artifactId: string } };

/**
 * Which produced object a card is about, whichever arm it is.
 *
 * ONE MEMBER ON EVERY ARM, read the same way. The capture arm used to answer with its
 * `captureName`, because the register assigned the artifact id into that member — so
 * the shelf's key and the human-readable name were the same string by construction,
 * and the card put a locator where a name belongs. Every arm now carries its own
 * `artifactId`, which is what the log's fold keys on and what a later fetch is keyed
 * by, and none of them is reachable by reading a display value. That is also the whole
 * of what the `named` arm carries, which is why this accessor stayed one line when the
 * ledger arm joined the union rather than growing a branch per shape.
 */
export function producedObjectArtifactId(card: ProducedObjectCard): string {
  return card.props.artifactId;
}

/** A payload member as a non-empty string, or nothing. */
function readStringMember(
  payload: Readonly<Record<string, unknown>> | undefined,
  member: string,
): string | undefined {
  const value = payload?.[member];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A payload's `state`, where it is one of the three the shelf can render. */
function readProducedState(
  payload: Readonly<Record<string, unknown>> | undefined,
): ProducedArtifactState | undefined {
  const value = payload?.["state"];
  return isProducedArtifactState(value) ? value : undefined;
}

/**
 * Every artifact this window produced, newest first, as the log now knows it.
 *
 * `producedArtifactIds` is the provenance, and `produced-provenance.ts` is where it
 * comes from: the artifacts the daemon named as this session's browser output, plus
 * the ones this window's own capture acts minted. An artifact the log carries that is
 * not in that set is some other surface's output — a repository attachment, a diff, an
 * agent's publish from another tool — and it belongs on the timeline rather than on a
 * shelf whose sentence is "browser-produced". An empty set therefore folds to no rows,
 * which is the honest reading of a session whose browser has produced nothing rather
 * than an empty view of its artifacts.
 *
 * Newest first because the shelf's own sentence is "the session's RECENT
 * browser-produced artifacts": a person opening the overflow control after a capture
 * is looking for the capture they just took, and a list in log order would put it
 * last. The sort is over the fold's own positions, so it is stable and needs no clock.
 */
export function foldProducedArtifacts(
  timeline: readonly ConsoleSessionEvent[],
  producedArtifactIds: ReadonlySet<string>,
): readonly ProducedArtifact[] {
  const byArtifactId = new Map<string, ProducedArtifact>();
  for (const event of timeline) {
    if (!PRODUCED_ARTIFACT_EVENT_KINDS.includes(event.kind)) {
      continue;
    }
    const artifactId = readStringMember(event.payload, "artifactId");
    const state = readProducedState(event.payload);
    if (artifactId === undefined || state === undefined) {
      continue;
    }
    if (!producedArtifactIds.has(artifactId)) {
      continue;
    }
    const existing = byArtifactId.get(artifactId);
    if (existing !== undefined && existing.latestSequence > event.sequence) {
      // An out-of-order delivery. The newest beat is the one that decides the state,
      // and "newest" is the log's position rather than the order this loop saw them.
      continue;
    }
    byArtifactId.set(artifactId, {
      artifactId,
      state,
      runId: readStringMember(event.payload, "runId"),
      visibility: readStringMember(event.payload, "visibility"),
      latestSequence: event.sequence,
    });
  }
  return [...byArtifactId.values()].sort(
    (left, right) => right.latestSequence - left.latestSequence,
  );
}
