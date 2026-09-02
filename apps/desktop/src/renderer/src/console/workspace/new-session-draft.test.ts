// The new-session draft, and the honest ending of a send it cannot finish.
//
// §4.8 asks for a draft that is local until it is sent, and for a send that names
// the calls that succeeded. Two of the three calls that send needs are registered
// nowhere in the contracts package, so the interesting case is not the happy path:
// it is that a send which creates a session and then cannot attach anything says
// so, names `session.create` as done, and leaves the draft on screen.

import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "../bridge/index.js";
import type { ConsoleScenario } from "../bridge/scenario.js";
import { NewSessionDraft } from "./new-session-draft.js";

const CREATED_SESSION_ID = "session-created-1";

function scenario(options: { readonly scriptsCreate: boolean }): ConsoleScenario {
  return {
    id: "draft-send",
    label: "Draft send",
    purpose: "Drives the new-session draft's one reachable wire call.",
    sessionId: "session-draft",
    participantIdsInJoinOrder: ["participant-you"],
    startedAtIso: "2026-01-01T09:00:00.000Z",
    beats: [],
    replies: options.scriptsCreate
      ? [{ call: "session.create", result: { sessionId: CREATED_SESSION_ID } }]
      : [],
  };
}

function draftFor(options: { readonly scriptsCreate: boolean }): NewSessionDraft {
  return new NewSessionDraft({ bridge: createFixtureBridge({ scenario: scenario(options) }) });
}

describe("NewSessionDraft — what it holds", () => {
  it("starts empty and says so", () => {
    const draft = draftFor({ scriptsCreate: true });
    expect(draft.snapshot().isEmpty).toBe(true);
  });

  it("replaces a second selection of the same definition rather than adding it twice", () => {
    const draft = draftFor({ scriptsCreate: true });
    draft.selectAgent({ definitionId: "definition-1", providerAccountId: undefined });
    draft.selectAgent({ definitionId: "definition-1", providerAccountId: "account-9" });
    expect(draft.snapshot().agents).toStrictEqual([
      { definitionId: "definition-1", providerAccountId: "account-9" },
    ]);
  });

  it("ignores a paying account for an agent that was never selected", () => {
    const draft = draftFor({ scriptsCreate: true });
    draft.setPayingAccount("definition-unknown", "account-9");
    expect(draft.snapshot().agents).toStrictEqual([]);
    expect(draft.snapshot().isEmpty).toBe(true);
  });

  it("becomes non-empty on any one axis, and empty again when discarded", () => {
    const draft = draftFor({ scriptsCreate: true });
    draft.setPosture("workspace-sandboxed");
    expect(draft.snapshot().isEmpty).toBe(false);
    draft.discard();
    expect(draft.snapshot().isEmpty).toBe(true);
  });

  it("publishes each mutation to its subscribers", () => {
    const draft = draftFor({ scriptsCreate: true });
    const revisions: number[] = [];
    const unsubscribe = draft.subscribe((state) => {
      revisions.push(state.revision);
    });
    draft.setRepoMount({ repoId: "repo-1", executionMode: "worktree" });
    draft.setPosture("trusted");
    unsubscribe();
    expect(revisions).toStrictEqual([1, 2]);
  });
});

describe("NewSessionDraft — the send", () => {
  it("refuses an empty draft without touching the wire", async () => {
    const result = await draftFor({ scriptsCreate: true }).send();
    expect(result.outcome).toBe("refused");
    expect(result.refusal?.code).toBe("draft-empty");
    expect(result.completedCalls).toStrictEqual([]);
  });

  it("creates the session, then says which calls it could not make", async () => {
    const draft = draftFor({ scriptsCreate: true });
    draft.selectAgent({ definitionId: "definition-1", providerAccountId: undefined });
    const result = await draft.send();

    expect(result.outcome).toBe("partial");
    expect(result.sessionId).toBe(CREATED_SESSION_ID);
    // §4.8: the error slot names the calls that SUCCEEDED, because a person
    // deciding whether to retry needs to know a session already exists.
    expect(result.completedCalls).toStrictEqual(["session.create"]);
    expect(result.refusal?.code).toBe("wire-unregistered");
    expect(result.refusal?.detail).toContain("agent.attach");
    expect(result.refusal?.detail).toContain("run.queueCreate");
  });

  it("keeps the draft when the create itself fails, and names no completed call", async () => {
    const draft = draftFor({ scriptsCreate: false });
    draft.setPosture("readonly-sandboxed");
    const result = await draft.send();

    expect(result.outcome).toBe("refused");
    expect(result.sessionId).toBeUndefined();
    expect(result.completedCalls).toStrictEqual([]);
    expect(result.refusal?.code).toBe("session-create-failed");
    // The draft survives a failed send: a person's choices are not thrown away
    // because a wire was down.
    expect(draft.snapshot().isEmpty).toBe(false);
  });

  it("negative control: the daemon's own message never reaches the person", async () => {
    // Without this, the case above would pass over a refusal that pasted an IPC
    // stack into console copy.
    const draft = draftFor({ scriptsCreate: false });
    draft.setPosture("trusted");
    const result = await draft.send();
    expect(result.refusal?.detail).not.toContain("scenario");
    expect(result.refusal?.detail).not.toContain("reply-unscripted");
  });
});
