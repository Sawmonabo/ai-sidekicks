// The one decision the binding makes about a handed-back keystroke.
//
// `Spec-023 §Console Design (Meridian)` 12.4's two halves meet here: the projection
// decides which chords MAY be claimed, and this decides what happens to one that was.
// The three outcomes are different and each has to be reachable — replayed, left
// alone because the console does not claim it, and left alone because there is no
// pane root to replay into — and only the first of them may produce an event.
//
// The negative controls are the two "left alone" arms, because a binding that
// replayed everything would pass a test asserting only that a claimed chord replays,
// and it would inject keystrokes into this window that the page was supposed to keep.

import { afterEach, describe, expect, it } from "vitest";

import { replayClaimedChord } from "./handback-binding.js";
import { attachedPaneRoot, chord, handbackOver } from "./keyboard-handback.test-support.js";

/** The chord the console claims in these cases, in the projection's own spelling. */
const CLAIMED_CHORD = "Meta+KeyK";

afterEach(() => {
  document.body.replaceChildren();
});

describe("replaying a handed-back keystroke", () => {
  it("replays a chord the console claims, on the pane root", () => {
    const paneRoot = attachedPaneRoot();
    const replayed: string[] = [];
    paneRoot.addEventListener("keydown", (event) => {
      replayed.push(event.code);
    });
    const outcome = replayClaimedChord(
      handbackOver([CLAIMED_CHORD]),
      chord({ metaKey: true }),
      paneRoot,
    );
    expect(outcome?.status).toBe("replayed");
    expect(replayed).toEqual(["KeyK"]);
  });

  it("leaves a chord the console does not claim alone, and reports nothing about it", () => {
    const paneRoot = attachedPaneRoot();
    const replayed: string[] = [];
    paneRoot.addEventListener("keydown", (event) => {
      replayed.push(event.code);
    });
    // The page keeps it. There is nothing to report about a keystroke this window
    // never wanted, which is why the outcome is `undefined` rather than a refusal.
    const outcome = replayClaimedChord(handbackOver([]), chord({ metaKey: true }), paneRoot);
    expect(outcome).toBeUndefined();
    expect(replayed).toEqual([]);
  });

  it("replays nothing where the pane has no root to replay into", () => {
    const outcome = replayClaimedChord(
      handbackOver([CLAIMED_CHORD]),
      chord({ metaKey: true }),
      null,
    );
    expect(outcome).toBeUndefined();
  });

  it("negative control: an unclaimed chord is not replayed even with a root present", () => {
    const paneRoot = attachedPaneRoot();
    const outcome = replayClaimedChord(
      handbackOver([CLAIMED_CHORD]),
      // A different physical key: the projection claims meta-K and nothing else.
      chord({ key: "j", code: "KeyJ", metaKey: true }),
      paneRoot,
    );
    expect(outcome).toBeUndefined();
  });
});
