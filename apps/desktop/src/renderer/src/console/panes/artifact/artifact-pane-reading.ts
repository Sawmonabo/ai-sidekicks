// What the artifact pane renders from, and the pure reductions over it.
//
// The seam against `artifact-reader.ts` is WHAT the pane knows against WHO asked for
// it. That file owns the calls, the scheduler, and the generation stamp; this one owns
// the immutable value those produce and every total function over it, so a reduction
// can be driven directly in a test with no bridge, no clock, and no reader at all.
//
// Nothing here reaches the port or the wire. `repos/artifact-model.ts` owns what a
// served manifest IS; this module owns how one reading becomes the next.

import type { GrowthArtifactPayloadEncoding, GrowthArtifactRead } from "../../bridge/index.js";
import {
  ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP,
  ATTACHMENT_BYTE_CAP_DEFAULT,
  refuse,
  type ConsoleRefusal,
} from "../../core/index.js";
import { ATTACHMENT_ALLOWLIST_DEFAULT } from "../../repos/attachment-model.js";
import type {
  ArtifactDeleteReceipt,
  ArtifactManifestRow,
  ArtifactsPanelState,
} from "../../repos/artifact-model.js";

/**
 * The effective allow-list and byte cap, with where they came from.
 *
 * `source` is rendered rather than inferred. An operator override REPLACES the default
 * wholesale — `Spec-014 §Bounds (normative defaults; operator-tunable)` — so a hint that
 * could not say which of the two it is showing would be a hint a participant cannot
 * trust against a deployment they cannot see.
 */
export interface ArtifactAllowlistReading {
  readonly source: "effective" | "shipped-default";
  readonly mediaTypes: readonly string[];
  readonly maximumByteLength: number;
  /** Why the effective read did not answer, on the `shipped-default` arm. */
  readonly refusal: ConsoleRefusal | undefined;
}

/**
 * What one artifact's payload fetch has established.
 *
 * SIX ARMS, BECAUSE THE WIRE HAS TWO AND EACH OF THEM SPLITS. `GrowthArtifactRead` is
 * a union: the DEFERRED arm hands back a CAS key and no bytes, the INLINE arm hands
 * back the bytes with the encoding to read them by. Both are served answers a surface
 * has to draw — "I asked for the bytes and did not get them inline" is not a failure —
 * so neither collapses into the refusal arm. The inline arm then splits on whether the
 * bytes are text: a payload that decodes is previewable and one that does not is
 * reported as what it is rather than drawn as replacement characters.
 *
 * `not-checked` is its own arm and is not `deferred` with an absent handle: nobody has
 * asked, which rule 8 separates from every answer.
 */
export type ArtifactPayloadReading =
  | { readonly status: "not-checked" }
  | { readonly status: "fetching"; readonly artifactId: string }
  | { readonly status: "refused"; readonly artifactId: string; readonly refusal: ConsoleRefusal }
  /** A key to fetch the bytes with, and no verb registered anywhere that fetches by one. */
  | { readonly status: "deferred"; readonly artifactId: string; readonly payloadHandle: string }
  | {
      readonly status: "text";
      readonly artifactId: string;
      readonly encoding: GrowthArtifactPayloadEncoding;
      /** Bounded at `ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP`; `truncated` says so. */
      readonly text: string;
      readonly truncated: boolean;
    }
  /** Bytes that are not text. Reported, never drawn — and never guessed at. */
  | {
      readonly status: "opaque";
      readonly artifactId: string;
      readonly encoding: GrowthArtifactPayloadEncoding;
      readonly reason: "not-utf8" | "undecodable";
    };

/** Everything the pane renders from, in one immutable value. */
export interface ArtifactPaneReading {
  readonly artifacts: ArtifactsPanelState;
  readonly allowlist: ArtifactAllowlistReading;
  /**
   * What the last delete REPORTED, which is not the same as that it happened.
   *
   * On the reading rather than in the pane's `useState`, on `refusalByArtifactId`'s
   * rule: the fact is the daemon's and the reader is what learns it. Cleared by the
   * next list, because the receipt is about a row that list no longer holds and a
   * consequence left standing over a re-read would read as this read's own.
   */
  readonly lastDeleteReceipt: ArtifactDeleteReceipt | undefined;
  /** The payload fetch a participant asked for, at most one at a time. */
  readonly payload: ArtifactPayloadReading;
  /**
   * What the last act on a row answered, keyed by artifact id. Refusals only.
   *
   * Held on the reading rather than in the pane's own `useState`, because a served act
   * CHANGES the row it was about — the read replaces it, the delete removes it — and a
   * refusal kept in a second place would still be beside a row the reader has since
   * re-established.
   */
  readonly refusalByArtifactId: ReadonlyMap<string, ConsoleRefusal>;
}

