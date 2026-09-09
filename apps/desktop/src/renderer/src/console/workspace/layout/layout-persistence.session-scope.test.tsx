// What a route from one session to another leaves on the deck.
//
// The workspace stays MOUNTED across a navigation between two open sessions — the shell
// opens session stores and never closes them — so anything this hook holds for the life
// of the mount is held across sessions too. The restore refusals were exactly that: a
// session whose saved arrangement could not be read set them, and a session that
// restored cleanly never replaced them, so the deck went on showing the first session's
// restore errors under the second session's panes.
//
// Every case drives the real hook against a real `DeckLayout` and a real store through
// `layout-persistence.test-support.tsx`, which is where the mount and the route live.
// The ordering claims are `layout-persistence.restore-order.test.tsx`' and the failed
// read is `layout-persistence.read-failure.test.tsx`'.

import { describe, expect, it } from "vitest";

import { memoryStore } from "../Workspace.test-support.js";
import {
  RESTORE_SESSION,
  deckLayout,
  drain,
  mountPersistence,
  saveDeck,
  saveDeckInAnUnknownGrammar,
} from "./layout-persistence.test-support.js";

/** The session a case routes TO. Never the one the record with refusals belongs to. */
const SECOND_SESSION = "session-restore-second";

describe("useDeckPersistence — restore refusals belong to the session that raised them", () => {
  it("stops showing one session's restore refusals once another session has restored", async () => {
    // The defect: the refusals were mount state. A person who opened a session whose
    // saved layout could not be read, then navigated to a session that restored
    // cleanly, was shown the first session's errors over the second session's deck —
    // with nothing on screen tying them to a session they had left.
    const store = memoryStore();
    await saveDeckInAnUnknownGrammar(store, RESTORE_SESSION);
    const mounted = mountPersistence(deckLayout(), store);
    await drain();
    expect(mounted.restoreRefusalCodes()).toStrictEqual(["snapshot-version-unknown"]);

    mounted.routeTo(SECOND_SESSION);
    await drain();

    // The second session has no record at all, which is a settled restore with nothing
    // to refuse — and a settled restore replaces, empty report included.
    expect(mounted.restoreRefusalCodes()).toStrictEqual([]);
  });

  it("shows nothing for a session whose restore has not settled yet", async () => {
    // The other half of "replace on every settled restore": before one settles there is
    // no reading to show, and the previous session's is not a stand-in for it.
    const store = memoryStore();
    await saveDeckInAnUnknownGrammar(store, RESTORE_SESSION);
    const mounted = mountPersistence(deckLayout(), store);
    await drain();

    mounted.routeTo(SECOND_SESSION);

    // Routed, and the second session's read has not landed: the refusals are already
    // gone rather than lingering until something replaces them.
    expect(mounted.restoreRefusalCodes()).toStrictEqual([]);
    await drain();
  });

  it("shows the second session's own refusals where it has them", async () => {
    // Replacement rather than clearing: a session that cannot read its own arrangement
    // says so, whatever the session before it said.
    const store = memoryStore();
    await saveDeck(store, ["timeline"], RESTORE_SESSION);
    await saveDeckInAnUnknownGrammar(store, SECOND_SESSION);
    const mounted = mountPersistence(deckLayout(), store);
    await drain();
    expect(mounted.restoreRefusalCodes()).toStrictEqual([]);

    mounted.routeTo(SECOND_SESSION);
    await drain();

    expect(mounted.restoreRefusalCodes()).toStrictEqual(["snapshot-version-unknown"]);
  });

  it("negative control: a session that refuses its restore renders that refusal at all", async () => {
    // Without this, a hook that returned an empty list for every session would pass the
    // two cases above — and no restore would ever report anything.
    const store = memoryStore();
    await saveDeckInAnUnknownGrammar(store, RESTORE_SESSION);
    const mounted = mountPersistence(deckLayout(), store);

    await drain();

    expect(mounted.restoreRefusalCodes()).toStrictEqual(["snapshot-version-unknown"]);
  });
});
