// The child environments: rows replace the captured base's pair of the same name, a project row
// beats an `Every project` row, no curated credential variable or never-set Claude Code name
// reaches a provider child or a Codex conversation's commands (under the host's name matching)
// while a project's setup command keeps the person's credential variables,
// no ambient daemon variable is inherited, and nothing can re-enable a provider's auto-updater,
// lower a Claude Code process variable or point a process at an empty account folder.

import { describe, expect, it } from "vitest";

import type { EnvironmentRow } from "@ai-sidekicks/contracts/machine-settings";
import { PROVIDER_NAMES, type ProviderName } from "@ai-sidekicks/contracts/provider/name";

import { captureThrow } from "../../__fixtures__/capture-failure.js";
import { CURATED_CREDENTIAL_ENV_VARS } from "../../policy/execution-posture-service.js";
import { PROVIDER_DRIVER_DESCRIPTORS } from "../driver/descriptor.js";
import {
  ProviderAccountFolderError,
  ProviderSpawnEnvConflictError,
  buildCommandSpawnEnv,
  buildProviderSpawnEnv,
  composeCodexShellEnvironmentPolicy,
  type SpawnEnvPair,
} from "../spawn-env.js";
import { selectProviderOperatingSystem } from "../operating-system/selection.js";

const CAPTURED_BASE: readonly SpawnEnvPair[] = [
  ["HOME", "/home/agent"],
  ["PATH", "/usr/bin"],
];

const CLAUDE_PROCESS_ENVIRONMENT = {
  CLAUDE_AUTO_BACKGROUND_TASKS: "1",
  CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS: "0",
  BASH_MAX_TIMEOUT_MS: "2147483647",
};

function namesOf(env: readonly SpawnEnvPair[]): string[] {
  return env.map(([name]) => name);
}

function valueOf(env: readonly SpawnEnvPair[], name: string): string | undefined {
  return env.find(([entryName]) => entryName === name)?.[1];
}

function occurrencesOf(env: readonly SpawnEnvPair[], name: string): number {
  return namesOf(env).filter((entryName) => entryName === name).length;
}

function row(name: string, value: string): EnvironmentRow {
  return { name, value };
}

describe("provider spawn environment — rows over the captured base", () => {
  it("lets a row replace the base pair its name matches under the host's rule, once", () => {
    const built = buildProviderSpawnEnv({
      driverName: "claude",
      baseEnv: [
        ["Path", "C:\\Windows\\System32"],
        ["HTTPS_PROXY", "http://proxy.internal:3128"],
      ],
      environmentRows: { everyProject: [row("PATH", "C:\\Tools")], project: [] },
      hostEnvNameMatch: "case-insensitive",
    });

    expect(built.slice(0, 2)).toStrictEqual([
      ["PATH", "C:\\Tools"],
      ["HTTPS_PROXY", "http://proxy.internal:3128"],
    ]);
    expect(built.filter(([name]) => name.toUpperCase() === "PATH")).toHaveLength(1);
  });

  it("lets a project row win over the Every project row and drops a name the app sets", () => {
    const built = buildProviderSpawnEnv({
      driverName: "codex",
      baseEnv: CAPTURED_BASE,
      environmentRows: {
        everyProject: [row("REGION", "us"), row("DISABLE_UPDATES", "0")],
        project: [row("REGION", "eu"), row("CODEX_APP_SERVER_BIN", "/tmp/elsewhere")],
      },
      hostEnvNameMatch: "case-sensitive",
    });

    expect(valueOf(built, "REGION")).toBe("eu");
    expect(occurrencesOf(built, "REGION")).toBe(1);
    expect(namesOf(built)).not.toContain("DISABLE_UPDATES");
    expect(namesOf(built)).not.toContain("CODEX_APP_SERVER_BIN");
  });
});

