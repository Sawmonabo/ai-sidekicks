// The installed bridge the absorbed session probe reads, and the press that reaches it.
//
// Hoisted on second use, per `apps/desktop/AGENTS.md`. Two suites drive a Start press
// through the whole destination — what a SETTLED create does with the session it made,
// and how many creates a burst of presses may put — and both need the same two things:
// a `window.sidekicks` the probe can call, and a click on the one control that mounts
// it. A second copy of either would let the two disagree about what a press is.
//
// `window.sidekicks` AND NOT THE CONSOLE'S OWN BRIDGE, deliberately: the probe is a
// shipped Tier-1 component that reads the preload directly, which is the whole reason
// the console guards its mount on the bridge SOURCE rather than handing it one.

import { act } from "@testing-library/react";

import type { SidekicksBridge } from "@ai-sidekicks/contracts";

/** The session the daemon mints for these suites. */
export const CREATED_SESSION_ID = "7f3c1a2b-4d5e-4f60-8a71-9c2d3e4f5061";

/** Install a `daemon.call` for the probe to reach, answering as the case says. */
export function installProbeBridge(
  call: (method: string, params: unknown) => Promise<unknown>,
): void {
  (window as unknown as { sidekicks: SidekicksBridge }).sidekicks = {
    daemon: { call },
  } as unknown as SidekicksBridge;
}

/** Take the installed bridge away again, so no case inherits another's. */
export function uninstallProbeBridge(): void {
  delete (window as unknown as { sidekicks?: SidekicksBridge }).sidekicks;
}

/** Press Start, the way a person does. */
export function pressStart(container: HTMLElement): void {
  const start = container.querySelector<HTMLButtonElement>(".meridian-sessions__start");
  if (start === null) {
    throw new Error("the destination rendered no start control");
  }
  act(() => {
    start.click();
  });
}

/** Whether the start control is currently offered. What a released slot restores. */
export function startIsOffered(container: HTMLElement): boolean {
  const start = container.querySelector<HTMLButtonElement>(".meridian-sessions__start");
  return start !== null && !start.disabled;
}
