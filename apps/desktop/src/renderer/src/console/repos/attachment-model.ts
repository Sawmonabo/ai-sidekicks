// What an attachment IS to this console: the vocabularies, the bounds, the copy, and
// the one arithmetic step every progress figure passes through.
//
// THIS FAMILY'S OWN VOCABULARY for attachments, stated here because no committed
// document states it. The split against `attachment-ingest.ts`
// beside it is behaviour versus vocabulary, the same split `artifact-model.ts` and
// `ArtifactsPanel.tsx` already make one directory over: this module holds no state,
// performs no call, and imports nothing that does, so a card can render an attachment
// without pulling the ingest client in behind it.
//
// WIRE TRUTH FIRST. `packages/contracts` registers NO attachment type. The nearest
// thing on the wire is `SteerPayload.attachments`, typed `z.array(z.unknown())` with a
// count cap of 64 — an UNTYPED arm, and `Spec-014 §Interfaces And Contracts` forbids
// delivering an attachment over one. There is no `AttachmentIngestInit` shape, no
// method string for any leg of the ingest trio, and no manifest type. So the shapes
// below are CONSOLE VIEW MODELS transcribing what `Spec-014` names, and every call that
// would fill them goes through `bridge/growth-port.ts`, which refuses by name
// (`artifact-ingest-and-crud`, `artifact-allowlist-and-abort`). Nothing here claims the
// daemon sends it.
//
// THE DECLARED VALUES ARE ADVISORY AND THE DERIVED ONES ARE THE TRUTH. `Spec-014
// §Required Behavior` makes a caller's `mediaType` and `sizeBytes` hints that narrow a
// signature check and never widen acceptance, so `AttachmentSource` holds them as
// DECLARED and `AttachmentDerivedTruth` is a separate shape that replaces them once the
// daemon has read the bytes. Two shapes rather than optional fields on one, because a
// card that showed a declared type where a derived one belongs would be reporting the
// caller's claim as the server's finding.
//
// WHAT THIS MODULE REFUSES TO MODEL — its own Never list, because no committed
// document carries one for this surface:
//   • No payload bytes, in any field. An attachment REFERENCE is a typed, ordered list
//     of artifact ids and never bytes, and no shape here carries a manifest's content.
//     The source below holds the participant's own `Blob` — a handle the browser owns,
//     which the ingest client reads one bounded slice at a time — because a stream with
//     no byte source can only describe a file it never sends. A handle is not a copy:
//     nothing in this module reads it, and no field anywhere holds a whole payload.
//   • No payload on an entry that cannot send it. A handle is not a copy, but it is a
//     KEEP: the browser holds those bytes for as long as anything can still reach the
//     `Blob`, so a carrier that kept every finished upload's source kept every finished
//     upload — a hundred megabytes each, until the sidebar unmounted. The entry is
//     therefore a union over its own state: the arms that can still send carry the
//     payload and the terminal arms carry name, size, media type, and the minted
//     artifact id and nothing else. Not a rule about remembering to drop it — a
//     `complete` entry has nowhere to put one.
//   • No client-side type gate. The allow-list below is a HINT for the picker and the
//     default stated where the effective list cannot be read; a hard block here would
//     make the console wrong about an operator-widened deployment it cannot see.
//   • No filename rebuilt from the raw input. `normalizedName` is what renders and what
//     is used; the caller's original string survives as manifest metadata the console
//     never turns back into a path component.
//   • No unresolved cause recomputed from live relay state. The marker is read from the
//     reading node's own manifest row and mapped to copy here, never to a fresher
//     answer.

import {
  INGEST_STALL_DISCLOSURE_MS,
  INGEST_STREAM_LIFETIME_CEILING_MS,
  reportTripwire,
} from "../core/index.js";

// --- Where the bounds live -----------------------------------------------
//
// NOT HERE. The attachment byte cap, the carrier cap, the chunk cap, the stream
// lifetime, and the stall disclosure are behavioural limits three families spend —
// this model, the ingest client, and the artifact pane — and four of the five mirror a
// bound `Spec-014 §Bounds (normative defaults; operator-tunable)` registers on the
// wire. A view-family model holding them would make this module a configuration
// authority its neighbours had to import to learn a number the daemon owns, so they
// sit in `core/constants.ts` with their rationales and their wire sources, and the two
// this file's own arithmetic spends are imported above like any other consumer's.

