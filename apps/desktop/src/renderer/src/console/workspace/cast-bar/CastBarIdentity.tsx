// What session this is: the short id, the display title where one exists, and the
// state chip.
//
// THE THREE ARE ONE ANSWER AND ONE READ. `Spec-023 §The four bars` puts the session
// identity at the head of the cast bar, and `Spec-023 §Console Design (Meridian)`
// fixes what a nameless session renders as: "by its identifier and participants,
// never by an invented title". So the id is unconditional and in mono, the title is
// rendered when the read carries one, and the state is the wire's own word.
//
// THE TWO RULES THAT WERE WRITTEN HERE MOVED WITH THEIR COMPONENTS. What a nameless
// session renders, and why a wire word is a mono chip rather than prose, are each
// stated in the module that obeys them — `CastBarSessionTitle.tsx` and
// `CastBarSessionState.tsx`. This module arranges the three and decides nothing.

import { type GrowthSessionSummary } from "../../bridge/index.js";
import { Nothing, WireFigure } from "../../primitives/index.js";
import { type CastBarReadState } from "./cast-bar-reads.js";
import { CastBarSessionState } from "./CastBarSessionState.js";
import { CastBarSessionTitle } from "./CastBarSessionTitle.js";

export interface CastBarIdentityProps {
  /** `undefined` on a route that names no session — rendered as an absence. */
  readonly sessionId: string | undefined;
  /** The identity read, which is `reading` for as long as there is nothing to read. */
  readonly identity: CastBarReadState<GrowthSessionSummary>;
}

export function CastBarIdentity(props: CastBarIdentityProps): React.JSX.Element {
  return (
    <span className="meridian-cast-bar__identity">
      {props.sessionId === undefined ? (
        <Nothing kind="empty" title="No session" />
      ) : (
        <>
          <WireFigure value={props.sessionId} title="Session id" />
          <CastBarSessionTitle identity={props.identity} />
          <CastBarSessionState identity={props.identity} />
        </>
      )}
    </span>
  );
}
