// Reaching the acts bar's third act, and the switch binding it needs to render at all.
//
// Hoisted on second use, per `apps/desktop/AGENTS.md`. Two suites mount `SessionActs`
// to get at the import — one asking what the import DOES and one asking how long it
// lives — and both have to press the same two controls to reach it and hand the bar
// the same durable switch. A second copy of either would let them disagree about what
// "the import is open" means.

import { act } from "@testing-library/react";

import type { SessionPreferenceBinding } from "../rows/session-preferences.js";

/**
 * A switch that is on, persists nothing, and refuses nothing.
 *
 * The acts bar always draws `AutoPinSetting`, so every case that is about the import
 * still has to supply one. Frozen at module level rather than rebuilt per case,
 * because no case here moves it — a suite that did would be a suite about the switch.
 */
export const QUIET_PREFERENCES: SessionPreferenceBinding = {
  isAutoPinOnFirstSendEnabled: true,
  lastRefusal: undefined,
  setAutoPinOnFirstSend: () => undefined,
};

/**
 * Open the import panel from the create menu, the way somebody reaches it.
 *
 * The popup is PORTALLED, so its items are in the document rather than under the bar
 * the caller holds — which is also why the item is found by its own text: two menus
 * open at once would otherwise be read as one.
 */
export function openImportDisclosure(container: HTMLElement): void {
  const trigger = container.querySelector<HTMLButtonElement>(
    "button.meridian-session-acts__menu-trigger",
  );
  if (trigger === null) {
    throw new Error("the acts bar rendered no create menu");
  }
  act(() => {
    trigger.click();
  });
  const item = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find(
    (candidate) => candidate.textContent === "Import a provider session",
  );
  if (item === undefined) {
    throw new Error("the create menu offered no provider import");
  }
  act(() => {
    item.click();
  });
}
