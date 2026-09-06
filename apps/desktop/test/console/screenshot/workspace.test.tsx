// The screenshot tier: the session workspace, with its sidebar open and collapsed.
//
// `Spec-023 §Console Test Tiers` names a screenshot tier "per component and per
// scheme", and the workspace is the surface where the sidebar's own claim is
// visible at all: the split between the deck and the column, the eight section
// headers a person reads down, and the rail the collapsed sidebar leaves behind.
// None of that is checkable from the DOM assertions in the unit tier — a sidebar
// rendered at zero width, behind the deck, or with its rail clipped away passes
// every one of them.
//
// TWO SUBJECTS RATHER THAN ONE, and the second is not decoration. Collapsed is the
// state a person leaves the sidebar in for a whole session, and the failure it
// guards against is the one that cannot be asserted: a rail with nothing on it is
// a sidebar there is no way back from.
//
// AND THE TWO SUBJECTS SHARE A DATABASE, which is what the reset and the two guards
// below are for. The collapse a person makes is DURABLE — it is written under this
// session's partition and read back by the next mount — so the collapsed case here
// used to arrive in the expanded case after it, and the tier minted a dark
// "expanded" reference byte-identical to its own collapsed sibling. Each case now
// starts from a deleted database and refuses to photograph a sidebar in the state
// the other case's reference is named for.
//
// The tier's fail-closed guard and its missing-reference probe are asserted once
// for the whole tier by `frame.test.tsx`; `baseline-platform.ts` says why they are
// not repeated here, and holds the one decision about which hosts may compare — a
// RUNNER rather than a platform. `baseline-host.ts` reads this run against that rule
// once, and this file asks it rather than reading the environment for itself.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "@testing-library/react";

import {
  awaitSessionRouteMounted,
  emulateSystemScheme,
  renderSettled,
  resetDurableConsoleState,
} from "../console-harness.js";
import {
  requireCapturedElement,
  skipOffBaselineHost,
  warnOnceOffBaselineHost,
} from "./baseline-host.js";

import {
  ConsoleRoot,
  installMeridianTokens,
} from "../../../src/renderer/src/console/frame/index.js";
import { formatRoute } from "../../../src/renderer/src/console/routing/index.js";
import { CONSOLE_SCHEMES } from "../../../src/renderer/src/console/tokens/tokens.js";
import {
  LEDGER_QUIET_SCENARIO,
  LEDGER_QUIET_SCENARIO_ID,
} from "../../../src/renderer/src/console/bridge/scenarios/ledger-quiet.js";

/** The sidebar's own column, which both of its arms render and neither omits. */
const SIDEBAR_SELECTOR = ".meridian-sidebar";

/**
 * The marker the collapsed arm puts on that column.
 *
 * Read off the column rather than inferred from which control is on screen: it is
 * what the stylesheet keys on, so it is the one reading that cannot be true while
 * the picture disagrees with it.
 */
const SIDEBAR_COLLAPSED_CLASS = "meridian-sidebar--collapsed";

/** What one opened workspace hands back: the mount, and what a capture is taken of. */
interface WorkspaceMount {
  readonly container: HTMLElement;
  /** The whole console window — the composition this file pins. */
  readonly frame: Element;
}

/**
 * The workspace with its sidebar mounted and arrived, or a throw.
 *
 * A throw rather than the assert-then-return-early shape, which turns "the sidebar
 * never mounted" into a test that passes having photographed a deck alone.
 *
 * THE ARRIVAL WAIT IS WHAT MAKES THE GUARDS BELOW MEAN ANYTHING, and it was measured
 * rather than assumed. `renderSettled` returns while the sidebar's saved arrangement
 * is still being read, so the arm it hands back is not always the arm the capture
 * will see: with a record on disk, this file read an expanded sidebar two turns
 * before a restored collapse landed, and photographed the collapse. The harness's
 * wait puts every reading after the session route has finished arriving.
 */
