// The terminal pane's own box, measured against the space the chrome gives it.
//
// This belongs to the browser tier and can belong nowhere else: happy-dom returns
// zeroes from every `getBoundingClientRect` and resolves no custom property through
// the cascade, so a case asserting "the pane body is exactly as tall as its cell"
// would pass under the unit tier against a body of any height at all.
//
// The rule it pins is one line of CSS and the failure it replaces is invisible in a
// screenshot of the top of the pane: with the content box sized to its cell and the
// padding added outside it, the body overhung the cell by twice the pane padding, and
// what fell off the bottom was the emulator's last rows.
//
// THE CELL IS TWO BOXES DEEP, because the frame is `PaneFrame`'s.
// The pane layout sizes the chrome's `<section>`; the chrome gives its body a flex region
// under the head; the terminal pane's box grows into that. So the measurement is the same
// one against a taller stack: the section fits the pane layout cell, and the body's own box
// spends its padding inside whatever the section left it rather than beyond it.

import { describe, expect, it } from "vitest";

import { renderSettled } from "../helpers/app-harness.js";

import { contentBlockSize } from "./content-block-size.js";

import { installMeridianTokens } from "@renderer/app/token-installation.js";
import { TerminalPane } from "@renderer/features/terminal/pane/components/TerminalPane.js";
// The context builder beside the pane, for the reason it is exported: the `terminal`
// arm's members are answered in one place, and a tier that spelled its own copy would
// be the second answer.
import { terminalPaneContext } from "@renderer/features/terminal/pane/components/TerminalPane.test-support.js";
// The pane body, imported for its stylesheets: it is the one module that carries the
// terminal's rules, and this tier is about what those rules compute to.
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
    // `display: grid` rather than a bare block, because that is what makes the cell
    // SIZE the pane: a grid item stretches to its area in both axes, so the chrome's
    // section takes the 400 px the pane layout allotted it. A block parent would leave the
    // section at its content height and the case below would measure nothing.
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
    // The region's own padding is room for the browser's focus mark, so the pane's box
    // fills the region's content box rather than its outer edge.
    expect(body.getBoundingClientRect().height).toBe(contentBlockSize(bodyRegion));
  });

  it("still spends the padding, so the fit is not bought by dropping it", async () => {
    // The negative control. A pane that had simply lost its padding would satisfy the
    // case above and would put the emulator hard against the pane's edge.
    const { body } = await mountPaneInFixedCell();
    const padding = Number.parseFloat(getComputedStyle(body).paddingBlockStart);

    expect(padding).toBeGreaterThan(0);
    expect(getComputedStyle(body).boxSizing).toBe("border-box");
  });

  it("leaves the head its own height rather than covering it", async () => {
    // The second negative control, and the one the two-box stack made necessary: a
    // body that filled the whole section — `block-size: 100%` against the frame
    // rather than a flex grow against the region under the head — would satisfy both
    // cases above while drawing over the breadcrumb the pane is named by.
    const { frame, bodyRegion } = await mountPaneInFixedCell();

    expect(bodyRegion.getBoundingClientRect().height).toBeLessThan(
      frame.getBoundingClientRect().height,
    );
  });
});
