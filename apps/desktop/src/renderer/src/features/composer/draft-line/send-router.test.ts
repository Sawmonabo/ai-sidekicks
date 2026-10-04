// Resolution: what a body and a target would do before anything is sent. The same text routes
// differently by target, a registered slash command is intercepted, a slash word on no list and a
// doubled slash are sent as typed, a provider entry is named rather than sent, and the daemon
// receives the user's own text.

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

  it(
    "routes a run-addressed message to the steer intervention, with " + "the read comparand",
    async () => {
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
    },
  );

  it(
    "refuses a steer whose run version has not been read, rather " + "than sending a zero",
    async () => {
      const call = vi.fn().mockResolvedValue({});
      const outcome = await routerWith(call).send("steer me", {
        ...RUN_TARGET,
        expectedRunVersion: undefined,
      });

      expect(outcome.status).toBe("refused");
      expect(outcome.status === "refused" && outcome.refusal.code).toBe("run-version-unread");
      // Nothing reached the wire, so the refusal is not a send that also complained.
      expect(call).not.toHaveBeenCalled();
    },
  );
});

describe("ComposerSendRouter — the slash prefix", () => {
  it("intercepts a registered command and composes it into nothing", async () => {
    const call = vi.fn().mockResolvedValue({});
    const outcome = await routerWith(call, ["compact"]).send("/compact now", SESSION_TARGET);

    expect(outcome).toStrictEqual({ status: "intercepted", commandName: "compact" });
    expect(call).not.toHaveBeenCalled();
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

  it("sends a doubled slash exactly as typed, spacing included", async () => {
    // There is no escape: a doubled slash names no command and goes out untouched.
    const call = vi.fn().mockResolvedValue(QUEUE_CREATED);
    await routerWith(call, ["not-a-command"]).send("//not-a-command  \n", SESSION_TARGET);

    expect(call).toHaveBeenCalledWith("run.queueCreate", {
      sessionId: SESSION_ID,
      clientIdempotencyKey: PINNED_REQUEST_UUID,
      content: "//not-a-command  \n",
    });
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
});
