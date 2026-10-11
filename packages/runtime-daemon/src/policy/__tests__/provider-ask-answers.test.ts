// The daemon refuses an agent's background Claude Code commands and allows an agent's `.md` notes
// in the agent-memory folder, by their own path or through a configuration home's link; every other
// ask gets no answer of the daemon's and goes to the person.

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HOST_OPERATING_SYSTEM } from "../../../tests/helpers/host-operating-system.js";
import { answerProviderAsk } from "../provider-ask-answers.js";

let scratch: string;
let memoryFolder: string;
// A configuration home's `agent-memory` link to the memory folder.
let memoryLink: string;
let outsideFolder: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "provider-ask-answers-"));
  memoryFolder = path.join(scratch, "data", "agent-memory");
  memoryLink = path.join(scratch, "claude-home", "agent-memory");
  outsideFolder = path.join(scratch, "project");
  await mkdir(path.join(memoryFolder, "reviewer"), { recursive: true });
  await mkdir(path.dirname(memoryLink), { recursive: true });
  await mkdir(outsideFolder);
  await symlink(memoryFolder, memoryLink);
  await writeFile(path.join(memoryFolder, "reviewer", "MEMORY.md"), "# Notes\n");
  await writeFile(path.join(outsideFolder, "README.md"), "# Project\n");
  // Links inside the memory folder that lead out of it.
  await symlink(
    path.join(outsideFolder, "README.md"),
    path.join(memoryFolder, "reviewer", "escape.md"),
  );
  await symlink(outsideFolder, path.join(memoryFolder, "outside"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("answerProviderAsk", () => {
  it.each([
    "claude agents",
    "claude daemon start",
    'claude --bg "fix the tests"',
    "claude -p --bg=1 hello",
    "cd /repo && /usr/local/bin/claude daemon",
    "FOO=1 nohup claude agents &",
    "git status; claude --bg review",
    "echo $(claude daemon status)",
    // Options before the subcommand, a value-taking one among them.
    "claude --verbose daemon",
    "claude --model opus agents",
    // Substitutions the parser reaches: inside double quotes, in an assignment, in a here-document.
    'echo "$(claude daemon)"',
    'echo "`claude agents`"',
    "X=$(claude daemon) true",
    "cat <<END\n$(claude daemon)\nEND",
    // The backgrounding flag's other name.
    'claude --background "fix the tests"',
    // The string a shell's `-c`, alone or in a cluster, or `eval` runs.
    'sh -c "claude daemon"',
    "bash -lc 'claude --bg x'",
    'eval "claude agents"',
    // One inside another.
    "bash -c \"eval 'claude daemon'\"",
  ])("refuses `%s`", async (command) => {
    expect(
      await answerProviderAsk(
        { kind: "command", command },
        memoryFolder,
        HOST_OPERATING_SYSTEM.pathRules,
      ),
    ).toEqual({
      decision: "deny",
      reason: expect.stringContaining("claude --bg"),
    });
  });

  it.each([
    "claude",
    "claude -p 'list the agents'",
    "claude mcp list",
    'git commit -m "refuse claude --bg inside a session"',
    "echo claude daemon",
    'echo "claude daemon"',
    // A prompt word ends the options, so a later word is no subcommand.
    'claude "fix" daemon',
    "rm -rf build",
    // A shell's string is read as a line, and one the parser cannot read is never guessed at.
    'sh -c "echo claude daemon"',
    "sh -c 'claude daemon $('",
    // A substitution's body reports its own parse errors, apart from the line's.
    `sh -c 'claude daemon; echo "$(if then)"'`,
  ])("leaves `%s` to the person", async (command) => {
    expect(
      await answerProviderAsk(
        { kind: "command", command },
        memoryFolder,
        HOST_OPERATING_SYSTEM.pathRules,
      ),
    ).toBeUndefined();
  });

  it("allows a note in the memory folder by its own path, through the link and as a new file", async () => {
    for (const filePath of [
      path.join(memoryFolder, "reviewer", "MEMORY.md"),
      path.join(memoryLink, "reviewer", "MEMORY.md"),
      path.join(memoryLink, "new-agent", "MEMORY.md"),
    ]) {
      expect(
        await answerProviderAsk(
          { kind: "file_change", paths: [filePath] },
          memoryFolder,
          HOST_OPERATING_SYSTEM.pathRules,
        ),
      ).toEqual({
        decision: "allow",
      });
    }
  });

  it("leaves every other file to the person", async () => {
    await writeFile(path.join(memoryFolder, "reviewer", "notes.txt"), "plain\n");
    for (const filePath of [
      path.join(memoryFolder, "reviewer", "notes.txt"),
      path.join(outsideFolder, "README.md"),
      path.join(memoryFolder, "reviewer", "escape.md"),
      path.join(memoryFolder, "outside", "README.md"),
      // Not joined with `path.join`, which would fold the `..` away.
      [memoryFolder, "outside", "..", "reviewer", "MEMORY.md"].join(path.sep),
      path.join(scratch, "data", "agent-memory-old", "MEMORY.md"),
      "reviewer/MEMORY.md",
    ]) {
      expect(
        await answerProviderAsk(
          { kind: "file_change", paths: [filePath] },
          memoryFolder,
          HOST_OPERATING_SYSTEM.pathRules,
        ),
      ).toBeUndefined();
    }
    // A change that touches a note and a project file at once.
    const mixedChange = {
      kind: "file_change",
      paths: [
        path.join(memoryFolder, "reviewer", "MEMORY.md"),
        path.join(outsideFolder, "README.md"),
      ],
    } as const;
    expect(
      await answerProviderAsk(mixedChange, memoryFolder, HOST_OPERATING_SYSTEM.pathRules),
    ).toBeUndefined();
  });
});
