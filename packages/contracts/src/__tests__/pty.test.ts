// A session's shells cross from the daemon to every device that shows them, and
// the lease decides which of those devices may type. These tests hold the shapes
// the screen depends on: the list and output frames it draws from, the acts it
// sends, and the lease change it folds, whose holder must agree with its reason.
import { describe, expect, it } from "vitest";

import {
  PtyCloseRequestSchema,
  PtyControlChangedPayloadSchema,
  PtyControlHeldByOtherDetailsSchema,
  PtyListUpdateSchema,
  PtyOpenRequestSchema,
  PtyOutputFrameSchema,
  PtyReorderRequestSchema,
  PtyResizeRequestSchema,
  PtyWriteRequestSchema,
  SessionSetTerminalFlowControlRequestSchema,
  SessionTakeControlRequestSchema,
} from "../pty.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const PRESS_ID = "33333333-3333-4333-8333-333333333333";
const SHELL = { sessionId: SESSION_ID, terminalId: "term-1" };

describe("pty.list", () => {
  const running = {
    terminalId: "term-1",
    title: "zsh",
    status: { state: "running" },
    holder: null,
  };

  it("accepts the whole set, a run's hold and an exited shell among it", () => {
    const update = {
      sessionId: SESSION_ID,
      terminals: [
        { ...running, holder: { holderDeviceId: "laptop", holderRunId: RUN_ID } },
        {
          terminalId: "term-2",
          title: "pnpm dev",
          status: { state: "exited", exitCode: 1 },
          holder: null,
        },
      ],
    };
    expect(PtyListUpdateSchema.safeParse(update).success).toBe(true);
  });

  it("refuses a shell that did not start without the cause", () => {
    const update = {
      sessionId: SESSION_ID,
      terminals: [{ ...running, status: { state: "did_not_start" } }],
    };
    expect(PtyListUpdateSchema.safeParse(update).success).toBe(false);
  });

  it("refuses a set that lists one shell twice", () => {
    const update = { sessionId: SESSION_ID, terminals: [running, running] };
    expect(PtyListUpdateSchema.safeParse(update).success).toBe(false);
  });
});

describe("pty.open, pty.close, pty.reorder", () => {
  it("opens a shell with a key and nothing that picks the program", () => {
    const request = { sessionId: SESSION_ID, clientIdempotencyKey: PRESS_ID };
    expect(PtyOpenRequestSchema.safeParse(request).success).toBe(true);
    expect(PtyOpenRequestSchema.safeParse({ sessionId: SESSION_ID }).success).toBe(false);
    expect(PtyOpenRequestSchema.safeParse({ ...request, shell: "/bin/bash" }).success).toBe(false);
  });

  it("closes one shell, forced only when the person confirmed", () => {
    expect(PtyCloseRequestSchema.safeParse({ ...SHELL, force: true }).success).toBe(true);
    expect(PtyCloseRequestSchema.safeParse({ sessionId: SESSION_ID }).success).toBe(false);
  });

  it("refuses an order that names a shell twice", () => {
    expect(
      PtyReorderRequestSchema.safeParse({ sessionId: SESSION_ID, terminalIds: ["a", "b"] }).success,
    ).toBe(true);
    expect(
      PtyReorderRequestSchema.safeParse({ sessionId: SESSION_ID, terminalIds: ["a", "b", "a"] })
        .success,
    ).toBe(false);
  });
});

describe("pty.outputSubscribe frames", () => {
  it("accepts a replay at the last size with its holder, then output and the exit", () => {
    const replay = { kind: "replay", ...SHELL, data: "$ ", columns: 120, rows: 40, holder: null };
    expect(PtyOutputFrameSchema.safeParse(replay).success).toBe(true);
    expect(PtyOutputFrameSchema.safeParse({ kind: "output", ...SHELL, data: "ok\n" }).success).toBe(
      true,
    );
    expect(PtyOutputFrameSchema.safeParse({ kind: "exited", ...SHELL, exitCode: 0 }).success).toBe(
      true,
    );
  });

  it("refuses a replay that does not say who holds the shell", () => {
    const replay = { kind: "replay", ...SHELL, data: "", columns: 120, rows: 40 };
    expect(PtyOutputFrameSchema.safeParse(replay).success).toBe(false);
  });
});

