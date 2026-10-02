// Shared mounting for the browser, screenshot and accessibility tiers, and what a mount leaves
// behind.
//
// Every mount settles first: `AppProviders` upgrades the store to the durable adapter after mount,
// so asserting straight after `render` hits a half-settled tree. The durable store is one
// IndexedDB database per origin that unmounting does not clear, so the reset between cases lives
// here, where every tier shares it.

import { cdp, server, userEvent } from "vitest/browser";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";

import { crossMacrotaskBoundary } from "./macrotask-boundary.js";
import { settle } from "./settle.js";
import { UI_STATE_DATABASE_NAME } from "@renderer/store/persistence/indexeddb-persistence-adapter.js";
import { paneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { screenRegistry } from "@renderer/registries/screens/screen-registry.js";
import { type ColorScheme } from "@renderer/styles/tokens.js";

/**
 * Loads every deferred body the process-wide pane and screen registries hold.
 *
 * The mount does this, not the tier: a loader-backed body arrives on its own chunk, which a
 * dynamic import can take longer than the one macrotask a render settle crosses, so a tier at a
 * deferred address would read, audit or photograph the reserved region. A feature mount builds
 * its own registry and resolves one body through `feature-mounts/pane-body-resolution.ts`.
 *
 * It walks every registered key, not the unloaded ones (as `mount-app.tsx` does for screens):
 * mounting is itself an ask, so a tier mounting at a lazy address has React call that loader
 * during the initial render and the key has already left `unloadedKeys()`. `preload` settles at
 * once for a body in hand and joins the in-flight promise for one still arriving.
 */
async function loadRegisteredBodies(): Promise<void> {
  await Promise.all([
    ...paneRegistry.registeredPaneKinds().map(async (kind) => paneRegistry.preload(kind)),
    ...screenRegistry
      .registeredScreenNames()
      .map(async (screenName) => screenRegistry.preload(screenName)),
  ]);
}

/**
 * Types a key sequence and lets React finish reacting to it.
 *
 * `userEvent` dispatches real events outside React's batching, so the state they cause would
 * settle after the promise resolves, as an act warning and a tree one render behind.
 */
export async function pressKeys(sequence: string): Promise<void> {
  await act(async () => {
    await userEvent.keyboard(sequence);
  });
}

/**
 * Puts the page in a scheme the way a person's operating system does.
 *
 * Not by stamping the scheme attribute: `AppProviders` writes its own store's preference into it
 * in a layout effect, so a value set before mounting is overwritten with the default `"system"`
 * on first paint (how the first dark-scheme screenshot came out light). Emulating
 * `prefers-color-scheme` drives the layer a default install uses. Chromium-only, through CDP;
 * the browser-mode tiers pin Chromium.
 */
export async function emulateSystemScheme(scheme: ColorScheme): Promise<void> {
  await cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: scheme }],
  });
}

/**
 * What a mounted app hands back.
 *
 * Not Testing Library's `RenderResult`: that type is generic in its query set and container, and
 * passing an explicit `container` resolves the query parameter to its bare constraint, so naming
 * it here would export a type no caller's `RenderResult` matches. The tiers use the container
 * and nothing else.
 */
interface AppMount {
  /** The viewport-sized element the app was rendered into. */
  readonly container: HTMLElement;
}

/**
 * Mounts at window size and lets every settled promise land.
 *
 * The container is sized to the viewport: Testing Library's default is an unstyled `div`, and
 * the frame's full-height layout in a shrink-to-fit box lays out at the height of its text,
 * making a geometry assertion measure the wrong box and a screenshot a thumbnail. The wait is a
 * macrotask boundary, not a counted number of flushes: the persistence upgrade resolves a
 * promise whose continuation schedules another, and a chain one link deeper than a count would
 * stop being waited for. It waits on no clock: a view over a fixture scenario schedules its
 * reads on the scenario's frozen clock, which `scheduled-read.ts`'s `settleScheduledRead`
 * advances. A caller holding a bridge settles both (`feature-mounts/composer.tsx`); a caller
 * mounting `AppProviders`, which builds its own bridge, has only this.
 */
export async function renderSettled(element: ReactElement): Promise<AppMount> {
  const container: HTMLElement = document.createElement("div");
  container.style.width = "100vw";
  container.style.height = "100vh";
  document.body.append(container);

  await act(async () => {
    render(element, { container });
    await crossMacrotaskBoundary();
    // After the first settle: a registry is populated by the feature modules an importer pulled
    // in, and deferred bodies are worth loading only once something has mounted against them.
    // Nothing follows the join: it awaits every registration's own promise, so the wait is the
    // join, and `act` flushes the reveal those settlements schedule when this scope closes.
    await loadRegisteredBodies();
  });
  return { container };
}

