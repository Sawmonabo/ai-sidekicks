// The screenshot tier: the browser-terminal family's three surfaces, per scheme.
//
// `settled-capture.ts` owns the mechanism this file rides: every capture is written
// into the gitignored `__screenshots__/` and compared against nothing, so this file
// gates on whether each surface can be captured at all.
//
// WHAT IS PINNED, AND WHY THESE THREE. The family ships two pane bodies and the card
// the browser's captures land as, and each is a different composition rather than a
// state of one:
//
//   • the browser pane's chrome, whose whole design claim is that a control is
//     disabled from the view's REPORTED state and that the surfaces the namespace
//     does not yet serve render an absence instead of a dead button — a claim that
//     is about what is drawn, which is what an image can hold and a DOM assertion
//     reads only one attribute of;
//   • a stored capture card, the object 12.6 says a capture "lands as", collapsed to
//     name, kind, and size with the preview one click away;
//   • the terminal pane on a DEGRADED lease, which is the frame `bridge/scenario/
//     terminal.ts` says a capture should hold — its own header: the script ends on
//     the host going silent under a lease that had just been taken, which "carries
//     everything the held frame carried plus the reading that took the keyboard
//     away", while a script ending on a free lease "would pin the emptiest frame the
//     surface has".
//
// Three surfaces and two schemes is six captures, written afresh on whichever host
// runs the tier.

import { afterEach, beforeEach, describe, it } from "vitest";

import { emulateSystemScheme } from "../console-harness.js";
import {
  mountBrowserCaptureCard,
  mountBrowserPane,
  mountTerminalPane,
  type MountedFamilySurface,
} from "../surfaces/browser-terminal.js";
import { captureSettled } from "./settled-capture.js";

import { installMeridianTokens } from "../../../src/renderer/src/console/frame/index.js";
import { CONSOLE_SCHEMES } from "../../../src/renderer/src/console/tokens/tokens.js";

/**
 * The surfaces this tier captures, each with the name its image is written under.
 *
 * A table rather than three near-identical suites: the cases differ only in which
 * surface is mounted, and three copies of the same six lines is three places for the
 * scheme emulation to be forgotten in one of them.
 */
const PINNED_SURFACES: readonly {
  readonly captureName: string;
  readonly mount: () => Promise<MountedFamilySurface>;
}[] = [
  { captureName: "browser-pane-chrome", mount: mountBrowserPane },
  { captureName: "browser-capture-card", mount: mountBrowserCaptureCard },
  { captureName: "terminal-pane-degraded-lease", mount: mountTerminalPane },
];

beforeEach(() => {
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  // Leave the emulation off, so a later file's baseline is not captured under
  // whichever scheme this one finished in.
  await emulateSystemScheme("light");
});

describe("screenshot — the browser and terminal surfaces", () => {
  for (const surface of PINNED_SURFACES) {
    for (const scheme of CONSOLE_SCHEMES) {
      it(`renders ${surface.captureName} in the ${scheme} scheme`, async () => {
        // Through the system preference rather than a stamped attribute: the token
        // sheet's dark layer is a `prefers-color-scheme` block, and driving it is
        // what a default install actually resolves.
        await emulateSystemScheme(scheme);
        const mounted = await surface.mount();

        await captureSettled(mounted.element, `${surface.captureName}-${scheme}`);
      });
    }
  }
});
