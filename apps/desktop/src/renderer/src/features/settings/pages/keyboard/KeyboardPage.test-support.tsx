// The cast both keyboard-page suites drive the real registry with.
//
// The page reads the window's real command registry and the frame's real override seam, so
// what it prints is what the frame installs and what it records reaches that seam. Each suite
// contributes the rail's shipped chords itself, since this module may not import the layout.

import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";

import { afterEach, beforeEach } from "vitest";

import { commandRegistry } from "#renderer/registries/commands/registry.js";
import { keybindingOverrides } from "#renderer/registries/keybindings/overrides/store.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { KeyboardPage } from "./KeyboardPage.js";

/**
 * The commands the shipped frame bindings name, plus one that no chord reaches.
 *
 * Registered on the real registry, which the page reads by name.
 */
const TEST_COMMAND_IDS = [
  "frame.goToSessions",
  "frame.goToWorkflows",
  "bridge.checkForUpdates",
] as const;

/**
 * A chord no platform reads differently.
 *
 * `$mod` resolves against the host; `Alt` is the same key everywhere, and the seam is under
 * test, not the modifier.
 */
export const RECORDED_PRESS = { key: "j", code: "KeyJ", altKey: true } as const;

/** Render the keyboard page under the announcer it needs. */
export function renderKeyboardPage(): ReturnType<typeof render> {
  return render(
    <LiveAnnouncerProvider>
      <KeyboardPage />
    </LiveAnnouncerProvider>,
  );
}

/** One row, found by the command name it draws. */
export function rowOf(container: HTMLElement, title: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>(".meridian-keymap__row")].find(
    (candidate) => candidate.querySelector(".meridian-keymap__title")?.textContent === title,
  );
  if (row === undefined) {
    throw new Error(`no row for ${title}`);
  }
  return row;
}

/** The recorder button on one row, by the name it carries resting or armed. */
export function recorderOf(container: HTMLElement, title: string): HTMLElement {
  return within(rowOf(container, title)).getByRole("button", {
    name: (name) => name === `Rebind ${title}` || name === `Press a chord for ${title}`,
  });
}

/** Arm the recorder on a row and press one chord into it. */
export async function recordChordOnto(
  container: HTMLElement,
  title: string,
  press: Record<string, unknown>,
): Promise<void> {
  const recorder = recorderOf(container, title);
  fireEvent.click(recorder);
  await act(async () => {
    fireEvent.keyDown(recorder, press);
    await crossMacrotaskBoundary();
  });
}

beforeEach(() => {
  commandRegistry.registerAll([
    {
      id: "frame.goToSessions",
      title: "Sessions",
      group: "App",
      run: () => undefined,
    },
    {
      id: "frame.goToWorkflows",
      title: "Workflows",
      group: "App",
      run: () => undefined,
    },
    {
      id: "bridge.checkForUpdates",
      title: "Check for updates",
      group: "Help",
      run: () => undefined,
    },
  ]);
});

afterEach(async () => {
  cleanup();
  for (const commandId of TEST_COMMAND_IDS) {
    commandRegistry.unregister(commandId);
  }
  // The seam is this window's, so one case's rebinding would be the next case's keyboard.
  await keybindingOverrides.resetAll();
});
