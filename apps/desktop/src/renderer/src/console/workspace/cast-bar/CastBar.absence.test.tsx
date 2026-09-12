// The session header's one honest absence, and the line it is not allowed to say.
//
// The session spend has to render as the "not checked" kind of nothing rather than as a
// zero. A zero is a claim nobody measured, and a screenshot cannot tell an unmeasured
// zero from a measured one. The all-clear line is the same rule stated positively: it
// may only appear where the header has actually established that nothing is waiting.
//
// What the header DOES render off an answered read is `CastBar.readings.test.tsx`.

import { describe, expect, it } from "vitest";

import { CastBar } from "./CastBar.js";
import { SESSION_ID, renderBar, storeWith, type TimelineRow } from "./CastBar.test-support.js";

const AGENT = "agent-architect";

describe("CastBar — what the console has not measured", () => {
  it("draws the spend figure as unread rather than as a zero", () => {
    const bar = renderBar(<CastBar sessionId={SESSION_ID} sessionStore={storeWith()} />);
    const allClear = bar.querySelector(".meridian-cast-bar__all-clear");
    const badge = allClear?.querySelector(".meridian-nothing__badge-label");
    expect(badge?.textContent).toBe("Session spend");
    // The header has room for a label and not for a sentence, so the second line is
    // the badge's tooltip — which is what `Nothing` does with a `detail` at this
    // placement, and the honest limit of the shape.
    expect(badge?.getAttribute("title")).toBe("No cost receipt has been read.");
    // The strongest form of "it never sums the rows": there is no figure at all.
    expect(allClear?.textContent).not.toMatch(/\$|\d+\.\d\d/);
  });
});

describe("CastBar — what is waiting on you", () => {
  /** A blocked run, and a later ordinary row from a DIFFERENT run. */
  function blockedInOneRunBusyInAnother(): readonly TimelineRow[] {
    return [
      {
        sequence: 1,
        kind: "run.waiting_for_approval",
        actorId: AGENT,
        payload: { runId: "run-a" },
      },
      { sequence: 2, kind: "tool.invoked", actorId: AGENT, payload: { runId: "run-b" } },
    ];
  }

  it("counts the blocked run even while a newer ordinary row followed it", () => {
    const bar = renderBar(
      <CastBar sessionId={SESSION_ID} sessionStore={storeWith(blockedInOneRunBusyInAnother())} />,
    );
    expect(bar.textContent).toContain("1 request is waiting on you.");
    expect(bar.textContent).not.toContain("Nothing needs you.");
  });

  it("clears the line once that run itself moves on", () => {
    const bar = renderBar(
      <CastBar
        sessionId={SESSION_ID}
        sessionStore={storeWith([
          ...blockedInOneRunBusyInAnother(),
          { sequence: 3, kind: "run.running", actorId: AGENT, payload: { runId: "run-a" } },
        ])}
      />,
    );
    expect(bar.textContent).not.toContain("waiting on you");
    expect(bar.textContent).toContain("Nothing needs you.");
  });

  it("says how many in the plural, counted and never rounded", () => {
    const bar = renderBar(
      <CastBar
        sessionId={SESSION_ID}
        sessionStore={storeWith([
          {
            sequence: 1,
            kind: "run.waiting_for_approval",
            actorId: AGENT,
            payload: { runId: "a" },
          },
          {
            sequence: 2,
            kind: "approval.requested",
            actorId: AGENT,
            payload: { approvalRequestId: "req-1" },
          },
        ])}
      />,
    );
    expect(bar.textContent).toContain("2 requests are waiting on you.");
  });
});

describe("CastBar — the all-clear line", () => {
  it("says nothing needs you when nothing does", () => {
    const bar = renderBar(
      <CastBar
        sessionId={SESSION_ID}
        sessionStore={storeWith([{ sequence: 1, kind: "run.running", actorId: AGENT }])}
      />,
    );
    expect(bar.textContent).toContain("Nothing needs you.");
  });

  it("negative control: it goes silent the moment something is blocked", () => {
    // Without this, the case above would pass over a header that printed the line
    // unconditionally — which is the one rendering that would be actively false.
    const bar = renderBar(
      <CastBar
        sessionId={SESSION_ID}
        sessionStore={storeWith([{ sequence: 1, kind: "approval.requested", actorId: AGENT }])}
      />,
    );
    expect(bar.textContent).not.toContain("Nothing needs you.");
  });
});
