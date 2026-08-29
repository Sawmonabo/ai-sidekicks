// Coverage map for `intervention.ts` (Plan-005 Phase 3, T3.7):
//   * `Spec-005 §Required Behavior` — one generic `applyIntervention` dispatcher plus the
//     degraded-fallback answer, rather than a per-intervention method set.
//   * ADR-011 (generic intervention dispatch) — `queue_and_interrupt` is the
//     documented daemon fallback for a provider with no native steer.
//   * I-005-4 — an intervention type this driver cannot dispatch natively returns
//     a `degraded` RESULT: never a throw, and never a silent no-op. The
//     no-silent-no-op conjunct is asserted by counting OUTBOUND TRAFFIC, not by
//     reading the return value: a degraded steer must send zero user-text frames
//     and zero control requests, because a driver that delivered the steer text
//     and then reported `degraded` would double-apply the intervention the daemon
//     is about to queue.
//   * P0-3 (T3.14) — the requester's `clientIdempotencyKey` has no pinned wire
//     home on the interrupt control request, so no substitute is invented: the
//     dispatched request carries exactly `{ subtype, cancelQueued }`.
//   * P3-1 (T3.14) — an acknowledged CANCEL that reports surviving queued
//     messages (`still_queued`, the `interrupt_receipt_v1` receipt) degrades
//     instead of reading as success; the same field on an INTERRUPT is the
//     contract working, and applies.

import {
  DRIVER_FALLBACK_ACTION_MAX_LEN,
  DriverInterventionResultSchema,
  type ApplyInterventionParams,
} from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { CLAUDE_STEER_FALLBACK_ACTION, ClaudeInterventionDispatcher } from "../intervention.js";
import {
  ClaudeSessionUnavailableError,
  type ClaudeRunChannelLookup,
  type ClaudeSessionChannel,
} from "../lifecycle.js";
import {
  buildCancelParams,
  buildInterruptParams,
  buildSteerParams,
  FakeClaudeSessionChannel,
  TEST_RUN_ID,
} from "./claude-test-doubles.js";

class StubRunChannelLookup implements ClaudeRunChannelLookup {
  readonly channel: FakeClaudeSessionChannel | undefined;

  constructor(channel: FakeClaudeSessionChannel | undefined) {
    this.channel = channel;
  }

  findChannelForRun(): ClaudeSessionChannel | undefined {
    return this.channel;
  }
}

interface InterventionHarness {
  readonly dispatcher: ClaudeInterventionDispatcher;
  readonly channel: FakeClaudeSessionChannel;
}

function buildHarness(): InterventionHarness {
  const channel = new FakeClaudeSessionChannel("provider-session-live");
  const dispatcher = new ClaudeInterventionDispatcher({
    channelLookup: new StubRunChannelLookup(channel),
  });
  return { dispatcher, channel };
}

function buildDispatcherWithoutLiveRun(): ClaudeInterventionDispatcher {
  return new ClaudeInterventionDispatcher({ channelLookup: new StubRunChannelLookup(undefined) });
}

describe("CLAUDE_STEER_FALLBACK_ACTION", () => {
  it("stays inside the bound the driver result envelope enforces", () => {
    // The bound is enforced at runtime by the schema parse every result goes
    // through; this asserts the shipped value against it directly, so a later
    // edit to the constant fails here rather than only inside a dispatch path.
    expect(CLAUDE_STEER_FALLBACK_ACTION.length).toBeLessThanOrEqual(DRIVER_FALLBACK_ACTION_MAX_LEN);
    expect(CLAUDE_STEER_FALLBACK_ACTION).toBe("queue_and_interrupt");
  });
});

describe("ClaudeInterventionDispatcher steer (I-005-4)", () => {
  it("degrades with the documented queue_and_interrupt fallback", async () => {
    const harness = buildHarness();

    const result = await harness.dispatcher.applyIntervention(
      buildSteerParams("try the other fix"),
    );

    expect(result).toStrictEqual({
      status: "degraded",
      fallbackAction: CLAUDE_STEER_FALLBACK_ACTION,
    });
    expect(CLAUDE_STEER_FALLBACK_ACTION).toBe("queue_and_interrupt");
    expect(DriverInterventionResultSchema.safeParse(result).success).toBe(true);
  });

  it("sends nothing to the provider — the degrade is never a partial application", async () => {
    const harness = buildHarness();

    await harness.dispatcher.applyIntervention(buildSteerParams("try the other fix"));

    expect(harness.channel.sentWireTexts).toStrictEqual([]);
    expect(harness.channel.controlRequests).toStrictEqual([]);
    expect(harness.channel.outboundCallCount).toBe(0);
  });

  it("never leaks the steer content into an out-of-band provider turn", async () => {
    const harness = buildHarness();

    await harness.dispatcher.applyIntervention(buildSteerParams("secret steering text"));

    const outboundPayload = JSON.stringify({
      frames: harness.channel.sentTextFrames,
      controls: harness.channel.controlRequests,
    });
    expect(outboundPayload).not.toContain("secret steering text");
  });

  it("degrades rather than throwing when the target run has no live channel", async () => {
    const dispatcher = buildDispatcherWithoutLiveRun();

    const result = await dispatcher.applyIntervention(buildSteerParams("try the other fix"));

    expect(result.status).toBe("degraded");
  });
});

