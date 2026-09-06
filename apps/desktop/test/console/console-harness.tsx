// Shared mounting for the three browser-mode tiers, and what a mount leaves behind.
//
// Not a test file — no `include` glob reaches it; it is imported by the browser,
// screenshot, and accessibility tiers so all three mount the console the same
// way. A per-tier copy of this would be three chances to mount it differently and
// then compare results as if they were comparable.
//
// The one thing it does beyond `render` is WAIT. `ConsoleRoot` starts async work
// on mount — the durable persistence adapter is opened and the store is upgraded
// from the in-memory one when it settles, deliberately, so first paint never waits
// on a database. A test that asserts immediately after `render` therefore asserts
// against a half-settled tree AND leaves a state update landing outside `act`,
// which React reports as a warning rather than as the failure it usually is. So
// every mount here settles first, and a tier's assertions run against the frame a
// person would actually be looking at.
//
// AND THE SECOND THING IT OWNS IS WHAT THAT MOUNT LEFT BEHIND. The store the mount
// opened is DURABLE and it is shared: the sidebar's collapse, the deck's
// arrangement and the colour scheme are written into one IndexedDB database per
// origin, and unmounting the tree closes a connection rather than removing a
// record. So a case that collapsed the sidebar was restored into the NEXT case's
// mount, and the screenshot tier minted a reference named for an expanded sidebar
// over a picture of a collapsed one — byte-identical to its own collapsed sibling,
// which is how it was finally noticed. The reset below is the counterpart of the
// mount above, and it is one function for the reason the mount is one function: a
// per-tier copy of it is another chance to reset it differently, and this is the
// module every tier already mounts through.

import { cdp, server, userEvent } from "vitest/browser";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";

import { CONSOLE_DATABASE_NAME } from "../../src/renderer/src/console/persistence/indexeddb-adapter.js";
import { type ConsoleScheme } from "../../src/renderer/src/console/tokens/index.js";

/**
 * Type a key sequence and let React finish reacting to it.
 *
 * `userEvent` dispatches real events, which land outside React's batching, so the
 * state they cause settles after the promise resolves rather than before it —
 * which React reports as an act warning and a test observes as a tree one render
 * behind. Wrapping the press is what makes the assertion after it honest.
 */
export async function pressKeys(sequence: string): Promise<void> {
  await act(async () => {
    await userEvent.keyboard(sequence);
  });
}

/**
 * Put the page in a scheme the way a person's operating system does.
 *
 * NOT by stamping the scheme attribute: `ConsoleRoot` owns that attribute and
 * writes its own store's preference into it in a layout effect, so a test that
 * set it before mounting would have it overwritten with the default `"system"`
 * on the first paint — which is exactly how the first dark-scheme screenshot
 * came out light. Emulating `prefers-color-scheme` drives the same layer a
 * default install actually uses, and the console reads it rather than fighting
 * it.
 *
 * Chromium-only, through CDP. The browser-mode tiers pin Chromium, so this is a
 * capability of the configured browser rather than an assumption about browsers.
 */
export async function emulateSystemScheme(scheme: ConsoleScheme): Promise<void> {
  await cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: scheme }],
  });
}

/**
 * What a mounted console hands back.
 *
 * Deliberately NOT Testing Library's `RenderResult`: that type is generic in
 * its query set and container, and passing an explicit `container` resolves the
 * query parameter to its bare constraint rather than to the concrete default,
 * so naming it here would export a type no caller's `RenderResult` matches. The
 * three tiers use the container and nothing else.
 */
export interface ConsoleMount {
  /** The viewport-sized element the console was rendered into. */
  readonly container: HTMLElement;
}

