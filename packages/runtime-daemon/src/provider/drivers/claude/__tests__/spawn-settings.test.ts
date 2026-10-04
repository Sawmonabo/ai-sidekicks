// `spawn-settings.ts`: the sandbox settings every sandboxed spawn is realized with.

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider-driver";
import { describe, expect, it } from "vitest";

import { composeClaudeSandboxSettings } from "../spawn-settings.js";

const SANDBOXED_POSTURE: ExecutionPosture = {
  mode: "sandboxed",
  credentialPolicyRef: "policy://default",
  writableRoots: ["/workspace"],
};

describe("composeClaudeSandboxSettings", () => {
  it("realizes every sandboxed level fail-closed and writes nowhere at readonly", () => {
    const readonlyPosture: ExecutionPosture = { ...SANDBOXED_POSTURE, mode: "readonly" };
    for (const posture of [SANDBOXED_POSTURE, readonlyPosture]) {
      const settings = composeClaudeSandboxSettings(posture);
      // No tool call may run outside the sandbox, and a host whose sandbox cannot start must
      // refuse rather than run unsandboxed under a recorded sandboxed posture.
      expect(settings.sandbox.enabled).toBe(true);
      expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
      expect(settings.sandbox.failIfUnavailable).toBe(true);
    }
    // An omitted list requests the provider's default, which is not "writes nowhere".
    expect(
      composeClaudeSandboxSettings(readonlyPosture).sandbox.filesystem.allowWrite,
    ).toStrictEqual([]);
  });
});
