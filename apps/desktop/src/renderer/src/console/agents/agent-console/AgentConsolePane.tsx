// The agent console: what one agent is running under, in a pane or in a window.
//
// `Spec-023 §Console Design (Meridian)` §The surface set ships exactly two auxiliary
// windows, and this is one of them — so this body is mounted twice, by the deck as a
// pane and by the frame as the `agent-console` surface. It takes plain props rather
// than either context so neither mount has to translate the other's shape, and so the
// component can be driven in a test without building a deck or a route.
//
// EVERY WIRE-BACKED PROP IS OPTIONAL, AND THAT IS NOT LAZINESS. An auxiliary address
// resolves to a session and may name no agent; a bare route resolves to no session at
// all, and both contexts type `sessionStore` as possibly absent for exactly that
// reason. A pane that demanded them would be unmountable in the states the frame can
// actually produce, so each column states which half it is missing instead.
//
// WHAT EACH COLUMN IS
//
//   • **Binding** — the roster read, the card for this agent, the provider-axis
//     switch, and the attach form. Its own component, because every one of those
//     needs the models and hooks cannot be called conditionally.
//   • **Machines** — the shipped runtime-node roster, absorbed rather than
//     re-authored: it is the only caller of the node-attach reads that exists, and a
//     second one beside it would be two implementations of one job. It is handed the
//     roster read and the presence subscription this pane's own bridge serves, so it
//     answers from whichever bridge this window resolved and never from a second one
//     beside it.
//   • **Definition** — the seat for a body another plan authors.
//   • **Peers and linkage** — the session-scoped peer-invocation grant, and what this
//     agent's newest run started or was refused. Each is its own module: both hold
//     state whose subject can change under them — a session for the grant, a parent
//     run for the linkage — and that rule is what each module's header is about.

import { useAgentConsoleModels } from "../run-console/agent-console-model.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import { renderAbsorbedNodeRoster } from "../../frame/legacy-surfaces.js";
import { Nothing, WireFigure } from "../../primitives/index.js";
import type { SessionStore } from "../../store/index.js";
import { AgentBindingColumn } from "./AgentBindingColumn.js";
import { PeerInvocationMount } from "./PeerInvocationMount.js";
import { RunLinkageMount } from "./RunLinkageMount.js";
import { SidekickDefinitionEditorMount } from "./SidekickDefinitionEditorMount.js";

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
  /**
   * Absent where the mount could not resolve one; the columns that need it say so.
   *
   * There is no second `bridgeSource` prop beside this. Both mounts pass the whole
   * bridge and the bridge names its own source, so a separate source prop would be
   * a second answer to a question this one already answers — and the machines
   * column, which was the only reader of that answer, now takes the bridge itself.
   */
  readonly bridge?: ConsoleBridge | undefined;
  /** Absent on a bare route, which both mount contexts admit. */
  readonly sessionStore?: SessionStore | undefined;
}

export function AgentConsolePane(props: AgentConsolePaneProps): React.JSX.Element {
  const models = useAgentConsoleModels(props.bridge, props.sessionStore);

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
        <div className="meridian-agent-console__column" aria-label="Binding">
          <h3 className="meridian-agent-console__column-title">Binding</h3>
          {models === undefined ? (
            <Nothing
              kind="not-checked"
              placement="surface"
              title="This console was not handed a session to read agents from."
              detail="The roster, the binding, and the attach form are all scoped to one session, so nothing was asked of the daemon."
            />
          ) : (
            <AgentBindingColumn models={models} agentId={props.agentId} />
          )}
        </div>

        <div className="meridian-agent-console__column" aria-label="Machines">
          <h3 className="meridian-agent-console__column-title">Machines</h3>
          {renderAbsorbedNodeRoster(props.bridge, props.sessionId)}
        </div>

        <div className="meridian-agent-console__column" aria-label="Definition">
          <h3 className="meridian-agent-console__column-title">Definition</h3>
          <SidekickDefinitionEditorMount agentId={props.agentId} />
        </div>

        <div className="meridian-agent-console__column" aria-label="Peers and linkage">
          <h3 className="meridian-agent-console__column-title">Peers and linkage</h3>
          <PeerInvocationMount
            models={models}
            bridge={props.bridge}
            sessionStore={props.sessionStore}
          />
          <RunLinkageMount
            models={models}
            sessionStore={props.sessionStore}
            agentId={props.agentId}
          />
        </div>
      </div>
    </section>
  );
}
