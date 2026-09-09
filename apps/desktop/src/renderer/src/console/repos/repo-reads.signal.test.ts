// The two repos reads that used to be made outside a round, driven through the door.
//
// WHAT THIS IS ABOUT, and why it is a suite of its own. `repo-reads.ts` opens by
// claiming that every read in it takes a signal and that the requirement is what makes
// "a read here cannot be made outside a round" structural. Two functions contradicted
// it — the mount-scoped capabilities arm and the reuse check — and both are the shape
// the claim is easiest to break in: a SECOND wrapper over a method whose first wrapper
// already carried one. So the cases below are about those two specifically, and each
// is driven through the real `callDaemon` door rather than through a stub, because
// what is being asserted is that the signal ARRIVES there.
//
// AN ABORTED SIGNAL IS THE INSTRUMENT, not a spy on the call. The door refuses
// `read-abandoned` before it sends, so a wrapper that forwards its signal answers that
// refusal and a wrapper that drops it answers the fixture's own served reply. The
// difference is total, it needs no counter, and it is the same observation the
// abandonment suite in `bridge/daemon/` makes of the door itself.

import type { RepoMountId } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { GIT_MOUNT_ID } from "../bridge/scenario/repos/repos-fixture-data.js";
import { REPOS_SCENARIO } from "../bridge/scenario/repos/repos.js";
import { ReadScope } from "../store/index.js";
import { checkWorktreeReuse, readMountExecutionModeCapabilities } from "./repo-reads.js";

/** The branch the repos scenario holds a live, dirty, compatible candidate for. */
const CANDIDATE_BRANCH = "feat/rate-limit-wiring";

function fixtureBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: REPOS_SCENARIO });
}

/** A round nobody is waiting on any more — a surface that opened and then left. */
function abandonedSignal(): AbortSignal {
  const scope = new ReadScope();
  const round = scope.openRound();
  scope.abandon();
  return round.signal;
}

/** A round that is open, which is what a live surface hands its read. */
function liveSignal(): AbortSignal {
  return new ReadScope().openRound().signal;
}

describe("readMountExecutionModeCapabilities — the pre-bind arm reads inside a round", () => {
  it("answers the fixture's own reply while the round is open", async () => {
    // The floor. Without it the abandoned case below would pass over a wrapper that
    // never reaches the wire at all, and prove nothing about the signal.
    const reply = await readMountExecutionModeCapabilities(
      fixtureBridge(),
      GIT_MOUNT_ID as RepoMountId,
      liveSignal(),
    );
    expect(reply.status).toBe("served");
  });

  it("negative control: an abandoned round stops it at the door", async () => {
    // THE ASSERTION. The bind dialog closed while its pre-bind read was outstanding:
    // the reply is not parsed, the modes are not folded, and what comes back is the
    // departure rather than a capability set for a form nobody is filling in.
    const reply = await readMountExecutionModeCapabilities(
      fixtureBridge(),
      GIT_MOUNT_ID as RepoMountId,
      abandonedSignal(),
    );
    expect(reply.status).toBe("refused");
    expect(reply.status === "refused" && reply.refusal.code).toBe("read-abandoned");
  });
});

describe("checkWorktreeReuse — the reuse check reads inside a round", () => {
  it("answers the fixture's own verdict while the round is open", async () => {
    const reply = await checkWorktreeReuse(
      fixtureBridge(),
      GIT_MOUNT_ID as RepoMountId,
      CANDIDATE_BRANCH,
      liveSignal(),
    );
    expect(reply.status).toBe("served");
    expect(reply.status === "served" && reply.value.available).toBe(true);
  });

  it("negative control: an abandoned round stops it at the door", async () => {
    // The check a participant supersedes most often — it is re-asked as they type a
    // branch name — so this is the read that most wanted a signal and had none.
    const reply = await checkWorktreeReuse(
      fixtureBridge(),
      GIT_MOUNT_ID as RepoMountId,
      CANDIDATE_BRANCH,
      abandonedSignal(),
    );
    expect(reply.status).toBe("refused");
    expect(reply.status === "refused" && reply.refusal.code).toBe("read-abandoned");
  });
});
