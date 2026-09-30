// The local-runtime page and its call-bearing blocks, mounted over operations a case scripts.
//
// Shared by the suites beside it. The operations are built once per mount because the status
// answer is held against the bridge that produced it; a bridge rebuilt per render would make
// a re-read case read as a re-read that never happened.

import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { unscriptedScenario } from "@test/helpers/fixture-bridge.js";
import { NEVER_SETTLES } from "@test/helpers/abandoned-pass.js";
import type { MainProcessState } from "@shared/daemon-status-topic.js";
import { UNREPORTED_MAIN_PROCESS_STATE } from "@renderer/store/window/main-process-state.js";
import { settingsPageContextWith } from "@test/helpers/settings-page-mount.js";
import { DaemonOperationsBlocks, RuntimePage } from "./RuntimePage.js";
import type { DaemonOperations } from "./hooks/useDaemonStatus.js";

/** The calls a case wants to see, in the order they were made. */
export interface ControlLedger {
  readonly calls: string[];
  /**
   * One entry per status read, carrying the version that read answered with.
   *
   * A list, not a count: the re-read claim needs both how many reads there were and which
   * answer is on screen.
   */
  readonly statusReads: string[];
}

/** One mounted page, and the supervisor state a case can move under it. */
export interface MountedRuntimePage {
  readonly container: HTMLElement;
  readonly ledger: ControlLedger;
  /** Re-render the page under a different supervisor state, over the same bridge. */
  readonly showMainProcessState: (next: MainProcessState) => void;
}

/** Mount the page with its call-bearing blocks over scripted operations. */
export function renderRuntimePage(options: {
  readonly mainProcessState?: MainProcessState;
  /**
   * Whether a dispatched control is recorded and then never answered.
   *
   * The double-press cases are about the window between dispatch and settlement; an
   * operation answering on the next microtask closes that window before an assertion can
   * read it.
   */
  readonly holdsControls?: boolean;
}): MountedRuntimePage {
  const ledger: ControlLedger = { calls: [], statusReads: [] };
  const { bridge } = createFixtureBridge({ scenario: unscriptedScenario("daemon-page") });
  const holdOpen = async (): Promise<void> => {
    if (options.holdsControls === true) {
      await NEVER_SETTLES;
    }
  };
  const operations: DaemonOperations = {
    // A different version every time, so a case can tell a re-read from a re-render.
    readStatus: async () => {
      const version = `2026-04-30-read-${ledger.statusReads.length + 1}`;
      ledger.statusReads.push(version);
      return await Promise.resolve({ state: "connected", version });
    },
    stop: async () => {
      ledger.calls.push("stop");
      await holdOpen();
    },
    restart: async () => {
      ledger.calls.push("restart");
      await holdOpen();
    },
  };
  const pageUnder = (mainProcessState: MainProcessState): ReactNode => {
    const context = settingsPageContextWith(bridge, undefined, { mainProcessState });
    return (
      <RuntimePage context={context}>
        <DaemonOperationsBlocks context={context} operations={operations} />
      </RuntimePage>
    );
  };
  const { container, rerender } = render(
    pageUnder(options.mainProcessState ?? UNREPORTED_MAIN_PROCESS_STATE),
  );
  return {
    container,
    ledger,
    showMainProcessState: (next) => {
      rerender(pageUnder(next));
    },
  };
}

/** The button a case presses, found by its own label. */
export function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) {
    throw new Error(`no button labeled ${label}`);
  }
  return button;
}
