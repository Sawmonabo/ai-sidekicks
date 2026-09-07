// What a definition's detail OFFERS: which acts it draws, which refusals it raises on
// its own, and what an act's answer settles to.
//
// THE DISPATCH IS THE MODULE BESIDE THIS ONE. `definition-authoring-dispatch.ts` holds
// the latch, the three act bodies and the create they ride, on the split
// `run-control-commands.ts` and `run-control-dispatch.ts` already make one family over:
// what a surface offers is read by the component that draws the controls, and how a
// press is carried out is read by nothing but itself.
//
// THREE AND NOT FIVE, AND THE ARITHMETIC IS THE POINT. `builder-authoring.ts`
// enumerates the five acts that WRITE a definition — saving, cutting a new version,
// importing, promoting, forking — and rule 7 gives a surface one primary action, which
// for the builder pane is saving, in its head. What is left for the body is the acts
// whose subject is the definition already in front of the person, and of the four
// remaining two need something this build does not have: cutting a new version and
// forking both submit an EDITED body, and the canvas that would edit one is the
// reserved authoring slot. So they are not drawn — this family's absent-not-disabled
// rule, which withholds a control rather than greying one — and importing and
// promoting are.
//
// THE THIRD IS NOT AN AUTHORING ACT AT ALL, which is why it is not in that tuple.
// Exporting submits nothing: it serializes the version body already on screen into the
// file form and hands the bytes to the host. Adding it to `WORKFLOW_AUTHORING_ACTS`
// would break that tuple's one claim — five acts, one wire — by putting an act with no
// wire inside it.

import { refuse, type ConsoleRefusal } from "../../../core/index.js";

/**
 * The acts a detail draws, and exactly three.
 *
 * The tuple is the declaration and the union derives from it, so the count above is
 * countable at runtime rather than asserted in prose.
 */
export const WORKFLOW_DETAIL_ACTS = ["export", "import", "promote"] as const;

/** One act a detail draws. Derived from the tuple, never restated. */
export type WorkflowDetailAct = (typeof WORKFLOW_DETAIL_ACTS)[number];

/** The subsystem name every refusal this surface raises is attributed to. */
export const WORKFLOW_DETAIL_ORIGIN = "workflow-definition-detail";

/**
 * The refusals this surface raises on its own, and no others.
 *
 * Four, and not one of them is a daemon's — each is a fact about this window that
 * settles before any call is put.
 *
 *   • `body-unavailable` — exporting and promoting both need the version body, and a
 *     version read that refused leaves them nothing to serialize or submit.
 *   • `file-unreadable` — the file-form reader refused the pasted text, and its own
 *     reason travels as the sentence.
 *   • `session-unbound` — an imported definition has to land in a scope, and this pane
 *     is open on no session to land it in.
 *   • `act-in-flight` — a create is already outstanding and cannot be recalled, so the
 *     second press is answered rather than queued or dropped.
 *
 * Every OTHER refusal a person sees here arrived from somewhere else and is rendered
 * verbatim: the port's own `wire-unregistered`, the daemon's typed code, the host's
 * clipboard rejection.
 */
export const WORKFLOW_DETAIL_REFUSAL_CODES: readonly [
  "body-unavailable",
  "file-unreadable",
  "session-unbound",
  "act-in-flight",
] = ["body-unavailable", "file-unreadable", "session-unbound", "act-in-flight"] as const;

/** One locally-raised refusal code. Derived from the tuple, never restated. */
export type WorkflowDetailRefusalCode = (typeof WORKFLOW_DETAIL_REFUSAL_CODES)[number];

/**
 * Where one act stands. The settled arm carries what a person reads about it.
 *
 * NO ARM CARRIES THE EXPORTED BYTES, deliberately. Where an act stands and what it
 * produced are two facts with two lifetimes: the clipboard write settles after the
 * serialization does, so a file held on the settled arm would be erased by the host's
 * own refusal — leaving a person a sentence about a copy that did not happen and
 * nothing on screen to select instead. The bytes are `exportedFile` below.
 */
export type WorkflowDetailActOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "dispatching" }
  | { readonly kind: "settled"; readonly detail: string }
  | { readonly kind: "refused"; readonly refusal: ConsoleRefusal };

/** The three acts, each with where it stands, and the bytes an export produced. */
export interface WorkflowDefinitionAuthoring {
  readonly outcomes: Readonly<Record<WorkflowDetailAct, WorkflowDetailActOutcome>>;
  /**
   * The file the last export serialized for this definition, once there is one.
   *
   * Survives the clipboard's answer either way, which is what makes a refused copy
   * recoverable by hand rather than a dead end.
   */
  readonly exportedFile: string | undefined;
  /** Serialize the version body on screen and hand the bytes to the host. */
  exportDefinition: () => void;
  /** Read pasted text as a definition file and submit it into this session's scope. */
  importDefinition: (text: string) => void;
  /** Submit the version body on screen at `shared` scope, naming what it came from. */
  promoteDefinition: () => void;
}

/**
 * Raise one of this surface's own refusals.
 *
 * THE NARROWING LIVES HERE BECAUSE `refuse` CANNOT DO IT. That constructor's `code`
 * parameter is a deliberately-wide `string` — `core/refusal.ts` cannot close it without
 * importing every producer and inverting the DAG — so every locally-raised refusal goes
 * through this one door, and a code the tuple above does not declare is a compile error
 * rather than a string nobody notices.
 */
export function detailRefusal(code: WorkflowDetailRefusalCode, sentence: string): ConsoleRefusal {
  return refuse(WORKFLOW_DETAIL_ORIGIN, code, sentence);
}

/**
 * The refusal for an act whose subject was refused one read up.
 *
 * Its own constructor rather than a call site's literal, because two acts raise it and
 * a sentence written twice is a sentence that drifts once.
 */
export function bodyUnavailable(actProse: string): ConsoleRefusal {
  return detailRefusal(
    "body-unavailable",
    `${actProse} needs this version's body, and the version read did not answer with one.`,
  );
}
