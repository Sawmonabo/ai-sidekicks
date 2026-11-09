// The relay rule at the trust boundary, checked against the verb's own contract: every absolute
// path a reply offers to open comes back with one token the page can open it by, and a path that
// is not absolute comes back with none.

import {
  SESSION_INSPECTOR_METHOD_DESCRIPTORS,
  validateSessionMemoryReadResponse,
} from "@ai-sidekicks/contracts/session/inspector";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import { describe, expect, it } from "vitest";

import { mintTokensForPaths } from "./relay.js";
import { FilePathRefs } from "./refs.js";
import { pageOwner } from "./refs.test-support.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000001" as SessionId;

const MEMORY_READ = SESSION_INSPECTOR_METHOD_DESCRIPTORS["session.memory.read"].method;

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
