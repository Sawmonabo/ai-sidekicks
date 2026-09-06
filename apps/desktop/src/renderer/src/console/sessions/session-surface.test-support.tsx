// The harness both of this destination's test files drive it through.
//
// Hoisted on second use, per `apps/desktop/AGENTS.md`. The two files ask different
// questions — one about the LIST and the act of starting a session, the other about
// the two session-scoped reads in the aside — but they mount the same destination
// against the same faked context, and a second copy of `settle` in particular would
// let them disagree about how many passes the read chain needs without either one
// failing.

import { act, render } from "@testing-library/react";

import { ManualClock } from "../core/index.js";
import { PAST_REFRESH_DEBOUNCE_MS, settle as settlePasses } from "../core/settle.test-support.js";
import { LiveAnnouncer, LiveAnnouncerProvider } from "../primitives/index.js";
import { politeText } from "../primitives/live-region.test-support.js";
import { SidekicksBridgeProvider } from "../bridge/index.js";
import { SessionsSurface } from "./SessionsSurface.js";
import { openStore } from "./sessions.test-support.js";
import { SessionStore } from "../store/index.js";
import type { ConsoleSurfaceContext } from "../seats/index.js";

/**
 * Let the destination's asynchronous arrivals land.
 *
 * Three reads settle behind this surface — the attention projection, the invites
 * fan-out, and the node's session directory — and each settles an effect that can
 * schedule the next, so the count is the depth of that chain rather than a number
 * picked to make a test pass.
 *
 * The attention read is the one that also costs TIME. It goes through the console's
 * one refresh scheduler, so its first read lands a debounce interval after the
 * subscribe rather than on the next microtask — and the bridge this file builds
 * carries no scenario engine, so that interval is measured on the wall clock. A
 * surface driven against the real fixture advances the frozen clock instead.
 */
export async function settle(): Promise<void> {
  await settlePasses(4);
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
}): ConsoleSurfaceContext {
  const directorySessionIds = options.directorySessionIds;
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
    },
    frameStore: { navigate: () => undefined },
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
        <SessionsSurface context={context} />
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
