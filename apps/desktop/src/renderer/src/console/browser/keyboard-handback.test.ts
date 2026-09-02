// Who wins a keystroke, and what a wrong answer costs.
//
// Correct behaviour on this surface is the absence of a complaint, which is exactly
// why it needs adversarial cases rather than a happy path: a claim rule that is one
// modifier too broad takes `S` away from a page's own search box, and a claim rule
// that is one too narrow silently kills the operator's whole chord set inside a pane.
// Both failures look like nothing at all until somebody is typing.

import { describe, expect, it } from "vitest";

import { isConsoleRefusal } from "../core/index.js";
import {
  CHORD_MODIFIER_TOKENS,
  CLOSE_TAB_CHORD,
  KEYBOARD_HANDBACK_REFUSAL_ORIGIN,
  KeyboardHandback,
  carriesApplicationModifier,
  chordCarriesApplicationModifier,
  describeChordEvent,
  isCloseTabChord,
  projectClaimableChords,
  type ChordDescriptor,
} from "./keyboard-handback.js";

function chord(overrides: Partial<ChordDescriptor> = {}): ChordDescriptor {
  return {
    key: "k",
    code: "KeyK",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    ...overrides,
  };
}

function handbackOver(installed: readonly string[] | undefined): KeyboardHandback {
  return new KeyboardHandback({ readInstalledChords: () => installed });
}

function attachedPaneRoot(): HTMLElement {
  const root = document.createElement("div");
  root.tabIndex = -1;
  document.body.append(root);
  return root;
}

describe("carriesApplicationModifier", () => {
  it("counts control, meta, and alt", () => {
    expect(carriesApplicationModifier(chord({ ctrlKey: true }))).toBe(true);
    expect(carriesApplicationModifier(chord({ metaKey: true }))).toBe(true);
    expect(carriesApplicationModifier(chord({ altKey: true }))).toBe(true);
  });

  it("does not count shift, because a shift-only combination is a capital letter", () => {
    expect(carriesApplicationModifier(chord({ shiftKey: true }))).toBe(false);
    expect(carriesApplicationModifier(chord())).toBe(false);
  });
});

describe("describeChordEvent", () => {
  it("reads every field the claim decision depends on off a real event", () => {
    const descriptor = describeChordEvent(
      new KeyboardEvent("keydown", {
        key: "k",
        code: "KeyK",
        metaKey: true,
        shiftKey: true,
      }),
    );
    expect(descriptor).toStrictEqual(chord({ metaKey: true, shiftKey: true }));
  });
});

describe("projectClaimableChords", () => {
  it("drops bare chords, so a mirror can never hold one", () => {
    expect(projectClaimableChords(["KeyS", "Shift+KeyS", "$mod+KeyS"])).toStrictEqual([
      "$mod+KeyS",
    ]);
  });

  it("accepts every modifier token the grammar names, including a bracketed one", () => {
    for (const modifier of CHORD_MODIFIER_TOKENS) {
      expect(chordCarriesApplicationModifier(`${modifier}+KeyK`)).toBe(true);
    }
    expect(chordCarriesApplicationModifier("[Alt]+KeyK")).toBe(true);
  });

  it("deduplicates and sorts, so two mirrors of one set compare equal", () => {
    expect(projectClaimableChords(["$mod+KeyB", "$mod+KeyA", "$mod+KeyB"])).toStrictEqual([
      "$mod+KeyA",
      "$mod+KeyB",
    ]);
  });

  it("negative control: the filter is not rejecting everything", () => {
    // A projection that returned the empty array would satisfy the bare-chord case
    // above and would also disable every console chord inside a pane.
    expect(projectClaimableChords(["Control+KeyP"])).toHaveLength(1);
  });
});

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

  it("claims a modified keystroke once the mirror is readable", () => {
    expect(handbackOver(["$mod+KeyK"]).decide(chord({ metaKey: true }))).toStrictEqual({
      claimed: true,
    });
  });

  it("re-reads the chord set on every decision, so a rebinding is never stale", () => {
    let installed: readonly string[] | undefined = undefined;
    const handback = new KeyboardHandback({ readInstalledChords: () => installed });
    expect(handback.decide(chord({ metaKey: true })).claimed).toBe(false);
    installed = ["$mod+KeyK"];
    expect(handback.decide(chord({ metaKey: true })).claimed).toBe(true);
  });
});

