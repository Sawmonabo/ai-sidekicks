// Main's part in the page's daemon wire. A window's file tokens are put back as their paths for the
// helper, and a raw path or a token minted for another purpose is refused; a served reply's paths
// get tokens the window opens by, and a pasted picture the service copied is removed. The status
// topic speaks with no service linked, the current state first, and ends with the page.

import { randomUUID } from "node:crypto";

import { SESSION_DRAFT_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/draft";
import { SESSION_INSPECTOR_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/inspector";
import { WORKFLOW_STEP_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/workflow/run/step/methods";
import { describe, expect, it, vi } from "vitest";

import type { MainProcessState } from "#shared/daemon/status-topic.js";
import { DaemonLink, unlinkedState } from "../services/daemon/link/status.js";
import { answerFilePathAsk, MainTopics, type DaemonSubscriber } from "./daemon.js";
import { FilePathRefs } from "./file-path/refs.js";
import { pageOwner } from "./file-path/refs.test-support.js";

const SUBMIT = WORKFLOW_STEP_METHOD_DESCRIPTORS["workflow.humanForm.submit"].method;
const ATTACH = SESSION_DRAFT_METHOD_DESCRIPTORS["session.attachment.add"].method;
const MEMORY_READ = SESSION_INSPECTOR_METHOD_DESCRIPTORS["session.memory.read"].method;

/** The window a call comes from. */
const WINDOW = pageOwner(1);

/** A human form's submit carrying `path` as its picked folder, and a token in a text answer. */
function submitWith(path: string, note: string): unknown {
  return {
    workflowRunId: "00000000-0000-4000-8000-000000000002",
    nodeId: "review",
    attempt: 1,
    executionIndex: 1,
    // A token in `fields` is an answer's text, not a path, and crosses as sent.
    fields: { note },
    paths: [{ field: "where", path }],
    expectedRevision: 1,
  };
}

/** A page main can be told has navigated to a new document, or gone, with what it was sent. */
function pageThatCanGo(): DaemonSubscriber & {
  readonly navigate: () => void;
  readonly destroy: () => void;
} {
  const owner = pageOwner(2);
  return { ...owner, send: vi.fn() };
}

describe("a window's file tokens", () => {
  it("puts a picked folder's token back as its path, and refuses a raw path or another purpose's token", () => {
    const filePathRefs = new FilePathRefs();
    const services = { filePathRefs, pastedImages: { removeCopied: vi.fn() } };
    const folder = "/Users/person/projects/app";
    const folderRef = filePathRefs.mint(WINDOW, "folder", folder);

    expect(
      answerFilePathAsk(services, WINDOW, {
        kind: "filePaths.swap",
        askId: 4,
        windowId: WINDOW.id,
        method: SUBMIT,
        params: submitWith(folderRef, folderRef),
      }),
    ).toStrictEqual({
      kind: "filePaths.swapped",
      askId: 4,
      params: submitWith(folder, folderRef),
      readsReply: false,
    });

    const attachRef = filePathRefs.mint(WINDOW, "attach", folder);
    for (const unminted of [folder, attachRef]) {
      expect(() =>
        answerFilePathAsk(services, WINDOW, {
          kind: "filePaths.swap",
          askId: 5,
          windowId: WINDOW.id,
          method: SUBMIT,
          params: submitWith(unminted, ""),
        }),
      ).toThrow(TypeError);
    }
  });

  it("mints a token for each path a reply offers, and removes the pasted pictures the service copied", () => {
    const filePathRefs = new FilePathRefs();
    const removeCopied = vi.fn();
    const services = { filePathRefs, pastedImages: { removeCopied } };
    const memoryFile = "/Users/person/.claude/projects/app/CLAUDE.md";

    const minted = answerFilePathAsk(services, WINDOW, {
      kind: "filePaths.mint",
      askId: 6,
      windowId: WINDOW.id,
      method: MEMORY_READ,
      params: { sessionId: "00000000-0000-4000-8000-000000000001" },
      value: {
        entries: [
          { path: memoryFile, kind: "file" },
          { path: "relative.md", kind: "file" },
        ],
      },
    });
    if (minted.kind !== "filePaths.minted") {
      throw new Error("expected tokens");
    }
    // Only the absolute path is offered to open, and its token stands for it.
    expect(Object.keys(minted.fileRefs)).toStrictEqual([memoryFile]);
    expect(filePathRefs.requirePath(WINDOW, minted.fileRefs[memoryFile], "open")).toBe(memoryFile);

    const refusedStagingId = randomUUID();
    answerFilePathAsk(services, WINDOW, {
      kind: "filePaths.mint",
      askId: 7,
      windowId: WINDOW.id,
      method: ATTACH,
      params: {
        items: [
          { kind: "file", clientStagingId: randomUUID(), path: "/pasted/one.png" },
          { kind: "file", clientStagingId: refusedStagingId, path: "/pasted/two.png" },
        ],
      },
      value: { refused: [{ clientStagingId: refusedStagingId }] },
    });
    expect(removeCopied).toHaveBeenLastCalledWith(WINDOW, ["/pasted/one.png"]);
  });
});

describe("main's topics", () => {
  it("delivers the link's state from before any service answers, the current one first, until the page goes", () => {
    const link = new DaemonLink();
    const log = { write: vi.fn() };
    const topics = new MainTopics({ link, topics: {}, log });
    const page = pageThatCanGo();
    const subscriptionId = randomUUID();

    expect(topics.open(page, { subscriptionId, event: "daemon.status", params: {} })).toStrictEqual(
      { outcome: "opened" },
    );
    link.report(unlinkedState({ kind: "starting" }));
    page.destroy();
    link.report(unlinkedState({ kind: "stopped" }));

    const delivered = vi
      .mocked(page.send)
      .mock.calls.map(([, , state]) => (state as MainProcessState).connection.kind);
    expect(delivered).toStrictEqual(["connecting", "starting"]);
  });

  it("refuses a topic it does not serve and a status topic opened with a request, opening nothing", () => {
    const link = new DaemonLink();
    const opener = vi.fn();
    const topics = new MainTopics({
      link,
      topics: { "machine.feed": opener },
      log: { write: vi.fn() },
    });
    const page = pageThatCanGo();

    for (const request of [
      { subscriptionId: randomUUID(), event: "daemon.stop", params: {} },
      { subscriptionId: randomUUID(), event: "daemon.status", params: { sessionId: "s" } },
      { subscriptionId: 7, event: "daemon.status", params: {} },
    ]) {
      expect(topics.open(page, request), JSON.stringify(request)).toStrictEqual({
        outcome: "unsendable",
      });
    }
    expect(page.send).not.toHaveBeenCalled();
    expect(opener).not.toHaveBeenCalled();
  });

  it("tells the page how a held topic ended, closes the rest when it navigates, and says nothing after", () => {
    const ends: ((end: { readonly reason: "completed" }) => void)[] = [];
    const close = vi.fn();
    const topics = new MainTopics({
      link: new DaemonLink(),
      topics: {
        feed: (_params, _deliver, onEnded) => {
          ends.push(onEnded);
          return { outcome: "opened", close };
        },
      },
      log: { write: vi.fn() },
    });
    const page = pageThatCanGo();
    const [ended, held] = [randomUUID(), randomUUID()];
    topics.open(page, { subscriptionId: ended, event: "feed", params: {} });
    topics.open(page, { subscriptionId: held, event: "feed", params: {} });

    ends[0]?.({ reason: "completed" });
    page.navigate();
    ends[1]?.({ reason: "completed" });

    expect(vi.mocked(page.send).mock.calls).toStrictEqual([
      ["daemon.subscriptionEnd", ended, { reason: "completed" }],
    ]);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
