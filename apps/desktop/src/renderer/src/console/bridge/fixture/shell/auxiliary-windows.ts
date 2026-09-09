// The auxiliary-window plane a FIXTURE bridge answers with, and which of its two arms
// a build takes.
//
// TWO ARMS, DECIDED BY WHETHER A SHELL IS INSTALLED — never by the `define` gate.
// `__SIDEKICKS_CONSOLE_FIXTURES__` says a build was compiled with the fixture bridge
// in it; it says nothing about whether an Electron main process is underneath, and
// the same fixture bundle is loaded in both places:
//
//   • **A shell is installed** — the Electron-hosted fixture build, which is what the
//     screenshot and endurance launchers run and what a developer opens locally. The
//     preload has run, so `window.sidekicks.window` is the real IPC namespace, and
//     this port DELEGATES to it: a detach here opens an actual `BrowserWindow`
//     through `src/main/auxiliary-window-ipc.ts`, exactly as the live bridge's does.
//     One code path, one main handler, and the deck's placeholder, focus control,
//     return control and crash note are reachable against a real window rather than
//     against a model of one.
//   • **No shell is installed** — browser-mode vitest and any renderer loaded without
//     a preload. There is no process here that can open a window, so every operation
//     answers the typed `shell-absent` refusal and the deck renders it. The pane is
//     never suppressed and is never lost.
//
// WHY THERE IS NO LONGER A MODELLED WINDOW. This module used to mint a synthetic
// handle and record two map entries, and answer `served` — which made a detach in a
// fixture build a success that opened nothing: the deck suppressed the pane's body,
// drew a placeholder for a window that did not exist, and the person lost the pane
// until they pressed return. A model is the right fixture answer for a DAEMON read,
// because a scenario states what the daemon would have said. It is the wrong answer
// for the shell, because the shell is right here — so the honest fixture is the one
// that uses it where it exists and refuses where it does not.

import type { SidekicksBridge } from "@ai-sidekicks/contracts";

import {
  createShellAuxiliaryWindowPort,
  refuseWithoutShell,
  type AuxiliaryWindowPort,
} from "../../auxiliary-window-port.js";
import { readInstalledBridge } from "../../live-bridge.js";

/**
 * The auxiliary-window plane for one fixture bridge.
 *
 * Takes the installed shell as an argument rather than reading it, so the arm a
 * bridge is on is decided once by its caller and a test can drive either — the
 * `implementedRoutes` seam on the hand-off is the same shape for the same reason.
 * {@link readFixtureShell} is the production reading.
 */
export function createFixtureAuxiliaryWindowPort(
  shell: SidekicksBridge | undefined,
): AuxiliaryWindowPort {
  return shell === undefined ? SHELL_ABSENT_PORT : createShellAuxiliaryWindowPort(shell);
}

/**
 * The shell this fixture build is running inside, or `undefined` where there is none.
 *
 * `readInstalledBridge` rather than a `window.sidekicks` read of its own: that module
 * is the console's single reader of the installed bridge, and its probe is what tells
 * a preload that ran from one that did not. A second reading here would be a second
 * answer to the same question, and the one that went stale would be this one.
 */
export function readFixtureShell(): SidekicksBridge | undefined {
  return readInstalledBridge();
}

/**
 * Every operation, refused because this build has no shell.
 *
 * One frozen port rather than a fresh object per bridge, and it is allowed to be one:
 * it holds no state at all — every method ignores its argument and answers the same
 * constant refusal — so two bridges sharing it can no more interfere than two callers
 * of the same pure function can. The rule against module-level singletons is about
 * shared STATE, and there is none here to share.
 */
const SHELL_ABSENT_PORT: AuxiliaryWindowPort = {
  detachPane: async () => refuseWithoutShell(),
  focusAuxiliary: async () => refuseWithoutShell(),
  closeAuxiliary: async () => refuseWithoutShell(),
  subscribePaneErrors: async () => refuseWithoutShell(),
  subscribePaneReturns: async () => refuseWithoutShell(),
};
