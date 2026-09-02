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
// from `SessionStoreRegistry`, the same source the auxiliary context picker reads.
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

import { useMemo, useState, type ReactNode } from "react";

import type { SessionDirectoryState } from "../frame/session-directory.js";
import { useSessionDirectory } from "../frame/session-directory.js";
import { renderAbsorbedSessionProbe } from "../frame/legacy-surfaces.js";
import type { ConsoleSurfaceContext } from "../frame/surface-registry.js";
import type { AttentionSeverity } from "../bridge/index.js";
import {
  NotificationCenter,
  attentionProjectionReaderFor,
  useAttentionProjection,
  type AttentionReading,
} from "../notifications/index.js";
import { DerivedFigure, InlineRefusal, Nothing, formatCount } from "../primitives/index.js";
import { useOpenSessionIds, useSessionPartition, type SessionStore } from "../store/index.js";
import { InviteShelf, type InviteShelfReader } from "./InviteShelf.js";
import { SessionList } from "./SessionList.js";
import {
  mergeSessionRows,
  sessionsAbsenceKindFor,
  withAttentionSeverity,
} from "./session-directory-rows.js";
import { useSessionPins, type SessionPinBinding } from "./session-pins.js";
import type { SessionListRow } from "./session-rows.js";

export interface SessionsSurfaceProps {
  readonly context: ConsoleSurfaceContext;
}

