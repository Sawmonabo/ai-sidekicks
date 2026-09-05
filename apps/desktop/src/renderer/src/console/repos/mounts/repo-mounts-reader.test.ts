// The read: what it asks, in what order, and what it says when the answer does not come.
//
// Every case here drives the REAL reader against the REAL fixture bridge on a frozen
// clock. Nothing stands in for the module under test, and no timer is real — the
// manual clock's `pendingCount` after teardown is what makes the "no timer outlives
// the section" claim a check rather than an assertion.

import { afterEach, describe, expect, it } from "vitest";

import { REPOS_SCENARIO, REPOS_WORKTREE_STATUS_REPLY } from "../../bridge/scenarios/repos.js";
import type { ConsoleScenario } from "../../bridge/scenario.js";
import { ManualClock, REFRESH_DEBOUNCE_MS } from "../../core/index.js";
import { openReader, settle, disposeTrackedReaders } from "./repo-mounts.test-support.js";

// Every reader a case opens is tracked, and none of them outlives its case.
afterEach(disposeTrackedReaders);

/** The one call that names an execution root, whichever kind. */
const ROOT_READ_CALL = "repo.worktreeStatusRead";

/**
 * The scenario's own root read, with its clones removed and its worktrees kept.
 *
 * Rebuilt from the scenario's own TYPED reply rather than by spreading an `unknown`
 * or parsing it here: the negative control's whole claim is that the two arrays travel
 * independently, a control assembled from a cast could disagree with the wire and
 * still pass, and the bridge door is the console's one parser — a suite that reached
 * the contract's schema would be a second one.
 */
function scenarioWithoutClones(): ConsoleScenario {
  return {
    ...REPOS_SCENARIO,
    id: "repos-without-clones",
    replies: [
      ...REPOS_SCENARIO.replies.filter((reply) => reply.call !== ROOT_READ_CALL),
      { call: ROOT_READ_CALL, result: { ...REPOS_WORKTREE_STATUS_REPLY, ephemeralClones: [] } },
    ],
  };
}

