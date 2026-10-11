// A project's Codex rule file: a rule replaces the opposite one over its subject, the file is kept
// out of git through the repository's own exclude list once, and a revoke removes only its rule.

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

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

  await writeCodexProjectRule(projectFolder, npmTestAllow, readGitFolder);
  await writeCodexProjectRule(projectFolder, { ...hostBlock, sense: "allow" }, readGitFolder);
  await writeCodexProjectRule(projectFolder, hostBlock, readGitFolder);

  expect(await readRuleLines()).toStrictEqual([
    'prefix_rule(pattern=["npm", "test"], decision="allow")',
    'network_rule(host="example.com", protocol="https", decision="deny")',
    'network_rule(host="example.com", protocol="http", decision="deny")',
  ]);
  expect(await readFile(path.join(projectFolder, ".git", "info", "exclude"), "utf8")).toBe(
    "/.codex/rules/sidekicks.rules\n",
  );

  await removeCodexProjectRule(projectFolder, npmTestAllow);

  expect(await readRuleLines()).toHaveLength(2);
});
