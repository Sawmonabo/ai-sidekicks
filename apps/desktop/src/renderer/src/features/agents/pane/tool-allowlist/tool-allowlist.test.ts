// An agent's tool allowlist: an unreported configuration, the driver's default set and an empty
// allowlist are three positions, never folded into one.

import { describe, expect, it } from "vitest";

import { agentEntry, resolvedConfiguration } from "#test/helpers/agent-list.js";
import { agentToolAllowlistPosition } from "./tool-allowlist.js";

const IDENTITY_ONLY = agentEntry();

describe("agent tool allowlist — the missing readings stay apart", () => {
  it("reads an agent with no resolved configuration as unanswered", () => {
    expect(agentToolAllowlistPosition(IDENTITY_ONLY)).toStrictEqual({ kind: "not-reported" });
  });

  it("reads a configuration whose allowlist is null as the provider's default set", () => {
    expect(
      agentToolAllowlistPosition({
        ...IDENTITY_ONLY,
        resolvedConfiguration: resolvedConfiguration({ toolAllowlist: null }),
      }),
    ).toStrictEqual({ kind: "driver-default" });
  });

  it("reads a present, empty allowlist as a chosen restriction", () => {
    expect(
      agentToolAllowlistPosition({
        ...IDENTITY_ONLY,
        resolvedConfiguration: resolvedConfiguration({ toolAllowlist: [] }),
      }),
    ).toStrictEqual({ kind: "no-tools" });
  });
});
