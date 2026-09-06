// The two things the cast bar's wire DOES carry: who is in the session, and what each
// of them is called.
//
// Both are asserted through the chip, because a model that derives a value no renderer
// reads is a fold whose only observable effect is a sentence disappearing somewhere
// else on the bar. The naming problem is the sharp one: two UUID v7 values minted at
// one instant share a fifteen-character prefix, and the chip's own ellipsis truncates
// both to the same visible string, so a bar that fell back to ids would render two
// participants under one name.
//
// What the bar must NOT say — the unmeasured presence dot, the unmeasured spend, the
// all-clear line — is `CastBar.absence.test.tsx`.

import { within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CastBar } from "./CastBar.js";
import {
  AGENT_ARCHITECT,
  PARTICIPANT_PRIYA,
  SESSION_ID,
  admittedMember,
  attachedAgent,
  renderBar,
  storeWith,
} from "./CastBar.test-support.js";

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

  it("says the session is opening, and holds the bar's height while it does", () => {
    const bar = renderBar(
      <CastBar
        sessionId={SESSION_ID}
        sessionStore={undefined}
        expectedMemberCount={3}
        onFollow={() => undefined}
      />,
    );
    expect(bar.textContent).toContain("This session is opening.");
    // One placeholder per member the caller was told about, so the bar is already the
    // height it will be when the chips arrive and nothing below it moves.
    expect(bar.querySelectorAll(".meridian-cast-chip--skeleton")).toHaveLength(3);
    // And they name nobody: every one of them is a placeholder, so a screenshot of a
    // session mid-open cannot be read as a session with three unnamed participants.
    expect(bar.querySelectorAll(".meridian-cast-chip")).toHaveLength(3);
    expect(bar.querySelectorAll(".meridian-cast-chip__name")).toHaveLength(0);
    expect(bar.querySelector(".meridian-cast-bar__members")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("negative control: with no member count it draws one placeholder, never none", () => {
    // Without this the case above would pass over a skeleton that sized itself from
    // the caller alone — and a window restoring a route it saved last run holds no
    // membership slice, which is the common case rather than the rare one. A bar that
    // drew nothing there is the height jump this exists to prevent.
    const bar = renderBar(
      <CastBar sessionId={SESSION_ID} sessionStore={undefined} onFollow={() => undefined} />,
    );
    expect(bar.querySelectorAll(".meridian-cast-chip--skeleton")).toHaveLength(1);
  });
});

describe("CastBar — one chip per participant", () => {
  it("renders a chip per participant in join order, each with its verb", () => {
    const bar = renderBar(
      <CastBar
        sessionId={SESSION_ID}
        sessionStore={storeWith(
          ["participant-you", AGENT_ARCHITECT],
          [
            attachedAgent(1, AGENT_ARCHITECT, "Architect"),
            { sequence: 2, kind: "tool.invoked", actorId: AGENT_ARCHITECT },
          ],
        )}
        onFollow={() => undefined}
      />,
    );
    const chips = [...bar.querySelectorAll(".meridian-cast-chip")];
    expect(chips).toHaveLength(2);
    expect(chips[1]?.querySelector(".meridian-cast-chip__name")?.textContent).toBe("Architect");
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

describe("CastBar — the name the wire gave each participant", () => {
  it("renders the identity handle a membership beat carried, and keeps the id as its tooltip", () => {
    const bar = renderBar(
      <CastBar
        sessionId={SESSION_ID}
        sessionStore={storeWith(
          [PARTICIPANT_PRIYA],
          [admittedMember(1, PARTICIPANT_PRIYA, "priya")],
        )}
        onFollow={() => undefined}
      />,
    );
    const name = bar.querySelector(".meridian-cast-chip__name");
    expect(name?.textContent).toBe("priya");
    // The id is not lost — it is where a person can reach it without it being the
    // only thing on the chip.
    expect(name?.getAttribute("title")).toBe(PARTICIPANT_PRIYA);
    expect(name?.textContent).not.toContain(PARTICIPANT_PRIYA);
  });

  it("speaks the chip as the identifier and the verb, which is the name the model composes", () => {
    const bar = renderBar(
      <CastBar
        sessionId={SESSION_ID}
        sessionStore={storeWith(
          [PARTICIPANT_PRIYA],
          [
            admittedMember(1, PARTICIPANT_PRIYA, "priya"),
            {
              sequence: 2,
              kind: "run.waiting_for_approval",
              actorId: PARTICIPANT_PRIYA,
              payload: { runId: "run-a" },
            },
          ],
        )}
        onFollow={() => undefined}
      />,
    );
    // Composed rather than concatenated out of the chip's children: the presence
    // glyph is an image with a name, so the DOM's own computation would open every
    // chip with "Presence has not been read". The documented example is the head of
    // the name; a chip that is waiting on a person also says so.
    expect(
      within(bar).getByRole("button", { name: "priya, waiting on approval, waiting on you" }),
    ).toBeDefined();
  });

  it("lets a rename land, because the fold's last writer wins", () => {
    const bar = renderBar(
      <CastBar
        sessionId={SESSION_ID}
        sessionStore={storeWith(
          [AGENT_ARCHITECT],
          [
            attachedAgent(1, AGENT_ARCHITECT, "Architect"),
            {
              sequence: 2,
              kind: "agent.config_updated",
              actorId: "participant-you",
              payload: { sessionId: SESSION_ID, agentId: AGENT_ARCHITECT, name: "Planner" },
            },
          ],
        )}
        onFollow={() => undefined}
      />,
    );
    expect(bar.querySelector(".meridian-cast-chip__name")?.textContent).toBe("Planner");
  });

  it("negative control: a participant the log never named still renders its id", () => {
    // Without this, every case above would pass over a chip that had learned to
    // invent a name — which is the one rendering worse than a UUID, because a reader
    // cannot tell an invention from a reading.
    const bar = renderBar(
      <CastBar
        sessionId={SESSION_ID}
        sessionStore={storeWith([PARTICIPANT_PRIYA])}
        onFollow={() => undefined}
      />,
    );
    const name = bar.querySelector(".meridian-cast-chip__name");
    expect(name?.textContent).toBe(PARTICIPANT_PRIYA);
    expect(name?.getAttribute("title")).toBeNull();
  });
});
