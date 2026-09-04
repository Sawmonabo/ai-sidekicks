// The definition editor's seat on the sidekicks page: chrome here, body elsewhere.
//
// WHY THIS IS A SECOND SEAT AND NOT THE ONE IN `index.ts`
//
// The family door already declares a seat called the sidekick-definition editor,
// and it is a different editor. That one is scoped to an ATTACHED AGENT: it shows
// the configuration one running sidekick was attached under, which is a snapshot
// taken at attach time and never changes afterwards. This one is scoped to a STORED
// DEFINITION — a record a person keeps between sessions, which they rename, retune,
// and delete, and which reaches nothing already running when they do.
//
// Two subjects, two lifetimes, two sets of controls. One seat serving both would
// have to take a union subject, and the body filling it would open with a branch on
// which half it was handed — which is two bodies sharing a function name rather
// than one body. `seats/owner-slot.ts` exists to stop one DECLARATION
// being written twice; it does not ask two different bodies to share one.
//
// WHAT THIS FILE MAY NEVER GROW
//
// A field, a form, a vocabulary read, or a patch. The editor's whole job — the
// three-way state of every axis, the difference between an absent key and an
// explicit null, the posture mode, the tool allowlist's three separately selectable
// states — is the owning plan's, and each of those is a decision this console would
// have to guess at. The seat carries the subject and the deletion obligation, and
// stops.

import { Nothing } from "../primitives/index.js";
import type { OwnerSlotProps } from "../seats/index.js";

/**
 * Which record the editor is open on.
 *
 * A closed two-arm union rather than an optional id, because "edit this stored
 * definition" and "compose one that does not exist yet" are different acts with
 * different daemon verbs behind them, and an `undefined` id would leave the body
 * inferring which from the absence of a value.
 *
 * `definitionId` and never `name`: the name is a mutable label a person may change
 * at any time, and a seat keyed by it would hand the body a subject that stops
 * resolving the moment somebody renames the record it names.
 */
export type SidekickDefinitionEditorSubject =
  | { readonly kind: "stored"; readonly definitionId: string }
  | { readonly kind: "new" };

/** What the stored-definition editor is handed when its body arrives. */
export interface SidekickDefinitionRecordEditorProps {
  readonly subject: SidekickDefinitionEditorSubject;
}

/** The editor body, as a render function — the shape every seat in this tree uses. */
export type SidekickDefinitionRecordEditorBody = (
  props: SidekickDefinitionRecordEditorProps,
) => React.ReactNode;

/**
 * The seat itself.
 *
 * `body` is `undefined` and this console does not author one. The three contract
 * members are developer-facing and reach no screen — the mount below is what a
 * person sees, and it names the feature rather than the work that owes it.
 */
export const SIDEKICK_DEFINITION_RECORD_EDITOR_SLOT: OwnerSlotProps<SidekickDefinitionRecordEditorBody> =
  {
    contract: {
      // Plan-030 owns the sidekick-definition registry and its editor; CP-023-6 is
      // the obligation under which this console mounts it.
      owningTask: "Plan-030 (mounted through CP-023-6)",
      mountObligation:
        "a bounded region beside the stored list, the subject the page has selected, and nothing else; the body owns the record read, every axis and its three-way state, the null-versus-absent patch, the save and delete verbs, and every refusal",
      deleteShellIn: "the Plan-030 editor task that fills this slot",
    },
    body: undefined,
  };

export interface SidekickDefinitionRecordEditorMountProps {
  /**
   * The seat being mounted, passed in rather than read from module scope.
   *
   * The page names the seat it is mounting, which is one more place a reader can
   * see the wiring — and it is what lets this component's filled arm be driven at
   * all. A component that reached for the module constant could only ever be
   * exercised in its empty arm, so the arm that matters on the day the body lands
   * would ship having never run.
   */
  readonly slot: OwnerSlotProps<SidekickDefinitionRecordEditorBody>;
  /** `undefined` while nothing is selected — no record open, and none being composed. */
  readonly subject: SidekickDefinitionEditorSubject | undefined;
}

/**
 * Render the seat: the body if it has arrived and has a subject, the reservation if not.
 *
 * "Reserved, not stubbed" — the console says the editor has not been built rather
 * than drawing a disabled form, which reads as a feature that is broken. There is
 * deliberately no shared owner-slot component anywhere in this console: a seat is
 * mounted by the family that mounts it, in that family's own layout and with that
 * family's own absence treatment.
 */
export function SidekickDefinitionRecordEditorMount(
  props: SidekickDefinitionRecordEditorMountProps,
): React.JSX.Element {
  const { body } = props.slot;
  if (body === undefined || props.subject === undefined) {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title="The sidekick editor has not been built here yet."
        detail="It will hold the provider, model, account, effort, instructions, goal, tool allowlist, and execution posture a saved sidekick is tuned with, and say for each one whether it is pinned here or inherited."
      />
    );
  }
  return <>{body({ subject: props.subject })}</>;
}
