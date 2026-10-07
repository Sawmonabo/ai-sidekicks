// The map joins commands to bindings, and the recorder reads one keystroke as one act. Verdicts
// about a binding set are the keybinding service's own, in
// `registries/keybindings/audit.ts`.

import { describe, expect, it } from "vitest";

import { type ChordPlatform } from "#renderer/lib/chord-format.js";
import { type Keybinding } from "#renderer/registries/commands/keybinding.js";
import { type CommandDefinition } from "#renderer/registries/commands/definition.js";
import { WHEN_SESSION_ACTIVE } from "#renderer/registries/commands/when-clause/vocabulary.js";
import { reservedChordReason } from "#renderer/registries/keybindings/audit.js";
import {
  composeKeybindingRows,
  matchKeybindingRows,
  readChordFromEvent,
  readHeldModifiersFromEvent,
  type ChordRecording,
} from "./keybinding-map.js";

function command(id: string, title: string, group = "App"): CommandDefinition {
  return { id, title, group, run: () => undefined };
}

/** One keystroke as the recorder receives it, with only the fields it reads. */
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

/**
 * Why the host takes the chord the recorder reads from this press, or `undefined`. The reserved
 * table matches the recorded spelling exactly, so this goes through the recorder.
 */
function hostReasonFor(
  platform: ChordPlatform,
  fields: Parameters<typeof press>[0],
): string | undefined {
  const recording = readChordFromEvent(press(fields), platform);
  return recording.outcome === "captured"
    ? reservedChordReason(recording.chord, platform)
    : undefined;
}

describe("composing rows", () => {
  const commands = [
    command("frame.goToWorkflows", "Workflows"),
    command("frame.goToSessions", "Sessions"),
    command("bridge.checkForUpdates", "Check for updates", "Help"),
  ];
  const bindings: readonly Keybinding[] = [
    { chord: "$mod+1", commandId: "frame.goToSessions" },
    { chord: "$mod+2", commandId: "frame.goToWorkflows", when: WHEN_SESSION_ACTIVE },
  ];

  it("carries each command's chord, and invents none for an unbound command", () => {
    const rows = composeKeybindingRows({
      commands,
      bindings,
      shippedBindings: bindings,
      platform: "darwin",
    });
    const workflows = rows.find((row) => row.commandId === "frame.goToWorkflows");
    expect(workflows?.chord).toBe("$mod+2");
    expect(rows.find((row) => row.commandId === "bridge.checkForUpdates")?.chord).toBeUndefined();
    // "Back to no chord" and "back to some chord" differ; only an absent `shippedChord` carries
    // the first.
    expect(
      rows.find((row) => row.commandId === "bridge.checkForUpdates")?.shippedChord,
    ).toBeUndefined();
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
    // Marking every row would be as wrong as marking none; only the reserved one has a reason.
    expect(
      rows.find((row) => row.commandId === "frame.goToWorkflows")?.unavailableReason,
    ).toBeUndefined();
  });

  it("marks the rows a person changed, including one they left with no chord", () => {
    const rows = composeKeybindingRows({
      commands,
      bindings,
      shippedBindings: bindings,
      overrides: { "frame.goToSessions": "$mod+1", "bridge.checkForUpdates": null },
      platform: "darwin",
    });
    const changed = rows.filter((row) => row.overridden).map((row) => row.commandId);
    // In the page's order: by group, so `App` before `Help`.
    expect(changed).toStrictEqual(["frame.goToSessions", "bridge.checkForUpdates"]);
  });

  it("carries the chord the app ships, so a reset can name what it restores", () => {
    // Composed against a changed effective table: the shipped chord must survive the override.
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
});

describe("reading a keystroke as a chord", () => {
  it("composes the held modifiers and the physical key, in the app's order", () => {
    const read = readChordFromEvent(
      press({ key: "K", code: "KeyK", metaKey: true, shiftKey: true }),
      "darwin",
    );
    expect(read).toStrictEqual<ChordRecording>({ outcome: "captured", chord: "$mod+Shift+KeyK" });
  });

  it("writes the platform's command modifier as `$mod` and the other one literally", () => {
    // On macOS `⌃` and `⌘` are different keys; folding them installs on the wrong one.
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
    // On the way to ⌘⇧K a person passes through ⌘ and ⌘⇧;
    // settling on either binds the wrong chord.
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
      outcome: "canceled",
    });
    expect(readChordFromEvent(press({ key: "Backspace", code: "Backspace" }))).toEqual({
      outcome: "cleared",
    });
    expect(readChordFromEvent(press({ key: "Delete", code: "Delete" }))).toEqual({
      outcome: "cleared",
    });
  });

  it("negative control: the same keys held with a modifier are chords, not commands", () => {
    // Guards `$mod+Backspace` from being unbindable by reading it as a clearing.
    expect(
      readChordFromEvent(press({ key: "Backspace", code: "Backspace", metaKey: true }), "darwin"),
    ).toEqual({ outcome: "captured", chord: "$mod+Backspace" });
    expect(
      readChordFromEvent(press({ key: "Escape", code: "Escape", shiftKey: true }), "darwin"),
    ).toEqual({ outcome: "captured", chord: "Shift+Escape" });
  });

  it("on Linux, reads each of GNOME's Escape chords as a chord the host takes", () => {
    const escape = { key: "Escape", code: "Escape" };
    for (const fields of [
      { altKey: true },
      { altKey: true, shiftKey: true },
      { ctrlKey: true, altKey: true },
      { ctrlKey: true, altKey: true, shiftKey: true },
      { metaKey: true },
    ]) {
      expect(hostReasonFor("linux", { ...escape, ...fields })).toMatch(/^GNOME /u);
    }
    // Negative control: Super+Shift+Esc is held by GNOME only during an input capture session.
    expect(hostReasonFor("linux", { ...escape, metaKey: true, shiftKey: true })).toBeUndefined();
  });

  it("on Windows, reads its Escape chords and every Windows-key chord as chords the host takes", () => {
    const escape = { key: "Escape", code: "Escape" };
    expect(hostReasonFor("win32", { ...escape, altKey: true })).toMatch(/switches windows/u);
    expect(hostReasonFor("win32", { ...escape, ctrlKey: true })).toMatch(/Start menu/u);
    expect(hostReasonFor("win32", { ...escape, ctrlKey: true, shiftKey: true })).toMatch(
      /Task Manager/u,
    );
    for (const fields of [
      { key: "e", code: "KeyE", metaKey: true },
      { key: "d", code: "KeyD", metaKey: true, ctrlKey: true },
      { key: "S", code: "KeyS", metaKey: true, shiftKey: true },
      { ...escape, metaKey: true },
    ]) {
      expect(hostReasonFor("win32", fields)).toMatch(/Windows key/u);
    }
    // Negative controls: Microsoft lists no Ctrl+Alt+Esc, and the Windows key is no class elsewhere.
    expect(hostReasonFor("win32", { ...escape, ctrlKey: true, altKey: true })).toBeUndefined();
    expect(hostReasonFor("linux", { key: "e", code: "KeyE", metaKey: true })).toBeUndefined();
  });

  it("falls back to the key when the host supplies no physical code", () => {
    expect(readChordFromEvent(press({ key: "F5", code: "" }))).toEqual({
      outcome: "captured",
      chord: "F5",
    });
  });
});

