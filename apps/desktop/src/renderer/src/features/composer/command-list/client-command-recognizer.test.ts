// Recognition is decided against every id this window has registered, visible or not, so a
// command that exists but does not apply here is never reported as a name nobody has heard of.

import { describe, expect, it } from "vitest";

import {
  CLIENT_COMMAND_REFUSAL_CODES,
  CLIENT_COMMAND_REFUSAL_ORIGIN,
  recognizeClientCommand,
  type ClientCommandRecognitionInput,
} from "./client-command-recognizer.js";

const INPUT: ClientCommandRecognitionInput = {
  registeredCommandIds: ["frame.goToSettings", "bridge.copyBuildDetails"],
};

describe("recognizeClientCommand", () => {
  it("recognizes a registered console command by its exact id", () => {
    const recognition = recognizeClientCommand("frame.goToSettings", INPUT);

    expect(recognition).toEqual({ status: "recognized", commandId: "frame.goToSettings" });
  });

  it("carries this zone's origin on every refusal it mints", () => {
    const recognition = recognizeClientCommand("compact", INPUT);

    expect(recognition.status).toBe("refused");
    if (recognition.status !== "refused") {
      throw new Error("a name the console never registered must not be recognized");
    }
    expect(recognition.refusal.origin).toBe(CLIENT_COMMAND_REFUSAL_ORIGIN);
    expect(recognition.refusal.detail).toContain("compact");
  });

  it("refuses an unregistered name as unknown, naming the name", () => {
    const recognition = recognizeClientCommand("nowhere.atAll", INPUT);

    expect(recognition.status).toBe("refused");
    if (recognition.status !== "refused") {
      throw new Error("an unregistered name must not be recognized");
    }
    expect(recognition.refusal.code).toBe("unknown-command");
    expect(recognition.refusal.detail).toContain("nowhere.atAll");
  });

  it("negative control: a partial id is not a match, so prefixes never run a command", () => {
    const recognition = recognizeClientCommand("frame.goTo", INPUT);

    expect(recognition.status).toBe("refused");
  });

  it("negative control: a name the provider also publishes resolves as the console's", () => {
    // Only the console's registration is one this composer can run.
    const recognition = recognizeClientCommand("compact", {
      registeredCommandIds: ["compact"],
    });

    expect(recognition).toEqual({ status: "recognized", commandId: "compact" });
  });

  it("declares its refusal vocabulary exactly once", () => {
    expect(new Set(CLIENT_COMMAND_REFUSAL_CODES).size).toBe(CLIENT_COMMAND_REFUSAL_CODES.length);
  });
});
