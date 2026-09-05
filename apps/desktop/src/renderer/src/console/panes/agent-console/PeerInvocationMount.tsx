// The session-scoped peer-invocation grant, projected rather than remembered.
//
// The value comes from the session's own projection, and its ABSENCE from that
// projection is the third state the control renders as unknown — the member is not
// on the shipped session read, so a session that has the capability enabled looks
// identical here to one that does not, and saying "off" would be the one wrong
// answer. The re-read therefore has to be a real read: it asks the daemon again
// through the refresh chokepoint and its reply lands in the store, whose session
// partition this mount is subscribed to — so a member the daemon now serves appears
// without anything here holding a second copy of it.
//
// ONE MUTATION AT A TIME, AND ONLY THE CURRENT ONE MAY SETTLE. `sidekick.peerInvocationSet`
// is durable: it appends an event and moves a session-scoped grant. Two of them in
// flight is two durable records for one intended act, and their replies may land in
// either order — so the older one can install over the newer settlement while the
// daemon's own state says the opposite. Two things are needed and neither is
// sufficient:
//
//   • **The latch**, so a second press is never taken while one is outstanding. It
//     is synchronous — `mutation-control.ts` writes it the instant `submit` is
//     entered — because a `useState` flag is only written on the next render and two
//     presses delivered in one task would both read the stale value.
//   • **The generation**, so a reply whose round has been abandoned is discarded.
//     The latch alone does not reach the race the grant actually has: this control's
//     own append reaches the store as a projected row, and the projection moving is
//     what RETIRES the reply being waited on and returns the control to idle. A
//     release with no generation under it is precisely the second press the latch
//     was there to refuse, admitted one moment later.
//
// A SETTLEMENT ALSO BELONGS TO A SESSION. The pane stays mounted when it moves from
// one session to another — the deck hands it new props rather than a new instance —
// so the session a submission was asked of is recorded and its settlement is
// rendered only under that session. The comparison is at RENDER, for the reason
// `RunLinkageMount` states: an effect leaves one committed frame showing the
// previous subject's answer under the new one.
//
// The comparison is on the SESSION and never on the value, for
// `agents/run-console/agent-console-model.ts`' reason: two sessions agreeing about the grant is
// not one fact, it is two, and only one of them was read.

import { useCallback, useEffect, useState } from "react";

import { PeerInvocation, type AgentConsoleModels } from "../../agents/index.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import { useSubjectScopedState, type SessionStore } from "../../store/index.js";
import { AgentMutationControl, useAgentMutationControl } from "./mutation-control.js";
import {
  NOTHING_PROJECTED,
  usePeerInvocationProjection,
  useSessionProjectionReRead,
  type PeerInvocationProjection,
} from "./session-projection.js";

/** Names a peer-invocation failure the thrown value carried no refusal for. */
const PEER_INVOCATION_ORIGIN = "peer-invocation";

/** The grant's mount: subscribed where a store exists, stated where none does. */
export function PeerInvocationMount(props: {
  readonly models: AgentConsoleModels | undefined;
  readonly bridge: ConsoleBridge | undefined;
  readonly sessionStore: SessionStore | undefined;
}): React.JSX.Element {
  const { bridge, models, sessionStore } = props;
  if (sessionStore === undefined) {
    // No store means no partition to subscribe to and nothing for a re-read to
    // land in, so the control is mounted without either and its recovery answers
    // with the refusal that says so.
    return <PeerInvocationControl models={models} bridge={bridge} projection={NOTHING_PROJECTED} />;
  }
  return <SubscribedPeerInvocation models={models} bridge={bridge} sessionStore={sessionStore} />;
}

/** The mounted arm, where a store exists and its partition subscription may run. */
function SubscribedPeerInvocation(props: {
  readonly models: AgentConsoleModels | undefined;
  readonly bridge: ConsoleBridge | undefined;
  readonly sessionStore: SessionStore;
}): React.JSX.Element {
  const projection = usePeerInvocationProjection(props.sessionStore);
  return (
    <PeerInvocationControl
      models={props.models}
      bridge={props.bridge}
      sessionStore={props.sessionStore}
      projection={projection}
    />
  );
}

