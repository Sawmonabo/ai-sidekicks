// The git-flow contract as the daemon and the desktop both parse it: each method's
// request and result accept the shape the review and ship surfaces use, and refuse
// the cases those surfaces rule out.
import { describe, expect, it } from "vitest";

import {
  GITFLOW_METHOD_DESCRIPTORS,
  GIT_HOST_NAME_MAX_LEN,
  GitSettledPayloadSchema,
  GitflowGenerateFailedDetailsSchema,
  GitflowHostInvalidDetailsSchema,
} from "../gitflow/index.js";
import { DRIVER_FAILURE_DETAIL_MAX_LEN } from "../provider-driver.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const RUN_ID = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const AGENT_ID = "6ba7b811-9dad-41d1-80b4-00c04fd430c8";
const COMMIT_ID = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const BLOB_ID = "0123456789abcdef0123456789abcdef01234567";
const AT = "2026-09-29T12:00:00.000Z";

const methods = GITFLOW_METHOD_DESCRIPTORS;
const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe("self-hosted git hosts", () => {
  const add = methods["gitflow.hostAdd"];

  it("takes one host name and no kind", () => {
    expect(accepts(add.requestSchema, { host: "gitlab.internal.lan" })).toBe(true);
    expect(accepts(add.requestSchema, { host: "gitlab.internal.lan", kind: "gitlab" })).toBe(false);
  });

  it("leaves a name that does not parse to the daemon's refusal", () => {
    expect(accepts(add.requestSchema, { host: " " })).toBe(true);
    expect(accepts(add.requestSchema, { host: "https://gitlab.internal.lan/x" })).toBe(true);
  });

  it("bounds the host at the longest name DNS allows", () => {
    expect(accepts(add.requestSchema, { host: "a".repeat(GIT_HOST_NAME_MAX_LEN) })).toBe(true);
    expect(accepts(add.requestSchema, { host: "a".repeat(GIT_HOST_NAME_MAX_LEN + 1) })).toBe(false);
  });

  it("lists the machine's hosts with the kind that answered for each", () => {
    const list = methods["gitflow.hostList"];
    expect(accepts(list.requestSchema, {})).toBe(true);
    expect(accepts(list.requestSchema, { sessionId: SESSION_ID })).toBe(false);
    const host = { host: "git.example.lan", kind: "github", addedAt: AT };
    expect(accepts(list.responseSchema, { hosts: [host] })).toBe(true);
    expect(accepts(list.responseSchema, { hosts: [{ ...host, kind: "bitbucket" }] })).toBe(false);
  });

  it("removes a host, saying whether it was listed", () => {
    const remove = methods["gitflow.hostRemove"];
    expect(accepts(remove.requestSchema, { host: "git.example.lan" })).toBe(true);
    expect(accepts(remove.responseSchema, { removed: false })).toBe(true);
  });

  it("refuses a host for exactly two reasons", () => {
    expect(accepts(GitflowHostInvalidDetailsSchema, { reason: "not_a_host_name" })).toBe(true);
    expect(accepts(GitflowHostInvalidDetailsSchema, { reason: "not_answered" })).toBe(true);
    expect(accepts(GitflowHostInvalidDetailsSchema, { reason: "unreachable" })).toBe(false);
  });
});

