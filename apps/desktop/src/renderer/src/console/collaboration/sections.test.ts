// The two sections this family claims, and the holder both of them share.
//
// Registration is checked against a real `SidebarSectionRegistry` rather than a
// stand-in: the property that matters — two ids, one owner, replace rather than
// conflict on a second call — is the registry's behaviour, and a local double would
// prove nothing about it. It is a board this test OWNS rather than the process-wide
// singleton, so what a case asserts is what that case registered.

import { describe, expect, it } from "vitest";

import { registerCollaborationSections } from "./sections.js";
import { sectionsRegisteredForTest } from "./sections.test-support.js";
import { CollaborationSessionModelHolder } from "./session-models.js";

describe("collaboration sidebar sections", () => {
  it("fills exactly the channels and members sections", () => {
    expect(sectionsRegisteredForTest().registeredSectionIds()).toStrictEqual([
      "channels",
      "members",
    ]);
  });

  it("claims both under one owner, so both move together", () => {
    // Two owners on one family's sections would let a partial reload leave the
    // sidebar showing one section from before the change and one from after.
    const sections = sectionsRegisteredForTest();
    const owners = new Set(
      (["channels", "members"] as const).map((id) => sections.descriptorFor(id)?.owner ?? ""),
    );
    expect(owners.size).toBe(1);
    expect([...owners][0]).not.toBe("");
  });

  it("survives being registered twice, as a hot reload does it", () => {
    const sections = sectionsRegisteredForTest();
    const before = sections.registeredSectionIds();
    expect(() => {
      registerCollaborationSections(sections);
    }).not.toThrow();
    expect(sections.registeredSectionIds()).toStrictEqual(before);
  });

  it("negative control: a section this family does not fill has no body", () => {
    expect(sectionsRegisteredForTest().descriptorFor("runs")).toBeUndefined();
  });
});

describe("collaboration session models — the holder", () => {
  it("releases nothing it never built", () => {
    // `dispose` before any session is asked for is the teardown path a sidebar that
    // never rendered takes, and it must not throw on the way out.
    const holder = new CollaborationSessionModelHolder();
    expect(() => {
      holder.dispose();
    }).not.toThrow();
  });
});