/**
 * How one act on a row settled, for the sentence the pane announces.
 *
 * FOUR ARMS BECAUSE A LATE ANSWER SPLITS TWO WAYS, AND ONLY ONE OF THEM IS SILENT.
 *
 * `superseded` is an act whose answer changed nothing on screen and never will —
 * the reader was disposed under it, or the act itself was refused after a refresh
 * had already re-read the row it was about. Announcing a settlement for one of
 * those would report work the participant cannot see.
 *
 * `reconciling` is the other half, and it is NOT silent: the act was SERVED while a
 * refresh was in flight, so the fact it established holds — the reader applied it
 * and scheduled the read that re-establishes the rest. It is not `settled` because
 * the racing read may put the row back for the interval before that read lands, and
 * a reader cannot vouch for a screen it does not yet own.
 */
export type ArtifactRowActOutcome =
  | { readonly status: "settled" }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal }
  | { readonly status: "reconciling" }
  | { readonly status: "superseded" };

const NO_ROW_REFUSALS: ReadonlyMap<string, ConsoleRefusal> = new Map();

/** The bounds the console ships with, when the deployment's own could not be read. */
export const SHIPPED_DEFAULT_ALLOWLIST: ArtifactAllowlistReading = {
  source: "shipped-default",
  mediaTypes: ATTACHMENT_ALLOWLIST_DEFAULT,
  maximumByteLength: ATTACHMENT_BYTE_CAP_DEFAULT,
  refusal: undefined,
};

/** Before anyone asked. `not-checked` is a different claim from an empty list. */
export const NOTHING_READ_YET: ArtifactPaneReading = {
  artifacts: { kind: "not-checked" },
  allowlist: SHIPPED_DEFAULT_ALLOWLIST,
  lastDeleteReceipt: undefined,
  payload: { status: "not-checked" },
  refusalByArtifactId: NO_ROW_REFUSALS,
};

/** Which subsystem refused, when the refusal is the reader's own and not the port's. */
export const ARTIFACT_READER_REFUSAL_ORIGIN = "artifact-pane-reader";

/** The one code this reader mints. The port owns every other refusal the pane renders. */
export const ARTIFACT_READ_THREW_CODE = "read-threw";

/**
 * The refusal a read that threw becomes.
 *
 * A thrown value is not a refusal until something makes it one, and the alternative —
 * letting it reject inside a timer callback — leaves the pane on the in-flight absence
 * for the rest of its life. The message is carried; the thrown value is not.
 */
export function readFailureRefusal(error: unknown): ConsoleRefusal {
  const cause =
    error instanceof Error ? error.message : "the read threw a value that is not an error.";
  return refuse(
    ARTIFACT_READER_REFUSAL_ORIGIN,
    ARTIFACT_READ_THREW_CODE,
    `The artifact read failed before it could answer: ${cause}`,
  );
}

/**
 * The listed rows with one replaced by a fresher read of the same artifact.
 *
 * A row the current list no longer holds is left out rather than re-added: the list is
 * what the list read answered, and putting a row back on the strength of a
 * single-artifact read would claim a session membership no list established.
 */
export function withReplacedRow(
  artifacts: ArtifactsPanelState,
  row: ArtifactManifestRow,
): ArtifactsPanelState {
  if (artifacts.kind !== "listed") {
    return artifacts;
  }
  return {
    kind: "listed",
    rows: artifacts.rows.map((listed) => (listed.id === row.id ? row : listed)),
  };
}

/**
 * The listed rows without the one a served delete removed.
 *
 * Reading the served reply rather than predicting it: the daemon answered, so the
 * manifest is gone and the row that stood for it goes with it. The re-read that
 * follows is what re-establishes the rest of the list.
 */
export function withoutRow(
  artifacts: ArtifactsPanelState,
  artifactId: string,
): ArtifactsPanelState {
  if (artifacts.kind !== "listed") {
    return artifacts;
  }
  return { kind: "listed", rows: artifacts.rows.filter((listed) => listed.id !== artifactId) };
}

/**
 * How a delete settled, with the receipt on the two arms the daemon served.
 *
 * `ArtifactRowActOutcome`'s four arms with the receipt added where one exists, rather
 * than a fifth arm or an optional member: the receipt is present on exactly the arms
 * that mean the daemon answered, so a caller narrowing on `status` has it without
 * asking whether it might be absent. Assignable to the shared type, so the pane's one
 * announcer still takes it.
 */
