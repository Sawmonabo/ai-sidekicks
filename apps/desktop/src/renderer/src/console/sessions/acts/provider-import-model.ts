// One provider import, held for as long as the import runs rather than for as long as
// its panel is on screen.
//
// THE DEFECT THIS EXISTS FOR. `ProviderImportPanel` held both halves of an import
// itself — the begin act in its own subject-scoped cell and the progress drain in its
// own effect — and the panel is rendered CONDITIONALLY, behind the acts bar's
// disclosure. Switching to the join form therefore unmounted it mid-import: the
// cleanup closed the progress subscription while the daemon went on reading the
// transcript, and coming back built a fresh act with no import id at all. The
// one-import-at-a-time guard is derived from that id, so the panel then offered
// another import while the first was still running, with nothing anywhere reporting
// it. Every part of that is silent.
//
// SO THE STATE LIVES ABOVE THE CONDITION. `SessionActs` holds this model and renders
// the panel with it; the panel became a view over an import rather than the place an
// import lives. A panel that unmounts and comes back now finds the same act, the same
// id, and a subscription that was never closed — the reading continues while the
// panel is not looking at it.
//
// THAT IS A LIFETIME AND NOT A CACHE. Nothing here survives the growth port it was
// held for: the act is addressed on the port through the console's one subject-scoped
// holder, exactly as it was when the panel held it, so a bridge or scenario change
// still retires the import along with everything else that port answered.
//
// TWO PHASES, KEPT APART, AND ONE PREDICATE OVER BOTH. The begin settles once and the
// stream is a stream; they fail differently and read differently, which is why
// `act-settlement.ts` and `provider-import.ts` are two modules. What a CONTROL needs
// is the union of them — whether an import is underway at all — and that is composed
// once here rather than at each control, because two controls deriving it separately
// would eventually disagree about which frame an import ends on.

import { SessionAct, useSessionAct, type ActSettlement } from "./act-settlement.js";
import {
  isImportUnderway,
  useImportProgress,
  type ImportProgressReading,
} from "./provider-import.js";
import { settleGrowthRead, type GrowthPort } from "../../bridge/index.js";
import { useSubjectScopedState } from "../../store/index.js";

/** The holder key the import's opening act is addressed by, within a port. */
const IMPORT_ACT_KEY = "provider-session-import";

/**
 * What the begin call takes, derived from the port rather than restated beside it.
 *
 * The request shape is declared once, in `bridge/growth-signatures/sessions.ts`, and a
 * hand-written copy here would be a second declaration of a closed shape — free to
 * drift the day the wire lands and grows a member.
 */
type ProviderImportRequest = Parameters<GrowthPort["providerSessionImportBegin"]>[0];

/** What a settled begin answers with, derived from that same port's served arm. */
type ProviderImportAnswer = Extract<
  Awaited<ReturnType<GrowthPort["providerSessionImportBegin"]>>,
  { readonly status: "served" }
>["value"];

/** Everything a surface needs to render one import, and the one act that starts one. */
export interface ProviderImportModel {
  /** Where the opening call got to. Its refused arm is the act's own refusal. */
  readonly settlement: ActSettlement<ProviderImportAnswer>;
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
   * the acts bar's disclosure switch are asking one question and a second derivation
   * of it would answer differently for the frame between a settled begin and the
   * effect that opens its stream.
   */
  readonly isUnderway: boolean;
  /** Put one import. Refuses in the act's own words while one is already running. */
  readonly put: (request: ProviderImportRequest) => void;
}

/**
 * Mint the act, on the port and not on the mount.
 *
 * A declared function taking the port rather than a closure written at the call site,
 * on the rule `session-pins.ts` states for its own acts: the seed is read only when
 * the subject changes, so it names the port it was minted for and nothing else.
 */
function mintProviderImportAct(
  growth: GrowthPort,
): SessionAct<ProviderImportRequest, ProviderImportAnswer> {
  return new SessionAct<ProviderImportRequest, ProviderImportAnswer>({
    // Through `settleGrowthRead`, which is the console's one reader of a growth call
    // that REJECTED rather than answering — the fixture throws a scripted daemon
    // refusal verbatim, and the live seam will throw the same shape the day the wire
    // lands, so a call site reading only the fulfilment arm leaves the form pinned on
    // "running" for the life of the mount while an unhandled rejection reaches the
    // window.
    //
    // The refusing arm IS a `ConsoleRefusal` either way and carries the operation, the
    // slate row, and the document that owes the wire, so it travels onto the act's
    // refused arm untouched rather than being re-minted here.
    attempt: async (request) => {
      const outcome = await settleGrowthRead(growth.providerSessionImportBegin(request));
      return outcome.status === "served"
        ? { status: "served", value: outcome.value }
        : { status: "refused", refusal: outcome };
    },
    describeWhat: "The import",
  });
}

/**
 * Hold one provider import for as long as this component is mounted.
 *
 * CALLED ABOVE THE DISCLOSURE, never inside the panel. That placement IS the fix —
 * see the header — and it is the caller's to get right, because only the caller knows
 * which of its children are conditional.
 */
export function useProviderImport(growth: GrowthPort): ProviderImportModel {
  // Keyed on the PORT, on the rule `JoinSessionForm.tsx` states: an act minted in a
  // mount-lifetime cell stays bound to the growth port the window closed when the
  // bridge or the scenario moved.
  const act = useSubjectScopedState(growth, IMPORT_ACT_KEY, () =>
    mintProviderImportAct(growth),
  ).value;
  const settlement = useSessionAct(act);
  const importId = settlement.status === "settled" ? settlement.answer.importId : undefined;
  const progress = useImportProgress(growth, importId);
  const isBeginning = settlement.status === "running";
  const isReading = isImportUnderway(importId, progress);
  return {
    settlement,
    progress,
    isBeginning,
    isReading,
    isUnderway: isBeginning || isReading,
    put: (request) => {
      // Not awaited, and nothing escapes: the act answers a duplicate press on its
      // return rather than by rejecting, and the attempt above has no throwing arm.
      void act.run(request);
    },
  };
}
