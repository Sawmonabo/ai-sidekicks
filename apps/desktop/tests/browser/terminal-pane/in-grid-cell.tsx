// The terminal pane mounted in a grid cell of a fixed height, for the browser cases that measure
// a pane's box against its cell. `display: grid` so the cell sizes the pane: a grid item
// stretches to its area, where a block parent would leave the pane at its content height.

import { renderSettled } from "../../helpers/app/harness.js";

import { installMeridianTokens } from "@renderer/app/token-installation.js";
import { TerminalPane } from "@renderer/features/terminal/pane/components/TerminalPane.js";
// The context builder beside the pane answers the `terminal` arm's members in one place.
import { terminalPaneContext } from "@renderer/features/terminal/pane/components/TerminalPane.test-support.js";
// The pane body, imported for the pane's and the terminal's stylesheets, which these cases measure.
import "@renderer/features/terminal/pane/terminal-pane-body.js";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { TERMINAL_LEASE_SCENARIO } from "@fixtures/scenarios/terminal-lease.js";

/** The boxes a case measures: the cell, the pane frame, the frame's body region, and the body. */
interface MountedTerminalPaneBoxes {
  readonly layoutCell: HTMLElement;
  readonly frame: HTMLElement;
  readonly bodyRegion: HTMLElement;
  readonly body: HTMLElement;
}

/** Mounts the terminal pane in a grid cell `cellHeightPx` tall, or throws if a box is missing. */
export async function mountTerminalPaneInGridCell(
  cellHeightPx: number,
): Promise<MountedTerminalPaneBoxes> {
  installMeridianTokens(document);
  const { bridge } = createFixtureBridge({ scenario: TERMINAL_LEASE_SCENARIO });
  const { container } = await renderSettled(
    <div style={{ display: "grid", height: `${String(cellHeightPx)}px` }}>
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
    throw new Error("the terminal pane did not mount into its grid cell");
  }
  return { layoutCell, frame, bodyRegion, body };
}
