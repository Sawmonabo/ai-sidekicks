// The sessions destination: what am I in the middle of, what is waiting on me, and
// the three ways work arrives — started here, joined, or imported.
//
// `Spec-023 §Console Design (Meridian)` §All-sessions list: "Answer 'what am I in
// the middle of' in one screen, ordered so the thing you touched last is where you
// left it."
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
// STARTING A SESSION IS AN ACT, NEVER A SIDE EFFECT OF LOOKING AT THE LIST
//
// `session.create` and `session.join` are live now, and one shipped Tier-1
// component already calls them — from its MOUNT EFFECT. Mounting that component
// with the surface would mean every navigation to Settings and back created a
// session, because the route lifecycle remounts the slot. A session is a durable
// object with a cost; creating one is something a person does.
//
// So the probe is built only when the start control is pressed, and the press
// count keys the mount: a second press remounts and therefore starts a second
// session, where a boolean would leave the first mount in place and make the
// control silently inert after its first use. The probe itself is untouched — the
// console absorbs the three shipped Tier-1 components and re-authors none of them,
// and `renderAbsorbedSessionProbe` carries the fixture guard, so this file never
// has to know that the probe reads the installed bridge directly.
//
// ONE ATTENTION READ FOR THE WHOLE DESTINATION. The notification center renders it
// and the list takes each row's severity from the same plane. Two reads would be
// two answers to "what needs me", and the row and the panel beside it would
// eventually disagree in front of a person who can see both at once.
//
// NOTHING HERE MEMOISES ON THE CONTEXT. `ConsoleSurfaceContext` is composed fresh
// on every frame render, so a dependency array naming it memoises nothing — and an
// effect keyed on a value derived from it would re-fire forever, since its own
// `setState` produces the next render. Every dependency below is a STABLE
// identity: a store, the bridge, or a wire-verbatim string off the route.

import { useMemo, useState } from "react";

import type { ConsoleSurfaceContext } from "../seats/index.js";
import { useConsoleClock, type AttentionItem, type GrowthPort } from "../bridge/index.js";
import {
  NotificationCenter,
  attentionProjectionReaderFor,
  useAttentionNotifications,
  useAttentionProjection,
  useRailAttentionPublisher,
  useAttentionSettlementAnnouncement,
  useOsNotificationDelivery,
} from "./notifications/index.js";
import { InlineRefusal } from "../primitives/index.js";
import { renderAbsorbedSessionProbe, useSessionDirectory } from "../seats/index.js";
import { useOpenSessionIds } from "../store/index.js";
import { InviteShelf, type InviteShelfReader } from "./invitations/InviteShelf.js";
import { useOpenSessionProjection } from "./rows/open-session-rows.js";
import { useSessionPreferences } from "./rows/session-preferences.js";
import { sessionListDegradation } from "./session-list-degradation.js";
import { SessionActs } from "./acts/SessionActs.js";
import { mergeSessionRows } from "./rows/session-directory-rows.js";
import { useSessionPins } from "./rows/session-pins.js";
import type { SessionListRow } from "./rows/session-rows.js";
import { SessionRowsView } from "./SessionRowsView.js";
import { type SessionRowsProps } from "./SessionRowsView.js";

export interface SessionsSurfaceProps {
  readonly context: ConsoleSurfaceContext;
}

