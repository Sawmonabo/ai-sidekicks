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
//     agent's newest run started or was refused.

import { useCallback, useEffect, useState } from "react";

import {
  PeerInvocation,
  RunLinkage,
  SIDEKICK_DEFINITION_EDITOR_SLOT,
  useAgentConsoleModels,
  useNewestRunIdForAgent,
  type AgentConsoleModels,
  type ChildRunLinkageRead,
} from "../../agents/index.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import type { ConsoleRefusal } from "../../core/index.js";
import { consoleRefusalFrom, usePushDrivenRead } from "../../seats/index.js";
import { renderAbsorbedNodeRoster } from "../../frame/legacy-surfaces.js";
import { Nothing, WireFigure } from "../../primitives/index.js";
import type { SessionStore } from "../../store/index.js";
import { AgentBindingColumn } from "./AgentBindingColumn.js";
import { usePeerInvocationEnabled, useSessionProjectionReRead } from "./session-projection.js";

/** Names a peer-invocation failure the thrown value carried no refusal for. */
const PEER_INVOCATION_ORIGIN = "peer-invocation";

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

/**
 * The peer-invocation grant, projected rather than remembered.
 *
 * The value comes from the session's own projection, and its ABSENCE from that
 * projection is the third state the control renders as unknown — the member is not
 * on the shipped session read, so a session that has the capability enabled looks
 * identical here to one that does not, and saying "off" would be the one wrong
 * answer. The re-read therefore has to be a real read: it asks the daemon again
 * through the refresh chokepoint and its reply lands in the store, whose session
 * partition this mount is subscribed to — so a member the daemon now serves
 * appears without anything here holding a second copy of it.
 */
function PeerInvocationMount(props: {
  readonly models: AgentConsoleModels | undefined;
  readonly bridge: ConsoleBridge | undefined;
  readonly sessionStore: SessionStore | undefined;
}): React.JSX.Element {
  const { bridge, models, sessionStore } = props;
  if (sessionStore === undefined) {
    // No store means no partition to subscribe to and nothing for a re-read to
    // land in, so the control is mounted without either and its recovery answers
    // with the refusal that says so.
    return <PeerInvocationControl models={models} bridge={bridge} projectedEnabled={undefined} />;
  }
  return <SubscribedPeerInvocation models={models} bridge={bridge} sessionStore={sessionStore} />;
}

/** The mounted arm, where a store exists and its partition subscription may run. */
function SubscribedPeerInvocation(props: {
  readonly models: AgentConsoleModels | undefined;
  readonly bridge: ConsoleBridge | undefined;
  readonly sessionStore: SessionStore;
}): React.JSX.Element {
  const projectedEnabled = usePeerInvocationEnabled(props.sessionStore);
  return (
    <PeerInvocationControl
      models={props.models}
      bridge={props.bridge}
      sessionStore={props.sessionStore}
      projectedEnabled={projectedEnabled}
    />
  );
}

/**
 * What one peer-invocation mutation settled with, and which session it was about.
 *
 * THE SESSION IS PART OF THE SETTLEMENT, which is the whole of this type. The pane
 * stays mounted when it moves from one session to another — the deck hands it new
 * props rather than a new instance — so an unstamped settlement kept winning over
 * the session the console had arrived at, and a reply from the session it had left
 * could land after the move and decide the switch for a session it was never about.
 * Both are the same defect: a local settlement outliving its subject.
 *
 * The comparison is on the SESSION and never on the value, for
 * `agents/agent-console-model.ts`' reason: two sessions agreeing about the grant is
 * not one fact, it is two, and only one of them was read.
 */
type PeerInvocationSettlement =
  | { readonly sessionId: string; readonly outcome: "served"; readonly enabled: boolean }
  | { readonly sessionId: string; readonly outcome: "refused"; readonly refusal: ConsoleRefusal };

