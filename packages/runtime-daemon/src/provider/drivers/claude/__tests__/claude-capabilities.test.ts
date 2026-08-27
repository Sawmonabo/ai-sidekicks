/**
 * Plan-005 T3.8 — Claude capability declaration (I-005-2, CP-005-5).
 *
 * The invariant is that the declaration is EXPLICIT and TOTAL, and that no
 * caller may read support out of absence. Two of these assertions are
 * compile-time rather than runtime and say so where they appear: the flag
 * record's totality is enforced by its type annotation, and the writer's
 * conformance to the declaration sink is enforced by a conditional type.
 *
 * What is deliberately NOT asserted here: that a
 * `runtime_node.capability_declared` / `capability_updated` event reaches the
 * log. That emission is `DriverCapabilitiesWriter`'s (Plan-005 T2.4) and is
 * covered by its own tests; a typed fake observes the CALL, never the event.
 * What this file asserts about the refresh trigger is exactly what it owns —
 * that a fresh reading, keyed to this driver, reaches the sink unaltered, and
 * that the sink's verdict is returned unaltered.
 */

import { describe, expect, it, vi } from "vitest";

import {
  DRIVER_CAPABILITY_FLAGS,
  type DriverCapabilityFlag,
  type DriverCliVersionReport,
  type GetCapabilitiesResult,
} from "@ai-sidekicks/contracts";

import type {
  DeclareDriverCapabilitiesInput,
  DeclareDriverCapabilitiesResult,
  DriverCapabilitiesWriter,
} from "../../../driver-capabilities-writer.js";
import {
  assertValidCapabilityFlags,
  assertValidContractVersion,
  assertValidGetCapabilitiesResultShape,
} from "../../../provider-output-validation.js";
import {
  CLAUDE_CAPABILITY_CONTRACT_VERSION,
  CLAUDE_DECLARED_CAPABILITY_FLAGS,
  CLAUDE_DRIVER_NAME,
  ClaudeCapabilityReporter,
  type DriverCapabilityDeclarationSink,
} from "../capabilities.js";
import { CLAUDE_TOOL_CATALOG } from "../tools.js";

const CLI_VERSION: DriverCliVersionReport = { raw: "2.1.245 (Claude Code)", semver: "2.1.245" };

function makeReporter(
  readCliVersion: () => Promise<DriverCliVersionReport> = () => Promise.resolve({ ...CLI_VERSION }),
): ClaudeCapabilityReporter {
  return new ClaudeCapabilityReporter({ readCliVersion });
}

/** A typed fake sink: records what the refresh trigger hands the writer. */
class RecordingDeclarationSink implements DriverCapabilityDeclarationSink {
  readonly calls: DeclareDriverCapabilitiesInput[] = [];
  #verdict: DeclareDriverCapabilitiesResult;

  constructor(
    verdict: DeclareDriverCapabilitiesResult = { emitted: "declared", cliVersionRefreshed: true },
  ) {
    this.#verdict = verdict;
  }

