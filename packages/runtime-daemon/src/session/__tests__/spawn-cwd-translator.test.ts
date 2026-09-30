// Tests for the cwd translator, a pure transform, so they run on every platform (the Windows
// wrapping shell is chosen explicitly). The OS-level teardown test is in
// `spawn-cwd-translator.windows.test.ts`.
//
// Two guarantees are asserted: the translated `cwd` is the stable parent, never the worktree
// path, so the PTY backend holds no OS lock on a worktree; and the worktree path stays
// recoverable from the command string (`cd-prefix`) or the env tuples (`cwd-env`).

import { describe, expect, it } from "vitest";

import { translateSpawnCwd } from "../spawn-cwd-translator.js";
import type {
  DriverStrategy,
  TranslateSpawnCwdInput,
  WrappingShell,
} from "../spawn-cwd-translator.js";
import type { SpawnRequest } from "@ai-sidekicks/contracts";

// ----------------------------------------------------------------------------
// Test fixtures
// ----------------------------------------------------------------------------

const WORKTREE_PATH: string = "/Users/dev/worktrees/feature-x";
const STABLE_PARENT: string = "/Users/dev";

function makeSpec(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    kind: "spawn_request",
    command: "bash",
    args: ["-l"],
    env: [
      ["PATH", "/usr/local/bin:/usr/bin:/bin"],
      ["HOME", "/Users/dev"],
    ],
    cwd: WORKTREE_PATH,
    rows: 24,
    cols: 80,
    ...overrides,
  };
}

function makeInput(
  strategy: DriverStrategy,
  overrides: Partial<TranslateSpawnCwdInput> = {},
): TranslateSpawnCwdInput {
  const input: TranslateSpawnCwdInput = {
    spec: makeSpec(),
    strategy,
    stableParent: STABLE_PARENT,
    ...overrides,
  };
  return input;
}

// ----------------------------------------------------------------------------
// cd-prefix strategy — POSIX wrapping shell
// ----------------------------------------------------------------------------

describe("translateSpawnCwd — cd-prefix (POSIX shell wrapping)", () => {
  it("rewrites cwd to the stable parent and wraps the command in `sh -c`", () => {
    const result: SpawnRequest = translateSpawnCwd(
      makeInput("cd-prefix", { wrappingShell: "posix" }),
    );

    expect(result.cwd).toBe(STABLE_PARENT);
    expect(result.command).toBe("/bin/sh");
    expect(result.args[0]).toBe("-c");
    // `exec` makes the PTY's child PID the target, not the wrapper shell.
    expect(result.args[1]).toContain(`cd '${WORKTREE_PATH}' && exec 'bash' '-l'`);
  });

  it("preserves env tuples unchanged (cd-prefix does not touch env)", () => {
    const spec: SpawnRequest = makeSpec();
    const result: SpawnRequest = translateSpawnCwd(
      makeInput("cd-prefix", { spec, wrappingShell: "posix" }),
    );

    expect(result.env).toEqual(spec.env);
  });

  it("preserves rows + cols + kind discriminant", () => {
    const result: SpawnRequest = translateSpawnCwd(
      makeInput("cd-prefix", {
        spec: makeSpec({ rows: 50, cols: 132 }),
        wrappingShell: "posix",
      }),
    );

    expect(result.kind).toBe("spawn_request");
    expect(result.rows).toBe(50);
    expect(result.cols).toBe(132);
  });

  it("shell-quotes worktree paths containing spaces", () => {
    const worktree: string = "/Users/dev/work trees/feature x";
    const result: SpawnRequest = translateSpawnCwd(
      makeInput("cd-prefix", {
        spec: makeSpec({ cwd: worktree }),
        wrappingShell: "posix",
      }),
    );

    // The embedded space must not split the path into two arguments.
    expect(result.args[1]).toContain(`cd '${worktree}' && exec`);
  });

  it("shell-escapes worktree paths containing single quotes", () => {
    // POSIX single-quote escaping closes the span, emits an escaped `'`, and re-opens:
    // `'a'\''b'` is the literal `a'b`.
    const worktree: string = "/Users/dev/worktrees/jane's-feature";
    const result: SpawnRequest = translateSpawnCwd(
      makeInput("cd-prefix", {
        spec: makeSpec({ cwd: worktree }),
        wrappingShell: "posix",
      }),
    );

    expect(result.args[1]).toContain(`cd '/Users/dev/worktrees/jane'\\''s-feature'`);
  });

  it("shell-escapes args containing shell metacharacters", () => {
    const result: SpawnRequest = translateSpawnCwd(
      makeInput("cd-prefix", {
        spec: makeSpec({
          command: "bash",
          // Unquoted, `; ls` would run an extra command in the wrapping shell.
          args: ["-c", "echo 'hello'; ls"],
        }),
        wrappingShell: "posix",
      }),
    );

    expect(result.args[1]).toContain(`exec 'bash' '-c' 'echo '\\''hello'\\''; ls'`);
  });

  it("handles empty-args spawns (no trailing space in the script)", () => {
    const result: SpawnRequest = translateSpawnCwd(
      makeInput("cd-prefix", {
        spec: makeSpec({ command: "bash", args: [] }),
        wrappingShell: "posix",
      }),
    );

    expect(result.args[1]).toBe(`cd '${WORKTREE_PATH}' && exec 'bash'`);
  });

  it("worktree path round-trips: it can be recovered from the wrapped script", () => {
    // The path must not be lost when `cwd` is replaced.
    const result: SpawnRequest = translateSpawnCwd(
      makeInput("cd-prefix", { wrappingShell: "posix" }),
    );
    const script: string | undefined = result.args[1];
    expect(script).toBeDefined();
    expect(script).toContain(WORKTREE_PATH);
  });
});