describe("reading what is held right now", () => {
  it("answers the same tokens a chord is composed from", () => {
    // The hint and the chord read one function, so a modifier has one name in both.
    const held = press({ key: "K", code: "KeyK", metaKey: true, shiftKey: true });
    expect(readHeldModifiersFromEvent(held, "darwin")).toStrictEqual(["$mod", "Shift"]);
    expect(readChordFromEvent(held, "darwin")).toStrictEqual<ChordRecording>({
      outcome: "captured",
      chord: "$mod+Shift+KeyK",
    });
  });

  it("answers the state a release leaves behind, not the key that ended", () => {
    // A keyup carries the flags the host is in after the release, so `⇧` released while `⌥` is
    // down reads as `⌥` alone; recomputing is correct where clearing is not.
    expect(
      readHeldModifiersFromEvent(
        press({ key: "Shift", code: "ShiftLeft", altKey: true, shiftKey: false }),
        "darwin",
      ),
    ).toStrictEqual(["Alt"]);
  });

  it("negative control: the key that ended does not decide the answer", () => {
    // Guards against a reader that keys on `key` and subtracts the released modifier itself,
    // which is wrong for a stuck flag and for a chord read on keydown.
    expect(
      readHeldModifiersFromEvent(
        press({ key: "Shift", code: "ShiftLeft", shiftKey: true }),
        "darwin",
      ),
    ).toStrictEqual(["Shift"]);
  });
});

describe("filtering rows", () => {
  const bindings: readonly Keybinding[] = [
    { chord: "$mod+1", commandId: "frame.goToSessions", when: WHEN_SESSION_ACTIVE },
  ];
  const rows = composeKeybindingRows({
    commands: [
      command("frame.goToSessions", "Sessions"),
      command("bridge.checkForUpdates", "Check for updates", "Help"),
    ],
    bindings,
    shippedBindings: bindings,
    platform: "darwin",
  });

  it("answers every row for no query, then narrows on the name and the chord as drawn", () => {
    expect(matchKeybindingRows(rows, "   ", "darwin")).toHaveLength(2);
    expect(
      matchKeybindingRows(rows, "sessions", "darwin").map((row) => row.commandId),
    ).toStrictEqual(["frame.goToSessions"]);
    expect(matchKeybindingRows(rows, "⌘1", "darwin").map((row) => row.commandId)).toStrictEqual([
      "frame.goToSessions",
    ]);
  });
});
