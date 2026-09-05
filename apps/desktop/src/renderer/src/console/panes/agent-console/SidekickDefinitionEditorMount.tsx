import { SIDEKICK_DEFINITION_EDITOR_SLOT } from "../../agents/index.js";
import { Nothing } from "../../primitives/index.js";

/**
 * The definition editor's seat, rendered in this pane's own layout.
 *
 * There is deliberately no shared owner-slot component in this console — a slot is
 * mounted by the family that mounts it, with that family's own reserved-not-stubbed
 * treatment. This is that treatment for this pane: a stated absence naming the
 * feature, never the governance work that owes it.
 */
export function SidekickDefinitionEditorMount(props: {
  readonly agentId: string | undefined;
}): React.JSX.Element {
  const { body } = SIDEKICK_DEFINITION_EDITOR_SLOT;
  if (body === undefined || props.agentId === undefined) {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title="The definition editor has not been built here yet."
        detail="It will show the instructions, goal, tool allowlist, and execution posture this agent was attached under, and let them be edited where the daemon allows it."
      />
    );
  }
  return <>{body({ agentId: props.agentId })}</>;
}