/** The control itself: the projected grant, the mutation, and the re-read. */
function PeerInvocationControl(props: {
  readonly models: AgentConsoleModels | undefined;
  readonly bridge: ConsoleBridge | undefined;
  readonly sessionStore?: SessionStore | undefined;
  readonly projectedEnabled: boolean | undefined;
}): React.JSX.Element {
  const { bridge, models, projectedEnabled, sessionStore } = props;
  const [settlement, setSettlement] = useState<PeerInvocationSettlement | undefined>(undefined);
  const reRead = useSessionProjectionReRead(bridge, sessionStore);

  const setEnabled = useCallback(
    (enabled: boolean): void => {
      if (models === undefined) {
        return;
      }
      const askedOfSessionId = models.sessionId;
      models
        .setPeerInvocation(enabled)
        // The REPLY's value, read back from the post-append projection — never the
        // value that was asked for — stamped with the session it was asked of.
        .then((reply) => {
          setSettlement({ sessionId: askedOfSessionId, outcome: "served", enabled: reply.enabled });
        })
        .catch((error: unknown) => {
          setSettlement({
            sessionId: askedOfSessionId,
            outcome: "refused",
            refusal: consoleRefusalFrom(error, PEER_INVOCATION_ORIGIN),
          });
        });
    },
    [models],
  );

  // Answered only while the settlement is THIS session's. A pane that has moved
  // falls back to the new session's projection, which is the only thing anything
  // has read about it — and to the unknown arm where that projection is absent,
  // which is the honest answer rather than the previous session's grant.
  const settledHere =
    models !== undefined && settlement?.sessionId === models.sessionId ? settlement : undefined;

  return (
    <PeerInvocation
      enabled={settledHere?.outcome === "served" ? settledHere.enabled : projectedEnabled}
      onSetEnabled={setEnabled}
      onReRead={reRead.requestReRead}
      // The two refusals are reachable from different states of this control — the
      // switch is drawn only where the grant is known and the re-read is offered
      // only where it is not — so the mutation's is preferred without either ever
      // hiding the other in practice.
      refusal={
        (settledHere?.outcome === "refused" ? settledHere.refusal : undefined) ?? reRead.refusal
      }
    />
  );
}

/**
 * The child-link read for this agent's newest run.
 *
 * The read is keyed by a PARENT RUN and this console is scoped to an agent, so the
 * two are related through the store's own run projection and through no wire question
 * the daemon answers. Where no run has been attributed to this agent, the surface
 * renders that absence rather than an empty result.
 */
function RunLinkageMount(props: {
  readonly models: AgentConsoleModels | undefined;
  readonly sessionStore: SessionStore | undefined;
  readonly agentId: string | undefined;
}): React.JSX.Element {
  const { models, sessionStore, agentId } = props;
  if (models === undefined || sessionStore === undefined) {
    return <RunLinkage parentRunId={undefined} state={undefined} />;
  }
  return <SubscribedRunLinkage models={models} sessionStore={sessionStore} agentId={agentId} />;
}

/** The subscribed arm: the linkage is re-keyed whenever the run partition moves. */
function SubscribedRunLinkage(props: {
  readonly models: AgentConsoleModels;
  readonly sessionStore: SessionStore;
  readonly agentId: string | undefined;
}): React.JSX.Element {
  const parentRunId = useNewestRunIdForAgent(props.sessionStore, props.agentId);
  if (parentRunId === undefined) {
    return <RunLinkage parentRunId={undefined} state={undefined} />;
  }
  return <ResolvedRunLinkage models={props.models} parentRunId={parentRunId} />;
}

/**
 * The mounted arm, where both halves exist and the read may be taken.
 *
 * The lease is taken and the read started from an EFFECT and never from the render
 * body: starting opens a subscription and arms a scheduler, and React may abandon or
 * replay a render pass — an abandoned one would leave a live read with no cleanup to
 * release it, and a replayed one would dispose a read the committed tree is still
 * showing. The frame between the render that names a run and the effect that leases
 * its read holds none, and renders as the `not-checked` absence the surface already
 * has for a question nothing was asked of.
 */
function ResolvedRunLinkage(props: {
  readonly models: AgentConsoleModels;
  readonly parentRunId: string;
}): React.JSX.Element {
  const { models, parentRunId } = props;
  const [read, setRead] = useState<ChildRunLinkageRead | undefined>(undefined);

  useEffect(() => {
    const lease = models.acquireLinkage(parentRunId);
    lease.read.start();
    setRead(lease.read);
    return () => {
      lease.release();
      setRead(undefined);
    };
  }, [models, parentRunId]);

  if (read === undefined) {
    return <RunLinkage parentRunId={parentRunId} state={undefined} />;
  }
  return <HeldRunLinkage parentRunId={parentRunId} read={read} />;
}

/** The arm where a read is held, so the hook that reads it may be called. */
function HeldRunLinkage(props: {
  readonly parentRunId: string;
  readonly read: ChildRunLinkageRead;
}): React.JSX.Element {
  const state = usePushDrivenRead(props.read);
  return <RunLinkage parentRunId={props.parentRunId} state={state} />;
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
