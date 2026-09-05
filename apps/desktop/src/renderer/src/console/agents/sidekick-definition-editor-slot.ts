// The sidekick-definition editor's seat: chrome here, body elsewhere.
//
// WHY THIS IS A MODULE AND NOT A DECLARATION IN THE FAMILY DOOR, which is where it
// was. The one surface that mounts it — the agent console — is inside this family, so
// a mount reaching the door for it would close a cycle the moment the door published
// the console's own registrars: `index.ts` → `agent-console/agent-console-mounts.ts`
// → `AgentConsoleBody.tsx` → `SidekickDefinitionEditorMount.tsx` → `index.ts`, which
// `no-circular` fails. A door that DECLARES rather than re-exports is what makes an
// intra-family consumer unable to reach the symbol deeply, so the declaration moved to
// a module of its own and the door re-exports it like every other name it carries.
//
// WHY THE SEAT LIVES IN THIS FAMILY AND NOT WHERE IT IS MOUNTED. The editor is about
// an agent's DEFINITION — its instructions, its goal, its tool allowlist, its
// execution posture. That vocabulary is this family's, and the surface that happens to
// mount the editor today is one of several that eventually will. A seat declared at
// the mount point would have to be re-declared at the second one, and two declarations
// of one contract is exactly what `seats/owner-slot.ts` exists to prevent.

import type { OwnerSlotProps } from "../seats/index.js";

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
