// `intervention.ts`: a steer degrades to `queue_and_interrupt` and writes nothing, because the
// daemon queues it and a written steer would apply twice; interrupt and cancel map onto the
// interrupt control request, and a cancel whose receipt lists survivors degrades.

import { DriverInterventionResultSchema } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { ClaudeInterventionDispatcher } from "../intervention.js";
import { STEER_FALLBACK_ACTION } from "../../../provider-driver.js";
import { ClaudeSessionUnavailableError } from "../session-errors.js";
import { type ClaudeRunProcessLookup, type ClaudeProviderProcess } from "../session-transport.js";
import {
  buildCancelParams,
  buildInterruptParams,
  buildSteerParams,
  FakeClaudeProviderProcess,
} from "./claude-test-doubles.js";

class StubRunProcessLookup implements ClaudeRunProcessLookup {
  readonly channel: FakeClaudeProviderProcess | undefined;

  constructor(channel: FakeClaudeProviderProcess | undefined) {
    this.channel = channel;
  }

  findProcessForRun(): ClaudeProviderProcess | undefined {
    return this.channel;
  }
}

interface InterventionHarness {
  readonly dispatcher: ClaudeInterventionDispatcher;
  readonly channel: FakeClaudeProviderProcess;
}

function buildHarness(): InterventionHarness {
  const channel = new FakeClaudeProviderProcess("provider-session-live");
  const dispatcher = new ClaudeInterventionDispatcher({
    channelLookup: new StubRunProcessLookup(channel),
  });
  return { dispatcher, channel };
}

function buildDispatcherWithoutLiveRun(): ClaudeInterventionDispatcher {
  return new ClaudeInterventionDispatcher({ channelLookup: new StubRunProcessLookup(undefined) });
}

describe("ClaudeInterventionDispatcher steer", () => {
  it("degrades with the queue_and_interrupt fallback and sends nothing to the provider", async () => {
    const harness = buildHarness();

    const result = await harness.dispatcher.applyIntervention(
      buildSteerParams("try the other fix"),
    );

    expect(result).toStrictEqual({
      status: "degraded",
      fallbackAction: STEER_FALLBACK_ACTION,
    });
    expect(DriverInterventionResultSchema.safeParse(result).success).toBe(true);
    // The degrade is never a partial application.
    expect(harness.channel.sentWireTexts).toStrictEqual([]);
    expect(harness.channel.controlRequests).toStrictEqual([]);
    expect(harness.channel.outboundCallCount).toBe(0);
  });
});

describe("ClaudeInterventionDispatcher native interrupt and cancel", () => {
  it("routes an interrupt to the interrupt control request without canceling queued input", async () => {
    const harness = buildHarness();

    const result = await harness.dispatcher.applyIntervention(buildInterruptParams());

    expect(result).toStrictEqual({ status: "applied" });
    expect(harness.channel.controlRequests).toStrictEqual([
      { subtype: "interrupt", cancelQueued: false },
    ]);
    expect(harness.channel.sentWireTexts).toStrictEqual([]);
    expect(DriverInterventionResultSchema.safeParse(result).success).toBe(true);
  });

  it("routes a cancel to the same control request with queued input canceled", async () => {
    const harness = buildHarness();

    const result = await harness.dispatcher.applyIntervention(buildCancelParams());

    expect(result).toStrictEqual({ status: "applied" });
    expect(harness.channel.controlRequests).toStrictEqual([
      { subtype: "interrupt", cancelQueued: true },
    ]);
  });

  it("degrades — never throws — when the CLI answers with a typed control refusal", async () => {
    const harness = buildHarness();
    harness.channel.controlResponse = {
      subtype: "error",
      error: "Unsupported control request subtype: interrupt",
    };

    const result = await harness.dispatcher.applyIntervention(buildInterruptParams());

    expect(result).toStrictEqual({ status: "degraded" });
    expect(result.fallbackAction).toBeUndefined();
    expect(DriverInterventionResultSchema.safeParse(result).success).toBe(true);
  });

  it("refuses an interrupt for a run with no live channel rather than claiming a degrade", async () => {
    const dispatcher = buildDispatcherWithoutLiveRun();

    await expect(dispatcher.applyIntervention(buildInterruptParams())).rejects.toBeInstanceOf(
      ClaudeSessionUnavailableError,
    );
  });
});

describe("ClaudeInterventionDispatcher cancel receipt grading", () => {
  it("degrades a cancel the provider acknowledged while reporting survivors", async () => {
    const harness = buildHarness();
    harness.channel.controlResponse = {
      subtype: "success",
      response: { still_queued: ["3f1b0c22-0000-4000-8000-000000000001"] },
    };

    const result = await harness.dispatcher.applyIntervention(buildCancelParams());

    // `applied` would tell the daemon the cancel took hold while queued messages still run.
    expect(result).toStrictEqual({ status: "degraded" });
    expect(result.fallbackAction).toBeUndefined();
    expect(DriverInterventionResultSchema.safeParse(result).success).toBe(true);
  });

  it("applies an interrupt that reports survivors — survival is what defines it", async () => {
    const harness = buildHarness();
    harness.channel.controlResponse = {
      subtype: "success",
      response: { still_queued: ["3f1b0c22-0000-4000-8000-000000000001"] },
    };

    // Queued input is meant to outlive an interrupt, so survivors are not a failure here.
    await expect(
      harness.dispatcher.applyIntervention(buildInterruptParams()),
    ).resolves.toStrictEqual({ status: "applied" });
  });

  it("reads a malformed receipt as reporting nothing rather than throwing", async () => {
    const harness = buildHarness();
    harness.channel.controlResponse = {
      subtype: "success",
      response: { still_queued: "not-an-array" },
    };

    // The receipt comes from the provider; an unreadable one must not turn a delivered cancel
    // into an exception.
    await expect(harness.dispatcher.applyIntervention(buildCancelParams())).resolves.toStrictEqual({
      status: "applied",
    });
  });
});
