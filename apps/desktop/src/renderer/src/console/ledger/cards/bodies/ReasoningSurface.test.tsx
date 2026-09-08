// The four arms, the tail, and the one control — each rendered as itself.

import type { EventCursor, ReasoningSurfaceReadResponse, RunId } from "@ai-sidekicks/contracts";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { REASONING_SURFACE_SLOT, type ReasoningSurfaceReading } from "./reasoning-surface.js";
import { ReasoningSurface } from "./ReasoningSurface.js";

const SAMPLE_RUN_ID = "01J0000000000000000000000B" as RunId;

function renderSurface(
  overrides: {
    readonly runId?: RunId | undefined;
    readonly liveText?: string;
    readonly reading?: ReasoningSurfaceReading;
    readonly onExpand?: () => void;
    readonly body?: (props: { readonly runId: RunId }) => React.ReactNode;
  } = {},
): HTMLElement {
  const { container } = render(
    <ReasoningSurface
      slot={{ contract: REASONING_SURFACE_SLOT, body: overrides.body }}
      runId={"runId" in overrides ? overrides.runId : SAMPLE_RUN_ID}
      liveText={overrides.liveText}
      reading={overrides.reading ?? { status: "not-asked" }}
      onExpand={overrides.onExpand ?? (() => undefined)}
    />,
  );
  return container;
}

/** An `available` reply with entries and no continuation. */
function availableReply(bodies: readonly string[]): ReasoningSurfaceReadResponse {
  return {
    availability: "available",
    hasMore: false,
    reasoningEntries: bodies.map((content, index) => ({
      sequence: index,
      content,
      timestamp: "2026-09-02T10:00:00.000Z",
    })),
  };
}

describe("the four availability arms", () => {
  it("renders the entries on the available arm", () => {
    const container = renderSurface({
      reading: { status: "read", response: availableReply(["weighed the two branches"]) },
    });
    expect(container.textContent).toContain("weighed the two branches");
  });

  it("says a redaction is a withholding and shows the daemon's own reason", () => {
    const container = renderSurface({
      reading: {
        status: "read",
        response: { availability: "policy_redacted", policyReason: "org-policy-7" },
      },
    });
    expect(container.textContent).toContain("withheld by policy");
    expect(container.textContent).toContain("org-policy-7");
  });

  it("negative control: a redaction never renders as an absence of reasoning", () => {
    // Without the arm split, `policy_redacted` and `unavailable` would render the
    // same empty body and a reader could not tell withheld from never-captured.
    const redacted = renderSurface({
      reading: {
        status: "read",
        response: { availability: "policy_redacted", policyReason: "org-policy-7" },
      },
    });
    const unavailable = renderSurface({
      reading: { status: "read", response: { availability: "unavailable" } },
    });
    expect(redacted.textContent).not.toBe(unavailable.textContent);
    // The unavailable arm says the opposite in as many words — "Nothing is being
    // withheld here" — so the check is on the redaction's own claim rather than on
    // the word, which both arms are entitled to use.
    expect(unavailable.textContent).not.toContain("withheld by policy");
    expect(unavailable.textContent).not.toContain("org-policy-7");
  });

  it("negative control: a compacted surface is not an unavailable one", () => {
    const compacted = renderSurface({
      reading: { status: "read", response: { availability: "compacted" } },
    });
    const unavailable = renderSurface({
      reading: { status: "read", response: { availability: "unavailable" } },
    });
    expect(compacted.textContent).toContain("compacted");
    expect(compacted.textContent).not.toBe(unavailable.textContent);
  });

  it("says a bounded page has a continuation nobody asked for", () => {
    const container = renderSurface({
      reading: {
        status: "read",
        response: {
          availability: "available",
          hasMore: true,
          nextCursor: "cursor-01" as EventCursor,
          reasoningEntries: [
            { sequence: 0, content: "first", timestamp: "2026-09-02T10:00:00.000Z" },
          ],
        },
      },
    });
    expect(container.textContent).toContain("More reasoning follows this page.");
  });
});

describe("the streaming tail", () => {
  it("shows the newest lines while a turn streams", () => {
    const container = renderSurface({ liveText: "one\ntwo\nthree\nfour" });
    expect(container.textContent).toContain("four");
    expect(container.textContent).not.toContain("one");
  });

  it("renders the tail beside a read rather than instead of it", () => {
    const container = renderSurface({
      liveText: "still going",
      reading: { status: "read", response: availableReply(["settled entry"]) },
    });
    expect(container.textContent).toContain("still going");
    expect(container.textContent).toContain("settled entry");
  });

  it("negative control: a settled row renders no tail at all", () => {
    const container = renderSurface();
    expect(container.querySelector(".meridian-reasoning-surface__tail")).toBeNull();
  });
});

describe("the expand control", () => {
  it("asks for the surface when it is pressed", () => {
    const onExpand = vi.fn();
    const container = renderSurface({ onExpand });
    container.querySelector<HTMLButtonElement>(".meridian-reasoning-surface__expand")?.click();
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it("is absent on a row the run-scoped read could never address", () => {
    const container = renderSurface({ runId: undefined });
    expect(container.querySelector(".meridian-reasoning-surface__expand")).toBeNull();
  });

  it("is absent once the read has answered", () => {
    const container = renderSurface({
      reading: { status: "read", response: { availability: "unavailable" } },
    });
    expect(container.querySelector(".meridian-reasoning-surface__expand")).toBeNull();
  });

  it("is absent while a read is in flight", () => {
    const container = renderSurface({ reading: { status: "reading" } });
    expect(container.querySelector(".meridian-reasoning-surface__expand")).toBeNull();
  });

  it("survives a refusal and says which press it is", () => {
    // THE DEFECT, EXERCISED. The control was drawn on `not-asked` alone, so a read
    // refused by a transport that was down for a moment left the refusal on screen
    // with no way to ask again — which rule 9 forbids in terms ("a refusal never hides
    // the control that produced it").
    const onExpand = vi.fn();
    const container = renderSurface({
      onExpand,
      reading: {
        status: "refused",
        refusal: { code: "timeline.run_not_found", detail: "No such run.", origin: "daemon" },
      },
    });
    const control = container.querySelector<HTMLButtonElement>(
      ".meridian-reasoning-surface__expand",
    );
    expect(control?.textContent).toBe("Try the read again");
    control?.click();
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it("negative control: the refusal is still drawn beside the control that survived it", () => {
    // Without this, offering the retry by REPLACING the refusal would pass the case
    // above while hiding why the first press failed.
    const container = renderSurface({
      reading: {
        status: "refused",
        refusal: { code: "timeline.run_not_found", detail: "No such run.", origin: "daemon" },
      },
    });
    expect(container.textContent).toContain("timeline.run_not_found");
  });
});

describe("the states around the read", () => {
  it("says nothing at all before anybody asks", () => {
    const container = renderSurface();
    expect(container.textContent).not.toContain("captured");
  });

  it("renders a refusal with the daemon's own code", () => {
    const container = renderSurface({
      reading: {
        status: "refused",
        refusal: { code: "timeline.run_not_found", detail: "No such run.", origin: "daemon" },
      },
    });
    expect(container.textContent).toContain("timeline.run_not_found");
    expect(container.textContent).toContain("No such run.");
  });
});

describe("the plan-owned body", () => {
  it("replaces the shell entirely once it is mounted", () => {
    const container = renderSurface({
      body: () => <p>the real reasoning body</p>,
      reading: { status: "read", response: { availability: "unavailable" } },
    });
    expect(container.textContent).toBe("the real reasoning body");
  });
});
