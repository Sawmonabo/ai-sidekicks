// Whether a pane fills the cell the pane layout gives it, in the arrangement the pane layout
// actually uses.
//
// `.meridian-pane` (`PaneFrame.css`) takes `flex: 1 1 auto`. The pane layout is a column flex chain
// (`features/sessions/pane-layout/components/SessionPaneLayout.css`), where the initial `0 1 auto`
// would size a pane by its content and hand the transcript's scroll container a fraction of the
// layout's height. Under a grid parent `flex` is inert, so both arrangements ship and both are
// covered here.
//
// The subject is the frame, not the terminal pane: `.meridian-pane` is one sheet for every kind,
// and the terminal pane is the cheapest body to hang it on because it already publishes a
// context builder.

import { describe, expect, it } from "vitest";

import { renderSettled } from "../../helpers/app/harness.js";
import { mountTerminalPaneInGridCell } from "../terminal-pane/in-grid-cell.js";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { TerminalPane } from "#renderer/features/terminal/pane/components/TerminalPane.js";
import { terminalPaneContext } from "#renderer/features/terminal/pane/components/TerminalPane.test-support.js";
// Imported for its stylesheet, `SessionPaneLayout.css`, the other half of the arrangement under
// test.
import "#renderer/features/sessions/pane-layout/components/SessionPaneLayout.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { TERMINAL_LEASE_SCENARIO } from "#fixtures/scenarios/terminal-lease.js";

/** The pane layout's own height. Every assertion below is against this one number. */
const PANE_LAYOUT_HEIGHT_PX = 600;

/**
 * How `react-resizable-panels` lays its group out. The library writes it inline at runtime and
 * this tier measures CSS; the case depends only on the group being a row, which makes the pane
 * cell inside it stretch vertically.
 */
const RESIZABLE_GROUP_LAYOUT = { display: "flex", flexDirection: "row" } as const;

interface MountedPane {
  readonly layoutCell: HTMLElement;
  readonly pane: HTMLElement;
}

async function mountPaneInPaneLayout(): Promise<MountedPane> {
  installMeridianTokens(document);
  const { bridge } = createFixtureBridge({ scenario: TERMINAL_LEASE_SCENARIO });
  const { container } = await renderSettled(
    <div className="meridian-pane-layout" style={{ height: `${String(PANE_LAYOUT_HEIGHT_PX)}px` }}>
      <div className="meridian-pane-layout__group" style={RESIZABLE_GROUP_LAYOUT}>
        <div className="meridian-pane-layout__pane">
          <TerminalPane {...terminalPaneContext(undefined, bridge)} />
        </div>
      </div>
    </div>,
  );
  const layoutCell = container.querySelector(".meridian-pane-layout__pane");
  const pane = container.querySelector(".meridian-pane");
  if (!(layoutCell instanceof HTMLElement) || !(pane instanceof HTMLElement)) {
    throw new Error("the pane did not mount into a pane layout cell");
  }
  return { layoutCell, pane };
}

describe("browser — a pane fills the cell the pane layout gives it", () => {
  it("takes the whole cell height in the pane layout's column-flex arrangement", async () => {
    const { layoutCell, pane } = await mountPaneInPaneLayout();

    expect(layoutCell.getBoundingClientRect().height).toBe(PANE_LAYOUT_HEIGHT_PX);
    expect(
      pane.getBoundingClientRect().height,
      "the pane is sized by its content rather than by its cell, so " +
        "every box below it — the transcript's scroll container included " +
        "— is measuring against a height the pane layout never gave it",
    ).toBe(PANE_LAYOUT_HEIGHT_PX);
  });

  it("still fills a grid cell, which is the arrangement that already worked", async () => {
    // Keeps the rule about growing rather than a height: a pane given `height: 100%` would pass
    // the case above and break here once a cell stopped being its parent's full height. It also
    // pins that the flex rule leaves the grid path alone, since `flex` is inert on a grid item.
    const { layoutCell, frame: pane } = await mountTerminalPaneInGridCell(PANE_LAYOUT_HEIGHT_PX);

    expect(layoutCell.getBoundingClientRect().height).toBe(PANE_LAYOUT_HEIGHT_PX);
    expect(pane.getBoundingClientRect().height).toBe(PANE_LAYOUT_HEIGHT_PX);
  });

  it("negative control: a pane in a column-flex box with no height hugs its content", async () => {
    // Without this the two cases above would pass over a `.meridian-pane` simply given a height;
    // the claim is that the pane takes what its cell has, and a cell with nothing to give leaves
    // it at its content.
    installMeridianTokens(document);
    const { bridge } = createFixtureBridge({ scenario: TERMINAL_LEASE_SCENARIO });
    const { container } = await renderSettled(
      <div style={{ display: "flex", flexDirection: "column" }}>
        <TerminalPane {...terminalPaneContext(undefined, bridge)} />
      </div>,
    );
    const pane = container.querySelector(".meridian-pane");
    if (!(pane instanceof HTMLElement)) {
      throw new Error("the pane did not mount");
    }

    expect(pane.getBoundingClientRect().height).toBeLessThan(PANE_LAYOUT_HEIGHT_PX);
  });
});
