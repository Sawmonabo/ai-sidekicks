// The git-flow contract as the daemon and the desktop both parse it: a workflow run's diff names
// an approval pause counted from 1, a diff file carries its old path exactly when it was renamed,
// and a hosting address the desktop opens is only a web address.
import { describe, it } from "vitest";

import { GITFLOW_METHOD_DESCRIPTORS } from "../methods.js";
import { WorkflowStepReviewPauseSchema } from "../../workflow/run/step.js";
import { accepts, refuses } from "../../__tests__/safe-parse.test-support.js";

const AGENT_ID = "6ba7b811-9dad-41d1-80b4-00c04fd430c8";
const SESSION_ID = "6ba7b812-9dad-41d1-80b4-00c04fd430c8";
const WORKFLOW_RUN_ID = "6ba7b813-9dad-41d1-80b4-00c04fd430c8";
const COMMIT_ID = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const BLOB_ID = "0123456789abcdef0123456789abcdef01234567";
const AT = "2026-09-29T12:00:00.000Z";

const methods = GITFLOW_METHOD_DESCRIPTORS;

describe("gitflow.diffRead", () => {
  const diff = methods["gitflow.diffRead"];

  const file = {
    path: "src/keys.ts",
    kind: "modified",
    additions: 4,
    deletions: 1,
    patch: "@@ -1 +1 @@\n-a\n+b\n",
    oldBlobId: BLOB_ID,
    newBlobId: BLOB_ID,
    newestTurn: 3,
  };
  const result = (files: unknown[]) => ({
    head: "sidekicks/4f2a/rotate-keys",
    base: "main",
    files,
    commits: [
      {
        commitId: COMMIT_ID,
        shortId: "a1b2c3d",
        subject: "Mint the replacement before revoking",
        landedAt: AT,
        agent: { agentId: AGENT_ID, name: "reviewer" },
      },
    ],
  });

  it("names an approval pause counted from 1, as the step's review pause does", () => {
    const request = (pauseNumber: number) => ({
      sessionId: SESSION_ID,
      scope: "workflow_run",
      workflowRunId: WORKFLOW_RUN_ID,
      from: { epoch: 0, point: "start" },
      to: { epoch: 0, point: "pause", pauseNumber },
    });
    accepts(diff.requestSchema, request(1));
    refuses(diff.requestSchema, request(0));
    // The step hands its pinned review pause to this request, so both refuse the same numbers.
    accepts(WorkflowStepReviewPauseSchema, { state: "pinned", epoch: 0, pauseNumber: 1 });
    refuses(WorkflowStepReviewPauseSchema, { state: "pinned", epoch: 0, pauseNumber: 0 });
  });

  it("carries the old path exactly when a file was renamed", () => {
    accepts(diff.responseSchema, result([file]));
    const renamed = { ...file, kind: "renamed", oldPath: "src/key.ts" };
    accepts(diff.responseSchema, result([renamed]));
    refuses(diff.responseSchema, result([{ ...renamed, oldPath: undefined }]));
    refuses(diff.responseSchema, result([{ ...file, oldPath: "src/key.ts" }]));
  });
});

describe("gitflow.changeRequestSubscribe", () => {
  const subscribe = methods["gitflow.changeRequestSubscribe"];
  const summary = {
    number: 482,
    url: "https://github.com/acme/app/pull/482",
    state: "open",
    isDraft: false,
    reviewDecision: "changes_requested",
  };
  const detail = {
    ...summary,
    viewerIsAuthor: true,
    description: "Rotates the signing keys.",
    reviews: [{ reviewer: "octocat", verdict: "commented" }],
    requestedReviewers: ["hubot"],
    threads: [
      {
        threadId: "PRRT_1",
        path: "src/keys.ts",
        line: 12,
        side: "new",
        state: "open",
        comments: [{ commentId: "c1", author: "octocat", body: "Why now?", createdAt: AT }],
      },
    ],
    checks: [
      {
        checkId: "run-9",
        name: "test",
        status: "failure",
        runUrl: "https://github.com/acme/app/actions/runs/9",
      },
    ],
    headCommitId: COMMIT_ID,
  };

  it("carries a hosting address only as a web address", () => {
    accepts(subscribe.emissionSchema, { depth: "summary", requests: [summary], readAt: AT });
    accepts(subscribe.emissionSchema, {
      depth: "full",
      requests: [detail],
      readAt: AT,
      lastReadFailedAt: AT,
    });
    refuses(subscribe.emissionSchema, { depth: "full", requests: [summary], readAt: AT });
    refuses(subscribe.emissionSchema, {
      depth: "summary",
      requests: [{ ...summary, url: "javascript:alert(1)" }],
      readAt: AT,
    });
  });
});
