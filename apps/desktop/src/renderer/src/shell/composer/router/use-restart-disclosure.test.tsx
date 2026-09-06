// The window's one restart disclosure, said once and by whichever composer is
// focused first.
//
// Split along the seam the module was: the debt is the STORE's, so a second composer
// in the same window finds it already paid, and a disclosure said per composer would
// be the window announcing the same recovered draft twice.

import { fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DraftStore } from "../../../console/persistence/index.js";
import { bridgeAnswering } from "../../../console/bridge/fixture/fixture-bridge.test-support.js";
import { mountBar, openSessionStore } from "./composer-send-bar.test-support.js";

describe("ComposerSendBar — the store's restart disclosure, once", () => {
  it("says nothing until there is unsent text to say it about", () => {
    const draftStore = new DraftStore();
    const sessionStore = openSessionStore();
    const bridge = bridgeAnswering(async () => undefined).bridge;

    const mounted = mountBar({ bridge, draftStore, sessionStore });
    // The default state of every composer in every window, and what the captured
    // pixels hold: an untouched line says nothing about text nobody has typed. On
    // the shipped tree this sentence was in the DOM here, on every composer.
    expect(mounted.result.container.querySelector(".meridian-composer__notice")).toBeNull();

    fireEvent.focus(mounted.line);
    expect(draftStore.restartNoticePending).toBe(false);
    // Armed, still silent: focus alone is not text at risk.
    expect(mounted.result.container.querySelector(".meridian-composer__notice")).toBeNull();

    fireEvent.change(mounted.line, { target: { value: "unsent words" } });
    expect(mounted.result.container.textContent).toContain(draftStore.restartNoticeText);
  });

  it("keeps it to one composer per window, and out of the ones it never armed", () => {
    const draftStore = new DraftStore();
    const sessionStore = openSessionStore();
    const bridge = bridgeAnswering(async () => undefined).bridge;

    const first = mountBar({ bridge, draftStore, sessionStore });
    fireEvent.focus(first.line);
    first.result.unmount();

    // Once per window, not once per mount: a second composer takes the disclosure on
    // nowhere, so typing into it says nothing.
    const second = mountBar({ bridge, draftStore, sessionStore });
    fireEvent.focus(second.line);
    fireEvent.change(second.line, { target: { value: "more unsent words" } });
    expect(second.result.container.querySelector(".meridian-composer__notice")).toBeNull();
  });

  it("negative control: a store that owes no disclosure renders none at all", () => {
    const draftStore = new DraftStore({ restartNoticePending: false });
    const mounted = mountBar({
      bridge: bridgeAnswering(async () => undefined).bridge,
      draftStore,
      sessionStore: openSessionStore(),
    });
    fireEvent.focus(mounted.line);
    fireEvent.change(mounted.line, { target: { value: "unsent words" } });
    expect(mounted.result.container.querySelector(".meridian-composer__notice")).toBeNull();
  });
});
