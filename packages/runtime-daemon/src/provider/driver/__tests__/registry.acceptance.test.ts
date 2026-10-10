// ProviderRegistry and DriverCapabilitiesWriter composed over one real SQLite handle, with the
// driver as the only double: capability gating agrees between the live registry, a registry
// re-seeded from the durable cache after a restart, and a refreshed registry.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { captureThrow } from "../../../__fixtures__/capture-failure.js";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import { makeAdvancingClock } from "../../../__fixtures__/advancing-clock.js";
import {
  CLI_VERSION_REPORT,
  CONTRACT_VERSION,
  expectHydrationHit,
  makeFlags,
  makeResult,
} from "../../capability/__fixtures__/results.js";
import { DriverCapabilitiesWriter } from "../capabilities-writer.js";
import { DriverCapabilityUnsupportedError, ProviderRegistry } from "../registry.js";
import type { GetCapabilitiesResult } from "../contract.js";
import { FakeProviderDriver } from "../__fixtures__/contract-doubles.js";

const DRIVER_NAME: ProviderName = "claude";

// The registry gates on the snapshot it is handed and never calls the driver itself.
const driver = new FakeProviderDriver(() =>
  Promise.reject(new Error("the registry never reads a driver's capabilities")),
);

interface Stack {
  readonly writer: DriverCapabilitiesWriter;
  readonly registry: ProviderRegistry;
}

let scratch: ScratchDatabase;

function makeStack(): Stack {
  return {
    writer: new DriverCapabilitiesWriter(scratch, makeAdvancingClock()),
    registry: new ProviderRegistry(),
  };
}

beforeEach(async () => {
  scratch = await openScratchDatabase();
});

afterEach(async () => {
  await scratch.close();
});

describe("capability gating across the registry, the durable cache and a restart", () => {
  it(
    "registry gate, declare, hydrate, and a re-seeded registry-B all agree on the gating set " +
      "across a daemon restart",
    async () => {
      const { writer, registry } = makeStack();

      // steer:false, resume:true, tool_calls:true, and a non-empty tools array.
      // Tools are already in canonical order with an explicit `idempotency_class`, so a hydrate
      // round-trip is an identity check.
      const advertised: GetCapabilitiesResult = makeResult({
        capabilities: { flags: makeFlags({ steer: false }), contractVersion: CONTRACT_VERSION },
        tools: [{ name: "search", idempotency_class: "idempotent", description: "search the web" }],
      });
      // Registry A: the live gate reads the snapshot resolved at register.
      registry.register(DRIVER_NAME, driver, advertised.capabilities);
      // A declared-true flag returns void.
      expect(registry.checkCapability(DRIVER_NAME, "resume")).toBeUndefined();
      // A declared-false flag throws.
      const refusal = captureThrow(() => registry.checkCapability(DRIVER_NAME, "steer"));
      expect(refusal).toBeInstanceOf(DriverCapabilityUnsupportedError);
      expect((refusal as DriverCapabilityUnsupportedError).code).toBe(
        "driver.capability_unsupported",
      );

      // Persist the snapshot to the durable cache.
      expect(
        await writer.declare({
          driverName: DRIVER_NAME,
          result: advertised,
        }),
      ).toEqual({ snapshotChange: "created", cliVersionRefreshed: true });

      // Hydrate reproduces the whole result, `cliVersion` included; a member-wise check would let a
      // dropped `cliVersion` pass.
      const hydrated: GetCapabilitiesResult = expectHydrationHit(writer.hydrate(DRIVER_NAME));
      expect(hydrated).toEqual(advertised);
      expect(hydrated.capabilities.flags).toEqual(makeFlags({ steer: false }));
      expect(hydrated.capabilities.contractVersion).toBe(CONTRACT_VERSION);
      expect(hydrated.tools).toEqual([
        { name: "search", idempotency_class: "idempotent", description: "search the web" },
      ]);
      expect(hydrated.cliVersion).toEqual(CLI_VERSION_REPORT);

      // Cold-start re-seed: registry B is fed the hydrated cache, not the live read, and must
      // gate identically to registry A.
      const registryB: ProviderRegistry = new ProviderRegistry();
      registryB.register(DRIVER_NAME, driver, hydrated.capabilities);
      expect(registryB.checkCapability(DRIVER_NAME, "resume")).toBeUndefined();
      const refusalB = captureThrow(() => registryB.checkCapability(DRIVER_NAME, "steer"));
      expect(refusalB).toBeInstanceOf(DriverCapabilityUnsupportedError);
      expect((refusalB as DriverCapabilityUnsupportedError).code).toBe(
        "driver.capability_unsupported",
      );
    },
  );

  it("steer false→true reports changed and the refreshed registry passes steer", async () => {
    const { writer } = makeStack();

    // Initial declare: steer:false.
    expect(
      await writer.declare({
        driverName: DRIVER_NAME,
        result: makeResult({
          capabilities: { flags: makeFlags({ steer: false }), contractVersion: CONTRACT_VERSION },
        }),
      }),
    ).toEqual({ snapshotChange: "created", cliVersionRefreshed: true });

    // Refreshed declare: steer:true is a real change.
    expect(
      await writer.declare({
        driverName: DRIVER_NAME,
        result: makeResult({
          capabilities: { flags: makeFlags({ steer: true }), contractVersion: CONTRACT_VERSION },
        }),
      }),
    ).toEqual({
      snapshotChange: "changed",
      // False on purpose: only the capability matrix changed, and `makeResult` re-declares the same
      // `CLI_VERSION_REPORT`. A flag wired to "a statement ran" would report true.
      cliVersionRefreshed: false,
    });

    // Re-hydrate and register from the refreshed cache: steer now passes.
    const refreshed: GetCapabilitiesResult = expectHydrationHit(writer.hydrate(DRIVER_NAME));
    expect(refreshed.capabilities.flags["steer"]).toBe(true);
    // The refresh must not drop the version pair.
    expect(refreshed.cliVersion).toEqual(CLI_VERSION_REPORT);

    const refreshedRegistry: ProviderRegistry = new ProviderRegistry();
    refreshedRegistry.register(DRIVER_NAME, driver, refreshed.capabilities);
    expect(refreshedRegistry.checkCapability(DRIVER_NAME, "steer")).toBeUndefined();
  });
});