export type ArtifactDeleteOutcome =
  | { readonly status: "settled"; readonly receipt: ArtifactDeleteReceipt }
  | { readonly status: "reconciling"; readonly receipt: ArtifactDeleteReceipt }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal }
  | { readonly status: "superseded" };

/**
 * How a payload fetch settled, with the arm it reached on the one that served.
 *
 * `ArtifactDeleteOutcome`'s shape and its reason: the caller announces what the fetch
 * ESTABLISHED — a handle, a preview, or bytes that are not text — and reaching back
 * into the reading for it would read whatever the reading held by then rather than
 * what this fetch answered. The `reconciling` arm has no analogue here: nothing this
 * fetch establishes can be undone by a list read landing under it.
 */
export type ArtifactPayloadOutcome =
  | { readonly status: "settled"; readonly payload: ArtifactPayloadReading }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal }
  | { readonly status: "superseded" };

/**
 * Read one served payload reply as the arm the pane draws.
 *
 * THE DISCRIMINATOR IS THE REPLY'S OWN AND IS NEVER SNIFFED. `payloadEncoding` is
 * present exactly when `payload` is, and the contract is explicit that a reader
 * switches on it rather than inspecting the bytes — which is the whole reason the
 * member exists beside them. So the inline arm is recognised by that member, and the
 * deferred arm is everything else the union admits.
 *
 * A DECODE THAT FAILS IS AN ANSWER, NOT AN ERROR. Base64 that will not decode and
 * bytes that are not UTF-8 are two different facts about a served reply, and neither
 * is a refusal: the daemon answered. Both land on `opaque` with the reason named, so
 * the pane can say which without a preview that would draw replacement characters and
 * call them the payload.
 */
export function artifactPayloadReadingFrom(
  artifactId: string,
  read: GrowthArtifactRead,
): ArtifactPayloadReading {
  if (read.payloadEncoding === undefined) {
    return { status: "deferred", artifactId, payloadHandle: read.payloadHandle };
  }
  const encoding = read.payloadEncoding;
  const decoded = decodedPayloadText(read.payload, encoding);
  if (decoded.status === "opaque") {
    return { status: "opaque", artifactId, encoding, reason: decoded.reason };
  }
  const truncated = decoded.text.length > ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP;
  return {
    status: "text",
    artifactId,
    encoding,
    text: truncated ? decoded.text.slice(0, ARTIFACT_PAYLOAD_PREVIEW_CHARACTER_CAP) : decoded.text,
    truncated,
  };
}

/** One payload's bytes as text, or why they are not text. */
function decodedPayloadText(
  payload: string,
  encoding: GrowthArtifactPayloadEncoding,
):
  | { readonly status: "text"; readonly text: string }
  | { readonly status: "opaque"; readonly reason: "not-utf8" | "undecodable" } {
  if (encoding === "utf8") {
    return { status: "text", text: payload };
  }
  let bytes: Uint8Array;
  try {
    // RFC 4648 §4, which is what the ingest side encodes with — the two sides of one
    // seam, and `atob` is the platform's own decoder for it.
    const binary = atob(payload);
    bytes = Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
  } catch {
    return { status: "opaque", reason: "undecodable" };
  }
  try {
    // `fatal` so a payload that is not text SAYS so. The lenient decoder answers with
    // replacement characters, which a preview would draw as though they were content.
    return { status: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { status: "opaque", reason: "not-utf8" };
  }
}

/** The row refusals with one act's refusal recorded against its row. */
export function withRowRefusal(
  refusalByArtifactId: ReadonlyMap<string, ConsoleRefusal>,
  artifactId: string,
  refusal: ConsoleRefusal,
): ReadonlyMap<string, ConsoleRefusal> {
  const recorded = new Map(refusalByArtifactId);
  recorded.set(artifactId, refusal);
  return recorded;
}

/** The row refusals without the one an act has since answered for. */
export function withoutRowRefusal(
  refusalByArtifactId: ReadonlyMap<string, ConsoleRefusal>,
  artifactId: string,
): ReadonlyMap<string, ConsoleRefusal> {
  if (!refusalByArtifactId.has(artifactId)) {
    return refusalByArtifactId;
  }
  const remaining = new Map(refusalByArtifactId);
  remaining.delete(artifactId);
  return remaining;
}
