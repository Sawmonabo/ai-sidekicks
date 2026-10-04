// The provider child environment: denied credential names never reach the child (under the
// host's name matching), no ambient daemon variable is inherited, and nothing can re-enable a
// provider's auto-updater or drop the Codex build pin.

import { describe, expect, it } from "vitest";

import { captureThrow } from "../../__fixtures__/capture-failure.js";
import { PROVIDER_NAMES, type ProviderName } from "@ai-sidekicks/contracts/provider-account";

import { PROVIDER_DRIVER_DESCRIPTORS } from "../provider-driver-descriptors.js";
import {
  ProviderSpawnEnvConflictError,
  ProviderSpawnEnvNameMatchMismatchError,
  buildProviderSpawnEnv,
  hostEnvNameMatchForPlatform,
  type CredentialEnvPolicy,
  type SpawnEnvPair,
} from "../spawn-env.js";

const CURATED_BASE: readonly SpawnEnvPair[] = [
  ["HOME", "/home/agent"],
  ["PATH", "/usr/bin"],
];

function namesOf(env: readonly SpawnEnvPair[]): string[] {
  return env.map(([name]) => name);
}

function valueOf(env: readonly SpawnEnvPair[], name: string): string | undefined {
  return env.find(([entryName]) => entryName === name)?.[1];
}

function occurrencesOf(env: readonly SpawnEnvPair[], name: string): number {
  return namesOf(env).filter((entryName) => entryName === name).length;
}

describe("provider spawn environment — auto-update suppression", () => {
  it("realizes each driver's declared opt-out, across the whole driver union", () => {
    // The table is total, but the builder could still read it for one driver and not another.
    const realized = new Map<ProviderName, readonly SpawnEnvPair[]>();
    for (const driverName of PROVIDER_NAMES) {
      realized.set(
        driverName,
        buildProviderSpawnEnv({
          driverName,
          baseEnv: CURATED_BASE,
          hostEnvNameMatch: "case-sensitive",
        }),
      );
    }

    expect([...realized.keys()].sort()).toStrictEqual([...PROVIDER_NAMES].sort());
    for (const driverName of PROVIDER_NAMES) {
      const built = realized.get(driverName) ?? [];
      const declared = Object.entries(
        PROVIDER_DRIVER_DESCRIPTORS[driverName].autoUpdateOptOutEnvironment,
      );
      for (const [name, value] of declared) {
        expect(valueOf(built, name)).toBe(value);
      }
      // The base survives whole: no policy was supplied, so nothing is pruned.
      expect(built.slice(0, CURATED_BASE.length)).toEqual(CURATED_BASE);
      expect(built).toHaveLength(CURATED_BASE.length + declared.length);
    }
  });

  it("overrides a base that would re-enable the updater, rather than appending beside it", () => {
    const built = buildProviderSpawnEnv({
      driverName: "claude",
      baseEnv: [...CURATED_BASE, ["DISABLE_AUTOUPDATER", "0"]],
      hostEnvNameMatch: "case-sensitive",
    });

    // Duplicate names resolve at the discretion of whatever execs the process, so the wrong
    // value must be absent, not just the right one present.
    expect(occurrencesOf(built, "DISABLE_AUTOUPDATER")).toBe(1);
    expect(valueOf(built, "DISABLE_AUTOUPDATER")).toBe("1");
    expect(namesOf(built)).toStrictEqual([
      "HOME",
      "PATH",
      "DISABLE_AUTOUPDATER",
      "DISABLE_UPDATES",
    ]);
  });
});

