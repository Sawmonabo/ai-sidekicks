// Every verdict about a binding set comes from the keybinding table; the reserved-chord table
// lists only a host's own chords.

import { describe, expect, it } from "vitest";

import { auditKeybindings, reservedChordReason } from "./keybinding-audit.js";

describe("reserved chords", () => {
  it("names the reason a host takes a chord", () => {
    expect(reservedChordReason("$mod+Space", "darwin")).toContain("Spotlight");
    expect(reservedChordReason("Alt+Tab", "win32")).toContain("Windows");
  });

  it("negative control: an ordinary chord is not reserved anywhere", () => {
    // Without this, a table that called every chord reserved would pass the case above.
    expect(reservedChordReason("$mod+KeyK", "darwin")).toBeUndefined();
    expect(reservedChordReason("$mod+Space", "linux")).toBeUndefined();
  });
});

describe("auditing a binding set", () => {
  it("reports nothing wrong with a set that is well formed and disjoint", () => {
    const audit = auditKeybindings([
      { chord: "$mod+1", commandId: "frame.goToSessions" },
      { chord: "$mod+2", commandId: "frame.goToWorkflows", when: "sessionActive" },
    ]);
    expect(audit.conflicts).toHaveLength(0);
    expect(audit.dropped).toHaveLength(0);
  });

  it("negative control: two commands on one chord in one scope are named as a conflict", () => {
    // The clean result above means nothing unless the audit detects a real conflict.
    const audit = auditKeybindings([
      { chord: "$mod+1", commandId: "frame.goToSessions" },
      { chord: "$mod+1", commandId: "frame.goToWorkflows" },
    ]);
    expect(audit.conflicts).toHaveLength(1);
    expect(audit.conflicts[0]?.commandIds).toStrictEqual([
      "frame.goToSessions",
      "frame.goToWorkflows",
    ]);
  });

  it("negative control: a chord the service cannot parse is reported as dropped", () => {
    const audit = auditKeybindings([{ chord: "", commandId: "frame.goToSessions" }]);
    expect(audit.dropped).toHaveLength(1);
    expect(audit.dropped[0]?.commandId).toBe("frame.goToSessions");
    expect(audit.dropped[0]?.reason.length).toBeGreaterThan(0);
  });

  it("keeps two disjoint scopes on one chord out of the conflict list", () => {
    const audit = auditKeybindings([
      { chord: "$mod+1", commandId: "frame.goToSessions", when: "onSettings" },
      { chord: "$mod+1", commandId: "frame.goToWorkflows", when: "!onSettings" },
    ]);
    expect(audit.conflicts).toHaveLength(0);
  });
});
