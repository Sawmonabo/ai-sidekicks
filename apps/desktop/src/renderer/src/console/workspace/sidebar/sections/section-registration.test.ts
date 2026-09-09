// Which of the eight sidebar seats this family actually fills.
//
// The module's header says three of the eight are this family's and which of them
// have bodies here. Both halves are prose, and the second half is the one that goes
// stale first — a section gains a body and the sentence beside it does not move. So
// it is asserted against the seat's own registry rather than against a second list,
// and against `SIDEBAR_SECTION_IDS` rather than a transcription of it: a section
// added to the seat and left unclaimed shows up here as an unfilled id rather than
// as nothing at all.
//
// EACH CASE COMPOSES ITS OWN BOARD, which is the same thing the composition root
// does with the board it was handed — `registerConsoleFamilies` passes one in rather
// than letting a family reach for the module-scope registry. So the real call is what
// is driven here, and nothing has to be released afterwards, because a test that
// claimed a seat on the shared registry is a duplicate-claim refusal in whichever
// file runs next.

import { describe, expect, it } from "vitest";

import {
  SIDEBAR_SECTION_IDS,
  SidebarSectionRegistry,
  type SidebarSectionId,
} from "../../../seats/index.js";
import { registerComposerSidebarSections } from "./section-registration.js";

/**
 * The sections this family fills today. The header's second half, as data.
 *
 * In the seat's own canonical order rather than in registration order, because that
 * is what `registeredSectionIds()` answers with — the registry orders its answer by
 * `SIDEBAR_SECTION_IDS` so a sidebar's sections read the same however the families
 * that own them happened to register.
 */
const SEATED_BY_THIS_FAMILY: readonly SidebarSectionId[] = ["goal", "runs", "approvals"];

/**
 * Which of those carry a rollup, as data beside the set rather than folded into it.
 *
 * The third seat is the reason this is a second list rather than a quantifier over the
 * first: `goal` is one line, so it has nothing to fold and reports no urgency of its
 * own, and asserting a rollup over every seated section would have made the case below
 * fail on a section that is correct. Naming the two that do carry one keeps the claim
 * exact in both directions — the two have a fold, and the third deliberately does not.
 */
const ROLLUP_BEARING: readonly SidebarSectionId[] = ["runs", "approvals"];

describe("the composer family's sidebar sections", () => {
  it("fills exactly the seats its header claims, and leaves the rest reserved", () => {
    const board = new SidebarSectionRegistry();
    expect(board.registeredSectionIds()).toStrictEqual([]);

    registerComposerSidebarSections(board);

    expect(board.registeredSectionIds()).toStrictEqual(SEATED_BY_THIS_FAMILY);

    // The negative control, and the reason the seat exists: every other section is
    // unfilled rather than stubbed here, so a body arriving from another family is
    // a registration and not an edit to this file.
    const unfilled = SIDEBAR_SECTION_IDS.filter((id) => !SEATED_BY_THIS_FAMILY.includes(id));
    expect(unfilled).toHaveLength(SIDEBAR_SECTION_IDS.length - SEATED_BY_THIS_FAMILY.length);
    for (const id of unfilled) {
      expect(board.descriptorFor(id)).toBeUndefined();
    }
  });

  it("names this family as the owner, so a duplicate claim says who holds the seat", () => {
    const board = new SidebarSectionRegistry();

    registerComposerSidebarSections(board);

    for (const id of SEATED_BY_THIS_FAMILY) {
      expect(board.descriptorFor(id)?.owner).toBe("composer-family");
    }
  });

  it("seats each section's rollup, and never a second answer beside it", () => {
    // The seat takes an explicit `attention` as the section's own claim and the fold
    // over its `rollup` as the fallback, so a descriptor carrying both is answering one
    // question twice — and the two go out of step the first time either is edited
    // alone. The never-both half is asserted over the WHOLE set, so a section seated
    // later by this family cannot quietly ship the pair; the rollup half is asserted
    // against the two that declare one, with the third's absence its own claim rather
    // than an unchecked gap.
    const board = new SidebarSectionRegistry();

    registerComposerSidebarSections(board);

    for (const id of SEATED_BY_THIS_FAMILY) {
      const descriptor = board.descriptorFor(id);
      expect(descriptor?.attention).toBeUndefined();
      if (ROLLUP_BEARING.includes(id)) {
        expect(descriptor?.rollup).toBeTypeOf("function");
      } else {
        expect(descriptor?.rollup).toBeUndefined();
      }
    }
  });

  it("is idempotent, because the composition root may run twice under a hot reload", () => {
    const board = new SidebarSectionRegistry();

    registerComposerSidebarSections(board);
    registerComposerSidebarSections(board);

    expect(board.registeredSectionIds()).toStrictEqual(SEATED_BY_THIS_FAMILY);
  });
});
