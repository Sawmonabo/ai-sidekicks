// After `translateSpawnCwd`, the `SpawnRequest` that `RustSidecarPtyHost` writes to the sidecar
// carries the stable parent as `cwd` and the worktree only inside the wrapping shell script.

import { describe, expect, it } from "vitest";

import { RustSidecarPtyHost } from "../rust-sidecar-pty-host.js";
import { translateSpawnCwd } from "../../session/spawn-cwd-translator.js";
import {
  flushMicrotasks,
  frameEnvelope,
  makeFakeSidecarChild,
  parseFramesFromStdin,
  spawnReturning,
} from "./pty-host.test-support.js";
import type { Envelope, SpawnRequest } from "../pty-host-protocol.js";

interface PathFixture {
  readonly worktree: string;
  readonly stableParent: string;
}

const POSIX_PATHS: PathFixture = {
  worktree: "/Users/dev/worktrees/feature-x",
  stableParent: "/Users/dev",
};

const WINDOWS_PATHS: PathFixture = {
  worktree: "C:\\Users\\dev\\worktrees\\feature-x",
  stableParent: "C:\\Users\\dev",
};

function makeLogicalSpec(cwd: string): SpawnRequest {
  return {
    kind: "spawn_request",
    command: "bash",
    args: ["-l"],
    env: [
      ["PATH", "/usr/local/bin:/usr/bin:/bin"],
      ["HOME", "/Users/dev"],
    ],
    cwd,
    rows: 24,
    cols: 80,
  };
}

describe("translateSpawnCwd × RustSidecarPtyHost — POSIX cd-prefix", () => {
  it("the wire-frame written to the sidecar carries the stable parent in cwd; worktree path is recoverable from args[1] of the sh -c wrapping script", async () => {
    // A logical request whose cwd is the worktree path.
    const logical: SpawnRequest = makeLogicalSpec(POSIX_PATHS.worktree);

    // `wrappingShell: "posix"` is forced so the result does not depend on the host platform.
    const translated: SpawnRequest = translateSpawnCwd({
      spec: logical,
      strategy: "cd-prefix",
      stableParent: POSIX_PATHS.stableParent,
      wrappingShell: "posix",
    });

    const fake = makeFakeSidecarChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    // Yield once so stdin buffers the request, then ack it so `spawn` resolves.
    const spawnPromise = host.spawn(translated);
    await flushMicrotasks();
    fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));
    await spawnPromise;

    // The cwd on the wire must be the stable parent, the directory the OS could lock.
    const envelopes: Envelope[] = parseFramesFromStdin(fake.readStdin());
    expect(envelopes).toHaveLength(1);
    const wireFrame: Envelope | undefined = envelopes[0];
    expect(wireFrame).toBeDefined();
    expect(wireFrame?.kind).toBe("spawn_request");

    if (wireFrame?.kind !== "spawn_request") {
      throw new Error(
        `wire frame should be spawn_request after narrowing; got ${wireFrame?.kind ?? "undefined"}`,
      );
    }
    expect(wireFrame.cwd).toBe(POSIX_PATHS.stableParent);

    // The worktree survives in the `sh -c` script: `cd` lands in it before `exec` replaces the
    // shell with the target command.
    expect(wireFrame.command).toBe("/bin/sh");
    expect(wireFrame.args[0]).toBe("-c");
    const script: string | undefined = wireFrame.args[1];
    expect(script).toBeDefined();
    expect(script).toContain(`cd '${POSIX_PATHS.worktree}' && exec`);
    expect(script).toContain("'bash' '-l'");
  });
});

// Runs on every platform: the `windows-cmd` branch is a pure transform and `wrappingShell` is set
// explicitly.

describe("translateSpawnCwd × RustSidecarPtyHost — Windows cmd.exe cd-prefix", () => {
  it("the wire-frame carries the stable parent in cwd; worktree path is recoverable from args[4] of the cmd.exe /d /s /v:off /c wrapping script", async () => {
    const logical: SpawnRequest = makeLogicalSpec(WINDOWS_PATHS.worktree);

    const translated: SpawnRequest = translateSpawnCwd({
      spec: logical,
      strategy: "cd-prefix",
      stableParent: WINDOWS_PATHS.stableParent,
      wrappingShell: "windows-cmd",
    });

    const fake = makeFakeSidecarChild();
    const host = new RustSidecarPtyHost({
      resolveBinaryPath: () => "/fake/sidecar",
      spawn: spawnReturning(fake),
    });

    const spawnPromise = host.spawn(translated);
    await flushMicrotasks();
    fake.writeStdout(frameEnvelope({ kind: "spawn_response", session_id: "s-0" }));
    await spawnPromise;

    const envelopes: Envelope[] = parseFramesFromStdin(fake.readStdin());
    expect(envelopes).toHaveLength(1);
    const wireFrame: Envelope | undefined = envelopes[0];
    if (wireFrame?.kind !== "spawn_request") {
      throw new Error(
        `wire frame should be spawn_request after narrowing; got ${wireFrame?.kind ?? "undefined"}`,
      );
    }

    // As on POSIX, the wire cwd is the stable parent.
    expect(wireFrame.cwd).toBe(WINDOWS_PATHS.stableParent);

    expect(wireFrame.command).toBe("cmd.exe");
    expect(wireFrame.args.slice(0, 4)).toEqual(["/d", "/s", "/v:off", "/c"]);
    const script: string | undefined = wireFrame.args[4];
    expect(script).toBeDefined();
    // The worktree survives in the `cd /d` prefix of the cmd.exe script.
    expect(script).toContain(`cd /d "${WINDOWS_PATHS.worktree}"`);
    expect(script).toContain('"bash" "-l"');
  });
});
