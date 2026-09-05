// The terminal pane's own box, measured against the slot it is given.
//
// This belongs to the browser tier and can belong nowhere else: happy-dom returns
// zeroes from every `getBoundingClientRect` and resolves no custom property through
// the cascade, so a case asserting "the pane is exactly as tall as its slot" would
// pass under the unit tier against a pane of any height at all.
//
// The rule it pins is one line of CSS and the failure it replaces is invisible in a
// screenshot of the top of the pane: with the content box sized to 100% and the
// padding added outside it, the pane overhung its slot by twice the pane padding, and
// what fell off the bottom was the emulator's last rows.

import { describe, expect, it } from "vitest";

import { renderSettled } from "../console-harness.js";

import { installMeridianTokens } from "../../../src/renderer/src/console/frame/index.js";
import { TerminalPane } from "../../../src/renderer/src/console/terminal/pane/TerminalPane.js";
// The family door, imported for its side effect: `apps/desktop/AGENTS.md` puts a
// family's stylesheet behind its own barrel and nowhere else, and this tier is about
// what that stylesheet computes to.
import "../../../src/renderer/src/console/terminal/index.js";
import { createFixtureBridge } from "../../../src/renderer/src/console/bridge/index.js";
import { TERMINAL_SCENARIO } from "../../../src/renderer/src/console/bridge/scenarios/terminal.js";

/** A deck slot of a fixed height, which is the only case the rule is about. */
const SLOT_HEIGHT_PX = 400;

async function mountPaneInFixedSlot(): Promise<{
  readonly slot: HTMLElement;
  readonly pane: HTMLElement;
}> {
  installMeridianTokens(document);
  const bridge = createFixtureBridge({ scenario: TERMINAL_SCENARIO });
  const { container } = await renderSettled(
    <div style={{ height: `${String(SLOT_HEIGHT_PX)}px` }}>
      <TerminalPane paneId="pane-terminal" bridge={bridge} sessionStore={undefined} />
    </div>,
  );
  const slot = container.firstElementChild;
  const pane = container.querySelector(".meridian-terminal-pane");
  if (!(slot instanceof HTMLElement) || !(pane instanceof HTMLElement)) {
    throw new Error("the terminal pane did not mount into a slot");
  }
  return { slot, pane };
}

describe("browser — the terminal pane's padding is inside its height", () => {
  it("fits its slot exactly, rather than overhanging it by its own padding", async () => {
    const { slot, pane } = await mountPaneInFixedSlot();

    expect(slot.getBoundingClientRect().height).toBe(SLOT_HEIGHT_PX);
    expect(pane.getBoundingClientRect().height).toBe(SLOT_HEIGHT_PX);
  });

  it("still spends the padding, so the fit is not bought by dropping it", async () => {
    // The negative control. A pane that had simply lost its padding would satisfy the
    // case above and would put the emulator hard against the pane's edge.
    const { pane } = await mountPaneInFixedSlot();
    const padding = Number.parseFloat(getComputedStyle(pane).paddingBlockStart);

    expect(padding).toBeGreaterThan(0);
    expect(getComputedStyle(pane).boxSizing).toBe("border-box");
  });
});
