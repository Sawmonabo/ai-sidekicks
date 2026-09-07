// The governance inventory reads as what the last mutation answered, and the port is
// what proves it.
//
// Two subjects, and both are here because they fail differently. The LEDGER is wrong
// when a substitution lands on the wrong binding or moves a row, and its cases drive
// the class directly with rows whose verdict is known. The PORT is wrong when the two
// mutations record nothing or the read serves the script past the ledger, and its cases
// drive the real fixture bridge over the real settings scenario on the real frozen
// clock — the wiring is exactly what a class-only suite could not see.
//
// The negative control is the third ledger case: a binding no mutation named keeps the
// scripted row. Without it a ledger that replaced every row with the last mutation's
// would pass both positive cases.

import { describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { FixtureMcpInventoryLedger } from "./fixture-mcp-inventory.js";
import { createFixture } from "./fixture-bridge.test-support.js";
import type { GrowthOutcome } from "../growth-port/index.js";
import {
  mcpBindingKeyOf,
  type GrowthMcpBindingRef,
  type GrowthMcpInventoryEntry,
} from "../growth-values/index.js";
import {
  SETTINGS_MCP_INVENTORY,
  SETTINGS_MCP_SET_ENABLED,
  SETTINGS_MCP_SET_TRUST,
} from "../scenarios/settings-mcp-plane.js";
import { SETTINGS_SCENARIO } from "../scenarios/settings.js";

/** The scripted latency on the inventory read, so a case advances past its own. */
const MCP_LIST_LATENCY_MS = 40;
/** The scripted latency on both governance mutations. */
const MCP_MUTATION_LATENCY_MS = 80;

/**
 * The two bindings this suite mutates, as a REQUEST names them.
 *
 * Written out rather than derived from the inventory row, because a request carries the
 * scope-qualified identity and nothing else — and each case pins its constant to the
 * scenario's own row through `mcpBindingKeyOf` below, so a scenario that re-scopes a
 * binding fails here rather than quietly mutating something the grid does not show.
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

/** The scripted row a case names, or a failure that says the scenario moved. */
function scriptedRowNamed(serverName: string): GrowthMcpInventoryEntry {
  const row = SETTINGS_MCP_INVENTORY.find((entry) => entry.serverName === serverName);
  if (row === undefined) {
    throw new Error(`the settings scenario declares no MCP binding named ${serverName}`);
  }
  return row;
}

/** One row of an inventory reading, by the server name a case names it with. */
function rowNamedIn(
  reading: { readonly servers: readonly GrowthMcpInventoryEntry[] },
  serverName: string,
): GrowthMcpInventoryEntry | undefined {
  return reading.servers.find((entry) => entry.serverName === serverName);
}

/**
 * The served value of one outcome, or a failure naming the outcome that was not served.
 *
 * A narrowing helper rather than a bare cast: an operation that refused answers a
 * `status` this suite has nothing to say about, and reading `.value` off it would be
 * the fixture's own absence rendered as a result.
 */
function servedValueOf<TValue>(outcome: GrowthOutcome<TValue>): TValue {
  if (outcome.status !== "served") {
    throw new Error(`the fixture port answered ${outcome.status} rather than serving a value`);
  }
  return outcome.value;
}

describe("FixtureMcpInventoryLedger", () => {
  it("serves the row a mutation answered with, in the scripted row's place", () => {
    const ledger = new FixtureMcpInventoryLedger();
    ledger.recordMutation(SETTINGS_MCP_SET_ENABLED);

    const reading = ledger.inventoryOver({ servers: SETTINGS_MCP_INVENTORY });

    expect(rowNamedIn(reading, "filesystem")).toBe(SETTINGS_MCP_SET_ENABLED.server);
    // Order is the script's, so the substitution replaced a row rather than appending
    // one — a reader watching one control cannot have another binding slide under it.
    expect(reading.servers.map((entry) => entry.serverName)).toStrictEqual(
      SETTINGS_MCP_INVENTORY.map((entry) => entry.serverName),
    );
  });

  it("keys the substitution on the whole binding and not on the server name", () => {
    const ledger = new FixtureMcpInventoryLedger();
    // The same server name under a scope the scripted inventory does not carry. A
    // ledger keyed on the name alone would put this row on the `user`-scoped
    // `filesystem` binding, which is a different binding entirely.
    ledger.recordMutation({
      ...SETTINGS_MCP_SET_ENABLED,
      server: {
        ...SETTINGS_MCP_SET_ENABLED.server,
        scope: "project",
        scopeRef: "/Users/example/work/elsewhere",
      },
    });

    const reading = ledger.inventoryOver({ servers: SETTINGS_MCP_INVENTORY });

    expect(rowNamedIn(reading, "filesystem")).toBe(scriptedRowNamed("filesystem"));
  });

  // Negative control: the substitution bites only where a mutation named the binding.
  it("leaves a binding no mutation named exactly as the script declares it", () => {
    const ledger = new FixtureMcpInventoryLedger();
    ledger.recordMutation(SETTINGS_MCP_SET_ENABLED);

    const reading = ledger.inventoryOver({ servers: SETTINGS_MCP_INVENTORY });

    expect(rowNamedIn(reading, "issue-tracker")).toBe(scriptedRowNamed("issue-tracker"));
    expect(rowNamedIn(reading, "scratchpad")).toBe(scriptedRowNamed("scratchpad"));
  });
});

describe("the fixture growth port — the inventory read after a governance mutation", () => {
  it("names the scenario's own bindings", () => {
    // The premise every case below rests on: the requests they send address the rows
    // the scenario declares. A re-scoped binding fails here rather than in a case whose
    // message would be about an inventory row.
    expect(mcpBindingKeyOf(FILESYSTEM_BINDING)).toBe(
      mcpBindingKeyOf(scriptedRowNamed("filesystem")),
    );
    expect(mcpBindingKeyOf(ISSUE_TRACKER_BINDING)).toBe(
      mcpBindingKeyOf(scriptedRowNamed("issue-tracker")),
    );
  });

  it("reports the binding disabled once the disable has been applied", async () => {
    const fixture = createFixture(SETTINGS_SCENARIO);

    const beforeMutation = fixture.bridge.growth.mcpList({});
    await crossMacrotaskBoundary();
    fixture.engine.advance(MCP_LIST_LATENCY_MS);
    expect(rowNamedIn(servedValueOf(await beforeMutation), "filesystem")?.enabled).toBe(true);

    const disable = fixture.bridge.growth.mcpSetEnabled({
      ...FILESYSTEM_BINDING,
      enabled: false,
      clientIdempotencyKey: "probe-disable",
    });
    await crossMacrotaskBoundary();
    fixture.engine.advance(MCP_MUTATION_LATENCY_MS);
    expect(servedValueOf(await disable).server).toBe(SETTINGS_MCP_SET_ENABLED.server);

    const afterMutation = fixture.bridge.growth.mcpList({});
    await crossMacrotaskBoundary();
    fixture.engine.advance(MCP_LIST_LATENCY_MS);
    const settledReading = servedValueOf(await afterMutation);
    // The defect this closes: the page rendered the mutation's own applied outcome
    // beside a grid that had put the control back on.
    expect(rowNamedIn(settledReading, "filesystem")).toBe(SETTINGS_MCP_SET_ENABLED.server);
    expect(rowNamedIn(settledReading, "filesystem")?.enabled).toBe(false);
  });

  it("reports the binding trusted once the grant has been applied", async () => {
    const fixture = createFixture(SETTINGS_SCENARIO);

    const grant = fixture.bridge.growth.mcpSetTrust({
      ...ISSUE_TRACKER_BINDING,
      trusted: true,
      clientIdempotencyKey: "probe-trust",
    });
    await crossMacrotaskBoundary();
    fixture.engine.advance(MCP_MUTATION_LATENCY_MS);
    expect(servedValueOf(await grant).server).toBe(SETTINGS_MCP_SET_TRUST.server);

    const afterMutation = fixture.bridge.growth.mcpList({});
    await crossMacrotaskBoundary();
    fixture.engine.advance(MCP_LIST_LATENCY_MS);
    const settledReading = servedValueOf(await afterMutation);
    expect(rowNamedIn(settledReading, "issue-tracker")).toBe(SETTINGS_MCP_SET_TRUST.server);
    // The rows this grant did not name are still the script's, on the same reading.
    expect(rowNamedIn(settledReading, "filesystem")).toBe(scriptedRowNamed("filesystem"));
  });

  it("holds one port's mutations off another port's inventory", async () => {
    // Two windows on one build hold two engines and two ports. A shared register would
    // put this disable on the second window's grid, which is a state no daemon can
    // produce — the two are reading different nodes.
    const disabling = createFixture(SETTINGS_SCENARIO);
    const untouched = createFixture(SETTINGS_SCENARIO);

    const disable = disabling.bridge.growth.mcpSetEnabled({
      ...FILESYSTEM_BINDING,
      enabled: false,
      clientIdempotencyKey: "probe-disable",
    });
    await crossMacrotaskBoundary();
    disabling.engine.advance(MCP_MUTATION_LATENCY_MS);
    expect(servedValueOf(await disable).server).toBe(SETTINGS_MCP_SET_ENABLED.server);

    const otherReading = untouched.bridge.growth.mcpList({});
    await crossMacrotaskBoundary();
    untouched.engine.advance(MCP_LIST_LATENCY_MS);
    expect(rowNamedIn(servedValueOf(await otherReading), "filesystem")).toBe(
      scriptedRowNamed("filesystem"),
    );
  });
});