// ----------------------------------------------------------------------------
// cd-prefix strategy — Windows wrapping shell
// ----------------------------------------------------------------------------

describe("translateSpawnCwd — cd-prefix (Windows cmd.exe wrapping)", () => {
  it("rewrites cwd to stable parent and wraps in `cmd.exe /d /s /v:off /c`", () => {
    const result: SpawnRequest = translateSpawnCwd(
      makeInput("cd-prefix", {
        spec: makeSpec({ cwd: "C:\\Users\\dev\\worktrees\\feature-x" }),
        stableParent: "C:\\Users\\dev",
        wrappingShell: "windows-cmd",
      }),
    );

    expect(result.cwd).toBe("C:\\Users\\dev");
    expect(result.command).toBe("cmd.exe");
    expect(result.args.slice(0, 4)).toEqual(["/d", "/s", "/v:off", "/c"]);
  });

  it("passes `/v:off` between `/s` and `/c` (defense-in-depth vs. registry-flipped delayed expansion)", () => {
    // An operator can turn delayed expansion on system-wide through the
    // `HKLM\\SOFTWARE\\Microsoft\\Command Processor\\DelayedExpansion` registry value (or its
    // `HKCU` equivalent), and `!` is not caret-escaped, so `/v:off` keeps the wrapper independent
    // of that setting. `/c` consumes the rest of the command line, so `/v:off` must precede it.
    const result: SpawnRequest = translateSpawnCwd(
      makeInput("cd-prefix", {
        spec: makeSpec({ cwd: "C:\\worktrees\\f" }),
        stableParent: "C:\\Users\\dev",
        wrappingShell: "windows-cmd",
      }),
    );

    const vOffIdx: number = result.args.indexOf("/v:off");
    const cIdx: number = result.args.indexOf("/c");
    expect(vOffIdx).toBeGreaterThan(-1);
    expect(cIdx).toBeGreaterThan(-1);
    expect(vOffIdx).toBeLessThan(cIdx);
    expect(vOffIdx).toBe(2);
  });

  it("preserves literal `!VAR!` in args (delayed expansion disabled at the wrapper)", () => {
    // `quoteWindowsCmd` does not escape `!`; the wrapper's `/v:off` is what lets `!VAR!` reach
    // the target literally. Both halves of that contract are asserted here.
    const result: SpawnRequest = translateSpawnCwd(
      makeInput("cd-prefix", {
        spec: makeSpec({
          command: "deploy.exe",
          args: ["--env=!PROD!"],
          cwd: "C:\\worktrees\\f",
        }),
        stableParent: "C:\\Users\\dev",
        wrappingShell: "windows-cmd",
      }),
    );

    expect(result.args).toContain("/v:off");
    expect(result.args[4]).toContain('"--env=!PROD!"');
  });

  it("uses `cd /d` so drive-letter switches succeed", () => {
    const result: SpawnRequest = translateSpawnCwd(
      makeInput("cd-prefix", {
        spec: makeSpec({ cwd: "D:\\worktrees\\feature-x" }),
        stableParent: "C:\\Users\\dev",
        wrappingShell: "windows-cmd",
      }),
    );

    expect(result.args[4]).toContain(`cd /d "D:\\worktrees\\feature-x"`);
  });

  it("double-quote-escapes embedded quotes in cmd.exe quoting form", () => {
    // cmd.exe escapes a literal `"` inside a quoted span by doubling it. NTFS forbids `"` in
    // file names, but the rule must still hold for the command and args.
    const result: SpawnRequest = translateSpawnCwd(
      makeInput("cd-prefix", {
        spec: makeSpec({
          command: 'C:\\tools\\quoted "tool".exe',
          args: [],
          cwd: "C:\\worktrees\\f",
        }),
        stableParent: "C:\\Users\\dev",
        wrappingShell: "windows-cmd",
      }),
    );

    expect(result.args[4]).toContain('"C:\\tools\\quoted ""tool"".exe"');
  });

  it("caret-escapes %VAR% in args so cmd.exe does not expand env vars at the wrapper layer", () => {
    // cmd.exe scans `/c` script bytes for `%VAR%` even inside `"..."` spans. Unescaped, the
    // wrapper would expand `--env=%PROD%`, leaking the daemon's env or substituting an empty
    // string. The target must see `%PROD%` literally.
    const result: SpawnRequest = translateSpawnCwd(
      makeInput("cd-prefix", {
        spec: makeSpec({
          command: "deploy.exe",
          args: ["--env=%PROD%"],
          cwd: "C:\\worktrees\\f",
        }),
        stableParent: "C:\\Users\\dev",
        wrappingShell: "windows-cmd",
      }),
    );

    expect(result.args[4]).toContain('"--env=^%PROD^%"');
    expect(result.args[4]).not.toContain("=%PROD%");
  });

  it.each([
    { input: "%FOO", label: "leading `%` with no closer" },
    { input: "FOO%", label: "trailing `%` with no opener" },
    { input: "100%", label: "single `%` mid-string (percent-literal)" },
    { input: "%%PATH%%", label: "doubled `%` bracketing a name" },
    { input: "%", label: "lone `%`" },
    { input: "%%", label: "doubled `%` only" },
  ])(
    "caret-escapes every `%` regardless of pairing — boundary case: $label",
    ({ input }: { input: string }) => {
      // The rule is "every `%` becomes `^%`", not "every `%...%` pair is escaped". A pair-aware
      // regex such as `/%([^%]+)%/g` would pass the `%VAR%` test but corrupt these boundary
      // inputs. The defense is byte-level: any `%` reaching the wrapper unescaped is a bug.
      const result: SpawnRequest = translateSpawnCwd(
        makeInput("cd-prefix", {
          spec: makeSpec({
            command: "tool.exe",
            args: [input],
            cwd: "C:\\worktrees\\f",
          }),
          stableParent: "C:\\Users\\dev",
          wrappingShell: "windows-cmd",
        }),
      );

      const script: string = result.args[4] ?? "";
      // The quoted arg is the only part of the script containing `%`: the `cd` path and command
      // are `%`-free.
      const inputPercentCount: number = (input.match(/%/g) ?? []).length;
      const outputPercentCount: number = (script.match(/%/g) ?? []).length;
      const caretPercentPairCount: number = (script.match(/\^%/g) ?? []).length;

      expect(outputPercentCount).toBe(inputPercentCount);
      expect(caretPercentPairCount).toBe(outputPercentCount);
      // No `%` without a preceding `^`. Inside the class the `^` is literal, and ESLint flags
      // `\^` there as unnecessary.
      expect(/(^|[^^])%/.test(script)).toBe(false);
    },
  );

  it("caret-escapes each of & | < > ^ in args", () => {
    // Each must be `^`-prefixed so cmd.exe reads it literally, not as a separator (`&`, `|`),
    // redirection (`<`, `>`) or escape (`^`).
    const result: SpawnRequest = translateSpawnCwd(
      makeInput("cd-prefix", {
        spec: makeSpec({
          command: "tool.exe",
          args: ["a&b", "c|d", "e<f", "g>h", "i^j"],
          cwd: "C:\\worktrees\\f",
        }),
        stableParent: "C:\\Users\\dev",
        wrappingShell: "windows-cmd",
      }),
    );

    const script: string | undefined = result.args[4];
    expect(script).toBeDefined();
    expect(script).toContain('"a^&b"');
    expect(script).toContain('"c^|d"');
    expect(script).toContain('"e^<f"');
    expect(script).toContain('"g^>h"');
    expect(script).toContain('"i^^j"');
  });

  it("escapes caret before other metacharacters (order matters)", () => {
    // If `^` were escaped after `&`, the caret added for `&` would be doubled and corrupt the
    // literal.
    const result: SpawnRequest = translateSpawnCwd(
      makeInput("cd-prefix", {
        spec: makeSpec({
          command: "tool.exe",
          args: ["a^b&c"],
          cwd: "C:\\worktrees\\f",
        }),
        stableParent: "C:\\Users\\dev",
        wrappingShell: "windows-cmd",
      }),
    );

    // The wrong order would give `a^^b^^&c`.
    expect(result.args[4]).toContain('"a^^b^&c"');
  });

  it('preserves the `"` doubling rule when other metacharacters are present', () => {
    // Caret-escaping runs first, then `"` doubling, then the outer quotes; a string with both
    // `&` and `"` must survive all three.
    const result: SpawnRequest = translateSpawnCwd(
      makeInput("cd-prefix", {
        spec: makeSpec({
          command: 'tool "x" & y.exe',
          args: [],
          cwd: "C:\\worktrees\\f",
        }),
        stableParent: "C:\\Users\\dev",
        wrappingShell: "windows-cmd",
      }),
    );

    expect(result.args[4]).toContain('"tool ""x"" ^& y.exe"');
  });
});

