// One banner per thing a person is told, and one identity per banner.
//
// The column is a fold over raises, so the cases below are about what the fold keeps:
// a repeat leaves the standing banner as it is, other words are another banner, and
// dismissing one leaves the others exactly as they were — which is what lets the
// render key on the identity rather than on a position.

import { describe, expect, it } from "vitest";

import {
  PANE_LAYOUT_NOT_SAVED_BANNER,
  dismissSessionBanner,
  raiseSessionBanner,
  sessionBannerKey,
  type SessionBanner,
} from "./session-banners.js";

const OTHER_BANNER: SessionBanner = { words: ["Pane layout not saved", "it will save later"] };

function raiseAll(...banners: readonly SessionBanner[]): readonly SessionBanner[] {
  return banners.reduce<readonly SessionBanner[]>(
    (current, banner) => raiseSessionBanner(current, banner),
    [],
  );
}

describe("the session screen banner column", () => {
  it("keeps one banner, unchanged, when the same banner is raised again", () => {
    // A failing store refuses a save on every pane the person moves, so a drag used to
    // produce a column of identical banners saying one thing.
    const raised = raiseAll(PANE_LAYOUT_NOT_SAVED_BANNER, OTHER_BANNER);

    expect(raiseSessionBanner(raised, PANE_LAYOUT_NOT_SAVED_BANNER)).toBe(raised);
  });

  it("negative control: other words are a banner of their own", () => {
    // Without this, the case above would pass over a fold that took every raise as the
    // same banner and hid a second thing a person had to be told.
    expect(raiseAll(PANE_LAYOUT_NOT_SAVED_BANNER, OTHER_BANNER)).toHaveLength(2);
  });

  it("dismisses by identity and leaves every other banner as it was", () => {
    const raised = raiseAll(PANE_LAYOUT_NOT_SAVED_BANNER, OTHER_BANNER);
    const remaining = dismissSessionBanner(raised, sessionBannerKey(PANE_LAYOUT_NOT_SAVED_BANNER));

    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBe(raised[1]);
  });

  it("negative control: dismissing an identity nothing carries removes nothing", () => {
    // Without this, the case above would pass over a dismissal that emptied the column
    // whatever it was handed.
    const raised = raiseAll(PANE_LAYOUT_NOT_SAVED_BANNER, OTHER_BANNER);

    expect(dismissSessionBanner(raised, "no-such-banner")).toStrictEqual(raised);
  });
});
