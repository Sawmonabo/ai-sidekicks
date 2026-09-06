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

/**
 * The three states an artifact reaches, as the shelf renders them.
 *
 * Declared as a tuple with the union derived from it, so the presentation tables that
 * switch over it are total by construction and a fourth state does not compile until
 * every one of them says what it renders.
 */
export const PRODUCED_ARTIFACT_STATES = ["pending", "published", "superseded"] as const;

export type ProducedArtifactState = (typeof PRODUCED_ARTIFACT_STATES)[number];

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
 * A card this window can justify rendering, and which of the two it is.
 *
 * Declared here rather than beside the shelf that renders it, because the register
 * that MAKES cards and the component that renders them both need it, and the identity
 * reader below is the one place either of them reads an artifact id off one. A second
 * accessor would be a second answer to "which object is this card about".
 */
export type ProducedObjectCard =
  | { readonly kind: "capture"; readonly props: BrowserCaptureCardProps }
  | { readonly kind: "download"; readonly props: BrowserDownloadCardProps };

/**
 * Which produced object a card is about, whichever of the two shapes it has.
 *
 * BOTH ARMS ANSWER WITH THE SHELF'S KEY, which is the artifact id the log's fold
 * carries — `ProducedObjects.tsx` looks cards up by exactly that. The capture arm
 * reads it off `captureName` because `captured-objects.ts` assigns the artifact id
 * into that member, and the download arm carries it as its own `artifactId` because a
 * proposed file name is a page's suggestion and never an identity: a card keyed on one
 * would never be found and would always render as the identity-only row.
 */
export function producedObjectArtifactId(card: ProducedObjectCard): string {
  return card.kind === "capture" ? card.props.captureName : card.props.artifactId;
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
  return PRODUCED_ARTIFACT_STATES.find((state) => state === value);
}

/**
 * Every artifact this session has produced, newest first.
 *
 * Newest first because the shelf's own sentence is "the session's RECENT
 * browser-produced artifacts": a person opening the overflow control after a capture
 * is looking for the capture they just took, and a list in log order would put it
 * last. The sort is over the fold's own positions, so it is stable and needs no clock.
 */
export function foldProducedArtifacts(
  timeline: readonly ConsoleSessionEvent[],
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