describe("provider spawn environment — credential-policy deny strip", () => {
  const DENY_SECRET: CredentialEnvPolicy = {
    denyEnvVars: ["ANTHROPIC_API_KEY"],
    envNameMatch: "case-sensitive",
  };

  it("strips a denied name that the curated base carried", () => {
    const built = buildProviderSpawnEnv({
      driverName: "codex",
      baseEnv: [...CURATED_BASE, ["ANTHROPIC_API_KEY", "sk-live"]],
      hostEnvNameMatch: "case-sensitive",
      credentialEnvPolicy: DENY_SECRET,
    });

    expect(namesOf(built)).not.toContain("ANTHROPIC_API_KEY");
    expect(built).toEqual(CURATED_BASE);
  });

  it("keeps the denied name stripped while the opt-out survives the same strip", () => {
    // Strip, then set: the order is the contract.
    const built = buildProviderSpawnEnv({
      driverName: "claude",
      baseEnv: [...CURATED_BASE, ["ANTHROPIC_API_KEY", "sk-live"]],
      hostEnvNameMatch: "case-sensitive",
      credentialEnvPolicy: {
        denyEnvVars: ["ANTHROPIC_API_KEY", "DISABLE_AUTOUPDATER", "DISABLE_UPDATES"],
        envNameMatch: "case-sensitive",
      },
    });

    expect(namesOf(built)).not.toContain("ANTHROPIC_API_KEY");
    // A deny list has no authority over auto-updater suppression.
    expect(valueOf(built, "DISABLE_AUTOUPDATER")).toBe("1");
    expect(valueOf(built, "DISABLE_UPDATES")).toBe("1");
  });

  it("honors a case-insensitive host's match mode", () => {
    const built = buildProviderSpawnEnv({
      driverName: "codex",
      baseEnv: [...CURATED_BASE, ["Anthropic_Api_Key", "sk-live"]],
      hostEnvNameMatch: "case-insensitive",
      credentialEnvPolicy: {
        denyEnvVars: ["ANTHROPIC_API_KEY"],
        envNameMatch: "case-insensitive",
      },
    });

    expect(namesOf(built)).not.toContain("Anthropic_Api_Key");
  });

  it("replaces a case-variant of a mandated name rather than shipping both", () => {
    // On a case-insensitive host, appending `DISABLE_UPDATES` beside an inherited
    // `disable_updates=0` would leave the winner to the process launcher. No policy is supplied
    // (a spawn with no declared posture, on Windows), so the fold must key on the host's mode,
    // not the policy's.
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

describe("provider spawn environment — per-connection mandated pairs", () => {
  const CODEX_BIN = "AI_SIDEKICKS_CODEX_APP_SERVER_BIN";

  it("keeps a per-connection mandated pair that a deny list names", () => {
    // The exact-build-path pin stands in for codex-cli's absent opt-out; if a deny list could
    // strip it, the child would fall back to a floating build.
    const built = buildProviderSpawnEnv({
      driverName: "codex",
      baseEnv: CURATED_BASE,
      hostEnvNameMatch: "case-sensitive",
      credentialEnvPolicy: { denyEnvVars: [CODEX_BIN], envNameMatch: "case-sensitive" },
      additionalMandatedPairs: [[CODEX_BIN, "/opt/codex/bin/codex"]],
    });

    expect(valueOf(built, CODEX_BIN)).toBe("/opt/codex/bin/codex");
  });

  // A per-connection pair may not decide the value of a declared opt-out. The cases include a
  // differing value (a silent last-wins merge would lower suppression) and a verbatim
  // restatement (the refusal is about authority over the name, not the value).
  const CONFLICTING_MANDATES: readonly {
    readonly label: string;
    readonly pairs: readonly SpawnEnvPair[];
  }[] = [
    { label: "lowers a declared opt-out", pairs: [["DISABLE_UPDATES", "0"]] },
    { label: "restates a declared opt-out verbatim", pairs: [["DISABLE_UPDATES", "1"]] },
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
        baseEnv: CURATED_BASE,
        hostEnvNameMatch: "case-sensitive",
        additionalMandatedPairs: pairs,
      }),
    ).toThrow(ProviderSpawnEnvConflictError);
  });

  it("refuses a case-variant collision on a case-insensitive host", () => {
    // A host that cannot tell `disable_updates` from `DISABLE_UPDATES` must not be handed both.
    expect(() =>
      buildProviderSpawnEnv({
        driverName: "claude",
        baseEnv: CURATED_BASE,
        hostEnvNameMatch: "case-insensitive",
        additionalMandatedPairs: [["disable_updates", "0"]],
      }),
    ).toThrow(ProviderSpawnEnvConflictError);
  });
});

