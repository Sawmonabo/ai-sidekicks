// The session header: which session this is, how its machine is, and what it has cost.
//
// WHAT IT RENDERS AND WHAT IT REFUSES TO. The identity — short id, display title where
// the session has one, and the session state verbatim — the node's health in its
// compact form, whatever is still waiting on an answer, and the accountant's own
// committed figure. It renders no spend figure of its own: the accountant's value or an
// absence.
//
// THIS SURFACE IS THREE READS AND A STORE, AND THEY ANSWER DIFFERENT QUESTIONS. The
// store answers what the LOG says — what happened, and when. The identity, the health,
// and the spend are none of those: two are projections the daemon serves and one is a
// measurement, so each is a read, put once per session through the console's single
// growth-read chokepoint. They are put HERE rather than in the body below because the
// body is mounted only once the session's store has opened, and a session that is still
// opening still has an identity worth naming.
//
// AND ONE THING THE FRAME OWNS RATHER THAN THIS HEADER. A version-compatibility banner
// has no surface anywhere in this console yet, and the two banner stacks that DO exist —
// the frame's own and the workspace's — both render in this same column, immediately
// above this header and always visible beside it. A compact mark here would therefore be
// the same sentence twice on one screen, which the refusal grammar does not ask for:
// it assigns a refusal ONE shape by what it changed, and it changed what the whole
// session can do,
// which is the banner the row above already draws.
//
// The header is one line and every clause truncates, which is a CSS property here rather
// than a string operation: truncating in JavaScript would put a wire-derived string
// through a transformation the figure rules forbid.

import { type SessionStore } from "../../store/index.js";
import { CastBarBody } from "./CastBarBody.js";
import { CastBarIdentity } from "./identity/CastBarIdentity.js";
import { CastBarSkeleton } from "./CastBarSkeleton.js";
import { CastBarStatus } from "./CastBarStatus.js";
import {
  useCastBarGrowthPort,
  useCastBarHealth,
  useCastBarIdentity,
  useCastBarSpend,
} from "./model/cast-bar-readings.js";

export interface CastBarProps {
  /** `undefined` on a route that names no session — rendered as an absence. */
  readonly sessionId: string | undefined;
  /** `undefined` while the session's store has not opened — the loading arm. */
  readonly sessionStore: SessionStore | undefined;
}

export function CastBar(props: CastBarProps): React.JSX.Element {
  const growth = useCastBarGrowthPort();
  const identity = useCastBarIdentity(growth, props.sessionId);
  const healthVerdict = useCastBarHealth(growth, props.sessionId);
  const spend = useCastBarSpend(growth, props.sessionId);

  return (
    <header className="meridian-cast-bar" aria-label="Session">
      <CastBarIdentity sessionId={props.sessionId} identity={identity} />
      <CastBarStatus verdict={healthVerdict} />
      {props.sessionStore === undefined ? (
        <CastBarSkeleton />
      ) : (
        <CastBarBody
          sessionStore={props.sessionStore}
          spend={spend}
          // The one place the verdict becomes the all-clear's conjunct, so the mark
          // above and the line below are two readings of one value rather than two
          // derivations that can disagree.
          isNodeHealthUnwell={healthVerdict.kind === "unwell"}
        />
      )}
    </header>
  );
}