describe("gitflow.branchContextRead", () => {
  const read = methods["gitflow.branchContextRead"];
  const facts = {
    headBranch: "sidekicks/4f2a/rotate-keys",
    baseBranch: "main",
    defaultBranch: "main",
    upstreamRef: "origin/sidekicks/4f2a/rotate-keys",
    uncommittedFileCount: 3,
    aheadOfBase: 2,
    behindBase: 14,
    unpushedCommitCount: 1,
    neverLeftMachine: false,
    pendingOperation: { kind: "rebase", endCommand: "git rebase --continue" },
    changeRequests: [
      {
        number: 482,
        url: "https://github.com/acme/app/pull/482",
        state: "open",
        isDraft: false,
        mergeable: "conflicting",
        reviewDecision: "review_required",
      },
    ],
    hostKind: "github",
    countsAsOf: AT,
  };

  it("is keyed by the session alone", () => {
    expect(accepts(read.requestSchema, { sessionId: SESSION_ID })).toBe(true);
    expect(
      accepts(read.requestSchema, {
        sessionId: SESSION_ID,
        branchContextId: "550e8400-e29b-41d4-a716-446655440001",
      }),
    ).toBe(false);
  });

  it("carries the ship facts and the change-request form's opening values", () => {
    expect(accepts(read.responseSchema, facts)).toBe(true);
  });

  it("leaves an unsettled mergeability absent rather than reading it as unknown", () => {
    const [request] = facts.changeRequests;
    const { mergeable: _unsettled, ...withoutMergeable } = request!;
    expect(accepts(read.responseSchema, { ...facts, changeRequests: [withoutMergeable] })).toBe(
      true,
    );
    expect(
      accepts(read.responseSchema, {
        ...facts,
        changeRequests: [{ ...request, mergeable: "unknown" }],
      }),
    ).toBe(false);
  });

  it("keeps a reviewer's verdict out of the request's review decision", () => {
    const [request] = facts.changeRequests;
    expect(
      accepts(read.responseSchema, {
        ...facts,
        changeRequests: [{ ...request, reviewDecision: "commented" }],
      }),
    ).toBe(false);
  });

  it("names only a merge, a rebase or a bisect as the operation that stops a commit", () => {
    expect(
      accepts(read.responseSchema, {
        ...facts,
        pendingOperation: { kind: "cherry_pick", endCommand: "git cherry-pick --continue" },
      }),
    ).toBe(false);
  });
});

describe("gitflow.diffRead", () => {
  const diff = methods["gitflow.diffRead"];

  it("reads each comparison", () => {
    expect(accepts(diff.requestSchema, { sessionId: SESSION_ID, scope: "changes" })).toBe(true);
    expect(
      accepts(diff.requestSchema, {
        sessionId: SESSION_ID,
        scope: "branch",
        base: "main",
        commitId: COMMIT_ID,
      }),
    ).toBe(true);
    expect(
      accepts(diff.requestSchema, {
        sessionId: SESSION_ID,
        scope: "change_request",
        changeRequestNumber: 482,
      }),
    ).toBe(true);
  });

  it("diffs a workflow run between two of its snapshot points", () => {
    const runDiff = {
      sessionId: SESSION_ID,
      scope: "workflow_run",
      workflowRunId: "33333333-3333-4333-8333-333333333333",
      from: { epoch: 0, point: "start" },
      to: { epoch: 0, point: "pause", pauseNumber: 1 },
    };
    expect(accepts(diff.requestSchema, runDiff)).toBe(true);
    expect(accepts(diff.requestSchema, { ...runDiff, to: undefined })).toBe(false);
    expect(accepts(diff.requestSchema, { ...runDiff, to: { epoch: 0, point: "pause" } })).toBe(
      false,
    );
  });

  it("refuses a member another comparison owns, and a comparison that does not exist", () => {
    expect(
      accepts(diff.requestSchema, {
        sessionId: SESSION_ID,
        scope: "branch",
        changeRequestNumber: 482,
      }),
    ).toBe(false);
    expect(accepts(diff.requestSchema, { sessionId: SESSION_ID, scope: "change_request" })).toBe(
      false,
    );
    expect(accepts(diff.requestSchema, { sessionId: SESSION_ID, scope: "staged" })).toBe(false);
  });

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
    partial: false,
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

  it("returns one entry per path with its kind, counts, patch and blob ids", () => {
    expect(accepts(diff.responseSchema, result([file]))).toBe(true);
  });

  it("carries the old path exactly when a file was renamed", () => {
    const renamed = { ...file, kind: "renamed", oldPath: "src/key.ts" };
    expect(accepts(diff.responseSchema, result([renamed]))).toBe(true);
    expect(accepts(diff.responseSchema, result([{ ...renamed, oldPath: undefined }]))).toBe(false);
    expect(accepts(diff.responseSchema, result([{ ...file, oldPath: "src/key.ts" }]))).toBe(false);
  });

  it("says why a file cannot be shown only in its own closed words", () => {
    const tooLarge = { ...file, patch: undefined, unreadable: "too_large" };
    expect(accepts(diff.responseSchema, result([tooLarge]))).toBe(true);
    expect(accepts(diff.responseSchema, result([{ ...tooLarge, unreadable: "corrupt" }]))).toBe(
      false,
    );
  });

  it("carries a blob id only in git's full form", () => {
    expect(accepts(diff.responseSchema, result([{ ...file, newBlobId: "0123456" }]))).toBe(false);
  });
});

