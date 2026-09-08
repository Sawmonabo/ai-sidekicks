// The four positions, and the two absences the projection refuses to merge.
//
// Every case here is one way of collapsing a distinction the wire draws: a reply
// that said nothing about tools read as "the driver's default set", a chosen empty
// list read as an absence, or a populated list read as a name rather than a count.

import { describe, expect, it } from "vitest";

import type { AgentRosterEntry } from "../../bridge/index.js";
import { agentToolGrantPosition } from "./tool-grant.js";

const IDENTITY_ONLY: AgentRosterEntry = { agentId: "agent-scout", state: "ready" };

describe("agent tool grant — the four positions", () => {
  it("reads a reply with no resolved configuration as unanswered", () => {
    expect(agentToolGrantPosition(IDENTITY_ONLY)).toStrictEqual({ kind: "not-reported" });
  });

  it("reads a configuration with no allowlist member as the driver's default set", () => {
    expect(
      agentToolGrantPosition({
        ...IDENTITY_ONLY,
        resolvedConfiguration: { executionPostureMode: "worktree" },
      }),
    ).toStrictEqual({ kind: "driver-default" });
  });

  it("reads a present, empty allowlist as a chosen restriction", () => {
    expect(
      agentToolGrantPosition({ ...IDENTITY_ONLY, resolvedConfiguration: { toolAllowlist: [] } }),
    ).toStrictEqual({ kind: "no-tools" });
  });

  it("counts a populated allowlist and carries no names", () => {
    expect(
      agentToolGrantPosition({
        ...IDENTITY_ONLY,
        resolvedConfiguration: { toolAllowlist: ["read", "write", "search"] },
      }),
    ).toStrictEqual({ kind: "named", toolCount: 3 });
  });

  it("negative control: the two absences resolve to different positions", () => {
    // Without this, a projection that folded an unreported configuration into the
    // driver-default arm would pass both of the cases above that assert one each.
    const unreported = agentToolGrantPosition(IDENTITY_ONLY);
    const driverDefault = agentToolGrantPosition({
      ...IDENTITY_ONLY,
      resolvedConfiguration: {},
    });
    expect(unreported.kind).not.toBe(driverDefault.kind);
  });
});