async function openWorkspace(): Promise<WorkspaceMount> {
  document.location.hash = formatRoute({
    kind: "workspace",
    sessionId: LEDGER_QUIET_SCENARIO.sessionId,
  });
  const { container } = await renderSettled(<ConsoleRoot scenarioId={LEDGER_QUIET_SCENARIO_ID} />);
  const frame = requireCapturedElement(container, ".meridian-frame");
  await awaitSessionRouteMounted(container);
  // Asked for its own sake: the frame alone mounts on a route whose sidebar never
  // arrived, and a capture of that is a picture of a deck this file is not pinning.
  requireCapturedElement(container, SIDEBAR_SELECTOR);
  return { container, frame };
}

/** Which arm the sidebar rendered, as the column itself reports it. */
function sidebarIsCollapsed(container: HTMLElement): boolean {
  return requireCapturedElement(container, SIDEBAR_SELECTOR).classList.contains(
    SIDEBAR_COLLAPSED_CLASS,
  );
}

/**
 * Refuse a capture of a sidebar that is not in the state its reference is named for.
 *
 * A throw rather than the assert-then-return-early shape, on this file's own
 * doctrine: a case that photographed the wrong arm and reported a pass is exactly
 * what put a collapsed sidebar under the dark expanded reference. The collapsed
 * case needs no mirror of this before its click — the collapse control exists only
 * on the expanded arm, so a mount that arrived collapsed is refused by
 * `collapseSidebar` for having no control to press.
 */
function requireSidebarExpanded(container: HTMLElement): void {
  if (sidebarIsCollapsed(container)) {
    throw new Error(
      "the sidebar rendered its collapsed arm, so this capture would put a collapsed sidebar under " +
        "a reference named for the expanded one — an earlier case's arrangement was restored into " +
        "this mount",
    );
  }
}

/** Collapse the sidebar the way a person does: the control on the column itself. */
function collapseSidebar({ container, frame }: WorkspaceMount): void {
  const control = frame.querySelector<HTMLButtonElement>(".meridian-sidebar__collapse");
  if (control === null) {
    throw new Error(
      "the sidebar rendered no collapse control, so the collapsed subject cannot be reached the way a person reaches it",
    );
  }
  // Inside `act`, because the collapse is a store transition whose commit the capture
  // below reads: outside it the frame is photographed one commit behind the state the
  // reference is named for.
  act(() => {
    control.click();
  });
  if (!sidebarIsCollapsed(container)) {
    throw new Error(
      "the collapse control was pressed and the sidebar did not render its collapsed arm, so this " +
        "capture would put an expanded sidebar under the collapsed reference",
    );
  }
}

beforeEach(async () => {
  // Before the mount rather than after it: the database outlives this file, so what
  // has to be true is that nothing is in it when a case starts.
  await resetDurableConsoleState();
  document.location.hash = "";
  installMeridianTokens(document);
});

afterEach(async () => {
  document.location.hash = "";
  // Leave the emulation off, so a later file's baseline is not captured under
  // whichever scheme this one finished in.
  await emulateSystemScheme("light");
});

describe("screenshot — the session workspace and its sidebar", () => {
  // Said once at collection, on the one channel the terminal reporter forwards.
  warnOnceOffBaselineHost();

  for (const scheme of CONSOLE_SCHEMES) {
    it(`renders the sidebar expanded in the ${scheme} scheme`, async (context) => {
      skipOffBaselineHost(context);
      await emulateSystemScheme(scheme);
      const mount = await openWorkspace();
      requireSidebarExpanded(mount.container);

      await expect(mount.frame).toMatchScreenshot(`workspace-sidebar-expanded-${scheme}`);
    });

    it(`renders the sidebar collapsed in the ${scheme} scheme`, async (context) => {
      skipOffBaselineHost(context);
      await emulateSystemScheme(scheme);
      const mount = await openWorkspace();
      collapseSidebar(mount);

      await expect(mount.frame).toMatchScreenshot(`workspace-sidebar-collapsed-${scheme}`);
    });
  }
});