export function SessionsSurface(props: SessionsSurfaceProps): React.JSX.Element {
  const { context } = props;
  const pins = useSessionPins(context.uiStateStore);
  const directory = useSessionDirectory(context.bridge.growth);
  const windowSessionIds = useOpenSessionIds(context.sessionStoreRegistry);
  // The attention read is scoped to a session on the wire and this destination is
  // not, so it asks about every session the surface can NAME — the same set the
  // list is built from, derived here with no projected rows because the ids are all
  // this needs. Memoised on the merged ids rather than on the directory object, so
  // the read fires once when the directory settles and not again on every render
  // the surface performs afterwards.
  const attentionSessionIds = useMemo(
    () =>
      mergeSessionRows({ directory, windowSessionIds, projectedRows: [] }).map(
        (row) => row.sessionId,
      ),
    [directory, windowSessionIds],
  );
  const attention = useAttentionProjection(
    useMemo(
      () => attentionProjectionReaderFor(context.bridge.growth, attentionSessionIds),
      [context.bridge.growth, attentionSessionIds],
    ),
  );
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

  const listProps = {
    directory,
    windowSessionIds,
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
          {context.sessionStore === undefined ? (
            <DirectorySessionRows {...listProps} />
          ) : (
            <ProjectedSessionRows {...listProps} sessionStore={context.sessionStore} />
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

/** What both row sources are handed. The store is the only thing that differs. */
interface SessionRowsProps {
  readonly directory: SessionDirectoryState;
  readonly windowSessionIds: readonly string[];
  readonly attention: AttentionReading;
  readonly pins: SessionPinBinding;
  readonly startControl: ReactNode;
  readonly onOpen: (sessionId: string) => void;
}

/**
 * The rows when this address names no session, so the frame opened no store.
 *
 * The directory still answers — it is a node read and not a session read — which is
 * the whole regression this arm closes: a window holding nothing is not a node
 * holding nothing, and before the directory read the surface could not tell them
 * apart and reported the first as the second.
 */
function DirectorySessionRows(props: SessionRowsProps): React.JSX.Element {
  return <SessionRowsView {...props} projectedRows={[]} />;
}

/**
 * The rows when a store is open, subscribed per entity kind.
 *
 * A component of its own because the subscription needs a store and a hook cannot
 * be called conditionally — and because the partitioned subscription is the point:
 * `useSessionPartition` returns a reference whose identity changes only when that
 * kind changes, so a burst of run events re-renders nothing here.
 */
function ProjectedSessionRows(
  props: SessionRowsProps & { readonly sessionStore: SessionStore },
): React.JSX.Element {
  const sessionEntities = useSessionPartition(props.sessionStore, "session");
  const participantEntities = useSessionPartition(props.sessionStore, "participant");
  // Read rather than subscribed: a store's session is fixed for its whole life, so
  // there is nothing here to notify about. It is needed because a store projects
  // participants for ITS session, and a row for some other session that this store
  // merely heard about must not be attributed the wrong people.
  const projectedSessionId = props.sessionStore.sessionId;

  const projectedRows = useMemo<readonly SessionListRow[]>(() => {
    const participantIds = Object.keys(participantEntities);
    return Object.values(sessionEntities).map((entity) => ({
      sessionId: entity.id,
      state: entity.state,
      touchedAtIso: entity.touchedAt,
      participantIds: entity.id === projectedSessionId ? participantIds : [],
      attentionSeverity: undefined,
    }));
  }, [sessionEntities, participantEntities, projectedSessionId]);

  return <SessionRowsView {...props} projectedRows={projectedRows} />;
}

/**
 * The list itself, once both sources have been named.
 *
 * One view for both arms, so the merge, the attention stamp, the count sentence and
 * the absence are written once. Two copies of this would be two lists that agree
 * until one of them is edited.
 */
function SessionRowsView(
  props: SessionRowsProps & { readonly projectedRows: readonly SessionListRow[] },
): React.JSX.Element {
  const { attention, directory, projectedRows, windowSessionIds } = props;
  const rows = useMemo<readonly SessionListRow[]>(() => {
    const severityFor = (sessionId: string): AttentionSeverity | undefined =>
      attention.phase === "read" ? attention.plane.severityFor(sessionId) : undefined;
    return withAttentionSeverity(
      mergeSessionRows({ directory, windowSessionIds, projectedRows }),
      severityFor,
    );
  }, [attention, directory, windowSessionIds, projectedRows]);

  if (rows.length === 0) {
    return <SessionsAbsence directory={directory} action={props.startControl} />;
  }
  return (
    <>
      <p className="meridian-sessions__count">
        <DerivedFigure text={countSentence(rows.length, directory)} />
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

/**
 * What the count says, and whose count it is.
 *
 * The sentence names the AUTHORITY, not just the number: a list the node answered
 * for is the node's count, and a list assembled from what this window happens to
 * hold is this window's. Reporting the second in the first's words would be the
 * surface's one remaining chance to overclaim.
 */
function countSentence(rowCount: number, directory: SessionDirectoryState): string {
  if (directory.status === "served") {
    return rowCount === 1
      ? "One session is on this node."
      : `${formatCount(rowCount)} sessions are on this node.`;
  }
  return rowCount === 1
    ? "One session is open in this console."
    : `${formatCount(rowCount)} sessions are open in this console.`;
}

/**
 * The honest zero, chosen by what the directory read did rather than by the count.
 *
 * Three arms because there are three facts, and collapsing any two of them is the
 * conflation the five kinds of nothing exist to prevent. The `not-loaded` arm
 * carries no action deliberately: a read in flight renders as a skeleton, which has
 * nowhere to put a control, and passing one would make the code read as though a
 * control were on screen that is not.
 */
function SessionsAbsence(props: {
  readonly directory: SessionDirectoryState;
  readonly action: ReactNode;
}): React.JSX.Element {
  const kind = sessionsAbsenceKindFor(props.directory);
  if (kind === "not-loaded") {
    return (
      <Nothing kind="not-loaded" placement="surface" title="Reading the sessions on this node." />
    );
  }
  if (kind === "empty") {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title="There are no sessions on this node yet."
        detail="The node answered, and it has none. Starting one is the way to have the first."
        action={props.action}
      />
    );
  }
  return (
    <Nothing
      kind="not-checked"
      placement="surface"
      title="This console is not holding any sessions."
      detail={`The console lists the sessions this window has opened; the node's own directory answered nothing here. ${props.directory.status === "unavailable" ? props.directory.refusal.detail : ""}`.trim()}
      action={props.action}
    />
  );
}
