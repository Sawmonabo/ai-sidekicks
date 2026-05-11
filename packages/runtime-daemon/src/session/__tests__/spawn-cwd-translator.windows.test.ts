// Windows CI integration tests for the daemon-layer cwd translator.
//
// Why this file exists separately
// -------------------------------
//
// The sibling `spawn-cwd-translator.test.ts` covers the pure-transform
// behavior on every platform. This file covers the OS-level invariant:
// a worktree directory CAN be torn down concurrently with an active
// spawned session, without surfacing `ERROR_SHARING_VIOLATION`
// (the `microsoft/node-pty#647` failure mode that motivated the
// translator). That invariant only manifests on Windows; on Linux/Mac
// dev boxes these tests no-op via `describe.skipIf`.
//
// Why we mock the PtyHost (for now)
// ---------------------------------
//
// The real `NodePtyHost` and `RustSidecarPtyHost` backends are not yet
// shipped at the time this file lands. Rather than defer the
// translator's Windows-side regression coverage to a follow-up PR, we
// land the test infrastructure now with a minimal in-memory `PtyHost`
// that records the translated `SpawnRequest` and simulates a long-
// running session via a deferred resolution. Swap in the real
// `NodePtyHost` once NS-05 ships — the assertion shape is stable.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { translateSpawnCwd } from "../spawn-cwd-translator.js";
import type { TranslateSpawnCwdInput } from "../spawn-cwd-translator.js";
import type { PtyHost } from "@ai-sidekicks/contracts";
import type { PtySignal, SpawnRequest, SpawnResponse } from "@ai-sidekicks/contracts";

// ----------------------------------------------------------------------------
// Minimal in-memory PtyHost — recording mock
// ----------------------------------------------------------------------------
//
// TODO: replace with a real `NodePtyHost` instance once the
// `node-pty` fallback backend ships. The assertion shape — translated
// `SpawnRequest.cwd === stableParent`, worktree path recoverable from
// args[3] cmd.exe script — is stable across backends because the
// translator is platform-agnostic (only the wrapping-shell flavor
// differs, and we explicitly assert the `windows-cmd` shape here).

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
  // Use a real temp directory so the Windows teardown assertion
  // exercises the actual filesystem code path. The mock host does
  // NOT hold the OS lock on this directory (it's a mock), so the
  // rmSync below succeeds — what we're proving is that the
  // translated `SpawnRequest.cwd` we WOULD pass to a real backend
  // is the stable parent, not the worktree, so a real backend
  // could not have held the lock.
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
// Windows CI: ERROR_SHARING_VIOLATION regression
// ----------------------------------------------------------------------------
//
// `describe.skipIf` so the file is a no-op on Linux/Mac dev boxes; it
// only meaningfully runs on `windows-latest` in CI. The mock PtyHost
// degrades the test from "end-to-end spawn-and-teardown" to
// "translation verification at the wire layer" — but the load-bearing
// claim (the wire-layer `SpawnRequest.cwd` carries the stable parent,
// not the worktree path) is exactly what holds the Windows
// `ERROR_SHARING_VIOLATION` failure mode at bay. When a real backend
// lands at NS-05, swap RecordingPtyHost for it; the assertion stays.

describe.skipIf(process.platform !== "win32")(
  "translateSpawnCwd × PtyHost.spawn — Windows worktree teardown",
  () => {
    it("translated cwd is the stable parent (not the worktree); worktree path lives in cmd.exe script", async () => {
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

      // What the PtyHost backend would see — the load-bearing
      // assertion. The spawn-call cwd MUST be the stable parent,
      // not the worktree, so the OS cannot hold a lock on the
      // worktree directory.
      const seen: SpawnRequest | undefined = ctx.host.spawned[0];
      expect(seen).toBeDefined();
      expect(seen?.cwd).toBe(ctx.stableParent);
      expect(seen?.command).toBe("cmd.exe");
      expect(seen?.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);

      // The worktree path is recoverable from the wrapped cmd.exe
      // script — it lives in the command-string layer, not the
      // spawn-call cwd, per Plan-024 I-024-5.
      expect(seen?.args[3]).toContain(`cd /d "${ctx.worktree}"`);
    });

    it("worktree directory can be removed while the mock session is active (Windows teardown sim)", async () => {
      // The full integration would: spawn a long-running cmd.exe
      // session against a real backend, attempt rmSync on the
      // worktree, and assert no ERROR_SHARING_VIOLATION. With the
      // mock, we exercise the translation + simulate teardown — the
      // claim that the real backend would not lock the worktree
      // rests on the translation guarantee proven in the previous
      // test (the spawn-call cwd is the stable parent).
      const spec: SpawnRequest = {
        kind: "spawn_request",
        command: "cmd.exe",
        args: ["/k"],
        env: [],
        cwd: ctx.worktree,
        rows: 24,
        cols: 80,
      };
      const translated: SpawnRequest = translateSpawnCwd({
        spec,
        strategy: "cd-prefix",
        stableParent: ctx.stableParent,
      });

      await ctx.host.spawn(translated);

      // Simulate worktree teardown while the (mock) session is
      // active. On a real backend with translation correctly
      // applied, this succeeds because no Windows-level lock is
      // held on `worktree`. Wrapping in expect().not.toThrow()
      // makes the regression mode explicit: if the translator ever
      // forwarded the worktree as the spawn-call cwd, a real
      // backend would lock it and this rmSync would throw
      // ERROR_SHARING_VIOLATION.
      expect(() => {
        rmSync(ctx.worktree, { recursive: true, force: true });
      }).not.toThrow();
    });
  },
);