  declare(input: DeclareDriverCapabilitiesInput): Promise<DeclareDriverCapabilitiesResult> {
    this.calls.push(input);
    return Promise.resolve(this.#verdict);
  }
}

describe("Claude capability declaration — explicit and total (I-005-2)", () => {
  it("declares the Spec-005 matrix values exactly", () => {
    // Transcribed from Spec-005 §Per-Driver Capability Matrix (Claude column).
    // The annotation makes this expectation total too: a flag added to the
    // union breaks this test at COMPILE time, not on a silent `false`.
    const matrix: Record<DriverCapabilityFlag, boolean> = {
      resume: true,
      steer: false,
      interactive_requests: true,
      mcp: true,
      tool_calls: true,
      reasoning_stream: true,
      model_mutation: true,
      structured_output: true,
      rollback: true,
      session_goals: true,
      callback_tools: true,
      subagents: true,
      cost_cap: true,
    };
    expect(CLAUDE_DECLARED_CAPABILITY_FLAGS).toStrictEqual(matrix);
  });

  it("pins the three cells whose value is easy to get backwards", () => {
    expect(CLAUDE_DECLARED_CAPABILITY_FLAGS.steer).toBe(false);
    expect(CLAUDE_DECLARED_CAPABILITY_FLAGS.reasoning_stream).toBe(true);
    expect(CLAUDE_DECLARED_CAPABILITY_FLAGS.cost_cap).toBe(true);
  });

  it("covers every canonical flag, with a boolean for each", () => {
    const declared = Object.keys(CLAUDE_DECLARED_CAPABILITY_FLAGS).sort();
    expect(declared).toStrictEqual([...DRIVER_CAPABILITY_FLAGS].sort());
    for (const flag of DRIVER_CAPABILITY_FLAGS) {
      expect(Object.hasOwn(CLAUDE_DECLARED_CAPABILITY_FLAGS, flag)).toBe(true);
      expect(typeof CLAUDE_DECLARED_CAPABILITY_FLAGS[flag]).toBe("boolean");
    }
  });

  it("is accepted by the write seam's own totality guard", () => {
    // Drives the real guard rather than restating its rule: a declaration this
    // module ships must survive the validator the writer applies to it.
    expect(() => {
      assertValidCapabilityFlags(CLAUDE_DECLARED_CAPABILITY_FLAGS);
    }).not.toThrow();
  });

  it("declares no flag the contract does not carry", () => {
    // `transcript_replay` is in the Spec-005 matrix (Claude cell: `probe`) but
    // not in the union. Declaring it early would ship a key the writer rejects;
    // T3.19/T3.20 mints it in the contract and decides the value there.
    expect(Object.hasOwn(CLAUDE_DECLARED_CAPABILITY_FLAGS, "transcript_replay")).toBe(false);
    const canonical = new Set<string>(DRIVER_CAPABILITY_FLAGS);
    for (const flag of Object.keys(CLAUDE_DECLARED_CAPABILITY_FLAGS)) {
      expect(canonical.has(flag)).toBe(true);
    }
  });

  it("carries a canonical, identifying contract version", () => {
    expect(() => {
      assertValidContractVersion(CLAUDE_CAPABILITY_CONTRACT_VERSION);
    }).not.toThrow();
  });

  it("names the driver with the daemon-controlled registry key", () => {
    expect(CLAUDE_DRIVER_NAME).toBe("claude");
  });
});

describe("getCapabilities() — the V1 result wrapper", () => {
  it("reports flags, contract version, tools, and the CLI version", async () => {
    const result: GetCapabilitiesResult = await makeReporter().getCapabilities();

    expect(result.capabilities.flags).toStrictEqual(CLAUDE_DECLARED_CAPABILITY_FLAGS);
    expect(result.capabilities.contractVersion).toBe(CLAUDE_CAPABILITY_CONTRACT_VERSION);
    expect(result.tools).toStrictEqual([...CLAUDE_TOOL_CATALOG]);
    expect(result.cliVersion).toStrictEqual(CLI_VERSION);
  });

  it("produces a wrapper the write seam's shape guard accepts", () => {
    return makeReporter()
      .getCapabilities()
      .then((result) => {
        expect(() => {
          assertValidGetCapabilitiesResultShape(result);
        }).not.toThrow();
      });
  });

  it("reports the injected CLI version verbatim, as a copy", async () => {
    const source: DriverCliVersionReport = { raw: "2.2.0-rc.1 (probe)", semver: "2.2.0-rc.1" };
    const result = await makeReporter(() => Promise.resolve(source)).getCapabilities();
    expect(result.cliVersion).toStrictEqual(source);
    expect(Object.is(result.cliVersion, source)).toBe(false);
  });

  it("re-reads the CLI version on every call (a report is never cached here)", async () => {
    const readCliVersion = vi.fn(() => Promise.resolve({ ...CLI_VERSION }));
    const reporter = makeReporter(readCliVersion);
    await reporter.getCapabilities();
    await reporter.getCapabilities();
    expect(readCliVersion).toHaveBeenCalledTimes(2);
  });

  it("hands out defensive copies — a mutated reply cannot rewrite the next one", async () => {
    const reporter = makeReporter();
    const first = await reporter.getCapabilities();

    first.capabilities.flags.cost_cap = false;
    first.capabilities.flags.steer = true;
    first.tools.length = 0;

    expect(CLAUDE_DECLARED_CAPABILITY_FLAGS.cost_cap).toBe(true);
    expect(CLAUDE_DECLARED_CAPABILITY_FLAGS.steer).toBe(false);
    expect(CLAUDE_TOOL_CATALOG.length).toBeGreaterThan(0);

    const second = await reporter.getCapabilities();
    expect(second.capabilities.flags.cost_cap).toBe(true);
    expect(second.capabilities.flags.steer).toBe(false);
    expect(second.tools).toStrictEqual([...CLAUDE_TOOL_CATALOG]);
    expect(Object.is(second.capabilities.flags, first.capabilities.flags)).toBe(false);
  });

  it("reports tools already class-closed (I-005-3 holds at the wrapper)", async () => {
    const result = await makeReporter().getCapabilities();
    expect(result.tools.length).toBe(CLAUDE_TOOL_CATALOG.length);
    for (const tool of result.tools) {
      expect(tool.idempotency_class).toBeDefined();
    }
  });

  it("propagates a CLI-version read failure instead of reporting a partial wrapper", async () => {
    const reporter = makeReporter(() => Promise.reject(new Error("claude --version failed")));
    await expect(reporter.getCapabilities()).rejects.toThrow("claude --version failed");
  });
});

describe("refreshDeclaration() — the emission seam (CP-005-5)", () => {
  it("hands the sink a fresh reading keyed to this driver", async () => {
    const sink = new RecordingDeclarationSink();
    const reporter = makeReporter();

    const verdict = await reporter.refreshDeclaration(sink, {
      sessionId: "session-1",
      nodeId: "node-1",
    });

    expect(sink.calls.length).toBe(1);
    const [call] = sink.calls;
    expect(call?.driverName).toBe(CLAUDE_DRIVER_NAME);
    expect(call?.sessionId).toBe("session-1");
    expect(call?.nodeId).toBe("node-1");
    expect(call?.result).toStrictEqual(await reporter.getCapabilities());
    expect(verdict).toStrictEqual({ emitted: "declared", cliVersionRefreshed: true });
  });

  it("omits `actor` entirely when the caller supplies none", async () => {
    const sink = new RecordingDeclarationSink();
    await makeReporter().refreshDeclaration(sink, { sessionId: "s", nodeId: "n" });
    expect(Object.hasOwn(sink.calls[0] ?? {}, "actor")).toBe(false);
  });

  it("passes an explicit actor through, including an explicit null", async () => {
    const sink = new RecordingDeclarationSink();
    const reporter = makeReporter();
    await reporter.refreshDeclaration(sink, { sessionId: "s", nodeId: "n", actor: "operator-1" });
    await reporter.refreshDeclaration(sink, { sessionId: "s", nodeId: "n", actor: null });
    expect(sink.calls[0]?.actor).toBe("operator-1");
    expect(sink.calls[1]?.actor).toBeNull();
  });

  it("returns the sink's verdict unaltered — change detection is the writer's", async () => {
    for (const emitted of ["declared", "updated", "noop"] as const) {
      const sink = new RecordingDeclarationSink({ emitted, cliVersionRefreshed: false });
      const verdict = await makeReporter().refreshDeclaration(sink, {
        sessionId: "s",
        nodeId: "n",
      });
      expect(verdict).toStrictEqual({ emitted, cliVersionRefreshed: false });
    }
  });

  it("re-reads the version on each refresh, so a CLI upgrade reaches the sink", async () => {
    const versions: DriverCliVersionReport[] = [
      { raw: "2.1.245", semver: "2.1.245" },
      { raw: "2.1.246", semver: "2.1.246" },
    ];
    let call = 0;
    const reporter = makeReporter(() => {
      const version = versions[Math.min(call, versions.length - 1)];
      call += 1;
      return Promise.resolve(version as DriverCliVersionReport);
    });
    const sink = new RecordingDeclarationSink();

    await reporter.refreshDeclaration(sink, { sessionId: "s", nodeId: "n" });
    await reporter.refreshDeclaration(sink, { sessionId: "s", nodeId: "n" });

    expect(sink.calls[0]?.result.cliVersion.semver).toBe("2.1.245");
    expect(sink.calls[1]?.result.cliVersion.semver).toBe("2.1.246");
  });

  it("does not swallow a sink failure", async () => {
    const failing: DriverCapabilityDeclarationSink = {
      declare: () => Promise.reject(new Error("write seam rejected the declaration")),
    };
    await expect(
      makeReporter().refreshDeclaration(failing, { sessionId: "s", nodeId: "n" }),
    ).rejects.toThrow("write seam rejected the declaration");
  });

  it("is satisfied by the real DriverCapabilitiesWriter (compile-time)", () => {
    // The runtime assertion is trivial; the guarantee is the conditional type,
    // which fails `tsc -p tsconfig.test.json` if the writer's `declare` ever
    // stops matching the sink this module declares.
    type WriterConformsToSink = DriverCapabilitiesWriter extends DriverCapabilityDeclarationSink
      ? true
      : false;
    const writerConforms: WriterConformsToSink = true;
    expect(writerConforms).toBe(true);
  });
});
