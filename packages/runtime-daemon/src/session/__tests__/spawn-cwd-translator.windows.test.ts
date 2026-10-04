// Windows-only check of what keeps `ERROR_SHARING_VIOLATION` off a worktree teardown: the `cwd`
// handed to the backend is the stable parent, not the worktree. The pure transform is covered on
// every platform in `spawn-cwd-translator.test.ts`; here `describe.skipIf` makes this file a no-op
// elsewhere. A recording in-memory `PtyHost` stands in for a real backend.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { translateSpawnCwd } from "../spawn-cwd-translator.js";
import type { TranslateSpawnCwdInput } from "../spawn-cwd-translator.js";
import type { PtySignal, SpawnRequest, SpawnResponse } from "../../pty/pty-host-protocol.js";
import type { DrainResult, PtyHost } from "../../pty/pty-host.js";

// ----------------------------------------------------------------------------
// Minimal in-memory PtyHost — recording mock
// ----------------------------------------------------------------------------

class RecordingPtyHost implements PtyHost {
  public readonly spawned: SpawnRequest[] = [];
  public closed: boolean = false;

  async spawn(spec: SpawnRequest): Promise<SpawnResponse> {
    this.spawned.push(spec);
    return await Promise.resolve({
      kind: "spawn_response",
      session_id: `mock-session-${this.spawned.length.toString()}`,
    });
  }

  async resize(_sessionId: string, _rows: number, _cols: number): Promise<void> {
    return await Promise.resolve();
  }

  async write(_sessionId: string, _bytes: Uint8Array): Promise<void> {
    return await Promise.resolve();
  }

  async kill(_sessionId: string, _signal: PtySignal): Promise<void> {
    return await Promise.resolve();
  }

  async close(_sessionId: string): Promise<void> {
    this.closed = true;
    return await Promise.resolve();
  }

  /** Satisfies the `PtyHost` interface; the recording host has nothing to drain. */
  async shutdown(_options: {
    readonly perSessionTimeoutMs: number;
    readonly hostTimeoutMs: number;
  }): Promise<DrainResult> {
    return await Promise.resolve({
      sessionsDrained: 0,
      sessionsForcedKilled: 0,
      sidecarExitedCleanly: true,
      taskkillEscalated: false,
    });
  }

  onData(_sessionId: string, _chunk: Uint8Array): void {
    // no-op
  }

  onExit(_sessionId: string, _exitCode: number, _signalCode?: number): void {
    // no-op
  }
}

// ----------------------------------------------------------------------------
// Test fixtures
// ----------------------------------------------------------------------------

interface TestContext {
  host: RecordingPtyHost;
  worktree: string;
  stableParent: string;
}

let ctx: TestContext;

beforeEach(() => {
  const stableParent: string = mkdtempSync(join(tmpdir(), "ai-sidekicks-spawn-cwd-"));
  const worktree: string = join(stableParent, "worktrees", "feature-x");

  ctx = {
    host: new RecordingPtyHost(),
    worktree,
    stableParent,
  };
});

afterEach(() => {
  rmSync(ctx.stableParent, { recursive: true, force: true });
});

// ----------------------------------------------------------------------------
// Windows: the backend never sees the worktree as cwd
// ----------------------------------------------------------------------------

describe.skipIf(process.platform !== "win32")(
  "translateSpawnCwd × PtyHost.spawn — Windows worktree teardown",
  () => {
    it(
      "translated cwd is the stable parent (not the worktree); worktree path lives in cmd.exe " +
        "script",
      async () => {
        const spec: SpawnRequest = {
          kind: "spawn_request",
          command: "cmd.exe",
          args: [],
          env: [],
          cwd: ctx.worktree,
          rows: 24,
          cols: 80,
        };

        const translateInput: TranslateSpawnCwdInput = {
          spec,
          strategy: "cd-prefix",
          stableParent: ctx.stableParent,
        };
        const translated: SpawnRequest = translateSpawnCwd(translateInput);

        const response: SpawnResponse = await ctx.host.spawn(translated);
        expect(response.kind).toBe("spawn_response");

        // What the backend would see: the stable parent, so the OS cannot lock the worktree.
        const seen: SpawnRequest | undefined = ctx.host.spawned[0];
        expect(seen).toBeDefined();
        expect(seen?.cwd).toBe(ctx.stableParent);
        expect(seen?.command).toBe("cmd.exe");
        expect(seen?.args.slice(0, 4)).toEqual(["/d", "/s", "/v:off", "/c"]);

        // The worktree path survives in the wrapped script.
        expect(seen?.args[4]).toContain(`cd /d "${ctx.worktree}"`);
      },
    );
  },
);