describe("provider spawn environment — the curated credential variables", () => {
  const secretPairs: SpawnEnvPair[] = CURATED_CREDENTIAL_ENV_VARS.map((name) => [name, "secret"]);

  it("never hands a curated variable to any provider, from the base or from a row", () => {
    for (const driverName of PROVIDER_NAMES) {
      const built = buildProviderSpawnEnv({
        driverName,
        baseEnv: [...CAPTURED_BASE, ...secretPairs],
        environmentRows: {
          everyProject: secretPairs.map(([name]) => row(name, "from every project")),
          project: secretPairs.map(([name]) => row(name, "from the project")),
        },
        hostEnvNameMatch: "case-sensitive",
      });

      for (const name of CURATED_CREDENTIAL_ENV_VARS) {
        expect(namesOf(built)).not.toContain(name);
      }
      expect(built.slice(0, CAPTURED_BASE.length)).toStrictEqual(CAPTURED_BASE);
    }
  });

  it("keeps the person's NPM_TOKEN for a setup command and never for a provider child", () => {
    // A setup `pnpm install` from a private registry reads it; a provider child never may. A row
    // naming a credential home, which only the daemon sets, reaches neither.
    const request = {
      baseEnv: [...CAPTURED_BASE, ["NPM_TOKEN", "secret"] as const],
      environmentRows: { everyProject: [row("CODEX_HOME", "/tmp/elsewhere")], project: [] },
      hostEnvNameMatch: "case-sensitive" as const,
    };

    const setupCommand = buildCommandSpawnEnv(request);
    const providerChild = buildProviderSpawnEnv({ ...request, driverName: "claude" });

    expect(setupCommand).toStrictEqual([...CAPTURED_BASE, ["NPM_TOKEN", "secret"]]);
    expect(namesOf(providerChild)).not.toContain("NPM_TOKEN");
    expect(namesOf(providerChild)).not.toContain("CODEX_HOME");
  });

  it("strips a case variant on a case-insensitive host", () => {
    const variants: SpawnEnvPair[] = CURATED_CREDENTIAL_ENV_VARS.map((name) => [
      name.toLowerCase(),
      "secret",
    ]);
    const built = buildProviderSpawnEnv({
      driverName: "claude",
      baseEnv: [...CAPTURED_BASE, ...variants],
      hostEnvNameMatch: "case-insensitive",
    });

    for (const [variant] of variants) {
      expect(namesOf(built)).not.toContain(variant);
    }
  });

  it("gives a Codex conversation's commands its project rows and no curated variable", () => {
    const policy = composeCodexShellEnvironmentPolicy({
      baseEnv: [...CAPTURED_BASE, ...secretPairs],
      environmentRows: {
        everyProject: [row("REGION", "us")],
        project: [row("REGION", "eu"), ...secretPairs.map(([name]) => row(name, "secret"))],
      },
      hostEnvNameMatch: "case-sensitive",
    });

    expect(policy.inherit).toBe("none");
    expect(policy.set).toStrictEqual({ HOME: "/home/agent", PATH: "/usr/bin", REGION: "eu" });
  });
});

describe("provider spawn environment — what the app sets on a provider process", () => {
  it("realizes each driver's declared opt-out, across the whole driver union", () => {
    // The table is total, but the builder could still read it for one driver and not another.
    const realized = new Map<ProviderName, readonly SpawnEnvPair[]>();
    for (const driverName of PROVIDER_NAMES) {
      realized.set(
        driverName,
        buildProviderSpawnEnv({
          driverName,
          baseEnv: CAPTURED_BASE,
          hostEnvNameMatch: "case-sensitive",
        }),
      );
    }

    expect([...realized.keys()].sort()).toStrictEqual([...PROVIDER_NAMES].sort());
    for (const driverName of PROVIDER_NAMES) {
      const built = realized.get(driverName) ?? [];
      for (const [name, value] of Object.entries(
        PROVIDER_DRIVER_DESCRIPTORS[driverName].autoUpdateOptOutEnvironment,
      )) {
        expect(valueOf(built, name)).toBe(value);
      }
    }
  });

  it("sets Claude Code's process variables over a base that would lower them, once each", () => {
    const built = buildProviderSpawnEnv({
      driverName: "claude",
      baseEnv: [
        ...CAPTURED_BASE,
        ["DISABLE_AUTOUPDATER", "0"],
        ["BASH_MAX_TIMEOUT_MS", "600000"],
        ["CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS", "30000"],
      ],
      environmentRows: { everyProject: [row("CLAUDE_AUTO_BACKGROUND_TASKS", "0")], project: [] },
      hostEnvNameMatch: "case-sensitive",
    });

    // Duplicate names resolve at the discretion of whatever execs the process, so the wrong
    // value must be absent, not just the right one present.
    expect(Object.fromEntries(built)).toStrictEqual({
      HOME: "/home/agent",
      PATH: "/usr/bin",
      ...PROVIDER_DRIVER_DESCRIPTORS.claude.autoUpdateOptOutEnvironment,
      ...CLAUDE_PROCESS_ENVIRONMENT,
    });
    expect(built).toHaveLength(Object.keys(Object.fromEntries(built)).length);
  });

  it("never hands Claude Code a name it must not receive, even from the person's shell", () => {
    const neverSet = [
      "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
      "CLAUDE_CODE_EXIT_AFTER_STOP_DELAY",
      "CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT",
      "CLAUDE_CODE_REMOTE_MEMORY_DIR",
    ];
    const built = buildProviderSpawnEnv({
      driverName: "claude",
      baseEnv: [...CAPTURED_BASE, ...neverSet.map((name): SpawnEnvPair => [name, "1"])],
      environmentRows: { everyProject: [], project: neverSet.map((name) => row(name, "1")) },
      hostEnvNameMatch: "case-sensitive",
    });

    for (const name of neverSet) {
      expect(namesOf(built)).not.toContain(name);
    }
  });

  it("replaces a case variant of a mandated name rather than shipping both", () => {
    // On a case-insensitive host, appending `DISABLE_UPDATES` beside an inherited
    // `disable_updates=0` would leave the winner to the process launcher.
    const built = buildProviderSpawnEnv({
      driverName: "claude",
      baseEnv: [["disable_updates", "0"]],
      hostEnvNameMatch: "case-insensitive",
    });

    expect(namesOf(built)).not.toContain("disable_updates");
    expect(occurrencesOf(built, "DISABLE_UPDATES")).toBe(1);
    expect(valueOf(built, "DISABLE_UPDATES")).toBe("1");
  });
});

