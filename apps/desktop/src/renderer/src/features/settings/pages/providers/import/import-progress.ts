// The progress half of a provider import, as a reading.
//
// The import is two calls and they answer different kinds of thing. `session.import`
// is a write that settles once with an import id. `session.importSubscribe` is a
// stream over one provider's imports, and a stream has a state no settlement
// expresses: open and has said something, open and has said nothing yet, or closed.
// So the two are held apart. What the stream carries, and why it is keyed by provider,
// is the contract's `provider-import.ts`.
//
// Nothing is computed from the messages: the counts and the outcome are the service's
// own words, rendered verbatim.

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
 * `startedImportId` is the id this screen's own start was answered with, if it made
 * one. It matters because a stream's first message may be the LAST import's outcome:
 * a settled message for any other import is history, and the one this screen started
 * is still going until its own settled message arrives. A progress message is always
 * a running import, whoever started it.
 *
 * Before the stream has said anything — including the frame between the start
 * settling and the effect that opens the stream — an import is underway exactly when
 * this screen started one. A closed stream reads nothing further, so it ends the
 * reading.
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
