// The router's four resolutions, both slash paths, and the two negative controls
// this lane owes.
//
// Everything below drives the REAL router against REAL contract shapes. The wire ids
// are genuine UUIDs because the registered schemas parse them — a test that used
// friendly strings would be asserting against a refusal it caused itself, and would
// go green for the wrong reason the moment the parse was removed.

import { describe, expect, it, vi } from "vitest";

import type { ConsoleBridge } from "../../../console/bridge/index.js";
import type { ComposerChannelTarget, ComposerRunTarget } from "../chips/chip-models.js";
import { COMPOSER_REFUSAL_CODES } from "./send-refusals.js";
import { ComposerSendRouter } from "./send-router.js";

const SESSION_ID = "8f1c2c3e-5c6a-4a19-9f5f-1d2b3c4d5e6f";
const CHANNEL_ID = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";
const RUN_ID = "2b3c4d5e-6f7a-4b1c-9d2e-4f5a6b7c8d9e";
const PINNED_REQUEST_UUID = "3c4d5e6f-7a8b-4c1d-8e2f-5a6b7c8d9e0f";
const INTERVENTION_ID = "4d5e6f7a-8b9c-4d1e-8f2a-6b7c8d9e0f1a";

/**
 * One registered `run.intervene` response, in the shape the wire actually admits.
 *
 * The steer arm and not a bare `{}`: the router parses this reply, so a stand-in
 * that did not parse would put every case below on the unreadable arm and prove
 * nothing about the state the daemon reported.
 */
function interventionResponse(
  state: string,
  runVersion: number,
  extra: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    interventionId: INTERVENTION_ID,
    interventionType: "steer",
    state,
    runVersion,
    ...extra,
  };
}

/** The ordinary answer: the run took the steer and its version moved on. */
const STEER_APPLIED = interventionResponse("applied", 8);

const CHANNEL_TARGET: ComposerChannelTarget = {
  path: "channel-message",
  sessionId: SESSION_ID,
  channelId: CHANNEL_ID,
  workspaceId: undefined,
  channelLabel: "main",
};

const RUN_TARGET: ComposerRunTarget = {
  path: "provider-bound",
  sessionId: SESSION_ID,
  agentId: "agent-implementer",
  agentName: "Ada",
  driverName: "claude",
  targetRunId: RUN_ID,
  expectedRunVersion: 7,
  runState: "running",
  providerFailureDetail: undefined,
};

/** A bridge whose only live member is the daemon call, recorded for assertion. */
function bridgeRecording(call: ReturnType<typeof vi.fn>): ConsoleBridge {
  return {
    sidekicks: { daemon: { call } },
    growth: {},
    source: "fixture",
    scenarioEngine: undefined,
  } as unknown as ConsoleBridge;
}

function routerWith(
  call: ReturnType<typeof vi.fn>,
  recognized: readonly string[] = [],
  published: readonly string[] = [],
) {
  return new ComposerSendRouter({
    bridge: bridgeRecording(call),
    recognizeClientCommand: (name) => recognized.includes(name),
    recognizeProviderCommand: (name) =>
      published.includes(name)
        ? { name, kind: "command" as const, driverName: "claude" }
        : undefined,
    mintIdempotencyKey: () => PINNED_REQUEST_UUID,
  });
}

