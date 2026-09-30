// The progress half of a provider import, as a reading.
//
// `session.import` is a write that settles once with an import id; `session.importSubscribe`
// is a stream, which can be open and silent, open and speaking, or closed. The two are held
// apart. What the stream carries, and why it is keyed by provider, is in the contract's
// `provider-import.ts`. Nothing is computed from the messages: the counts and the outcome
// are the service's own words.

import type {
  ProviderImportId,
  ProviderImportProgress,
  ProviderImportProviderRequest,
} from "@ai-sidekicks/contracts";

/** An open progress subscription: the messages, and the way to let go of it. */
export interface ImportProgressStream {
  readonly events: AsyncIterable<ProviderImportProgress>;
  readonly close: () => void;
}

/** The call that subscribes to one provider's import stream. */
export type ImportProgressSubscribeCall = (
  request: ProviderImportProviderRequest,
) => Promise<ImportProgressStream>;

/** Where one provider's import stream has got to. */
export type ImportProgressReading =
  | { readonly status: "unsubscribed" }
  | { readonly status: "open"; readonly newest: ProviderImportProgress | undefined }
  | { readonly status: "closed"; readonly newest: ProviderImportProgress | undefined };

/**
 * Whether an import is still being read.
 *
 * `startedImportId` is the id this screen's own start was answered with, if any. A stream's
 * first message may be the last import's outcome, so a settled message for any other import
 * is history; this screen's import is still going until its own settled message arrives. A
 * progress message always means a running import.
 *
 * Before the stream has spoken, including the frame between the start settling and the
 * stream opening, an import is underway exactly when this screen started one. A closed
 * stream reads nothing further, so it ends the reading.
 */
export function isImportUnderway(
  startedImportId: ProviderImportId | undefined,
  progress: ImportProgressReading,
): boolean {
  if (progress.status === "closed") {
    return false;
  }
  if (progress.status === "unsubscribed" || progress.newest === undefined) {
    return startedImportId !== undefined;
  }
  const { newest } = progress;
  if (newest.kind === "progress") {
    return true;
  }
  return startedImportId !== undefined && newest.importId !== startedImportId;
}
