// The map joins commands to bindings, and the recorder reads one keystroke as one
// act. Every verdict about a binding SET is the keybinding service's own and is
// driven where that service is asked (`palette/keybinding-audit.test.ts`).

import { describe, expect, it } from "vitest";

import {
  composeEffectiveBindings,
  type ConsoleCommand,
  type KeyBinding,
} from "../../../palette/index.js";
import {
  composeKeybindingRows,
  composeStaleOverrideRows,
  matchKeybindingRows,
  readChordFromEvent,
  type ChordRecording,
} from "./keybinding-map.js";

function command(id: string, title: string, group = "Navigation"): ConsoleCommand {
  return { id, title, group, run: () => undefined };
}

/** One keystroke, as the recorder receives it. Only the fields it reads. */
function press(
  fields: Partial<
    Pick<KeyboardEvent, "key" | "code" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">
  >,
): Parameters<typeof readChordFromEvent>[0] {
  return {
    key: "",
    code: "",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...fields,
  };
}

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
    const rows = composeKeybindingRows({
      commands,
      bindings,
      shippedBindings: bindings,
      platform: "darwin",
    });
    const workspace = rows.find((row) => row.commandId === "frame.goToWorkflows");
    expect(workspace?.chord).toBe("$mod+2");
    expect(workspace?.whenExpression).toBe("sessionActive");
  });

  it("leaves a command with no binding without a chord rather than inventing one", () => {
    const rows = composeKeybindingRows({
      commands,
      bindings,
      shippedBindings: bindings,
      platform: "darwin",
    });
    expect(rows.find((row) => row.commandId === "app.checkForUpdates")?.chord).toBeUndefined();
  });

  it("orders by category and then by name, so the list matches the palette", () => {
    const rows = composeKeybindingRows({
      commands,
      bindings,
      shippedBindings: bindings,
      platform: "darwin",
    });
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
      shippedBindings: bindings,
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

  it("marks the rows a person changed, including one they left with no chord", () => {
    const rows = composeKeybindingRows({
      commands,
      bindings,
      shippedBindings: bindings,
      overrides: { "frame.goToSessions": "$mod+1", "app.checkForUpdates": null },
      platform: "darwin",
    });
    const changed = rows.filter((row) => row.overridden).map((row) => row.commandId);
    expect(changed).toStrictEqual(["app.checkForUpdates", "frame.goToSessions"]);
  });

  it("carries the chord the console ships, so a reset can name what it restores", () => {
    // Composed against a CHANGED effective table: the shipped chord has to survive
    // being overridden, which is the one case a reset control exists for.
    const rows = composeKeybindingRows({
      commands,
      bindings: [{ chord: "$mod+9", commandId: "frame.goToSessions" }, ...bindings.slice(1)],
      shippedBindings: bindings,
      overrides: { "frame.goToSessions": "$mod+9" },
      platform: "darwin",
    });
    const changed = rows.find((row) => row.commandId === "frame.goToSessions");
    expect(changed?.chord).toBe("$mod+9");
    expect(changed?.shippedChord).toBe("$mod+1");
  });

  it("leaves a command the console ships no chord for without a default to restore", () => {
    // "back to no chord" and "back to some chord" are different promises, and only
    // an absent `shippedChord` can carry the first one honestly.
    const rows = composeKeybindingRows({
      commands,
      bindings,
      shippedBindings: bindings,
      platform: "darwin",
    });
    expect(
      rows.find((row) => row.commandId === "app.checkForUpdates")?.shippedChord,
    ).toBeUndefined();
  });

  it("negative control: with no overrides, no row claims to have been changed", () => {
    // Without this the case above would pass over a composer that marked every row,
    // and the page would offer a reset on rows with nothing to reset.
    const rows = composeKeybindingRows({
      commands,
      bindings,
      shippedBindings: bindings,
      platform: "darwin",
    });
    expect(rows.some((row) => row.overridden)).toBe(false);
  });
});

describe("reading a keystroke as a chord", () => {
  it("composes the held modifiers and the physical key, in the console's order", () => {
    const read = readChordFromEvent(
      press({ key: "K", code: "KeyK", metaKey: true, shiftKey: true }),
      "darwin",
    );
    expect(read).toStrictEqual<ChordRecording>({ outcome: "captured", chord: "$mod+Shift+KeyK" });
  });

  it("writes the platform's command modifier as `$mod` and the other one literally", () => {
    // `⌃` and `⌘` are two different keys on macOS, so a recorder that folded them
    // together would install the chord on the wrong one.
    expect(readChordFromEvent(press({ key: "k", code: "KeyK", ctrlKey: true }), "darwin")).toEqual({
      outcome: "captured",
      chord: "Control+KeyK",
    });
    expect(readChordFromEvent(press({ key: "k", code: "KeyK", ctrlKey: true }), "win32")).toEqual({
      outcome: "captured",
      chord: "$mod+KeyK",
    });
  });

  it("does not complete on a modifier held on its own", () => {
    // A person on the way to ⌘⇧K passes through ⌘ and ⌘⇧; settling on either would
    // bind the wrong chord every time.
    expect(
      readChordFromEvent(press({ key: "Meta", code: "MetaLeft", metaKey: true }), "darwin"),
    ).toEqual({ outcome: "incomplete", heldModifiers: ["$mod"] });
    expect(
      readChordFromEvent(
        press({ key: "Shift", code: "ShiftLeft", metaKey: true, shiftKey: true }),
        "darwin",
      ),
    ).toEqual({ outcome: "incomplete", heldModifiers: ["$mod", "Shift"] });
  });

  it("cancels on Escape and clears on Backspace or Delete, pressed alone", () => {
    expect(readChordFromEvent(press({ key: "Escape", code: "Escape" }))).toEqual({
      outcome: "cancelled",
    });
    expect(readChordFromEvent(press({ key: "Backspace", code: "Backspace" }))).toEqual({
      outcome: "cleared",
    });
    expect(readChordFromEvent(press({ key: "Delete", code: "Delete" }))).toEqual({
      outcome: "cleared",
    });
  });

  it("negative control: the same keys held with a modifier are chords, not commands", () => {
    // Without this, `$mod+Backspace` — a chord somebody may legitimately want —
    // would be unbindable, because the recorder would read it as a clearing.
    expect(
      readChordFromEvent(press({ key: "Backspace", code: "Backspace", metaKey: true }), "darwin"),
    ).toEqual({ outcome: "captured", chord: "$mod+Backspace" });
    expect(
      readChordFromEvent(press({ key: "Escape", code: "Escape", shiftKey: true }), "darwin"),
    ).toEqual({ outcome: "captured", chord: "Shift+Escape" });
  });

  it("falls back to the key when the host supplies no physical code", () => {
    expect(readChordFromEvent(press({ key: "F5", code: "" }))).toEqual({
      outcome: "captured",
      chord: "F5",
    });
  });
});

