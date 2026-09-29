// Resolution: what a body and a target WOULD do, before anything is sent.
//
// Send is a router rather than a verb, which is the claim every case here reads:
// the same text resolves differently by target, a slash line resolves the same at a
// running turn as on an idle line, an enumerated provider entry is named rather than
// sent, and the text that reaches the daemon is the text the user wrote.

import { describe, expect, it, vi } from "vitest";
import {
  CHANNEL_TARGET,
  PINNED_REQUEST_UUID,
  QUEUE_CREATED,
  RUN_ID,
  RUN_TARGET,
  SESSION_ID,
  STEER_APPLIED,
  routerWith,
} from "./send-router.test-support.js";

describe("ComposerSendRouter — Send is a router, not a verb", () => {
  it("routes a channel-addressed message to the queue-create call", async () => {
    const call = vi.fn().mockResolvedValue(QUEUE_CREATED);
    const outcome = await routerWith(call).send("ship the fix", CHANNEL_TARGET);

    expect(outcome).toStrictEqual({ status: "sent", path: "channel-message" });
    expect(call).toHaveBeenCalledWith("run.queueCreate", {
      sessionId: SESSION_ID,
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
});

describe("ComposerSendRouter — the slash prefix", () => {
  it("resolves a slash line at a running turn as it does on an idle line", () => {
    // A recognised console word is intercepted and a published provider name is named
    // in a refusal, on both targets: the running turn adds no rule of its own.
    const router = routerWith(vi.fn(), ["compact"], ["review"]);
    for (const line of ["/compact now", "/review"]) {
      expect(router.resolve(line, RUN_TARGET)).toStrictEqual(router.resolve(line, CHANNEL_TARGET));
    }
  });

  it("sends a slash word on no list to a running turn as typed", async () => {
    const call = vi.fn().mockResolvedValue(STEER_APPLIED);
    const outcome = await routerWith(call).send("/compact now", RUN_TARGET);

    expect(outcome).toStrictEqual({ status: "sent", path: "provider-bound" });
    expect(call).toHaveBeenCalledWith("run.intervene", {
      type: "steer",
      targetRunId: RUN_ID,
      expectedRunVersion: 7,
      clientIdempotencyKey: PINNED_REQUEST_UUID,
      content: "/compact now",
    });
  });

  it("sends a slash word on no list as typed on a new turn", async () => {
    const call = vi.fn().mockResolvedValue(QUEUE_CREATED);
    const outcome = await routerWith(call).send("/compact now", CHANNEL_TARGET);

    expect(outcome).toStrictEqual({ status: "sent", path: "channel-message" });
    expect(call).toHaveBeenCalledWith("run.queueCreate", {
      sessionId: SESSION_ID,
      payload: { content: "/compact now" },
    });
  });

  it("intercepts a registered command and composes it into nothing", async () => {
    const call = vi.fn().mockResolvedValue({});
    const outcome = await routerWith(call, ["compact"]).send("/compact now", CHANNEL_TARGET);

    expect(outcome).toStrictEqual({ status: "intercepted", commandName: "compact" });
    expect(call).not.toHaveBeenCalled();
  });

  it("sends a doubled slash exactly as typed, spacing included", async () => {
    const call = vi.fn().mockResolvedValue(QUEUE_CREATED);
    await routerWith(call, ["not-a-command"]).send("//not-a-command  \n", CHANNEL_TARGET);

    expect(call).toHaveBeenCalledWith("run.queueCreate", {
      sessionId: SESSION_ID,
      payload: { content: "//not-a-command  \n" },
    });
  });
});

describe("ComposerSendRouter — an enumerated provider entry is named, never sent", () => {
  it("refuses a typed provider command as the discovery entry it is", async () => {
    // The popover listed `review`, so the send path names the entry the person typed
    // rather than treating it as text.
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

  it("negative control: with no enumeration read, the same line is sent as typed", () => {
    const resolution = routerWith(vi.fn()).resolve("/review", RUN_TARGET);

    expect(resolution.outcome).toBe("steer");
  });

  it("names a published entry on a new turn too, rather than sending it", () => {
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

  it("sends an unpublished, unregistered name as typed", () => {
    const resolution = routerWith(vi.fn(), [], ["review"]).resolve("/nothing", CHANNEL_TARGET);

    expect(resolution.outcome).toBe("new-turn");
  });

  it("does not read a doubled slash as the name the provider published", () => {
    const resolution = routerWith(vi.fn(), [], ["review"]).resolve("//review", CHANNEL_TARGET);

    expect(resolution.outcome).toBe("new-turn");
  });
});

describe("ComposerSendRouter — the daemon receives the text the user wrote", () => {
  // Indentation and a trailing blank line, both load-bearing: this is what a pasted
  // block and a deliberately separated Markdown paragraph look like. The negative
  // control in every case is the dispatched params rather than the resolution label,
  // because two routers can resolve to the same arm and send different bytes.
  const INDENTED_BODY = "  if (ready) {\n    ship();\n  }\n\n";

  it("queues a channel message byte-identical, indentation and blank line included", async () => {
    const call = vi.fn().mockResolvedValue(QUEUE_CREATED);
    await routerWith(call).send(INDENTED_BODY, CHANNEL_TARGET);

    expect(call).toHaveBeenCalledWith("run.queueCreate", {
      sessionId: SESSION_ID,
      payload: { content: INDENTED_BODY },
    });
  });

  it("steers with the same bytes, so the running turn reads what was typed", async () => {
    const call = vi.fn().mockResolvedValue(STEER_APPLIED);
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
    // A command opens its line, so pasted code whose first non-blank character is a
    // slash is prose.
    const call = vi.fn().mockResolvedValue(QUEUE_CREATED);
    const outcome = await routerWith(call, ["help"]).send("  /help me read this", CHANNEL_TARGET);

    expect(outcome).toStrictEqual({ status: "sent", path: "channel-message" });
    expect(call).toHaveBeenCalledWith("run.queueCreate", {
      sessionId: SESSION_ID,
      payload: { content: "  /help me read this" },
    });
  });

  it("negative control: the same name at the first byte is still a command", async () => {
    const call = vi.fn().mockResolvedValue({});
    const outcome = await routerWith(call, ["help"]).send("/help me read this", CHANNEL_TARGET);

    expect(outcome).toStrictEqual({ status: "intercepted", commandName: "help" });
    expect(call).not.toHaveBeenCalled();
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
    const call = vi.fn().mockResolvedValue(QUEUE_CREATED);
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