/**
 * Mount at window size and let every settled promise land.
 *
 * The container is sized to the viewport rather than left to grow with its
 * content. Testing Library's default container is an unstyled `div`, and the
 * console's frame is a full-height layout — mounted into a shrink-to-fit box it
 * lays out at the height of its text, which makes a geometry assertion measure
 * the wrong box and a screenshot baseline a thumbnail of the top-left corner.
 *
 * Two promise flushes, not one: the persistence upgrade resolves a promise whose
 * continuation schedules another (open the database, then read the partition
 * back), and a single flush would return between the two.
 */
export async function renderSettled(element: ReactElement): Promise<ConsoleMount> {
  const container: HTMLElement = document.createElement("div");
  container.style.width = "100vw";
  container.style.height = "100vh";
  document.body.append(container);

  await act(async () => {
    render(element, { container });
    await Promise.resolve();
    await Promise.resolve();
  });
  return { container };
}

/**
 * Let one turn of the console's own asynchronous work land, inside `act`.
 *
 * A macrotask rather than a microtask flush: the mount path crosses both, and a
 * turn that only drained the microtask queue would return between two halves of one
 * settlement. Inside `act` because every one of those settlements ends in a React
 * state update, and an update that lands outside it settles after the awaited turn
 * rather than before — which React reports as a warning and a capture observes as a
 * frame one commit behind the state it claims to pin.
 *
 * Here rather than in the one tier that first wrote it, because the wait and the
 * reset below are its second and third callers and `apps/desktop/AGENTS.md` hoists a
 * helper on its second use.
 */
