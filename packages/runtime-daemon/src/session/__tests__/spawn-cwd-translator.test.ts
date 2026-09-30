// `translateSpawnCwd` moves `cwd` to the stable parent, so the PTY holds no OS lock on a worktree,
// and carries the worktree path in a quoted shell script (`cd-prefix`) or the env (`cwd-env`).

import { describe, expect, it } from "vitest";

import { translateSpawnCwd } from "../spawn-cwd-translator.js";
import type { DriverStrategy, TranslateSpawnCwdInput } from "../spawn-cwd-translator.js";
import type { SpawnRequest } from "../../pty/pty-host-protocol.js";

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
});

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
});

describe("translateSpawnCwd — cwd-env (agent-CLI env propagation)", () => {
  it("rewrites cwd and appends the worktree as CWD, keeping env order and duplicates", () => {
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

    expect(result.cwd).toBe(STABLE_PARENT);
    expect(result.env).toEqual([
      ["PATH", "/usr/bin"],
      ["DEBUG", "*"],
      ["PATH", "/usr/bin:/usr/local/bin"],
      ["CWD", WORKTREE_PATH],
    ]);
  });
});

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

  it("defaults wrappingShell from process.platform when omitted", () => {
    // The default is `windows-cmd` on Windows and `posix` elsewhere.
    const result: SpawnRequest = translateSpawnCwd(makeInput("cd-prefix"));
    if (process.platform === "win32") {
      expect(result.command).toBe("cmd.exe");
    } else {
      expect(result.command).toBe("/bin/sh");
    }
  });
});
