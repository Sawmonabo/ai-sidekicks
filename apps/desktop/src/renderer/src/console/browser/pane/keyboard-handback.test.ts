// Who wins a keystroke, and what a wrong answer costs.
//
// Correct behaviour on this surface is the absence of a complaint, which is exactly
// why it needs adversarial cases rather than a happy path: a claim rule that is one
// modifier too broad takes `S` away from a page's own search box, and a claim rule
// that is one too narrow silently kills the operator's whole chord set inside a pane.
// Both failures look like nothing at all until somebody is typing.

import { describe, expect, it } from "vitest";

import { isConsoleRefusal } from "../../core/index.js";
import type { ChordPlatform } from "../../primitives/index.js";
import {
  CLAIMABLE_MODIFIER_TOKENS,
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

/**
 * A handback over a fixed chord set. `darwin` by default because meta is the modifier
 * every case below reaches for; the platform cases name theirs.
 */
function handbackOver(
  installed: readonly string[] | undefined,
  platform: ChordPlatform = "darwin",
): KeyboardHandback {
  return new KeyboardHandback({ readInstalledChords: () => installed, platform });
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
    for (const modifier of CLAIMABLE_MODIFIER_TOKENS) {
      expect(chordCarriesApplicationModifier(`${modifier}+KeyK`)).toBe(true);
    }
    expect(chordCarriesApplicationModifier("[Alt]+KeyK")).toBe(true);
  });

  it("subtracts only shift from the console's chord vocabulary", () => {
    // The set is derived, so this asserts the ONE subtraction rather than the members:
    // a modifier added to the vocabulary shows up here without an edit, and a
    // shift-only combination — a capital letter — stays with the page.
    expect(CLAIMABLE_MODIFIER_TOKENS).not.toContain("Shift");
    expect(chordCarriesApplicationModifier("Shift+KeyS")).toBe(false);
  });

  it("reads the plus key chord the grammar spells `$mod++`", () => {
    // A preservation case, not a change: tinykeys splits a press on `+` PRECEDED by a
    // word character, so `$mod++` is meta-plus, and the printer's splitter is the one
    // that agrees with the parser about that. It is pinned because the predicate now
    // reads through that splitter and this is the chord the two disagree on.
    expect(chordCarriesApplicationModifier("$mod++")).toBe(true);
    expect(projectClaimableChords(["$mod++"])).toStrictEqual(["$mod++"]);
  });

  it("keeps a multi-press sequence out of the mirror", () => {
    // `parseChord` refuses a sequence, so a mirrored one is a chord the main process
    // takes from the page and the renderer can never match: the operator would get a
    // not-claimable refusal for a keystroke that should simply have reached the page.
    expect(chordCarriesApplicationModifier("$mod+KeyK $mod+KeyB")).toBe(false);
    expect(projectClaimableChords(["$mod+KeyK $mod+KeyB"])).toStrictEqual([]);
  });

  it("negative control: the sequence rule is not rejecting every modified chord", () => {
    // A predicate that answered false for everything would satisfy the two cases above
    // and would empty the mirror, which is the failure the projection exists to avoid.
    expect(chordCarriesApplicationModifier("$mod+KeyK")).toBe(true);
    expect(chordCarriesApplicationModifier(" $mod+KeyK ")).toBe(true);
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

describe("KeyboardHandback.replay", () => {
  it("focuses the pane and replays the chord, carrying every modifier through unchanged", () => {
    const handback = handbackOver(["$mod+Shift+KeyK"]);
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

  it("reaches the pane's own capture handler, which is where the close chord is handled", () => {
    // The finding. Dispatching on `window` made the window the target, and a target's
    // propagation path does not include its descendants — so `BrowserPane`'s
    // `onKeyDownCapture` never saw the replay, and the one chord it handles there was
    // silently swallowed: no `close-unregistered` refusal, no close, and a keystroke
    // the mirror had just taken from the page.
    const handback = handbackOver([CLOSE_TAB_CHORD]);
    const paneRoot = attachedPaneRoot();
    const seenAtPane: KeyboardEvent[] = [];
    const paneCaptureHandler = (event: Event): void => {
      seenAtPane.push(event as KeyboardEvent);
    };
    paneRoot.addEventListener("keydown", paneCaptureHandler, { capture: true });

    const outcome = handback.replay(chord({ key: "w", code: "KeyW", metaKey: true }), paneRoot);

    expect(outcome).toStrictEqual({ status: "replayed" });
    expect(seenAtPane).toHaveLength(1);
    expect(seenAtPane[0]?.code).toBe("KeyW");
    expect(seenAtPane[0]?.metaKey).toBe(true);
  });

  it("still reaches the window, so every other chord keeps the route it had", () => {
    // The half a re-target could have broken. The keybinding table listens at the
    // window, and a replay that stopped reaching it would trade one swallowed chord
    // for every other one.
    const handback = handbackOver(["$mod+KeyK"]);
    const paneRoot = attachedPaneRoot();
    const seenAtWindow: KeyboardEvent[] = [];
    const listener = (event: Event): void => {
      seenAtWindow.push(event as KeyboardEvent);
    };
    const capturing = (event: Event): void => {
      seenAtWindow.push(event as KeyboardEvent);
    };
    window.addEventListener("keydown", listener);
    window.addEventListener("keydown", capturing, { capture: true });
    try {
      handback.replay(chord({ metaKey: true }), paneRoot);
    } finally {
      window.removeEventListener("keydown", listener);
      window.removeEventListener("keydown", capturing, { capture: true });
    }

    // Both phases: the window captures on the way down and hears it bubble back up,
    // so a listener registered either way is unaffected by the re-target.
    expect(seenAtWindow).toHaveLength(2);
    expect(seenAtWindow[0]?.code).toBe("KeyK");
  });

  it("negative control: a chord the mirror does not hold reaches neither", () => {
    // Without it the two cases above would pass against a replay that dispatched
    // every keystroke it was handed, which is a pane that takes chords from the page
    // the mirror never claimed.
    const handback = handbackOver(["$mod+KeyK"]);
    const paneRoot = attachedPaneRoot();
    const seen: KeyboardEvent[] = [];
    const listener = (event: Event): void => {
      seen.push(event as KeyboardEvent);
    };
    paneRoot.addEventListener("keydown", listener, { capture: true });
    window.addEventListener("keydown", listener);
    try {
      const outcome = handback.replay(chord({ key: "j", code: "KeyJ", metaKey: true }), paneRoot);
      expect(outcome.status).toBe("refused");
    } finally {
      window.removeEventListener("keydown", listener);
    }

    expect(seen).toHaveLength(0);
    expect(handback.replayCount).toBe(0);
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
