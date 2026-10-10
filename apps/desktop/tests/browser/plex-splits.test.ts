// A character outside Latin-1 is drawn in Plex. The arrow the console draws in a chord hint and a
// diff footer lives in the packages' Pi split; drawing one makes Chromium fetch that split and no
// other, and the face that answers is the app's own family, not the host's.

import { afterEach, describe, expect, it } from "vitest";

import {
  MERIDIAN_STYLE_ELEMENT_ID,
  installMeridianTokens,
} from "#renderer/app/token-installation.js";

/** The arrow's code point, inside the Pi split's `U+2190-2199`. */
const RIGHTWARDS_ARROW = 0x2192;

afterEach(() => {
  document.getElementById(MERIDIAN_STYLE_ELEMENT_ID)?.remove();
  document.body.replaceChildren();
});

describe("browser — the Plex splits", () => {
  it("draws a → in IBM Plex Sans from the split that holds it", async () => {
    installMeridianTokens(document);
    const arrow = document.createElement("span");
    arrow.style.fontFamily = '"IBM Plex Sans"';
    arrow.textContent = String.fromCodePoint(RIGHTWARDS_ARROW);
    document.body.append(arrow);
    await document.fonts.load(`16px "IBM Plex Sans"`, arrow.textContent);
    await document.fonts.ready;

    const loaded = [...document.fonts].filter(
      (face) => face.family === '"IBM Plex Sans"' || face.family === "IBM Plex Sans",
    );
    const answering = loaded.filter(
      (face) =>
        face.status === "loaded" &&
        face.style === "normal" &&
        coversCodePoint(face, RIGHTWARDS_ARROW),
    );
    expect(answering).toHaveLength(1);
    // A range of its own, not the whole of Unicode: the split is fetched only for what it holds.
    expect(answering[0]?.unicodeRange).not.toBe("U+0-10FFFF");
  });
});

/** Whether a face's declared `unicode-range` holds one code point. */
function coversCodePoint(face: FontFace, codePoint: number): boolean {
  return face.unicodeRange.split(",").some((part) => {
    const [start = "", end = start] = part.trim().replace(/^U\+/iu, "").split("-");
    return Number.parseInt(start, 16) <= codePoint && codePoint <= Number.parseInt(end, 16);
  });
}
