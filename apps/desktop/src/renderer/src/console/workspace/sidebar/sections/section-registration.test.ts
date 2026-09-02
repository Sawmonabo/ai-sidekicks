// Which of the eight sidebar seats this family actually fills.
//
// The module's header says three of the eight are this family's and one of them has
// a body here. Both halves are prose, and the second half is the one that goes
// stale first — a section gains a body and the sentence beside it does not move. So
// it is asserted against the seat's own registry rather than against a second list,
// and against `SIDEBAR_SECTION_IDS` rather than a transcription of it: a section
// added to the seat and left unclaimed shows up here as an unfilled id rather than
// as nothing at all.
//
// The registrations write into the PROCESS-WIDE registry, which is what the
// composition root calls, so the real call is what is driven here — and every id is
// released afterwards, because a seat left claimed by a test is a duplicate-claim
// refusal in whichever file runs next.

import { afterEach, describe, expect, it } from "vitest";

import {
  SIDEBAR_SECTION_IDS,
  sidebarSectionRegistry,
  type SidebarSectionId,
} from "../../../seats/index.js";
import { registerComposerSidebarSections } from "./section-registration.js";

/** The sections this family fills today. The header's second half, as data. */
const SEATED_BY_THIS_FAMILY: readonly SidebarSectionId[] = ["runs"];

afterEach(() => {
  for (const id of SIDEBAR_SECTION_IDS) {
    sidebarSectionRegistry.unregister(id);
  }
});

describe("the composer family's sidebar sections", () => {
  it("fills exactly the seats its header claims, and leaves the rest reserved", () => {
    expect(sidebarSectionRegistry.registeredSectionIds()).toStrictEqual([]);

    registerComposerSidebarSections();

    expect(sidebarSectionRegistry.registeredSectionIds()).toStrictEqual(SEATED_BY_THIS_FAMILY);

    // The negative control, and the reason the seat exists: every other section is
    // unfilled rather than stubbed here, so a body arriving from another family is
    // a registration and not an edit to this file.
    const unfilled = SIDEBAR_SECTION_IDS.filter((id) => !SEATED_BY_THIS_FAMILY.includes(id));
    expect(unfilled).toHaveLength(SIDEBAR_SECTION_IDS.length - SEATED_BY_THIS_FAMILY.length);
    for (const id of unfilled) {
      expect(sidebarSectionRegistry.descriptorFor(id)).toBeUndefined();
    }
  });

  it("names this family as the owner, so a duplicate claim says who holds the seat", () => {
    registerComposerSidebarSections();
    for (const id of SEATED_BY_THIS_FAMILY) {
      expect(sidebarSectionRegistry.descriptorFor(id)?.owner).toBe("composer-family");
    }
  });

  it("is idempotent, because the composition root may run twice under a hot reload", () => {
    registerComposerSidebarSections();
    registerComposerSidebarSections();
    expect(sidebarSectionRegistry.registeredSectionIds()).toStrictEqual(SEATED_BY_THIS_FAMILY);
  });
});
