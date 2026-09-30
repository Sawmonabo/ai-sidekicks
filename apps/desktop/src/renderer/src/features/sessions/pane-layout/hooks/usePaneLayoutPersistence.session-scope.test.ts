// What a route from one session to another leaves on the pane layout. The session screen stays
// mounted across a navigation between two open sessions, so anything the hook holds for the
// life of the mount is held across sessions: the restore refusals once outlived the session
// that raised them and showed under the next session's panes. Every case drives the real hook
// through `usePaneLayoutPersistence.test-support.tsx`. Ordering is in
// `usePaneLayoutPersistence.restore-order.test.ts` and the failed read in
// `usePaneLayoutPersistence.read-failure.test.ts`.

import { describe, expect, it } from "vitest";

import { memoryStore } from "../../SessionScreen.test-support.js";
import {
  RESTORE_SESSION_ID,
  createPaneLayoutStore,
  drain,
  mountPersistence,
  savePaneLayout,
  savePaneLayoutInUnknownVersion,
} from "./usePaneLayoutPersistence.test-support.js";

/** The session a case routes TO. Never the one the record with refusals belongs to. */
const SECOND_SESSION = "session-restore-second";

describe("usePaneLayoutPersistence — restore refusals belong to the session that raised them", () => {
  it("stops showing one session's restore refusals once another session has restored", async () => {
    // The refusals were mount state, so a session whose layout could not be read left its
    // errors over the next session's panes with nothing tying them to a session already left.
    const store = memoryStore();
    await savePaneLayoutInUnknownVersion(store, RESTORE_SESSION_ID);
    const mounted = mountPersistence(createPaneLayoutStore(), store);
    await drain();
    expect(mounted.restoreRefusalCodes()).toStrictEqual(["snapshot-version-unknown"]);

    mounted.routeTo(SECOND_SESSION);
    await drain();

    // The second session has no record, which is a settled restore with nothing to refuse, and
    // a settled restore replaces the reading.
    expect(mounted.restoreRefusalCodes()).toStrictEqual([]);
  });

  it("shows nothing for a session whose restore has not settled yet", async () => {
    // The other half of "replace on every settled restore": before one settles there is no
    // reading, and the previous session's is not a stand-in.
    const store = memoryStore();
    await savePaneLayoutInUnknownVersion(store, RESTORE_SESSION_ID);
    const mounted = mountPersistence(createPaneLayoutStore(), store);
    await drain();

    mounted.routeTo(SECOND_SESSION);

    // The refusals are gone at once, not lingering until something replaces them.
    expect(mounted.restoreRefusalCodes()).toStrictEqual([]);
    await drain();
  });

  it("shows the second session's own refusals where it has them", async () => {
    // Replacement rather than clearing: a session that cannot read its arrangement says so.
    const store = memoryStore();
    await savePaneLayout(store, ["transcript"], RESTORE_SESSION_ID);
    await savePaneLayoutInUnknownVersion(store, SECOND_SESSION);
    const mounted = mountPersistence(createPaneLayoutStore(), store);
    await drain();
    expect(mounted.restoreRefusalCodes()).toStrictEqual([]);

    mounted.routeTo(SECOND_SESSION);
    await drain();

    expect(mounted.restoreRefusalCodes()).toStrictEqual(["snapshot-version-unknown"]);
  });

  it("negative control: a session that refuses its restore renders that refusal at all", async () => {
    // Without this, a hook that returned an empty list would pass the two cases above.
    const store = memoryStore();
    await savePaneLayoutInUnknownVersion(store, RESTORE_SESSION_ID);
    const mounted = mountPersistence(createPaneLayoutStore(), store);

    await drain();

    expect(mounted.restoreRefusalCodes()).toStrictEqual(["snapshot-version-unknown"]);
  });
});
