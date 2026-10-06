// A claim rule one modifier too broad takes `S` from a page's search box; one too narrow kills
// the person's whole chord set inside a pane. Neither shows until somebody is typing. The
// forwarding is asserted at both ends, the pane's own capture handler and the window the keybinding
// table listens on, because a re-target that fixes one breaks the other.

import { describe, expect, it } from "vitest";
import { CLOSE_TAB_CHORD, type ChordDescriptor } from "./chord/claim.js";
import { attachedPaneRoot, chord, handbackOver } from "./keyboard.test-support.js";

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

  it("claims the chord the mirror actually holds", () => {
    expect(handbackOver(["$mod+KeyK"]).decide(chord({ metaKey: true }))).toStrictEqual({
      claimed: true,
    });
  });
});

describe("KeyboardHandback.decide — the claim is an exact mirrored chord", () => {
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
});

describe("KeyboardHandback.forwardChord", () => {
  it("focuses the pane and forwards the chord, carrying every modifier through unchanged", () => {
    const handback = handbackOver(["$mod+Shift+KeyK"]);
    const paneRoot = attachedPaneRoot();
    const seen: KeyboardEvent[] = [];
    const listener = (event: Event): void => {
      seen.push(event as KeyboardEvent);
    };
    window.addEventListener("keydown", listener);
    try {
      const outcome = handback.forwardChord(chord({ metaKey: true, shiftKey: true }), paneRoot);
      expect(outcome).toStrictEqual({ status: "forwarded" });
      expect(handback.forwardCount).toBe(1);
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
    // Dispatching on `window` makes it the target, and a target's propagation path excludes its
    // descendants, so the pane's `onKeyDownCapture` never saw the forwarded chord.
    const handback = handbackOver([CLOSE_TAB_CHORD]);
    const paneRoot = attachedPaneRoot();
    const seenAtPane: KeyboardEvent[] = [];
    const paneCaptureHandler = (event: Event): void => {
      seenAtPane.push(event as KeyboardEvent);
    };
    paneRoot.addEventListener("keydown", paneCaptureHandler, { capture: true });

    const outcome = handback.forwardChord(
      chord({ key: "w", code: "KeyW", metaKey: true }),
      paneRoot,
    );

    expect(outcome).toStrictEqual({ status: "forwarded" });
    expect(seenAtPane).toHaveLength(1);
    expect(seenAtPane[0]?.code).toBe("KeyW");
    expect(seenAtPane[0]?.metaKey).toBe(true);
  });
});
