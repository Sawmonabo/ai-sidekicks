// What an attachment IS to this console: the states, the declaration, the bytes, and
// the entry the two become.
//
// THE SEAM, IN ONE SENTENCE: this module changes when the console's own model of an
// ingest changes — a state added, a member the ledger has to carry, a rule about which
// entries may still send. It holds no copy, formats no figure, and performs no
// arithmetic, so a card's wording and a card's numbers both change without touching it.
// It rests on `attachment-policy.ts` for the daemon's vocabulary and on nothing else in
// this family.
//
// WIRE TRUTH FIRST. `packages/contracts` registers NO attachment type. The nearest
// thing on the wire is `SteerPayload.attachments`, typed `z.array(z.unknown())` with a
// count cap of 64 — an UNTYPED arm, and `Spec-014 §Interfaces And Contracts` forbids
// delivering an attachment over one. There is no `AttachmentIngestInit` shape, no
// method string for any leg of the ingest trio, and no manifest type. So the shapes
// below are CONSOLE VIEW MODELS transcribing what `Spec-014` names, and every call that
// would fill them goes through `bridge/growth-port/growth-port.ts`, which refuses by name
// (`artifact-ingest-and-crud`, `artifact-allowlist-and-abort`). Nothing here claims the
// daemon sends it.
//
// THE DECLARED VALUES ARE ADVISORY AND THE DERIVED ONES ARE THE TRUTH. `Spec-014
// §Required Behavior` makes a caller's `mediaType` and `sizeBytes` hints that narrow a
// signature check and never widen acceptance, so `AttachmentDeclaration` holds them as
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
//   • No filename rebuilt from the raw input. `normalizedName` is what renders and what
//     is used; the caller's original string survives as manifest metadata the console
//     never turns back into a path component.

import type { IngestRefusalDisposition, UnresolvedAttachmentCause } from "./attachment-policy.js";

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
