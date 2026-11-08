// The `sidekicks://` link is untrusted input from any program on the machine, and the copy, the
// desktop's handler and the command line must agree on its form, so the Rust pair reads this case
// table too.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { type AppLinkTarget, composeAppLink, parseAppLink } from "../app-link.js";
import { SessionIdSchema } from "../session/id.js";
import { canonicalizeUuid } from "../uuid-canonical.js";
import { type WorkflowRunId, WorkflowRunIdSchema } from "../workflow/run/id.js";

const appLinkTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session"), sessionId: SessionIdSchema }).strict(),
  z.object({ kind: z.literal("workflowRun"), workflowRunId: WorkflowRunIdSchema }).strict(),
]);

const appLinkCases = z
  .object({
    composed: z.array(z.object({ target: appLinkTargetSchema, link: z.string() }).strict()),
    parsed: z.array(
      z.object({ link: z.string(), target: appLinkTargetSchema.nullable() }).strict(),
    ),
  })
  .strict()
  .parse(
    JSON.parse(
      readFileSync(
        new URL(
          "../../../../crates/sidekicks-contracts/tests/fixtures/app-link.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );

/** The target with its id lowercased: ids compare as ids, and the id schemas keep the case read. */
function canonicalTarget(target: AppLinkTarget | null): AppLinkTarget | null {
  if (target === null) {
    return null;
  }
  return target.kind === "session"
    ? { kind: "session", sessionId: canonicalizeUuid(target.sessionId) }
    : { kind: "workflowRun", workflowRunId: canonicalizeUuid(target.workflowRunId) };
}

describe("composeAppLink and parseAppLink", () => {
  it.each(appLinkCases.composed)("writes $link and reads it back", ({ target, link }) => {
    expect(composeAppLink(target)).toBe(link);
    expect(parseAppLink(link)).toEqual(target);
  });

  it.each(appLinkCases.parsed)("reads $link as $target", ({ link, target }) => {
    expect(canonicalTarget(parseAppLink(link))).toEqual(target);
  });

  it("refuses to write a link for an id that would not read back", () => {
    expect(() =>
      composeAppLink({ kind: "workflowRun", workflowRunId: "run/other" as WorkflowRunId }),
    ).toThrow(RangeError);
  });
});
