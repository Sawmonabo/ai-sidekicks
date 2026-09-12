// The sessions destination: what am I in the middle of, what is waiting on me, and
// the three ways work arrives — started here, joined, or imported.
//
// The all-sessions list answers "what am I in the middle of" in one screen, ordered
// so the thing you touched last is where you left it.
//
// WHAT THIS SURFACE MAY AND MAY NOT CLAIM
//
// Two sets answer "which sessions are there" and the surface offers their union.
// The node's directory comes from the growth port's `sessionList` read, which the
// fixture serves and the live bridge refuses; this window's own open sessions come
// from `SessionStoreRegistry`, the same source the auxiliary context picker reads —
// and from EVERY one of those stores, through `open-session-rows.ts`, rather than
// from the route's, which at this address is `undefined` and always will be.
// `session-directory-rows.ts` owns the merge and owns the decision that matters —
// which kind of nothing an empty list is — because that decision follows the READ
// and never the row count: a refused directory is `not-checked` ("nobody asked"), a
// served directory with no rows is `empty` ("the node answered, and it has none"),
// and a read still in flight is `not-loaded`.
//
// No lifecycle control is drawn: rename, archive, close, and reactivate are all
// unregistered, and an offered control with no wire behind it is the
// capability-claimed-but-not-implemented shape the design forbids — drawing it
// disabled is the same claim with a tooltip. The import IS drawn, and the difference
// is which kind of absence it renders: its two operations are on the growth slate and
// refuse by name, so a person who tries it is told nothing was asked and who owes the
// wire, rather than being shown a control that quietly does nothing.
//
// WHILE THIS WINDOW IS NOT FOLLOWING THE DAEMON the list still renders — a stale list
// a person can read beats an empty one — labeled as the last read, and both writes are
// refused with the cause named. `session-list-degradation.ts` composes both sentences
// from the store's own fold, so the disabled control and the line explaining it cannot
// disagree.
//
// AND WHILE THE SHELL ITSELF CANNOT BE WRITTEN TO, the same thing happens for a
// different reason. The two causes are separate facts — a lost stream is this window's,
// a reconnecting or stopped supervisor is the shell's — and the shell's is the stronger
// one, so it is the sentence a control carries when both stand. Neither cause is
// derived here: `store/shell/shell-state.ts` owns the one that is the shell's, which is what
// keeps this destination's disabled controls and the palette's read-only line from
// naming two different reasons for one state, and `acts/session-act-block.ts` owns the
// ranking — for every act on this destination, the composed draft's Send included,
// which is what stopped that control being the one affordance still live through an
// outage. Every act here is a WRITE, so the whole-window derivation answers for all of
// them, and each is guarded again at DISPATCH: a block can land in the frame between
// the render that enabled a control and the press that reaches its handler.
//
// THE DAEMON'S OWN LIFECYCLE CONTROLS ARE NOT ON THIS RULE, and must not be: stopping
// and restarting the local runtime are how a stopped shell is recovered, and they are
// shell acts rather than daemon calls. Blocking them because the shell is stopped would
// close the only way back. `frame/shell-state/shell-status-binding.ts` says the same
// thing from the side that performs one.
//
// STARTING A SESSION IS AN ACT, NEVER A SIDE EFFECT OF LOOKING AT THE LIST
//
// `session.create` and `session.join` are live now, and one pre-console
// component already calls them — from its MOUNT EFFECT. Mounting that component
// with the surface would mean every navigation to Settings and back created a
// session, because the route lifecycle remounts the slot. A session is a durable
// object with a cost; creating one is something a person does.
//
// So the probe is built only when the start control is pressed, and the press
// count keys the mount: a second press remounts and therefore starts a second
// session, where a boolean would leave the first mount in place and make the
// control silently inert after its first use. The probe still performs the create —
// the console absorbs the three pre-console components and re-authors none of
// them, and `renderAbsorbedSessionProbe` carries the fixture guard, so this file
// never has to know that the probe reads the installed bridge directly.
//
// WHAT CHANGED IS THAT THE CONSOLE NOW HEARS THE RESULT. Counting presses was all
// this surface could do while the probe handed its settlement to nobody: the session
// a press produced had a name no console surface could learn, so the start path
// opened no store, recorded no origin, and navigated nowhere, and the new session
// stayed absent from the all-sessions list until the window came down. The probe
// takes one additive, optional `onCreated` now, and `acts/session-start.ts` is what
// a settled create reaches.
//
// AND THE COMPOSED DRAFT REACHES THE SAME ACT, through the seat its two families meet
// on. It had the same defect for the same reason from the other side: a completed send
// published its report and named its session to nobody, so a composed session was as
// unreachable as a probed one. Both settle through `settleStartedSession` below, which
// is the one place this destination says what starting a session here produces.
//
// ONE ATTENTION READ FOR THE WHOLE WINDOW, AND THIS DESTINATION DOES NOT PERFORM IT.
// The notification center renders it and the list takes each row's severity from the
// same plane, so two reads would be two answers to "what needs me" and the row and the
// panel beside it would eventually disagree in front of a person who can see both at
// once. It moved OUT of this file onto the window's frame-lifetime binding seat,
// because the rail draws a count off the same read and a read mounted here ended the
// moment somebody navigated away — leaving the rail suppressed on a machine that was
// answering perfectly well. This surface consumes what the binding holds, and the
// node's directory rides along with it for the same reason: read here as well, it
// would be the same wire asked twice per window.
//
// NOTHING HERE MEMOISES ON THE CONTEXT. `ConsoleSurfaceContext` is composed fresh
// on every frame render, so a dependency array naming it memoises nothing — and an
// effect keyed on a value derived from it would re-fire forever, since its own
// `setState` produces the next render. Every dependency below is a STABLE
// identity: a store, the bridge, or a wire-verbatim string off the route.