describe("ComposerSendRouter — a fulfilled intervention is not a successful send", () => {
  it("keeps the message for a steer the run rejected, and renders the daemon's cause", async () => {
    // The finding: fulfilment was treated as success, so a normally rejected steer
    // cleared the participant's draft as if it had landed. The draft is the send
    // bar's to clear and it clears on `sent` alone, so a refusal here is what keeps
    // the words in the line.
    const call = vi
      .fn()
      .mockResolvedValue(
        interventionResponse("rejected", 7, { rejectionReason: "run.invalid_transition" }),
      );
    const outcome = await routerWith(call).send("try the other branch", RUN_TARGET);

    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.refusal.origin).toBe("daemon");
    // The response's own machine-readable cause, in the slot the console renders in
    // mono — never a category this module invented for it.
    expect(outcome.status === "refused" && outcome.refusal.code).toBe("run.invalid_transition");
  });

  it("names the lifecycle state where the response carried no cause", async () => {
    // `rejectionReason` is optional on the steer arm, and an absent one still leaves
    // the daemon's own word for what happened.
    const call = vi.fn().mockResolvedValue(interventionResponse("expired", 11));
    const outcome = await routerWith(call).send("steer me", RUN_TARGET);

    expect(outcome.status === "refused" && outcome.refusal.code).toBe("expired");
  });

  it("negative control: the same call answering `applied` is a send", async () => {
    // Without this the cases above would hold over a router that had started
    // refusing every steer.
    const call = vi.fn().mockResolvedValue(STEER_APPLIED);
    const outcome = await routerWith(call).send("try the other branch", RUN_TARGET);

    expect(outcome).toStrictEqual({ status: "sent", path: "provider-bound" });
  });

  it("treats the two fallback states as sends, because the message travelled", async () => {
    // `accepted` is the daemon's admission and `degraded` is the orchestration layer
    // having fallen back — the transition table puts both on the path where the run
    // takes the message, so keeping the draft would invite a duplicate steer.
    for (const state of ["requested", "accepted", "degraded"]) {
      const call = vi.fn().mockResolvedValue(interventionResponse(state, 8));
      const outcome = await routerWith(call).send("try the other branch", RUN_TARGET);
      expect(outcome).toStrictEqual({ status: "sent", path: "provider-bound" });
    }
  });

  it("keeps the message where the answer did not parse as the registered response", async () => {
    // The call was answered and the answer is unreadable, so the console cannot
    // confirm the steer reached the run. Losing the participant's words to that
    // ambiguity is worse than letting them decide to send again.
    const call = vi.fn().mockResolvedValue({ state: "applied" });
    const outcome = await routerWith(call).send("try the other branch", RUN_TARGET);

    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.refusal.code).toBe("intervention-unreadable");
  });
});

describe("ComposerSendRouter — the next steer is guarded with the answer's own version", () => {
  it("sends the version the last intervention answered with", async () => {
    // An applied native steer advances the run version with no state event to
    // broadcast it, so the store's projection stays at 7 and every later steer under
    // it would be refused as stale. The response is the only place the fresh
    // comparand exists, and this is what keeps it.
    const call = vi.fn().mockResolvedValue(STEER_APPLIED);
    const router = routerWith(call);

    await router.send("first", RUN_TARGET);
    await router.send("second", RUN_TARGET);

    expect(call.mock.calls[0]?.[1]).toMatchObject({ expectedRunVersion: 7 });
    expect(call.mock.calls[1]?.[1]).toMatchObject({ expectedRunVersion: 8 });
  });

  it("keeps the version a refusal answered with, so the retry is guarded", async () => {
    // The reject-re-read-retry loop, closed without a re-read: a refused
    // intervention still answers with the run's current version.
    const call = vi
      .fn()
      .mockResolvedValueOnce(interventionResponse("expired", 12))
      .mockResolvedValue(STEER_APPLIED);
    const router = routerWith(call);

    await router.send("first", RUN_TARGET);
    await router.send("second", RUN_TARGET);

    expect(call.mock.calls[1]?.[1]).toMatchObject({ expectedRunVersion: 12 });
  });

  it("negative control: a projection ahead of the answer is the one that is sent", async () => {
    // The run advances through its own state stream with no control pressed, so
    // preferring the kept answer unconditionally would pin every later steer to the
    // version the last settlement saw — and a refusal carries no way back.
    const call = vi.fn().mockResolvedValue(interventionResponse("applied", 8));
    const router = routerWith(call);

    await router.send("first", RUN_TARGET);
    await router.send("second", { ...RUN_TARGET, expectedRunVersion: 40 });

    expect(call.mock.calls[1]?.[1]).toMatchObject({ expectedRunVersion: 40 });
  });

  it("guards a steer the store has never projected a version for", async () => {
    // Without a projection the router refuses; with an answer kept from an earlier
    // intervention there is a comparand, and it is a wire figure rather than a zero
    // this module invented.
    const call = vi.fn().mockResolvedValue(STEER_APPLIED);
    const router = routerWith(call);

    await router.send("first", RUN_TARGET);
    const outcome = await router.send("second", { ...RUN_TARGET, expectedRunVersion: undefined });

    expect(outcome.status).toBe("sent");
    expect(call.mock.calls[1]?.[1]).toMatchObject({ expectedRunVersion: 8 });
  });

  it("negative control: with no answer kept, an unprojected run still refuses", async () => {
    const call = vi.fn().mockResolvedValue(STEER_APPLIED);
    const outcome = await routerWith(call).send("steer me", {
      ...RUN_TARGET,
      expectedRunVersion: undefined,
    });

    expect(outcome.status === "refused" && outcome.refusal.code).toBe("run-version-unread");
    expect(call).not.toHaveBeenCalled();
  });
});

