// The cast bar: everyone in the session, and what each of them is doing.
//
// `Spec-023 §The surface set`: the cast bar "shows every participant as a live chip —
// hue ring, name, presence glyph, terminal-lease glyph where held, and a present-tense
// verb derived client-side from that participant's newest timeline row and liveness
// alone — up to eight chips then "+N", with an all-clear line when nothing is amber or
// red". THAT EACH CHIP IS ALSO A WAY TO FOLLOW ITS ACTOR is this console's own rule,
// because no committed document states it; the act itself lives in
// `workspace/actor-follow.ts`, which is where the rule is written down.
//
// WHAT IT RENDERS AND WHAT IT REFUSES TO. The identity, the six-value session state
// verbatim, one chip per participant in join-log order, the fold to "+N" past the
// chip cap, and the all-clear line. It renders no verb it did not derive from a
// registered event kind, no colour that means urgency (the hue answers "who", and
// amber and red live on the rows), and no spend figure of its own — the receipt's
// value or nothing.
//
// THREE THINGS THE DESIGN NAMES THAT THE WIRE DOES NOT HAVE, rendered as absences
// rather than invented:
//
//   • **Liveness.** `@ai-sidekicks/contracts` registers four presence states and a
//     read that carries them, but nothing in the console subscribes to one yet and
//     the growth port has no presence operation. So the presence glyph renders the
//     "not checked" kind of nothing rather than a green dot nobody measured.
//   • **The terminal lease.** No `controlHolder` member is registered anywhere in
//     the contracts package, so no lease glyph is drawn.
//   • **The committed spend.** The cost receipt is not a wire the console has. The
//     all-clear line therefore ends at its sentence, and the figure's absence is
//     drawn as an absence.
//
// The bar is one line and every verb truncates to one clause, which is a CSS
// property here rather than a string operation: truncating in JavaScript would put a
// wire-derived string through a transformation the figure rules forbid.

import { Nothing, WireFigure } from "../primitives/index.js";
import { type SessionStore } from "../store/index.js";
import { CastBarBody } from "./CastBarBody.js";

export interface CastBarProps {
  /** `undefined` on a route that names no session — rendered as an absence. */
  readonly sessionId: string | undefined;
  /** `undefined` while the session's store has not opened — the loading arm. */
  readonly sessionStore: SessionStore | undefined;
  /** Follow this actor: focus their pane, scroll the ledger to their latest row. */
  readonly onFollow: (participantId: string) => void;
  /** Open the members section. Absent, the "+N" fold renders as a count only. */
  readonly onShowMembers?: () => void;
}

export function CastBar(props: CastBarProps): React.JSX.Element {
  return (
    <header className="meridian-cast-bar" aria-label="Session cast">
      <span className="meridian-cast-bar__identity">
        {/* A display title would come from `SessionSnapshot.metadata`, which no wire
            the console holds carries — so the identity is the short id alone, in mono.
            `Spec-023 §The surface set` fixes that disposition for the sessions list and
            it holds here: a session with no name "renders by its identifier and
            participants, never by an invented title". */}
        {props.sessionId === undefined ? (
          <Nothing kind="empty" title="No session" />
        ) : (
          <WireFigure value={props.sessionId} title="Session id" />
        )}
      </span>
      {props.sessionStore === undefined ? (
        <Nothing kind="not-loaded" title="This session is opening." />
      ) : (
        <CastBarBody
          sessionStore={props.sessionStore}
          onFollow={props.onFollow}
          {...(props.onShowMembers === undefined ? {} : { onShowMembers: props.onShowMembers })}
        />
      )}
    </header>
  );
}