describe("pty.write, pty.resize, session.setTerminalFlowControl", () => {
  it("writes keys or a paste, and nothing else", () => {
    expect(PtyWriteRequestSchema.safeParse({ ...SHELL, data: "ls\r", kind: "paste" }).success).toBe(
      true,
    );
    expect(PtyWriteRequestSchema.safeParse({ ...SHELL, data: "ls\r" }).success).toBe(false);
    expect(PtyWriteRequestSchema.safeParse({ ...SHELL, data: "ls\r", kind: "drop" }).success).toBe(
      false,
    );
  });

  it("refuses a size of zero cells", () => {
    expect(PtyResizeRequestSchema.safeParse({ ...SHELL, columns: 0, rows: 40 }).success).toBe(
      false,
    );
  });

  it("keys flow control by the shell", () => {
    expect(
      SessionSetTerminalFlowControlRequestSchema.safeParse({ ...SHELL, paused: true }).success,
    ).toBe(true);
    expect(
      SessionSetTerminalFlowControlRequestSchema.safeParse({ sessionId: SESSION_ID, paused: true })
        .success,
    ).toBe(false);
  });
});

describe("the per-shell lease", () => {
  it("takes one named shell, forced or not", () => {
    expect(SessionTakeControlRequestSchema.safeParse({ ...SHELL, force: true }).success).toBe(true);
    expect(SessionTakeControlRequestSchema.safeParse({ sessionId: SESSION_ID }).success).toBe(
      false,
    );
  });

  it("accepts a take by a device and a take by a run", () => {
    const byDevice = {
      ...SHELL,
      holderDeviceId: "desktop",
      previousHolderDeviceId: "laptop",
      reason: "taken",
    };
    expect(PtyControlChangedPayloadSchema.safeParse(byDevice).success).toBe(true);
    expect(
      PtyControlChangedPayloadSchema.safeParse({ ...byDevice, holderRunId: RUN_ID }).success,
    ).toBe(true);
  });

  it("refuses a take that names nobody", () => {
    const payload = {
      ...SHELL,
      holderDeviceId: null,
      previousHolderDeviceId: "laptop",
      reason: "taken",
    };
    expect(PtyControlChangedPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("refuses a release that names a holder or a run", () => {
    const release = {
      ...SHELL,
      holderDeviceId: null,
      previousHolderDeviceId: "laptop",
      reason: "auto_released_disconnect",
    };
    expect(PtyControlChangedPayloadSchema.safeParse(release).success).toBe(true);
    expect(
      PtyControlChangedPayloadSchema.safeParse({ ...release, holderDeviceId: "laptop" }).success,
    ).toBe(false);
    expect(
      PtyControlChangedPayloadSchema.safeParse({
        ...release,
        reason: "auto_released_run_idle",
        holderRunId: RUN_ID,
      }).success,
    ).toBe(false);
  });

  it("refuses the reasons a hold can no longer end by", () => {
    const payload = {
      ...SHELL,
      holderDeviceId: null,
      previousHolderDeviceId: "laptop",
      reason: "released",
    };
    expect(PtyControlChangedPayloadSchema.safeParse(payload).success).toBe(false);
    expect(
      PtyControlChangedPayloadSchema.safeParse({
        ...payload,
        reason: "auto_released_authorization_lost",
      }).success,
    ).toBe(false);
  });

  it("names a run's hold in the held-by-other refusal", () => {
    const details = { terminalId: "term-1", holderDeviceId: "laptop", holderRunId: RUN_ID };
    expect(PtyControlHeldByOtherDetailsSchema.safeParse(details).success).toBe(true);
    expect(
      PtyControlHeldByOtherDetailsSchema.safeParse({ terminalId: "term-1", holderRunId: RUN_ID })
        .success,
    ).toBe(false);
  });
});