describe("filtering rows", () => {
  const bindings: readonly KeyBinding[] = [
    { chord: "$mod+1", commandId: "frame.goToSessions", when: "sessionActive" },
  ];
  const rows = composeKeybindingRows({
    commands: [
      command("frame.goToSessions", "Go to sessions"),
      command("app.checkForUpdates", "Check for updates", "Application"),
    ],
    bindings,
    shippedBindings: bindings,
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

  it("narrows on the chord and on the when-scope, the section's other two axes", () => {
    expect(matchKeybindingRows(rows, "$mod+1").map((row) => row.commandId)).toStrictEqual([
      "frame.goToSessions",
    ]);
    expect(matchKeybindingRows(rows, "sessionActive").map((row) => row.commandId)).toStrictEqual([
      "frame.goToSessions",
    ]);
  });

  it("negative control: a query nothing matches narrows to nothing", () => {
    // A filter that always answered everything would satisfy the assertions above.
    expect(matchKeybindingRows(rows, "zzzqqq")).toHaveLength(0);
  });
});

describe("composing the overrides that belong to no command", () => {
  const commands = [command("frame.goToSessions", "Go to sessions")];
  const shippedBindings: readonly KeyBinding[] = [
    { chord: "$mod+1", commandId: "frame.goToSessions" },
  ];

  it("reports an override whose command this build does not have, with its chord", () => {
    const stale = composeStaleOverrideRows({
      commands,
      shippedBindings,
      overrides: { "frame.goToSessions": "Alt+KeyS", "retired.oldCommand": "Alt+KeyQ" },
    });
    expect(stale).toStrictEqual([{ commandId: "retired.oldCommand", chord: "Alt+KeyQ" }]);
  });

  it("proves the entry it reports really does reserve its chord", () => {
    // Which is why it has to be drawn at all: the effective table appends the unknown
    // command's binding, so the chord is live and refuses somebody else's rebinding
    // while the rows above — built from the registered commands — cannot show it.
    const overrides = { "retired.oldCommand": "Alt+KeyQ" };
    const effective = composeEffectiveBindings(shippedBindings, overrides);
    expect(effective).toContainEqual({ chord: "Alt+KeyQ", commandId: "retired.oldCommand" });
    expect(composeStaleOverrideRows({ commands, shippedBindings, overrides })).toHaveLength(1);
  });

  it("negative control: an override on a registered command is not stale", () => {
    // Without this, the cases above would pass over a function that called every
    // override stale — which would offer a Remove control for every chord a person
    // had deliberately chosen.
    expect(
      composeStaleOverrideRows({
        commands,
        shippedBindings,
        overrides: { "frame.goToSessions": "Alt+KeyS" },
      }),
    ).toStrictEqual([]);
  });

  it("stops reporting a command as stale the moment that command registers", () => {
    // Hydration is deliberately permissive because families register at module scope
    // as they load, so an override read before its family registered is legitimate.
    // The same map, read once each side of that registration, must answer differently.
    const overrides = { "late.family.act": "Alt+KeyQ" };
    expect(composeStaleOverrideRows({ commands, shippedBindings, overrides })).toHaveLength(1);
    expect(
      composeStaleOverrideRows({
        commands: [...commands, command("late.family.act", "A late act")],
        shippedBindings,
        overrides,
      }),
    ).toStrictEqual([]);
  });

  it("negative control: a cleared override is not stale, because it reserves nothing", () => {
    // `null` is a person saying a command should have no chord. It appends no
    // binding, so there is no chord to be in anybody's way and nothing to remove.
    expect(
      composeStaleOverrideRows({
        commands,
        shippedBindings,
        overrides: { "retired.oldCommand": null },
      }),
    ).toStrictEqual([]);
  });

  it("negative control: an override the shipped table binds is not stale", () => {
    // A command the table binds but the registry has not registered yet is a real
    // shipped chord being rebound, not a leftover.
    expect(
      composeStaleOverrideRows({
        commands: [],
        shippedBindings,
        overrides: { "frame.goToSessions": "Alt+KeyS" },
      }),
    ).toStrictEqual([]);
  });
});
