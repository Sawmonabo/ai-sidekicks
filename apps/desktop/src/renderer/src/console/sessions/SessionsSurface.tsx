// The sessions destination: what am I in the middle of, what is waiting on me, and
// the one way to start something new.
//
// `Spec-023 §Console Design (Meridian)` §All-sessions list: "Answer 'what am I in
// the middle of' in one screen, ordered so the thing you touched last is where you
// left it."
//
// WHAT THIS SURFACE MAY AND MAY NOT CLAIM
//
// There is no session-enumeration verb on any transport — the item sits on the
// growth slate beside the rename, archive, close, and reactivate verbs, which are
// likewise unregistered. So the list is composed from the sessions THIS CONSOLE
// ALREADY HOLDS REFERENCES TO, and its empty state says exactly that rather than
// implying it swept the daemon and found nothing. That distinction is the whole
// difference between "you have no sessions" and "this console has not asked", and
// the five kinds of nothing exist so the console never conflates them.
//
// For the same reason no lifecycle control is drawn: an offered control with no
// wire behind it is the capability-claimed-but-not-implemented shape the design
// forbids, and drawing it disabled is the same claim with a tooltip.
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

import { useMemo, useState, type ReactNode } from "react";

import { renderAbsorbedSessionProbe } from "../frame/legacy-surfaces.js";
import type { ConsoleSurfaceContext } from "../frame/surface-registry.js";
import {
  NotificationCenter,
  READS_NO_ATTENTION_PROJECTION,
  useAttentionProjection,
  type AttentionReading,
} from "../notifications/index.js";
import { DerivedFigure, InlineRefusal, Nothing, formatCount } from "../primitives/index.js";
import { useSessionPartition, type SessionStore } from "../store/index.js";
import { InviteShelf, type InviteShelfReader } from "./InviteShelf.js";
import { SessionList } from "./SessionList.js";
import { useSessionPins, type SessionPinBinding } from "./session-pins.js";
import type { SessionListRow } from "./session-rows.js";

export interface SessionsSurfaceProps {
  readonly context: ConsoleSurfaceContext;
}

export function SessionsSurface(props: SessionsSurfaceProps): React.JSX.Element {
  const { context } = props;
  const attention = useAttentionProjection(READS_NO_ATTENTION_PROJECTION);
  const pins = useSessionPins(context.uiStateStore);
  // Counts presses rather than recording a boolean, so the built node can be keyed
  // on it: a second press remounts and therefore starts a second session.
  const [startRequestCount, setStartRequestCount] = useState(0);

  // The invites read is scoped to one session and this address names none, so the
  // reader answers an empty fan-out and the shelf renders "nothing was asked"
  // rather than an empty inbox. `growth` and the identifier are both stable, so the
  // shelf's one-shot read fires once per mount.
  const { growth } = context.bridge;
  const activeSessionId = context.frameStore.activeSessionId;
  const readInvites = useMemo<InviteShelfReader>(
    () => () =>
      activeSessionId === undefined
        ? Promise.resolve([])
        : Promise.all([growth.invitesList({ sessionId: activeSessionId })]),
    [activeSessionId, growth],
  );

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

  return (
    <section className="meridian-sessions" aria-label="Sessions">
      <header className="meridian-sessions__head">
        <h1 className="meridian-sessions__title">Sessions</h1>
        <p className="meridian-sessions__lede">
          The work this console is holding open. It lists the sessions it has references to — there
          is no verb for enumerating the rest, so this is not a sweep of the daemon.
        </p>
      </header>

      <div className="meridian-sessions__body">
        <div className="meridian-sessions__list" aria-label="Open sessions">
          {pins.lastRefusal === undefined ? null : <InlineRefusal {...pins.lastRefusal} />}
          {context.sessionStore === undefined ? (
            <NoHeldSessions action={startControl} />
          ) : (
            <HeldSessions
              sessionStore={context.sessionStore}
              attention={attention}
              pins={pins}
              startControl={startControl}
              onOpen={(sessionId) => {
                context.frameStore.navigate({ kind: "workspace", sessionId });
              }}
            />
          )}
        </div>

        <aside className="meridian-sessions__aside" aria-label="What is waiting on you">
          <InviteShelf read={readInvites} uiStateStore={context.uiStateStore} />
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
 * The honest zero.
 *
 * `not-checked` rather than `empty`, and the copy says which: the route names no
 * session, so the frame opened no store, so there is nothing to read — and no
 * session-directory read exists to ask with. "There are none" would be a fact this
 * console never established.
 */
function NoHeldSessions(props: { readonly action: ReactNode }): React.JSX.Element {
  return (
    <Nothing
      kind="not-checked"
      placement="surface"
      title="This console is not holding any sessions."
      detail="Start one, or join one you were invited to, and it appears here with its state and whatever is waiting on you. The rest are not missing — there is no session-directory read to ask with, so nobody asked."
      action={props.action}
    />
  );
}

/**
 * The rows, subscribed per entity kind.
 *
 * A component of its own because the subscription needs a store and a hook cannot
 * be called conditionally — and because the partitioned subscription is the point:
 * `useSessionPartition` returns a reference whose identity changes only when that
 * kind changes, so a burst of run events re-renders nothing here.
 */
function HeldSessions(props: {
  readonly sessionStore: SessionStore;
  readonly attention: AttentionReading;
  readonly pins: SessionPinBinding;
  readonly startControl: ReactNode;
  readonly onOpen: (sessionId: string) => void;
}): React.JSX.Element {
  const sessionEntities = useSessionPartition(props.sessionStore, "session");
  const participantEntities = useSessionPartition(props.sessionStore, "participant");
  const { attention } = props;
  // Read rather than subscribed: a store's session is fixed for its whole life, so
  // there is nothing here to notify about. It is needed because a store projects
  // participants for ITS session, and a row for some other session that this store
  // merely heard about must not be attributed the wrong people.
  const projectedSessionId = props.sessionStore.sessionId;

  const rows = useMemo<readonly SessionListRow[]>(() => {
    const participantIds = Object.keys(participantEntities);
    return Object.values(sessionEntities).map((entity) => ({
      sessionId: entity.id,
      state: entity.state,
      touchedAtIso: entity.touchedAt,
      participantIds: entity.id === projectedSessionId ? participantIds : [],
      attentionSeverity:
        attention.phase === "read" ? attention.plane.severityFor(entity.id) : undefined,
    }));
  }, [sessionEntities, participantEntities, projectedSessionId, attention]);

  if (rows.length === 0) {
    return <NoHeldSessions action={props.startControl} />;
  }
  return (
    <>
      <p className="meridian-sessions__count">
        <DerivedFigure
          text={
            rows.length === 1
              ? "One session is open in this console."
              : `${formatCount(rows.length)} sessions are open in this console.`
          }
        />
      </p>
      <SessionList
        rows={rows}
        tierBySessionId={props.pins.tiers}
        onOpen={props.onOpen}
        onSetTier={props.pins.setTier}
      />
      {props.startControl}
    </>
  );
}
