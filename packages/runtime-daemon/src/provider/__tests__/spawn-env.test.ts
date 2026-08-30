/**
 * Plan-005 T3.25 — the provider-neutral child-environment builder (I-005-10).
 *
 * Coverage targets, taken from the task's own Tests field and from
 * `Spec-005 §Required Behavior` / `Spec-012 §Required Behavior` rather than
 * restated from the module under test:
 *
 *   * Every driver-spawned child's environment carries its provider's
 *     auto-update opt-out, asserted AT THE BUILDER rather than per call site —
 *     and asserted over the whole driver union, so a provider added without an
 *     opt-out decision fails here rather than shipping one.
 *   * The opt-out COMPOSES with the credential-policy deny strip: a denied name
 *     stays stripped after the builder runs, and the opt-out survives a policy
 *     that names it.
 *   * The strip honours the policy's recorded name-match mode. The negative
 *     control is the same input under the other mode: if both modes agreed, the
 *     mode would not be doing anything.
 *   * The per-connection mandated pairs are strip-exempt, because the Codex
 *     exact-build-path pin is what stands in for that provider's absent
 *     environment opt-out — a deny list that could remove it would defeat the
 *     fallback the empty table entry relies on.
 *
 * The table's own shape (total over the union, Codex deliberately empty) is
 * asserted where it has been since it landed, beside the version handshake that
 * also reads it. What is asserted HERE is that the builder realizes it.
 */

import { describe, expect, it } from "vitest";

import { DRIVER_CLI_VERSION_FLOORS, type FlooredDriverName } from "../capability-refresh.js";
import {
  PROVIDER_AUTO_UPDATE_OPT_OUT_ENV,
  ProviderSpawnEnvConflictError,
  buildProviderSpawnEnv,
  type CredentialEnvPolicy,
  type SpawnEnvPair,
} from "../spawn-env.js";

// Derived from the floors table rather than written out, exactly as the
// handshake suite derives it: a driver added to the union without an opt-out
// decision must fail a test, not pass one that never looked at it.
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
    // Totality THROUGH the builder. The table being total is asserted beside
    // the handshake; what could still be wrong here is a builder that reads it
    // for one driver and not another.
    const realized = new Map<FlooredDriverName, readonly SpawnEnvPair[]>();
    for (const driverName of ALL_DRIVERS) {
      realized.set(driverName, buildProviderSpawnEnv({ driverName, baseEnv: CURATED_BASE }));
    }

    expect([...realized.keys()].sort()).toStrictEqual([...ALL_DRIVERS].sort());
    for (const driverName of ALL_DRIVERS) {
      const built = realized.get(driverName) ?? [];
      const declared = Object.entries(PROVIDER_AUTO_UPDATE_OPT_OUT_ENV[driverName]);
      for (const [name, value] of declared) {
        expect(valueOf(built, name)).toBe(value);
      }
      // The base survives whole beside it: this builder prunes only what a
      // policy denies, and no policy was supplied.
      expect(built.slice(0, CURATED_BASE.length)).toEqual(CURATED_BASE);
      expect(built).toHaveLength(CURATED_BASE.length + declared.length);
    }
  });

  it("overrides a base that would re-enable the updater, rather than appending beside it", () => {
    const built = buildProviderSpawnEnv({
      driverName: "claude",
      baseEnv: [...CURATED_BASE, ["DISABLE_AUTOUPDATER", "0"]],
    });

    // Duplicate names resolve at the discretion of whatever execs the process,
    // so "the right value is present" is not enough — the wrong one must be
    // absent.
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
    // The declared-absence arm. codex-cli documents no environment opt-out, so
    // the builder must add NOTHING for it — an invented variable would be
    // indistinguishable in the child from an enforced one.
    expect(buildProviderSpawnEnv({ driverName: "codex", baseEnv: CURATED_BASE })).toEqual(
      CURATED_BASE,
    );
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
      credentialEnvPolicy: DENY_SECRET,
    });

    expect(namesOf(built)).not.toContain("ANTHROPIC_API_KEY");
    expect(built).toEqual(CURATED_BASE);
  });

  it("keeps the denied name stripped while the opt-out survives the same strip", () => {
    // The composition property. Both halves run over the same base, and the
    // order between them is the specification: strip, then set.
    const built = buildProviderSpawnEnv({
      driverName: "claude",
      baseEnv: [...CURATED_BASE, ["ANTHROPIC_API_KEY", "sk-live"]],
      credentialEnvPolicy: {
        denyEnvVars: ["ANTHROPIC_API_KEY", "DISABLE_AUTOUPDATER", "DISABLE_UPDATES"],
        envNameMatch: "case-sensitive",
      },
    });

    expect(namesOf(built)).not.toContain("ANTHROPIC_API_KEY");
    // A policy cannot switch a provider's auto-updater back on: suppression is
    // a correctness obligation the deny list has no authority over.
    expect(valueOf(built, "DISABLE_AUTOUPDATER")).toBe("1");
    expect(valueOf(built, "DISABLE_UPDATES")).toBe("1");
  });

  it("strips nothing when no policy is supplied, which is what a trusted posture carries", () => {
    const built = buildProviderSpawnEnv({
      driverName: "codex",
      baseEnv: [...CURATED_BASE, ["ANTHROPIC_API_KEY", "sk-live"]],
    });

    expect(valueOf(built, "ANTHROPIC_API_KEY")).toBe("sk-live");
  });

  it("honours a case-insensitive host's match mode", () => {
    const built = buildProviderSpawnEnv({
      driverName: "codex",
      baseEnv: [...CURATED_BASE, ["Anthropic_Api_Key", "sk-live"]],
      credentialEnvPolicy: {
        denyEnvVars: ["ANTHROPIC_API_KEY"],
        envNameMatch: "case-insensitive",
      },
    });

    expect(namesOf(built)).not.toContain("Anthropic_Api_Key");
  });

  it("NEGATIVE CONTROL — the same input under case-sensitive matching keeps the variant", () => {
    // Without this arm the case-insensitive assertion above would pass equally
    // for a builder that lower-cased everything unconditionally, or for one that
    // stripped any name resembling a denied one. The mode has to decide.
    const built = buildProviderSpawnEnv({
      driverName: "codex",
      baseEnv: [...CURATED_BASE, ["Anthropic_Api_Key", "sk-live"]],
      credentialEnvPolicy: {
        denyEnvVars: ["ANTHROPIC_API_KEY"],
        envNameMatch: "case-sensitive",
      },
    });

    expect(valueOf(built, "Anthropic_Api_Key")).toBe("sk-live");
  });

  it("replaces a case-variant of a mandated name rather than shipping both", () => {
    // The mirror of the strip's mode-awareness: on a case-insensitive host,
    // appending `DISABLE_UPDATES` beside an inherited `disable_updates=0` would
    // hand the outcome to the process launcher.
    const built = buildProviderSpawnEnv({
      driverName: "claude",
      baseEnv: [["disable_updates", "0"]],
      credentialEnvPolicy: { denyEnvVars: [], envNameMatch: "case-insensitive" },
    });

    expect(namesOf(built)).not.toContain("disable_updates");
    expect(valueOf(built, "DISABLE_UPDATES")).toBe("1");
  });
});