// --- The default allow-list ----------------------------------------------
//
// `Spec-014 §Bounds (normative defaults; operator-tunable)` ships this value-for-value,
// and an operator override REPLACES it wholesale with no merge semantics — so the hint is this list or the operator's, never
// this list plus a set of edits. `image/svg+xml` is deliberately absent: it is the one
// image type that is also a scriptable document, and its exclusion is a recorded
// decision rather than an oversight.

/** Admitted on a UTF-8 well-formedness proof rather than a byte signature. */
export const ATTACHMENT_SIGNATURE_EXEMPT_MEDIA_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/yaml",
  "text/xml",
  "text/x-diff",
] as const;

/** Admitted on the payload's own leading signature. */
export const ATTACHMENT_SIGNATURE_VERIFIED_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/zip",
  "application/gzip",
] as const;

/** The whole shipped default, in the order the two subsets are stated. */
export const ATTACHMENT_ALLOWLIST_DEFAULT: readonly string[] = [
  ...ATTACHMENT_SIGNATURE_EXEMPT_MEDIA_TYPES,
  ...ATTACHMENT_SIGNATURE_VERIFIED_MEDIA_TYPES,
];

// --- Ingest states --------------------------------------------------------

/**
 * Where one attachment's ingest stands. Closed.
 *
 * `abandoned` is its own member and not a flavour of `refused`: nobody refused it, the
 * participant stopped sending and the daemon's reaper claims the spool. Rendering the
 * two the same way would tell a participant their cancellation was an error.
 */
export const ATTACHMENT_INGEST_STATES = [
  "declared",
  "ingesting",
  "complete",
  "refused",
  "abandoned",
] as const;

/** One ingest state. Derived, so the vocabulary is declared exactly once. */
export type AttachmentIngestState = (typeof ATTACHMENT_INGEST_STATES)[number];

/**
 * What a refusal means for the NEXT act, which is the only thing a participant can use.
 *
 * `Spec-014 §Interfaces And Contracts` makes every call of the ingest trio retry-safe —
 * a replayed chunk is acknowledged without re-appending, and a replayed completion
 * replays its original response verbatim — so a lost response is retried in place and
 * never restarted. The two named codes are the exceptions and they are deliberately
 * distinct: `artifact.ingest_stream_invalid` (409) is terminal for the stream and means
 * begin again, `artifact.ingest_capacity_exhausted` (429) is transient with no stream
 * state created and means wait and retry. Collapsing them would tell a participant to
 * re-upload a hundred megabytes because the daemon was momentarily busy.
 */
export const INGEST_REFUSAL_DISPOSITIONS = ["retry-in-place", "wait-and-retry", "restart"] as const;

/** One disposition. Derived. */
export type IngestRefusalDisposition = (typeof INGEST_REFUSAL_DISPOSITIONS)[number];

/**
 * The two daemon codes whose disposition differs from the retry-safe default.
 *
 * Named here as strings because `packages/contracts` registers NEITHER — there is no
 * artifact error namespace in `error.ts` at all. They are `Spec-014`'s codes, matched
 * against whatever a refusal carries, and they are not method names, event types, or
 * wire fields: a code the console does not recognise takes the retry-in-place arm,
 * which is the contract's own default rather than a guess.
 */
export const INGEST_STREAM_INVALID_CODE = "artifact.ingest_stream_invalid";
export const INGEST_CAPACITY_EXHAUSTED_CODE = "artifact.ingest_capacity_exhausted";

/** What a participant should do next about this refusal. Total over every code. */
export function ingestRefusalDisposition(code: string): IngestRefusalDisposition {
  if (code === INGEST_STREAM_INVALID_CODE) {
    return "restart";
  }
  if (code === INGEST_CAPACITY_EXHAUSTED_CODE) {
    return "wait-and-retry";
  }
  return "retry-in-place";
}

/** The sentence each disposition puts in front of the control that acts on it. */
export const INGEST_DISPOSITION_COPY: Readonly<Record<IngestRefusalDisposition, string>> = {
  "retry-in-place":
    "Retrying sends the same chunk again. A chunk the daemon already has is acknowledged without being appended twice, so nothing is uploaded a second time.",
  "wait-and-retry":
    "The daemon is at capacity and created no stream state. Waiting and retrying is the whole remedy; the bytes already sent are unaffected.",
  restart:
    "This stream is over and cannot be resumed. Retrying begins the upload again from the first byte.",
};

