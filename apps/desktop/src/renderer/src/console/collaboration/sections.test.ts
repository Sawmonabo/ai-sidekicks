// The two sections this family claims, and the holder both of them share.
//
// Registration is checked against the real seat registry rather than a stand-in:
// the property that matters — two ids, one owner, replace rather than conflict on a
// second call — is the registry's behaviour, and a local double would prove nothing
// about it.

import { describe, expect, it } from "vitest";

import { sidebarSectionRegistry } from "../seats/index.js";
import { registerCollaborationSections } from "./sections.js";
import { CollaborationSessionModelHolder } from "./session-models.js";

describe("collaboration sidebar sections", () => {
  it("fills exactly the channels and members sections", () => {
    registerCollaborationSections();
    expect(sidebarSectionRegistry.registeredSectionIds()).toStrictEqual(["channels", "members"]);
  });

  it("claims both under one owner, so both move together", () => {
    // Two owners on one family's sections would let a partial reload leave the
    // sidebar showing one section from before the change and one from after.
    registerCollaborationSections();
    const owners = new Set(
      (["channels", "members"] as const).map(
        (id) => sidebarSectionRegistry.descriptorFor(id)?.owner ?? "",
      ),
    );
    expect(owners.size).toBe(1);
    expect([...owners][0]).not.toBe("");
  });

  it("survives being registered twice, as a hot reload does it", () => {
    registerCollaborationSections();
    const before = sidebarSectionRegistry.registeredSectionIds();
    expect(() => {
      registerCollaborationSections();
    }).not.toThrow();
    expect(sidebarSectionRegistry.registeredSectionIds()).toStrictEqual(before);
  });

  it("negative control: a section this family does not fill has no body", () => {
    registerCollaborationSections();
    expect(sidebarSectionRegistry.descriptorFor("runs")).toBeUndefined();
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
