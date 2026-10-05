// A faked screen context that records the routes navigated to and the sessions the registry
// was asked to open.

import type { ScreenContext } from "#renderer/registries/screens/screen-context.js";

/**
 * The fields the acts read, and nothing else. Cast rather than constructed, as in
 * `app/AppRouter.test.tsx`: a real context opens a database on construction.
 */
export function contextWith(options: {
  /** The session each `registry.open` call named, in call order; opening has no visible result. */
  readonly openedSessionIds?: string[];
  /** Whether this window's registry is disposed, so `open` throws as the real one does. */
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
      // Throws when disposed, so a case asserting the skip exercises the guard.
      open: (sessionId: string) => {
        if (options.isRegistryDisposed === true) {
          throw new Error(`the registry is disposed and cannot open ${sessionId}`);
        }
        options.openedSessionIds?.push(sessionId);
      },
    },
  } as unknown as ScreenContext;
}