/** What cancelling actually does, said exactly rather than as "cancelled". */
export const INGEST_ABANDON_COPY =
  "Sending stops now. The bytes already spooled are cleaned up shortly by the daemon rather than instantly, and no artifact is minted.";

// --- The unresolved marker ------------------------------------------------

/**
 * Why an attachment could not be resolved where it sits. Closed at six.
 *
 * `Spec-014 §Fallback Behavior` requires the turn to PROCEED and the marker to sit in
 * the attachment's declared position — never appended, never footnoted — so this is a
 * per-position reading and not a page-level banner.
 */
export const UNRESOLVED_ATTACHMENT_CAUSES = [
  "deleted",
  "local_only_remote",
  "pending_replication",
  "over_cap",
  "quota_exceeded",
  "expired",
] as const;

/** One unresolved cause. Derived. */
export type UnresolvedAttachmentCause = (typeof UNRESOLVED_ATTACHMENT_CAUSES)[number];

/** What a cause means, and what a participant can do about it. */
export interface UnresolvedAttachmentPresentation {
  readonly meaning: string;
  /** ABSENT means there is no remedy — said outright rather than left blank. */
  readonly remedy: string | undefined;
}

/**
 * The six causes, total over `UnresolvedAttachmentCause`.
 *
 * Each carries its OWN remedy, because they are six different situations and a shared
 * "try again later" would be wrong for five of them. `deleted` carries none, and the
 * absence is the honest answer rather than a softer sentence that implies a way back.
 */
export const UNRESOLVED_ATTACHMENT_PRESENTATION: Readonly<
  Record<UnresolvedAttachmentCause, UnresolvedAttachmentPresentation>
> = {
  deleted: {
    meaning: "The manifest is gone.",
    remedy: undefined,
  },
  local_only_remote: {
    meaning: "Held on the publishing node only, and this is not that node.",
    remedy: "Change its visibility to shared on the publishing node.",
  },
  pending_replication: {
    meaning: "The publisher has it and the relay does not yet.",
    remedy: "Wait for the publisher's transfer to finish.",
  },
  over_cap: {
    meaning: "Too large to pin on the relay, so it is only reachable from the publisher.",
    remedy: "The publisher must be online.",
  },
  quota_exceeded: {
    meaning: "The publisher's relay quota was full when this was published.",
    remedy: "Free relay quota, then re-publish.",
  },
  expired: {
    meaning: "The payload is not obtainable from the relay.",
    remedy: "The publisher re-publishes it while online.",
  },
};

// --- The shapes a card renders -------------------------------------------

/**
 * What a participant SAID this attachment is, before the daemon read a byte of it.
 *
 * METADATA ONLY, AND THAT IS THE POINT. It carries no payload member at all, which is
 * what makes it the shape a finished entry can keep: a `Blob` here would put the bytes
 * back on every terminal entry by construction rather than by mistake, and the whole
 * release rule below rests on there being a declaration that cannot hold one.
 */
export interface AttachmentDeclaration {
  /** The console's own handle for this attachment before an artifact id exists. */
  readonly localId: string;
  /** The caller's filename. Metadata only — never a path component, never rebuilt. */
  readonly declaredName: string;
  /**
   * Decoded bytes. Every bound in this file counts these and never an encoded length.
   *
   * Always the payload's own size, because `attachmentSourceFrom` is what mints a
   * declaration and takes it from there — a separately-supplied length could disagree
   * with the bytes the stream actually sends, and every progress figure, every
   * bound, and the daemon's own spool reservation are all counted against it.
   */
  readonly byteLength: number;
  /** The caller's claim about the type. Advisory input, never a trusted fact. */
  readonly declaredMediaType?: string | undefined;
}

/** What a participant handed over: the declaration, and the bytes it describes. */
export interface AttachmentSource {
  readonly declared: AttachmentDeclaration;
  /**
   * The bytes themselves, by reference.
   *
   * A `Blob` — which a `File` off a picker or a drop already is — so the payload
   * stays wherever the browser is keeping it and the ingest client reads one
   * chunk-capped slice at a time. Nothing copies it, and nothing here reads it.
   */
  readonly payload: Blob;
}

/** What a picker, a drop, or a paste hands over. The length is not among it. */
export interface AttachmentSourceInput {
  readonly localId: string;
  readonly declaredName: string;
  readonly payload: Blob;
  readonly declaredMediaType?: string | undefined;
}

