// What an act needs from the half of the pane that reads, and the one write both
// halves of the act side perform.
//
// A MODULE OF ITS OWN BECAUSE TWO CLASSES IMPLEMENT AGAINST IT. `artifact-actions.ts`
// owns the manifest re-read and the delete, `artifact-payload-fetch.ts` owns the
// payload single flight, and both hold the same host and both record a refusal on a
// row. Declared in either of them, the other would import a contract from a peer and
// close a cycle; declared here, the seam has a name and a home.

import type { ConsoleRefusal } from "../../core/index.js";
import type { CurrentGenerationClaim } from "../../store/index.js";
import {
  withRowRefusal,
  type ArtifactPaneReading,
  type ArtifactRowActOutcome,
} from "./artifact-pane-reading.js";

/**
 * What an act needs from the half of the pane that reads.
 *
 * DECLARED ONCE AND IMPLEMENTED BY THE READER, so the two halves share a contract
 * rather than a field. Every member reads or writes state the reader owns, which is
 * why they are named as the operations they are rather than exposed as the fields they
 * touch — `scheduledReadClaim` answers with a round an act COMPARES and can never
 * mint, and `requestRefreshAfterAct` names the one reason an act may put on the
 * scheduler.
 */
export interface ArtifactActionHost {
  /** The reading standing right now. Every publish below spreads forward from it. */
  currentReading(): ArtifactPaneReading;
  publish(reading: ArtifactPaneReading): void;
  /**
   * The round the scheduled read is on.
   *
   * Read, never mutated: an act takes it before its call and asks `isCurrent` after,
   * and a round the reader superseded means a refresh has re-read the rows this act
   * was about. A claim that cannot give the key back is the whole of what makes it
   * safe to hand an act — a settlement cannot revoke the single flight the reader is
   * relying on. It is deliberately NOT the fetch register — see the header.
   */
  scheduledReadClaim(): CurrentGenerationClaim;
  /** Whether the pane behind this reader has gone. The only reason to publish nothing. */
  isDisposed(): boolean;
  /** Ask for the read that follows an act the daemon accepted. */
  requestRefreshAfterAct(): void;
}

/**
 * Put a refusal on one row and answer with it.
 *
 * A FUNCTION OVER THE HOST rather than a method on either act class, because it is a
 * reading operation like the `with*` writers it calls: both act classes record the
 * same way, and a copy in each would be two chances for one of them to drift into
 * writing the refusal somewhere the other does not.
 */
export function recordRowRefusal(
  host: ArtifactActionHost,
  artifactId: string,
  refusal: ConsoleRefusal,
): ArtifactRowActOutcome {
  const reading = host.currentReading();
  host.publish({
    ...reading,
    refusalByArtifactId: withRowRefusal(reading.refusalByArtifactId, artifactId, refusal),
  });
  return { status: "refused", refusal };
}
