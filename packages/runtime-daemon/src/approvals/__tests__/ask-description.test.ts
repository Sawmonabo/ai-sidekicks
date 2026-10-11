// A provider ask's card: the subject a standing rule on it names, no standing allow on a git push
// or branch delete that destroys work, and a target the wire's bound keeps whole.

import { describe, expect, it } from "vitest";

import { FILE_PATH_MAX_LEN } from "@ai-sidekicks/contracts/free-form-string";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { ProviderAskAction } from "../../provider/port/permission-ask.js";
import { deriveRuleSubject, describeProviderAsk } from "../ask-description.js";

function describeCommand(command: string): ReturnType<typeof describeProviderAsk> {
  return describeProviderAsk({
    sessionId: "session-1" as SessionId,
    runId: "run-1" as RunId,
    requestId: "ask-1",
    toolName: "Bash",
    input: { command },
    action: { kind: "command", command },
    ruleScopes: ["session", "project"],
  });
}

describe("deriveRuleSubject", () => {
  it.each<[ProviderAskAction, string | undefined]>([
    [{ kind: "command", command: "npm run build --watch" }, "npm run"],
    [{ kind: "command", command: "FOO=1 git push origin main" }, "git push"],
    // A path or an option after the program is no subcommand, so the program stands alone.
    [{ kind: "command", command: "ls ./src" }, "ls"],
    [{ kind: "command", command: "rm -rf build" }, "rm"],
    // A rule over a line of several commands, or a string a shell runs, would cover commands the
    // card never named.
    [{ kind: "command", command: "cd app && rm -rf ~" }, undefined],
    [{ kind: "command", command: "echo $(rm -rf ~)" }, undefined],
    [{ kind: "command", command: "bash -lc 'npm test'" }, undefined],
    [{ kind: "command", command: "eval npm test" }, undefined],
    // A line the parser cannot read whole names no subject.
    [{ kind: "command", command: "npm test 'unclosed" }, undefined],
    [{ kind: "file_change", paths: ["src/a.ts"] }, "src/a.ts"],
    [{ kind: "file_change", paths: ["src/a.ts", "src/b.ts"] }, undefined],
    [{ kind: "network", host: "registry.npmjs.org" }, "registry.npmjs.org"],
    [{ kind: "command_input", input: "y\n" }, undefined],
    [{ kind: "plan" }, undefined],
  ])("names the subject of %j", (action, subject) => {
    expect(deriveRuleSubject(action)).toBe(subject);
  });
});

describe("describeProviderAsk", () => {
  it.each([
    "git push --force origin main",
    "git push -uf origin main",
    "git push --force-with-lease=main origin main",
    "git push origin --delete feature",
    "git push origin +main",
    "git push origin :feature",
    "git -C repo push --mirror",
    "git branch -D feature",
    "git branch --delete feature",
    "bash -lc 'git push -f'",
    "eval 'sh -c \"git branch -D x\"'",
    "cd repo && git push --force",
  ])("offers no standing allow on the destructive %s", (command) => {
    const { category, resourceDescriptor } = describeCommand(command);

    expect(category).toBe("destructive_git");
    expect(resourceDescriptor).toMatchObject({
      standingAllowOffered: false,
      projectScopeOffered: false,
    });
  });

  it.each([
    ["git push origin main", "git push"],
    ["git branch feature", "git branch"],
    ["git push origin main:main", "git push"],
  ])("offers a standing allow on the ordinary %s", (command, subject) => {
    const { category, resourceDescriptor } = describeCommand(command);

    expect(category).toBe("tool_execution");
    expect(resourceDescriptor).toMatchObject({
      subject,
      standingAllowOffered: true,
      projectScopeOffered: true,
    });
  });

  it("offers no project rule where the provider keeps none for the ask", () => {
    const description = describeProviderAsk({
      sessionId: "session-1" as SessionId,
      runId: "run-1" as RunId,
      requestId: "ask-1",
      toolName: "Read",
      input: {},
      action: { kind: "file_read", path: "/etc/hosts" },
      ruleScopes: ["session"],
    });

    expect(description.resourceDescriptor).toMatchObject({
      subject: "/etc/hosts",
      standingAllowOffered: true,
      projectScopeOffered: false,
      editable: true,
    });
  });

  it("offers no standing allow, and no edit, on a change to several files", () => {
    const description = describeProviderAsk({
      sessionId: "session-1" as SessionId,
      runId: "run-1" as RunId,
      requestId: "ask-1",
      toolName: "apply_patch",
      input: {},
      action: { kind: "file_change", paths: ["a.ts", "b.ts"] },
      ruleScopes: ["session", "project"],
    });

    expect(description).toMatchObject({
      category: "file_write",
      scope: "a.ts\nb.ts",
      resourceDescriptor: { standingAllowOffered: false, editable: false },
    });
  });

  it("cuts a long target on a whole character, and offers no rule on a subject it cut", () => {
    // Each emoji is two UTF-16 units, so an odd bound would split one in half.
    const program = "🙂".repeat(FILE_PATH_MAX_LEN);
    const { scope, resourceDescriptor } = describeCommand(`${program}\0 --flag`);

    expect(scope).toBe("🙂".repeat(FILE_PATH_MAX_LEN / 2));
    expect(scope.includes("\0")).toBe(false);
    expect(resourceDescriptor.standingAllowOffered).toBe(false);
  });
});
