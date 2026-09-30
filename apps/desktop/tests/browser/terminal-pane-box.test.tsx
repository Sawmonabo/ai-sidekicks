// The terminal pane's own box, measured against the space the chrome gives it. happy-dom
// returns zeroes from every `getBoundingClientRect` and resolves no custom property, so "the
// pane body is exactly as tall as its cell" would pass there against a body of any height.
//
// The rule is one line of CSS: with the content box sized to its cell and the padding added
// outside it, the body would overhang the cell by twice the pane padding and the emulator's
// last rows would fall off the bottom, invisible in a screenshot of the pane's top.
//
// The cell is two boxes deep because the frame is `PaneFrame`'s: the pane layout sizes the
// chrome's `<section>`, the chrome gives its body a flex region under the head, and the terminal
// pane's box grows into that. The body's box must spend its padding inside what the section
// left it.

import { describe, expect, it } from "vitest";

import { renderSettled } from "../helpers/app-harness.js";

import { installMeridianTokens } from "@renderer/app/token-installation.js";
import { TerminalPane } from "@renderer/features/terminal/pane/components/TerminalPane.js";
// The context builder beside the pane answers the `terminal` arm's members in one place.
import { terminalPaneContext } from "@renderer/features/terminal/pane/components/TerminalPane.test-support.js";
// The pane body, imported for the terminal's stylesheets, which this tier measures.
import "@renderer/features/terminal/pane/terminal-pane-body.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { TERMINAL_LEASE_SCENARIO } from "../../fixtures/scenarios/terminal-lease.js";

/** A pane layout cell of a fixed height, which is the only case the rule is about. */
const LAYOUT_CELL_HEIGHT_PX = 400;

/** What the three cases below measure: the pane layout's cell, the frame, and this box. */
interface MountedPaneBoxes {
  readonly layoutCell: HTMLElement;
  readonly frame: HTMLElement;
  readonly body: HTMLElement;
  readonly bodyRegion: HTMLElement;
}

async function mountPaneInFixedCell(): Promise<MountedPaneBoxes> {
  installMeridianTokens(document);
  const { bridge } = createFixtureBridge({ scenario: TERMINAL_LEASE_SCENARIO });
  const { container } = await renderSettled(
    // `display: grid` so the cell sizes the pane: a grid item stretches to its area, so the
    // chrome's section takes the 400 px allotted. A block parent would leave it at its content
    // height and the cases would measure nothing.
    <div style={{ display: "grid", height: `${String(LAYOUT_CELL_HEIGHT_PX)}px` }}>
      <TerminalPane {...terminalPaneContext(undefined, bridge)} />
    </div>,
  );
  const layoutCell = container.firstElementChild;
  const frame = container.querySelector(".meridian-pane");
  const bodyRegion = container.querySelector(".meridian-pane__body");
  const body = container.querySelector(".meridian-terminal-pane");
  if (
    !(layoutCell instanceof HTMLElement) ||
    !(frame instanceof HTMLElement) ||
    !(bodyRegion instanceof HTMLElement) ||
    !(body instanceof HTMLElement)
  ) {
    throw new Error("the terminal pane did not mount into its cell");
  }
  return { layoutCell, frame, body, bodyRegion };
}

describe("browser — the terminal pane's padding is inside its height", () => {
  it("fits its cell exactly, rather than overhanging it by its own padding", async () => {
    const { layoutCell, frame, body, bodyRegion } = await mountPaneInFixedCell();

    expect(layoutCell.getBoundingClientRect().height).toBe(LAYOUT_CELL_HEIGHT_PX);
    expect(frame.getBoundingClientRect().height).toBe(LAYOUT_CELL_HEIGHT_PX);
    expect(body.getBoundingClientRect().height).toBe(bodyRegion.getBoundingClientRect().height);
  });

  it("still spends the padding, so the fit is not bought by dropping it", async () => {
    // Negative control: a pane that simply lost its padding would satisfy the case above and put
    // the emulator hard against the pane's edge.
    const { body } = await mountPaneInFixedCell();
    const padding = Number.parseFloat(getComputedStyle(body).paddingBlockStart);

    expect(padding).toBeGreaterThan(0);
    expect(getComputedStyle(body).boxSizing).toBe("border-box");
  });

  it("leaves the head its own height rather than covering it", async () => {
    // A body that filled the whole section (`block-size: 100%` against the frame rather than a
    // flex grow against the region under the head) would satisfy both cases above while drawing
    // over the breadcrumb the pane is named by.
    const { frame, bodyRegion } = await mountPaneInFixedCell();

    expect(bodyRegion.getBoundingClientRect().height).toBeLessThan(
      frame.getBoundingClientRect().height,
    );
  });
});
