// One provider import, held for as long as the import runs rather than for as long as
// its panel is on screen.
//
// THE DEFECT THIS EXISTS FOR. A panel that held both halves of an import itself — the
// begin act in its own cell and the progress drain in its own effect — lost the import
// whenever it was unmounted: the cleanup closed the progress subscription while the
// daemon went on reading the transcript, and coming back built a fresh act with no
// import id at all. The one-import-at-a-time guard is derived from that id, so the
// panel then offered another import while the first was still running, with nothing
// anywhere reporting it. Every part of that is silent.
//
// SO THE STATE LIVES ABOVE THE CONDITION. The caller holds this model and renders the
// panel with it; the panel is a view over an import rather than the place an import
// lives. A panel that unmounts and comes back finds the same act, the same id, and a
// subscription that was never closed — the reading continues while the panel is not
// looking at it.
//
// THAT IS A LIFETIME AND NOT A CACHE. The act is addressed on the begin call through
// the console's one subject-scoped holder, so a new call retires the import along with
// everything else the old one answered.
//
// The two calls are the caller's, taken as arguments, so this module keeps only its
// own logic. A rejected call is not caught here: it propagates.
//
// TWO PHASES, KEPT APART, AND ONE PREDICATE OVER BOTH. The begin settles once and the
// stream is a stream; they fail differently and read differently, which is why
// `act-settlement.ts` and `provider-import.ts` are two modules. What a CONTROL needs
// is the union of them — whether an import is underway at all — and that is composed
// once here rather than at each control, because two controls deriving it separately
// would eventually disagree about which frame an import ends on.

import { SingleFlightAct, useSingleFlightAct } from "./useSingleFlightAct.js";
import {
  isImportUnderway,
  type ImportProgressReading,
  type ImportProgressSubscribeCall,
} from "./import-progress.js";
import { useImportProgress } from "./useImportProgress.js";
import type { Refusal } from "@renderer/lib/refusal.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";

/**
 * The call that begins one provider import.
 */
export type ProviderImportBeginCall = (
  request: ProviderImportRequest,
) => Promise<ProviderImportAnswer>;

/** Everything a surface needs to render one import, and the one act that starts one. */
export interface ProviderImportModel {
  /** Where the progress subscription got to, in the producer's own words. */
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
   * Put one import. Resolves to the act's own refusal while one is already running,
   * and to `undefined` where the import was put. A rejected begin propagates.
   */
  readonly put: (request: ProviderImportRequest) => Promise<Refusal | undefined>;
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
      new SingleFlightAct<ProviderImportRequest, ProviderImportAnswer>({
        attempt: begin,
        describeWhat: "The import",
      }),
  ).value;
  const settlement = useSingleFlightAct(act);
  const importId = settlement.status === "settled" ? settlement.answer.importId : undefined;
  const progress = useImportProgress(subscribe, importId);
  const isBeginning = settlement.status === "running";
  const isReading = isImportUnderway(importId, progress);
  return {
    progress,
    isBeginning,
    isReading,
    isUnderway: isBeginning || isReading,
    put: async (request) => await act.run(request),
  };
}

/** What the begin call takes: the provider, and what to read from it. */
interface ProviderImportRequest {
  readonly providerName: string;
  readonly sourceRef: string;
}

/** What the begin call answers: the id the progress subscription is opened on. */
interface ProviderImportAnswer {
  readonly importId: string;
}
