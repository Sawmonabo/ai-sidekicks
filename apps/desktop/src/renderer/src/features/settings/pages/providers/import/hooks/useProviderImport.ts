// One provider's import, held for as long as its section is on screen rather than its panel.
//
// The caller holds this model above whatever discloses the panel and renders the panel with
// it, so closing the panel does not end the import: the daemon keeps reading, and only a
// holder that outlives the panel can keep reporting it and keep a second import from starting
// beside it.
//
// The start and the stop are addressed on the calls through the subject-scoped holder, so new
// calls retire everything the old ones answered. How many imports run, what a second start
// answers, and what the stream sends first are the service's rules, in the contract's
// `provider/import.ts`. The three calls are arguments; a rejected call settles as a refusal the
// panel draws.
//
// The start settles once and the stream is a stream, so the two phases are kept apart, and
// which import is running is composed once here so no two controls can disagree.

import {
  ProviderImportCall,
  useProviderImportCall,
  type ProviderImportCallSettlement,
} from "./useProviderImportCall.js";
import {
  runningImportIdOf,
  type ImportProgressReading,
  type ImportProgressSubscribeCall,
  type ImportStopCall,
} from "../progress.js";
import { useImportProgress } from "./useImportProgress.js";
import type {
  ProviderImportProviderRequest,
  ProviderImportStartResponse,
  ProviderImportStopRequest,
} from "@ai-sidekicks/contracts/provider/import";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { Refusal } from "#renderer/lib/refusal/contract.js";
import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";

/** The call that starts one provider's import. */
export type ProviderImportBeginCall = (
  request: ProviderImportProviderRequest,
) => Promise<ProviderImportStartResponse>;

/** The three calls one provider's import is driven through; held stable by the caller. */
export interface ProviderImportCalls {
  readonly begin: ProviderImportBeginCall;
  readonly subscribe: ImportProgressSubscribeCall;
  readonly stop: ImportStopCall;
}

/** Everything a view needs to render one provider's import, and the acts that drive it. */
export interface ProviderImportModel {
  readonly provider: ProviderName;
  /** Where the provider's import stream got to, in the service's own words. */
  readonly progress: ImportProgressReading;
  /** The refusal the last start was answered with, or `undefined` where none was. */
  readonly startRefusal: Refusal | undefined;
  /** The refusal the last stop was answered with, or `undefined` where none was. */
  readonly stopRefusal: Refusal | undefined;
  /** The daemon's import is still being read, so it can be stopped. */
  readonly isReading: boolean;
  /** A start is out, or the daemon's import is still being read. */
  readonly isUnderway: boolean;
  /** A stop is out. */
  readonly isStopping: boolean;
  /** Start an import. A rejected start settles as {@link startRefusal}. */
  readonly start: () => void;
  /** Stop the running import; its stopped outcome arrives on the stream. */
  readonly stop: () => void;
  /** Open the import stream again after it failed. */
  readonly reopen: () => void;
}

/** The code a rejected start that carried none of its own is reported under. */
const START_FAILED_CODE = "import-start-failed";

/** The code a rejected stop that carried none of its own is reported under. */
const STOP_FAILED_CODE = "import-stop-failed";

/**
 * Hold one provider's import for as long as this component is mounted.
 *
 * Call it above the disclosure, never inside the panel: that placement is what keeps the
 * import alive when the panel unmounts, and only the caller knows which children are
 * conditional.
 */
export function useProviderImport(
  provider: ProviderName,
  calls: ProviderImportCalls,
): ProviderImportModel {
  // Keyed on the calls and the provider, the whole subject: an act in a mount-lifetime cell
  // would stay bound to calls the window has since replaced.
  const startCall = useSubjectScopedState(
    calls,
    provider,
    () => new ProviderImportCall(calls.begin, START_FAILED_CODE),
  ).value;
  const stopCall = useSubjectScopedState(
    calls,
    provider,
    () => new ProviderImportCall<ProviderImportStopRequest, void>(calls.stop, STOP_FAILED_CODE),
  ).value;
  const started = useProviderImportCall(startCall);
  const stopped = useProviderImportCall(stopCall);
  const { reading: progress, reopen } = useImportProgress(calls.subscribe, provider);
  const runningImportId = runningImportIdOf(
    started.status === "settled" ? started.answer.importId : undefined,
    progress,
  );
  return {
    provider,
    progress,
    startRefusal: refusalOf(started),
    stopRefusal: refusalOf(stopped),
    isReading: runningImportId !== undefined,
    isUnderway: started.status === "running" || runningImportId !== undefined,
    isStopping: stopped.status === "running",
    start: () => {
      void startCall.run({ provider });
    },
    stop: () => {
      if (runningImportId !== undefined) {
        void stopCall.run({ importId: runningImportId });
      }
    },
    reopen,
  };
}

function refusalOf<TAnswer>(
  settlement: ProviderImportCallSettlement<TAnswer>,
): Refusal | undefined {
  return settlement.status === "refused" ? settlement.refusal : undefined;
}
