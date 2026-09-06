// The capture-face pin, proved on the element every captured surface reads through.
//
// Not a mount of any one family's surface: the tier grows a file per family and
// this claim is about the document they all render into, so it is made against a
// bare element carrying the same `var(--meridian-font-mono)` declaration the
// console's own stylesheets carry. A family added tomorrow inherits the proof.
//
// The measurement is an ADVANCE RATIO rather than a resolved `font-family` string,
// because that string reports the stack that was REQUESTED and says nothing about
// which face answered — and the failure this pin ends was two faces answering the
// same request on the same host across two runs. A ratio names the face.

import { beforeEach, describe, expect, it } from "vitest";

import {
  CAPTURE_MONOSPACE_ADVANCE_EM,
  CAPTURE_MONOSPACE_STACK,
  MONOSPACE_FONT_CUSTOM_PROPERTY,
} from "./capture-faces.js";

import { installMeridianTokens } from "../../../src/renderer/src/console/frame/index.js";

/** A string of fixed-width characters long enough for the ratio to be decisive. */
const PROBE_TEXT = "019b7b30-0280-7c11-8420-b1a5c0de2201";

/** The size the console renders wire figures at, near enough for a ratio. */
const PROBE_FONT_SIZE_PX = 13;

/**
 * How far a measured advance may sit from the pinned face's own.
 *
 * The competing face measures 0.600 em, which is 0.002 away, so this is a tenth of
 * the distance to the nearest wrong answer — wide enough for sub-pixel layout
 * rounding, far too narrow to accept the face this pin exists to exclude.
 */
const ADVANCE_TOLERANCE_EM = 0.0002;

/** What one character of `PROBE_TEXT` advances, in em, as this document renders it. */
function measureAdvanceEm(fontFamily: string): number {
  const probe = document.createElement("span");
  probe.textContent = PROBE_TEXT;
  probe.style.fontFamily = fontFamily;
  probe.style.fontSize = `${PROBE_FONT_SIZE_PX}px`;
  probe.style.whiteSpace = "pre";
  probe.style.position = "absolute";
  document.body.append(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width / (PROBE_FONT_SIZE_PX * PROBE_TEXT.length);
}

/** The advance of monospace text reached the way the console's stylesheets reach it. */
function measureTokenAdvanceEm(): number {
  return measureAdvanceEm(`var(${MONOSPACE_FONT_CUSTOM_PROPERTY})`);
}

describe("the face a capture is taken under", () => {
  beforeEach(() => {
    installMeridianTokens(document);
  });

  it("is pinned by the project's own setup, so a new family's file inherits it", () => {
    // No hook in this file pins anything. If the setup file were dropped from the
    // project the property would still resolve — to the shipped stack, off whichever
    // face the host had registered — and this is the assertion that notices.
    //
    // FIRST in the file, and every case below leaves the property as it found it,
    // because a case that inherited a pin from a case that ran before it would go on
    // passing with the setup file removed. That is not hypothetical: it was how this
    // suite behaved before, and removing the wiring to check is what showed it.
    expect(document.documentElement.style.getPropertyValue(MONOSPACE_FONT_CUSTOM_PROPERTY)).toBe(
      CAPTURE_MONOSPACE_STACK,
    );
  });

  it("resolves monospace text to the pinned face rather than to the host's own", () => {
    // Through the custom property, never through the pinned stack directly: that is
    // the path `figure.css`, `chip.css`, and the terminal host all take, so a pin
    // that reached the property but not the surfaces would still fail here.
    expect(Math.abs(measureTokenAdvanceEm() - CAPTURE_MONOSPACE_ADVANCE_EM)).toBeLessThan(
      ADVANCE_TOLERANCE_EM,
    );
  });

  it("follows the property rather than reporting a face of its own", () => {
    // The negative control. `serif` resolves on every host and is never fixed-width,
    // so a measurement that did not actually follow the property would go on
    // reporting the pinned face here and the assertion above would pass vacuously.
    document.documentElement.style.setProperty(MONOSPACE_FONT_CUSTOM_PROPERTY, "serif");
    const underADifferentFace = measureTokenAdvanceEm();
    // Removed rather than re-pinned, so nothing this case did survives into the next
    // one and the setup file stays the only thing that pins anything here.
    document.documentElement.style.removeProperty(MONOSPACE_FONT_CUSTOM_PROPERTY);

    expect(Math.abs(underADifferentFace - CAPTURE_MONOSPACE_ADVANCE_EM)).toBeGreaterThan(
      ADVANCE_TOLERANCE_EM,
    );
  });

  it("is still pinned for the case after one that cleared the property", () => {
    // The setup file runs per test, so a case that reset the document does not leave
    // the next family's capture rendering off the host's own face.
    expect(document.documentElement.style.getPropertyValue(MONOSPACE_FONT_CUSTOM_PROPERTY)).toBe(
      CAPTURE_MONOSPACE_STACK,
    );
  });
});
