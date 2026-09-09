// Reaching the acts bar's third act, and the switch binding it needs to render at all.
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
// through: a per-spec poll would be the wait written three times, and the version that
// raced would look identical to the two that did not.
//
// THE JOIN DISCLOSURE IS HERE FOR THE SAME REASON, and it arrived the other way round:
// its wait was written INSIDE a spec, under a comment saying "one home for the wait
// rather than a per-spec race", which is the sentence a hoist makes true and a
// per-spec copy makes false. Its switch is read by a second suite too, which had its
// own copy of the selector — so the accessor is here and the two readings cannot
// disagree about which control the bar's join act is.

import { act } from "@testing-library/react";

import { joinSessionFormMount, providerImportPanelMount } from "./act-body-mounts.js";
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
 * The acts bar's join switch, or a throw.
 *
 * A throw rather than a nullable: a suite that read `undefined` here and asserted on
 * `?.disabled` would pass for a bar that rendered no join act at all.
 */
export function requireJoinDisclosure(container: HTMLElement): HTMLButtonElement {
  const control = container.querySelector<HTMLButtonElement>(".meridian-session-acts__secondary");
  if (control === null) {
    throw new Error("the acts bar rendered no join disclosure");
  }
  return control;
}

/**
 * Open the join form from that switch, the way somebody reaches it.
 *
 * The load runs BEFORE the press for `openImportDisclosure`'s reason, which is the
 * board's and not this act's: `LoadedLazyBody.render` reads the settled body at render
 * time, so a mount that begins after the load never suspends and the press commits the
 * form itself. Waiting afterwards would assert against a frame the reserved region is
 * still on.
 */
export async function openJoinDisclosure(container: HTMLElement): Promise<void> {
  const control = requireJoinDisclosure(container);
  await joinSessionFormMount.load();
  act(() => {
    control.click();
  });
}
