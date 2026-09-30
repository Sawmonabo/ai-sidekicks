// What a definition's detail offers: the acts it draws, the refusals it raises itself, and what
// an act's answer settles to. `hooks/useWorkflowDefinitionAuthoring.ts` holds the latch and the
// record and hands each press to `definition-authoring-export.ts` or
// `definition-authoring-port-acts.ts`.

import { refuse, type Refusal } from "@renderer/lib/refusal.js";

/** The acts a detail draws; `WorkflowDetailAct` derives from this tuple. */
export const WORKFLOW_DETAIL_ACTS = ["export", "import"] as const;

/** One act a detail draws. */
export type WorkflowDetailAct = (typeof WORKFLOW_DETAIL_ACTS)[number];

/** The subsystem name every refusal the definition detail raises is attributed to. */
export const WORKFLOW_DETAIL_ORIGIN = "workflow-definition-detail";

/**
 * The refusals the definition detail raises itself, each a fact about this window that settles
 * before any call is put. Every other refusal shown here (the host's clipboard rejection)
 * arrives from elsewhere and is rendered verbatim.
 *
 *   - `file-unreadable`: the file reader refused the pasted text; its reason is the sentence.
 *   - `session-unbound`: the pane is open on no session for an import to land in.
 *   - `act-in-flight`: a create is outstanding and cannot be recalled, so a second press is
 *     answered rather than queued or dropped.
 */
export const WORKFLOW_DETAIL_REFUSAL_CODES: readonly [
  "file-unreadable",
  "session-unbound",
  "act-in-flight",
] = ["file-unreadable", "session-unbound", "act-in-flight"] as const;

/** One locally raised refusal code. */
export type WorkflowDetailRefusalCode = (typeof WORKFLOW_DETAIL_REFUSAL_CODES)[number];

/**
 * Where one act stands. No arm carries the exported bytes: the clipboard write settles after
 * serialization, so bytes on the settled arm would vanish on a host refusal (they live in
 * `exportedFile`). `dispatching` carries its own sentence because the two acts wait on
 * different things.
 */
export type WorkflowDetailActOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "dispatching"; readonly detail: string }
  | { readonly kind: "settled"; readonly detail: string }
  | { readonly kind: "refused"; readonly refusal: Refusal };

/** The two acts, each with where it stands, and the bytes an export produced. */
export interface WorkflowDefinitionAuthoring {
  readonly outcomes: Readonly<Record<WorkflowDetailAct, WorkflowDetailActOutcome>>;
  /**
   * The file the last export serialized for this definition, once there is one. It survives
   * the clipboard's answer, so a refused copy can be recovered by hand.
   */
  readonly exportedFile: string | undefined;
  /** Serialize the version body on screen and hand the bytes to the host. */
  exportDefinition: () => void;
  /** Read pasted text as a definition file and submit it into this session's scope. */
  importDefinition: (text: string) => void;
}

/**
 * Raise one of the definition detail's own refusals. `refuse` takes a wide `string` code, so
 * this narrows it: a code the tuple above does not declare is a compile error.
 */
export function detailRefusal(code: WorkflowDetailRefusalCode, sentence: string): Refusal {
  return refuse(WORKFLOW_DETAIL_ORIGIN, code, sentence);
}