describe("provider spawn environment — account folders", () => {
  it("pins each provider's account folders over the base", () => {
    const claude = buildProviderSpawnEnv({
      driverName: "claude",
      baseEnv: [...CAPTURED_BASE, ["CLAUDE_CONFIG_DIR", "/home/agent/.claude"]],
      accountFolders: {
        configFolder: "/var/lib/sidekicks/sessions/s1/claude",
        credentialStoreFolder: "/var/lib/sidekicks/accounts/a1/claude",
      },
      hostEnvNameMatch: "case-sensitive",
    });
    const codex = buildProviderSpawnEnv({
      driverName: "codex",
      baseEnv: CAPTURED_BASE,
      codexHome: "/var/lib/sidekicks/accounts/a2/codex",
      hostEnvNameMatch: "case-sensitive",
    });

    expect(occurrencesOf(claude, "CLAUDE_CONFIG_DIR")).toBe(1);
    expect(valueOf(claude, "CLAUDE_CONFIG_DIR")).toBe("/var/lib/sidekicks/sessions/s1/claude");
    expect(valueOf(claude, "CLAUDE_SECURESTORAGE_CONFIG_DIR")).toBe(
      "/var/lib/sidekicks/accounts/a1/claude",
    );
    expect(valueOf(codex, "CODEX_HOME")).toBe("/var/lib/sidekicks/accounts/a2/codex");
  });

  it("refuses an empty or relative account folder, given or inherited", () => {
    // An empty Claude Code credential store runs the process on the person's own sign-in.
    expect(() =>
      buildProviderSpawnEnv({
        driverName: "claude",
        baseEnv: [...CAPTURED_BASE, ["CLAUDE_SECURESTORAGE_CONFIG_DIR", ""]],
        hostEnvNameMatch: "case-sensitive",
      }),
    ).toThrow(ProviderAccountFolderError);
    expect(() =>
      buildProviderSpawnEnv({
        driverName: "claude",
        baseEnv: CAPTURED_BASE,
        accountFolders: { configFolder: "/var/lib/a/claude", credentialStoreFolder: "" },
        hostEnvNameMatch: "case-sensitive",
      }),
    ).toThrow(ProviderAccountFolderError);
    expect(() =>
      buildProviderSpawnEnv({
        driverName: "codex",
        baseEnv: CAPTURED_BASE,
        codexHome: "accounts/a2/codex",
        hostEnvNameMatch: "case-sensitive",
      }),
    ).toThrow(ProviderAccountFolderError);
  });
});

