// Reaching the acts bar's secondary act, and the switch binding it needs to render at
// all.
//
// Hoisted on second use, per `apps/desktop/AGENTS.md`. Two suites mount `SessionActs`
// to get at the import — one asking what the import DOES and one asking how long it
// lives — and both have to press the same two controls to reach it and hand the bar
// the same durable switch. A second copy of either would let them disagree about what
// "the import is open" means.
//
// AND THE WAIT FOR THE PANEL'S CHUNK LIVES HERE TOO, for that same reason and one more.
// The panel is a loader-backed body — `provider-import-panel-body.ts` states why — so
// the press that discloses it draws the reserved region until its module lands. Resolved
// through the MOUNT the bar itself renders, in the one function both suites press
// through: a per-spec poll would be the wait written twice, and the version that raced
// would look identical to the one that did not.

import { act } from "@testing-library/react";

import { providerImportPanelMount } from "./act-body-mounts.js";
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
export async function openImportDisclosure(container: HTMLElement): Promise<void> {
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
  // BEFORE the press rather than after it: `LoadedLazyBody.render` reads the settled
  // body at render time, so a mount that begins after the load never suspends and the
  // press below commits the panel itself. Waiting afterwards would assert against a
  // frame the reserved region is still on.
  await providerImportPanelMount.load();
  act(() => {
    item.click();
  });
}

/**
 * The create menu's import item, opened and read, or a throw.
 *
 * A throw rather than a nullable: a suite that read `undefined` here and asserted on
 * `?.ariaDisabled` would pass for a bar that rendered no import act at all. The popup
 * is PORTALLED, so the item is found in the document rather than under the bar the
 * caller holds.
 */
export function requireImportDisclosure(container: HTMLElement): HTMLElement {
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
  return item;
}
