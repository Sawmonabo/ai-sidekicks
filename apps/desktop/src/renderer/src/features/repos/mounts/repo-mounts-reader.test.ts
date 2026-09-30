// The read: what it asks, and in what order. The real reader runs over scripted calls on a
// frozen clock.

import { afterEach, describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { REFRESH_DEBOUNCE_MS } from "@renderer/lib/reads/refresh-caps.js";
import {
  CANONICAL_ROOT,
  DRIFTED_MOUNT_ID,
  HEALTHY_MOUNT_ID,
  UNREACHABLE_MOUNT_ID,
  disposeTrackedReaders,
  openReader,
  sessionOperations,
  settle,
  worktreeRecord,
} from "./repo-mounts.test-support.js";

afterEach(disposeTrackedReaders);

describe("RepoMountsReader — the read", () => {
  it("learns the mounts from the workspace roster and reads each one for health", async () => {
    const clock = new ManualClock();
    const reader = openReader(sessionOperations(), clock);
    expect(reader.snapshot.status).toBe("not-read");

    reader.start();
    await settle(clock, reader);

    const reading = reader.snapshot;
    expect(reading.status).toBe("read");
    expect(reading.workspaces).toHaveLength(3);
    // The workspace list is where the mounts come from, and the mount read is the only call
    // that carries `health`. One read per distinct mount, each answering about the mount it named.
    expect(reading.mounts.map((mount) => mount.id)).toStrictEqual(
      reading.workspaces.map((row) => row.repoMountId),
    );
    expect(reading.mounts.map((mount) => mount.health.status)).toStrictEqual([
      "healthy",
      "unreachable",
      "identity_mismatch",
    ]);
  });

  it("reads each workspace's own execution-mode capabilities", async () => {
    const clock = new ManualClock();
    const reader = openReader(sessionOperations(), clock);
    reader.start();
    await settle(clock, reader);

    const reading = reader.snapshot;
    // One answer per workspace, keyed by the list's own ids.
    expect(Object.keys(reading.capabilitiesByWorkspaceId).sort()).toStrictEqual(
      reading.workspaces.map((row) => row.id).sort(),
    );
    const firstWorkspaceId = reading.workspaces[0]?.id ?? "";
    expect(reading.capabilitiesByWorkspaceId[firstWorkspaceId]?.defaultMode).toBe(
      "provisioned-worktree",
    );
  });

  it("reads the worktrees of every bound mount, mount by mount", async () => {
    // The status read is keyed by one project's folder, so three mounts mean three calls.
    const clock = new ManualClock();
    const reader = openReader(
      sessionOperations({
        readWorktreeStatus: (repoMountId) =>
          Promise.resolve({
            repoRoot: { path: CANONICAL_ROOT, branchName: "main" },
            worktrees: [
              worktreeRecord({
                worktreeId: `worktree-on-${repoMountId}`,
                repoMountId,
              }),
            ],
          }),
      }),
      clock,
    );
    reader.start();
    await settle(clock, reader);

    expect(reader.snapshot.worktrees.map((record) => record.worktreeId)).toStrictEqual([
      `worktree-on-${HEALTHY_MOUNT_ID}`,
      `worktree-on-${UNREACHABLE_MOUNT_ID}`,
      `worktree-on-${DRIFTED_MOUNT_ID}`,
    ]);
  });

  it("negative control: nothing is read until the section starts", async () => {
    // Without this the cases above would pass against a reader that read at construction,
    // putting a burst of daemon calls behind every render pass React discards.
    const clock = new ManualClock();
    const reader = openReader(sessionOperations(), clock);
    clock.advance(REFRESH_DEBOUNCE_MS);
    await Promise.resolve();
    expect(reader.performCount).toBe(0);
    expect(reader.snapshot.status).toBe("not-read");
  });

  it("starts once however many times it is asked to", async () => {
    // React mounts an effect twice under development strict mode; a reader that armed twice
    // would double every read.
    const clock = new ManualClock();
    const reader = openReader(sessionOperations(), clock);
    reader.start();
    reader.start();
    await settle(clock, reader);
    expect(reader.performCount).toBe(1);
  });
});