// ----------------------------------------------------------------------------
// cwd-env strategy
// ----------------------------------------------------------------------------

describe("translateSpawnCwd — cwd-env (agent-CLI env propagation)", () => {
  it("rewrites cwd to the stable parent", () => {
    const result: SpawnRequest = translateSpawnCwd(makeInput("cwd-env"));
    expect(result.cwd).toBe(STABLE_PARENT);
  });

  it('appends `["CWD", <worktree>]` to env (worktree path recoverable)', () => {
    const result: SpawnRequest = translateSpawnCwd(makeInput("cwd-env"));

    const cwdEntry: [string, string] | undefined = result.env.find(
      ([key]: [string, string]): boolean => key === "CWD",
    );
    expect(cwdEntry).toEqual(["CWD", WORKTREE_PATH]);
  });

  it("preserves the input command + args + kind verbatim", () => {
    const spec: SpawnRequest = makeSpec({
      command: "claude-driver",
      args: ["--session", "abc123"],
    });
    const result: SpawnRequest = translateSpawnCwd({
      spec,
      strategy: "cwd-env",
      stableParent: STABLE_PARENT,
    });

    expect(result.kind).toBe("spawn_request");
    expect(result.command).toBe("claude-driver");
    expect(result.args).toEqual(["--session", "abc123"]);
  });

  it("preserves existing env tuples (order and duplicates per protocol contract)", () => {
    // `env` is a tuple array because POSIX `execve` and Windows `CreateProcess` keep order and
    // accept duplicates; the translator must not dedupe or reorder.
    const spec: SpawnRequest = makeSpec({
      env: [
        ["PATH", "/usr/bin"],
        ["DEBUG", "*"],
        ["PATH", "/usr/bin:/usr/local/bin"],
      ],
    });
    const result: SpawnRequest = translateSpawnCwd({
      spec,
      strategy: "cwd-env",
      stableParent: STABLE_PARENT,
    });

    expect(result.env).toEqual([
      ["PATH", "/usr/bin"],
      ["DEBUG", "*"],
      ["PATH", "/usr/bin:/usr/local/bin"],
      ["CWD", WORKTREE_PATH],
    ]);
  });

  it("does not mutate the input spec or env array", () => {
    const inputEnv: Array<[string, string]> = [["PATH", "/usr/bin"]];
    const spec: SpawnRequest = makeSpec({ env: inputEnv });
    const inputEnvCopyBefore: Array<[string, string]> = [...inputEnv];

    translateSpawnCwd({
      spec,
      strategy: "cwd-env",
      stableParent: STABLE_PARENT,
    });

    expect(inputEnv).toEqual(inputEnvCopyBefore);
    expect(spec.cwd).toBe(WORKTREE_PATH);
    expect(spec.env).toBe(inputEnv);
  });
});

