// The world this destination's test files drive it against.
//
// Split from the harness beside it, which mounts the surface and reads what it drew.
// The two halves answer different questions and grew at different rates: this one is
// the faked context — every wire the surface asks and what each one answers — and
// `session-surface.test-support.tsx` is the mount, the settle, and the queries. A case
// composes a context here and hands it there, which is the same shape it had as one
// file and the reason neither half needs the other.
//
// Hoisted on second use, per `apps/desktop/AGENTS.md`, and a second copy of
// `contextWith` in particular would let two suites disagree about what a refused read
// looks like without any one of them failing.

import { NO_TRANSPORT_RECONNECT } from "../core/index.js";
import { openStore } from "./sessions.test-support.js";
import {
  SessionStore,
  UNREPORTED_SHELL_STATE,
  type ShellConnection,
  type ShellState,
} from "../store/index.js";
import type { ConsoleSurfaceContext } from "../seats/index.js";

/**
 * One open session's store, established the way a read would.
 *
 * One store per session, which is what the registry holds: `SessionStore` refuses a
 * foreign session's events, so a single store standing in for several open sessions
 * would be a shape the console never produces.
 */
export function storeHolding(options: {
  readonly sessionId: string;
  /** Wire-verbatim, so a case can order two sessions by what the projection says. */
  readonly touchedAtIso?: string;
  /** Participants the store has seen, in the order it saw them. */
  readonly participantIds?: readonly string[];
}): SessionStore {
  const participantIds = options.participantIds ?? [];
  const store = new SessionStore({ sessionId: options.sessionId });
  store.initialise({
    cursor: 0,
    entities: [
      {
        kind: "session" as const,
        id: options.sessionId,
        state: "active",
        touchedAt: options.touchedAtIso ?? "2026-01-01T10:00:00.000Z",
      },
      ...participantIds.map((participantId) => ({
        kind: "participant" as const,
        id: participantId,
      })),
    ],
    participantJoinLog: [...participantIds],
  });
  return store;
}

/** The refusal the growth port answers with while no wire serves a read. */
export function refusedRead(operationId: string, slateRow: string): unknown {
  return {
    status: "unavailable",
    code: "wire-unregistered",
    origin: "growth-port",
    detail: `Not checked — the ${operationId} read is not registered yet.`,
    operationId,
    slateRow,
    owningDocument: "Spec-002",
  };
}

/**
 * The fields this surface reads, and nothing else.
 *
 * Cast rather than fully constructed, for `RouteSurface.test.tsx`'s reason: a
 * real context carries three stores, one of which opens a database on
 * construction, and building all of that to hand six fields to a component that
 * reads six would make the setup the subject. The two stores that ARE real here
 * are the two whose behaviour is under test.
 */
