// Ledger entries for the two folds that read them.
//
// Hoisted on the second use: the chip fold and the send-reference fold both need an
// entry in a named state, and a factory written twice would let the two suites drift
// into testing two different shapes of the same thing.
//
// TWO FACTORIES AND NOT ONE WITH A CAST. The entry union splits on whether a send is
// still possible from where the entry stands — the sending arm holds the user's
// bytes and the settled arm has nowhere to put them — so a single factory could only
// satisfy both by asserting past that split, which would let a case build an entry the
// carrier can never publish. The split is taken STRUCTURALLY off the union rather than
// by naming the states again, so a state that changes arms changes these with it.

import type { AttachmentIngestEntry } from "../../../../console/repos/index.js";

/** The arm that still holds bytes, read off the union rather than listed again. */
type SendingEntry = Extract<AttachmentIngestEntry, { readonly payload: Blob }>;

/** Its complement, so the two cannot drift apart or come to overlap. */
type SettledEntry = Exclude<AttachmentIngestEntry, SendingEntry>;

/** What a case varies. Everything omitted takes the quiet default below. */
export interface IngestEntryOptions {
  readonly localId?: string;
  readonly declaredName?: string;
  readonly byteLength?: number;
  readonly declaredMediaType?: string;
  readonly receivedBytes?: number;
  readonly derived?: AttachmentIngestEntry["derived"];
  readonly refusal?: AttachmentIngestEntry["refusal"];
  readonly disposition?: AttachmentIngestEntry["disposition"];
  readonly openedAtMilliseconds?: number;
  readonly lastProgressAtMilliseconds?: number;
}

/** One entry mid-ingest or refused, holding the bytes a retry would resend. */
export function sendingEntry(
  state: SendingEntry["state"],
  options: IngestEntryOptions = {},
): SendingEntry {
  return { ...commonRecord(state, options), state, payload: new Blob(["x"]) };
}

/** One entry that has stopped — settled into an artifact, or abandoned. */
export function settledEntry(
  state: SettledEntry["state"],
  options: IngestEntryOptions = {},
): SettledEntry {
  return { ...commonRecord(state, options), state };
}

/** A settled artifact, as the daemon reported it at completion. */
export function derivedTruth(
  overrides: Partial<NonNullable<AttachmentIngestEntry["derived"]>> = {},
): NonNullable<AttachmentIngestEntry["derived"]> {
  return {
    artifactId: overrides.artifactId ?? "artifact-1",
    normalizedName: overrides.normalizedName ?? "notes.md",
    derivedMediaType: overrides.derivedMediaType ?? "text/markdown",
    derivedSizeBytes: overrides.derivedSizeBytes ?? 1024,
  };
}

/** Everything both arms carry, so the two factories differ only where the union does. */
function commonRecord(
  state: AttachmentIngestEntry["state"],
  options: IngestEntryOptions,
): Omit<SettledEntry, "state"> {
  return {
    declared: {
      localId: options.localId ?? "local-1",
      declaredName: options.declaredName ?? "notes.md",
      byteLength: options.byteLength ?? 1024,
      declaredMediaType: options.declaredMediaType,
    },
    receivedBytes: options.receivedBytes ?? 0,
    // A stream handle exists from the moment one is opened, which is every state but
    // the one before the daemon has been asked for anything.
    ingestId: state === "declared" ? undefined : "ingest-1",
    derived: options.derived,
    refusal: options.refusal,
    disposition: options.disposition,
    openedAtMilliseconds: options.openedAtMilliseconds,
    lastProgressAtMilliseconds: options.lastProgressAtMilliseconds,
  };
}
