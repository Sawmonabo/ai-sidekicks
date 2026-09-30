// The running commands cross from the daemon to every device, and the acts on them
// cross back. These tests hold the frames the working line's list draws from, the
// input a waiting command accepts, and the stored ending a reload settles a row by.
import { describe, expect, it } from "vitest";

import {
  CommandEndedPayloadSchema,
  CommandListFrameSchema,
  CommandStopRequestSchema,
  CommandWriteRequestSchema,
} from "../command.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const COMMAND = { sessionId: SESSION_ID, commandId: "cmd-1" };

describe("command.list frames", () => {
  const running = {
    commandId: "cmd-1",
    runId: RUN_ID,
    name: "pnpm test",
    startedAt: "2026-09-29T18:00:00Z",
    waitingInForeground: false,
    waitingForInput: true,
  };

  it("accepts the whole set and a piece of one command's output", () => {
    expect(
      CommandListFrameSchema.safeParse({
        kind: "commands",
        sessionId: SESSION_ID,
        commands: [running],
      }).success,
    ).toBe(true);
    expect(
      CommandListFrameSchema.safeParse({ kind: "output", ...COMMAND, data: "PASS\n" }).success,
    ).toBe(true);
  });

  it("refuses a set that lists one command twice", () => {
    const frame = { kind: "commands", sessionId: SESSION_ID, commands: [running, running] };
    expect(CommandListFrameSchema.safeParse(frame).success).toBe(false);
  });

  it("refuses a command that does not say whether it waits on its input", () => {
    const { waitingForInput: _omitted, ...withoutWaiting } = running;
    const frame = { kind: "commands", sessionId: SESSION_ID, commands: [withoutWaiting] };
    expect(CommandListFrameSchema.safeParse(frame).success).toBe(false);
  });
});

describe("command.stop", () => {
  it("names one command and never sweeps", () => {
    expect(CommandStopRequestSchema.safeParse(COMMAND).success).toBe(true);
    expect(CommandStopRequestSchema.safeParse({ sessionId: SESSION_ID }).success).toBe(false);
  });
});

describe("command.write", () => {
  it("accepts typed text, the end of input, or both", () => {
    expect(CommandWriteRequestSchema.safeParse({ ...COMMAND, text: "y\n" }).success).toBe(true);
    expect(CommandWriteRequestSchema.safeParse({ ...COMMAND, endOfInput: true }).success).toBe(
      true,
    );
    expect(
      CommandWriteRequestSchema.safeParse({ ...COMMAND, text: "y\n", endOfInput: true }).success,
    ).toBe(true);
  });

  it("refuses a write that carries neither", () => {
    expect(CommandWriteRequestSchema.safeParse(COMMAND).success).toBe(false);
    expect(CommandWriteRequestSchema.safeParse({ ...COMMAND, endOfInput: false }).success).toBe(
      false,
    );
  });
});

describe("command.ended", () => {
  const ended = { ...COMMAND, runId: RUN_ID, ending: "ended_by_person", durationMs: 4200 };

  it("accepts one of the three endings", () => {
    expect(CommandEndedPayloadSchema.safeParse(ended).success).toBe(true);
    expect(
      CommandEndedPayloadSchema.safeParse({ ...ended, ending: "failed", exitCode: 2 }).success,
    ).toBe(true);
  });

  it("refuses an ending outside the three", () => {
    expect(CommandEndedPayloadSchema.safeParse({ ...ended, ending: "timed_out" }).success).toBe(
      false,
    );
  });
});
