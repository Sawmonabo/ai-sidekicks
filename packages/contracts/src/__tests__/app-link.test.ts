// The `sidekicks://` link is untrusted input from any program on the machine, and
// the copy, the desktop's handler and the command line must agree on its form.
import { describe, expect, it } from "vitest";

import { composeAppLink, parseAppLink } from "../app-link.js";
import type { SessionId } from "../session.js";
import type { WorkflowRunId } from "../workflow-run.js";

const SESSION_ID = "0199a0c2-7d3e-7b1f-9c4a-8f3a1b2c5d6e" as SessionId;
const WORKFLOW_RUN_ID = "0199a0c2-7d3e-7b1f-9c4a-8f3a1b2c5d6f" as WorkflowRunId;

describe("composeAppLink and parseAppLink", () => {
  it("writes a session's and a workflow run's link and reads each back to its target", () => {
    const sessionLink = composeAppLink({ kind: "session", sessionId: SESSION_ID });
    const runLink = composeAppLink({ kind: "workflowRun", workflowRunId: WORKFLOW_RUN_ID });

    expect(sessionLink).toBe(`sidekicks://session/${SESSION_ID}`);
    expect(runLink).toBe(`sidekicks://workflow-run/${WORKFLOW_RUN_ID}`);
    expect(parseAppLink(sessionLink)).toEqual({ kind: "session", sessionId: SESSION_ID });
    expect(parseAppLink(runLink)).toEqual({ kind: "workflowRun", workflowRunId: WORKFLOW_RUN_ID });
  });

  it.each([
    ["another scheme", `https://session/${SESSION_ID}`],
    ["another host", `sidekicks://project/${SESSION_ID}`],
    ["a trailing slash", `sidekicks://session/${SESSION_ID}/`],
    ["a second path segment", `sidekicks://session/${SESSION_ID}/extra`],
    ["a query", `sidekicks://session/${SESSION_ID}?token=secret`],
    ["a fragment", `sidekicks://session/${SESSION_ID}#top`],
    ["user info", `sidekicks://me@session/${SESSION_ID}`],
    ["a percent-encoded id", `sidekicks://workflow-run/run%2Fother`],
    ["a session id that is not a UUID", "sidekicks://session/not-a-uuid"],
    ["leading whitespace", ` sidekicks://session/${SESSION_ID}`],
  ])("refuses %s", (_case, address) => {
    expect(parseAppLink(address)).toBeNull();
  });

  it("refuses to write a link for an id that would not read back", () => {
    expect(() =>
      composeAppLink({ kind: "workflowRun", workflowRunId: "run/other" as WorkflowRunId }),
    ).toThrow(RangeError);
  });
});