describe("RepoMountsReader — the read", () => {
  it("learns the mounts from the workspace roster and reads each one for health", async () => {
    const clock = new ManualClock();
    const reader = openReader(REPOS_SCENARIO, clock);
    expect(reader.snapshot.status).toBe("not-read");

    reader.start();
    await settle(clock, reader);

    const reading = reader.snapshot;
    expect(reading.status).toBe("read");
    expect(reading.workspaces).toHaveLength(2);
    // There is no `repo.mountList` on the wire; the roster is where the mounts come
    // from, and the mount read is the only surface that carries `health`. One read per
    // DISTINCT mount, and each answers about the mount it named — a scenario that
    // answered both with one mount would report a session holding two as holding one.
    expect(reading.mounts.map((mount) => mount.id)).toStrictEqual(
      reading.workspaces.map((row) => row.repoMountId),
    );
    expect(reading.mounts.map((mount) => mount.health.status)).toStrictEqual([
      "healthy",
      "unreachable",
    ]);
    expect(reading.refusal).toBeUndefined();
  });

  it("reads each workspace's own execution-mode capabilities", async () => {
    const clock = new ManualClock();
    const reader = openReader(REPOS_SCENARIO, clock);
    reader.start();
    await settle(clock, reader);

    const reading = reader.snapshot;
    // One answer per workspace, keyed by the roster's own ids rather than by ids
    // restated here — a literal would pin this case to the fixture's spelling and
    // pass for the wrong reason the day the roster grows a third row.
    expect(Object.keys(reading.capabilitiesByWorkspaceId).sort()).toStrictEqual(
      reading.workspaces.map((row) => row.id).sort(),
    );
    const firstWorkspaceId = reading.workspaces[0]?.id ?? "";
    expect(reading.capabilitiesByWorkspaceId[firstWorkspaceId]?.defaultMode).toBe("worktree");
  });

  it("carries both kinds of execution root the one status read answers with", async () => {
    const clock = new ManualClock();
    const reader = openReader(REPOS_SCENARIO, clock);
    reader.start();
    await settle(clock, reader);

    const reading = reader.snapshot;
    // The clone list used to be dropped on publication, so a session running in the
    // `ephemeral clone` mode reported no execution root while the daemon had named one.
    expect(reading.worktrees).toHaveLength(2);
    // Two clones, and the second is the swept one: `cleanedAt` decides a row's
    // disposition ahead of its deadline, so a scenario with no stamped clone could
    // not reach the reclaimed reading on any surface.
    expect(reading.ephemeralClones).toHaveLength(2);
    expect(reading.ephemeralClones[0]?.workspaceId).toBe(reading.workspaces[0]?.id);
    expect(reading.ephemeralClones[1]?.cleanedAt).toBeDefined();
  });

  it("negative control: a root read carrying no clone publishes none", async () => {
    // Without this the case above would pass against a reader that published a
    // constant, and against one that folded the clones in with the worktrees.
    const clock = new ManualClock();
    const reader = openReader(scenarioWithoutClones(), clock);
    reader.start();
    await settle(clock, reader);

    expect(reader.snapshot.worktrees).toHaveLength(2);
    expect(reader.snapshot.ephemeralClones).toStrictEqual([]);
  });

  it("negative control: nothing is read until the section starts", async () => {
    // Without this the case above would pass against a reader that read at
    // construction, which would put a burst of daemon calls behind every render pass
    // React discards.
    const clock = new ManualClock();
    const reader = openReader(REPOS_SCENARIO, clock);
    clock.advance(REFRESH_DEBOUNCE_MS);
    await Promise.resolve();
    expect(reader.performCount).toBe(0);
    expect(reader.snapshot.status).toBe("not-read");
  });

  it("starts once however many times it is asked to", async () => {
    // React mounts an effect twice under development strict mode, and a reader that
    // armed twice there would double every read in exactly the environment where the
    // budget is being watched.
    const clock = new ManualClock();
    const reader = openReader(REPOS_SCENARIO, clock);
    reader.start();
    reader.start();
    await settle(clock, reader);
    expect(reader.performCount).toBe(1);
  });
});

describe("RepoMountsReader — when the answer does not come", () => {
  it("publishes the refusal rather than an empty list", async () => {
    // The fixture rejects a call no scenario scripts, which is what the live bridge
    // would do for a wire the daemon refused. `Spec-023 §Console Design (Meridian)`
    // rule 8: "we have not asked" and "there are none" are different facts, and so is
    // "we asked and were refused".
    const clock = new ManualClock();
    const reader = openReader({ ...REPOS_SCENARIO, replies: [] }, clock);
    reader.start();
    await settle(clock, reader);

    const reading = reader.snapshot;
    expect(reading.status).toBe("read");
    expect(reading.refusal).toBeDefined();
    expect(reading.refusal?.origin).toBe("fixture-bridge");
    expect(reading.mounts).toStrictEqual([]);
  });

  it("scopes a refused capabilities read to the one workspace it was about", async () => {
    const clock = new ManualClock();
    const reader = openReader(
      {
        ...REPOS_SCENARIO,
        replies: REPOS_SCENARIO.replies.filter(
          (reply) => reply.call !== "repo.executionModeCapabilitiesRead",
        ),
      },
      clock,
    );
    reader.start();
    await settle(clock, reader);

    const reading = reader.snapshot;
    // The section as a whole answered; only the mode question did not.
    expect(reading.refusal).toBeUndefined();
    expect(reading.mounts).toHaveLength(2);
    expect(Object.keys(reading.workspaceRefusals.byCapabilitiesRead).sort()).toStrictEqual(
      reading.workspaces.map((row) => row.id).sort(),
    );
  });
});
