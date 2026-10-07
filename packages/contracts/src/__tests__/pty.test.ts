// A session's shells cross from the daemon to every device that shows them, and the lease decides
// which of those devices may type. A shell appears once in the list and in a tab order, a run's
// hold names its command, and a lease change's holder agrees with its reason.
import { describe, expect, it } from "vitest";

import {
  PtyControlChangedPayloadSchema,
  PtyControlHeldByOtherDetailsSchema,
  PtyListUpdateSchema,
  PtyReorderRequestSchema,
} from "../pty.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const COMMAND_ID = "command-1";
const RUN_HOLD = { holderRunId: RUN_ID, holderCommandId: COMMAND_ID };
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
        { ...running, holder: { holderDeviceId: "laptop", ...RUN_HOLD } },
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

  it("refuses a set that lists one shell twice", () => {
    const update = { sessionId: SESSION_ID, terminals: [running, running] };
    expect(PtyListUpdateSchema.safeParse(update).success).toBe(false);
  });
});

describe("pty.reorder", () => {
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

describe("the per-shell lease", () => {
  it("accepts a take by a device and a take by a run's command", () => {
    const byDevice = {
      ...SHELL,
      holderDeviceId: "desktop",
      previousHolderDeviceId: "laptop",
      reason: "taken",
    };
    expect(PtyControlChangedPayloadSchema.safeParse(byDevice).success).toBe(true);
    expect(PtyControlChangedPayloadSchema.safeParse({ ...byDevice, ...RUN_HOLD }).success).toBe(
      true,
    );
  });

  it("refuses a run's hold that does not name the run and its command together", () => {
    const byRun = {
      ...SHELL,
      holderDeviceId: "desktop",
      previousHolderDeviceId: null,
      reason: "taken",
    };
    const shellHolder = { holderDeviceId: "desktop" };
    const heldByOther = { terminalId: "term-1", holderDeviceId: "desktop" };
    for (const half of [{ holderRunId: RUN_ID }, { holderCommandId: COMMAND_ID }]) {
      expect(PtyControlChangedPayloadSchema.safeParse({ ...byRun, ...half }).success).toBe(false);
      expect(
        PtyControlHeldByOtherDetailsSchema.safeParse({ ...heldByOther, ...half }).success,
      ).toBe(false);
      const update = {
        sessionId: SESSION_ID,
        terminals: [
          {
            terminalId: "term-1",
            title: "zsh",
            status: { state: "running" },
            holder: { ...shellHolder, ...half },
          },
        ],
      };
      expect(PtyListUpdateSchema.safeParse(update).success).toBe(false);
    }
  });

  it("accepts a forced take off another device, and refuses one off nobody or by a run", () => {
    const forced = {
      ...SHELL,
      holderDeviceId: "desktop",
      previousHolderDeviceId: "laptop",
      reason: "taken_by_force",
    };
    expect(PtyControlChangedPayloadSchema.safeParse(forced).success).toBe(true);
    expect(
      PtyControlChangedPayloadSchema.safeParse({ ...forced, previousHolderDeviceId: null }).success,
    ).toBe(false);
    expect(PtyControlChangedPayloadSchema.safeParse({ ...forced, ...RUN_HOLD }).success).toBe(
      false,
    );
    expect(
      PtyControlChangedPayloadSchema.safeParse({ ...forced, holderDeviceId: null }).success,
    ).toBe(false);
  });

  it("holds each take and release to the holders its reason names, a hand-back among them", () => {
    const payload = {
      ...SHELL,
      holderDeviceId: null,
      previousHolderDeviceId: "laptop",
      reason: "taken",
    };
    expect(PtyControlChangedPayloadSchema.safeParse(payload).success).toBe(false);

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
      PtyControlChangedPayloadSchema.safeParse({ ...release, previousHolderDeviceId: null })
        .success,
    ).toBe(false);
    for (const reason of ["auto_released_command_ended", "auto_released_run_idle"]) {
      const runRelease = { ...release, previousHolderDeviceId: "desktop", reason };
      expect(PtyControlChangedPayloadSchema.safeParse(runRelease).success).toBe(true);
      // The hand-back to the device the run took the shell from.
      expect(
        PtyControlChangedPayloadSchema.safeParse({ ...runRelease, holderDeviceId: "laptop" })
          .success,
      ).toBe(true);
      expect(
        PtyControlChangedPayloadSchema.safeParse({
          ...runRelease,
          holderDeviceId: "desktop",
          ...RUN_HOLD,
        }).success,
      ).toBe(false);
    }
  });

  it("names a run's hold in the held-by-other refusal", () => {
    const details = { terminalId: "term-1", holderDeviceId: "laptop", ...RUN_HOLD };
    expect(PtyControlHeldByOtherDetailsSchema.safeParse(details).success).toBe(true);
    expect(
      PtyControlHeldByOtherDetailsSchema.safeParse({ terminalId: "term-1", ...RUN_HOLD }).success,
    ).toBe(false);
  });
});