describe("provider spawn environment — host name-matching semantics", () => {
  it("derives the host's mode from the platform, and only Windows is case-insensitive", () => {
    expect(hostEnvNameMatchForPlatform("win32")).toBe("case-insensitive");
    for (const platform of ["darwin", "linux", "freebsd"] as const) {
      expect(hostEnvNameMatchForPlatform(platform)).toBe("case-sensitive");
    }
  });

  it.each([
    { host: "case-sensitive", policy: "case-insensitive" },
    { host: "case-insensitive", policy: "case-sensitive" },
  ] as const)("REFUSES a policy declaring $policy matching on a $host host", ({ host, policy }) => {
    // A policy written for another host's semantics is a wiring fault. Honoring the policy would
    // leave `path` in a child on a case-insensitive host; honoring the host would apply a deny
    // list under semantics its author never assumed.
    const error = captureThrow(() =>
      buildProviderSpawnEnv({
        driverName: "claude",
        baseEnv: CURATED_BASE,
        hostEnvNameMatch: host,
        credentialEnvPolicy: { denyEnvVars: ["ANTHROPIC_API_KEY"], envNameMatch: policy },
      }),
    );
    expect(error).toBeInstanceOf(ProviderSpawnEnvNameMatchMismatchError);
    // Both values ride the error as members, so the person knows which side to fix.
    expect((error as ProviderSpawnEnvNameMatchMismatchError).hostEnvNameMatch).toBe(host);
    expect((error as ProviderSpawnEnvNameMatchMismatchError).policyEnvNameMatch).toBe(policy);
  });
});

describe("bound-account child environment carries no ambient credential inheritance", () => {
  /**
   * A credential-bearing name a provider CLI would read if it were inherited. Seeded into the
   * daemon's own `process.env` during the test, the only inheritance path that could exist:
   * the builder composes only from the `baseEnv` it is handed.
   */
  const AMBIENT_CREDENTIAL_NAME = "AI_SIDEKICKS_TEST_AMBIENT_PROVIDER_TOKEN";

  /** The credential home the daemon pinned for the bound account. */
  const BOUND_ACCOUNT_CREDENTIAL_HOME = "/var/lib/ai-sidekicks/accounts/acct-01J0ND/claude";

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

  it("composes EXACTLY the curated base plus the mandated pairs, and nothing else", () => {
    // Asserted over the whole variable set: probing for one absent name cannot report a
    // variable nobody anticipated.
    const { composed, ambientDuringBuild } = withAmbientCredential(() => ({
      composed: buildProviderSpawnEnv({
        driverName: "claude",
        baseEnv: [
          ["PATH", "/usr/bin:/bin"],
          ["HOME", "/var/empty"],
          ["CLAUDE_CONFIG_DIR", BOUND_ACCOUNT_CREDENTIAL_HOME],
        ],
        hostEnvNameMatch: hostEnvNameMatchForPlatform(process.platform),
      }),
      // Read inside the seeded window; the restore runs before the assertions.
      ambientDuringBuild: process.env[AMBIENT_CREDENTIAL_NAME],
    }));

    expect(Object.fromEntries(composed)).toStrictEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/var/empty",
      CLAUDE_CONFIG_DIR: BOUND_ACCOUNT_CREDENTIAL_HOME,
      ...PROVIDER_DRIVER_DESCRIPTORS.claude.autoUpdateOptOutEnvironment,
    });
    // The ambient credential existed while the environment was composed and reached no child.
    expect(ambientDuringBuild).toBeDefined();
    expect(composed.map(([name]) => name)).not.toContain(AMBIENT_CREDENTIAL_NAME);
  });

  it("never reads the daemon's own environment for either provider", () => {
    // Total over the driver union. An empty base yields exactly the mandated pairs, so any leak
    // would show here.
    for (const driverName of PROVIDER_NAMES) {
      const composed = withAmbientCredential(() =>
        buildProviderSpawnEnv({
          driverName,
          baseEnv: [],
          hostEnvNameMatch: hostEnvNameMatchForPlatform(process.platform),
        }),
      );
      expect(Object.fromEntries(composed)).toStrictEqual({
        ...PROVIDER_DRIVER_DESCRIPTORS[driverName].autoUpdateOptOutEnvironment,
      });
    }
  });
});