describe("the ship acts", () => {
  const preview = methods["gitflow.gitActionPreview"];
  const execute = methods["gitflow.gitActionExecute"];
  const commit = {
    sessionId: SESSION_ID,
    act: "commit",
    formValues: { subject: "s".repeat(200), body: "Why the keys rotate." },
  };
  const openChangeRequest = {
    sessionId: SESSION_ID,
    act: "open_change_request",
    formValues: {
      base: "main",
      title: "Rotate signing keys",
      description: "",
      draft: true,
      reviewers: ["octocat"],
      labels: ["security"],
    },
  };

  it("previews each act from the same form values it runs with", () => {
    expect(accepts(preview.requestSchema, commit)).toBe(true);
    expect(accepts(preview.requestSchema, { sessionId: SESSION_ID, act: "push" })).toBe(true);
    expect(accepts(preview.requestSchema, { sessionId: SESSION_ID, act: "pull" })).toBe(true);
    expect(accepts(preview.requestSchema, openChangeRequest)).toBe(true);
    expect(accepts(preview.responseSchema, { commands: ["git add -A", "git commit -F -"] })).toBe(
      true,
    );
  });

  it("puts no length limit on a commit subject but refuses an empty one", () => {
    expect(accepts(execute.requestSchema, commit)).toBe(true);
    expect(accepts(execute.requestSchema, { ...commit, formValues: { subject: "" } })).toBe(false);
  });

  it("gives push and pull no form, and opening a request its whole form", () => {
    expect(
      accepts(execute.requestSchema, {
        sessionId: SESSION_ID,
        act: "push",
        formValues: { subject: "x" },
      }),
    ).toBe(false);
    const { draft: _draft, ...withoutDraft } = openChangeRequest.formValues;
    expect(accepts(execute.requestSchema, { ...openChangeRequest, formValues: withoutDraft })).toBe(
      false,
    );
  });

  it("offers no amend and no force push", () => {
    expect(accepts(execute.requestSchema, { sessionId: SESSION_ID, act: "amend" })).toBe(false);
    expect(accepts(execute.requestSchema, { sessionId: SESSION_ID, act: "force_push" })).toBe(
      false,
    );
  });

  it("retries an act from its failed command on execution only", () => {
    const retry = { ...commit, retryFromCommand: { actId: "act-1", commandIndex: 1 } };
    expect(accepts(execute.requestSchema, retry)).toBe(true);
    expect(accepts(preview.requestSchema, retry)).toBe(false);
    expect(
      accepts(execute.responseSchema, { actId: "act-1", commands: ["git add -A", "git commit"] }),
    ).toBe(true);
  });

  it("streams each command's state", () => {
    const subscribe = methods["gitflow.gitActionSubscribe"];
    expect(accepts(subscribe.requestSchema, { actId: "act-1" })).toBe(true);
    const frame = {
      actId: "act-1",
      commands: [
        { index: 0, text: "git add -A", state: "done" },
        { index: 1, text: "git commit -F -", state: "failed", output: "hook refused" },
      ],
    };
    expect(accepts(subscribe.emissionSchema, frame)).toBe(true);
    expect(
      accepts(subscribe.emissionSchema, {
        ...frame,
        commands: [{ index: 0, text: "git add -A", state: "skipped" }],
      }),
    ).toBe(false);
  });
});

