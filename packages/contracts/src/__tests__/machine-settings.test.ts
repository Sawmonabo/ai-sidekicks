// The machine's settings file is read by the service and by the main process
// before the service answers, so a key the file lacks must read as its default
// on both, and a broken file must be refused whole so it is repaired. A change
// carries exactly one member, and a row's name is checked by the one rule both
// processes import.
import { describe, expect, it } from "vitest";

import {
  MACHINE_SETTINGS_DEFAULTS,
  MachineSettingsReadingSchema,
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
    expect(parsed.data.voice).toStrictEqual({ mode: "tap", codexVoice: null });
  });

  it("refuses the whole file for an unknown key, even inside a group", () => {
    expect(parseMachineSettingsFile({ notifications: { sound: true } }).success).toBe(false);
  });

  it("refuses the whole file for a value out of its set", () => {
    expect(parseMachineSettingsFile({ voice: { mode: "push" } }).success).toBe(false);
    expect(
      parseMachineSettingsFile({ notifications: { emailDigest: { after: "week" } } }).success,
    ).toBe(false);
    expect(parseMachineSettingsFile({ defaultCheckout: "ephemeral clone" }).success).toBe(false);
  });

  it("refuses a file that is not an object", () => {
    expect(parseMachineSettingsFile([]).success).toBe(false);
  });

  it("refuses a branch-name pattern without exactly one {title} or with two {session}", () => {
    expect(parseMachineSettingsFile({ branchNamePattern: "sawmon/{title}" }).success).toBe(true);
    expect(parseMachineSettingsFile({ branchNamePattern: "sawmon/{session}" }).success).toBe(false);
    expect(parseMachineSettingsFile({ branchNamePattern: "{title}/{title}" }).success).toBe(false);
    expect(
      parseMachineSettingsFile({ branchNamePattern: "{session}/{session}/{title}" }).success,
    ).toBe(false);
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
        change: { voice: { mode: "tap", codexVoice: "cove" } },
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

  it("refuses a group missing one of its members", () => {
    expect(
      MachineSettingsUpdateRequestSchema.safeParse({ change: { voice: { mode: "tap" } } }).success,
    ).toBe(false);
  });
});

describe("a reading", () => {
  it("carries a repair only with its time and a cause from the set", () => {
    const settings = MACHINE_SETTINGS_DEFAULTS;
    expect(
      MachineSettingsReadingSchema.safeParse({
        settings,
        repair: { repairedAt: "2026-09-29T18:00:00.000Z", cause: "schemaRefused" },
      }).success,
    ).toBe(true);
    expect(
      MachineSettingsReadingSchema.safeParse({
        settings,
        repair: { repairedAt: "2026-09-29T18:00:00.000Z", cause: "deleted" },
      }).success,
    ).toBe(false);
  });
});

describe("the environment-name rule", () => {
  it("lets an ordinary name through", () => {
    expect(environmentNameRefusal("HTTPS_PROXY")).toBeNull();
  });

  it("refuses what is not a name", () => {
    expect(environmentNameRefusal("1PROXY")).toBe("notAName");
    expect(environmentNameRefusal("MY-PROXY")).toBe("notAName");
  });

  it("refuses a credential-shaped name in any case", () => {
    expect(environmentNameRefusal("ANTHROPIC_API_KEY")).toBe("credentialShaped");
    expect(environmentNameRefusal("github_token")).toBe("credentialShaped");
    expect(environmentNameRefusal("DB_PASSWORD")).toBe("credentialShaped");
  });

  it("refuses a name the app sets itself, in any case", () => {
    expect(environmentNameRefusal("DISABLE_AUTOUPDATER")).toBe("setByApp");
    expect(environmentNameRefusal("disable_updates")).toBe("setByApp");
    expect(environmentNameRefusal("CODEX_APP_SERVER_BIN")).toBe("setByApp");
  });
});