describe("provider spawn environment — per-connection mandated pairs", () => {
  const CODEX_BIN = "AI_SIDEKICKS_CODEX_APP_SERVER_BIN";

  it("keeps a per-connection mandated pair that a deny list names", () => {
    // The exact-build-path pin is what stands in for codex-cli's absent
    // environment opt-out. If a policy could strip it, the child would fall back
    // to whatever the launcher resolves to — which is the floating build the
    // suppression obligation exists to prevent.
    const built = buildProviderSpawnEnv({
      driverName: "codex",
      baseEnv: CURATED_BASE,
      credentialEnvPolicy: { denyEnvVars: [CODEX_BIN], envNameMatch: "case-sensitive" },
      additionalMandatedPairs: [[CODEX_BIN, "/opt/codex/bin/codex"]],
    });

    expect(valueOf(built, CODEX_BIN)).toBe("/opt/codex/bin/codex");
  });

  it("appends mandated pairs after the surviving base, in a stable order", () => {
    const built = buildProviderSpawnEnv({
      driverName: "claude",
      baseEnv: CURATED_BASE,
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

  // A per-connection pair may not decide the value of a declared opt-out. The
  // table drives these so the refusal is asserted against a DIFFERING value —
  // where a silent last-wins merge would actually lower the suppression — and
  // against a matching restatement, where the refusal is about authority over
  // the name rather than about the value.
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
        additionalMandatedPairs: pairs,
      }),
    ).toThrow(ProviderSpawnEnvConflictError);
  });

  it("refuses a case-variant collision on a case-insensitive host", () => {
    // The collision check reads the host's match mode, so a host that cannot
    // tell `disable_updates` from `DISABLE_UPDATES` must not be handed both.
    expect(() =>
      buildProviderSpawnEnv({
        driverName: "claude",
        baseEnv: CURATED_BASE,
        credentialEnvPolicy: { denyEnvVars: [], envNameMatch: "case-insensitive" },
        additionalMandatedPairs: [["disable_updates", "0"]],
      }),
    ).toThrow(ProviderSpawnEnvConflictError);
  });

  it("NEGATIVE CONTROL — the same case-variant pair passes under case-sensitive matching", () => {
    // Proves the refusal above is the match mode talking rather than the name:
    // on a case-sensitive host the two names ARE different variables, and the
    // declared opt-out still reaches the child at its own value.
    const built = buildProviderSpawnEnv({
      driverName: "claude",
      baseEnv: CURATED_BASE,
      credentialEnvPolicy: { denyEnvVars: [], envNameMatch: "case-sensitive" },
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
        additionalMandatedPairs: [["DISABLE_AUTOUPDATER", "0"]],
      });
    } catch (error) {
      expect((error as ProviderSpawnEnvConflictError).conflictingName).toBe("DISABLE_AUTOUPDATER");
    }
  });
});
