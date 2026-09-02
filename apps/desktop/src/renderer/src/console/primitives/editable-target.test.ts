// The two questions, and the gap between them that the deck's defect lived in.
//
// The negative control this file exists for is the ANCESTOR arm: before it, a key
// event fired from inside a `role="textbox"` composed of ordinary elements answered
// "not editable", which is how a chord reached the deck while a person was typing.

import { afterEach, describe, expect, it } from "vitest";

import { isEditableTarget, isTextEntryTarget } from "./editable-target.js";

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

  it("leaves a control that is not text entry open to a chord", () => {
    expect(isTextEntryTarget(mount('<input type="checkbox" />'))).toBe(false);
    expect(isTextEntryTarget(mount('<input type="radio" />'))).toBe(false);
    expect(isTextEntryTarget(mount("<button></button>"))).toBe(false);
  });

  it("answers false for a non-element target and for nothing at all", () => {
    expect(isTextEntryTarget(null)).toBe(false);
    expect(isTextEntryTarget(new EventTarget())).toBe(false);
  });

  it("does NOT walk to an editable ancestor — that is the wide question", () => {
    const widget = mount('<div role="textbox"><span>caret here</span></div>');
    const inner = widget.querySelector("span");
    expect(inner).not.toBeNull();
    expect(isTextEntryTarget(inner)).toBe(false);
  });
});

describe("isEditableTarget", () => {
  it("answers true for everything the narrow question answers true for", () => {
    expect(isEditableTarget(mount("<textarea></textarea>"))).toBe(true);
    expect(isEditableTarget(mount('<input type="search" />'))).toBe(true);
  });

  it("walks to a role-declared widget the event fired inside", () => {
    for (const role of ["textbox", "searchbox", "combobox", "listbox"]) {
      const widget = mount(`<div role="${role}"><span>inside</span></div>`);
      const inner = widget.querySelector("span");
      expect(inner).not.toBeNull();
      expect(isEditableTarget(inner)).toBe(true);
    }
  });

  // The negative control: an ordinary subtree with no editable ancestor answers
  // false, so the ancestor walk is discriminating rather than always-true.
  it("answers false inside a widget that owns none of the keys", () => {
    const chrome = mount('<div role="group"><button>close</button></div>');
    const inner = chrome.querySelector("button");
    expect(inner).not.toBeNull();
    expect(isEditableTarget(inner)).toBe(false);
  });

  it("answers false for a non-element target and for nothing at all", () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(new EventTarget())).toBe(false);
  });
});
