// The create form's model, driven without mounting anything.
//
// The four functions here are the ones a rendered case exercises only incidentally —
// the fallback a stale choice takes, the shape of the link, and the two tables the
// compiler holds to the wire's own vocabulary.

import { describe, expect, it } from "vitest";

import { MILLISECONDS_PER_DAY } from "../../core/index.js";
import {
  DEFAULT_INVITE_EXPIRY_ID,
  INVITE_EXPIRY_CHOICES,
  JOIN_MODES,
  JOIN_MODE_NOTES,
  composeInviteLink,
  inviteExpiryChoice,
  inviteExpiryInstant,
} from "./invite-draft.js";

/** An arbitrary instant with no significance beyond being fixed. */
const NOW_MS = Date.UTC(2026, 0, 1, 10, 5, 0);

describe("the join modes a form may offer", () => {
  it("offers exactly the wire's three, and never ownership", () => {
    // `MembershipRole` carries `owner` beside these; `JoinMode` does not, and an
    // invitation that granted it would be granting what no invite verb can.
    expect(JOIN_MODES).toEqual(["viewer", "collaborator", "runtime contributor"]);
    expect(JOIN_MODES).not.toContain("owner");
  });

  it("says what each one grants, in a sentence", () => {
    for (const mode of JOIN_MODES) {
      expect(JOIN_MODE_NOTES[mode].grants.length).toBeGreaterThan(0);
    }
  });
});

describe("the expiries a form may offer", () => {
  it("starts on the week the corpus fixes as the default", () => {
    expect(inviteExpiryChoice(DEFAULT_INVITE_EXPIRY_ID).days).toBe(7);
  });

  it("answers a choice that has since left the list with that same default", () => {
    // Total by construction: a caller holding an id from an older list gets the
    // corpus's default rather than an invitation with no expiry at all.
    expect(inviteExpiryChoice("90d")).toEqual(inviteExpiryChoice(DEFAULT_INVITE_EXPIRY_ID));
  });

  it("negative control: a live id is answered with its own row", () => {
    // Without this the case above would pass over a function that ignored its
    // argument and answered the default every time.
    expect(inviteExpiryChoice("1d").days).toBe(1);
  });

  it("offers them shortest first", () => {
    const days = INVITE_EXPIRY_CHOICES.map((choice) => choice.days);
    expect(days).toEqual([...days].sort((left, right) => left - right));
  });

  it("measures the instant off the clock it is handed", () => {
    expect(inviteExpiryInstant(NOW_MS, 7)).toBe(
      new Date(NOW_MS + 7 * MILLISECONDS_PER_DAY).toISOString(),
    );
    expect(inviteExpiryInstant(NOW_MS, 7)).toMatch(/Z$/u);
  });
});

describe("the link an invitation is sent as", () => {
  it("composes the form the spec fixes, and adds nothing to it", () => {
    expect(composeInviteLink("sidekicks.example", "v4.local.abc")).toBe(
      "https://sidekicks.example/invite/v4.local.abc",
    );
  });
});
