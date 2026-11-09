// The relay rule at the trust boundary: every absolute path a reply offers to open, read through
// the verb's own contract, comes back with one token the page can open it by, and a path that is
// not absolute comes back with none; a request's folder member crosses only as a token the page
// was given for a folder, swapped for its path.

import { SessionMemoryReadResponseSchema } from "@ai-sidekicks/contracts/session/inspector";
import { describe, expect, it } from "vitest";

import { mintTokensForPaths, swapTokensForPaths } from "./relay.js";
import { FilePathRefs } from "./refs.js";
import { pageOwner } from "./refs.test-support.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";

/** A memory read whose entries sit at `paths`, as the contract parses it. */
function memoryReadAt(paths: readonly string[]): unknown {
  return SessionMemoryReadResponseSchema.parse({
    sessionId: SESSION_ID,
    home: "/Users/person/.claude",
    autoMemory: { enabled: true },
    entries: paths.map((path) => ({ path, kind: "file" })),
  });
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
      "session.memoryRead",
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

    const first = mintTokensForPaths(refs, page, "session.memoryRead", memoryReadAt([memoryFile]));
    const again = mintTokensForPaths(refs, page, "session.memoryRead", memoryReadAt([memoryFile]));

    expect(again).toStrictEqual(first);
  });

  it("mints no token for a path that is not absolute, which a program could read as an option", () => {
    const refs = new FilePathRefs();
    const minted = mintTokensForPaths(
      refs,
      pageOwner(1),
      "session.memoryRead",
      memoryReadAt(["-a Terminal", "notes/CLAUDE.md", "/Users/person/CLAUDE.md"]),
    );

    expect(Object.keys(minted)).toStrictEqual(["/Users/person/CLAUDE.md"]);
  });
});

describe("a question card's answers", () => {
  it("cross with a path page's folder token swapped for its path and every other answer as sent", () => {
    const refs = new FilePathRefs();
    const page = pageOwner(1);
    const folder = "/Users/person/projects/app";
    const folderRef = refs.mint(page, "folder", folder);
    const answersWith = (path: string): unknown => ({
      questionId: SESSION_ID,
      answers: [
        // A token typed as text is an answer's words, not a path, and crosses as sent.
        { kind: "typed", text: folderRef },
        { kind: "path", path },
        { kind: "skipped" },
      ],
    });

    expect(swapTokensForPaths(refs, page, "question.resolve", answersWith(folderRef))).toEqual({
      questionId: SESSION_ID,
      answers: [
        { kind: "typed", text: folderRef },
        { kind: "path", path: folder },
        { kind: "skipped" },
      ],
    });
    // A raw path, and a token minted for another purpose, never reach the daemon.
    for (const unminted of [folder, refs.mint(page, "attach", folder)]) {
      expect(() =>
        swapTokensForPaths(refs, page, "question.resolve", answersWith(unminted)),
      ).toThrow(TypeError);
    }
  });
});