describe("KeyboardHandback.replay", () => {
  it("replays as a window keydown, carrying every modifier through unchanged", () => {
    const handback = handbackOver(["$mod+KeyK"]);
    const paneRoot = attachedPaneRoot();
    const seen: KeyboardEvent[] = [];
    const listener = (event: Event): void => {
      seen.push(event as KeyboardEvent);
    };
    window.addEventListener("keydown", listener);
    try {
      const outcome = handback.replay(chord({ metaKey: true, shiftKey: true }), paneRoot);
      expect(outcome).toStrictEqual({ status: "replayed" });
      expect(handback.replayCount).toBe(1);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.code).toBe("KeyK");
      expect(seen[0]?.metaKey).toBe(true);
      expect(seen[0]?.shiftKey).toBe(true);
    } finally {
      window.removeEventListener("keydown", listener);
    }
    expect(document.activeElement).toBe(paneRoot);
  });

  it("refuses an unclaimable chord instead of replaying it", () => {
    const handback = handbackOver(["$mod+KeyK"]);
    const outcome = handback.replay(chord(), attachedPaneRoot());
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") {
      throw new Error("unreachable");
    }
    expect(isConsoleRefusal(outcome.refusal)).toBe(true);
    expect(outcome.refusal.origin).toBe(KEYBOARD_HANDBACK_REFUSAL_ORIGIN);
    expect(outcome.refusal.code).toBe("not-claimable");
    expect(handback.replayCount).toBe(0);
  });

  it("refuses when the pane has left the document, rather than dispatching into it", () => {
    const handback = handbackOver(["$mod+KeyK"]);
    const detached = document.createElement("div");
    const outcome = handback.replay(chord({ metaKey: true }), detached);
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") {
      throw new Error("unreachable");
    }
    expect(outcome.refusal.code).toBe("pane-detached");
    expect(handback.replayCount).toBe(0);
  });
});

describe("isCloseTabChord", () => {
  it("takes the platform's own modifier on each platform", () => {
    expect(isCloseTabChord(chord({ key: "w", code: "KeyW", metaKey: true }), "darwin")).toBe(true);
    expect(isCloseTabChord(chord({ key: "w", code: "KeyW", ctrlKey: true }), "win32")).toBe(true);
    expect(isCloseTabChord(chord({ key: "w", code: "KeyW", ctrlKey: true }), "linux")).toBe(true);
  });

  it("refuses the OTHER platform's modifier, so control-W stays the page's on macOS", () => {
    expect(isCloseTabChord(chord({ key: "w", code: "KeyW", ctrlKey: true }), "darwin")).toBe(false);
    expect(isCloseTabChord(chord({ key: "w", code: "KeyW", metaKey: true }), "win32")).toBe(false);
  });

  it("refuses both modifiers together, which is a different chord", () => {
    expect(
      isCloseTabChord(chord({ key: "w", code: "KeyW", metaKey: true, ctrlKey: true }), "darwin"),
    ).toBe(false);
  });

  it("refuses alt, shift, and an in-progress composition", () => {
    expect(
      isCloseTabChord(chord({ key: "w", code: "KeyW", metaKey: true, altKey: true }), "darwin"),
    ).toBe(false);
    expect(
      isCloseTabChord(chord({ key: "w", code: "KeyW", metaKey: true, shiftKey: true }), "darwin"),
    ).toBe(false);
    expect(
      isCloseTabChord(
        chord({ key: "w", code: "KeyW", metaKey: true, isComposing: true }),
        "darwin",
      ),
    ).toBe(false);
  });

  it("reads the layout-independent code, and falls back to the key when there is none", () => {
    expect(isCloseTabChord(chord({ key: "∑", code: "KeyW", metaKey: true }), "darwin")).toBe(true);
    expect(isCloseTabChord(chord({ key: "W", code: "", metaKey: true }), "darwin")).toBe(true);
  });

  it("refuses every other key", () => {
    expect(isCloseTabChord(chord({ key: "q", code: "KeyQ", metaKey: true }), "darwin")).toBe(false);
  });

  it("is the chord the hint prints", () => {
    expect(CLOSE_TAB_CHORD).toBe("$mod+KeyW");
  });
});
