// What a governance press on this deck answers: the binding the request named, and
// never a neighbour.
//
// THE DEFECT THESE CASES EXIST AGAINST. Both mutations answered a constant, so an
// enablement press on the issue tracker or the scratchpad came back carrying the
// filesystem row, and a trust press on anything but the issue tracker came back
// carrying that one. The shell renders the outcome under the row whose control was
// pressed while the fixture's inventory ledger substitutes the row the ANSWER names, so
// one press appeared to move two different servers and neither surface was wrong about
// the value it had been handed.
//
// EVERY CASE READS THE REPLY THE WAY THE FIXTURE DOES — whichever arm the entry carries
// — so a reply that goes back to answering a constant fails here on the assertion
// rather than on a missing member.
//
// THE REFUSALS ARE ANSWERS TOO. A computed reply holds a refusal by THROWING the wire's
// own envelope, because the reply table is keyed by method and a second entry for one
// call is unreachable — so a case that expects one reads what was thrown rather than
// what was returned.

import { describe, expect, it } from "vitest";

import { mcpBindingKeyOf } from "../../growth-values/index.js";
import type { GrowthMcpBindingRef, GrowthMcpInventoryEntry } from "../../growth-values/index.js";
import { SETTINGS_MCP_INVENTORY } from "./mcp-plane.js";
import { settingsMcpAnswerFor, settingsMcpMutationResult } from "./mcp-plane.test-support.js";

/**
 * The three bindings this suite presses, as a REQUEST names them.
 *
 * Written out rather than derived from the inventory row, because a request carries the
 * scope-qualified identity and nothing else — and the first case pins each of them to
 * the scenario's own row, so a scenario that re-scopes a binding fails there rather
 * than in a case whose message would be about an outcome.
 */
const FILESYSTEM_BINDING: GrowthMcpBindingRef = {
  provider: "claude",
  scope: "user",
  serverName: "filesystem",
};
const ISSUE_TRACKER_BINDING: GrowthMcpBindingRef = {
  provider: "codex",
  scope: "project",
  scopeRef: "/Users/example/work/atlas",
  serverName: "issue-tracker",
};
const SCRATCHPAD_BINDING: GrowthMcpBindingRef = {
  provider: "claude",
  scope: "local",
  scopeRef: "/Users/example/work/atlas",
  serverName: "scratchpad",
};

/** The key one binding is keyed by, so a case states an identity rather than a name. */
function keyOf(binding: GrowthMcpBindingRef): string {
  return mcpBindingKeyOf(binding);
}

/**
 * The trust verdict a served row carries, or `undefined` where the arm carries none.
 *
 * The degraded arm has no `trusted` member at all rather than a false one, so a case
 * reads it through the discriminant instead of asserting the arm it expects.
 */
function trustVerdictOf(entry: GrowthMcpInventoryEntry): boolean | undefined {
  return entry.trustUnavailable === true ? undefined : entry.trusted;
}

/** The code one refused press carries, or a failure naming the press that was served. */
function refusalCodeOf(call: string, request: unknown): unknown {
  try {
    settingsMcpAnswerFor(call, request);
  } catch (rejection) {
    return (rejection as Readonly<Record<string, unknown>>)["code"];
  }
  throw new Error(`${call} served an answer for a request it should have refused`);
}

