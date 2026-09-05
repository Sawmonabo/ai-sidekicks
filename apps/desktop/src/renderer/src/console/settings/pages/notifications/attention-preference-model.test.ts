// The one rule that decides how an unnamed preference is shown, and the one edit it
// permits.
//
// Both halves are worth holding. The rule has to refuse to draw switches for a value
// it cannot vouch for, or the page starts offering controls over data it does not
// understand; and the edit has to carry the WHOLE value, or a write erases every
// member beside the one that was pressed.

import { describe, expect, it } from "vitest";

import {
  announcementFor,
  flipMember,
  isToggleableValue,
  projectPreferenceRows,
  type AttentionPreference,
  type AttentionPreferenceReadOutcome,
} from "./attention-preference-model.js";

function preference(key: string, value: Readonly<Record<string, unknown>>): AttentionPreference {
  return { key, value };
}

describe("isToggleableValue — a value is switches only when every member is one", () => {
  it("accepts a value whose members are all booleans", () => {
    expect(isToggleableValue({ mentions: true, runs: false })).toBe(true);
  });

  it("negative control: one member that is not a boolean takes the whole value out", () => {
    // Drawing switches for the boolean members and dropping the rest would show a
    // record the daemon never sent, and a write would then send that record back.
    expect(isToggleableValue({ mentions: true, quietHours: "22:00" })).toBe(false);
    expect(isToggleableValue({ mentions: true, nested: { runs: true } })).toBe(false);
  });

  it("refuses the empty record, which is vacuously all-boolean and has nothing to draw", () => {
    // A key with no switches under it reads as a control that failed to paint, so
    // `{}` takes the read-only arm and renders as itself.
    expect(isToggleableValue({})).toBe(false);
  });
});

describe("flipMember — the whole value comes back, with one member changed", () => {
  it("flips the named member in both directions", () => {
    expect(flipMember({ mentions: true, runs: false }, "mentions")).toStrictEqual({
      mentions: false,
      runs: false,
    });
    expect(flipMember({ mentions: true, runs: false }, "runs")).toStrictEqual({
      mentions: true,
      runs: true,
    });
  });

  it("keeps every member it was not asked about, including the ones already off", () => {
    // The update carries a record and not a patch, so a returned fragment would have
    // the write erase whatever it left out — and a member already `false` is exactly
    // the one a careless implementation drops.
    expect(flipMember({ mentions: true, runs: false, digests: false }, "mentions")).toStrictEqual({
      mentions: false,
      runs: false,
      digests: false,
    });
  });

  it("negative control: a member the record does not hold is not invented", () => {
    // Flipping an absent member as though it were `false` would add a key to a
    // record the daemon owns, and the write would then store it.
    const value = { mentions: true };
    expect(flipMember(value, "runs")).toStrictEqual({ mentions: true });
    expect(Object.hasOwn(flipMember(value, "runs"), "runs")).toBe(false);
  });
});

describe("projectPreferenceRows — which arm each stored value lands on", () => {
  it("draws an all-boolean value as one switch per member, in the wire's own order", () => {
    const [row] = projectPreferenceRows([preference("attention", { runs: false, mentions: true })]);
    expect(row?.kind).toBe("toggles");
    if (row?.kind !== "toggles") {
      throw new Error("expected the toggles arm");
    }
    expect(row.members.map((member) => member.name)).toStrictEqual(["runs", "mentions"]);
    expect(row.members.map((member) => member.isEnabled)).toStrictEqual([false, true]);
    // The whole value rides the row, so an edit writes it back rather than a fragment.
    expect(row.value).toStrictEqual({ runs: false, mentions: true });
  });

  it("shows any other value read-only, exactly as it arrived", () => {
    const [row] = projectPreferenceRows([preference("digest", { every: "monday", runs: true })]);
    expect(row?.kind).toBe("opaque");
    if (row?.kind !== "opaque") {
      throw new Error("expected the opaque arm");
    }
    expect(row.rendering).toBe('{"every":"monday","runs":true}');
  });

  it("negative control: two preferences sharing a member name get distinct switch keys", () => {
    // The pending write and the refusal are held against a switch. Keyed on the
    // member name alone, pressing one preference's `mentions` would spin and then
    // refuse on the other preference's `mentions` as well.
    const rows = projectPreferenceRows([
      preference("channels", { mentions: true }),
      preference("runs", { mentions: false }),
    ]);
    const memberKeys = rows
      .flatMap((row) => (row.kind === "toggles" ? row.members : []))
      .map((member) => member.memberKey);
    expect(memberKeys).toHaveLength(2);
    expect(new Set(memberKeys).size).toBe(2);
  });

  it("keeps the preferences in the order the daemon sent them", () => {
    const rows = projectPreferenceRows([
      preference("zulu", { on: true }),
      preference("alpha", { on: true }),
    ]);
    expect(rows.map((row) => row.key)).toStrictEqual(["zulu", "alpha"]);
  });

  it("answers an empty set with no rows rather than with a row holding nothing", () => {
    expect(projectPreferenceRows([])).toStrictEqual([]);
  });
});

describe("announcementFor — what a settled read says out loud", () => {
  it("names what was read and how many, with no plural to get wrong", () => {
    const served: AttentionPreferenceReadOutcome = {
      status: "served",
      value: { preferences: [preference("attention", { runs: true })] },
    };
    expect(announcementFor(served)).toBe("Your notification preferences were read. Stored: 1.");
  });

  it("counts an empty set rather than saying nothing about it", () => {
    const served: AttentionPreferenceReadOutcome = { status: "served", value: { preferences: [] } };
    expect(announcementFor(served)).toBe("Your notification preferences were read. Stored: 0.");
  });

  it("negative control: a refusal is carried verbatim rather than paraphrased", () => {
    // Rule 9 renders the author's words. A house sentence here would say less than
    // what was actually refused, and would say it in the console's voice.
    const refused = {
      status: "unavailable",
      code: "wire-unregistered",
      detail: "Not checked — attention.preferenceRead is not registered yet.",
      origin: "growth-port",
    } as unknown as AttentionPreferenceReadOutcome;
    expect(announcementFor(refused)).toBe(
      "Not checked — attention.preferenceRead is not registered yet.",
    );
  });
});
