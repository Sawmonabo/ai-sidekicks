// One sidebar, three owners, and the order a person reads it in.
//
// The sections are filled by the composer family (`goal`, `runs`, `approvals`),
// the collaboration family (`channels`, `agents`, `members`), and the repos family
// (`repos`, `artifacts`). Three branches, one sidebar: the failure this file exists
// for is two of them claiming one section, and the second failure is the render
// order drifting to whichever module happened to evaluate first.
//
// The third failure is the set itself being short. `SidebarSectionId`,
// registration, and render order all derive from the tuple, so a section the tuple
// omits cannot be registered by anyone — which is why the first case below compares
// the whole tuple to the spec's own enumeration rather than counting it.

import { describe, expect, it } from "vitest";

import { DuplicateRegistrationError } from "../core/index.js";
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

/**
 * The sections `Spec-023 §Console Design (Meridian)` §The surface set enumerates,
 * in its own order. The sentence, verbatim:
 *
 *   "The session sidebar shows the session's other work as independently loaded
 *   sections — goal, channels, runs, agents, repos and worktrees, approvals,
 *   artifacts, members — each a composition of its own read, opening panes …"
 *
 * `repos` is that sentence's "repos and worktrees" — one section, named for the
 * entity kind its cards open panes for. Transcribed rather than read from the spec
 * file for `pane-kinds.test.ts`'s reason: `node:fs` is banned in renderer programs
 * and the corpus sits outside this package's Vite root, so the honest arrangement
 * is a transcription a reviewer can diff against the quote above.
 */
const SPEC_SIDEBAR_SECTION_IDS: readonly string[] = [
  "goal",
  "channels",
  "runs",
  "agents",
  "repos",
  "approvals",
  "artifacts",
  "members",
];

describe("sidebar sections — the closed set Spec-023 §The surface set enumerates", () => {
  it("carries the spec's sections in the spec's order, which is render order", () => {
    // `toStrictEqual` is ORDERED, and the order is not cosmetic: it is what a
    // person reads down the sidebar. A section the tuple omits is one no family
    // can register, so this single comparison is both the membership check and
    // the order check.
    expect([...SIDEBAR_SECTION_IDS]).toStrictEqual([...SPEC_SIDEBAR_SECTION_IDS]);
  });

  it("declares each section exactly once", () => {
    // `toStrictEqual` above would pass over a set that repeated a member if the
    // transcription repeated it too, and a repeat is what a merge of two
    // concurrent additions produces.
    expect(new Set(SIDEBAR_SECTION_IDS).size).toBe(SIDEBAR_SECTION_IDS.length);
  });

  it("negative control: the two sections a shorter substrate had no seat for", () => {
    // Without this the comparison above would pass over a transcription edited to
    // match a tuple that had dropped them — which is exactly how the substrate
    // came to omit both while claiming to be closed over the spec's list. Named
    // one by one, so removing either fails here rather than in a diff nobody reads.
    expect(SIDEBAR_SECTION_IDS).toContain("goal");
    expect(SIDEBAR_SECTION_IDS).toContain("approvals");
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
    registry.register(descriptor("approvals", "composer-family"));
    registry.register(descriptor("runs", "composer-family"));
    registry.register(descriptor("goal", "composer-family"));
    expect(registry.registeredSectionIds()).toStrictEqual(["goal", "runs", "approvals", "members"]);
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