import { useState } from "react";

import type { ConsoleSurfaceContext, NewSessionControlComponent } from "../seats/index.js";
import { NotificationCenter, useAttentionSettlementAnnouncement } from "./notifications/index.js";
import { InlineRefusal } from "../primitives/index.js";
import { absorbedSurfaceAsks, renderAbsorbedSessionProbe } from "../seats/index.js";
import { useOpenSessionIds } from "../store/index.js";
import { useOpenSessionProjection } from "./rows/open-session-rows.js";
import { useSessionPreferences } from "./rows/session-preferences.js";
import { sessionListDegradation } from "./session-list-degradation.js";
import { SessionActs } from "./acts/SessionActs.js";
import { useSessionActBlock } from "./acts/session-act-block.js";
import { sessionDestinationActs } from "./acts/session-destination-acts.js";
import {
  SESSION_CREATE_OUTSTANDING_SENTENCE,
  useSessionStartFlight,
} from "./acts/session-start-flight.js";
import { useSessionAttention } from "./SessionAttentionBinding.js";
import { useSessionPins } from "./rows/session-pins.js";
import { SessionRowsView } from "./SessionRowsView.js";
import { type SessionRowsProps } from "./SessionRowsView.js";

export interface SessionsSurfaceProps {
  readonly context: ConsoleSurfaceContext;
  /**
   * The composed-session control, as the component this surface mounts every pass.
   *
   * The opposite of the start press below, and deliberately: the probe must not be
   * built until the press, because building it creates a session. This one owns its
   * own open state and creates nothing until its own send, so rebuilding it per press
   * would throw away whatever a person had chosen — mounting it on every render costs
   * nothing, because the component identity does not move and React reconciles it.
   *
   * THE COMPONENT AND NOT A BUILT NODE, because two of its props are this surface's:
   * the bridge it composes against, and the settlement a completed send is handed to.
   * Built one layer up, at the registration, neither was reachable — which is how a
   * composed session came to be created and then left unnamed.
   */
  readonly newSessionControl: NewSessionControlComponent;
}

