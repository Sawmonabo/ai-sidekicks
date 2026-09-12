// The section this family claims, and the holder it reads through.
//
// Registration is checked against a real `SidebarSectionRegistry` rather than a
// stand-in: the property that matters — the id, its owner, replace rather than
// conflict on a second call — is the registry's behaviour, and a local double would
// prove nothing about it. It is a board this test OWNS rather than the process-wide
// singleton, so what a case asserts is what that case registered.

import { describe, expect, it } from "vitest";

import { registerChannelsSections } from "./sections.js";
import { sectionsRegisteredForTest } from "./sections.test-support.js";
import { ChannelSessionModelHolder } from "./session-models.js";

describe("channels sidebar sections", () => {
  it("fills exactly the channels section", () => {
    expect(sectionsRegisteredForTest().registeredSectionIds()).toStrictEqual(["channels"]);
  });

  it("claims it under an owner of this family's own", () => {
    // The owner string is what makes a second registration a replacement rather than
    // a conflict, so a section registered under an empty owner would swap with
    // whatever else reached the board without one.
    const sections = sectionsRegisteredForTest();
    expect(sections.descriptorFor("channels")?.owner).not.toBe("");
    expect(sections.descriptorFor("channels")?.owner).toBeDefined();
  });

  it("survives being registered twice, as a hot reload does it", () => {
    const sections = sectionsRegisteredForTest();
    const before = sections.registeredSectionIds();
    expect(() => {
      registerChannelsSections(sections);
    }).not.toThrow();
    expect(sections.registeredSectionIds()).toStrictEqual(before);
  });

  it("negative control: a section this family does not fill has no body", () => {
    expect(sectionsRegisteredForTest().descriptorFor("runs")).toBeUndefined();
  });
});

describe("channels session models — the holder", () => {
  it("releases nothing it never built", () => {
    // `dispose` before any session is asked for is the teardown path a sidebar that
    // never rendered takes, and it must not throw on the way out.
    const holder = new ChannelSessionModelHolder();
    expect(() => {
      holder.dispose();
    }).not.toThrow();
  });
});
