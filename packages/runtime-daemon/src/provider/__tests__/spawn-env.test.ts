/**
 * Tests for the provider-neutral child-environment builder: each driver's auto-update opt-out
 * reaches the child, composes with the credential deny strip, and every fold honors the host's
 * name-match mode.
 *
 * - The opt-out is asserted at the builder, over the whole driver union, so a provider added
 *   without an opt-out decision fails here.
 * - A policy that disagrees with the host's match mode is refused, because both ways of
 *   reconciling it are wrong.
 * - Per-connection mandated pairs are exempt from the deny strip: the Codex exact-build-path
 *   pin stands in for that provider's absent environment opt-out.
 * - The table's own shape (total over the union, Codex deliberately empty) is asserted in
 *   `version-gate.test.ts`; this file asserts that the builder realizes it.
 */

import { describe, expect, it } from "vitest";

import { DRIVER_CLI_VERSION_FLOORS, type FlooredDriverName } from "../capability-refresh.js";
import {
  PROVIDER_AUTO_UPDATE_OPT_OUT_ENV,
  ProviderSpawnEnvConflictError,
  ProviderSpawnEnvNameMatchMismatchError,
  buildProviderSpawnEnv,
  hostEnvNameMatchForPlatform,
  type CredentialEnvPolicy,
  type SpawnEnvPair,
} from "../spawn-env.js";