export function SessionsSurface(props: SessionsSurfaceProps): React.JSX.Element {
  const { context } = props;
  const pins = useSessionPins(context.uiStateStore);
  const preferences = useSessionPreferences(context.uiStateStore);
  const directory = useSessionDirectory(context.bridge.growth);
  const windowSessionIds = useOpenSessionIds(context.sessionStoreRegistry);
  // Every open session's own projection, not the route's. This address names no
  // session, so `context.sessionStore` is `undefined` here for the life of the
  // surface — see `open-session-rows.ts` for what reading it cost. The route-scoped
  // store is still supplied and still read, by the surfaces mounted at addresses that
  // DO name one; this destination is simply not one of them.
  const openSessions = useOpenSessionProjection(context.sessionStoreRegistry);
  const projectedRows = openSessions.rows;
  // Whether this window is still following the daemon, and what that costs. The fold
  // rides the projection's own subscription rather than a second one, and the two
  // sentences are composed once from the cause — a control deciding for itself
  // whether it is allowed would be a second source of truth for the store's fact.
  const degradation = sessionListDegradation(openSessions.degradedCause);
  // The attention read is scoped to a session on the wire and this destination is
  // not, so it asks about every session the surface can NAME — the same set the
  // list is built from, derived here with no projected rows because the ids are all
  // this needs. Memoised on the merged ids rather than on the directory object, so
  // the read fires once when the directory settles and not again on every render
  // the surface performs afterwards.
  const attentionSessionIds = useMemo(
    () => mergeSessionRows({ directory, windowSessionIds, projectedRows: [] }).map(sessionIdOf),
    [directory, windowSessionIds],
  );
  const attentionProjection = useAttentionProjection(
    useMemo(
      () => attentionProjectionReaderFor(context.bridge.growth, attentionSessionIds),
      [context.bridge.growth, attentionSessionIds],
    ),
    context.sessionStoreRegistry,
  );
  const attention = attentionProjection.reading;
  // Said once per settlement, here rather than inside the center: this destination is
  // where the read lives, and the center is handed a reading and mounted in two other
  // harnesses that render it with no announcer above them. The panel draws the same
  // read for everyone who can see it — this is the half for everyone who cannot.
  useAttentionSettlementAnnouncement(attention);
  // Whether a banner raised from this read would reach anyone. Advisory: it changes
  // what the centre SAYS and never whether the shell is asked, because the OS is the
  // authority on delivery and a reading this console could not obtain would otherwise
  // silence every notification on every host whose permission it cannot read.
  const delivery = useOsNotificationDelivery(context.bridge.growth);
  // The destination is where the read lives, so it is where the emission belongs: the
  // centre is handed a reading and mounted in harnesses that hold none, and an
  // emitter inside it would announce a projection twice on any surface that rendered
  // two centres.
  useAttentionNotifications({
    reading: attention,
    delivery,
    frameStore: context.frameStore,
    bridge: context.bridge,
  });
  // The rail's count, published from this read for as long as it is mounted.
  useRailAttentionPublisher(context.frameStore, attention);
  // Counts presses rather than recording a boolean, so the built node can be keyed
  // on it: a second press remounts and therefore starts a second session.
  const [startRequestCount, setStartRequestCount] = useState(0);

  // The invites read is scoped to one session on the wire and this destination is
  // not, so it fans out over THE SAME session set the attention read asks about —
  // the one `attentionSessionIds` already merged. Keyed on the route's session
  // instead, this read asked about nothing at all: every address that mounts this
  // surface is `kind: "sessions"` and names no session, so the projection was always
  // `undefined` and every invitation the console could name was reported unasked.
  //
  // An empty set stays an empty fan-out, and the shelf renders "nothing was asked"
  // rather than an empty inbox. Each session's outcome travels on its own, so one
  // session's refusal cannot hide another's answer — the shelf merges them and
  // reports a refusal only when nothing at all was served.
  const { growth } = context.bridge;
  const readInvites = useMemo<InviteShelfReader>(
    () => inviteShelfReaderFor(growth, attentionSessionIds),
    [growth, attentionSessionIds],
  );

  // The shelf arms one wake-up per outstanding invitation expiry, so it needs the
  // clock this window runs on — the scenario's frozen one under the fixture, so a
  // screenshot's expiry thresholds are byte-stable.
  //
  // Through the window's own clock hook rather than a memo of this surface's. The
  // live arm of `consoleClockFor` MINTS, so its result is identity-unstable by
  // construction, and a memo is a hint React is free to discard — which would hand
  // the shelf a new clock identity on a pass the bridge never moved on, and
  // `useDeadlineWake` takes the clock as its SUBJECT, so a re-minted one re-seeds the
  // held instant. The hook pins the resolution in state, which is where a resource
  // identity belongs.
  const shelfClock = useConsoleClock();

  // Both navigations are the same act — open the session this thing belongs to — and
  // they are declared together so neither surface can drift into a second answer for
  // "where does pressing this go". An attention item resolves nothing by being
  // opened: `Spec-019 §Required Behavior` puts resolution in the daemon, and the
  // centre offers no dismiss precisely because a client-side one would be a heuristic
  // standing in for it.
  const openSession = sessionOpenerFor(context.frameStore);
  const openAttentionItem = (item: AttentionItem): void => {
    openSession(item.sessionId);
  };

  const startControl = (
    <SessionActs
      bridge={context.bridge}
      preferences={preferences}
      onStart={() => {
        setStartRequestCount((previous) => previous + 1);
      }}
      onJoined={openSession}
      blockedReason={degradation.blockedActSentence}
    />
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
          <InviteShelf read={readInvites} uiStateStore={context.uiStateStore} clock={shelfClock} />
          <NotificationCenter
            reading={attention}
            delivery={delivery}
            onOpen={openAttentionItem}
            onReopen={attentionProjection.retry}
          />
        </aside>
      </div>

      {startRequestCount === 0 ? null : (
        <div className="meridian-sessions__started" key={startRequestCount}>
          {renderAbsorbedSessionProbe(context.bridge.source)}
        </div>
      )}
    </section>
  );
}

/**
 * The invitations read, fanned out over the sessions this destination can name.
 *
 * The mirror of `attentionProjectionReaderFor`, and deliberately its shape: both
 * wires are session-scoped, this destination is not, both are asked about the same
 * merged set, and both carry every session's outcome rather than only the served
 * ones — so each surface can tell a refused read from an empty answer for itself.
 *
 * An empty set answers an empty array rather than a refusal: nothing was asked, and
 * the shelf has its own sentence for that.
 */
function inviteShelfReaderFor(
  growth: GrowthPort,
  sessionIds: readonly string[],
): InviteShelfReader {
  return async () =>
    await Promise.all(sessionIds.map(async (sessionId) => await growth.invitesList({ sessionId })));
}

/**
 * The navigation both surfaces perform, bound to one frame store.
 *
 * Module-level and NOT a `useCallback`, on the rule `sessionIdOf` below already
 * states: a mount-lifetime cell naming a session is the shape the console holds
 * through its one subject-keyed holder, so a callback capturing a session id is the
 * shape a reader — and `test/console/architecture/subject-state-chokepoint.test.ts` —
 * has to stop and check. Nothing here needs a stable identity either: both consumers
 * are rendered by this surface on every pass regardless.
 */
function sessionOpenerFor(
  frameStore: ConsoleSurfaceContext["frameStore"],
): (sessionId: string) => void {
  return (sessionId: string): void => {
    frameStore.navigate({ kind: "workspace", sessionId });
  };
}

/**
 * One row's session id.
 *
 * Module-level rather than a lambda inside the memo below, and the reason is a rule
 * rather than a preference: a mount-lifetime cell naming a session is the shape the
 * console holds through its one holder, so a cell whose body writes the word for a
 * reason of its own is the shape a reader — and the tripwire — has to stop and check.
 */
function sessionIdOf(row: SessionListRow): string {
  return row.sessionId;
}
