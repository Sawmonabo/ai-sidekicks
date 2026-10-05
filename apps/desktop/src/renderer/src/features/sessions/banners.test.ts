// One banner per thing a person is told. The column is a fold over raises: a repeat leaves the
// standing banner as it is, other words are another banner, and dismissing one leaves the others
// untouched, which lets the render key on identity.

import { describe, expect, it } from "vitest";

import {
  PANE_LAYOUT_NOT_SAVED_BANNER,
  dismissSessionBanner,
  raiseSessionBanner,
  sessionBannerKey,
  type SessionBanner,
} from "./banners.js";

const OTHER_BANNER: SessionBanner = { words: ["Pane layout not saved", "it will save later"] };

function raiseAll(...banners: readonly SessionBanner[]): readonly SessionBanner[] {
  return banners.reduce<readonly SessionBanner[]>(
    (current, banner) => raiseSessionBanner(current, banner),
    [],
  );
}

describe("the session screen banner column", () => {
  it("keeps one banner, unchanged, when the same banner is raised again", () => {
    // A failing store refuses a save on every pane moved; a drag must not stack identical banners.
    const raised = raiseAll(PANE_LAYOUT_NOT_SAVED_BANNER, OTHER_BANNER);

    expect(raiseSessionBanner(raised, PANE_LAYOUT_NOT_SAVED_BANNER)).toBe(raised);
  });

  it("negative control: other words are a banner of their own", () => {
    // The case above would also pass over a fold that treated every raise as the same banner.
    expect(raiseAll(PANE_LAYOUT_NOT_SAVED_BANNER, OTHER_BANNER)).toHaveLength(2);
  });

  it("dismisses by identity and leaves every other banner as it was", () => {
    const raised = raiseAll(PANE_LAYOUT_NOT_SAVED_BANNER, OTHER_BANNER);
    const remaining = dismissSessionBanner(raised, sessionBannerKey(PANE_LAYOUT_NOT_SAVED_BANNER));

    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBe(raised[1]);
  });

  it("negative control: dismissing an identity nothing carries removes nothing", () => {
    // The case above would also pass over a dismissal that emptied the column whatever it got.
    const raised = raiseAll(PANE_LAYOUT_NOT_SAVED_BANNER, OTHER_BANNER);

    expect(dismissSessionBanner(raised, "no-such-banner")).toStrictEqual(raised);
  });
});
