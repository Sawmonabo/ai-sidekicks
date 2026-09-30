// A claim rule one modifier too broad takes `S` from a page's search box; one too narrow kills
// the operator's whole chord set inside a pane. Neither shows until somebody is typing.

import { describe, expect, it } from "vitest";

import { KeyboardHandback } from "./keyboard-handback.js";
import { type ChordDescriptor } from "./chord-claim.js";
import { attachedPaneRoot, chord, handbackOver } from "./keyboard-handback.test-support.js";

describe("KeyboardHandback.decide", () => {
  it("leaves an in-progress composition with the page, modifier or not", () => {
    const handback = handbackOver(["$mod+KeyK"]);
    expect(handback.decide(chord({ isComposing: true, metaKey: true }))).toStrictEqual({
      claimed: false,
      because: "composing",
    });
  });

  it("leaves a bare keystroke with the page", () => {
    expect(handbackOver(["$mod+KeyK"]).decide(chord())).toStrictEqual({
      claimed: false,
      because: "no-application-modifier",
    });
  });

  it("fails open to the page when the mirror cannot be read", () => {
    expect(handbackOver(undefined).decide(chord({ metaKey: true }))).toStrictEqual({
      claimed: false,
      because: "mirror-unreadable",
    });
  });

  it("distinguishes an unreadable mirror from an empty console", () => {
    // `undefined` rather than `[]`: a console with no chords installed is a readable answer.
    expect(handbackOver([]).mirrorChords()).toStrictEqual([]);
    expect(handbackOver(undefined).mirrorChords()).toBeUndefined();
  });

  it("claims the chord the mirror actually holds", () => {
    expect(handbackOver(["$mod+KeyK"]).decide(chord({ metaKey: true }))).toStrictEqual({
      claimed: true,
    });
  });

  it("re-reads the chord set on every decision, so a rebinding is never stale", () => {
    let installed: readonly string[] | undefined = undefined;
    const handback = new KeyboardHandback({
      readInstalledChords: () => installed,
      platform: "darwin",
    });
    expect(handback.decide(chord({ metaKey: true })).claimed).toBe(false);
    installed = ["$mod+KeyK"];
    expect(handback.decide(chord({ metaKey: true })).claimed).toBe(true);
  });
});

describe("KeyboardHandback.decide — the claim is an exact mirrored chord", () => {
  it("resolves the platform's own modifier, so one authored chord claims on all three", () => {
    expect(handbackOver(["$mod+KeyK"], "darwin").decide(chord({ metaKey: true }))).toStrictEqual({
      claimed: true,
    });
    expect(handbackOver(["$mod+KeyK"], "win32").decide(chord({ ctrlKey: true }))).toStrictEqual({
      claimed: true,
    });
    expect(handbackOver(["$mod+KeyK"], "linux").decide(chord({ ctrlKey: true }))).toStrictEqual({
      claimed: true,
    });
  });

  it("leaves the OTHER platform's modifier with the page", () => {
    // On macOS control-K is the page's and meta-K the console's; a rule taking either would take
    // page shortcuts.
    expect(handbackOver(["$mod+KeyK"], "darwin").decide(chord({ ctrlKey: true }))).toStrictEqual({
      claimed: false,
      because: "not-mirrored",
    });
    expect(handbackOver(["$mod+KeyK"], "win32").decide(chord({ metaKey: true }))).toStrictEqual({
      claimed: false,
      because: "not-mirrored",
    });
  });

  it("leaves the page every modified keystroke the mirror does not hold", () => {
    const handback = handbackOver(["$mod+KeyK"]);
    const pageKeystrokes: readonly ChordDescriptor[] = [
      chord({ key: "c", code: "KeyC", metaKey: true }),
      chord({ key: "l", code: "KeyL", metaKey: true }),
      chord({ metaKey: true, shiftKey: true }),
      chord({ metaKey: true, altKey: true }),
    ];
    for (const keystroke of pageKeystrokes) {
      expect(handback.decide(keystroke)).toStrictEqual({
        claimed: false,
        because: "not-mirrored",
      });
    }
  });

  it("claims each chord of a two-chord mirror and nothing beside them", () => {
    const handback = handbackOver(["$mod+KeyK", "$mod+Shift+KeyP"]);

    expect(handback.decide(chord({ metaKey: true })).claimed).toBe(true);
    expect(
      handback.decide(chord({ key: "p", code: "KeyP", metaKey: true, shiftKey: true })).claimed,
    ).toBe(true);
    expect(handback.decide(chord({ key: "p", code: "KeyP", metaKey: true })).claimed).toBe(false);
  });

  it("reads a chord authored either way as one keystroke", () => {
    // `$mod+k` and `$mod+KeyK` are one binding to the keybinding table, so one claim here.
    expect(handbackOver(["$mod+k"]).decide(chord({ metaKey: true })).claimed).toBe(true);
  });

  it("leaves the page a keystroke whose only mirrored chord does not parse", () => {
    // Modifiers with no key is refused by `parseChord`; it matches nothing rather than throwing.
    expect(handbackOver(["$mod+"]).decide(chord({ metaKey: true }))).toStrictEqual({
      claimed: false,
      because: "not-mirrored",
    });
  });

  it("negative control: a non-empty mirror does not claim by presence alone", () => {
    // A rule that claimed every modified keystroke once the mirror held anything would take
    // Cmd+C and Cmd+L with it.
    const handback = handbackOver(["$mod+KeyK"]);

    expect(handback.decide(chord({ metaKey: true })).claimed).toBe(true);
    expect(handback.decide(chord({ key: "c", code: "KeyC", metaKey: true })).claimed).toBe(false);
  });
});

