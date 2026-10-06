// The one gesture both import suites make: choosing a provider, the way a person does.

import { act } from "@testing-library/react";

/** Choose a provider in the panel's provider field. */
export function chooseProvider(container: HTMLElement, provider: string): void {
  const field = [...container.querySelectorAll("label")].find((label) =>
    label.textContent?.startsWith("Provider"),
  );
  const select = field?.querySelector("select");
  if (select === null || select === undefined) {
    throw new Error("the import panel rendered no provider field");
  }
  act(() => {
    select.value = provider;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