export function contextWith(options: {
  /**
   * The ROUTE-scoped store, which this destination deliberately does not read.
   *
   * Kept because the field is part of the context every surface is handed, and
   * because a case that supplies one and finds none of its rows on screen is the
   * negative control for the switch to the registry.
   */
  readonly sessionStore?: SessionStore;
  readonly bridgeSource?: "live" | "fixture";
  /** What the node's directory read answers. Refused unless a test names rows. */
  readonly directorySessionIds?: readonly string[];
  /** The stores this window has open, as the registry holds them. */
  readonly openStores?: readonly SessionStore[];
  /** Sessions the registry reports open but holds no store for. */
  readonly windowSessionIds?: readonly string[];
  /**
   * The session each `registry.open` call named, appended in call order.
   *
   * Recorded rather than stubbed silently, because opening is one of the four things
   * a settled start does and it is the one with no visible consequence on this
   * screen: a session this window created is a session this window has open, and the
   * registry is where that becomes true.
   */
  readonly openedSessionIds?: string[];
  /**
   * Whether this window's registry has been disposed — a bridge it has already left.
   *
   * Named because `open` is the one registry call that RAISES rather than returning
   * a refusal, so a settlement landing after a replacement must not take the rest of
   * the act with it.
   */
  readonly isRegistryDisposed?: boolean;
  /** Attention items the projection serves, per session. Refused unless named. */
  readonly attentionBySessionId?: Readonly<Record<string, readonly unknown[]>>;
  /**
   * What the shell's notification-permission read answers. Refused unless named,
   * which is what the live bridge does and therefore the default a case inherits.
   */
  readonly notificationPermission?: "granted" | "denied" | "not-determined";
  /** One entry per `native.showNotification` call the surface made, in order. */
  readonly emittedNotifications?: unknown[];
  /** Whether the window has focus. Focused unless a case says otherwise. */
  readonly isWindowFocused?: boolean;
  /**
   * The session this window's route names, for the emitter's audience rule. None by
   * default, which is the sessions destination — where this surface renders.
   */
  readonly activeSessionId?: string;
  /** Every route the surface navigated to, appended in order. */
  readonly navigations?: unknown[];
  /**
   * Where this window stands with its local runtime. Unreported unless a case says
   * otherwise, which is what a shipped window holds and therefore the default every
   * case that is not about the shell inherits: nothing is blocked on the strength of
   * a supervisor nobody asked.
   */
  readonly shellConnection?: ShellConnection;
}): ConsoleSurfaceContext {
  const directorySessionIds = options.directorySessionIds;
  // Whole, rather than the connection alone: the surface reads it through the store's
  // own `shellMutationBlock`, which is total over the state, so a partial value here
  // would be a shape the real store never produces.
  const shellState: ShellState = {
    ...UNREPORTED_SHELL_STATE,
    connection: options.shellConnection ?? UNREPORTED_SHELL_STATE.connection,
  };
  const frameStoreState = {
    // The route, because the emitter's audience rule reads it — and derived from the
    // named session rather than set beside it, which is how the real store holds the
    // pair: `FrameStore.activeSessionId` is a projection of `route` and never a second
    // record of it, so two independent stub members could describe a window that
    // cannot exist. Naming no session is the sessions destination itself, which is
    // where this surface renders and where the centre shows every session at once.
    route:
      options.activeSessionId === undefined
        ? { kind: "sessions" }
        : { kind: "workspace", sessionId: options.activeSessionId },
    isWindowFocused: options.isWindowFocused ?? true,
    shellState,
  };
  return {
    route: { kind: "sessions" },
    bridge: {
      source: options.bridgeSource ?? "fixture",
      growth: {
        attentionProjectionRead: ({ sessionId }: { readonly sessionId: string }) => {
          const items = options.attentionBySessionId?.[sessionId];
          return Promise.resolve(
            items === undefined
              ? refusedRead("attentionProjectionRead", "attention-projection-read")
              : { status: "served", value: { items } },
          );
        },
        shellNotificationPermissionRead: () =>
          Promise.resolve(
            options.notificationPermission === undefined
              ? refusedRead("shellNotificationPermissionRead", "notification-permission-read")
              : { status: "served", value: { state: options.notificationPermission } },
          ),
        sessionList: () =>
          Promise.resolve(
            directorySessionIds === undefined
              ? refusedRead("sessionList", "session-directory-read")
              : {
                  status: "served",
                  value: directorySessionIds.map((sessionId) => ({
                    sessionId,
                    state: "active",
                  })),
                },
          ),
      },
      // The one member of the shipped bridge this destination calls. Recorded rather
      // than stubbed silently, so a case can assert that a banner was raised — and,
      // more often, that one was not.
      sidekicks: {
        native: {
          showNotification: (notificationOptions: unknown) => {
            options.emittedNotifications?.push(notificationOptions);
          },
        },
      },
      // The attention plane's change signal, attached and silent: a case moves this
      // destination's projection by naming what each session's read answers, never by
      // playing a beat, so a bridge that signalled here would re-read on nothing.
      attentionSubscribe: () => () => undefined,
      // The transport's reconnect signal, silent for the same reason and taken rather
      // than left off: this stub is cast, so a window trigger reading a member that is
      // not here fails at the mount instead of at the compiler.
      transportReconnect: NO_TRANSPORT_RECONNECT,
    },
    frameStore: {
      navigate: (route: unknown) => {
        options.navigations?.push(route);
      },
      // Read imperatively by the emitter, exactly as the real store is: what decides
      // a banner is where the window was when the item arrived.
      getState: () => frameStoreState,
      // The read-only face `useShellState` subscribes through. A constant snapshot
      // with a no-op subscription, because a case names the shell state it wants and
      // nothing here moves it — and the identity is held rather than minted per read,
      // which is what `useSyncExternalStore` compares.
      readable: {
        getState: () => frameStoreState,
        getInitialState: () => frameStoreState,
        subscribe: () => () => undefined,
      },
      activeSessionId: options.activeSessionId,
      publishRailAttentionCount: () => undefined,
    },
    sessionStore: options.sessionStore,
    sessionStoreRegistry: {
      openSessionIds: [
        ...(options.openStores ?? []).map((store) => store.sessionId),
        ...(options.windowSessionIds ?? []),
      ],
      peek: (sessionId: string) =>
        (options.openStores ?? []).find((store) => store.sessionId === sessionId),
      subscribe: () => () => undefined,
      isDisposed: options.isRegistryDisposed ?? false,
      // Raises on a disposed registry exactly as the real one does, so a case
      // asserting that a settled start skips the open is asserting the guard rather
      // than a stub that quietly answered anyway.
      open: (sessionId: string) => {
        if (options.isRegistryDisposed === true) {
          throw new Error(`the registry is disposed and cannot open ${sessionId}`);
        }
        options.openedSessionIds?.push(sessionId);
      },
    },
    uiStateStore: openStore(),
    draftStore: undefined,
  } as unknown as ConsoleSurfaceContext;
}
