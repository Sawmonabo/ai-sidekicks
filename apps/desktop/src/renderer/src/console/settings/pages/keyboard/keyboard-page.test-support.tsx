// The cast both keyboard-page suites drive the real registry with.
//
// The page reads the window's real command registry and the frame's real override
// seam: what it prints is what the frame installs, and what it records reaches that
// seam rather than a table of its own. Both halves — what it reads, and what it
// changes — need that same wiring, so it is built once here.

import { act, cleanup, fireEvent, render } from "@testing-library/react";

import { afterEach, beforeEach } from "vitest";

import { consoleCommands, consoleKeybindingOverrides } from "../../../palette/index.js";
import { LiveAnnouncerProvider } from "../../../primitives/index.js";
import { KeyboardPage } from "./KeyboardPage.js";

/**
 * The commands the shipped frame bindings name, plus one that no chord reaches.
 *
 * Registered on the REAL registry rather than a stand-in: the page reads that
 * registry by name, and a test that handed it a private one would prove the join
 * works on an object nothing in the console uses.
 */
export const TEST_COMMAND_IDS = [
  "frame.goToSessions",
  "frame.goToWorkflows",
  "app.checkForUpdates",
] as const;

/**
 * A chord no platform reads differently.
 *
 * `$mod` resolves against the host, so a synthesised press naming it would be a
 * second platform reading in a test file. `Alt` is the same key everywhere, which is
 * all these cases need — what is under test is the seam, not the modifier.
 */
export const RECORDED_PRESS = { key: "j", code: "KeyJ", altKey: true } as const;

export function renderPage(): ReturnType<typeof render> {
  return render(
    <LiveAnnouncerProvider>
      <KeyboardPage />
    </LiveAnnouncerProvider>,
  );
}

export function politeAnnouncement(container: HTMLElement): string {
  return container.querySelector('[data-live-region="polite"]')?.textContent ?? "";
}

/** The recorder on one row, found by the command id printed beside it. */
export function rowOf(container: HTMLElement, commandId: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>(".meridian-keymap__row")].find(
    (candidate) => (candidate.textContent ?? "").includes(commandId),
  );
  if (row === undefined) {
    throw new Error(`no row for ${commandId}`);
  }
  return row;
}

export function recorderOf(container: HTMLElement, commandId: string): HTMLElement {
  const button = rowOf(container, commandId).querySelector<HTMLElement>(".meridian-keymap__record");
  if (button === null) {
    throw new Error(`no recorder for ${commandId}`);
  }
  return button;
}

/** Arm the recorder on a row and press one chord into it. */
export async function recordOnto(
  container: HTMLElement,
  commandId: string,
  press: Record<string, unknown>,
): Promise<void> {
  const recorder = recorderOf(container, commandId);
  fireEvent.click(recorder);
  await act(async () => {
    fireEvent.keyDown(recorder, press);
    await Promise.resolve();
  });
}

beforeEach(() => {
  consoleCommands.registerAll([
    {
      id: "frame.goToSessions",
      title: "Go to sessions",
      group: "Navigation",
      run: () => undefined,
    },
    {
      id: "frame.goToWorkflows",
      title: "Go to workflows",
      group: "Navigation",
      run: () => undefined,
    },
    {
      id: "app.checkForUpdates",
      title: "Check for updates",
      group: "Application",
      run: () => undefined,
    },
  ]);
});

afterEach(async () => {
  cleanup();
  for (const commandId of TEST_COMMAND_IDS) {
    consoleCommands.unregister(commandId);
  }
  // The seam is this window's, so one case's rebinding would otherwise be the next
  // case's starting keyboard.
  await consoleKeybindingOverrides.resetAll();
});
