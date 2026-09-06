// The harness the two mount modules share: what a mounted surface IS, and the waits
// that say it has settled.
//
// SPLIT OUT SO THE MOUNTS DO NOT SHARE A FILE WITH THE MACHINERY. `repos.tsx` and
// `repos-artifact.tsx` each hold surfaces and nothing else, and both reach into this
// module's exports — so the alternative was one of them exporting its own privates to
// the other, which would have made a mount module the harness's home by accident.
//
// EVERY WAIT HERE THROWS RATHER THAN RETURNING FALSE. A tier that timed out silently
// would capture an unsettled surface and compare it against a baseline of a settled
// one, and the failure would surface as a pixel diff naming nothing. The message names
// the selector that never arrived.

import { waitFor, within } from "@testing-library/react";

import { advanceScenarioUntil } from "../../../src/renderer/src/console/repos/scenario-clock.test-support.js";

import type { ConsoleBridge } from "../../../src/renderer/src/console/bridge/index.js";

/** The element a tier reads, and the bridge it was mounted against. */
export interface MountedFamilySurface {
  readonly element: HTMLElement;
  readonly bridge: ConsoleBridge;
}

/** How long a surface's first read may take to settle before a tier gives up. */
const FAMILY_READ_TIMEOUT_MS = 5_000;

/**
 * How far a mount moves the scenario clock to let a scheduled read land.
 *
 * Comfortably past `REFRESH_MAX_WAIT_MS`, and stated as one number rather than tuned
 * per subject: the claim is "every deadline a mounted surface armed has passed", and a
 * value that only just cleared the current one would turn a scheduler retune into a
 * flake in an unrelated tier.
 */
export const SCENARIO_SETTLE_ADVANCE_MS = 1000;

/**
 * Find the one region a surface renders itself as, by the name it announces.
 *
 * By accessible name rather than by class, because that is what a person using
 * assistive technology navigates by — a surface that lost its accessible name would
 * still match a class selector and would still be captured as if nothing had
 * changed. `getByRole` rather than a selector for the same reason: it resolves the
 * name the way the accessibility tree does, through `aria-labelledby` and the
 * heading it points at.
 *
 * A PATTERN AS WELL AS A STRING, because a pane's name is now its whole address
 * trail: `seats/ConsolePaneChrome` names a pane "session-1 artifact-01 Artifact" so
 * two panes of one kind are told apart by what they are views of. A caller that wants
 * to say "the artifact pane, whichever subject it is over" anchors a pattern at the
 * kind; a caller naming a surface whose name is fixed still passes the string.
 */
export function requireLabelledRegion(
  container: HTMLElement,
  accessibleName: string | RegExp,
): HTMLElement {
  return within(container).getByRole("region", { name: accessibleName });
}

/**
 * Find a surface that announces no name of its own, by the class it renders under.
 *
 * The sidebar section is the one such surface this family has, and deliberately: the
 * sidebar chrome owns the section's heading and its disclosure state, so a body that
 * announced a second name would put two regions in the tree for one section. The
 * selector is what is left, and a throw rather than a null keeps a tier from
 * comparing an empty box against a baseline.
 */
export function requireElement(container: HTMLElement, selector: string): HTMLElement {
  const element = container.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`nothing in the mounted tree matches \`${selector}\``);
  }
  return element;
}

/** Wait until a selector resolves inside a mounted surface, or say what did not. */
export async function waitForWithin(region: HTMLElement, selector: string): Promise<void> {
  await waitFor(
    () => {
      if (region.querySelector(selector) === null) {
        throw new Error(`the surface has not rendered \`${selector}\` yet`);
      }
    },
    { timeout: FAMILY_READ_TIMEOUT_MS },
  );
}

/**
 * The same wait, for a surface whose reads are scheduled on the SCENARIO's clock.
 *
 * THE SECTION AND ITS GATES SCHEDULE ON THE BRIDGE'S CLOCK, which under the fixture is
 * the scenario's frozen one — the point of taking it from `consoleClockFor`, and what
 * makes these baselines pin one instant rather than the day they were minted on. Real
 * time therefore moves none of it, so this wait drives the clock instead of polling the
 * machine. The pane mounts above keep `waitForWithin`: their reads run on a port this
 * file scripts directly, with no scenario engine behind them.
 */
export async function driveUntilWithin(
  bridge: ConsoleBridge,
  region: HTMLElement,
  selector: string,
): Promise<void> {
  await advanceScenarioUntil(bridge, () => {
    if (region.querySelector(selector) === null) {
      throw new Error(`the surface has not rendered \`${selector}\` yet`);
    }
  });
}
