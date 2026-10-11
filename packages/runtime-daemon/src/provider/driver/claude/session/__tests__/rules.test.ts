// The rules Claude Code is handed: a command allow becomes the command alone and with arguments
// after it, and none whose prefix would also let a force push or a branch delete through, in the
// session's lists or as a project allow its answer carries.

import { expect, it } from "vitest";

import type { ProviderAskRule } from "../../../../port/permission-ask.js";
import { composeClaudeProjectAllowUpdate, composeClaudeSessionRuleLists } from "../rules.js";

function commandAllow(subject: string): ProviderAskRule {
  return { kind: "session", sense: "allow", action: "command", subject };
}

it("hands over no allow whose prefix would let a force push or a branch delete through", () => {
  const destructive = ["git", "git push", "git branch"].map(commandAllow);

  expect(
    composeClaudeSessionRuleLists([...destructive, commandAllow("git status")]).allow,
  ).toStrictEqual(["Bash(git status)", "Bash(git status *)"]);
  expect(destructive.map(composeClaudeProjectAllowUpdate)).toStrictEqual([
    undefined,
    undefined,
    undefined,
  ]);
});
