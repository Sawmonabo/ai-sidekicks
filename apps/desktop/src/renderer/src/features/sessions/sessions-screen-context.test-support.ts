// The world the destination's acts are driven against.
//
// A faked surface context that records what the acts call: which routes were
// navigated to and which sessions the registry was asked to open.

import type { ScreenContext } from "@renderer/console/seats/index.js";

/**
 * The fields the acts read, and nothing else.
 *
 * Cast rather than fully constructed, for `RouteSurface.test.tsx`'s reason: a real
 * context carries three stores, one of which opens a database on construction, and
 * building all of that to hand two members to code that reads two would make the setup
 * the subject.
 */
export function contextWith(options: {
  /**
   * The session each `registry.open` call named, appended in call order.
   *
   * Recorded rather than stubbed silently, because opening is the one step of a
   * settled start with no visible consequence on screen: a session this window
   * created is a session this window has open, and the registry is where that becomes
   * true.
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
  /** Every route the acts navigated to, appended in order. */
  readonly navigations?: unknown[];
}): ScreenContext {
  return {
    frameStore: {
      navigate: (route: unknown) => {
        options.navigations?.push(route);
      },
    },
    sessionStoreRegistry: {
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
  } as unknown as ScreenContext;
}
