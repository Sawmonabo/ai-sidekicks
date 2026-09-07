// The two answers, and that they stay two.
//
// The claim worth a unit is the second one's SCOPE: recognition is decided against
// every id this window has registered, visible or not, so a command that exists and
// does not apply here is never reported as a name nobody has heard of. That is the
// difference between "go where it applies" and "you typed it wrong".

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
  it("recognises a registered console command by its exact id", () => {
    const recognition = recognizeClientCommand("frame.goToSettings", INPUT);

    expect(recognition).toEqual({ status: "recognized", commandId: "frame.goToSettings" });
  });

  it("carries this zone's origin on every refusal it mints", () => {
    const recognition = recognizeClientCommand("compact", INPUT);

    expect(recognition.status).toBe("refused");
    if (recognition.status !== "refused") {
      throw new Error("a name the console never registered must not be recognised");
    }
    expect(recognition.refusal.origin).toBe(CLIENT_COMMAND_REFUSAL_ORIGIN);
    expect(recognition.refusal.detail).toContain("compact");
  });

  it("refuses an unregistered name as unknown, naming the name rather than the escape", () => {
    const recognition = recognizeClientCommand("nowhere.atAll", INPUT);

    expect(recognition.status).toBe("refused");
    if (recognition.status !== "refused") {
      throw new Error("an unregistered name must not be recognised");
    }
    expect(recognition.refusal.code).toBe("unknown-command");
    expect(recognition.refusal.detail).toContain("nowhere.atAll");
    // The escape belongs to the router, which is what a person who TYPED an
    // unrecognised name actually meets; saying it twice would be two owners of one
    // sentence.
    expect(recognition.refusal.detail).not.toContain("//");
  });

  it("negative control: a partial id is not a match, so prefixes never run a command", () => {
    const recognition = recognizeClientCommand("frame.goTo", INPUT);

    expect(recognition.status).toBe("refused");
  });

  it("negative control: a name the provider also publishes resolves as the console's", () => {
    // Both surfaces may publish `compact`. The console's registration is what decides
    // here, because the console's is the only one this composer can run.
    const recognition = recognizeClientCommand("compact", {
      registeredCommandIds: ["compact"],
    });

    expect(recognition).toEqual({ status: "recognized", commandId: "compact" });
  });

  it("declares its refusal vocabulary exactly once", () => {
    expect(new Set(CLIENT_COMMAND_REFUSAL_CODES).size).toBe(CLIENT_COMMAND_REFUSAL_CODES.length);
  });
});
