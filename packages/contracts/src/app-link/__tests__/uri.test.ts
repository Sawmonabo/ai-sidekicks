// The `sidekicks://` link is untrusted input from any program on the machine, and the copy, the
// desktop's handler and the command line must agree on its form, so the Rust pair reads this case
// table too, parsed strictly here with zod.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { readCaseTable } from "../../__tests__/case-table.test-support.js";
import { type SessionId, validateSessionId } from "../../generated/session/id.js";
import { type WorkflowRunId, validateWorkflowRunId } from "../../generated/workflow/run/id.js";
import { composeAppLink, parseAppLink } from "../uri.js";

const appLinkTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("session"),
      sessionId: z.custom<SessionId>((id) => validateSessionId(id)),
    })
    .strict(),
  z
    .object({
      kind: z.literal("workflowRun"),
      workflowRunId: z.custom<WorkflowRunId>((id) => validateWorkflowRunId(id)),
    })
    .strict(),
]);

const appLinkCases = readCaseTable(
  z
    .object({
      composed: z.array(z.object({ target: appLinkTargetSchema, link: z.string() }).strict()),
      parsed: z.array(
        z.object({ link: z.string(), target: appLinkTargetSchema.nullable() }).strict(),
      ),
    })
    .strict(),
  "app-link.json",
);

describe("composeAppLink and parseAppLink", () => {
  it.each(appLinkCases.composed)("writes $link and reads it back", ({ target, link }) => {
    expect(composeAppLink(target)).toBe(link);
    expect(parseAppLink(link)).toEqual(target);
  });

  it.each(appLinkCases.parsed)("reads $link as $target", ({ link, target }) => {
    expect(parseAppLink(link)).toEqual(target);
  });
});