describe("ComposerSendRouter — Send is a router, not a verb", () => {
  it("routes a channel-addressed message to the queue-create call", async () => {
    const call = vi.fn().mockResolvedValue({});
    const outcome = await routerWith(call).send("ship the fix", CHANNEL_TARGET);

    expect(outcome).toStrictEqual({ status: "sent", path: "channel-message" });
    expect(call).toHaveBeenCalledWith("run.queueCreate", {
      sessionId: SESSION_ID,
      channelId: CHANNEL_ID,
      payload: { content: "ship the fix" },
    });
  });

  it("routes a run-addressed message to the steer intervention, with the read comparand", async () => {
    const call = vi.fn().mockResolvedValue(STEER_APPLIED);
    const outcome = await routerWith(call).send("try the other branch", RUN_TARGET);

    expect(outcome).toStrictEqual({ status: "sent", path: "provider-bound" });
    expect(call).toHaveBeenCalledWith("run.intervene", {
      type: "steer",
      targetRunId: RUN_ID,
      expectedRunVersion: 7,
      clientIdempotencyKey: PINNED_REQUEST_UUID,
      content: "try the other branch",
    });
  });

  it("refuses a steer whose run version has not been read, rather than sending a zero", async () => {
    const call = vi.fn().mockResolvedValue({});
    const outcome = await routerWith(call).send("steer me", {
      ...RUN_TARGET,
      expectedRunVersion: undefined,
    });

    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.refusal.code).toBe("run-version-unread");
    // The negative control for the clean send above: nothing reached the wire, so
    // the refusal is a refusal and not a send that also complained.
    expect(call).not.toHaveBeenCalled();
  });

  it("stops the addressed run through the interrupt call and never derives the cut", async () => {
    const call = vi.fn().mockResolvedValue({});
    const outcome = await routerWith(call).stop(RUN_TARGET);

    expect(outcome).toStrictEqual({ status: "sent", path: "provider-bound" });
    expect(call).toHaveBeenCalledWith("driver.interruptRun", { runId: RUN_ID });
  });
});

describe("ComposerSendRouter — the reserved slash prefix, on both paths", () => {
  it("never sends a leading-slash message as prose on either path", async () => {
    const call = vi.fn().mockResolvedValue({});
    const router = routerWith(call);

    const onChannel = await router.send("/compact now", CHANNEL_TARGET);
    const onRun = await router.send("/compact now", RUN_TARGET);

    expect(onChannel.status).toBe("refused");
    expect(onRun.status).toBe("refused");
    // The lane's own claim, asserted rather than described: no command text of any
    // shape reaches the wire through the composer.
    expect(call).not.toHaveBeenCalled();
  });

  it("intercepts a registered command and composes it into nothing", async () => {
    const call = vi.fn().mockResolvedValue({});
    const outcome = await routerWith(call, ["compact"]).send("/compact now", CHANNEL_TARGET);

    expect(outcome).toStrictEqual({ status: "intercepted", commandName: "compact" });
    expect(call).not.toHaveBeenCalled();
  });

  it("escapes a doubled slash to one literal slash on the channel path", async () => {
    const call = vi.fn().mockResolvedValue({});
    await routerWith(call).send("//not-a-command", CHANNEL_TARGET);

    expect(call).toHaveBeenCalledWith("run.queueCreate", {
      sessionId: SESSION_ID,
      channelId: CHANNEL_ID,
      payload: { content: "/not-a-command" },
    });
  });

  it("keeps the loud refusal on the provider-bound path even for the escape", async () => {
    const call = vi.fn().mockResolvedValue({});
    const outcome = await routerWith(call, ["compact"]).send("//still no", RUN_TARGET);

    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.refusal.code).toBe("slash-prefix-unsupported");
    // The copy names the remedy and carries no internal id — the design's own rule.
    expect(outcome.status === "refused" && outcome.refusal.detail).not.toMatch(/[A-Z]{2,}-\d/u);
    expect(call).not.toHaveBeenCalled();
  });

  it("names the escape when a leading slash matches no registered command", () => {
    const resolution = routerWith(vi.fn()).resolve("/unknown", CHANNEL_TARGET);

    expect(resolution.outcome).toBe("refused");
    expect(resolution.outcome === "refused" && resolution.refusal.detail).toContain("//");
  });
});

