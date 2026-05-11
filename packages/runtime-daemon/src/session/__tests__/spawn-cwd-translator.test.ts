// Unit tests for the daemon-layer cwd translator.
//
// Scope: pure-transform behavior on POSIX hosts (Linux/macOS dev boxes
// and CI). The Windows behavior is exercised in the sibling
// `spawn-cwd-translator.windows.test.ts` (gated on `process.platform`).
//
// What we assert (invariant satisfaction)
// ---------------------------------------
//
//   - Post-translation `cwd` carries a stable parent, never the
//     original worktree path. This is the load-bearing daemon-layer
//     guarantee: the PTY backend (Rust sidecar or in-process
//     `node-pty`) sees a path the OS cannot hold a worktree lock on.
//   - The original worktree path lives in the command string (for
//     `cd-prefix`) or the env tuples (for `cwd-env`). It must be
//     RECOVERABLE from the translated request — without that, we'd
//     be losing the user-facing cwd silently.
//   - Both strategies preserve the input request's identity in their
//     respective unmodified fields (env for `cd-prefix`, args/command
//     for `cwd-env`).

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
    // The wrapping script must `cd` into the worktree, then `exec`
    // the original command so the PTY's child PID is the target,
    // not the wrapper shell.
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

    // Single-quoted spans are literal under sh; the embedded space
    // must NOT split the path into two arguments.
    expect(result.args[1]).toContain(`cd '${worktree}' && exec`);
  });

  it("shell-escapes worktree paths containing single quotes", () => {
    // POSIX single-quote escaping closes the span, emits an escaped
    // `'`, and re-opens: `'a'\''b'` → literal `a'b`.
    const worktree: string = "/Users/dev/worktrees/jane's-feature";
    const result: SpawnRequest = translateSpawnCwd(
      makeInput("cd-prefix", {
        spec: makeSpec({ cwd: worktree }),
        wrappingShell: "posix",
      }),
    );

    // The shell-safe form is /Users/dev/worktrees/jane'\''s-feature
    // wrapped in single quotes.
    expect(result.args[1]).toContain(`cd '/Users/dev/worktrees/jane'\\''s-feature'`);
  });

  it("shell-escapes args containing shell metacharacters", () => {
    const result: SpawnRequest = translateSpawnCwd(
      makeInput("cd-prefix", {
        spec: makeSpec({
          command: "bash",
          // These args, unquoted, would be reinterpreted by the
          // wrapping shell (`; ls` would run an extra command). The
          // quoter must neutralize them.
          args: ["-c", "echo 'hello'; ls"],
        }),
        wrappingShell: "posix",
      }),
    );

    // The dangerous arg is wrapped so `; ls` is literal text passed
    // to the inner shell, not a wrapping-shell command separator.
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
    // I-024-5 / CP-001-2: the worktree path must live in the command
    // string layer, not the spawn-call cwd. The test asserts the
    // path is in fact present in the wrapped script (no silent loss).
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
//
// These tests run on every platform because the translator is pure —
// we override `wrappingShell` to `windows-cmd` explicitly. The actual
// Windows process-spawn integration test lives in the sibling
// `*.windows.test.ts` file.

describe("translateSpawnCwd — cd-prefix (Windows cmd.exe wrapping)", () => {
  it("rewrites cwd to stable parent and wraps in `cmd.exe /d /s /c`", () => {
    const result: SpawnRequest = translateSpawnCwd(
      makeInput("cd-prefix", {
        spec: makeSpec({ cwd: "C:\\Users\\dev\\worktrees\\feature-x" }),
        stableParent: "C:\\Users\\dev",
        wrappingShell: "windows-cmd",
      }),
    );

    expect(result.cwd).toBe("C:\\Users\\dev");
    expect(result.command).toBe("cmd.exe");
    expect(result.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
  });

  it("uses `cd /d` so drive-letter switches succeed", () => {
    const result: SpawnRequest = translateSpawnCwd(
      makeInput("cd-prefix", {
        spec: makeSpec({ cwd: "D:\\worktrees\\feature-x" }),
        stableParent: "C:\\Users\\dev",
        wrappingShell: "windows-cmd",
      }),
    );

    expect(result.args[3]).toContain(`cd /d "D:\\worktrees\\feature-x"`);
  });

  it("double-quote-escapes embedded quotes in cmd.exe quoting form", () => {
    // cmd.exe escapes a literal `"` inside a quoted span by doubling
    // it (`""`). Filesystem paths with `"` are rare on Windows
    // (illegal in NTFS file names) but the escape rule must hold
    // for command/args.
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

    expect(result.args[3]).toContain('"C:\\tools\\quoted ""tool"".exe"');
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
    // The protocol declares `env` as `Array<[string, string]>` because
    // POSIX `execve` and Windows `CreateProcess` preserve order and
    // accept duplicates. The translator must NOT dedupe or reorder.
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

    // The first three entries are the input env, unchanged in order
    // and value; the appended CWD comes last.
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

    // Input not mutated.
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
    // This test documents the intentional non-idempotency: idempotency
    // detection would require a marker either on the wire (mutating
    // the protocol contract) or in env (colliding with cwd-env). Both
    // are worse than pushing single-invocation discipline to the caller,
    // where the single chokepoint (session-spawn entry) already exists.
    //
    // If a future refactor changes this, update this test and the
    // "Invocation contract" header on `spawn-cwd-translator.ts`.
    const first: SpawnRequest = translateSpawnCwd(
      makeInput("cd-prefix", { wrappingShell: "posix" }),
    );
    const second: SpawnRequest = translateSpawnCwd({
      spec: first,
      strategy: "cd-prefix",
      stableParent: STABLE_PARENT,
      wrappingShell: "posix",
    });

    // Outer shell wraps the inner shell wrap; the inner script is
    // nested inside the outer `exec` form.
    expect(second.command).toBe("/bin/sh");
    expect(second.args[0]).toBe("-c");
    expect(second.args[1]).toContain("exec '/bin/sh' '-c'");
  });

  it("defaults wrappingShell from process.platform when omitted", () => {
    // The defaulting branch is `windows-cmd` on Windows, `posix`
    // otherwise. The CI matrix runs Linux/macOS only for this unit
    // file, so the default branch lands on `posix` here. The Windows
    // CI integration test exercises the `windows-cmd` default
    // implicitly when it omits `wrappingShell`.
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