/**
 * Mint one source from the payload a participant chose.
 *
 * The only way to make an `AttachmentSource`, so the declared length and the bytes
 * cannot come from two places. `Spec-014 §Required Behavior` makes the declared size
 * advisory to the daemon, which derives its own at completion — but it is also the
 * stream's spool RESERVATION, so a console that declared one number and sent another
 * would have the daemon refuse a stream it had already admitted.
 */
export function attachmentSourceFrom(input: AttachmentSourceInput): AttachmentSource {
  return {
    declared: {
      localId: input.localId,
      declaredName: input.declaredName,
      byteLength: input.payload.size,
      declaredMediaType: input.declaredMediaType,
    },
    payload: input.payload,
  };
}

/** What the daemon found once it had the bytes. This replaces the declaration. */
export interface AttachmentDerivedTruth {
  readonly artifactId: string;
  readonly normalizedName: string;
  readonly derivedMediaType: string;
  readonly derivedSizeBytes: number;
}

/**
 * The states an entry can still put bytes on a stream from. A SUBSET, not a second set.
 *
 * Only this half is written down; the settled half is its COMPLEMENT, computed below,
 * so the two arms of the entry union cannot drift apart or come to overlap. And the
 * subset relation is checked rather than asserted: `isSendingAttachmentIngestState`
 * declares a predicate narrowing `AttachmentIngestState` to this type, which does not
 * compile unless every member here is one — so a typo, or a state that left the parent
 * vocabulary, fails the build rather than silently making the complement wrong.
 *
 * All three refusal dispositions offer a retry, so `refused` belongs here in full. A
 * disposition that offered none would move it to the settled arm, and this line is
 * where that decision would be made rather than somewhere a reader has to find.
 */
export const SENDING_ATTACHMENT_INGEST_STATES = ["declared", "ingesting", "refused"] as const;

/** One state an entry can still send from. Derived. */
export type SendingAttachmentIngestState = (typeof SENDING_ATTACHMENT_INGEST_STATES)[number];

/** One state an entry is finished in. The complement, so the two arms partition the set. */
export type SettledAttachmentIngestState = Exclude<
  AttachmentIngestState,
  SendingAttachmentIngestState
>;

/** Whether an entry in this state can still put bytes on a stream. */
export function isSendingAttachmentIngestState(
  state: AttachmentIngestState,
): state is SendingAttachmentIngestState {
  return (SENDING_ATTACHMENT_INGEST_STATES as readonly AttachmentIngestState[]).includes(state);
}

/** What one entry records about its own ingest, apart from what it was declared over. */
export interface AttachmentIngestRecord {
  readonly state: AttachmentIngestState;
  /** The spooled running total of DECODED bytes the daemon has acknowledged. */
  readonly receivedBytes: number;
  readonly ingestId: string | undefined;
  readonly derived: AttachmentDerivedTruth | undefined;
  readonly refusal: { readonly code: string; readonly detail: string } | undefined;
  readonly disposition: IngestRefusalDisposition | undefined;
  /** When the stream opened, for the six-hour ceiling. Absent before it opened. */
  readonly openedAtMilliseconds: number | undefined;
  /** When a chunk was last acknowledged, for the stall disclosure. */
  readonly lastProgressAtMilliseconds: number | undefined;
}

/** An entry that can still send, so it holds the participant's bytes. */
export interface SendingAttachmentIngestEntry extends AttachmentIngestRecord {
  readonly state: SendingAttachmentIngestState;
  readonly declared: AttachmentDeclaration;
  readonly payload: Blob;
}

/** An entry that has stopped. Metadata only, and no payload member to hold one in. */
export interface SettledAttachmentIngestEntry extends AttachmentIngestRecord {
  readonly state: SettledAttachmentIngestState;
  readonly declared: AttachmentDeclaration;
  readonly payload?: never;
}

/**
 * One attachment's ingest, as the client publishes it and a card renders it.
 *
 * A UNION OVER ITS OWN STATE, and the exact rule is: an entry holds the participant's
 * `Blob` while — and only while — a send is still possible from where it stands. A
 * `complete` entry has minted its artifact and an `abandoned` one has stopped for good,
 * so neither can send and neither has anywhere to put a payload. Both arms carry the
 * same `declared` metadata, so every reader of a name, a size, or a media type is
 * unchanged and only the byte handle is at issue.
 */
