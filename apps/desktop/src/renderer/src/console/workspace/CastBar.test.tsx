// The cast bar's two honest absences, and the line it is not allowed to say.
//
// Both of the things §4.1 asks this bar to show that the console cannot get —
// presence and session spend — have to render as the "not checked" kind of nothing
// rather than as a green dot and a zero. Either would be a claim nobody measured,
// and a screenshot cannot tell an unmeasured green dot from a measured one.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SessionStore } from "../store/index.js";
import { CastBar } from "./CastBar.js";

const SESSION_ID = "session-cast";

function storeWith(
  participantIds: readonly string[],
  timeline: readonly { sequence: number; kind: string; actorParticipantId: string }[] = [],
): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialise({
    cursor: timeline.length,
    entities: [],
    participantJoinLog: participantIds,
    timeline: timeline.map((row) => ({
      sessionId: SESSION_ID,
      sequence: row.sequence,
      kind: row.kind,
      occurredAt: "2026-01-01T14:20:00.000Z",
      actorParticipantId: row.actorParticipantId,
    })),
  });
  return store;
}

function renderBar(element: React.JSX.Element): HTMLElement {
  const { container } = render(element);
  const bar = container.querySelector(".meridian-cast-bar");
  if (!(bar instanceof HTMLElement)) {
    throw new Error("CastBar rendered no bar element");
  }
  return bar;
}

describe("CastBar — the session's identity", () => {
  it("renders the id wire-verbatim rather than a title nothing carries", () => {
    const bar = renderBar(
      <CastBar
        sessionId={SESSION_ID}
        sessionStore={storeWith(["participant-you"])}
        onFollow={() => undefined}
      />,
    );
    expect(bar.querySelector(".meridian-cast-bar__identity")?.textContent).toContain(SESSION_ID);
  });

  it("says the session is opening rather than drawing an empty cast", () => {
    const bar = renderBar(
      <CastBar sessionId={SESSION_ID} sessionStore={undefined} onFollow={() => undefined} />,
    );
    expect(bar.textContent).toContain("This session is opening.");
    expect(bar.querySelectorAll(".meridian-cast-chip")).toHaveLength(0);
  });
});

describe("CastBar — one chip per participant", () => {
  it("renders a chip per participant in join order, each with its verb", () => {
    const bar = renderBar(
      <CastBar
        sessionId={SESSION_ID}
        sessionStore={storeWith(
          ["participant-you", "agent-architect"],
          [{ sequence: 1, kind: "tool.invoked", actorParticipantId: "agent-architect" }],
        )}
        onFollow={() => undefined}
      />,
    );
    const chips = [...bar.querySelectorAll(".meridian-cast-chip")];
    expect(chips).toHaveLength(2);
    expect(chips[1]?.textContent).toContain("agent-architect");
    expect(chips[1]?.querySelector(".meridian-cast-chip__verb")?.textContent).toBe(
      "running a tool",
    );
  });

  it("gives a participant with no row no verb at all", () => {
    const bar = renderBar(
      <CastBar
        sessionId={SESSION_ID}
        sessionStore={storeWith(["participant-you"])}
        onFollow={() => undefined}
      />,
    );
    expect(bar.querySelectorAll(".meridian-cast-chip__verb")).toHaveLength(0);
  });

  it("follows the participant whose chip was pressed", () => {
    const followed: string[] = [];
    const bar = renderBar(
      <CastBar
        sessionId={SESSION_ID}
        sessionStore={storeWith(["participant-you", "agent-architect"])}
        onFollow={(participantId) => {
          followed.push(participantId);
        }}
      />,
    );
    bar.querySelectorAll<HTMLButtonElement>(".meridian-cast-chip")[1]?.click();
    expect(followed).toStrictEqual(["agent-architect"]);
  });

  it("says nobody has joined rather than rendering an empty row", () => {
    const bar = renderBar(
      <CastBar sessionId={SESSION_ID} sessionStore={storeWith([])} onFollow={() => undefined} />,
    );
    expect(bar.textContent).toContain("Nobody has joined this session yet.");
  });
});

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

describe("CastBar — the all-clear line", () => {
  it("says nothing needs you when nothing does", () => {
    const bar = renderBar(
      <CastBar
        sessionId={SESSION_ID}
        sessionStore={storeWith(
          ["agent-architect"],
          [{ sequence: 1, kind: "run.running", actorParticipantId: "agent-architect" }],
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
          [{ sequence: 1, kind: "approval.requested", actorParticipantId: "agent-architect" }],
        )}
        onFollow={() => undefined}
      />,
    );
    expect(bar.textContent).not.toContain("Nothing needs you.");
  });
});
