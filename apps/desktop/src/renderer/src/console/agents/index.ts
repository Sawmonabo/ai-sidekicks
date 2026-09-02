// The agents family's door.
//
// Today it holds exactly one thing: the seat for a body another plan authors.
//
// WHY THE SEAT LIVES IN THIS FAMILY AND NOT WHERE IT IS MOUNTED
//
// The editor is about an agent's DEFINITION — its instructions, its goal, its tool
// allowlist, its execution posture. That vocabulary is this family's, and the
// surface that happens to mount the editor today (the agent console) is one of
// several that eventually will. A seat declared at the mount point would have to be
// re-declared at the second one, and two declarations of one contract is exactly
// what `workspace/seats/owner-slot.ts` exists to prevent.
//
// The agent card, the roster read, and the lifecycle vocabulary they render are the
// roster lane's and land beside this file.

import type { OwnerSlotProps } from "../workspace/index.js";

// The sidekicks page, which the settings surface mounts. It is a page rather than a
// pane because the design puts a saved sidekick's configuration in settings and
// reaches it from the in-session attach picker, and it crosses a family boundary, so
// it leaves this family through the door rather than by a deep import.
export { SidekickDefinitionsPage } from "./DefinitionsPage.js";

/** What the sidekick-definition editor is handed when its body arrives. */
export interface SidekickDefinitionEditorProps {
  /** The agent whose definition is being edited, wire-verbatim. */
  readonly agentId: string;
}

/** The editor body, as a render function — the shape every seat in this tree uses. */
export type SidekickDefinitionEditorBody = (
  props: SidekickDefinitionEditorProps,
) => React.ReactNode;

/**
 * The sidekick-definition editor: chrome here, body elsewhere.
 *
 * `body` is `undefined` and this console does not author one. The mounting surface
 * renders its own reserved-not-stubbed treatment; the contract's three members are
 * developer-facing and reach no screen.
 */
export const SIDEKICK_DEFINITION_EDITOR_SLOT: OwnerSlotProps<SidekickDefinitionEditorBody> = {
  contract: {
    owningTask: "Plan-030 (mounted through CP-023-6)",
    mountObligation:
      "a bounded region inside the agent console, the agent id the pane is scoped to, and nothing else; the body owns the definition read, every field, and every refusal",
    deleteShellIn: "the Plan-030 editor task that fills this slot",
  },
  body: undefined,
};