describe("the settings scenario's MCP governance mutations", () => {
  it("names the scenario's own bindings", () => {
    // The premise every case below rests on. A re-scoped binding fails here rather
    // than in a case whose message would be about a mutation outcome.
    const scriptedKeys = SETTINGS_MCP_INVENTORY.map((entry) => keyOf(entry));

    expect(scriptedKeys).toContain(keyOf(FILESYSTEM_BINDING));
    expect(scriptedKeys).toContain(keyOf(ISSUE_TRACKER_BINDING));
    expect(scriptedKeys).toContain(keyOf(SCRATCHPAD_BINDING));
  });

  it("answers an enablement press with the row the request named, in the direction pressed", () => {
    const disabled = settingsMcpMutationResult("mcp.setEnabled", {
      ...FILESYSTEM_BINDING,
      enabled: false,
      clientIdempotencyKey: "probe-disable",
    });
    const enabled = settingsMcpMutationResult("mcp.setEnabled", {
      ...FILESYSTEM_BINDING,
      enabled: true,
      clientIdempotencyKey: "probe-enable",
    });

    expect(keyOf(disabled.server)).toBe(keyOf(FILESYSTEM_BINDING));
    expect(disabled.server.enabled).toBe(false);
    // The other direction, which a constant reply cannot answer: the page offers
    // whichever toggle the row's current state does not already hold.
    expect(keyOf(enabled.server)).toBe(keyOf(FILESYSTEM_BINDING));
    expect(enabled.server.enabled).toBe(true);
  });

  it("answers a trust press with the row the request named, on each governable binding", () => {
    const granted = settingsMcpMutationResult("mcp.setTrust", {
      ...FILESYSTEM_BINDING,
      trusted: true,
      clientIdempotencyKey: "probe-grant",
    });
    const withdrawn = settingsMcpMutationResult("mcp.setTrust", {
      ...ISSUE_TRACKER_BINDING,
      trusted: false,
      clientIdempotencyKey: "probe-withdraw",
    });

    expect(keyOf(granted.server)).toBe(keyOf(FILESYSTEM_BINDING));
    expect(trustVerdictOf(granted.server)).toBe(true);
    expect(keyOf(withdrawn.server)).toBe(keyOf(ISSUE_TRACKER_BINDING));
    expect(trustVerdictOf(withdrawn.server)).toBe(false);
    // A trust grant binds at the daemon and reaches no provider configuration, so it
    // carries no live leg for it to have been applied to.
    expect(granted.applied).toBe("daemon_enforced");
    expect(granted.liveResults).toBeUndefined();
  });

  it("refuses an enablement press on a scope no provider-config write can reach", () => {
    // Enablement is a provider-config write and only user-scope configuration is
    // writable, so both non-user rows refuse rather than answering with the row that
    // can be written.
    expect(
      refusalCodeOf("mcp.setEnabled", {
        ...ISSUE_TRACKER_BINDING,
        enabled: false,
        clientIdempotencyKey: "probe-project",
      }),
    ).toBe("mcp.config_scope_unsupported");
    expect(
      refusalCodeOf("mcp.setEnabled", {
        ...SCRATCHPAD_BINDING,
        enabled: true,
        clientIdempotencyKey: "probe-local",
      }),
    ).toBe("mcp.config_scope_unsupported");
  });

  it("refuses a trust press on the binding that never reaches a run", () => {
    expect(
      refusalCodeOf("mcp.setTrust", {
        ...SCRATCHPAD_BINDING,
        trusted: true,
        clientIdempotencyKey: "probe-untrustable",
      }),
    ).toBe("mcp.config_scope_unsupported");
  });

  it("refuses a binding this scenario declares nowhere", () => {
    // The same server name in a scope the inventory does not carry. A reply keyed on
    // the name alone would answer this with the user-scoped filesystem row.
    const unscripted = {
      provider: "claude",
      scope: "project",
      scopeRef: "/Users/example/work/elsewhere",
      serverName: "filesystem",
    };

    expect(
      refusalCodeOf("mcp.setEnabled", { ...unscripted, enabled: false, clientIdempotencyKey: "a" }),
    ).toBe("mcp.server_not_found");
    expect(
      refusalCodeOf("mcp.setTrust", { ...unscripted, trusted: true, clientIdempotencyKey: "b" }),
    ).toBe("mcp.server_not_found");
  });

  it("matches no binding for a user-scoped request that carries a scope reference", () => {
    // The negative control for the member-wise match: `scopeRef` is required for
    // `project` and `local` and forbidden for `user`, so a request carrying one on the
    // user arm addresses no binding at all rather than the one it half-resembles.
    expect(
      refusalCodeOf("mcp.setTrust", {
        ...FILESYSTEM_BINDING,
        scopeRef: "/Users/example/work/atlas",
        trusted: true,
        clientIdempotencyKey: "probe-overspecified",
      }),
    ).toBe("mcp.server_not_found");
  });

  it("answers nothing for a press that carries no facet to apply", () => {
    // Neither served nor refused: the scenario scripts the METHOD and not this
    // request, which settles exactly as an unscripted call does rather than as an
    // answer about a binding nothing was asked to do anything to.
    expect(
      settingsMcpAnswerFor("mcp.setEnabled", {
        ...FILESYSTEM_BINDING,
        clientIdempotencyKey: "probe-bare",
      }),
    ).toBeUndefined();
    expect(
      settingsMcpAnswerFor("mcp.setTrust", {
        ...FILESYSTEM_BINDING,
        clientIdempotencyKey: "probe-bare",
      }),
    ).toBeUndefined();
  });
});
