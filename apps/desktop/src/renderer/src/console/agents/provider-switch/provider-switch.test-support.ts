// The catalog reading, the two agents, and the DOM queries both switch suites use.
//
// The switch has two subjects — which controls exist and what a press submits, and
// what a move CLEARS or holds — and they are two suites. These are what they share:
// a loaded catalog, an agent on each pinned driver, and the queries that read a field
// or an action out of the rendered form.
//
// THE QUERIES ARE FUNCTIONS AND NOT HELD ELEMENTS. Every one of them re-queries the
// container it is handed, because the form re-renders on every edit and an element
// captured before a change is a node React has already replaced — a suite asserting
// on one would be reading a form that is no longer on screen.

import { fireEvent } from "@testing-library/react";
import { expect } from "vitest";

import type { AgentRosterEntry } from "../../bridge/index.js";
import type { PushDrivenReadState } from "../../seats/index.js";
import { DRIVER_CATALOG_FIXTURE } from "../driver-catalog.test-support.js";
import type { DriverCatalogReading } from "../driver-catalog.js";

export const LOADED: PushDrivenReadState<DriverCatalogReading> = {
  kind: "loaded",
  value: DRIVER_CATALOG_FIXTURE,
};

export const ON_CLAUDE: AgentRosterEntry = {
  agentId: "agent-scout",
  name: "Scout",
  state: "ready",
  driverName: "claude",
  modelId: "claude-sonnet",
};

export const ON_CODEX: AgentRosterEntry = { ...ON_CLAUDE, driverName: "codex", modelId: "gpt-5.6" };

export function fieldLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".meridian-axis-field__label")].map(
    (element) => element.textContent ?? "",
  );
}

/** What the account field currently shows, which is the draft's answer for that axis. */
export function providerAccountValue(container: HTMLElement): string {
  const input = container.querySelector(".meridian-axis-field__text") as HTMLInputElement | null;
  return input?.value ?? "";
}

/** Edits one axis through the plain text input, which needs no popup to open. */
export function editProviderAccount(container: HTMLElement, value: string): void {
  const input = container.querySelector(".meridian-axis-field__text");
  fireEvent.change(input as HTMLInputElement, { target: { value } });
}

/** The combobox field carrying one label, found by the label a person reads. */
export function axisField(container: HTMLElement, label: string): HTMLElement | undefined {
  return [...container.querySelectorAll(".meridian-axis-field")].find(
    (field) => field.querySelector(".meridian-axis-field__label")?.textContent === label,
  ) as HTMLElement | undefined;
}

/** Opens one axis's popup and chooses a published option, the way a person does. */
export function chooseAxisValue(container: HTMLElement, label: string, value: string): void {
  const field = axisField(container, label);
  expect(field).not.toBeUndefined();
  fireEvent.click(field?.querySelector(".meridian-axis-field__trigger") as HTMLElement);
  const option = [...document.querySelectorAll(".meridian-axis-field__option")].find(
    (candidate) => candidate.textContent === value,
  );
  expect(option).not.toBeUndefined();
  fireEvent.click(option as HTMLElement);
}

/** What one combobox currently shows, which is the draft's own answer for that axis. */
export function axisValueOf(container: HTMLElement, label: string): string {
  return (
    axisField(container, label)?.querySelector(".meridian-axis-field__trigger")?.textContent ?? ""
  );
}

export function applyActions(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll(".meridian-switch__apply")] as HTMLButtonElement[];
}
