// The cast bar's two honest absences, the two things the wire DOES carry, and the
// line it is not allowed to say.
//
// Both of the things `Spec-023 §The surface set` asks this bar to show that the
// console cannot get — presence and session spend — have to render as the "not
// checked" kind of nothing rather than as a green dot and a zero. Either would be a
// claim nobody measured,
// and a screenshot cannot tell an unmeasured green dot from a measured one.
//
// The other half is the mirror image: a name and an attention state the wire DOES
// carry, which the bar has to render rather than discard. Both are asserted through
// the chip, because a model that derives a value no renderer reads is a fold whose
// only observable effect is a sentence disappearing somewhere else on the bar.

import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SessionStore } from "../store/index.js";
import { CastBar } from "./CastBar.js";

const SESSION_ID = "session-cast";

// UUID v7 values, spelled the way the wire spells them and minted at one instant —
// which is the whole of the naming problem: the two below share a fifteen-character
// prefix, and the chip's own ellipsis truncates both to the same visible string.
const PARTICIPANT_PRIYA = "019b79ee-0280-79a4-8120-cca0117a0120";
const AGENT_ARCHITECT = "019b79ee-0280-7a6e-8110-d1a4c1150001";

interface TimelineRow {
  readonly sequence: number;
  readonly kind: string;
  readonly actorParticipantId: string;
  /** The event's own payload — where every label and every correlation id lives. */
  readonly payload?: Readonly<Record<string, unknown>>;
}

function storeWith(
  participantIds: readonly string[],
  timeline: readonly TimelineRow[] = [],
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
      ...(row.payload === undefined ? {} : { payload: row.payload }),
    })),
  });
  return store;
}

/** The membership beat that names a person, in the shape the wire registers. */
function admittedMember(sequence: number, participantId: string, handle: string): TimelineRow {
  return {
    sequence,
    kind: "membership.created",
    actorParticipantId: participantId,
    payload: {
      membershipId: `membership-${String(sequence)}`,
      participantId,
      role: "collaborator",
      identityHandle: handle,
    },
  };
}

/**
 * The attach beat that names an agent.
 *
 * Its actor is the person who attached the agent and never the agent — which is why
 * the name has to be read off the payload's `agentId` rather than off the envelope.
 */
function attachedAgent(sequence: number, agentId: string, name: string): TimelineRow {
  return {
    sequence,
    kind: "agent.attached",
    actorParticipantId: "participant-you",
    payload: { sessionId: SESSION_ID, agentId, name, state: "ready", actor: "participant-you" },
  };
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
          ["participant-you", AGENT_ARCHITECT],
          [
            attachedAgent(1, AGENT_ARCHITECT, "Architect"),
            { sequence: 2, kind: "tool.invoked", actorParticipantId: AGENT_ARCHITECT },
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
              actorParticipantId: PARTICIPANT_PRIYA,
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
      within(bar).getByRole("button", { name: "priya, waiting on approval, needs you" }),
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
              actorParticipantId: "participant-you",
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

describe("CastBar — the chip that needs you", () => {
  /** A blocked run, and a later ordinary row from a DIFFERENT run by the same actor. */
  function blockedInOneRunBusyInAnother(): readonly TimelineRow[] {
    return [
      attachedAgent(1, AGENT_ARCHITECT, "Architect"),
      {
        sequence: 2,
        kind: "run.waiting_for_approval",
        actorParticipantId: AGENT_ARCHITECT,
        payload: { runId: "run-a" },
      },
      {
        sequence: 3,
        kind: "tool.invoked",
        actorParticipantId: AGENT_ARCHITECT,
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
    // The state is the chip's ground and its name. The ring is untouched: it
    // answers "who", and two participants sharing a wheel step have only it.
    expect(chip?.getAttribute("data-attention")).toBe("true");
    expect(chip?.getAttribute("data-ring")).toBe("solid");
    expect(
      within(bar).getByRole("button", { name: "Architect, running a tool, needs you" }),
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
              actorParticipantId: AGENT_ARCHITECT,
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
              actorParticipantId: AGENT_ARCHITECT,
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
