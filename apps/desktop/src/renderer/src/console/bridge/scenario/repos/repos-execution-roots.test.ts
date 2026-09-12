// The three roots the repos scenario states, and the relationship between them.
//
// A SEPARATE FILE FROM `repos.test.ts` BECAUSE THE SUBJECT IS NARROWER AND THE CLAIM IS
// STRUCTURAL. That suite asks whether the fixture is reachable at all — the beats parse,
// the entity-scoped reads answer per entity, the counts come off the roster. This one
// asks whether one served answer says the thing the surface reading it draws, which is a
// question about the VALUES rather than about the wiring.
//
// AND THE CLAIM IS THE NESTING, NEVER STRING INEQUALITY. The disclosure this fixture
// feeds compares bytes and resolves nothing — deliberately, since containment, symlink
// resolution and case folding are daemon rules — so "the roots differ" is true of one
// directory spelled two ways, and the fixture stated exactly that for as long as its
// checkout root was the bound root with `/.` on the end. Byte inequality is therefore
// the wrong assertion to pin a fixture with: it passes on the defect. What is asserted
// below is the relationship turn-boundary snapshots describe — a bound root
// nested inside the working-tree top level its snapshots normalize to — which no
// spelling discrepancy can satisfy.

import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "../../fixture/call-plane/bridge.js";
import { REPOS_SCENARIO } from "./repos.js";
import {
  ATTACHED_WORKSPACE_ID,
  DRIFTED_WORKSPACE_ID,
  GIT_WORKSPACE_ID,
} from "./repos-fixture-data.js";
import { REPOS_SCENARIO_REPLIES } from "./repos-replies.js";

/** The mount root the git workspace's mount resolved to, as the scenario's read states it. */
const GIT_MOUNT_CANONICAL_ROOT = "/Users/dev/code/ai-sidekicks";

/** One workspace's served execution context, or a failure naming the workspace. */
async function servedExecutionContext(workspaceId: string): Promise<{
  readonly boundRoot: string;
  readonly checkoutRoot?: string;
  readonly fallbackFromMode?: string;
}> {
  const bridge = createFixtureBridge({ scenario: REPOS_SCENARIO });
  const outcome = await bridge.growth.workspaceExecutionContextRead({ workspaceId });
  if (outcome.status !== "served") {
    throw new Error(`the fixture refused the execution-context read for ${workspaceId}`);
  }
  return outcome.value;
}

/** Whether one path sits strictly inside another, by the separator the paths are written with. */
function isNestedInside(candidate: string, enclosingRoot: string): boolean {
  return candidate.startsWith(`${enclosingRoot}/`) && candidate.length > enclosingRoot.length + 1;
}

describe("the repos scenario — the git workspace's three roots are three facts", () => {
  it("nests the bound root inside the normalized checkout root", async () => {
    // The case the disclosure exists for: a `branch`-mode workspace bound at a
    // subdirectory of its checkout, whose snapshots operate on the enclosing
    // working-tree top level. Asserted as containment rather than as inequality,
    // because inequality is what the trailing-`/.` fixture already satisfied.
    const context = await servedExecutionContext(GIT_WORKSPACE_ID);

    expect(context.checkoutRoot).toBeDefined();
    expect(isNestedInside(context.boundRoot, context.checkoutRoot ?? "")).toBe(true);
  });

  it("puts that checkout on a different top level from the mount's own root", async () => {
    // Without this the nesting above would hold for a bound root inside the mount's own
    // checkout, which is only TWO distinct roots — and the summary line the workspace
    // card renders is a claim about three.
    const context = await servedExecutionContext(GIT_WORKSPACE_ID);

    expect(context.checkoutRoot).not.toBe(GIT_MOUNT_CANONICAL_ROOT);
    expect(isNestedInside(context.checkoutRoot ?? "", GIT_MOUNT_CANONICAL_ROOT)).toBe(false);
    expect(new Set([GIT_MOUNT_CANONICAL_ROOT, context.boundRoot, context.checkoutRoot]).size).toBe(
      3,
    );
  });

  it("reports the bound root the workspace roster reports as that workspace's fsRoot", async () => {
    // Two views of one binding. A roster row and a context read that disagreed about
    // where a workspace runs would put a path on the card and a different one in the
    // disclosure beneath it, and the disclosure is what a person opens to resolve that.
    const roster = REPOS_SCENARIO_REPLIES.find((reply) => reply.call === "repo.workspaceList");
    const workspaces = (
      roster as {
        readonly result: {
          readonly workspaces: readonly { readonly id: string; readonly fsRoot?: string }[];
        };
      }
    ).result.workspaces;
    const context = await servedExecutionContext(GIT_WORKSPACE_ID);

    expect(workspaces.find((workspace) => workspace.id === GIT_WORKSPACE_ID)?.fsRoot).toBe(
      context.boundRoot,
    );
  });

  it("negative control: the attached workspace's roots agree, so the predicate discriminates", async () => {
    // The other half of the comparison, and the reason the nesting check is not
    // vacuous: this binding runs in the root it was bound at, so its checkout root is
    // its bound root and nothing is nested in anything.
    const context = await servedExecutionContext(ATTACHED_WORKSPACE_ID);

    expect(context.checkoutRoot).toBe(context.boundRoot);
    expect(isNestedInside(context.boundRoot, context.checkoutRoot ?? "")).toBe(false);
  });

  it("negative control: a workspace this scenario holds no context for is refused, not answered", async () => {
    // Without this the cases above would pass against a fixture answering every request
    // with the git workspace's row, which is the defect they exist to catch, one step
    // removed.
    const bridge = createFixtureBridge({ scenario: REPOS_SCENARIO });

    const outcome = await bridge.growth.workspaceExecutionContextRead({
      workspaceId: DRIFTED_WORKSPACE_ID,
    });

    expect(outcome.status).toBe("unavailable");
    expect(outcome).not.toHaveProperty("value");
  });
});
