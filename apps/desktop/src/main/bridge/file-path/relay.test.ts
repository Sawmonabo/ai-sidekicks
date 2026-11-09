// The relay rule at the trust boundary, checked against the verb's own contract: every absolute
// path a reply or a session event offers to open comes back with one token the page can open it
// by, a path that is not absolute comes back with none, and a folder the page attaches reaches the
// daemon only as the path its picked token stands for.

import {
  SESSION_INSPECTOR_METHOD_DESCRIPTORS,
  validateSessionMemoryReadResponse,
} from "@ai-sidekicks/contracts/session/inspector";
import { REPO_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/repo/methods";
import { SESSION_DIRECTORY_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/directory";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { validateSessionStreamFrame } from "@ai-sidekicks/contracts/session/methods";
import { describe, expect, it } from "vitest";

import { mayOfferPathsToOpen, mintTokensForPaths, swapTokensForPaths } from "./relay.js";
import { FilePathRefs } from "./refs.js";
import { pageOwner } from "./refs.test-support.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000001" as SessionId;

const MEMORY_READ = SESSION_INSPECTOR_METHOD_DESCRIPTORS["session.memory.read"].method;

const EVENT_SUBSCRIBE = SESSION_DIRECTORY_METHOD_DESCRIPTORS["session.event.subscribe"].method;

const REPO_MOUNT_ATTACH = REPO_METHOD_DESCRIPTORS["repoMount.attach"].method;

/** A memory read whose entries sit at `paths`, as the contract checks it. */
function memoryReadAt(paths: readonly string[]): unknown {
  const reply = {
    sessionId: SESSION_ID,
    home: "/Users/person/.claude",
    homeScope: "account",
    autoMemory: { enabled: true },
    entries: paths.map((path) => ({ path, kind: "file" as const })),
    listedAtNextStart: false,
  };
  expect(validateSessionMemoryReadResponse(reply)).toBe(true);
  return reply;
}

describe("a reply that offers a path to open", () => {
  it("comes back with a token for each path, which opens that path for that page", () => {
    const refs = new FilePathRefs();
    const page = pageOwner(1);
    const memoryFile = "/Users/person/.claude/projects/app/CLAUDE.md";
    const memoryFolder = "/Users/person/.claude/projects/app/memory";

    const minted = mintTokensForPaths(
      refs,
      page,
      MEMORY_READ,
      memoryReadAt([memoryFile, memoryFolder]),
    );

    expect(
      Object.fromEntries(
        Object.entries(minted).map(([path, token]) => [
          path,
          refs.requirePath(page, token, "open"),
        ]),
      ),
    ).toEqual({ [memoryFile]: memoryFile, [memoryFolder]: memoryFolder });
  });

  it("answers the same token for a path read again, so a refresh grows nothing", () => {
    const refs = new FilePathRefs();
    const page = pageOwner(1);
    const memoryFile = "/Users/person/.claude/CLAUDE.md";

    const first = mintTokensForPaths(refs, page, MEMORY_READ, memoryReadAt([memoryFile]));
    const again = mintTokensForPaths(refs, page, MEMORY_READ, memoryReadAt([memoryFile]));

    expect(again).toStrictEqual(first);
  });

  it("mints no token for a path that is not absolute, which a program could read as an option", () => {
    const refs = new FilePathRefs();
    const minted = mintTokensForPaths(
      refs,
      pageOwner(1),
      MEMORY_READ,
      memoryReadAt(["-a Terminal", "notes/CLAUDE.md", "/Users/person/CLAUDE.md"]),
    );

    expect(Object.keys(minted)).toStrictEqual(["/Users/person/CLAUDE.md"]);
  });
});

/** One change of a session's event stream carrying an event of `type` with `payload`. */
function streamChange(
  sequence: number,
  category: string,
  type: string,
  payload: Record<string, unknown>,
): unknown {
  return {
    cursor: String(sequence),
    event: {
      id: `event-${String(sequence)}`,
      sessionId: SESSION_ID,
      sequence,
      occurredAt: "2026-01-01T09:00:00Z",
      category,
      type,
      payload: { sessionId: SESSION_ID, ...payload },
      version: "1.0",
    },
  };
}

/** The notice event a provider's ignored settings file arrives in, and its category. */
const NOTICE = "session.notice.posted";
const NOTICE_CATEGORY = "sessionLifecycle";

describe("a folder attached as a project", () => {
  it("reaches the daemon by the picked folder's path, and never by a path the page wrote", () => {
    const refs = new FilePathRefs();
    const page = pageOwner(1);
    const folder = "/Users/person/work/app";
    const picked = refs.mint(page, "folder", folder);

    expect(swapTokensForPaths(refs, page, REPO_MOUNT_ATTACH, { localPath: picked })).toStrictEqual({
      localPath: folder,
    });
    expect(() =>
      swapTokensForPaths(refs, page, REPO_MOUNT_ATTACH, { localPath: "/Users/person/secrets" }),
    ).toThrow(TypeError);
    // A token minted to open a file is no folder picked to attach.
    const opened = refs.mint(page, "open", folder);
    expect(() => swapTokensForPaths(refs, page, REPO_MOUNT_ATTACH, { localPath: opened })).toThrow(
      TypeError,
    );
  });
});

describe("a session event that offers a path to open", () => {
  it("comes back with a token for the file a provider ignored, and for no other member", () => {
    const refs = new FilePathRefs();
    const page = pageOwner(1);
    const ignoredFile = "/Users/person/project/.claude/settings.json";
    const notice = { kind: "settingsIgnored", provider: "claude" };
    const frame = {
      kind: "changes",
      changes: [
        streamChange(1, NOTICE_CATEGORY, NOTICE, { ...notice, file: ignoredFile, line: 3 }),
        streamChange(2, NOTICE_CATEGORY, NOTICE, { ...notice, file: "settings.json", key: "x" }),
        // An event the relay names no path in, carrying a member of the same name.
        streamChange(3, "agentOutput", "agent.message.sent", { file: "/Users/person/notes.md" }),
      ],
    };
    expect(validateSessionStreamFrame(frame)).toBe(true);
    expect(mayOfferPathsToOpen(EVENT_SUBSCRIBE, JSON.stringify(frame))).toBe(true);

    const minted = mintTokensForPaths(refs, page, EVENT_SUBSCRIBE, frame);

    expect(Object.keys(minted)).toStrictEqual([ignoredFile]);
    expect(refs.requirePath(page, minted[ignoredFile], "open")).toBe(ignoredFile);
  });
});
