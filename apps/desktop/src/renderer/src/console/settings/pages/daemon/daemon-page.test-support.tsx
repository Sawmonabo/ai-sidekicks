// The local-runtime page, mounted over a port a case scripts.
//
// Shared by the two suites beside it — what the page SAYS
// (`DaemonPage.test.tsx`) and what it does when the port breaks its own contract
// (`DaemonPage.rejections.test.tsx`) — because both drive the same three operations
// through the same mount and a second copy of this port would be two answers to what
// the page is talking to.
//
// THE PORT IS SCRIPTED PER CASE AND BUILT ONCE PER MOUNT. The status answer is held
// against the growth port that produced it, so a bridge rebuilt per render would
// re-address the holder on every pass and make every re-read case read as a re-read
// that never happened.

import { render } from "@testing-library/react";
import type { ReactNode } from "react";

import type { ConsoleBridge } from "../../../bridge/index.js";
import { createRefusingGrowthPort } from "../../../bridge/growth-port/growth-port.js";
import { UNREPORTED_SHELL_STATE, type ShellState } from "../../../store/index.js";
import { settingsPageContextWith } from "../../settings-page-mount.test-support.js";
import { DaemonPage } from "./DaemonPage.js";

/** The calls a case wants to see, in the order they were made. */
export interface ControlLedger {
  readonly calls: string[];
  /**
   * One entry per status read, carrying the version THAT read answered with.
   *
   * A list and not a count, because both halves of the re-read claim are read off it:
   * how many reads there were, and which answer is the one on screen.
   */
  readonly statusReads: string[];
}

/** How a case wants the port underneath the page to behave. */
export interface PortScript {
  readonly servesStatus: boolean;
  /**
   * Whether a dispatched control is recorded and then never answered.
   *
   * The two double-press cases are about the window BETWEEN the dispatch and its
   * settlement, and a port that answers on the next microtask closes that window
   * before an assertion can read it — so those cases hold it open instead of racing.
   */
  readonly holdsControls: boolean;
  /**
   * Whether a call REJECTS instead of answering, and with what.
   *
   * `undefined` is a port that keeps its contract. A value is the failure the page has
   * no arm of its own for: every growth operation is typed to resolve, and the
   * rejection channel of a promise exists whether a contract uses it or not — a
   * transport that goes away mid-dispatch takes it, and so does the fixture seam that
   * throws a daemon envelope verbatim.
   */
  readonly rejection?: unknown;
}

/** Which of the three operations a scripted rejection applies to. */
export type RejectingOperation = "controls" | "status";

/** The reason a rejecting port hands back. Prose, so a case can assert it reached screen. */
export const TRANSPORT_GONE_MESSAGE = "the shell transport went away mid-dispatch";

/** One mounted page, and the supervisor state a case can move under it. */
export interface MountedDaemonPage {
  readonly container: HTMLElement;
  readonly ledger: ControlLedger;
  /** Re-render the page under a different supervisor state, over the SAME bridge. */
  readonly showShellState: (next: ShellState) => void;
}

export function renderPage(options: {
  readonly shellState?: ShellState;
  readonly servesStatus?: boolean;
  readonly holdsControls?: boolean;
  readonly ledger?: ControlLedger;
  /** What a call rejects with, and which operation takes it. */
  readonly rejection?: unknown;
  readonly rejecting?: RejectingOperation;
}): MountedDaemonPage {
  const ledger = options.ledger ?? { calls: [], statusReads: [] };
  const bridge = bridgeWith(
    ledger,
    {
      servesStatus: options.servesStatus ?? true,
      holdsControls: options.holdsControls ?? false,
      rejection: options.rejection,
    },
    options.rejecting,
  );
  const pageUnder = (shellState: ShellState): ReactNode => (
    <DaemonPage context={settingsPageContextWith(bridge, undefined, { shellState })} />
  );
  const { container, rerender } = render(pageUnder(options.shellState ?? UNREPORTED_SHELL_STATE));
  return {
    container,
    ledger,
    showShellState: (next) => {
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
    throw new Error(`no button labelled ${label}`);
  }
  return button;
}

function bridgeWith(
  ledger: ControlLedger,
  script: PortScript,
  rejecting: RejectingOperation | undefined,
): ConsoleBridge {
  const holdOpen = async (): Promise<void> => {
    if (script.holdsControls) {
      await new Promise<void>(() => undefined);
    }
  };
  const growth = {
    ...createRefusingGrowthPort(),
    // A DIFFERENT VERSION EVERY TIME, so a case can tell a re-read from a re-render:
    // an answer that never changes cannot distinguish a page that asked again from one
    // that kept the first reply.
    daemonStatusRead: async () => {
      if (rejecting === "status") {
        throw script.rejection;
      }
      if (!script.servesStatus) {
        return await createRefusingGrowthPort().daemonStatusRead({});
      }
      const version = `2026-04-30-read-${ledger.statusReads.length + 1}`;
      ledger.statusReads.push(version);
      return { status: "served", value: { state: "connected", version } } as const;
    },
    daemonStop: async () => {
      ledger.calls.push("stop");
      await holdOpen();
      if (rejecting === "controls") {
        throw script.rejection;
      }
      return { status: "served", value: undefined } as const;
    },
    daemonRestart: async () => {
      ledger.calls.push("restart");
      await holdOpen();
      if (rejecting === "controls") {
        throw script.rejection;
      }
      return await createRefusingGrowthPort().daemonRestart({});
    },
  };
  return { growth } as unknown as ConsoleBridge;
}
