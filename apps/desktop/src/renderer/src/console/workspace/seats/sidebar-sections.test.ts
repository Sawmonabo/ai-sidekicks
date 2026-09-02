// One sidebar, four owners, and the order a person reads it in.
//
// The sections are filled by the composer family (`runs`), the collaboration
// family (`channels`, `agents`, `members`), and the repos family (`repos`,
// `artifacts`). Three branches, one sidebar: the failure this file exists for is
// two of them claiming one section, and the second failure is the render order
// drifting to whichever module happened to evaluate first.

import { describe, expect, it } from "vitest";

import { DuplicateRegistrationError } from "../../core/index.js";
import {
  SIDEBAR_SECTION_IDS,
  SidebarSectionRegistry,
  registerSidebarSection,
  sidebarSectionRegistry,
  sidebarSectionRenderer,
  type SidebarSectionDescriptor,
} from "./sidebar-sections.js";

/** A descriptor whose render answers with its own owner, so lookups are checkable. */
function descriptor(id: SidebarSectionDescriptor["id"], owner: string): SidebarSectionDescriptor {
  return { id, owner, render: () => owner };
}

describe("sidebar sections — the closed set", () => {
  it("declares six sections, each exactly once", () => {
    // The count is pinned because the set is deliberately SMALLER than the
    // spec sentence's list of eight: `goal` and `approvals` have no Phase-1C
    // owner and are not minted as seats nobody can fill. A seventh appearing
    // here without that decision changing is what this case catches.
    expect(SIDEBAR_SECTION_IDS.length).toBe(6);
    expect(new Set(SIDEBAR_SECTION_IDS).size).toBe(SIDEBAR_SECTION_IDS.length);
  });

  it("keeps render order in the declaration", () => {
    expect([...SIDEBAR_SECTION_IDS]).toStrictEqual([
      "channels",
      "agents",
      "runs",
      "repos",
      "artifacts",
      "members",
    ]);
  });
});

describe("sidebar sections — one owner per section", () => {
  it("replaces when the same owner re-claims", () => {
    const registry = new SidebarSectionRegistry();
    registry.register(descriptor("repos", "repos-family"));
    registry.register(descriptor("repos", "repos-family"));
    expect(registry.registeredSectionIds()).toStrictEqual(["repos"]);
  });

  it("refuses a second owner rather than swapping", () => {
    const registry = new SidebarSectionRegistry();
    registry.register(descriptor("agents", "collaboration-family"));
    expect(() => {
      registry.register(descriptor("agents", "composer-family"));
    }).toThrow(DuplicateRegistrationError);
    expect(registry.descriptorFor("agents")?.owner).toBe("collaboration-family");
  });

  it("reports registered sections in declaration order", () => {
    const registry = new SidebarSectionRegistry();
    // Registered back to front, so an implementation reporting insertion order
    // would answer differently — and the sidebar would render differently.
    registry.register(descriptor("members", "collaboration-family"));
    registry.register(descriptor("runs", "composer-family"));
    registry.register(descriptor("channels", "collaboration-family"));
    expect(registry.registeredSectionIds()).toStrictEqual(["channels", "runs", "members"]);
  });

  it("negative control: a fresh registry claims nothing on its own", () => {
    expect(new SidebarSectionRegistry().registeredSectionIds()).toStrictEqual([]);
  });
});

describe("sidebar sections — the module-scope door", () => {
  it("hands back the registered body itself, not a wrapper", () => {
    // Identity rather than behaviour: the seat must hand the sidebar the exact
    // function the family registered. A wrapper would be a second place a section
    // could be given props, and the section contract would then have two authors.
    const artifacts = descriptor("artifacts", "sidebar-sections-test");
    try {
      registerSidebarSection(artifacts);
      expect(sidebarSectionRenderer("artifacts")).toBe(artifacts.render);
    } finally {
      sidebarSectionRegistry.unregister("artifacts");
    }
  });

  it("negative control: an unfilled section has no body", () => {
    // Without this the case above would pass over a `sidebarSectionRenderer` that
    // answered with some other section's body, or with a body left behind by an
    // earlier file.
    expect(sidebarSectionRenderer("artifacts")).toBeUndefined();
    expect(sidebarSectionRenderer("members")).toBeUndefined();
  });
});
