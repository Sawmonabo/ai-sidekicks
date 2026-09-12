// The session-scoped read in the destination's aside, and the address it is NOT
// keyed on.
//
// `SessionsSurface.test.tsx` next door holds the list's own three kinds of nothing
// and the act of starting a session. This file holds the other job the destination
// does: the attention projection is scoped to ONE session on the wire, and every
// address that mounts this surface is `kind: "sessions"` and names none — so a read
// keyed on the route asks about nothing at all and reports every session's answer as
// unasked. The read is therefore asserted through a session THIS ADDRESS DOES NOT
// NAME.
//
// And the attention read has a second half that no query into the panel can see: a
// person who cannot read the screen is told what the read settled on through the
// console's one polite region, or is told nothing at all.

import { describe, expect, it } from "vitest";

import { contextWith } from "./session-surface.context.test-support.js";
import { renderSurface, settle } from "./session-surface.test-support.js";

describe("what the destination puts beside the list", () => {
  it("mounts the attention panel", () => {
    const { container } = renderSurface(contextWith({}));
    expect(container.querySelector(".meridian-attention")).not.toBeNull();
  });

  it("says the attention projection was not read, rather than that nothing needs anybody", async () => {
    const { container } = renderSurface(contextWith({}));
    await settle();
    const text = container.textContent ?? "";
    expect(text).toContain("The attention projection has not been read.");
    expect(text).not.toContain("Nothing needs you.");
  });

  it("asks about every session it can name, not only the one the address names", async () => {
    // The read is session-scoped on the wire and this destination is not, so the
    // proof is that an item raised for a session THIS ADDRESS DOES NOT NAME still
    // reaches the panel. Before the fan-out the surface read for the active session
    // and the address names none, so this panel could never populate at all.
    const { container } = renderSurface(
      contextWith({
        directorySessionIds: ["session-node"],
        attentionBySessionId: {
          "session-node": [
            {
              id: "attention-1",
              sessionId: "session-node",
              trigger: "pending_approval",
              severity: "actionable",
              summary: "A tool call is waiting on you.",
              sourceEventId: "event-1",
              createdAt: "2026-01-01T10:00:00.000Z",
            },
          ],
        },
      }),
    );
    await settle();
    const text = container.textContent ?? "";
    expect(text).toContain("A tool call is waiting on you.");
    expect(text).not.toContain("The attention projection has not been read.");
  });

  it("says what the attention read settled on, to a person who cannot see the panel", async () => {
    // The whole chain rather than the hook: the destination performs the read, the
    // sentence is composed from it, and the console's one polite region carries it.
    // Every arm of the panel above renders an absence or a count that a screen
    // reader is told nothing about unless this wiring exists, and a panel that
    // settles silently is the same silent failure as a panel that renders an
    // all-clear it did not earn.
    const { container, politeText } = renderSurface(
      contextWith({
        directorySessionIds: ["session-node", "session-quiet"],
        attentionBySessionId: {
          "session-node": [
            {
              id: "attention-1",
              sessionId: "session-node",
              trigger: "pending_approval",
              severity: "actionable",
              summary: "A tool call is waiting on you.",
              sourceEventId: "event-1",
              createdAt: "2026-01-01T10:00:00.000Z",
            },
          ],
        },
      }),
    );
    await settle();

    // One session answered and one refused, so both halves are owed: the count, and
    // the coverage the read does not have.
    expect(politeText()).toBe("One item needs you. One session could not be checked.");
    // And the sentence is the announcer's, not a second copy rendered into the
    // panel — the surface's own element does not carry it.
    expect(container.textContent ?? "").not.toContain("One item needs you.");
  });
});