describe("KeyboardHandback.decide — tinykeys' optional modifiers", () => {
  // `$mod+[Shift]+KeyK` means "meta-K, shift optional", and a keystroke has only held modifiers.
  // Re-authoring the keystroke as a chord put every held modifier in the required set, so a
  // bracketed chord matched neither form: claimed from the page and never replayable.
  const OPTIONAL_SHIFT_CHORD = "$mod+[Shift]+KeyK";

  it("claims the chord with the optional modifier held", () => {
    expect(
      handbackOver([OPTIONAL_SHIFT_CHORD]).decide(chord({ metaKey: true, shiftKey: true })),
    ).toStrictEqual({ claimed: true });
  });

  it("claims the same chord with the optional modifier absent", () => {
    expect(handbackOver([OPTIONAL_SHIFT_CHORD]).decide(chord({ metaKey: true }))).toStrictEqual({
      claimed: true,
    });
  });

  it("still refuses a REQUIRED modifier that is not held", () => {
    // A chord written without brackets requires the modifier; a keystroke without it is the page's.
    expect(handbackOver(["$mod+Shift+KeyK"]).decide(chord({ metaKey: true }))).toStrictEqual({
      claimed: false,
      because: "not-mirrored",
    });
  });

  it("negative control: a modifier outside BOTH sets still leaves the keystroke alone", () => {
    // Without it the claiming cases would pass against a matcher that ignored modifiers.
    expect(
      handbackOver([OPTIONAL_SHIFT_CHORD]).decide(chord({ metaKey: true, altKey: true })),
    ).toStrictEqual({ claimed: false, because: "not-mirrored" });
  });

  it("replays a bracketed chord it claimed, in both of its forms", () => {
    // The whole point of claiming one: a chord taken from the page and not replayed
    // is a keystroke that reached nobody at all.
    const handback = handbackOver([OPTIONAL_SHIFT_CHORD]);
    const paneRoot = attachedPaneRoot();

    expect(handback.replay(chord({ metaKey: true, shiftKey: true }), paneRoot).status).toBe(
      "replayed",
    );
    expect(handback.replay(chord({ metaKey: true }), paneRoot).status).toBe("replayed");
    expect(handback.replayCount).toBe(2);
  });

  it("matches a keystroke on the spellings the event itself carries", () => {
    // The matcher reads `key` and `code`. A keystroke with no code is matched on its key alone,
    // which leaves a code-spelled mirror chord with the page.
    expect(handbackOver(["$mod+KeyK"]).decide(chord({ metaKey: true })).claimed).toBe(true);
    expect(handbackOver(["$mod+k"]).decide(chord({ code: "", metaKey: true })).claimed).toBe(true);
    expect(handbackOver(["$mod+KeyK"]).decide(chord({ code: "", metaKey: true })).claimed).toBe(
      false,
    );
  });
});
