// Both session-scoped reads in the destination's aside, and the address they are NOT
// keyed on.
//
// `SessionsSurface.test.tsx` next door holds the list's own three kinds of nothing
// and the act of starting a session. This file holds the other job the destination
// does: the attention projection and the invitations list are each scoped to ONE
// session on the wire, and every address that mounts this surface is
// `kind: "sessions"` and names none — so a read keyed on the route asks about
// nothing at all and reports every session's answer as unasked. Each read is
// therefore asserted through a session THIS ADDRESS DOES NOT NAME.
//
// And the attention read has a second half that no query into the panel can see: a
// person who cannot read the screen is told what the read settled on through the
// console's one polite region, or is told nothing at all.

import { describe, expect, it } from "vitest";

import { contextWith, renderSurface, settle } from "./session-surface.test-support.js";

describe("what the destination puts beside the list", () => {
  it("mounts the invitations shelf and the attention panel", () => {
    const { container } = renderSurface(contextWith({}));
    expect(container.querySelector(".meridian-invite-shelf")).not.toBeNull();
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

describe("the invitations the destination reads for", () => {
  /**
   * One invitation as the port serves it. Pending AND unlapsed, so the shelf lists it.
   *
   * The expiry is far out rather than merely plausible, and that is what keeps these
   * cases about the fan-out. The shelf stops offering an invitation whose expiry has
   * passed, and this surface runs on the wall clock, so a nearby stamp would make
   * every case below start failing on a date rather than on a change.
   */
  function pendingInvite(inviteId: string): unknown {
    return { inviteId, state: "pending", expiresAt: "2999-01-01T00:00:00.000Z" };
  }

  it("asks once per session it can name, and names each of them", async () => {
    // The regression this arm exists for: the read was keyed on the route's
    // session, every address that mounts this surface names none, and the fan-out
    // was therefore empty forever. Under that reader this array stays `[]`.
    const invitesListCalls: string[] = [];
    renderSurface(
      contextWith({
        directorySessionIds: ["session-a", "session-b"],
        invitesListCalls,
      }),
    );
    await settle();
    expect(invitesListCalls).toStrictEqual(["session-a", "session-b"]);
  });

  it("lists an invitation for a session this address does not name", async () => {
    const { container } = renderSurface(
      contextWith({
        directorySessionIds: ["session-a"],
        invitesBySessionId: { "session-a": [pendingInvite("invite-1")] },
      }),
    );
    await settle();
    const text = container.textContent ?? "";
    expect(text).toContain("invite-1");
    expect(text).not.toContain("No invitations have been read.");
  });

  it("does not let one session's refusal hide another session's invitation", async () => {
    // Each session's outcome travels on its own, so a partial read is a partial
    // read. A fan-out that collapsed to the first answer would render the refusal
    // and drop the invitation that did arrive — and one that dropped the refusal
    // would hide a session the console never got an answer from, so both are on
    // screen and neither stands for the other.
    const { container } = renderSurface(
      contextWith({
        directorySessionIds: ["session-refused", "session-served"],
        invitesBySessionId: { "session-served": [pendingInvite("invite-2")] },
      }),
    );
    await settle();
    const text = container.textContent ?? "";
    expect(text).toContain("invite-2");
    expect(text).toContain("the invitesList read is not registered yet");
  });

  it("negative control: asks nothing when it can name no session", async () => {
    // Without this, the fan-out could pass by asking about a session it invented.
    // A console holding none has nothing to ask about, and the shelf says exactly
    // that rather than reporting an empty inbox.
    const invitesListCalls: string[] = [];
    const { container } = renderSurface(contextWith({ invitesListCalls }));
    await settle();
    expect(invitesListCalls).toStrictEqual([]);
    expect(container.textContent ?? "").toContain("No invitations have been read.");
  });
});
