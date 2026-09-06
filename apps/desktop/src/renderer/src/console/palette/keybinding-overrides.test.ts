// What an override means, what it composes to, and which candidate chords the
// console refuses before anything is stored.

import { describe, expect, it } from "vitest";

import type { KeyBinding } from "./contributions.js";
import {
  KEYBINDING_OVERRIDE_REFUSAL_CODES,
  KEYBINDING_OVERRIDE_REFUSAL_ORIGIN,
  composeEffectiveBindings,
  readOverrideMap,
  refuseCandidateChord,
} from "./keybinding-overrides.js";

const DEFAULTS: readonly KeyBinding[] = [
  { chord: "$mod+1", commandId: "frame.goToSessions" },
  { chord: "$mod+2", commandId: "frame.goToWorkflows" },
];

describe("composing the effective table", () => {
  it("leaves a command nobody touched on the chord the console ships", () => {
    expect(composeEffectiveBindings(DEFAULTS, {})).toStrictEqual(DEFAULTS);
  });

  it("replaces a shipped chord with the override, in the shipped position", () => {
    const effective = composeEffectiveBindings(DEFAULTS, { "frame.goToSessions": "$mod+9" });
    expect(effective.map((binding) => binding.chord)).toStrictEqual(["$mod+9", "$mod+2"]);
    expect(effective[0]?.commandId).toBe("frame.goToSessions");
  });

  it("drops the binding for a command explicitly left unbound", () => {
    const effective = composeEffectiveBindings(DEFAULTS, { "frame.goToSessions": null });
    expect(effective.map((binding) => binding.commandId)).toStrictEqual(["frame.goToWorkflows"]);
  });

  it("binds a command the shipped table names nowhere, in command-id order", () => {
    const effective = composeEffectiveBindings(DEFAULTS, {
      "zz.later": "$mod+8",
      "app.checkForUpdates": "$mod+7",
    });
    expect(effective.slice(2).map((binding) => binding.commandId)).toStrictEqual([
      "app.checkForUpdates",
      "zz.later",
    ]);
  });

  it("negative control: an unbound entry for an unshipped command adds nothing", () => {
    // Without this the arm above would pass over a composer that appended a row for
    // every override key, including the ones that say "this has no chord".
    expect(composeEffectiveBindings(DEFAULTS, { "app.checkForUpdates": null })).toStrictEqual(
      DEFAULTS,
    );
  });
});

describe("reading a stored record", () => {
  it("keeps chords and explicit unbindings, and nothing else", () => {
    expect(
      readOverrideMap({ "frame.goToSessions": "$mod+9", "frame.goToWorkflows": null, bad: 7 }),
    ).toStrictEqual({ "frame.goToSessions": "$mod+9", "frame.goToWorkflows": null });
  });

  it("negative control: a record of the wrong shape answers the empty map", () => {
    // A reader that trusted whatever it found would hand `setBindings` a chord that
    // is a number, and the frame's own effect would raise.
    expect(readOverrideMap(["$mod+9"])).toStrictEqual({});
    expect(readOverrideMap("$mod+9")).toStrictEqual({});
    expect(readOverrideMap(undefined)).toStrictEqual({});
  });
});

describe("refusing a candidate chord", () => {
  const candidate = {
    defaults: DEFAULTS,
    overrides: {},
    platform: "darwin",
  } as const;

  it("admits a chord nothing else answers to", () => {
    expect(
      refuseCandidateChord({ ...candidate, commandId: "frame.goToSessions", chord: "$mod+9" }),
    ).toBeUndefined();
  });

  it("names the command that already holds the chord", () => {
    const refusal = refuseCandidateChord({
      ...candidate,
      commandId: "frame.goToSessions",
      chord: "$mod+2",
    });
    expect(refusal?.code).toBe("chord-taken");
    expect(refusal?.detail).toContain("frame.goToWorkflows");
    expect(refusal?.origin).toBe(KEYBINDING_OVERRIDE_REFUSAL_ORIGIN);
  });

  it("refuses a chord the host eats before the console can see it", () => {
    const refusal = refuseCandidateChord({
      ...candidate,
      commandId: "frame.goToSessions",
      chord: "$mod+Space",
    });
    expect(refusal?.code).toBe("chord-reserved");
    expect(refusal?.detail).toContain("Spotlight");
  });

  it("refuses a chord the keybinding service will not install", () => {
    const refusal = refuseCandidateChord({
      ...candidate,
      commandId: "frame.goToSessions",
      chord: "g d",
    });
    expect(refusal?.code).toBe("chord-unbindable");
  });

  it("lets a command keep the chord it already holds", () => {
    // The candidate replaces this command's own row rather than joining it, so a
    // rebinding to the same chord is not a collision with itself.
    expect(
      refuseCandidateChord({ ...candidate, commandId: "frame.goToSessions", chord: "$mod+1" }),
    ).toBeUndefined();
  });

  it("negative control: every code the refusals above carry is in the vocabulary", () => {
    // Without this the codes would be free strings that a surface renders and a
    // reader searches for, and a typo in one would be invisible.
    for (const code of ["chord-taken", "chord-reserved", "chord-unbindable"]) {
      expect(KEYBINDING_OVERRIDE_REFUSAL_CODES).toContain(code);
    }
    expect(KEYBINDING_OVERRIDE_REFUSAL_CODES).not.toContain("chord-fine");
  });
});
