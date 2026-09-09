// Every verdict about a binding set comes back from the keybinding service, and the
// reserved-chord table names a host's own chords and nothing else.

import { describe, expect, it } from "vitest";

import { auditKeybindings, reservedChordReason } from "./keybinding-audit.js";
import { AUXILIARY_MENU_CHORDS } from "../../../../../shared/auxiliary-menu-chords.js";

describe("reserved chords", () => {
  it("names the reason a host takes a chord", () => {
    expect(reservedChordReason("$mod+Space", "darwin")).toContain("Spotlight");
    expect(reservedChordReason("Alt+Tab", "win32")).toContain("Windows");
  });

  it("negative control: an ordinary chord is not reserved anywhere", () => {
    // Without this the assertions above would pass over a table that called every
    // chord reserved, which would render the whole keyboard unavailable.
    expect(reservedChordReason("$mod+KeyK", "darwin")).toBeUndefined();
    expect(reservedChordReason("$mod+Space", "linux")).toBeUndefined();
  });

  it("reports every menu accelerator as reserved, whichever spelling it is asked in", () => {
    // Electron consumes a menu accelerator BEFORE the renderer's key-binding table sees
    // the keystroke, so a chord the menu owns is a chord no binding can ever run — and
    // nothing else reports it: the binding installs, the keyboard page lists it as
    // live, `conflictsIn` sees no second binding, and the command simply never fires.
    //
    // BOTH SPELLINGS, because the chords are written in `tinykeys` grammar where
    // `$mod+Shift+t` and `$mod+Shift+KeyT` are one keystroke and two strings. A
    // `toLowerCase()` comparison passes the first of these and fails the second, and
    // the second is the spelling the bindings use — which is the direction that
    // matters. Swept over EVERY accelerator rather than a sample, so a route added to
    // the menu is covered on the day it lands.
    for (const chord of Object.values(AUXILIARY_MENU_CHORDS)) {
      expect(reservedChordReason(chord, "darwin")).toBeDefined();
      expect(
        reservedChordReason(
          chord.replace(/Key([A-Z])$/, (_match, letter: string) => letter.toLowerCase()),
          "darwin",
        ),
      ).toBeDefined();
    }
  });

  it("is swept over a menu that actually declares accelerators", () => {
    // The tripwire: without it the sweep above passes vacuously the day the menu's
    // chord record is emptied or the import resolves to something else.
    expect(Object.values(AUXILIARY_MENU_CHORDS).length).toBeGreaterThan(0);
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
    // The clean result above means nothing unless the audit bites. It is the real
    // keybinding service answering, so a conflict rule that changed there changes
    // every reader's report in the same act.
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
