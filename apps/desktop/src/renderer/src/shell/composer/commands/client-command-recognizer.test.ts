// The three answers, and that they stay three.
//
// The claim worth a unit is the middle one: a name the bound provider published is
// refused for a DIFFERENT reason than a name nobody registered. Collapsing them
// would tell a person who typed a real provider command that no such command exists,
// which is both false and the wrong next move.

import { describe, expect, it } from "vitest";

import {
  CLIENT_COMMAND_REFUSAL_CODES,
  CLIENT_COMMAND_REFUSAL_ORIGIN,
  recognizeClientCommand,
  type ClientCommandRecognitionInput,
} from "./client-command-recognizer.js";

const INPUT: ClientCommandRecognitionInput = {
  registeredCommandIds: ["frame.goToSettings", "bridge.copyBuildDetails"],
  providerCommandNames: ["compact", "review"],
};

describe("recognizeClientCommand", () => {
  it("recognises a registered console command by its exact id", () => {
    const recognition = recognizeClientCommand(
      { commandName: "frame.goToSettings", argumentText: "" },
      INPUT,
    );

    expect(recognition).toEqual({ status: "recognized", commandId: "frame.goToSettings" });
  });

  it("refuses a provider command by rule, naming the discovery-only reading", () => {
    const recognition = recognizeClientCommand({ commandName: "compact", argumentText: "" }, INPUT);

    expect(recognition.status).toBe("refused");
    if (recognition.status !== "refused") {
      throw new Error("a provider command name must not be recognised");
    }
    expect(recognition.refusal.code).toBe("provider-command-not-executable");
    expect(recognition.refusal.origin).toBe(CLIENT_COMMAND_REFUSAL_ORIGIN);
    expect(recognition.refusal.detail).toContain("compact");
  });

  it("refuses an unregistered name as unknown, naming the literal-slash escape", () => {
    const recognition = recognizeClientCommand(
      { commandName: "nowhere.atAll", argumentText: "" },
      INPUT,
    );

    expect(recognition.status).toBe("refused");
    if (recognition.status !== "refused") {
      throw new Error("an unregistered name must not be recognised");
    }
    expect(recognition.refusal.code).toBe("unknown-command");
    expect(recognition.refusal.detail).toContain("//");
  });

  it("negative control: a partial id is not a match, so prefixes never run a command", () => {
    const recognition = recognizeClientCommand(
      { commandName: "frame.goTo", argumentText: "" },
      INPUT,
    );

    expect(recognition.status).toBe("refused");
  });

  it("negative control: an offered id that is also a provider name resolves as the console's", () => {
    const recognition = recognizeClientCommand(
      { commandName: "compact", argumentText: "" },
      {
        registeredCommandIds: ["compact"],
        providerCommandNames: ["compact"],
      },
    );

    expect(recognition).toEqual({ status: "recognized", commandId: "compact" });
  });

  it("declares its refusal vocabulary exactly once", () => {
    expect(new Set(CLIENT_COMMAND_REFUSAL_CODES).size).toBe(CLIENT_COMMAND_REFUSAL_CODES.length);
  });
});
