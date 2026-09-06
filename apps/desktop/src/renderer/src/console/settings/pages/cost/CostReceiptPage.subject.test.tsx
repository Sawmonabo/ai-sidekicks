// Which session the figure on screen belongs to, and the frame that used to lie.
//
// The receipt is the one surface in this family where the wrong answer is a currency
// figure, so the subject rule is checked at the resolution the defect had: ONE
// COMMITTED FRAME. The page held the read in `useState` and cleared it at the top of
// its effect, which is first within the effect and therefore one commit after the
// render that renamed the session — so that commit painted session A's money, its
// per-run rows, and its per-paying-account rows under session B's name.
//
// A case that looks at the DOM after `rerender` cannot see it: `act` flushes the
// passive effect before returning. The frames are recorded from a LAYOUT effect
// instead, which React runs after the commit's DOM mutations and before any passive
// effect — see `core/committed-frame.test-support.tsx`.

import { describe, expect, it } from "vitest";

import {
  SESSION_ID,
  balancedReceipt,
  bridgeServing,
  renderMovableCostPage,
  settle,
} from "./cost-receipt-page.test-support.js";

const OTHER_SESSION_ID = "session-cost-other";

/** A row id only a served receipt puts on screen, so its presence names a figure. */
const SERVED_RUN_ID = "run-alpha";

describe("the cost page — the session a figure belongs to", () => {
  it("commits no frame carrying the previous session's rows under the new one", async () => {
    const page = renderMovableCostPage(bridgeServing(balancedReceipt()), SESSION_ID);
    await settle();
    expect(page.container.textContent ?? "").toContain(SERVED_RUN_ID);

    page.forgetFrames();
    page.showSession(OTHER_SESSION_ID);

    // Every frame, not just the last: the defect was one frame that was painted and
    // then replaced, which is exactly the frame a person sees.
    expect(page.frames.filter((frame) => frame.includes(SERVED_RUN_ID))).toStrictEqual([]);
    expect(page.frames[0] ?? "").toContain("Reading this session's receipt");
  });

  it("negative control: the recorder does see the rows while the session holds", async () => {
    // Without this, the case above would hold for a recorder that captured nothing,
    // and the frame it exists to inspect would go unexamined while the suite stayed
    // green.
    const page = renderMovableCostPage(bridgeServing(balancedReceipt()), SESSION_ID);
    await settle();

    expect(page.frames.filter((frame) => frame.includes(SERVED_RUN_ID))).not.toStrictEqual([]);
  });

  it("reads the new session's receipt once the frame after it settles", async () => {
    const page = renderMovableCostPage(bridgeServing(balancedReceipt()), SESSION_ID);
    await settle();
    page.showSession(OTHER_SESSION_ID);
    await settle();

    expect(page.container.textContent ?? "").toContain(SERVED_RUN_ID);
  });
});
