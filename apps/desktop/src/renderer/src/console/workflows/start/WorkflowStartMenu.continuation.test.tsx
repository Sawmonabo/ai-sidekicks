// The picker's pages past the first, and what a refused one leaves offered.
//
// ITS OWN FILE BESIDE THE MENU'S, on `definition-directory.paging.test.tsx`' precedent:
// the suite next door is about what one page of the enumeration lists, names and starts,
// and this one is about the second page — a different wire, a different set of states,
// and the one seam where a refusal is about a PART of the answer rather than about the
// whole of it. What both need to mount a picker is one helper in
// `workflow-start.test-support.tsx` rather than a copy per file.
//
// THE DEFECT THESE CASES WERE WRITTEN AGAINST. The directory deliberately stays `served`
// when a continuation is refused and keeps the cursor it was asked with, because the
// refusal is about the page and never about the handle. The menu rendered a continuation
// only on the `available` arm and a refusal only when the WHOLE directory was
// unavailable — so a refused second page disappeared: the rows stayed, nothing said the
// rest had failed to arrive, and the definitions past the first page were unreachable
// again with no way to ask for them.

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { growthUnavailable, type GrowthPort } from "../../bridge/index.js";
import { pagedGrowthPort } from "../definitions/definition-directory.test-support.js";
import { SECOND_PAGE_CURSOR, settle } from "../workflows-probe.test-support.js";
import { START_DEFINITIONS, mountMenu } from "./workflow-start.test-support.js";

afterEach(cleanup);

/** The label the one continuation control wears, whichever arm it is rendered on. */
const MORE_CONTROL = "Show more definitions";

/**
 * A first page carrying a cursor and a second page the daemon refuses, with every
 * cursor the surface asked with.
 *
 * Through the family's own paged port so the answer is the registered one — a page this
 * fixture serves is a page the wire could send — and through the port's own refusal
 * builder rather than a literal, so the code rendered is the one the seam composes.
 */
function refusedSecondPage(): { readonly growth: GrowthPort; readonly cursors: unknown[] } {
  const cursors: unknown[] = [];
  const growth = pagedGrowthPort((cursor) => {
    cursors.push(cursor);
    return cursor === undefined
      ? {
          status: "served",
          value: { definitions: START_DEFINITIONS, nextCursor: SECOND_PAGE_CURSOR },
        }
      : growthUnavailable("workflowDefinitionList");
  });
  return { growth, cursors };
}

/**
 * A first page holding no definitions and carrying a cursor, and a second that ends the
 * enumeration holding none either.
 *
 * A cursor API may legitimately serve an empty intermediate page, so this is the shape
 * that separates "nothing was found" from "nothing has been read yet" — and both pages
 * come back served, so neither absence on screen can be a refusal in disguise.
 */
function emptyFirstPageWithMore(): { readonly growth: GrowthPort; readonly cursors: unknown[] } {
  const cursors: unknown[] = [];
  const growth = pagedGrowthPort((cursor) => {
    cursors.push(cursor);
    return cursor === undefined
      ? { status: "served", value: { definitions: [], nextCursor: SECOND_PAGE_CURSOR } }
      : { status: "served", value: { definitions: [] } };
  });
  return { growth, cursors };
}

describe("an empty page is not an empty enumeration until the cursor runs out", () => {
  it("withholds the definitive claim while the directory reports unread pages", async () => {
    // The negative control on the case below, and the defect these two were written
    // against: the menu said this session resolves no workflow definitions over a page
    // the daemon had explicitly told it was not the last, with the control that reaches
    // the rest rendered directly beneath the claim that there was nothing to reach.
    const container = await mountMenu(emptyFirstPageWithMore().growth);

    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: MORE_CONTROL }).disabled).toBe(
      false,
    );
  });

  it("makes the claim once the enumeration is exhausted and still holds none", async () => {
    const container = await mountMenu(emptyFirstPageWithMore().growth);

    fireEvent.click(screen.getByRole("button", { name: MORE_CONTROL }));

    // While the page it asked for is arriving, the absence is a wait rather than a
    // result: the enumeration is no longer merely unread, it is being read.
    expect(container.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
    expect(container.querySelector(".meridian-nothing--not-checked")).toBeNull();

    await settle();

    // Nothing left to ask for and nothing found: this is the one state in which the
    // console may say so, and the way on is absent rather than offered against nothing.
    expect(container.querySelector(".meridian-nothing--not-checked")).toBeNull();
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
    expect(screen.queryByRole("button", { name: MORE_CONTROL })).toBeNull();
  });
});

describe("a continuation the daemon refused stays askable", () => {
  it("renders the refusal and asks the same page again when the retry is pressed", async () => {
    const paged = refusedSecondPage();
    const container = await mountMenu(paged.growth);

    fireEvent.click(screen.getByRole("button", { name: MORE_CONTROL }));
    await settle();

    // The refused page is a fact about ONE page, so the rows already served stay and
    // the refusal sits beside the control rather than replacing the whole directory.
    expect(container.querySelector(".meridian-refusal")).not.toBeNull();
    expect(container.querySelectorAll(".meridian-workflow-start-menu__row")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: MORE_CONTROL }));
    await settle();

    // The retained cursor and not a fresh first page: the refusal was about the page,
    // never about the handle.
    expect(paged.cursors).toStrictEqual([undefined, SECOND_PAGE_CURSOR, SECOND_PAGE_CURSOR]);
  });

  it("closes the continuation control while the page it asked for is in flight", async () => {
    const paged = refusedSecondPage();
    await mountMenu(paged.growth);

    fireEvent.click(screen.getByRole("button", { name: MORE_CONTROL }));

    expect(screen.getByRole<HTMLButtonElement>("button", { name: MORE_CONTROL }).disabled).toBe(
      true,
    );
    await settle();
  });

  it("negative control: nothing is refused and the control is open before the page is asked for", async () => {
    // Without this the two cases above would be satisfied by a picker that rendered a
    // refusal and a closed control from the first frame, which offers no page at all.
    const paged = refusedSecondPage();
    const container = await mountMenu(paged.growth);

    expect(container.querySelector(".meridian-refusal")).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: MORE_CONTROL }).disabled).toBe(
      false,
    );
  });
});
