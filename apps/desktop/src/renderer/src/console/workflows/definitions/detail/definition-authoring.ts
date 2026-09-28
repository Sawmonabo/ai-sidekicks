// What a definition's detail OFFERS: which acts it draws, which refusals it raises on
// its own, and what an act's answer settles to.
//
// THE DISPATCH IS THE MODULE BESIDE THIS ONE. `definition-authoring-dispatch.ts` holds
// the latch and the held record and hands each press to the act that carries it out —
// `definition-authoring-export.ts` for the one that reaches the host,
// `definition-authoring-port-acts.ts` for the one that rides the create — on the split
// `run-control-commands.ts` and `run-control-dispatch.ts` already make one family over:
// what a surface offers is read by the component that draws the controls, and how a
// press is carried out is read by nothing but itself.
//
// TWO ACTS. Importing and exporting are the acts whose subject is the definition already in
// front of the person. Exporting submits nothing: it serializes the version body on screen
// into the file form and hands the bytes to the host. Importing puts the create call.

import { refuse, type ConsoleRefusal } from "../../../core/index.js";

/**
 * The acts a detail draws, and exactly two.
 *
 * The tuple is the declaration and the union derives from it, so the count above is
 * countable at runtime rather than asserted in prose.
 */
export const WORKFLOW_DETAIL_ACTS = ["export", "import"] as const;

/** One act a detail draws. Derived from the tuple, never restated. */
export type WorkflowDetailAct = (typeof WORKFLOW_DETAIL_ACTS)[number];

/** The subsystem name every refusal this surface raises is attributed to. */
export const WORKFLOW_DETAIL_ORIGIN = "workflow-definition-detail";

/**
 * The refusals this surface raises on its own, and no others.
 *
 * Three, and not one of them is a daemon's — each is a fact about this window that
 * settles before any call is put.
 *
 *   • `file-unreadable` — the file-form reader refused the pasted text, and its own
 *     reason travels as the sentence.
 *   • `session-unbound` — an imported definition has to land in a scope, and this pane
 *     is open on no session to land it in.
 *   • `act-in-flight` — a create is already outstanding and cannot be recalled, so the
 *     second press is answered rather than queued or dropped.
 *
 * Every OTHER refusal a person sees here arrived from somewhere else and is rendered
 * verbatim: the host's clipboard rejection.
 */
export const WORKFLOW_DETAIL_REFUSAL_CODES: readonly [
  "file-unreadable",
  "session-unbound",
  "act-in-flight",
] = ["file-unreadable", "session-unbound", "act-in-flight"] as const;

/** One locally-raised refusal code. Derived from the tuple, never restated. */
export type WorkflowDetailRefusalCode = (typeof WORKFLOW_DETAIL_REFUSAL_CODES)[number];

/**
 * Where one act stands. The two in-progress-and-after arms carry what a person reads.
 *
 * NO ARM CARRIES THE EXPORTED BYTES, deliberately. Where an act stands and what it
 * produced are two facts with two lifetimes: the clipboard write settles after the
 * serialization does, so a file held on the settled arm would be erased by the host's
 * own refusal — leaving a person a sentence about a copy that did not happen and
 * nothing on screen to select instead. The bytes are `exportedFile` below.
 *
 * AND `dispatching` CARRIES A SENTENCE OF ITS OWN RATHER THAN LEAVING THE WORD TO THE
 * ROW. The two acts are not in flight in the same way — one submits a definition and
 * the other submits nothing at all, handing bytes to the host — so a single word
 * composed at the render site is a word that is wrong for one of them. The act that
 * knows what it is waiting on writes the sentence, which is where the settled arm's
 * already lives.
 */
export type WorkflowDetailActOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "dispatching"; readonly detail: string }
  | { readonly kind: "settled"; readonly detail: string }
  | { readonly kind: "refused"; readonly refusal: ConsoleRefusal };

/** The two acts, each with where it stands, and the bytes an export produced. */
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
