// One provider import, held for as long as the import runs rather than as long as its panel
// is on screen.
//
// The caller holds this model above whatever discloses the panel and renders the panel with
// it. A panel that held the start act and the progress drain itself lost the import on
// unmount: the cleanup closed the subscription while the daemon kept reading, and the panel
// then offered a second import with nothing reporting the first.
//
// The act is addressed on the start call through the subject-scoped holder, so a new call
// retires the import with everything else the old one answered. How many imports run, what
// a second start answers, and what the stream sends first are the service's rules, in the
// contract's `provider-import.ts`. Both calls are arguments; a rejected call propagates.
//
// The start settles once and the stream is a stream, so the two phases are kept apart, and
// whether an import is underway is composed once here so no two controls can disagree.

import { SingleFlightAct, useSingleFlightAct } from "./useSingleFlightAct.js";
import {
  isImportUnderway,
  type ImportProgressReading,
  type ImportProgressSubscribeCall,
} from "./import-progress.js";
import { useImportProgress } from "./useImportProgress.js";
import type {
  ProviderImportProviderRequest,
  ProviderImportStartResponse,
} from "@ai-sidekicks/contracts";
import type { Refusal } from "@renderer/lib/refusal.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";

/** The call that starts one provider's import. */
export type ProviderImportBeginCall = (
  request: ProviderImportProviderRequest,
) => Promise<ProviderImportStartResponse>;

/** Everything a view needs to render one import, and the one act that starts one. */
export interface ProviderImportModel {
  /** Where the provider's import stream got to, in the service's own words. */
  readonly progress: ImportProgressReading;
  /** The opening call is still out. */
  readonly isBeginning: boolean;
  /** The daemon's import is still being read. */
  readonly isReading: boolean;
  /**
   * Either phase; closes every control that would disturb a running import.
   *
   * Composed here so the submit control and any switch leaving the panel agree in the frame
   * between a settled begin and the effect that opens its stream.
   */
  readonly isUnderway: boolean;
  /**
   * Put one import. Resolves to the act's own refusal while the last start is still
   * unanswered, and to `undefined` where the import was put. A rejected start
   * propagates.
   */
  readonly put: (request: ProviderImportProviderRequest) => Promise<Refusal | undefined>;
}

/**
 * Hold one provider import for as long as this component is mounted.
 *
 * Call it above the disclosure, never inside the panel: that placement is what keeps the
 * import alive when the panel unmounts, and only the caller knows which children are
 * conditional.
 */
export function useProviderImport(
  begin: ProviderImportBeginCall,
  subscribe: ImportProgressSubscribeCall,
): ProviderImportModel {
  // Keyed on the begin call, the whole subject: an act in a mount-lifetime cell would stay
  // bound to a call the window has since replaced.
  const act = useSubjectScopedState(
    begin,
    undefined,
    () =>
      new SingleFlightAct<ProviderImportProviderRequest, StartedImport>({
        // The provider rides the answer, so the stream is opened on the provider this
        // start named and lives exactly as long as the act does.
        attempt: async (request) => ({ provider: request.provider, ...(await begin(request)) }),
        describeWhat: "The import",
      }),
  ).value;
  const settlement = useSingleFlightAct(act);
  const started = settlement.status === "settled" ? settlement.answer : undefined;
  const progress = useImportProgress(subscribe, started?.provider);
  const isBeginning = settlement.status === "running";
  const isReading = isImportUnderway(started?.importId, progress);
  return {
    progress,
    isBeginning,
    isReading,
    isUnderway: isBeginning || isReading,
    put: async (request) => await act.run(request),
  };
}

/** A start the service answered: the provider it named, and the import now running for it. */
type StartedImport = ProviderImportProviderRequest & ProviderImportStartResponse;
