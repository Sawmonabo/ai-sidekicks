// Who wins a keystroke.
//
// Correct behaviour on this surface is the absence of a complaint, which is exactly
// why it needs adversarial cases rather than a happy path: a claim rule that is one
// modifier too broad takes `S` away from a page's own search box, and a claim rule
// that is one too narrow silently kills the operator's whole chord set inside a pane.
// Both failures look like nothing at all until somebody is typing. The vocabulary the
// decision reads is posed in `chord-claim.test.ts`; what a claimed chord then does is
// in `keyboard-handback.replay.test.ts`.

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
    // The distinction is the whole reason the supplier returns `undefined` rather
    // than `[]`: a console with no chords installed is a readable answer.
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
    // On macOS control-K is the page's and meta-K is the console's, and a claim rule
    // that took either would take a page shortcut on every keystroke.
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
    // `$mod+k` and `$mod+KeyK` are one binding to the keybinding table, because both
    // go through the same comparison key. They are one claim here for the same reason.
    expect(handbackOver(["$mod+k"]).decide(chord({ metaKey: true })).claimed).toBe(true);
  });

  it("leaves the page a keystroke whose only mirrored chord does not parse", () => {
    // Modifiers with no key is a chord `parseChord` refuses. It matches nothing rather
    // than throwing, so the keystroke stays with the page.
    expect(handbackOver(["$mod+"]).decide(chord({ metaKey: true }))).toStrictEqual({
      claimed: false,
      because: "not-mirrored",
    });
  });

  it("negative control: a non-empty mirror does not claim by presence alone", () => {
    // The rule this replaces returned `claimed: true` for every modified keystroke as
    // soon as the mirror held anything, so a mirror of one chord took Cmd+C, Cmd+L,
    // and the rest of the page's shortcuts with it.
    const handback = handbackOver(["$mod+KeyK"]);

    expect(handback.decide(chord({ metaKey: true })).claimed).toBe(true);
    expect(handback.decide(chord({ key: "c", code: "KeyC", metaKey: true })).claimed).toBe(false);
  });
});

describe("KeyboardHandback.decide — tinykeys' optional modifiers", () => {
  // The grammar has two modifier sets. `$mod+[Shift]+KeyK` says "meta-K, and I do not
  // mind whether shift is down", and a keystroke has no sets at all — only modifiers
  // that are held. Re-authoring the keystroke as a chord put every held modifier in
  // the REQUIRED set and left the optional one empty, so a bracketed binding compared
  // equal to no keystroke in either valid form: the console claimed the chord from the
  // page and could then never replay it, which is a keystroke that reaches nobody.
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
    // The half an over-permissive matcher would break: a chord written without
    // brackets means the modifier is part of the chord, and a keystroke without it is
    // the page's.
    expect(handbackOver(["$mod+Shift+KeyK"]).decide(chord({ metaKey: true }))).toStrictEqual({
      claimed: false,
      because: "not-mirrored",
    });
  });

  it("negative control: a modifier outside BOTH sets still leaves the keystroke alone", () => {
    // Without this the two claiming cases above would pass against a matcher that had
    // simply stopped looking at modifiers, which takes every modified keystroke on the
    // page as soon as one bracketed chord is installed.
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
    // The matcher reads `key` and `code`, so a chord authored either way claims a
    // keystroke that carries both. A keystroke carrying NO code is matched on its key
    // alone — the fourth rule's direction, toward the page, for a chord the mirror
    // spells in code.
    expect(handbackOver(["$mod+KeyK"]).decide(chord({ metaKey: true })).claimed).toBe(true);
    expect(handbackOver(["$mod+k"]).decide(chord({ code: "", metaKey: true })).claimed).toBe(true);
    expect(handbackOver(["$mod+KeyK"]).decide(chord({ code: "", metaKey: true })).claimed).toBe(
      false,
    );
  });
});
