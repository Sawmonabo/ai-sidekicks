// What a claimed chord then does, and where it has to arrive for the console to work.
//
// The replay is the half that can fail while every decision above it is correct: a
// chord claimed from the page and then dispatched at the wrong target reaches nobody,
// which is a keystroke the operator has lost twice over. The route is asserted at both
// ends — the pane's own capture handler and the window the keybinding table listens on
// — because a re-target that fixes one by breaking the other is the failure this suite
// exists to catch.

import { describe, expect, it } from "vitest";

import { isConsoleRefusal } from "../../core/index.js";
import { CLOSE_TAB_CHORD } from "./chord-claim.js";
import { KEYBOARD_HANDBACK_REFUSAL_ORIGIN } from "./keyboard-handback.js";
import { attachedPaneRoot, chord, handbackOver } from "./keyboard-handback.test-support.js";

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
