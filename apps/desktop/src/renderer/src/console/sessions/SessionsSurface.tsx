// The sessions destination: what am I in the middle of, what is waiting on me, and
// the one way to start something new.
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
// disabled is the same claim with a tooltip.
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
import { useSessionDirectory } from "../frame/session-directory.js";
import { renderAbsorbedSessionProbe } from "../frame/legacy-surfaces.js";
import type { ConsoleSurfaceContext } from "../frame/surface-registry.js";
import { consoleClockFor, type GrowthPort } from "../bridge/index.js";
import {
  NotificationCenter,
  attentionProjectionReaderFor,
  useAttentionProjection,
  useAttentionSettlementAnnouncement,
} from "./notifications/index.js";
import { InlineRefusal } from "../primitives/index.js";
import { useOpenSessionIds } from "../store/index.js";
import { InviteShelf, type InviteShelfReader } from "./invitations/InviteShelf.js";
import { useOpenSessionRows } from "./rows/open-session-rows.js";
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
  const directory = useSessionDirectory(context.bridge.growth);
  const windowSessionIds = useOpenSessionIds(context.sessionStoreRegistry);
  // Every open session's own projection, not the route's. This address names no
  // session, so `context.sessionStore` is `undefined` here for the life of the
  // surface — see `open-session-rows.ts` for what reading it cost. The route-scoped
  // store is still supplied and still read, by the surfaces mounted at addresses that
  // DO name one; this destination is simply not one of them.
  const projectedRows = useOpenSessionRows(context.sessionStoreRegistry);
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
  const attention = useAttentionProjection(
    useMemo(
      () => attentionProjectionReaderFor(context.bridge.growth, attentionSessionIds),
      [context.bridge.growth, attentionSessionIds],
    ),
    context.bridge,
    context.sessionStoreRegistry,
  );
  // Said once per settlement, here rather than inside the center: this destination is
  // where the read lives, and the center is handed a reading and mounted in two other
  // harnesses that render it with no announcer above them. The panel draws the same
  // read for everyone who can see it — this is the half for everyone who cannot.
  useAttentionSettlementAnnouncement(attention);
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
  // screenshot's expiry thresholds are byte-stable. Resolved once off the bridge
  // rather than on every render: a fresh instance would cancel and re-arm the
  // shelf's timer every pass.
  const shelfClock = useMemo(() => consoleClockFor(context.bridge), [context.bridge]);

  const startControl = (
    <button
      type="button"
      className="meridian-sessions__start"
      onClick={() => {
        setStartRequestCount((previous) => previous + 1);
      }}
    >
      Start a session
    </button>
  );

  const listProps: SessionRowsProps = {
    directory,
    windowSessionIds,
    projectedRows,
    attention,
    pins,
    startControl,
    onOpen: (sessionId: string): void => {
      context.frameStore.navigate({ kind: "workspace", sessionId });
    },
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
          {pins.lastRefusal === undefined ? null : <InlineRefusal {...pins.lastRefusal} />}
          <SessionRowsView {...listProps} />
        </div>

        <aside className="meridian-sessions__aside" aria-label="What is waiting on you">
          <InviteShelf read={readInvites} uiStateStore={context.uiStateStore} clock={shelfClock} />
          <NotificationCenter reading={attention} />
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
