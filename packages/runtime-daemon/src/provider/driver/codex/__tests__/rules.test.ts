// A project's Codex rule file: a rule replaces the opposite one over its subject, the file is kept
// out of git through the repository's own exclude list once, a revoke removes only its rule, and no
// prefix that would also let a force push or a branch delete through is ever written.

import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import { HOST_OPERATING_SYSTEM } from "../../../../../tests/helpers/host-operating-system.js";
import type { ProviderAskRule } from "../../../port/permission-ask.js";
import { removeCodexProjectRule, writeCodexProjectRule } from "../rules.js";

let projectFolder: string;

beforeEach(async () => {
  projectFolder = await mkdtemp(path.join(tmpdir(), "codex-rules-"));
  await mkdir(path.join(projectFolder, ".git", "info"), { recursive: true });
});

afterEach(async () => {
  await rm(projectFolder, { recursive: true, force: true });
});

const readGitFolder = async (folder: string): Promise<string> =>
  await Promise.resolve(path.join(folder, ".git"));

async function readRuleLines(): Promise<string[]> {
  const text = await readFile(
    path.join(projectFolder, ".codex", "rules", "sidekicks.rules"),
    "utf8",
  );
  return text.split("\n").filter((line) => line !== "");
}

it("replaces the opposite rule over a subject, excludes the file once, and revokes one rule", async () => {
  const npmTestAllow: ProviderAskRule = {
    kind: "project",
    sense: "allow",
    action: "command",
    subject: "npm test",
  };
  const hostBlock: ProviderAskRule = {
    kind: "project",
    sense: "block",
    action: "network",
    subject: "example.com",
  };

  await writeCodexProjectRule(
    projectFolder,
    npmTestAllow,
    readGitFolder,
    HOST_OPERATING_SYSTEM.diskFlush,
  );
  await writeCodexProjectRule(
    projectFolder,
    { ...hostBlock, sense: "allow" },
    readGitFolder,
    HOST_OPERATING_SYSTEM.diskFlush,
  );
  await writeCodexProjectRule(
    projectFolder,
    hostBlock,
    readGitFolder,
    HOST_OPERATING_SYSTEM.diskFlush,
  );

  expect(await readRuleLines()).toStrictEqual([
    'prefix_rule(pattern=["npm", "test"], decision="allow")',
    'network_rule(host="example.com", protocol="https", decision="deny")',
    'network_rule(host="example.com", protocol="http", decision="deny")',
  ]);
  expect(await readFile(path.join(projectFolder, ".git", "info", "exclude"), "utf8")).toBe(
    "/.codex/rules/sidekicks.rules\n",
  );

  await removeCodexProjectRule(projectFolder, npmTestAllow, HOST_OPERATING_SYSTEM.diskFlush);

  expect(await readRuleLines()).toHaveLength(2);
});

it.each(["git", "git push", "git branch"])(
  "writes no allow on `%s`, whose prefix would let a force push through",
  async (subject) => {
    await writeCodexProjectRule(
      projectFolder,
      { kind: "project", sense: "allow", action: "command", subject },
      readGitFolder,
      HOST_OPERATING_SYSTEM.diskFlush,
    );

    await expect(access(path.join(projectFolder, ".codex"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
