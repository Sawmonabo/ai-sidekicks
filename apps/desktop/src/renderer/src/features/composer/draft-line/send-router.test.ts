// Resolution: what a body and a target would do before anything is sent. The same text routes
// differently by target, slash lines resolve alike on both, a provider entry is named rather
// than sent, and the daemon receives the user's own text.

import { describe, expect, it, vi } from "vitest";
import {
  SESSION_TARGET,
  PINNED_REQUEST_UUID,
  QUEUE_CREATED,
  RUN_ID,
  RUN_TARGET,
  SESSION_ID,
  STEER_APPLIED,
  routerWith,
} from "./send-router.test-support.js";

describe("ComposerSendRouter — Send is a router, not a verb", () => {
  it("routes a session-addressed message to the queue-create call", async () => {
    const call = vi.fn().mockResolvedValue(QUEUE_CREATED);
    const outcome = await routerWith(call).send("ship the fix", SESSION_TARGET);

    expect(outcome).toStrictEqual({ status: "sent", path: "session-message" });
    expect(call).toHaveBeenCalledWith("run.queueCreate", {
      sessionId: SESSION_ID,
      clientIdempotencyKey: PINNED_REQUEST_UUID,
      content: "ship the fix",
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
    // Nothing reached the wire, so the refusal is not a send that also complained.
    expect(call).not.toHaveBeenCalled();
  });
});

describe("ComposerSendRouter — the slash prefix", () => {
  it("resolves a slash line at a running turn as it does on an idle line", () => {
    // A registered word is intercepted and a published provider name is refused, on both
    // targets.
    const router = routerWith(vi.fn(), ["compact"], ["review"]);
    for (const line of ["/compact now", "/review"]) {
      expect(router.resolve(line, RUN_TARGET)).toStrictEqual(router.resolve(line, SESSION_TARGET));
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
    const outcome = await routerWith(call).send("/compact now", SESSION_TARGET);

    expect(outcome).toStrictEqual({ status: "sent", path: "session-message" });
    expect(call).toHaveBeenCalledWith("run.queueCreate", {
      sessionId: SESSION_ID,
      clientIdempotencyKey: PINNED_REQUEST_UUID,
      content: "/compact now",
    });
  });

  it("intercepts a registered command and composes it into nothing", async () => {
    const call = vi.fn().mockResolvedValue({});
    const outcome = await routerWith(call, ["compact"]).send("/compact now", SESSION_TARGET);

    expect(outcome).toStrictEqual({ status: "intercepted", commandName: "compact" });
    expect(call).not.toHaveBeenCalled();
  });

  it("sends a doubled slash exactly as typed, spacing included", async () => {
    const call = vi.fn().mockResolvedValue(QUEUE_CREATED);
    await routerWith(call, ["not-a-command"]).send("//not-a-command  \n", SESSION_TARGET);

    expect(call).toHaveBeenCalledWith("run.queueCreate", {
      sessionId: SESSION_ID,
      clientIdempotencyKey: PINNED_REQUEST_UUID,
      content: "//not-a-command  \n",
    });
  });
});

describe("ComposerSendRouter — an enumerated provider entry is named, never sent", () => {
  it("refuses a typed provider command as the discovery entry it is", async () => {
    // The popover listed `review`, so the send path names it rather than treating it as text.
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
    const resolution = routerWith(vi.fn(), [], ["review"]).resolve("/review", SESSION_TARGET);

    expect(resolution.outcome === "refused" && resolution.refusal.code).toBe(
      "provider-command-discovery-only",
    );
  });

  it("runs a console command whose name the provider also published", async () => {
    // The console's registry answers first; the discovery arm is for names it cannot run.
    const call = vi.fn().mockResolvedValue({});
    const outcome = await routerWith(call, ["compact"], ["compact"]).send(
      "/compact",
      SESSION_TARGET,
    );

    expect(outcome).toStrictEqual({ status: "intercepted", commandName: "compact" });
    expect(call).not.toHaveBeenCalled();
  });

  it("sends an unpublished, unregistered name as typed", () => {
    const resolution = routerWith(vi.fn(), [], ["review"]).resolve("/nothing", SESSION_TARGET);

    expect(resolution.outcome).toBe("new-turn");
  });

  it("does not read a doubled slash as the name the provider published", () => {
    const resolution = routerWith(vi.fn(), [], ["review"]).resolve("//review", SESSION_TARGET);

    expect(resolution.outcome).toBe("new-turn");
  });
});

describe("ComposerSendRouter — the daemon receives the text the user wrote", () => {
  // Indentation and a trailing blank line are load-bearing (a pasted block, a Markdown
  // paragraph break). The dispatched params are asserted, since two routers can resolve to the
  // same arm and send different bytes.
  const INDENTED_BODY = "  if (ready) {\n    ship();\n  }\n\n";

  it("queues a session message byte-identical, indentation and blank line included", async () => {
    const call = vi.fn().mockResolvedValue(QUEUE_CREATED);
    await routerWith(call).send(INDENTED_BODY, SESSION_TARGET);

    expect(call).toHaveBeenCalledWith("run.queueCreate", {
      sessionId: SESSION_ID,
      clientIdempotencyKey: PINNED_REQUEST_UUID,
      content: INDENTED_BODY,
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
    const outcome = await routerWith(call).send("  \n\t ", SESSION_TARGET);

    expect(outcome.status === "refused" && outcome.refusal.code).toBe("empty-message");
    expect(call).not.toHaveBeenCalled();
  });

  it("sends an indented line beginning with a slash as the prose it is", async () => {
    // A command opens its line, so an indented leading slash is prose.
    const call = vi.fn().mockResolvedValue(QUEUE_CREATED);
    const outcome = await routerWith(call, ["help"]).send("  /help me read this", SESSION_TARGET);

    expect(outcome).toStrictEqual({ status: "sent", path: "session-message" });
    expect(call).toHaveBeenCalledWith("run.queueCreate", {
      sessionId: SESSION_ID,
      clientIdempotencyKey: PINNED_REQUEST_UUID,
      content: "  /help me read this",
    });
  });

  it("negative control: the same name at the first byte is still a command", async () => {
    const call = vi.fn().mockResolvedValue({});
    const outcome = await routerWith(call, ["help"]).send("/help me read this", SESSION_TARGET);

    expect(outcome).toStrictEqual({ status: "intercepted", commandName: "help" });
    expect(call).not.toHaveBeenCalled();
  });
});

describe("ComposerSendRouter — one router, and identifiers the wire would accept", () => {
  it("refuses an identifier the registered schema rejects rather than round-tripping it", async () => {
    const call = vi.fn().mockResolvedValue({});
    const outcome = await routerWith(call).send("hello", {
      ...SESSION_TARGET,
      sessionId: "session-composer",
    });

    expect(outcome.status === "refused" && outcome.refusal.code).toBe("identifier-unparseable");
    expect(call).not.toHaveBeenCalled();
  });

  it("resolves and sends through the same decision, so no second router can disagree", async () => {
    const call = vi.fn().mockResolvedValue(QUEUE_CREATED);
    const router = routerWith(call);
    const resolution = router.resolve("one message", SESSION_TARGET);
    await router.send("one message", SESSION_TARGET);

    expect(resolution.outcome).toBe("new-turn");
    // The request the pure resolution built is byte-identical to the one dispatched; a second
    // resolution path fails here.
    expect(call.mock.calls[0]?.[1]).toStrictEqual(
      resolution.outcome === "new-turn" ? resolution.request : undefined,
    );
  });
});
