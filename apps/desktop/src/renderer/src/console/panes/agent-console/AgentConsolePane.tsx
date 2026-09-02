// The agent console: what one agent is running under, in a pane or in a window.
//
// `Spec-023 §Console Design (Meridian)` §The surface set ships exactly two
// auxiliary windows, and this is one of them — so this body is mounted twice, by
// the deck as a pane and by the frame as the `agent-console` surface. It takes
// plain props rather than either context so neither mount has to translate the
// other's shape, and so the component can be driven in a test without building a
// deck or a route.
//
// WHAT IT SAYS TODAY, AND WHY THAT IS THE HONEST AMOUNT
//
// `Spec-023 §Console Design (Meridian)` §The agent card fixes what the binding
// read renders: identity and lifecycle, the EFFECTIVE provider axis and never the
// pending one, the observed output speed beside the requested one, and any pending
// switch as a line of its own. Every one of those comes from a roster read that is
// fixture-only, and the card that renders them is the roster lane's. What this file
// owns is the frame they land in: who this pane is about, the machines the session's
// agents run on, and the definition editor's seat.
//
// The machines column is the shipped runtime-node roster, absorbed rather than
// re-authored — it is the only caller of the node-attach reads that exists, and a
// second one beside it would be two implementations of one job. It reads the
// installed bridge directly, so under the fixture the frame says the question was
// not put rather than answering from the live daemon in a window showing fixture
// data.

import { SIDEKICK_DEFINITION_EDITOR_SLOT } from "../../agents/index.js";
import type { ConsoleBridgeSource } from "../../bridge/index.js";
import { renderAbsorbedNodeRoster } from "../../frame/legacy-surfaces.js";
import { Nothing, WireFigure } from "../../primitives/index.js";

export interface AgentConsolePaneProps {
  /** The session this console is scoped to, wire-verbatim. */
  readonly sessionId: string | undefined;
  /**
   * The agent this console is about, wire-verbatim.
   *
   * `undefined` is reachable and is not a fault: the frame's context picker resolves
   * a bare auxiliary address by choosing a SESSION, and the agent-console grammar
   * carries its agent with its session or not at all, so a picked session arrives
   * here with no agent named. The pane says which half it is missing.
   */
  readonly agentId: string | undefined;
  readonly bridgeSource: ConsoleBridgeSource;
}

export function AgentConsolePane(props: AgentConsolePaneProps): React.JSX.Element {
  return (
    <section className="meridian-agent-console" aria-label="Agent console">
      <header className="meridian-agent-console__head">
        <h2 className="meridian-agent-console__title">Agent console</h2>
        {props.agentId === undefined ? (
          <p className="meridian-agent-console__subject">
            This console is open on a session and not yet on one of its agents.
          </p>
        ) : (
          <p className="meridian-agent-console__subject">
            <WireFigure value={props.agentId} />
          </p>
        )}
      </header>

      <div className="meridian-agent-console__columns">
        <div className="meridian-agent-console__column" aria-label="Machines">
          <h3 className="meridian-agent-console__column-title">Machines</h3>
          {renderAbsorbedNodeRoster(props.bridgeSource, props.sessionId)}
        </div>

        <div className="meridian-agent-console__column" aria-label="Definition">
          <h3 className="meridian-agent-console__column-title">Definition</h3>
          <SidekickDefinitionEditorMount agentId={props.agentId} />
        </div>
      </div>
    </section>
  );
}

/**
 * The definition editor's seat, rendered in this pane's own layout.
 *
 * There is deliberately no shared owner-slot component in this console — a slot is
 * mounted by the family that mounts it, with that family's own reserved-not-stubbed
 * treatment. This is that treatment for this pane: a stated absence naming the
 * feature, never the governance work that owes it.
 */
function SidekickDefinitionEditorMount(props: {
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
