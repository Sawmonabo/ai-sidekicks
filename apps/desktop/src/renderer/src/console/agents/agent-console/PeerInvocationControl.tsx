import { useCallback, useEffect, useState } from "react";
import { PeerInvocation } from "../PeerInvocation.js";
import { type AgentConsoleModels } from "../run-console/agent-console-model.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import { useSubjectScopedState, type SessionStore } from "../../store/index.js";
import { AgentMutationControl, useAgentMutationControl } from "./mutation-control.js";
import { useSessionProjectionReRead, type PeerInvocationProjection } from "./session-projection.js";

/** The control itself: the projected grant, the one mutation, and the re-read. */
export function PeerInvocationControl(props: {
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

export /** Names a peer-invocation failure the thrown value carried no refusal for. */
const PEER_INVOCATION_ORIGIN = "peer-invocation";