describe("provider spawn environment — per-process mandated pairs", () => {
  const CODEX_BIN = "CODEX_APP_SERVER_BIN";

  // A per-process pair may not decide the value of a declared opt-out or a process variable. The
  // cases include a differing value (a silent last-wins merge would lower suppression) and a
  // verbatim restatement (the refusal is about authority over the name, not the value).
  const CONFLICTING_MANDATES: readonly {
    readonly label: string;
    readonly pairs: readonly SpawnEnvPair[];
  }[] = [
    { label: "lowers a declared opt-out", pairs: [["DISABLE_UPDATES", "0"]] },
    { label: "restates a declared opt-out verbatim", pairs: [["DISABLE_UPDATES", "1"]] },
    { label: "lowers a process variable", pairs: [["BASH_MAX_TIMEOUT_MS", "600000"]] },
    {
      label: "claims one name twice within the same array",
      pairs: [
        [CODEX_BIN, "/opt/a/codex"],
        [CODEX_BIN, "/opt/b/codex"],
      ],
    },
  ];

  it.each(CONFLICTING_MANDATES)("refuses a mandated pair that $label", ({ pairs }) => {
    expect(() =>
      buildProviderSpawnEnv({
        driverName: "claude",
        baseEnv: CAPTURED_BASE,
        hostEnvNameMatch: "case-sensitive",
        additionalMandatedPairs: pairs,
      }),
    ).toThrow(ProviderSpawnEnvConflictError);
  });

  it("names the conflicting variables but never their values, which can hold a credential", () => {
    const error = captureThrow(() =>
      buildProviderSpawnEnv({
        driverName: "claude",
        baseEnv: CAPTURED_BASE,
        hostEnvNameMatch: "case-sensitive",
        additionalMandatedPairs: [
          ["OTEL_EXPORTER_OTLP_HEADERS", "Authorization=Bearer first-secret-token"],
          ["OTEL_EXPORTER_OTLP_HEADERS", "Authorization=Bearer second-secret-token"],
        ],
      }),
    );

    expect(error).toBeInstanceOf(ProviderSpawnEnvConflictError);
    expect((error as Error).message).toContain("OTEL_EXPORTER_OTLP_HEADERS");
    expect((error as Error).message).not.toContain("secret-token");
  });

  it("refuses a case-variant collision on a case-insensitive host", () => {
    // A host that cannot tell `disable_updates` from `DISABLE_UPDATES` must not be handed both.
    expect(() =>
      buildProviderSpawnEnv({
        driverName: "claude",
        baseEnv: CAPTURED_BASE,
        hostEnvNameMatch: "case-insensitive",
        additionalMandatedPairs: [["disable_updates", "0"]],
      }),
    ).toThrow(ProviderSpawnEnvConflictError);
  });
});

describe("provider spawn environment — host name-matching semantics", () => {
  it("picks the host's mode by platform, and only Windows is case-insensitive", () => {
    expect(selectProviderOperatingSystem("win32").environmentNameMatch).toBe("case-insensitive");
    for (const platform of ["darwin", "linux"] as const) {
      expect(selectProviderOperatingSystem(platform).environmentNameMatch).toBe("case-sensitive");
    }
  });
});

describe("provider child environment carries no ambient inheritance", () => {
  // Seeded into the daemon's own `process.env` during the test, the only inheritance path that
  // could exist: the builder composes only from the `baseEnv` it is handed.
  const AMBIENT_CREDENTIAL_NAME = "AI_SIDEKICKS_TEST_AMBIENT_PROVIDER_TOKEN";

  function withAmbientCredential<Result>(run: () => Result): Result {
    const previous = process.env[AMBIENT_CREDENTIAL_NAME];
    process.env[AMBIENT_CREDENTIAL_NAME] = "sk-ambient-person-token";
    try {
      return run();
    } finally {
      if (previous === undefined) {
        delete process.env[AMBIENT_CREDENTIAL_NAME];
      } else {
        process.env[AMBIENT_CREDENTIAL_NAME] = previous;
      }
    }
  }

  it("composes exactly the mandated pairs from an empty base, for either provider", () => {
    // Asserted over the whole variable set: probing for one absent name cannot report a variable
    // nobody anticipated.
    for (const driverName of PROVIDER_NAMES) {
      const composed = withAmbientCredential(() =>
        buildProviderSpawnEnv({
          driverName,
          baseEnv: [],
          hostEnvNameMatch: selectProviderOperatingSystem(process.platform).environmentNameMatch,
        }),
      );
      expect(Object.fromEntries(composed)).toStrictEqual({
        ...PROVIDER_DRIVER_DESCRIPTORS[driverName].autoUpdateOptOutEnvironment,
        ...(driverName === "claude" ? CLAUDE_PROCESS_ENVIRONMENT : {}),
      });
    }
  });
});
