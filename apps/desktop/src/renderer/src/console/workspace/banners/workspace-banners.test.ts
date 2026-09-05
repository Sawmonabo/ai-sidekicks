// One banner per thing that happened, and one identity per banner.
//
// The stack is a fold over raises, so the cases below are about what the fold keeps:
// a repeat is counted rather than appended, a difference in ANY of the three fields is
// a different banner, and dismissing one leaves the others exactly as they were —
// which is what lets the render key on the identity rather than on a position.

import { describe, expect, it } from "vitest";

import { refuse } from "../../core/index.js";
import {
  dismissWorkspaceBanner,
  raiseWorkspaceBanner,
  workspaceBannerKey,
  type WorkspaceBanner,
} from "./workspace-banners.js";

const SAVE_FAILED = refuse(
  "workspace",
  "layout-save-failed",
  "This window's pane arrangement could not be saved.",
);
const DETACH_REFUSED = refuse(
  "auxiliary-handoff",
  "wire-unregistered",
  "The window wire is not registered.",
);

function raiseAll(...refusals: readonly (typeof SAVE_FAILED)[]): readonly WorkspaceBanner[] {
  return refusals.reduce<readonly WorkspaceBanner[]>(
    (current, refusal) => raiseWorkspaceBanner(current, refusal),
    [],
  );
}

describe("the workspace banner stack", () => {
  it("counts an identical refusal rather than stacking it", () => {
    // A failing store raises this on every pane the person moves, so a drag used to
    // produce a column of identical banners saying one thing.
    const banners = raiseAll(SAVE_FAILED, SAVE_FAILED, SAVE_FAILED);

    expect(banners).toHaveLength(1);
    expect(banners[0]?.repeatCount).toBe(3);
  });

  it("negative control: a refusal differing in any one field is its own banner", () => {
    // Without this, the case above would pass over a fold that counted every raise as
    // the same one and showed a person a count where a second fact belonged.
    const otherDetail = refuse(
      SAVE_FAILED.origin,
      SAVE_FAILED.code,
      "This window's sidebar arrangement could not be saved.",
    );
    const otherCode = refuse(SAVE_FAILED.origin, "wire-unregistered", SAVE_FAILED.detail);
    const otherOrigin = refuse("persistence", SAVE_FAILED.code, SAVE_FAILED.detail);

    expect(raiseAll(SAVE_FAILED, otherDetail, otherCode, otherOrigin)).toHaveLength(4);
  });

  it("leaves a standing banner in place when a repeat arrives, and its neighbours untouched", () => {
    // The render keys on the identity, so a repeat that re-ordered the stack would
    // move a dismiss control out from under the pointer reaching for it.
    const raised = raiseAll(SAVE_FAILED, DETACH_REFUSED);
    const afterRepeat = raiseWorkspaceBanner(raised, SAVE_FAILED);

    expect(afterRepeat.map((banner) => banner.refusal.code)).toStrictEqual([
      "layout-save-failed",
      "wire-unregistered",
    ]);
    // The neighbour is the same entry, not a rebuilt one carrying the same fields.
    expect(afterRepeat[1]).toBe(raised[1]);
  });

  it("dismisses by identity and leaves every other banner as it was", () => {
    const raised = raiseAll(SAVE_FAILED, DETACH_REFUSED);
    const remaining = dismissWorkspaceBanner(raised, workspaceBannerKey(SAVE_FAILED));

    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBe(raised[1]);
  });

  it("negative control: dismissing an identity nothing carries removes nothing", () => {
    // Without this, the case above would pass over a dismissal that emptied the stack
    // whatever it was handed.
    const raised = raiseAll(SAVE_FAILED, DETACH_REFUSED);

    expect(dismissWorkspaceBanner(raised, "no-such-banner")).toStrictEqual(raised);
  });
});