describe("ComposerSendRouter — an enumerated provider entry is named, never sent", () => {
  it("refuses a typed provider command as the discovery entry it is", async () => {
    // The gap this closes: the popover listed `review` and the send path answered
    // "remove the leading slash, or address this message to the channel instead" —
    // advice for text that is not a command, given to somebody who typed one the
    // console itself had just shown them. Neither remedy runs it.
    const call = vi.fn().mockResolvedValue({});
    const outcome = await routerWith(call, [], ["review"]).send("/review", RUN_TARGET);

    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.refusal.code).toBe(
      "provider-command-discovery-only",
    );
    expect(outcome.status === "refused" && outcome.refusal.detail).toContain("review");
    expect(outcome.status === "refused" && outcome.refusal.detail).toContain("claude");
    expect(call).not.toHaveBeenCalled();
  });

  it("negative control: with no enumeration read, the same line keeps the old refusal", async () => {
    const call = vi.fn().mockResolvedValue({});
    const outcome = await routerWith(call).send("/review", RUN_TARGET);

    expect(outcome.status === "refused" && outcome.refusal.code).toBe("slash-prefix-unsupported");
  });

  it("names a published entry on the channel path too, rather than calling it unknown", () => {
    const resolution = routerWith(vi.fn(), [], ["review"]).resolve("/review", CHANNEL_TARGET);

    expect(resolution.outcome === "refused" && resolution.refusal.code).toBe(
      "provider-command-discovery-only",
    );
  });

  it("runs a console command whose name the provider also published", async () => {
    // The console's own registry answers first: a name this client can run is run,
    // and the discovery arm is what a name it cannot run falls through to.
    const call = vi.fn().mockResolvedValue({});
    const outcome = await routerWith(call, ["compact"], ["compact"]).send(
      "/compact",
      CHANNEL_TARGET,
    );

    expect(outcome).toStrictEqual({ status: "intercepted", commandName: "compact" });
    expect(call).not.toHaveBeenCalled();
  });

  it("keeps an unpublished, unregistered name at the unknown-command refusal", () => {
    const resolution = routerWith(vi.fn(), [], ["review"]).resolve("/nothing", CHANNEL_TARGET);

    expect(resolution.outcome === "refused" && resolution.refusal.code).toBe("unknown-command");
  });

  it("leaves the literal-slash escape an escape, whatever the provider published", () => {
    const resolution = routerWith(vi.fn(), [], ["review"]).resolve("//review", CHANNEL_TARGET);

    expect(resolution.outcome).toBe("new-turn");
  });
});

