// Is text being typed? The keybinding table asks before a chord such as "delete the selected
// row" fires, so a native field answering "no" would hand a person's keystrokes to that chord.

import { afterEach, describe, expect, it } from "vitest";

import { isTextEntryTarget } from "./editable-target.js";

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  const first = host.firstElementChild;
  if (!(first instanceof HTMLElement)) {
    throw new Error("the fixture markup produced no element");
  }
  return first;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("isTextEntryTarget", () => {
  it("answers for the native fields text is typed into", () => {
    expect(isTextEntryTarget(mount("<textarea></textarea>"))).toBe(true);
    expect(isTextEntryTarget(mount('<input type="search" />'))).toBe(true);
    expect(isTextEntryTarget(mount("<input />"))).toBe(true);
    expect(isTextEntryTarget(mount("<select></select>"))).toBe(true);
  });
});
