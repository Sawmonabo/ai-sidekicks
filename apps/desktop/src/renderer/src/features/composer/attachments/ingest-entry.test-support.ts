// Staged entries for the chip fold and the send-reference fold. Two factories, split on the
// union's send-capable arm, so a case cannot build an entry the staged list never publishes.

import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";
import type { SessionAttachmentSummary } from "@ai-sidekicks/contracts/session/draft";

import type { AttachmentIngestEntry } from "./shapes.js";

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
export function derivedValues(
  overrides: Partial<Omit<SessionAttachmentSummary, "artifactId">> & {
    readonly artifactId?: string;
  } = {},
): SessionAttachmentSummary {
  return {
    artifactId: (overrides.artifactId ?? "artifact-1") as ArtifactId,
    fileName: overrides.fileName ?? "notes.md",
    mimeType: overrides.mimeType ?? "text/markdown",
    sizeBytes: overrides.sizeBytes ?? 1024,
  };
}

/** The arm that still holds bytes, read off the union rather than listed again. */
type SendingEntry = Extract<AttachmentIngestEntry, { readonly payload: Blob }>;

/** Its complement, so the two cannot drift apart or come to overlap. */
type SettledEntry = Exclude<AttachmentIngestEntry, SendingEntry>;

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
    // A stream handle exists in every state except before the daemon has been asked anything.
    ingestId: state === "declared" ? undefined : "ingest-1",
    derived: options.derived,
    refusal: options.refusal,
    disposition: options.disposition,
    lastProgressAtMilliseconds: options.lastProgressAtMilliseconds,
  };
}
