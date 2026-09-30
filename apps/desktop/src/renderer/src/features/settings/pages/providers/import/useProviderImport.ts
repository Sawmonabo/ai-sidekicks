// One provider import, held for as long as the import runs rather than for as long as
// its panel is on screen.
//
// THE DEFECT THIS EXISTS FOR. A panel that held both halves of an import itself — the
// start act in its own cell and the progress drain in its own effect — lost the import
// whenever it was unmounted: the cleanup closed the progress subscription while the
// daemon went on reading, and coming back built a fresh act that had started nothing.
// Whether an import is underway is read off that act and its stream, so the panel then
// offered another import while the first was still running, with nothing anywhere
// reporting it. Every part of that is silent.
//
// SO THE STATE LIVES ABOVE THE CONDITION. The caller holds this model and renders the
// panel with it; the panel is a view over an import rather than the place an import
// lives. A panel that unmounts and comes back finds the same act, the same provider's
// stream, and a subscription that was never closed — the reading continues while the
// panel is not looking at it.
//
// THAT IS A LIFETIME AND NOT A CACHE. The act is addressed on the start call through
// the console's one subject-scoped holder, so a new call retires the import along with
// everything else the old one answered. How many imports run, what a second start
// answers, and what the stream sends first are the service's rules, in the contract's
// `provider-import.ts`; this module holds none of them.
//
// The two calls are the caller's, taken as arguments, so this module keeps only its
// own logic. A rejected call is not caught here: it propagates.
//
// TWO PHASES, KEPT APART, AND ONE PREDICATE OVER BOTH. The start settles once and the
// stream is a stream; they fail differently and read differently. What a CONTROL needs
// is the union of them — whether an import is underway at all — and that is composed
// once here rather than at each control, because two controls deriving it separately
// would eventually disagree about which message an import ends on.

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
   * Either phase — what closes every control that would disturb a running import.
   *
   * Composed here rather than at each reader, because the panel's submit control and
   * any switch that would leave the panel are asking one question and a second
   * derivation of it would answer differently for the frame between a settled begin
   * and the effect that opens its stream.
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
 * CALLED ABOVE THE DISCLOSURE, never inside the panel. That placement IS the fix —
 * see the header — and it is the caller's to get right, because only the caller knows
 * which of its children are conditional.
 */
export function useProviderImport(
  begin: ProviderImportBeginCall,
  subscribe: ImportProgressSubscribeCall,
): ProviderImportModel {
  // Keyed on the begin call, which IS the whole subject: an act minted in a
  // mount-lifetime cell would stay bound to a call the window has since replaced.
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