/**
 * The scroll container the session screen mounts on every session route.
 *
 * The frame is permanent chrome on the page from the first commit, so waiting on it returns at
 * once with a session route not yet resolved. This body mounts on every session route whether or
 * not the session has rows, so waiting on it observes the mount rather than the arrival of
 * content.
 */
export const SESSION_ROUTE_BODY_SELECTOR: string =
  ".meridian-frame__screen .meridian-transcript-feed__body";

/**
 * How long a session route gets to arrive before the window is called half-mounted. A deadline
 * rather than a count of settle turns, since how many turns a mount's chained promises take
 * depends on the machine. A third of the tier's own timeout, read from the resolved
 * configuration so the two cannot drift; the other two thirds are the script walk and capture.
 */
const SESSION_ROUTE_MOUNT_DEADLINE_MS: number = Math.floor(server.config.testTimeout / 3);

/**
 * Waits for a session route to finish arriving, or throws saying it never did.
 *
 * `renderSettled` returns once the mount's own promises have flushed, and the window is not
 * finished then: the saved sidebar arrangement is restored through a store read that starts
 * after the column is on screen. This body mounts by the same route and behind the session
 * store's own read, so a reading taken after it is of a window that has arrived.
 */
export async function awaitSessionRouteMounted(container: HTMLElement): Promise<void> {
  const deadlineAtMs = Date.now() + SESSION_ROUTE_MOUNT_DEADLINE_MS;
  while (container.querySelector(SESSION_ROUTE_BODY_SELECTOR) === null) {
    if (Date.now() >= deadlineAtMs) {
      throw new Error(
        `the session route mounted no body in ${String(SESSION_ROUTE_MOUNT_DEADLINE_MS)} ms, so ` +
          "this window never finished arriving and anything read off it now is half an app",
      );
    }
    await settle();
  }
}

/**
 * Retires every app this page mounted and deletes the database they shared.
 *
 * Called from `beforeEach` rather than `afterEach`, because a file inherits the origin and its
 * database from whichever file ran before it in the same browser session. The unmount is explicit
 * because Testing Library registers its own cleanup only where `afterEach` is a global; without it
 * every app of the run stays mounted, its store connection stays open, and the deletion below is
 * blocked. `cleanup()` is idempotent. The turn between the two is the close: `useUiStateStore`'s
 * disposal fires `store.close()` without awaiting it, and that close awaits its adapter before it
 * reaches `IDBDatabase.close()`, so deleting in the same turn would race the connection and surface
 * as `blocked`.
 */
export async function resetDurableAppState(): Promise<void> {
  cleanup();
  await settle();
  await deleteUiStateDatabase();
}

/**
 * Deletes the app's database, or throws saying which way it did not go.
 *
 * Loud on `blocked`: that event does not refuse the request, it waits for a connection nothing
 * will close, so ignoring it hangs until the tier's timeout and resolving on it hands the next
 * mount the records this exists to remove. A missing `indexedDB` throws too: every caller runs
 * in a real Chromium page where the global is present, and answering quietly on a host without
 * one would report the absence of isolation as isolation.
 */
async function deleteUiStateDatabase(): Promise<void> {
  if (typeof indexedDB === "undefined") {
    throw new Error(
      `this page has no indexedDB global, so ${UI_STATE_DATABASE_NAME} cannot be deleted and every ` +
        "case after this one would mount over the records the case before it wrote",
    );
  }

  const deletion = indexedDB.deleteDatabase(UI_STATE_DATABASE_NAME);
  await new Promise<void>((resolve, reject) => {
    deletion.onsuccess = (): void => {
      resolve();
    };
    deletion.onerror = (): void => {
      reject(
        new Error(
          `${UI_STATE_DATABASE_NAME} refused to be deleted (${describeDeletionFailure(deletion.error)}), ` +
            "so the next mount would be restored into the arrangement the last one left",
        ),
      );
    };
    deletion.onblocked = (): void => {
      reject(
        new Error(
          `${UI_STATE_DATABASE_NAME} is still open, so its deletion is blocked: an app mounted ` +
            "earlier in this page never had its store closed, and the next mount would be restored " +
            "into the arrangement that app left",
        ),
      );
    };
  });
}

/** What a refused deletion is called, for the sentence that reports it. */
function describeDeletionFailure(error: DOMException | null): string {
  return error === null ? "no reason given" : error.name;
}
