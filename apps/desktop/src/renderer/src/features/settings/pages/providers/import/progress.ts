// The progress half of a provider import, as a reading.
//
// `session.import` is a write that settles once with an import id; `session.importSubscribe`
// is a stream, which can be open and silent, open and speaking, or closed. The two are held
// apart. What the stream carries, and why it is keyed by provider, is in the contract's
// `provider/import.ts`. Nothing is computed from the messages: the counts and the outcome
// are the service's own words.

import type {
  ProviderImportId,
  ProviderImportProgress,
  ProviderImportProviderRequest,
  ProviderImportStopRequest,
} from "@ai-sidekicks/contracts/provider/import";
import type { Refusal } from "#renderer/lib/refusal/contract.js";

/** An open progress subscription: the messages, and the way to let go of it. */
export interface ImportProgressStream {
  readonly events: AsyncIterable<ProviderImportProgress>;
  readonly close: () => void;
}

/** The call that subscribes to one provider's import stream. */
export type ImportProgressSubscribeCall = (
  request: ProviderImportProviderRequest,
) => Promise<ImportProgressStream>;

/** The call that stops one running import; its stopped outcome arrives on the stream. */
export type ImportStopCall = (request: ProviderImportStopRequest) => Promise<void>;

/**
 * Where one provider's import stream has got to. `replayed` is the first message this opening of
 * the stream delivered: the provider's last outcome, or the import already running, which was true
 * before the screen looked. `failed` is a subscription or a stream that rejected, carrying the
 * service's own words.
 */
export type ImportProgressReading =
  | {
      readonly status: "open";
      readonly newest: ProviderImportProgress | undefined;
      readonly replayed: ProviderImportProgress | undefined;
    }
  | {
      readonly status: "closed";
      readonly newest: ProviderImportProgress | undefined;
      readonly replayed: ProviderImportProgress | undefined;
    }
  | { readonly status: "failed"; readonly refusal: Refusal };

/**
 * The import still being read, or `undefined` where none is.
 *
 * `startedImportId` is the id this screen's own start was answered with, if any. A stream's
 * first message may be the last import's outcome, so a settled message for any other import
 * is history; this screen's import is still going until its own settled message arrives. A
 * progress message always names a running import, whoever started it.
 *
 * Before the stream has spoken, including the frame between the start settling and the
 * stream opening, the running import is the one this screen started. A closed or failed
 * stream reads nothing further, so it ends the reading.
 */
export function runningImportIdOf(
  startedImportId: ProviderImportId | undefined,
  progress: ImportProgressReading,
): ProviderImportId | undefined {
  if (progress.status !== "open") {
    return undefined;
  }
  const { newest } = progress;
  if (newest === undefined) {
    return startedImportId;
  }
  if (newest.kind === "progress") {
    return newest.importId;
  }
  return newest.importId === startedImportId ? undefined : startedImportId;
}
