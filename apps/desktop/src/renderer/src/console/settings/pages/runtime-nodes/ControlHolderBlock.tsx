// Who holds the session's shared terminal, beside the machines it runs on.
//
// THE HOLDER IS A FACT ABOUT THE SESSION, NOT ABOUT A ROW. One lease exists per
// session, so `controlHolder` rides the roster RESPONSE rather than repeating itself
// on every node — and this block sits beside the node list for the same reason: the
// answer is one line about the session, not a column on a table of machines.
//
// IT COSTS NO SECOND READ. The reply it draws from is the one the absorbed roster
// already performed, recorded as it passed through the console's own read seam. A
// second `runtimenode.roster` would be a second answer, and a holder line disagreeing
// with the rows above it is exactly what that seam exists to prevent — which is also
// why nothing here raises a re-read of its own: the block beside it already asks the
// roster to re-read when this window comes back to the front, and a second raiser
// would double the reads for one focus.
//
// WHY THE STORE DECIDES WHICH COMPONENT RENDERS. The holder's hue comes from the
// session's own wheel, which lives on its store, and reading a store is a hook — so a
// window with that session closed cannot call it at all. The branch is here, in the
// one place that holds both the reading and the store, and the arm without a store
// still renders the holder: an identifier with no colour is a smaller loss than a
// blank line where a holder belongs.
//
// AND IT OFFERS NOTHING. Taking and releasing the lease are the terminal deck's
// controls against the daemon that owns the lease record. This block reports the
// projection.

import type { ReactNode } from "react";

import type { ConsoleBridge } from "../../../bridge/index.js";
import { useNodeRosterObservation } from "../../../seats/index.js";
import type { SessionStore } from "../../../store/index.js";
import { controlHolderReadingOf } from "./control-holder-reading.js";
import { ControlHolderLine } from "./ControlHolderLine.js";
import { HeldControlHolderLine } from "./HeldControlHolderLine.js";

export function ControlHolderBlock(props: {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
  readonly sessionStore: SessionStore | undefined;
}): ReactNode {
  const observation = useNodeRosterObservation(props.bridge, props.sessionId);
  const reading = controlHolderReadingOf(observation);
  const { sessionStore } = props;

  return (
    <section
      className="meridian-settings-page__block meridian-control-holder-block"
      aria-label="Terminal control"
    >
      <h3 className="meridian-settings-page__block-title">Terminal control</h3>
      <p className="meridian-settings-page__aside">
        One participant at a time may write into the session&rsquo;s shared shell. Who that is reads
        the same as it does for every other member — the lease is the daemon&rsquo;s to grant and
        this page only reports it.
      </p>
      {reading.kind === "held" && sessionStore !== undefined ? (
        <HeldControlHolderLine participantId={reading.participantId} sessionStore={sessionStore} />
      ) : (
        <ControlHolderLine reading={reading} hueAssignment={undefined} />
      )}
    </section>
  );
}