describe("Generate", () => {
  it("writes a commit's subject and body and a request's title and description", () => {
    const commitText = methods["gitflow.commitMessageGenerate"];
    const requestText = methods["gitflow.changeRequestTextGenerate"];
    expect(accepts(commitText.requestSchema, { sessionId: SESSION_ID })).toBe(true);
    expect(accepts(commitText.responseSchema, { subject: "Rotate keys", body: "" })).toBe(true);
    expect(accepts(requestText.responseSchema, { title: "Rotate keys", description: "" })).toBe(
      true,
    );
  });

  it("refuses in the provider's own words, within the provider-detail bound", () => {
    const words = "You've hit your usage limit.";
    expect(accepts(GitflowGenerateFailedDetailsSchema, { providerFailureDetail: words })).toBe(
      true,
    );
    expect(
      accepts(GitflowGenerateFailedDetailsSchema, {
        providerFailureDetail: "x".repeat(DRIVER_FAILURE_DETAIL_MAX_LEN + 1),
      }),
    ).toBe(false);
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

  it("takes the depth the reader needs", () => {
    expect(accepts(subscribe.requestSchema, { sessionId: SESSION_ID, depth: "summary" })).toBe(
      true,
    );
    expect(accepts(subscribe.requestSchema, { sessionId: SESSION_ID })).toBe(false);
    expect(accepts(subscribe.requestSchema, { sessionId: SESSION_ID, depth: "threads" })).toBe(
      false,
    );
  });

  it("streams the header's facts at summary depth and Review's at full depth", () => {
    expect(
      accepts(subscribe.emissionSchema, { depth: "summary", requests: [summary], readAt: AT }),
    ).toBe(true);
    expect(
      accepts(subscribe.emissionSchema, {
        depth: "full",
        requests: [detail],
        readAt: AT,
        lastReadFailedAt: AT,
      }),
    ).toBe(true);
    expect(
      accepts(subscribe.emissionSchema, { depth: "full", requests: [summary], readAt: AT }),
    ).toBe(false);
  });

  it("keeps a reviewer's verdict apart from the request's decision", () => {
    const frame = (reviews: unknown) => ({
      depth: "full",
      requests: [{ ...detail, reviews }],
      readAt: AT,
    });
    expect(
      accepts(
        subscribe.emissionSchema,
        frame([{ reviewer: "octocat", verdict: "review_required" }]),
      ),
    ).toBe(false);
  });

  it("carries only a thread state the host reports", () => {
    const [thread] = detail.threads;
    expect(
      accepts(subscribe.emissionSchema, {
        depth: "full",
        requests: [{ ...detail, threads: [{ ...thread, state: "pending" }] }],
        readAt: AT,
      }),
    ).toBe(false);
  });

  it("carries a hosting address only as a web address", () => {
    expect(
      accepts(subscribe.emissionSchema, {
        depth: "summary",
        requests: [{ ...summary, url: "javascript:alert(1)" }],
        readAt: AT,
      }),
    ).toBe(false);
  });
});

describe("the change-request form's candidates", () => {
  it("lists reviewers, narrowed by what was typed, and labels", () => {
    const reviewers = methods["gitflow.reviewerList"];
    const labels = methods["gitflow.labelList"];
    expect(accepts(reviewers.requestSchema, { sessionId: SESSION_ID, query: "oct" })).toBe(true);
    expect(
      accepts(reviewers.responseSchema, { reviewers: [{ login: "octocat", name: "Octo Cat" }] }),
    ).toBe(true);
    expect(accepts(labels.requestSchema, { sessionId: SESSION_ID, query: "sec" })).toBe(false);
    expect(accepts(labels.responseSchema, { labels: [{ name: "security" }] })).toBe(true);
  });
});

describe("posting a review and answering threads", () => {
  const submit = methods["gitflow.reviewSubmit"];

  it("posts under one of the three verdicts and never carries note text", () => {
    const review = { sessionId: SESSION_ID, changeRequestNumber: 482, verdict: "approve" };
    expect(accepts(submit.requestSchema, { ...review, body: "Looks right." })).toBe(true);
    expect(accepts(submit.requestSchema, { ...review, verdict: "request_changes" })).toBe(true);
    expect(accepts(submit.requestSchema, { ...review, verdict: "approved" })).toBe(false);
    expect(
      accepts(submit.requestSchema, { ...review, notes: [{ path: "a.ts", line: 1, body: "x" }] }),
    ).toBe(false);
  });

  it("says which notes posted and why the others did not", () => {
    expect(
      accepts(submit.responseSchema, {
        reviewUrl: "https://github.com/acme/app/pull/482#pullrequestreview-1",
        postedNoteIds: ["note-1"],
        failures: [{ noteId: "note-2", reason: "Line could not be resolved" }],
      }),
    ).toBe(true);
  });

  it("resolves and replies to a thread", () => {
    const resolve = methods["gitflow.threadResolve"];
    const reply = methods["gitflow.threadReply"];
    const thread = { sessionId: SESSION_ID, changeRequestNumber: 482, threadId: "PRRT_1" };
    expect(accepts(resolve.requestSchema, thread)).toBe(true);
    expect(accepts(resolve.responseSchema, { threadId: "PRRT_1", state: "resolved" })).toBe(true);
    expect(accepts(reply.requestSchema, { ...thread, body: "Fixed in a1b2c3d." })).toBe(true);
    expect(accepts(reply.requestSchema, { ...thread, body: "" })).toBe(false);
    expect(accepts(reply.responseSchema, { commentId: "c2" })).toBe(true);
  });

  it("reads the end of a failing check's log", () => {
    const log = methods["gitflow.checkLogRead"];
    expect(
      accepts(log.requestSchema, { sessionId: SESSION_ID, changeRequestNumber: 482, checkId: "9" }),
    ).toBe(true);
    expect(accepts(log.requestSchema, { sessionId: SESSION_ID, changeRequestNumber: 482 })).toBe(
      false,
    );
    expect(
      accepts(log.responseSchema, {
        text: "FAIL src/keys.test.ts",
        truncated: true,
        totalBytes: 14_000_000,
      }),
    ).toBe(true);
  });
});

describe("git.settled", () => {
  it("records each of the five acts with the reference its row names", () => {
    const payloads = [
      { sessionId: SESSION_ID, cause: "committed", commitId: COMMIT_ID, runId: RUN_ID },
      { sessionId: SESSION_ID, cause: "pushed", branch: "main" },
      { sessionId: SESSION_ID, cause: "pulled", branch: "main", commitId: COMMIT_ID },
      {
        sessionId: SESSION_ID,
        cause: "pull_request_opened",
        requestNumber: 482,
        requestUrl: "https://github.com/acme/app/pull/482",
      },
      { sessionId: SESSION_ID, cause: "review_posted", requestNumber: 12, verdict: "comment" },
    ];
    for (const payload of payloads) {
      expect(accepts(GitSettledPayloadSchema, payload)).toBe(true);
    }
  });

  it("gives a push no run, because the row names the act and not the actor", () => {
    expect(
      accepts(GitSettledPayloadSchema, {
        sessionId: SESSION_ID,
        cause: "pushed",
        branch: "main",
        runId: RUN_ID,
      }),
    ).toBe(false);
  });

  it("refuses a pull without its commit, a review under a reading, and a sixth act", () => {
    expect(
      accepts(GitSettledPayloadSchema, { sessionId: SESSION_ID, cause: "pulled", branch: "main" }),
    ).toBe(false);
    expect(
      accepts(GitSettledPayloadSchema, {
        sessionId: SESSION_ID,
        cause: "review_posted",
        requestNumber: 12,
        verdict: "approved",
      }),
    ).toBe(false);
    expect(accepts(GitSettledPayloadSchema, { sessionId: SESSION_ID, cause: "pr_prepared" })).toBe(
      false,
    );
  });
});
