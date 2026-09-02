// The map joins commands to bindings, and every verdict about a binding set comes
// back from the keybinding service rather than from a second rule here.

import { describe, expect, it } from "vitest";

import type { ConsoleCommand, KeyBinding } from "../../palette/index.js";
import {
  auditKeybindings,
  composeKeybindingRows,
  matchKeybindingRows,
  reservedChordReason,
} from "./keybinding-map.js";

function command(id: string, title: string, group = "Navigation"): ConsoleCommand {
  return { id, title, group, run: () => undefined };
}

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
});

describe("composing rows", () => {
  const commands = [
    command("frame.goToWorkflows", "Go to workflows"),
    command("frame.goToSessions", "Go to sessions"),
    command("app.checkForUpdates", "Check for updates", "Application"),
  ];
  const bindings: readonly KeyBinding[] = [
    { chord: "$mod+1", commandId: "frame.goToSessions" },
    { chord: "$mod+2", commandId: "frame.goToWorkflows", when: "sessionActive" },
  ];

  it("carries each command's chord and the scope of that chord", () => {
    const rows = composeKeybindingRows({ commands, bindings, platform: "darwin" });
    const workspace = rows.find((row) => row.commandId === "frame.goToWorkflows");
    expect(workspace?.chord).toBe("$mod+2");
    expect(workspace?.whenExpression).toBe("sessionActive");
  });

  it("leaves a command with no binding without a chord rather than inventing one", () => {
    const rows = composeKeybindingRows({ commands, bindings, platform: "darwin" });
    expect(rows.find((row) => row.commandId === "app.checkForUpdates")?.chord).toBeUndefined();
  });

  it("orders by category and then by name, so the list matches the palette", () => {
    const rows = composeKeybindingRows({ commands, bindings, platform: "darwin" });
    expect(rows.map((row) => row.commandId)).toStrictEqual([
      "app.checkForUpdates",
      "frame.goToSessions",
      "frame.goToWorkflows",
    ]);
  });

  it("marks a bound chord the host takes, and leaves the others unmarked", () => {
    const rows = composeKeybindingRows({
      commands,
      bindings: [{ chord: "$mod+Space", commandId: "frame.goToSessions" }, ...bindings.slice(1)],
      platform: "darwin",
    });
    expect(rows.find((row) => row.commandId === "frame.goToSessions")?.unavailableReason).toContain(
      "Spotlight",
    );
    // The negative half of the same claim: marking every row would be as wrong as
    // marking none, and only the reserved one carries a reason.
    expect(
      rows.find((row) => row.commandId === "frame.goToWorkflows")?.unavailableReason,
    ).toBeUndefined();
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
    // this page's report in the same act.
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

describe("filtering rows", () => {
  const rows = composeKeybindingRows({
    commands: [
      command("frame.goToSessions", "Go to sessions"),
      command("app.checkForUpdates", "Check for updates", "Application"),
    ],
    bindings: [],
    platform: "darwin",
  });

  it("answers every row before anything is typed", () => {
    expect(matchKeybindingRows(rows, "   ")).toHaveLength(2);
  });

  it("narrows on the name, and on the command id", () => {
    expect(matchKeybindingRows(rows, "sessions").map((row) => row.commandId)).toStrictEqual([
      "frame.goToSessions",
    ]);
    expect(matchKeybindingRows(rows, "app.check").map((row) => row.commandId)).toStrictEqual([
      "app.checkForUpdates",
    ]);
  });

  it("negative control: a query nothing matches narrows to nothing", () => {
    // A filter that always answered everything would satisfy the assertions above.
    expect(matchKeybindingRows(rows, "zzzqqq")).toHaveLength(0);
  });
});
