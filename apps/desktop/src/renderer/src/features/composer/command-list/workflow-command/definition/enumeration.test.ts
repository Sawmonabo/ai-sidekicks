// The enumeration is read whole or not at all, and an endless cursor stops at the cap. The fixture
// pages by cursor, not by call count.

import { describe, expect, it } from "vitest";

import { COMPOSER_WORKFLOW_DEFINITION_PAGE_CAP } from "#renderer/features/composer/bounds.js";
import { readWorkflowDefinitions } from "./enumeration.js";
import {
  fixtureWorkflowStartOperations,
  recordedWorkflowCalls,
  WORKFLOW_TEST_SESSION_ID,
} from "../workflow-command.test-support.js";

/** The names one walk carried back, in the order the pages served them. */
function namesOf(enumeration: Awaited<ReturnType<typeof readWorkflowDefinitions>>): string[] {
  return enumeration.definitions.map((definition) => definition.name);
}

describe("readWorkflowDefinitions", () => {
  it("follows the wire's own cursor to exhaustion", async () => {
    const calls = recordedWorkflowCalls();
    const operations = fixtureWorkflowStartOperations({
      pages: [
        { definitions: [{ name: "nightly" }] },
        { definitions: [{ name: "release" }] },
        { definitions: [{ name: "deploy" }] },
      ],
      calls,
    });

    const enumeration = await readWorkflowDefinitions(
      operations.readDefinitionPage,
      WORKFLOW_TEST_SESSION_ID,
    );

    expect(namesOf(enumeration)).toStrictEqual(["nightly", "release", "deploy"]);
    expect(enumeration.complete).toBe(true);
    // The cursors are the daemon's, carried back untouched.
    expect(calls.listed.map((request) => request.cursor)).toStrictEqual([
      undefined,
      "page-1",
      "page-2",
    ]);
  });

  it("rejects the whole read when any page rejects", async () => {
    // A partial list would resolve a typed name against definitions never fully listed.
    const operations = fixtureWorkflowStartOperations({
      pages: [{ definitions: [{ name: "nightly" }] }],
      onList: (request) => {
        if (request.cursor !== undefined) {
          throw new Error("page two is unreachable");
        }
      },
      endless: true,
    });

    await expect(
      readWorkflowDefinitions(operations.readDefinitionPage, WORKFLOW_TEST_SESSION_ID),
    ).rejects.toThrow("page two is unreachable");
  });

  it("stops at the page cap and says the search did not finish", async () => {
    const calls = recordedWorkflowCalls();
    const operations = fixtureWorkflowStartOperations({
      pages: [{ definitions: [{ name: "nightly" }] }],
      endless: true,
      calls,
    });

    const enumeration = await readWorkflowDefinitions(
      operations.readDefinitionPage,
      WORKFLOW_TEST_SESSION_ID,
    );

    // Bounded: a cursor handed back forever would otherwise loop on a keystroke.
    expect(calls.listed).toHaveLength(COMPOSER_WORKFLOW_DEFINITION_PAGE_CAP);
    expect(enumeration.complete).toBe(false);
  });
});