/** The control itself: the projected grant, the one mutation, and the re-read. */
function PeerInvocationControl(props: {
  readonly models: AgentConsoleModels | undefined;
  readonly bridge: ConsoleBridge | undefined;
  readonly sessionStore?: SessionStore | undefined;
  readonly projection: PeerInvocationProjection;
}): React.JSX.Element {
  const { bridge, models, projection, sessionStore } = props;
  // Built by an initializer and never in the body: a body would mint a fresh latch
  // on every pass React discarded, and a latch that is replaced mid-flight admits
  // the press it exists to refuse.
  const [attempt] = useState(
    () => new AgentMutationControl<boolean>({ origin: PEER_INVOCATION_ORIGIN }),
  );
  const attemptState = useAgentMutationControl(attempt);
  // WHETHER THIS CONTROL WAS PRESSED FOR THE SESSION ON SCREEN, keyed on the session
  // so that a pane which has moved reads that session's own seed — nothing was
  // pressed there — rather than a comparison anybody could get the wrong way round.
  //
  // THE SUBJECT IS THE CONTROL AND NOT THE TRANSPORT, because the transport is
  // `undefined` on the arm this component still renders on and a holder has to be
  // addressed by something. The control is what the round belongs to, it lives
  // exactly as long as this mount, and the effect below already retires the round
  // — and clears this value with it — on every move the key does not cover.
  const { value: wasAskedHere, publish: publishAskedHere } = useSubjectScopedState<boolean>(
    attempt,
    models?.sessionId,
    () => false,
  );
  const reRead = useSessionProjectionReRead(bridge, sessionStore);

  // A settled reply is retired the moment the projection it was read against MOVES,
  // and so is one still in flight. Another participant's
  // `session.peer_invocation_set`, this session's own event landing, a reconnect
  // read — each replaces the projected row, and each is the daemon speaking more
  // recently than the reply this control is waiting on or remembering. Without it
  // the first successful mutation won forever, so a grant turned off elsewhere kept
  // reading as on, which is the one direction that matters.
  //
  // Keyed on the row rather than on the value: a grant that goes off and back on
  // reads identical at both ends. Keyed on the models too, because a session change
  // retires a round for the same reason a projection move does. An effect rather
  // than a comparison in the render body, because retiring is a STATE change and a
  // render that performed it would be deriving the settlement it is also holding.
  useEffect(() => {
    attempt.supersede();
    publishAskedHere(false);
  }, [attempt, models, projection.source, publishAskedHere]);

  const setEnabled = useCallback(
    (enabled: boolean): void => {
      if (models === undefined) {
        return;
      }
      // The REPLY's value, read back from the post-append projection — never the
      // value that was asked for. `submit` answers whether the call happened, so
      // the press is recorded for the request that was made rather than for the one
      // the latch refused.
      const admitted = attempt.submit(
        async () => (await models.setPeerInvocation(enabled)).enabled,
      );
      if (admitted) {
        publishAskedHere(true);
      }
    },
    [attempt, models, publishAskedHere],
  );

  // Answered only while the round is THIS session's. A pane that has moved falls
  // back to the new session's projection, which is the only thing anything has read
  // about it — and to the unknown arm where that projection is absent, which is the
  // honest answer rather than the previous session's grant.
  const here = wasAskedHere ? attemptState : undefined;

  return (
    <PeerInvocation
      enabled={here?.status === "settled" ? here.settlement : projection.enabled}
      isPending={here?.status === "in-flight"}
      onSetEnabled={setEnabled}
      onReRead={reRead.requestReRead}
      // The two refusals are reachable from different states of this control — the
      // switch is drawn only where the grant is known and the re-read is offered
      // only where it is not — so the mutation's is preferred without either ever
      // hiding the other in practice.
      refusal={(here?.status === "refused" ? here.refusal : undefined) ?? reRead.refusal}
    />
  );
}