// ----------------------------------------------------------------------------
// Cross-strategy + contract checks
// ----------------------------------------------------------------------------

describe("translateSpawnCwd — contract", () => {
  it("throws on empty stableParent (would fall back to parent-process cwd on Windows)", () => {
    expect(() =>
      translateSpawnCwd({
        spec: makeSpec(),
        strategy: "cd-prefix",
        stableParent: "",
        wrappingShell: "posix",
      }),
    ).toThrow(/stableParent.*non-empty/);
  });

  it("calling twice nests the wrapping (caller's contract is single-invocation)", () => {
    // Non-idempotency is intentional: detecting a second call would need a marker on the wire or
    // in env (colliding with `cwd-env`), so the caller owns single invocation.
    const first: SpawnRequest = translateSpawnCwd(
      makeInput("cd-prefix", { wrappingShell: "posix" }),
    );
    const second: SpawnRequest = translateSpawnCwd({
      spec: first,
      strategy: "cd-prefix",
      stableParent: STABLE_PARENT,
      wrappingShell: "posix",
    });

    expect(second.command).toBe("/bin/sh");
    expect(second.args[0]).toBe("-c");
    expect(second.args[1]).toContain("exec '/bin/sh' '-c'");
  });

  it("defaults wrappingShell from process.platform when omitted", () => {
    // The default is `windows-cmd` on Windows and `posix` elsewhere.
    const result: SpawnRequest = translateSpawnCwd(makeInput("cd-prefix"));
    if (process.platform === "win32") {
      expect(result.command).toBe("cmd.exe");
    } else {
      expect(result.command).toBe("/bin/sh");
    }
  });

  it("explicit wrappingShell beats process.platform default", () => {
    const result: SpawnRequest = translateSpawnCwd(
      makeInput("cd-prefix", { wrappingShell: "windows-cmd" satisfies WrappingShell }),
    );
    expect(result.command).toBe("cmd.exe");
  });
});
