// The three execution roots, and the badge a substituted mode wears.
//
// THE ROWS ARE WHAT THE DISCLOSURE RENDERS AND THE BADGE IS WHAT SITS OUTSIDE IT, so
// both are tested here as values rather than through the markup: the ordering claim and
// the agreement claim are the parts that would go wrong silently.

import { describe, expect, it } from "vitest";

import {
  BOUND_ROOT_LABEL,
  CHECKOUT_ROOT_LABEL,
  MOUNT_ROOT_LABEL,
  executionPathRows,
  executionRootsSummaryLine,
  fallbackBadgeFor,
  type WorkspaceExecutionContext,
} from "./execution-context-model.js";

const MOUNT_ROOT = "/Users/dev/code/ai-sidekicks";

function context(overrides: Partial<WorkspaceExecutionContext> = {}): WorkspaceExecutionContext {
  return { workspaceId: "workspace-1", boundRoot: MOUNT_ROOT, ...overrides };
}

describe("executionPathRows — all three roots, in reading order", () => {
  it("places the mount root, the bound root, and the checkout root in that order", () => {
    const rows = executionPathRows(MOUNT_ROOT, context({ checkoutRoot: "/private/tmp/wt" }));
    expect(rows.map((row) => row.label)).toStrictEqual([
      MOUNT_ROOT_LABEL,
      BOUND_ROOT_LABEL,
      CHECKOUT_ROOT_LABEL,
    ]);
  });

  it("carries each root verbatim, with no normalisation of its own", () => {
    const boundRoot = "/Users/dev/code/ai-sidekicks/.worktrees/feat";
    const checkoutRoot = "/private/var/folders/T/wt";
    const rows = executionPathRows(MOUNT_ROOT, context({ boundRoot, checkoutRoot }));
    expect(rows.map((row) => row.value)).toStrictEqual([MOUNT_ROOT, boundRoot, checkoutRoot]);
  });

  it("marks a root that agrees with the one above it, and only then", () => {
    const rows = executionPathRows(MOUNT_ROOT, context({ checkoutRoot: MOUNT_ROOT }));
    expect(rows[1]?.matchesPrevious).toBe(true);
    expect(rows[2]?.matchesPrevious).toBe(true);
  });

  it("negative control: three different roots claim no agreement anywhere", () => {
    const rows = executionPathRows(
      MOUNT_ROOT,
      context({ boundRoot: "/a/bound", checkoutRoot: "/a/checkout" }),
    );
    expect(rows.some((row) => row.matchesPrevious)).toBe(false);
  });

  it("says why the checkout root is absent rather than rendering an empty cell", () => {
    // `run_execution_contexts.checkout_root` is captured per RUN, so a workspace no run
    // has executed in has none — which is a different fact from a root that is missing.
    const rows = executionPathRows(MOUNT_ROOT, context());
    expect(rows[2]?.value).toBeUndefined();
    expect(rows[2]?.absence).toContain("No run has captured");
  });

  it("negative control: a present checkout root carries no absence sentence", () => {
    const rows = executionPathRows(MOUNT_ROOT, context({ checkoutRoot: "/a/checkout" }));
    expect(rows[2]?.absence).toBeUndefined();
  });
});

describe("executionRootsSummaryLine — the one line the summary has room for", () => {
  it("claims agreement only when all three roots are byte-equal", () => {
    const line = executionRootsSummaryLine(
      { status: "read", context: context({ checkoutRoot: MOUNT_ROOT }) },
      MOUNT_ROOT,
    );
    expect(line).toBe("all three roots agree");
  });

  it("reports a worktree-mode binding as disagreeing, though two of its roots agree", () => {
    // The case the disclosure exists for: the execution root sits outside the mount it
    // was attached as, and its normalized checkout root is that same root — so a
    // summary reading the bound root against the checkout root ALONE would call three
    // differing paths agreement, on the one binding whose roots most need reading.
    const worktreeRoot = `${MOUNT_ROOT}-worktrees/implementer`;
    const line = executionRootsSummaryLine(
      {
        status: "read",
        context: context({ boundRoot: worktreeRoot, checkoutRoot: worktreeRoot }),
      },
      MOUNT_ROOT,
    );
    expect(line).toBe("the roots differ");
  });

  it("negative control: a mount root that differs from a bound root alone also differs", () => {
    const line = executionRootsSummaryLine(
      {
        status: "read",
        context: context({ boundRoot: "/a/bound", checkoutRoot: "/a/checkout" }),
      },
      MOUNT_ROOT,
    );
    expect(line).toBe("the roots differ");
  });

  it("says the checkout root is uncaptured rather than reading its absence as agreement", () => {
    const line = executionRootsSummaryLine({ status: "read", context: context() }, MOUNT_ROOT);
    expect(line).toBe("no captured checkout root");
  });

  it("keeps the three unserved readings apart from each other", () => {
    // Rule 8's separation, at the one place a person reads before opening anything: a
    // question never put, one in flight, and one the wire said no to are three lines.
    expect(executionRootsSummaryLine({ status: "not-read" }, MOUNT_ROOT)).toBe("not read");
    expect(executionRootsSummaryLine({ status: "reading" }, MOUNT_ROOT)).toBe("reading");
    expect(
      executionRootsSummaryLine(
        {
          status: "refused",
          refusal: {
            code: "workspace.not_found",
            detail: "No workspace with that id is bound on this node.",
            origin: "growth-port",
          },
        },
        MOUNT_ROOT,
      ),
    ).toContain("workspace.not_found");
  });
});

describe("fallbackBadgeFor", () => {
  it("names the mode that was asked for, which is the half the row does not carry", () => {
    const badge = fallbackBadgeFor(context({ fallbackFromMode: "worktree" }));
    expect(badge?.label).toContain("worktree");
    expect(badge?.sentence.trim().length).toBeGreaterThan(0);
  });

  it("negative control: a binding running the mode it was asked for wears no badge", () => {
    // The ordinary case must stay unmarked: a marker on every row is a marker on none.
    expect(fallbackBadgeFor(context())).toBeUndefined();
  });
});
