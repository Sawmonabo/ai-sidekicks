// The harness this destination's test files drive it through.
//
// Hoisted on second use, per `apps/desktop/AGENTS.md`. The files ask different
// questions — one about the LIST and the act of starting a session, another about the
// two session-scoped reads in the aside, and the binding's own about how long the
// rail's count lives — but they mount the same destination against the same faked
// context, and a second copy of `settle` in particular would let them disagree about
// how many passes the read chain needs without any one of them failing.

import { act, render } from "@testing-library/react";

import { ManualClock } from "../core/index.js";
import {
  PAST_REFRESH_DEBOUNCE_MS,
  settle as settleReactWork,
} from "../core/settle.test-support.js";
import { LiveAnnouncer, LiveAnnouncerProvider } from "../primitives/index.js";
import { politeText } from "../primitives/live-region.test-support.js";
import { SidekicksBridgeProvider } from "../bridge/index.js";
import { SessionAttentionBinding } from "./SessionAttentionBinding.js";
import { SessionsSurface } from "./SessionsSurface.js";
import { openStore } from "./sessions.test-support.js";
import {
  SessionStore,
  UNREPORTED_SHELL_STATE,
  type ShellConnection,
  type ShellState,
} from "../store/index.js";
import type { ConsoleSurfaceContext } from "../seats/index.js";

/**
 * Let the destination's asynchronous arrivals land.
 *
 * Three reads settle behind this destination — the attention projection, the invites
 * fan-out, and the node's session directory — and each settles an effect that can
 * schedule the next, so the count is the depth of that chain rather than a number
 * picked to make a test pass. Two of the three are performed by the binding ABOVE the
 * surface now rather than by the surface, which changes where they are mounted and
 * not how long the chain is.
 *
 * The attention read is the one that also costs TIME. It goes through the console's
 * one refresh scheduler, so its first read lands a debounce interval after the
 * subscribe rather than on the next microtask — and the bridge this file builds
 * carries no scenario engine, so that interval is measured on the wall clock. A
 * surface driven against the real fixture advances the frozen clock instead.
 */
export async function settle(): Promise<void> {
  await settleReactWork();
  await act(async () => {
    await new Promise((resolveAfterDebounce) => {
      setTimeout(resolveAfterDebounce, PAST_REFRESH_DEBOUNCE_MS);
    });
  });
}

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

/**
 * The absence the LIST is rendering, as its kind classes.
 *
 * Scoped to the list region deliberately. The aside beside it holds two other
 * reads — the invitations shelf and the attention panel — and each renders its own
 * honest absence, so an unscoped query would answer with whichever of the three
 * came first in the document and would pass or fail for reasons that have nothing
 * to do with the directory.
 */
export function listAbsenceKinds(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-sessions__list .meridian-nothing")].flatMap(
    (element) => [...element.classList].filter((name) => name.startsWith("meridian-nothing--")),
  );
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
 * Cast rather than fully constructed, for `legacy-surfaces.test.ts`'s reason: a
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
  /** Attention items the projection serves, per session. Refused unless named. */
  readonly attentionBySessionId?: Readonly<Record<string, readonly unknown[]>>;
  /** Invitations the port serves, per session. Refused unless a test names them. */
  readonly invitesBySessionId?: Readonly<Record<string, readonly unknown[]>>;
  /** The session each `invitesList` call named, appended in call order. */
  readonly invitesListCalls?: string[];
  /**
   * What the shell's notification-permission read answers. Refused unless named,
   * which is what the live bridge does and therefore the default a case inherits.
   */
  readonly notificationPermission?: "granted" | "denied" | "not-determined";
  /** One entry per `native.showNotification` call the surface made, in order. */
  readonly emittedNotifications?: unknown[];
  /** Whether the window has focus. Focused unless a case says otherwise. */
  readonly isWindowFocused?: boolean;
  /** The session the route names, for the emitter's audience rule. */
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
    isWindowFocused: options.isWindowFocused ?? true,
    shellState,
  };
  return {
    route: { kind: "sessions" },
    bridge: {
      source: options.bridgeSource ?? "fixture",
      growth: {
        invitesList: ({ sessionId }: { readonly sessionId: string }) => {
          options.invitesListCalls?.push(sessionId);
          const invites = options.invitesBySessionId?.[sessionId];
          return Promise.resolve(
            invites === undefined
              ? refusedRead("invitesList", "invites-list")
              : { status: "served", value: invites },
          );
        },
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
    },
    uiStateStore: openStore(),
    draftStore: undefined,
  } as unknown as ConsoleSurfaceContext;
}

/**
 * Mount the destination the way the frame does: under the bridge provider and the
 * console's one announcer.
 *
 * THE CONTEXT rather than an element, because the mount now has two things to do with
 * it — hand it to the surface and supply it to the provider — and a helper that took
 * the composed element could reach neither. The provider is part of the shape under
 * test: the invite shelf takes the window's clock from `useConsoleClock`, which
 * resolves through it, and the provider's own error says every console surface renders
 * inside one.
 *
 * THE SURFACE'S OWN ELEMENT IS RETURNED, not the render container — the
 * `settings/pages/application/updates/UpdatesBlock.reading.test.tsx` shape, and here it is
 * load-bearing rather
 * than tidy. The provider's two live regions are siblings ABOVE this surface, and
 * they carry the settlement sentence, so a case asserting the panel does not say
 * "Nothing needs you." would otherwise be reading the announcement of exactly that
 * and failing for a reason that has nothing to do with what is on screen.
 *
 * The announcer runs on a `ManualClock` so its hold window is frozen: whether a
 * sentence is still standing is otherwise a question about how fast the runner was.
 */
export function renderSurface(context: ConsoleSurfaceContext): {
  readonly container: HTMLElement;
  readonly politeText: () => string;
} {
  const announcer = new LiveAnnouncer({ clock: new ManualClock() });
  const mounted = render(
    <SidekicksBridgeProvider bridge={context.bridge}>
      <LiveAnnouncerProvider announcer={announcer}>
        {/*
          The window's attention binding, mounted the way the frame mounts it. It is
          part of the shape under test rather than scaffolding: the destination reads
          the projection and the node's directory THROUGH it now, so a harness that
          omitted it would be driving a surface no composition produces — and the one
          it would produce is the one this seat exists to retire.
        */}
        <SessionAttentionBinding
          context={{
            bridge: context.bridge,
            frameStore: context.frameStore,
            sessionStoreRegistry: context.sessionStoreRegistry,
          }}
        >
          <SessionsSurface context={context} />
        </SessionAttentionBinding>
      </LiveAnnouncerProvider>
    </SidekicksBridgeProvider>,
  ).container;
  const surfaceRoot = mounted.querySelector<HTMLElement>("section.meridian-sessions");
  if (surfaceRoot === null) {
    throw new Error("the sessions destination did not render");
  }
  return {
    container: surfaceRoot,
    politeText: () => politeText(mounted),
  };
}