// Derived from the floors table so a driver added to the union without an opt-out decision
// fails a test.
const ALL_DRIVERS: readonly FlooredDriverName[] = Object.keys(
  DRIVER_CLI_VERSION_FLOORS,
) as FlooredDriverName[];

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
    const realized = new Map<FlooredDriverName, readonly SpawnEnvPair[]>();
    for (const driverName of ALL_DRIVERS) {
      realized.set(
        driverName,
        buildProviderSpawnEnv({
          driverName,
          baseEnv: CURATED_BASE,
          hostEnvNameMatch: "case-sensitive",
        }),
      );
    }

    expect([...realized.keys()].sort()).toStrictEqual([...ALL_DRIVERS].sort());
    for (const driverName of ALL_DRIVERS) {
      const built = realized.get(driverName) ?? [];
      const declared = Object.entries(PROVIDER_AUTO_UPDATE_OPT_OUT_ENV[driverName]);
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

  it("leaves a driver declaring no opt-out byte-identical to its curated base", () => {
    // codex-cli documents no environment opt-out; an invented variable would look enforced in
    // the child.
    expect(
      buildProviderSpawnEnv({
        driverName: "codex",
        baseEnv: CURATED_BASE,
        hostEnvNameMatch: "case-sensitive",
      }),
    ).toEqual(CURATED_BASE);
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

  it("strips nothing when no policy is supplied, which is what a trusted posture carries", () => {
    const built = buildProviderSpawnEnv({
      driverName: "codex",
      baseEnv: [...CURATED_BASE, ["ANTHROPIC_API_KEY", "sk-live"]],
      hostEnvNameMatch: "case-sensitive",
    });

    expect(valueOf(built, "ANTHROPIC_API_KEY")).toBe("sk-live");
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

  it("NEGATIVE CONTROL — the same input under case-sensitive matching keeps the variant", () => {
    // Without this, the case-insensitive test would pass for a builder that lower-cased
    // everything or stripped look-alike names.
    const built = buildProviderSpawnEnv({
      driverName: "codex",
      baseEnv: [...CURATED_BASE, ["Anthropic_Api_Key", "sk-live"]],
      hostEnvNameMatch: "case-sensitive",
      credentialEnvPolicy: {
        denyEnvVars: ["ANTHROPIC_API_KEY"],
        envNameMatch: "case-sensitive",
      },
    });

    expect(valueOf(built, "Anthropic_Api_Key")).toBe("sk-live");
  });

  it("replaces a case-variant of a mandated name rather than shipping both", () => {
    // On a case-insensitive host, appending `DISABLE_UPDATES` beside an inherited
    // `disable_updates=0` would leave the winner to the process launcher. No policy is supplied
    // (the `trusted` posture on Windows), so the fold must key on the host's mode, not the
    // policy's.
    const built = buildProviderSpawnEnv({
      driverName: "claude",
      baseEnv: [["disable_updates", "0"]],
      hostEnvNameMatch: "case-insensitive",
    });

    expect(namesOf(built)).not.toContain("disable_updates");
    expect(occurrencesOf(built, "DISABLE_UPDATES")).toBe(1);
    expect(valueOf(built, "DISABLE_UPDATES")).toBe("1");
  });

  it("NEGATIVE CONTROL — the same base survives on a case-sensitive host", () => {
    // Without this, the test above would pass for a builder that upper-cased every base name;
    // on a POSIX host the two names are different variables.
    const built = buildProviderSpawnEnv({
      driverName: "claude",
      baseEnv: [["disable_updates", "0"]],
      hostEnvNameMatch: "case-sensitive",
    });

    expect(valueOf(built, "disable_updates")).toBe("0");
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

  it("appends mandated pairs after the surviving base, in a stable order", () => {
    const built = buildProviderSpawnEnv({
      driverName: "claude",
      baseEnv: CURATED_BASE,
      hostEnvNameMatch: "case-sensitive",
      additionalMandatedPairs: [["EXTRA", "value"]],
    });

    expect(built).toEqual([
      ["HOME", "/home/agent"],
      ["PATH", "/usr/bin"],
      ["DISABLE_AUTOUPDATER", "1"],
      ["DISABLE_UPDATES", "1"],
      ["EXTRA", "value"],
    ]);
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

  it("NEGATIVE CONTROL — the same case-variant pair passes under case-sensitive matching", () => {
    // Shows the refusal above comes from the match mode: on a case-sensitive host these are
    // different variables and the opt-out still reaches the child.
    const built = buildProviderSpawnEnv({
      driverName: "claude",
      baseEnv: CURATED_BASE,
      hostEnvNameMatch: "case-sensitive",
      additionalMandatedPairs: [["disable_updates", "0"]],
    });

    expect(valueOf(built, "DISABLE_UPDATES")).toBe("1");
    expect(valueOf(built, "disable_updates")).toBe("0");
  });

  it("names the conflicting variable on the refusal, so the defect is locatable", () => {
    expect.assertions(1);
    try {
      buildProviderSpawnEnv({
        driverName: "claude",
        baseEnv: CURATED_BASE,
        hostEnvNameMatch: "case-sensitive",
        additionalMandatedPairs: [["DISABLE_AUTOUPDATER", "0"]],
      });
    } catch (error) {
      expect((error as ProviderSpawnEnvConflictError).conflictingName).toBe("DISABLE_AUTOUPDATER");
    }
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
    expect.assertions(3);
    try {
      buildProviderSpawnEnv({
        driverName: "claude",
        baseEnv: CURATED_BASE,
        hostEnvNameMatch: host,
        credentialEnvPolicy: { denyEnvVars: ["ANTHROPIC_API_KEY"], envNameMatch: policy },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderSpawnEnvNameMatchMismatchError);
      // Both values ride the error as members, so the operator knows which side to fix.
      expect((error as ProviderSpawnEnvNameMatchMismatchError).hostEnvNameMatch).toBe(host);
      expect((error as ProviderSpawnEnvNameMatchMismatchError).policyEnvNameMatch).toBe(policy);
    }
  });

  it("refuses BEFORE composing anything — no partially-folded environment escapes", () => {
    // Asserted as a throw: no environment exists to inspect, and folding first would already
    // have keyed the mandated map wrongly.
    expect(() =>
      buildProviderSpawnEnv({
        driverName: "claude",
        baseEnv: [["disable_updates", "0"]],
        hostEnvNameMatch: "case-insensitive",
        credentialEnvPolicy: { denyEnvVars: [], envNameMatch: "case-sensitive" },
      }),
    ).toThrow(ProviderSpawnEnvNameMatchMismatchError);
  });

  it("accepts a policy that AGREES with the host, under either mode", () => {
    for (const mode of ["case-sensitive", "case-insensitive"] as const) {
      const built = buildProviderSpawnEnv({
        driverName: "claude",
        baseEnv: CURATED_BASE,
        hostEnvNameMatch: mode,
        credentialEnvPolicy: { denyEnvVars: ["ANTHROPIC_API_KEY"], envNameMatch: mode },
      });
      expect(valueOf(built, "DISABLE_UPDATES")).toBe("1");
    }
  });
});

describe("bound-account child environment carries no ambient credential inheritance", () => {
  /**
   * A credential-bearing name a provider CLI would read if it were inherited. Seeded into the
   * daemon's own `process.env` during the test, the only inheritance path that could exist:
   * the builder composes only from the `baseEnv` it is handed.
   */
  const AMBIENT_CREDENTIAL_NAME = "AI_SIDEKICKS_T317_AMBIENT_PROVIDER_TOKEN";

  /** The credential home the daemon pinned for the bound account. */
  const BOUND_ACCOUNT_CREDENTIAL_HOME = "/var/lib/ai-sidekicks/accounts/acct-01J0ND/claude";

  function withAmbientCredential<Result>(run: () => Result): Result {
    const previous = process.env[AMBIENT_CREDENTIAL_NAME];
    process.env[AMBIENT_CREDENTIAL_NAME] = "sk-ambient-operator-token";
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
      ...PROVIDER_AUTO_UPDATE_OPT_OUT_ENV.claude,
    });
    // The ambient credential existed while the environment was composed and reached no child.
    expect(ambientDuringBuild).toBeDefined();
    expect(composed.map(([name]) => name)).not.toContain(AMBIENT_CREDENTIAL_NAME);
  });

  it("keeps the account's pinned credential home while a deny list strips the ambient name", () => {
    // The account's pinned home survives; an ambient credential name carried in anyway is
    // removed by the policy.
    const composed = withAmbientCredential(() =>
      buildProviderSpawnEnv({
        driverName: "claude",
        baseEnv: [
          ["PATH", "/usr/bin:/bin"],
          ["CLAUDE_CONFIG_DIR", BOUND_ACCOUNT_CREDENTIAL_HOME],
          [AMBIENT_CREDENTIAL_NAME, "sk-ambient-operator-token"],
        ],
        hostEnvNameMatch: hostEnvNameMatchForPlatform(process.platform),
        credentialEnvPolicy: {
          denyEnvVars: [AMBIENT_CREDENTIAL_NAME],
          envNameMatch: hostEnvNameMatchForPlatform(process.platform),
        },
      }),
    );

    expect(Object.fromEntries(composed)).toStrictEqual({
      PATH: "/usr/bin:/bin",
      CLAUDE_CONFIG_DIR: BOUND_ACCOUNT_CREDENTIAL_HOME,
      ...PROVIDER_AUTO_UPDATE_OPT_OUT_ENV.claude,
    });
  });

  it("never reads the daemon's own environment for either provider", () => {
    // Total over the driver union. An empty base yields exactly the mandated pairs, so any leak
    // would show here.
    for (const driverName of Object.keys(
      PROVIDER_AUTO_UPDATE_OPT_OUT_ENV,
    ) as readonly FlooredDriverName[]) {
      const composed = withAmbientCredential(() =>
        buildProviderSpawnEnv({
          driverName,
          baseEnv: [],
          hostEnvNameMatch: hostEnvNameMatchForPlatform(process.platform),
        }),
      );
      expect(Object.fromEntries(composed)).toStrictEqual({
        ...PROVIDER_AUTO_UPDATE_OPT_OUT_ENV[driverName],
      });
    }
  });
});