export async function settleOneTurn(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

/**
 * The scroll container the workspace mounts on every session route.
 *
 * The frame is the window's permanent shell and is on the page from the first commit,
 * so a wait on it returns immediately and hands back a console whose session route has
 * not resolved yet. The workspace mounts this body on every session route whether or
 * not that session has rows, so a wait on it observes the MOUNT rather than the
 * arrival of content.
 */
export const SESSION_ROUTE_BODY_SELECTOR: string =
  ".meridian-frame__surface .meridian-ledger__body";

/**
 * How long a session route gets to arrive before the window is called half-mounted.
 *
 * A DEADLINE, and it replaced a fixed count of forty settle turns on 2026-09-02. That
 * count was a wait measured in the wrong unit: a mount is not one turn of work —
 * `ConsoleRoot` opens a durable persistence adapter, the session registry opens a
 * store, and the store initialises from the bridge's own session read, each resolving
 * a promise whose continuation schedules the next — and how many turns those take is a
 * property of the machine, not of the console. Forty of them are about 190 ms, which
 * is enough for a WARM mount and was not enough for a cold one on the pinned
 * `macos-15` runner: the first case in the ledger's file refused there while the
 * second, on the same route 1.1 s later, passed.
 *
 * A third of the tier's own timeout, read from the resolved configuration rather than
 * restated, so the two cannot drift apart and the failure names the surface that never
 * mounted instead of timing out the whole test. Two thirds of the budget are left for
 * the script walk and the capture, and 5 s is some twenty-six times the warm mount
 * that file was measured at.
 */
export const SESSION_ROUTE_MOUNT_DEADLINE_MS: number = Math.floor(server.config.testTimeout / 3);

/**
 * Wait for a session route to finish arriving, or throw saying it never did.
 *
 * WHY A TIER READS ANYTHING OFF A WINDOW THROUGH THIS. `renderSettled` returns once the
 * mount's own promises have flushed, and the window is not finished at that point: the
 * saved sidebar arrangement is restored through a store read that starts after the
 * column is already on screen, so the arm the mount hands back is not always the arm a
 * capture taken afterwards will see. Measured on the screenshot tier: a restored
 * collapse landed two turns after `renderSettled` returned, and the case in between
 * read an expanded sidebar and photographed a collapsed one. This body is mounted by
 * the same route and behind the session store's own read, so a reading taken after it
 * is a reading of a window that has arrived.
 */
export async function awaitSessionRouteMounted(container: HTMLElement): Promise<void> {
  const deadlineAtMs = Date.now() + SESSION_ROUTE_MOUNT_DEADLINE_MS;
  while (container.querySelector(SESSION_ROUTE_BODY_SELECTOR) === null) {
    if (Date.now() >= deadlineAtMs) {
      throw new Error(
        `the session route mounted no body in ${String(SESSION_ROUTE_MOUNT_DEADLINE_MS)} ms, so ` +
          "this window never finished arriving and anything read off it now is half a console",
      );
    }
    await settleOneTurn();
  }
}

/**
 * Retire every console this page mounted and delete the database they shared.
 *
 * CALLED FROM `beforeEach` RATHER THAN `afterEach`, which is what makes it cover
 * the wider half of the same defect: a file inherits the origin — and the database
 * on it — from whichever file ran before it in the same browser session, and a
 * teardown at the end of one file is a promise the next file has no way to check.
 *
 * THE UNMOUNT IS EXPLICIT AND IS NOT BELT-AND-BRACES. Testing Library registers its
 * own cleanup only where `afterEach` is a global, which every console browser
 * project sets today and none of them owes this module; without it every console of
 * the run stays mounted, its store connection stays open, and the deletion below is
 * blocked by it. `cleanup()` is idempotent — it unmounts what it is holding and
 * then holds nothing — so calling it here costs the ordinary path a walk over an
 * empty list and makes this function true on its own terms.
 *
 * THE TURN BETWEEN THE TWO IS THE CLOSE. `useUiStateStore`'s disposal fires
 * `store.close()` without awaiting it, because no React cleanup can await, and that
 * close awaits its adapter before it reaches `IDBDatabase.close()`. Deleting in the
 * same turn as the unmount would race the connection it is deleting behind, and
 * `blocked` is what such a race looks like from here.
 */
export async function resetDurableConsoleState(): Promise<void> {
  cleanup();
  await settleOneTurn();
  await deleteConsoleDatabase();
}

/**
 * Delete the console's database, or throw saying which way it did not go.
 *
 * LOUD ON `blocked`, which is the outcome worth naming rather than the one worth
 * tolerating: the request is not refused by that event, it WAITS — for a connection
 * nothing is going to close — so a caller that ignored it hangs until the tier's
 * timeout, and one that resolved on it hands the next mount the records this exists
 * to remove. Both are silent, and the second is the one that minted a reference in
 * the wrong state.
 *
 * A MISSING `indexedDB` THROWS TOO. Every caller is a browser-mode tier running in
 * a real Chromium page, where the global is always present; a host without one is a
 * host on which this function isolates nothing, and answering quietly there would
 * report the absence of isolation as isolation.
 */
async function deleteConsoleDatabase(): Promise<void> {
  if (typeof indexedDB === "undefined") {
    throw new Error(
      `this page has no indexedDB global, so ${CONSOLE_DATABASE_NAME} cannot be deleted and every ` +
        "case after this one would mount over the records the case before it wrote",
    );
  }

  const deletion = indexedDB.deleteDatabase(CONSOLE_DATABASE_NAME);
  await new Promise<void>((resolve, reject) => {
    deletion.onsuccess = (): void => {
      resolve();
    };
    deletion.onerror = (): void => {
      reject(
        new Error(
          `${CONSOLE_DATABASE_NAME} refused to be deleted (${describeDeletionFailure(deletion.error)}), ` +
            "so the next mount would be restored into the arrangement the last one left",
        ),
      );
    };
    deletion.onblocked = (): void => {
      reject(
        new Error(
          `${CONSOLE_DATABASE_NAME} is still open, so its deletion is blocked: a console mounted ` +
            "earlier in this page never had its store closed, and the next mount would be restored " +
            "into the arrangement that console left",
        ),
      );
    };
  });
}

/** What a refused deletion is called, for the sentence that reports it. */
function describeDeletionFailure(error: DOMException | null): string {
  return error === null ? "no reason given" : error.name;
}
