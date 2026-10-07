// The machine's settings file is read by the service and by the main process before the service
// answers, so a key the file lacks must read as its default on both, and a broken file must be
// refused whole so it is repaired. A change carries exactly one member, and a row's name is
// checked by the one rule both processes import.
import { describe, expect, it } from "vitest";

import {
  MACHINE_SETTINGS_DEFAULTS,
  MachineSettingsUpdateRequestSchema,
  environmentNameRefusal,
  parseMachineSettingsFile,
} from "../machine-settings.js";

describe("the settings file", () => {
  it("reads an empty file as every default", () => {
    const parsed = parseMachineSettingsFile({});
    expect(parsed.success && parsed.data).toStrictEqual(MACHINE_SETTINGS_DEFAULTS);
  });

  it("reads a missing key inside a group as its default and keeps the stored ones", () => {
    const parsed = parseMachineSettingsFile({
      notifications: { kinds: { failed: false } },
      voice: { mode: "tap" },
    });
    if (!parsed.success) throw parsed.error;
    expect(parsed.data.notifications.kinds).toStrictEqual({
      waitingOnYou: true,
      finished: true,
      failed: false,
      notifyStep: true,
    });
    expect(parsed.data.notifications.emailDigest.after).toBe("day");
    expect(parsed.data.voice).toStrictEqual({ mode: "tap", callVoice: null });
  });

  it("reads the last model and effort picked back whole, and none before the first pick", () => {
    const lastLeadModel = { driverName: "codex", modelId: "gpt-5.5", effort: null };
    const parsed = parseMachineSettingsFile({ lastLeadModel });
    expect(parsed.success && parsed.data.lastLeadModel).toStrictEqual(lastLeadModel);
    expect(MACHINE_SETTINGS_DEFAULTS.lastLeadModel).toBeNull();
  });

  it("refuses the whole file for an unknown key, even inside a group", () => {
    expect(parseMachineSettingsFile({ notifications: { sound: true } }).success).toBe(false);
  });

  it("refuses a file that is not an object", () => {
    expect(parseMachineSettingsFile([]).success).toBe(false);
  });

  it("refuses a branch-name pattern without exactly one {title}, whatever its {session}", () => {
    expect(parseMachineSettingsFile({ branchNamePattern: "sawmon/{title}" }).success).toBe(true);
    expect(parseMachineSettingsFile({ branchNamePattern: "sawmon/{session}" }).success).toBe(false);
    expect(parseMachineSettingsFile({ branchNamePattern: "{title}/{title}" }).success).toBe(false);
    expect(
      parseMachineSettingsFile({ branchNamePattern: "{session}/{session}/{title}" }).success,
    ).toBe(true);
  });
});

describe("daemon.machineSettingsUpdate", () => {
  it("accepts one member, a group written whole", () => {
    expect(
      MachineSettingsUpdateRequestSchema.safeParse({ change: { keepAwakeForOtherDevices: true } })
        .success,
    ).toBe(true);
    expect(
      MachineSettingsUpdateRequestSchema.safeParse({
        change: { voice: { mode: "tap", callVoice: "cove" } },
      }).success,
    ).toBe(true);
  });

  it("refuses a change with no member, with two, or with an unknown one", () => {
    expect(MachineSettingsUpdateRequestSchema.safeParse({ change: {} }).success).toBe(false);
    expect(
      MachineSettingsUpdateRequestSchema.safeParse({
        change: { screenReaderMode: true, keepAwakeWhileAgentWorks: true },
      }).success,
    ).toBe(false);
    expect(
      MachineSettingsUpdateRequestSchema.safeParse({ change: { osToastsMuted: true } }).success,
    ).toBe(false);
  });
});

describe("the environment-name rule", () => {
  it("lets an ordinary name through", () => {
    expect(environmentNameRefusal("HTTPS_PROXY")).toBeNull();
  });

  it("refuses what is not a name", () => {
    expect(environmentNameRefusal("1PROXY")).toBe("not_a_name");
    expect(environmentNameRefusal("MY-PROXY")).toBe("not_a_name");
  });

  it("refuses a credential-shaped name in any case", () => {
    expect(environmentNameRefusal("ANTHROPIC_API_KEY")).toBe("credential_shaped");
    expect(environmentNameRefusal("github_token")).toBe("credential_shaped");
    expect(environmentNameRefusal("DB_PASSWORD")).toBe("credential_shaped");
  });

  it("refuses a name the app sets itself, in any case", () => {
    expect(environmentNameRefusal("DISABLE_AUTOUPDATER")).toBe("set_by_app");
    expect(environmentNameRefusal("disable_updates")).toBe("set_by_app");
    expect(environmentNameRefusal("CODEX_APP_SERVER_BIN")).toBe("set_by_app");
  });
});
