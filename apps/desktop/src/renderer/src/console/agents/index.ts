// The agents family's door.
//
// WHAT IS BEHIND IT
//
// The agent card and its binding vocabulary, the two forms that move a binding
// (attach and the provider-axis switch), the settlement projection those replies are
// read through, the peer-invocation grant, the child-run linkage view, and the seat
// for a body another plan authors.
//
// WHY THE DEFINITION-EDITOR SEAT LIVES IN THIS FAMILY AND NOT WHERE IT IS MOUNTED
//
// The editor is about an agent's DEFINITION — its instructions, its goal, its tool
// allowlist, its execution posture. That vocabulary is this family's, and the
// surface that happens to mount the editor today (the agent console) is one of
// several that eventually will. A seat declared at the mount point would have to be
// re-declared at the second one, and two declarations of one contract is exactly
// what `workspace/seats/owner-slot.ts` exists to prevent.
//
// THE STYLESHEET IS IMPORTED HERE AND NOWHERE ELSE, so a surface can never render one
// of these components without the CSS that makes it legible, and the bundler sees one
// edge into the sheet rather than one per component.

import "./agents.css";

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

// --- WHAT LEAVES THIS FAMILY -------------------------------------------
//
// Only the symbols a surface outside `agents/` composes. The vocabulary tuples,
// the reading shapes, the catalog selectors, and the settlement projection are
// this family's own and are reached deeply from inside it — a barrel entry for
// one of them would be an export nothing outside can name.

export {
  AgentConsoleModels,
  newestRunIdForAgent,
  useAgentConsoleModels,
} from "./agent-console-model.js";

export type { AgentAttachReading, AgentSwitchSettlement, ProviderAxis } from "./agent-wire.js";

export { AgentCard, AgentRosterEmpty } from "./AgentCard.js";
export { AttachSidekick } from "./AttachSidekick.js";
export { AttachSidekickForm } from "./attach-model.js";
export { PeerInvocation } from "./PeerInvocation.js";
export { ProviderSwitch } from "./ProviderSwitch.js";
export { RunLinkage } from "./RunLinkage.js";
