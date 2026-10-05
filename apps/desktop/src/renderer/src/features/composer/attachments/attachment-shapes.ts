// The console's model of an ingest: the states, the declaration, the bytes, and the entry they
// become. It holds no copy and does no arithmetic. Declared values are advisory hints and the
// derived summary (the contract's `SessionAttachmentSummary`) replaces them, so they are two
// shapes. The entry is a union over its state: only arms that can still send carry the user's
// `Blob`, because a kept handle pins a finished upload's file until the composer unmounts. No
// shape carries payload bytes, and the caller's filename is never rebuilt into a path.

import type { SessionAttachmentSummary } from "@ai-sidekicks/contracts/session/draft";

import type { IngestRefusalDisposition } from "./attachment-policy.js";

/**
 * Where one attachment's ingest stands. `abandoned` is not a flavor of `refused`: the user
 * stopped sending, and rendering the two alike would tell them their cancellation was an error.
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
 * What a user said this attachment is, before the daemon read a byte of it. It carries no
 * payload member, which is what lets a finished entry keep it.
 */
export interface AttachmentDeclaration {
  /** The console's own handle for this attachment before an artifact id exists. */
  readonly localId: string;
  /** The caller's filename. Metadata only, never a path component. */
  readonly declaredName: string;
  /**
   * Decoded bytes; every bound counts these, never an encoded length. Always the payload's own
   * size, since `attachmentSourceFrom` mints it: a separate length could disagree with the
   * bytes sent and with the daemon's spool reservation.
   */
  readonly byteLength: number;
  /** The caller's claim about the type. Advisory input, never a trusted fact. */
  readonly declaredMediaType?: string | undefined;
}

/** What a user handed over: the declaration, and the bytes it describes. */
export interface AttachmentSource {
  readonly declared: AttachmentDeclaration;
  /** The bytes by reference: a `Blob` (a picker `File` already is one), read a slice at a time. */
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
 * Mints one source from the payload a user chose. The only way to make an `AttachmentSource`, so
 * the declared length and the bytes cannot come from two places: the declared size is also the
 * stream's spool reservation, and a mismatch would have the daemon refuse an admitted stream.
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

/**
 * The states an entry can still put bytes on a stream from. Only this half is written down;
 * the settled half is its complement, so the arms cannot drift or overlap. The predicate
 * `isSendingAttachmentIngestState` fails to compile if a member leaves the parent vocabulary.
 * Every refusal disposition offers a retry, so `refused` belongs here.
 */
export const SENDING_ATTACHMENT_INGEST_STATES = ["declared", "ingesting", "refused"] as const;

/** One state an entry can still send from. */
export type SendingAttachmentIngestState = (typeof SENDING_ATTACHMENT_INGEST_STATES)[number];

/** One state an entry is finished in. The complement, so the two arms partition the set. */
export type SettledAttachmentIngestState = Exclude<
  AttachmentIngestState,
  SendingAttachmentIngestState
>;

/** What one entry records about its own ingest, apart from what it was declared over. */
export interface AttachmentIngestRecord {
  readonly state: AttachmentIngestState;
  /** The spooled running total of DECODED bytes the daemon has acknowledged. */
  readonly receivedBytes: number;
  readonly ingestId: string | undefined;
  readonly derived: SessionAttachmentSummary | undefined;
  readonly refusal: { readonly code: string; readonly detail: string } | undefined;
  readonly disposition: IngestRefusalDisposition | undefined;
  /** When a chunk was last acknowledged, for the stall disclosure. */
  readonly lastProgressAtMilliseconds: number | undefined;
}

/** An entry that can still send, so it holds the user's bytes. */
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
 * One attachment's ingest, as the client publishes it and a card renders it. An entry holds the
 * user's `Blob` only while a send is still possible; both arms carry the same `declared`
 * metadata, so only the byte handle differs.
 */
export type AttachmentIngestEntry = SendingAttachmentIngestEntry | SettledAttachmentIngestEntry;

/** What one attachment position on a turn has to say. Three arms, none standing in for another. */
export type AttachmentReading =
  | { readonly kind: "ingesting"; readonly entry: AttachmentIngestEntry }
  | {
      readonly kind: "resolved";
      readonly attachmentId: string;
      readonly derived: SessionAttachmentSummary;
    }
  | { readonly kind: "unresolved"; readonly attachmentId: string };

/** Whether an entry in this state can still put bytes on a stream. */
export function isSendingAttachmentIngestState(
  state: AttachmentIngestState,
): state is SendingAttachmentIngestState {
  return (SENDING_ATTACHMENT_INGEST_STATES as readonly AttachmentIngestState[]).includes(state);
}

/** Whether this entry still holds the bytes, narrowing so a caller can read them. */
export function isSendingAttachmentIngestEntry(
  entry: AttachmentIngestEntry,
): entry is SendingAttachmentIngestEntry {
  return isSendingAttachmentIngestState(entry.state);
}

/**
 * Builds the entry one record calls for, carrying the bytes only as far as they can still be
 * sent. The record members are copied by name, not spread, because callers spread a whole
 * standing entry and a spread would carry its `payload` into a `complete` one. Returns
 * `undefined` for a record moving a settled entry back into a sending state, whose bytes are
 * gone.
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
