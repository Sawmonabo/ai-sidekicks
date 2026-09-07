// That the enumeration is read WHOLE, and that a walk nobody is waiting for stops.
//
// The defect these cases were written against is silent by construction: a resolution
// that matched only the first page answered "no workflow this session can start is
// named X" for every definition past it — a refusal about a name the daemon does
// carry, and one a person can only disprove by opening another surface. So the
// negative control is not "an assertion failed" but "the fixture's second page went
// unread", which is why the fixture pages by CURSOR rather than by call count.

import { describe, expect, it } from "vitest";

import { COMPOSER_WORKFLOW_DEFINITION_PAGE_CAP } from "../../composer-bounds.js";
import { readWorkflowDefinitions } from "./definition-enumeration.js";
import {
  fixtureGrowthPort,
  recordedWorkflowCalls,
  WORKFLOW_TEST_SESSION_ID,
} from "./workflow-start.test-support.js";

/** The names one walk carried back, in the order the pages served them. */
function namesOf(enumeration: Awaited<ReturnType<typeof readWorkflowDefinitions>>): string[] {
  return enumeration.status === "served"
    ? enumeration.definitions.map((definition) => definition.name)
    : [];
}

describe("readWorkflowDefinitions", () => {
  it("follows the wire's own cursor to exhaustion", async () => {
    const calls = recordedWorkflowCalls();
    const growth = fixtureGrowthPort({
      pages: [
        { definitions: [{ name: "nightly" }] },
        { definitions: [{ name: "release" }] },
        { definitions: [{ name: "deploy" }] },
      ],
      calls,
    });

    const enumeration = await readWorkflowDefinitions(growth, WORKFLOW_TEST_SESSION_ID);

    expect(namesOf(enumeration)).toStrictEqual(["nightly", "release", "deploy"]);
    expect(enumeration.status === "served" && enumeration.complete).toBe(true);
    // The cursors were the daemon's, carried back untouched: a walk that minted its
    // own would page through something the wire never offered.
    expect(calls.listed.map((request) => request.cursor)).toStrictEqual([
      undefined,
      "page-1",
      "page-2",
    ]);
  });

  it("negative control: a first-page-only read misses the later definition", async () => {
    // The shape the defect had. Reading one page and stopping leaves `release`
    // unfound, and the accelerator then refuses a name the session can start.
    const growth = fixtureGrowthPort({
      pages: [{ definitions: [{ name: "nightly" }] }, { definitions: [{ name: "release" }] }],
    });

    const firstPageOnly = await growth.workflowDefinitionList({
      sessionId: WORKFLOW_TEST_SESSION_ID,
    });

    expect(firstPageOnly.status === "served" && firstPageOnly.value.nextCursor).toBe("page-1");
    expect(
      firstPageOnly.status === "served"
        ? firstPageOnly.value.definitions.map((definition) => definition.name)
        : [],
    ).toStrictEqual(["nightly"]);
    // And the whole walk, over the same port, finds it.
    expect(namesOf(await readWorkflowDefinitions(growth, WORKFLOW_TEST_SESSION_ID))).toContain(
      "release",
    );
  });

  it("carries a refusal on any page as the whole read's refusal", async () => {
    // A partial list presented as the answer would resolve a typed name against
    // definitions the daemon never finished listing.
    const growth = fixtureGrowthPort({
      pages: [{ definitions: [{ name: "nightly" }] }, { refuses: true }],
    });

    const enumeration = await readWorkflowDefinitions(growth, WORKFLOW_TEST_SESSION_ID);

    expect(enumeration.status).toBe("refused");
    if (enumeration.status !== "refused") {
      throw new Error("a refused page must not settle as a served list");
    }
    // The port's own refusal, carried rather than re-minted: the code says this build
    // registers no wire for the operation, which is what the console renders.
    expect(enumeration.refusal.code).toBe("wire-unregistered");
  });

  it("stops at the page cap and says the search did not finish", async () => {
    const calls = recordedWorkflowCalls();
    const growth = fixtureGrowthPort({
      pages: [{ definitions: [{ name: "nightly" }] }],
      endless: true,
      calls,
    });

    const enumeration = await readWorkflowDefinitions(growth, WORKFLOW_TEST_SESSION_ID);

    // Bounded: a cursor the daemon keeps handing back is otherwise an unbounded loop
    // on a person's keystroke.
    expect(calls.listed).toHaveLength(COMPOSER_WORKFLOW_DEFINITION_PAGE_CAP);
    expect(enumeration.status === "served" && enumeration.complete).toBe(false);
  });

  it("stops paging the moment the reading it was for is superseded", async () => {
    const calls = recordedWorkflowCalls();
    let isLive = true;
    const growth = fixtureGrowthPort({
      pages: [{ definitions: [{ name: "nightly" }] }],
      endless: true,
      calls,
      onList: () => {
        // Superseded between pages, the way a typed keystroke supersedes the read
        // that was in flight for the previous one.
        isLive = false;
      },
    });

    const enumeration = await readWorkflowDefinitions(
      growth,
      WORKFLOW_TEST_SESSION_ID,
      () => isLive,
    );

    expect(calls.listed).toHaveLength(1);
    expect(enumeration.status === "served" && enumeration.complete).toBe(false);
  });

  it("negative control: the same endless port pages to the cap when nothing supersedes it", async () => {
    // Without the liveness guard the walk above would have spent every page the cap
    // allows, so the one-call assertion is a claim about cancellation rather than
    // about the fixture running out of pages.
    const calls = recordedWorkflowCalls();
    const growth = fixtureGrowthPort({
      pages: [{ definitions: [{ name: "nightly" }] }],
      endless: true,
      calls,
    });

    await readWorkflowDefinitions(growth, WORKFLOW_TEST_SESSION_ID, () => true);

    expect(calls.listed).toHaveLength(COMPOSER_WORKFLOW_DEFINITION_PAGE_CAP);
  });
});
