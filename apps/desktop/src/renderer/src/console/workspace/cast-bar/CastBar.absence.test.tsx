// The cast bar's two honest absences, and the line it is not allowed to say.
//
// Both of the things `Spec-023 §The surface set` asks this bar to show that the
// console cannot get — presence and session spend — have to render as the "not
// checked" kind of nothing rather than as a green dot and a zero. Either would be a
// claim nobody measured, and a screenshot cannot tell an unmeasured green dot from a
// measured one. The all-clear line is the same rule stated positively: it may only
// appear where the bar has actually established that nobody needs anything.
//
// What the bar DOES render off the wire — the members and their names — is
// `CastBar.test.tsx`.

import { within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CastBar } from "./CastBar.js";
import {
  AGENT_ARCHITECT,
  SESSION_ID,
  attachedAgent,
  renderBar,
  storeWith,
  type TimelineRow,
} from "./CastBar.test-support.js";

describe("CastBar — what the console has not measured", () => {
  it("draws presence as unread rather than as a state", () => {
    const bar = renderBar(
      <CastBar
        sessionId={SESSION_ID}
        sessionStore={storeWith(["participant-you"])}
        onFollow={() => undefined}
      />,
    );
    const chip = bar.querySelector(".meridian-cast-chip");
    expect(chip?.querySelector("svg")?.getAttribute("aria-label")).toBe(
      "Presence has not been read",
    );
  });

  it("draws the spend figure as unread rather than as a zero", () => {
    const bar = renderBar(
      <CastBar
        sessionId={SESSION_ID}
        sessionStore={storeWith(["participant-you"])}
        onFollow={() => undefined}
      />,
    );
    const allClear = bar.querySelector(".meridian-cast-bar__all-clear");
    const badge = allClear?.querySelector(".meridian-nothing__badge-label");
    expect(badge?.textContent).toBe("Session spend");
    // The bar has room for a label and not for a sentence, so the second line is
    // the badge's tooltip — which is what `Nothing` does with a `detail` at this
    // placement, and the honest limit of the shape.
    expect(badge?.getAttribute("title")).toBe("No cost receipt has been read.");
    // The strongest form of "it never sums the rows": there is no figure at all.
    expect(allClear?.textContent).not.toMatch(/\$|\d+\.\d\d/);
  });
});

describe("CastBar — the chip that is waiting on you", () => {
  /** A blocked run, and a later ordinary row from a DIFFERENT run by the same actor. */
  function blockedInOneRunBusyInAnother(): readonly TimelineRow[] {
    return [
      attachedAgent(1, AGENT_ARCHITECT, "Architect"),
      {
        sequence: 2,
        kind: "run.waiting_for_approval",
        actorId: AGENT_ARCHITECT,
        payload: { runId: "run-a" },
      },
      {
        sequence: 3,
        kind: "tool.invoked",
        actorId: AGENT_ARCHITECT,
        payload: { runId: "run-b" },
      },
    ];
  }

  it("marks the blocked chip even while its visible verb is an ordinary one", () => {
    const bar = renderBar(
      <CastBar
        sessionId={SESSION_ID}
        sessionStore={storeWith([AGENT_ARCHITECT], blockedInOneRunBusyInAnother())}
        onFollow={() => undefined}
      />,
    );
    const chip = bar.querySelector(".meridian-cast-chip");
    // The state is the chip's WORDS and its name — never its colour. The ring is
    // untouched because it answers "who", and two participants sharing a wheel step
    // have only it; the chip carries no ground of its own for either question.
    expect(chip?.getAttribute("data-attention")).toBe("true");
    expect(chip?.getAttribute("data-ring")).toBe("solid");
    expect(chip?.querySelector(".meridian-cast-chip__verb")?.textContent).toBe("waiting on you");
    expect(
      within(bar).getByRole("button", { name: "Architect, running a tool, waiting on you" }),
    ).toBeDefined();
  });

  it("clears both the mark and the sentence once that run itself moves on", () => {
    const bar = renderBar(
      <CastBar
        sessionId={SESSION_ID}
        sessionStore={storeWith(
          [AGENT_ARCHITECT],
          [
            ...blockedInOneRunBusyInAnother(),
            {
              sequence: 4,
              kind: "run.running",
              actorId: AGENT_ARCHITECT,
              payload: { runId: "run-a" },
            },
          ],
        )}
        onFollow={() => undefined}
      />,
    );
    const chip = bar.querySelector(".meridian-cast-chip");
    expect(chip?.getAttribute("data-attention")).toBe("false");
    expect(chip?.getAttribute("aria-label")).toBe("Architect, working");
  });

  it("negative control: a chip with nothing outstanding is marked neither way", () => {
    // Without this, the cases above would pass over a chip that marked everybody —
    // which would put the whole bar in amber and identify nobody, the same failure
    // as marking nobody.
    const bar = renderBar(
      <CastBar
        sessionId={SESSION_ID}
        sessionStore={storeWith(
          [AGENT_ARCHITECT],
          [
            attachedAgent(1, AGENT_ARCHITECT, "Architect"),
            {
              sequence: 2,
              kind: "tool.invoked",
              actorId: AGENT_ARCHITECT,
              payload: { runId: "run-b" },
            },
          ],
        )}
        onFollow={() => undefined}
      />,
    );
    const chip = bar.querySelector(".meridian-cast-chip");
    expect(chip?.getAttribute("data-attention")).toBe("false");
    expect(chip?.getAttribute("aria-label")).toBe("Architect, running a tool");
  });
});

describe("CastBar — the all-clear line", () => {
  it("says nothing needs you when nothing does", () => {
    const bar = renderBar(
      <CastBar
        sessionId={SESSION_ID}
        sessionStore={storeWith(
          ["agent-architect"],
          [{ sequence: 1, kind: "run.running", actorId: "agent-architect" }],
        )}
        onFollow={() => undefined}
      />,
    );
    expect(bar.textContent).toContain("Nothing needs you.");
  });

  it("negative control: it goes silent the moment somebody is blocked", () => {
    // Without this, the case above would pass over a bar that printed the line
    // unconditionally — which is the one rendering that would be actively false.
    const bar = renderBar(
      <CastBar
        sessionId={SESSION_ID}
        sessionStore={storeWith(
          ["agent-architect"],
          [{ sequence: 1, kind: "approval.requested", actorId: "agent-architect" }],
        )}
        onFollow={() => undefined}
      />,
    );
    expect(bar.textContent).not.toContain("Nothing needs you.");
  });
});