describe("ComposerSendRouter — the daemon receives the text the participant wrote", () => {
  // Indentation and a trailing blank line, both load-bearing: this is what a pasted
  // block and a deliberately separated Markdown paragraph look like. The negative
  // control in every case is the dispatched params rather than the resolution label,
  // because the old router resolved to the same arm and sent different bytes.
  const INDENTED_BODY = "  if (ready) {\n    ship();\n  }\n\n";

  it("queues a channel message byte-identical, indentation and blank line included", async () => {
    const call = vi.fn().mockResolvedValue({});
    await routerWith(call).send(INDENTED_BODY, CHANNEL_TARGET);

    expect(call).toHaveBeenCalledWith("run.queueCreate", {
      sessionId: SESSION_ID,
      channelId: CHANNEL_ID,
      payload: { content: INDENTED_BODY },
    });
  });

  it("steers with the same bytes, so the running turn reads what was typed", async () => {
    const call = vi.fn().mockResolvedValue({});
    await routerWith(call).send(INDENTED_BODY, RUN_TARGET);

    expect(call).toHaveBeenCalledWith("run.intervene", {
      type: "steer",
      targetRunId: RUN_ID,
      expectedRunVersion: 7,
      clientIdempotencyKey: PINNED_REQUEST_UUID,
      content: INDENTED_BODY,
    });
  });

  it("still refuses a body that is only whitespace, because blankness is a test", async () => {
    const call = vi.fn().mockResolvedValue({});
    const outcome = await routerWith(call).send("  \n\t ", CHANNEL_TARGET);

    expect(outcome.status === "refused" && outcome.refusal.code).toBe("empty-message");
    expect(call).not.toHaveBeenCalled();
  });

  it("sends an indented line beginning with a slash as the prose it is", async () => {
    // The narrowing the raw read buys: a command opens its line. Pasted code whose
    // first non-blank character is a slash used to be refused as an unknown command.
    const call = vi.fn().mockResolvedValue({});
    const outcome = await routerWith(call, ["help"]).send("  /help me read this", CHANNEL_TARGET);

    expect(outcome).toStrictEqual({ status: "sent", path: "channel-message" });
    expect(call).toHaveBeenCalledWith("run.queueCreate", {
      sessionId: SESSION_ID,
      channelId: CHANNEL_ID,
      payload: { content: "  /help me read this" },
    });
  });

  it("negative control: the same name at the first byte is still a command", async () => {
    const call = vi.fn().mockResolvedValue({});
    const outcome = await routerWith(call, ["help"]).send("/help me read this", CHANNEL_TARGET);

    expect(outcome).toStrictEqual({ status: "intercepted", commandName: "help" });
    expect(call).not.toHaveBeenCalled();
  });

  it("strips exactly the escape and leaves the participant's spacing alone", async () => {
    const call = vi.fn().mockResolvedValue({});
    await routerWith(call).send("//literal  \n", CHANNEL_TARGET);

    expect(call).toHaveBeenCalledWith("run.queueCreate", {
      sessionId: SESSION_ID,
      channelId: CHANNEL_ID,
      payload: { content: "/literal  \n" },
    });
  });
});

describe("ComposerSendRouter — a daemon refusal is carried, never paraphrased", () => {
  it("renders the daemon's own code and message", async () => {
    const call = vi
      .fn()
      .mockRejectedValue({ code: "run.version_conflict", message: "the run moved on" });
    const outcome = await routerWith(call).send("go", RUN_TARGET);

    expect(outcome).toStrictEqual({
      status: "refused",
      refusal: {
        origin: "daemon",
        code: "run.version_conflict",
        detail: "the run moved on",
      },
    });
    // The negative control: the carried code is NOT one the composer mints, so a
    // console-side translation table would have had to invent it.
    expect(COMPOSER_REFUSAL_CODES).not.toContain(
      outcome.status === "refused" && outcome.refusal.code,
    );
  });

  it("renders an envelope-less rejection as what it was, not as a sentence of its own", async () => {
    const call = vi.fn().mockRejectedValue("socket closed");
    const outcome = await routerWith(call).send("go", CHANNEL_TARGET);

    expect(outcome.status === "refused" && outcome.refusal.code).toBe("rejected");
    expect(outcome.status === "refused" && outcome.refusal.detail).toBe("socket closed");
  });
});

describe("ComposerSendRouter — one router, and identifiers the wire would accept", () => {
  it("refuses an identifier the registered schema rejects rather than round-tripping it", async () => {
    const call = vi.fn().mockResolvedValue({});
    const outcome = await routerWith(call).send("hello", {
      ...CHANNEL_TARGET,
      sessionId: "session-composer",
    });

    expect(outcome.status === "refused" && outcome.refusal.code).toBe("identifier-unparseable");
    expect(call).not.toHaveBeenCalled();
  });

  it("resolves and sends through the same decision, so no second router can disagree", async () => {
    const call = vi.fn().mockResolvedValue({});
    const router = routerWith(call);
    const resolution = router.resolve("one message", CHANNEL_TARGET);
    await router.send("one message", CHANNEL_TARGET);

    expect(resolution.outcome).toBe("new-turn");
    // The negative control for "one router": the request the pure resolution built
    // is byte-identical to the one the dispatch sent. A second resolution path —
    // the surface building its own request beside `resolve` — fails here.
    expect(call.mock.calls[0]?.[1]).toStrictEqual(
      resolution.outcome === "new-turn" ? resolution.request : undefined,
    );
  });
});
