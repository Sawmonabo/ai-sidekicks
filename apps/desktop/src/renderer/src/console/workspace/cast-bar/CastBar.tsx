// The cast bar: everyone in the session, and what each of them is doing.
//
// `Spec-023 §The surface set`: the cast bar "shows every participant as a live chip —
// hue ring, name, presence glyph, terminal-lease glyph where held, and a present-tense
// verb derived client-side from that participant's newest timeline row and liveness
// alone — up to eight chips then "+N", with an all-clear line when nothing is amber or
// red". THAT EACH CHIP IS ALSO A WAY TO FOLLOW ITS ACTOR is this console's own rule,
// because no committed document states it; the act itself lives in
// `workspace/cast-bar/actor-follow.ts`, which is where the rule is written down.
//
// WHAT IT RENDERS AND WHAT IT REFUSES TO. The identity — short id, display title where
// the session has one, and the six-value session state verbatim — the node's health in
// its compact form, one chip per participant in join-log order, the fold to "+N" past
// the chip cap, and the all-clear line with the accountant's own committed figure. It
// renders no verb it did not derive from a registered event kind, no colour on a chip
// that means urgency (the hue answers "who", and amber and red live on the rows and on
// the one health mark), and no spend figure of its own — the accountant's value or an
// absence.
//
// THIS SURFACE IS THREE READS AND A STORE, AND THEY ANSWER DIFFERENT QUESTIONS. The
// store answers what the LOG says — who joined, what they did, when. The identity, the
// health, and the spend are none of those: two are projections the daemon serves and
// one is a measurement, so each is a read, put once per session through the console's
// single growth-read chokepoint. They are put HERE rather than in the body below
// because the body is mounted only once the session's store has opened, and a session
// that is still opening still has an identity worth naming.
//
// TWO THINGS THE DESIGN NAMES THAT THE WIRE STILL DOES NOT HAVE, rendered as absences
// rather than invented:
//
//   • **Liveness.** `@ai-sidekicks/contracts` registers four presence states and a
//     read that carries them, but nothing in the console subscribes to one yet and
//     the growth port has no presence operation. So the presence glyph renders the
//     "not checked" kind of nothing rather than a green dot nobody measured.
//   • **The terminal lease.** No `controlHolder` member is registered anywhere in
//     the contracts package, so no lease glyph is drawn.
//
// AND ONE THE FRAME OWNS RATHER THAN THIS BAR. A version-compatibility banner has no
// surface anywhere in this console yet, and the two banner stacks that DO exist — the
// frame's own and the workspace's — both render in this same column, immediately above
// this bar and always visible beside it. A compact mark here would therefore be the
// same sentence twice on one screen, which rule 9 does not ask for: it assigns a
// refusal ONE shape by what it changed, and it changed what the whole room can do,
// which is the banner the row above already draws.
//
// The bar is one line and every verb truncates to one clause, which is a CSS
// property here rather than a string operation: truncating in JavaScript would put a
// wire-derived string through a transformation the figure rules forbid.

import { type SessionStore } from "../../store/index.js";
import { CastBarBody } from "./CastBarBody.js";
import { CastBarIdentity } from "./CastBarIdentity.js";
import { CastBarSkeleton } from "./CastBarSkeleton.js";
import { CastBarStatus } from "./CastBarStatus.js";
import {
  useCastBarGrowthPort,
  useCastBarHealth,
  useCastBarIdentity,
  useCastBarSpend,
} from "./cast-bar-readings.js";

export interface CastBarProps {
  /** `undefined` on a route that names no session — rendered as an absence. */
  readonly sessionId: string | undefined;
  /** `undefined` while the session's store has not opened — the loading arm. */
  readonly sessionStore: SessionStore | undefined;
  /**
   * How many members the caller was told this session has, for the loading arm only.
   *
   * `CastBarSkeleton.tsx` owns what this is for and why it is a hint rather than a
   * promise. It is read at no other time: once the store is open the members come
   * from the join log, which is the log's own answer and not a remembered one.
   */
  readonly expectedMemberCount?: number | undefined;
  /** Follow this actor: focus their pane, scroll the ledger to their latest row. */
  readonly onFollow: (participantId: string) => void;
  /** Open the members section. Absent, the "+N" fold renders as a count only. */
  readonly onShowMembers?: () => void;
}

export function CastBar(props: CastBarProps): React.JSX.Element {
  const growth = useCastBarGrowthPort();
  const identity = useCastBarIdentity(growth, props.sessionId);
  const health = useCastBarHealth(growth, props.sessionId);
  const spend = useCastBarSpend(growth, props.sessionId);

  return (
    <header className="meridian-cast-bar" aria-label="Session cast">
      <CastBarIdentity sessionId={props.sessionId} identity={identity} />
      <CastBarStatus health={health} />
      {props.sessionStore === undefined ? (
        <CastBarSkeleton expectedMemberCount={props.expectedMemberCount} />
      ) : (
        <CastBarBody
          sessionStore={props.sessionStore}
          spend={spend}
          onFollow={props.onFollow}
          {...(props.onShowMembers === undefined ? {} : { onShowMembers: props.onShowMembers })}
        />
      )}
    </header>
  );
}