describe("ClaudeInterventionDispatcher native interrupt and cancel", () => {
  it("routes an interrupt to the interrupt control request without cancelling queued input", async () => {
    const harness = buildHarness();

    const result = await harness.dispatcher.applyIntervention(buildInterruptParams());

    expect(result).toStrictEqual({ status: "applied" });
    expect(harness.channel.controlRequests).toStrictEqual([
      { subtype: "interrupt", cancelQueued: false },
    ]);
    expect(harness.channel.sentWireTexts).toStrictEqual([]);
    expect(DriverInterventionResultSchema.safeParse(result).success).toBe(true);
  });

  it("routes a cancel to the same control request with queued input cancelled", async () => {
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

  it("propagates a transport exception instead of laundering it into a degraded result", async () => {
    const harness = buildHarness();
    harness.channel.controlRequestFailure = new Error("stdin pipe closed");

    await expect(harness.dispatcher.applyIntervention(buildInterruptParams())).rejects.toThrow(
      "stdin pipe closed",
    );
  });

  it("refuses an interrupt for a run with no live channel rather than claiming a degrade", async () => {
    const dispatcher = buildDispatcherWithoutLiveRun();

    await expect(dispatcher.applyIntervention(buildInterruptParams())).rejects.toBeInstanceOf(
      ClaudeSessionUnavailableError,
    );
  });
});

describe("ClaudeInterventionDispatcher cancel receipt grading (P3-1)", () => {
  it("degrades a cancel the provider acknowledged while reporting survivors", async () => {
    const harness = buildHarness();
    harness.channel.controlResponse = {
      subtype: "success",
      response: { still_queued: ["3f1b0c22-0000-4000-8000-000000000001"] },
    };

    const result = await harness.dispatcher.applyIntervention(buildCancelParams());

    // Reporting `applied` here would tell the daemon a participant's cancellation
    // took hold while messages it was meant to stop are still queued to run.
    expect(result).toStrictEqual({ status: "degraded" });
    expect(result.fallbackAction).toBeUndefined();
    expect(DriverInterventionResultSchema.safeParse(result).success).toBe(true);
  });

  it("applies a cancel whose receipt reports an empty survivor list", async () => {
    const harness = buildHarness();
    harness.channel.controlResponse = { subtype: "success", response: { still_queued: [] } };

    await expect(harness.dispatcher.applyIntervention(buildCancelParams())).resolves.toStrictEqual({
      status: "applied",
    });
  });

  it("applies a cancel on a build that advertises no receipt capability", async () => {
    const harness = buildHarness();
    harness.channel.controlResponse = { subtype: "success" };

    // Absent means "this build reported nothing", never "messages survived".
    // Degrading here would fail closed on a guarantee the build never made.
    await expect(harness.dispatcher.applyIntervention(buildCancelParams())).resolves.toStrictEqual({
      status: "applied",
    });
  });

  it("applies an interrupt that reports survivors — survival is what defines it", async () => {
    const harness = buildHarness();
    harness.channel.controlResponse = {
      subtype: "success",
      response: { still_queued: ["3f1b0c22-0000-4000-8000-000000000001"] },
    };

    // An interrupt is precisely the operation queued input is meant to outlive;
    // grading it the way a cancel is graded would degrade the normal path.
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

    // The payload crosses the provider trust boundary, so an unreadable receipt
    // must not turn a delivered cancel into an exception.
    await expect(harness.dispatcher.applyIntervention(buildCancelParams())).resolves.toStrictEqual({
      status: "applied",
    });
  });

  it("invents no client identifier on the dispatched control request (P0-3)", async () => {
    const harness = buildHarness();

    await harness.dispatcher.applyIntervention(buildCancelParams());

    // The pinned `interrupt` control request carries no client-supplied id, and
    // the transport's own `request_id` is correlation state a retry must vary —
    // so the key travels nowhere rather than into an unregistered wire field.
    expect(harness.channel.controlRequests).toStrictEqual([
      { subtype: "interrupt", cancelQueued: true },
    ]);
  });
});

describe("ClaudeInterventionDispatcher unrouted intervention types (I-005-4)", () => {
  it("degrades instead of throwing when an unrouted type reaches the dispatcher", async () => {
    const harness = buildHarness();
    // Reachable only from an untyped boundary: the compile-time half of this
    // guard is the `never` parameter that rejects a fourth arm at build time.
    const unroutedParams = {
      ...buildInterruptParams(),
      type: "pause",
    } as unknown as ApplyInterventionParams;

    const result = await harness.dispatcher.applyIntervention(unroutedParams);

    expect(result).toStrictEqual({ status: "degraded" });
    expect(harness.channel.outboundCallCount).toBe(0);
    expect(DriverInterventionResultSchema.safeParse(result).success).toBe(true);
  });

  it("answers the target run identically whether or not a channel is live", async () => {
    const dispatcher = buildDispatcherWithoutLiveRun();
    const unroutedParams = {
      ...buildInterruptParams(),
      targetRunId: TEST_RUN_ID,
      type: "pause",
    } as unknown as ApplyInterventionParams;

    await expect(dispatcher.applyIntervention(unroutedParams)).resolves.toStrictEqual({
      status: "degraded",
    });
  });
});