export function SessionsSurface(props: SessionsSurfaceProps): React.JSX.Element {
  const { context } = props;
  const pins = useSessionPins(context.uiStateStore);
  const preferences = useSessionPreferences(context.uiStateStore);
  // The node's directory and the projection, from the window's binding rather than
  // from a read of this destination's own. Both used to be performed here, which made
  // them a DESTINATION's reads: the rail's count then stood only while a person was
  // looking at this screen, and the directory was read a second time on every window
  // that had this surface and the binding both. `SessionAttentionBinding.tsx` says the
  // rest; what matters here is that this surface has become a reader.
  const { directory, reading: attention, delivery, retry: retryAttention } = useSessionAttention();
  const windowSessionIds = useOpenSessionIds(context.sessionStoreRegistry);
  // Every open session's own projection, not the route's. This address names no
  // session, so `context.sessionStore` is `undefined` here for the life of the
  // surface — see `open-session-rows.ts` for what reading it cost. The route-scoped
  // store is still supplied and still read, by the surfaces mounted at addresses that
  // DO name one; this destination is simply not one of them.
  const openSessions = useOpenSessionProjection(context.sessionStoreRegistry);
  const projectedRows = openSessions.rows;
  // Whether this window is still following the daemon, and what that costs. The fold
  // rides the projection's own subscription rather than a second one, and both
  // sentences it produces are composed once from the cause — a control deciding for
  // itself whether it is allowed would be a second source of truth for the store's
  // fact. The line above the list is read here; the half every control carries is
  // `acts/session-act-block.ts`, which ranks it against the shell's own cause.
  const degradation = sessionListDegradation(openSessions.degradedCause);
  // Said once per settlement, here rather than inside the center: this destination is
  // where the read lives, and the center is handed a reading and mounted in two other
  // harnesses that render it with no announcer above them. The panel draws the same
  // read for everyone who can see it — this is the half for everyone who cannot.
  useAttentionSettlementAnnouncement(attention);
  // Whether a banner raised from this read would reach anyone, from the binding that
  // took the reading. Advisory: it changes what the centre SAYS and never whether the
  // shell is asked, because the OS is the authority on delivery and a reading this
  // console could not obtain would otherwise silence every notification on every host
  // whose permission it cannot read. The EMISSION is the binding's — a banner exists
  // for someone who is looking elsewhere, so mounting the emitter on this destination
  // meant the one surface it could never reach was every other screen.
  // Counts ADMITTED presses rather than every press, so the built node can be keyed
  // on it: a second admitted press remounts and therefore starts a second session,
  // and the flight below is what decides which presses are admitted at all.
  const [startRequestCount, setStartRequestCount] = useState(0);
  // One create at a time. `acts/session-start-flight.ts` says why the press count
  // could not carry that on its own — a second press while the first create was
  // running remounted the probe, suppressed its settlement, and left a durable session
  // nothing could name. The predicate is the seat's own: under the fixture the probe
  // dispatches nothing and settles never, so there is no act to single-flight.
  const startFlight = useSessionStartFlight(
    context.bridge,
    absorbedSurfaceAsks(context.bridge.source),
  );

  // Why no act may be put, and why the start act alone may not — one reading, asked at
  // render for the affordances and again at dispatch for the guards behind them.
  const actBlock = useSessionActBlock({
    frameStore: context.frameStore,
    degradedCause: openSessions.degradedCause,
    readDegradedCause: openSessions.readDegradedCause,
    startOutstandingSentence: startFlight.isOutstanding
      ? SESSION_CREATE_OUTSTANDING_SENTENCE
      : undefined,
  });

  // Every act a press on this destination performs, bound to the context above.
  // `acts/session-destination-acts.ts` owns what each one DOES; this file owns where
  // they are drawn and what closes them.
  const { openSession, openAttentionItem, settleStartedSession, recheckSessionDirectory } =
    sessionDestinationActs(context);

  // Both ways to have a session, offered together in the one place the list draws a
  // control: compose one, or take one of the acts this family owns. The composed draft
  // is a NODE and not a press, and deliberately: the acts row builds its start on the
  // press because what it mounts creates a session, while this one owns its own open
  // state and creates nothing until its own send — so rebuilding it per press would
  // throw away whatever a person had chosen.
  const ComposedNewSession = props.newSessionControl;
  const startControl = (
    <>
      <ComposedNewSession
        bridge={context.bridge}
        blockedAct={actBlock.act}
        onSessionCreated={settleStartedSession}
        onSessionDirectoryRecheck={recheckSessionDirectory}
      />
      <SessionActs
        bridge={context.bridge}
        preferences={preferences}
        onStart={() => {
          // Fail-closed at the dispatch site, not only on the control. The button is
          // disabled from the same sentence, so this is the guard rather than the
          // affordance: an enable predicate is a projection of the rule and a press that
          // reached here anyway must still put nothing, because what it mounts creates a
          // session from its own mount effect.
          if (actBlock.act.readSentence() !== undefined) {
            return;
          }
          // And the same rule for the act that is already running, decided by taking the
          // key rather than by reading the flag this render was built from: two presses
          // in one frame both find `isOutstanding` false, and only the register can tell
          // them apart.
          if (!startFlight.admit()) {
            return;
          }
          setStartRequestCount((previous) => previous + 1);
        }}
        blockedReason={actBlock.act.sentence}
        startBlockedReason={actBlock.startBlockedSentence}
      />
    </>
  );

  const listProps: SessionRowsProps = {
    directory,
    windowSessionIds,
    projectedRows,
    attention,
    pins,
    startControl,
    onOpen: openSession,
  };

  return (
    <section className="meridian-sessions" aria-label="Sessions">
      <header className="meridian-sessions__head">
        <h1 className="meridian-sessions__title">Sessions</h1>
        <p className="meridian-sessions__lede">
          The sessions this node reports, and the ones this window has open. The directory read sits
          on the growth slate — where it is refused, this list is only what this window holds, and
          says so.
        </p>
      </header>

      <div className="meridian-sessions__body">
        <div className="meridian-sessions__list" aria-label="Sessions on this node">
          {degradation.lastReadSentence === undefined ? null : (
            <p className="meridian-sessions__degraded" role="status">
              {degradation.lastReadSentence}
            </p>
          )}
          {pins.lastRefusal === undefined ? null : <InlineRefusal {...pins.lastRefusal} />}
          <SessionRowsView {...listProps} />
        </div>

        <aside className="meridian-sessions__aside" aria-label="What is waiting on you">
          <NotificationCenter
            reading={attention}
            delivery={delivery}
            onOpen={openAttentionItem}
            onReopen={retryAttention}
          />
        </aside>
      </div>

      {startRequestCount === 0 ? null : (
        <div className="meridian-sessions__started" key={startRequestCount}>
          {renderAbsorbedSessionProbe(context.bridge.source, {
            onCreated: (created) => {
              // A SETTLED create and never the press, on the settled join's own terms
              // one screen up. The probe is the only `session.create` caller in this
              // renderer and it now hands the session out, so this destination stops
              // counting presses and starts acting on the session a press produced.
              settleStartedSession(created.sessionId);
            },
            // The act is over, whichever way it went. Released here rather than beside
            // the create above, because a refused create ends the act just as
            // completely and a slot that only a success gives back leaves Start dead.
            onSettled: startFlight.settle,
          })}
        </div>
      )}
    </section>
  );
}