export type AttachmentIngestEntry = SendingAttachmentIngestEntry | SettledAttachmentIngestEntry;

/** Whether this entry still holds the bytes, narrowing so a caller can read them. */
export function isSendingAttachmentIngestEntry(
  entry: AttachmentIngestEntry,
): entry is SendingAttachmentIngestEntry {
  return isSendingAttachmentIngestState(entry.state);
}

/**
 * Build the entry one record calls for, carrying the bytes exactly as far as they can
 * still be sent.
 *
 * THE ONE CONSTRUCTOR, so the release is a property of the type rather than of anyone
 * remembering. The eight record members are copied BY NAME rather than spread: every
 * caller composes its record by spreading a whole standing entry, and a spread here
 * would carry that entry's `payload` straight through into a `complete` one — which is
 * the leak this exists to close, dressed as a one-line convenience.
 *
 * `undefined` for the one move that cannot be honoured: a record putting a settled
 * entry back into a sending state, whose bytes are already gone. The ledger writes
 * nothing rather than minting an entry that claims a payload it does not have.
 */
export function attachmentIngestEntryFrom(
  standing: AttachmentIngestEntry,
  record: AttachmentIngestRecord,
): AttachmentIngestEntry | undefined {
  const carried = {
    receivedBytes: record.receivedBytes,
    ingestId: record.ingestId,
    derived: record.derived,
    refusal: record.refusal,
    disposition: record.disposition,
    openedAtMilliseconds: record.openedAtMilliseconds,
    lastProgressAtMilliseconds: record.lastProgressAtMilliseconds,
    declared: standing.declared,
  };
  if (!isSendingAttachmentIngestState(record.state)) {
    return { ...carried, state: record.state };
  }
  const payload = standing.payload;
  if (payload === undefined) {
    return undefined;
  }
  return { ...carried, state: record.state, payload };
}

/**
 * What one attachment position on a turn has to say. Four arms, none standing in for
 * another.
 *
 * `not-checked` is separate from `unresolved` for rule 8's reason: an unresolved marker
 * is a manifest row that was READ and carries a cause, while `not-checked` is the
 * console admitting no read has happened — which is every attachment on a turn today,
 * because no wire resolves one.
 */
export type AttachmentReading =
  | { readonly kind: "ingesting"; readonly entry: AttachmentIngestEntry }
  | {
      readonly kind: "resolved";
      readonly attachmentId: string;
      readonly derived: AttachmentDerivedTruth;
    }
  | {
      readonly kind: "unresolved";
      readonly attachmentId: string;
      readonly cause: UnresolvedAttachmentCause;
    }
  | { readonly kind: "not-checked"; readonly attachmentId: string };

// --- What the card says about the media type ------------------------------

/**
 * Whose reading of the media type this is.
 *
 * The card labels the declared one AS declared, because the two are not the same
 * class of claim: `Spec-014 §Required Behavior` makes the declaration advisory input
 * that narrows an expected signature and never widens acceptance, while the derived
 * type is what the daemon found in the bytes. A chip that showed one and meant the
 * other would let a caller's claim pass for a finding.
 */
export type AttachmentMediaTypeProvenance = "derived" | "declared";

/** One media-type reading, and whose it is. */
export interface AttachmentMediaTypeReading {
  readonly mediaType: string;
  readonly provenance: AttachmentMediaTypeProvenance;
}

/**
 * Which media-type readings an in-flight attachment has, in the order they are shown.
 *
 * NEITHER SIDE GATES THE OTHER, which is the whole point of this function. The card
 * used to test the DECLARATION alone, so a payload a browser handed over with no
 * `File.type` — every paste, and any client that omits it — hid the derived type the
 * daemon had already found, on exactly the PNG and PDF attachments where the derived
 * signature is the interesting fact. Either value alone is a reading and is shown.
 *
 * WHERE BOTH EXIST AND AGREE, ONE CHIP. The declaration was confirmed rather than
 * contradicted, and printing the same string twice would read as a disagreement.
 *
 * WHERE BOTH EXIST AND DIFFER, THE DERIVED ONE LEADS AND THE DECLARATION SURVIVES
 * BESIDE IT. The derived type is the authority — `AttachmentCard.tsx`'s own rule that
 * derived truth REPLACES the declaration — but a disagreement is a fact a participant
 * acts on, and dropping the declaration would hide that their client claimed something
 * else.
 */
export function attachmentMediaTypeReadings(
  entry: AttachmentIngestEntry,
): readonly AttachmentMediaTypeReading[] {
  const declared = entry.declared.declaredMediaType;
  const derived = entry.derived?.derivedMediaType;
  if (derived === undefined) {
    return declared === undefined ? [] : [{ mediaType: declared, provenance: "declared" }];
  }
  const derivedReading: AttachmentMediaTypeReading = {
    mediaType: derived,
    provenance: "derived",
  };
  if (declared === undefined || declared === derived) {
    return [derivedReading];
  }
  return [derivedReading, { mediaType: declared, provenance: "declared" }];
}

/** What the card calls the caller's own claim, where it is shown beside a finding. */
export const ATTACHMENT_DECLARED_MEDIA_TYPE_LABEL = "declared";

// --- The one arithmetic step ---------------------------------------------

/** Where the progress tripwire reports from, so a firing names a module and not a call. */
export const ATTACHMENT_PROGRESS_SITE = "repos/attachment-model.ts";

/**
 * Advance one entry's decoded-byte total by one acknowledged chunk.
 *
 * THE WHOLE POINT OF THIS FUNCTION IS THAT IT IS THE ONLY ONE. This module's rule —
 * never chart base64 length as progress — is unenforceable as a rule about intent, but it is
 * perfectly checkable as arithmetic: an encoded length is about four thirds of the
 * decoded one, so charting it drives the running total past a total the caller itself
 * declared. That is impossible for a decoded count and is the observable signature of
 * having charted the wrong number — so it fires the `wire-figure-formatting` tripwire,
 * which is exactly "a figure reached a surface through something other than the byte
 * chokepoint", and the figure is clamped so the bar cannot render past full while the
 * defect is reported.
 *
 * Pure, exported, and taking the two numbers rather than the client's private state, so
 * the tripwire is provable by driving THIS function rather than by reaching into a
 * class or standing in for one.
 */
export function advanceReceivedBytes(
  entry: AttachmentIngestEntry,
  chunkByteLength: number,
): number {
  const advanced = entry.receivedBytes + chunkByteLength;
  if (advanced > entry.declared.byteLength) {
    reportTripwire(
      "wire-figure-formatting",
      ATTACHMENT_PROGRESS_SITE,
      `ingest progress for ${entry.declared.localId} advanced to ${String(advanced)} decoded bytes past a declared total of ${String(entry.declared.byteLength)}; a progress figure counts decoded bytes and never an encoded length`,
    );
    return entry.declared.byteLength;
  }
  return advanced;
}

/** Milliseconds left on this stream's six-hour ceiling, or `undefined` before it opened. */
export function ingestCeilingRemainingMs(
  entry: AttachmentIngestEntry,
  nowMilliseconds: number,
): number | undefined {
  if (entry.openedAtMilliseconds === undefined) {
    return undefined;
  }
  const elapsed = nowMilliseconds - entry.openedAtMilliseconds;
  return Math.max(0, INGEST_STREAM_LIFETIME_CEILING_MS - elapsed);
}

/**
 * The instant this upload's silence becomes worth disclosing, or `undefined` where
 * there is nothing outstanding to go quiet.
 *
 * The DEADLINE rather than only the predicate, because two callers need it and they
 * need the same one: the card asks whether the instant it was handed is past it, and
 * the carrier asks when to hand the card a fresher instant. Two subtractions against
 * one threshold would be two places for the threshold to be spent, and a carrier that
 * woke a second early would render a card that was still not stalled.
 */
export function ingestStallDisclosureAtMs(entry: AttachmentIngestEntry): number | undefined {
  if (entry.state !== "ingesting" || entry.lastProgressAtMilliseconds === undefined) {
    return undefined;
  }
  return entry.lastProgressAtMilliseconds + INGEST_STALL_DISCLOSURE_MS;
}

/** Whether this upload has been silent long enough to disclose the ceiling. */
export function isIngestStalled(entry: AttachmentIngestEntry, nowMilliseconds: number): boolean {
  const disclosureAtMilliseconds = ingestStallDisclosureAtMs(entry);
  return disclosureAtMilliseconds !== undefined && nowMilliseconds >= disclosureAtMilliseconds;
}
