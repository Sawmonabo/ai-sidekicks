// Minting a diff against the fixture: the attribution first, then the two calls.
//
// EVERY CASE DRIVES THE REAL FIXTURE BRIDGE, which is what makes the last two claims
// checkable at all: a hand-built port would answer whatever a case wrote beside it, and
// the two things worth proving here — that the payload comes back on a SECOND call, and
// that what comes back parses as a unified patch — are properties of the scenario's own
// answers rather than of this suite's expectations.

import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge } from "../../../bridge/index.js";
import {
  fixtureBridgeWithGrowth,
  growthRefusing,
} from "../../../bridge/fixture/call-plane/bridge.test-support.js";
import { REPOS_SCENARIO } from "../../../bridge/scenario/repos/repos.js";
import {
  RUN_ATTRIBUTED_COMPARED_STATES,
  UNSCRIPTED_COMPARISON_REFUSAL_CODE,
  WORKSPACE_FALLBACK_COMPARED_STATES,
} from "../../../bridge/scenario/repos/repos-diff-replies.js";
import {
  GIT_WORKSPACE_ID,
  IMPLEMENTER_RUN_ID,
  IMPLEMENTER_WORKTREE_ID,
  REVIEWER_WORKTREE_ID,
  SESSION_ID,
} from "../../../bridge/scenario/repos/repos-fixture-data.js";
import { ManualClock, REFRESH_DEBOUNCE_MS } from "../../../core/index.js";
import { SessionStore } from "../../../store/index.js";
import type { ConsoleBridge } from "../../../bridge/index.js";
import { DiffArtifactCreationController } from "./diff-creation-controller.js";
import type { DiffCreateSubject } from "./diff-create-subject.js";
import {
  SUBJECT_NOT_RESOLVED_DETAIL,
  WORKTREE_NOT_IN_SESSION_DETAIL,
  WORKTREE_WITHOUT_RUN_DETAIL,
} from "./diff-creation-model.js";

/** The subject a diff pane opened over the git workspace resolves from. */
const WORKSPACE_SUBJECT: DiffCreateSubject = { kind: "workspace", workspaceId: GIT_WORKSPACE_ID };

/** The subject a diff pane opened over the implementer's execution root resolves from. */
const IMPLEMENTER_SUBJECT: DiffCreateSubject = {
  kind: "worktree",
  worktreeId: IMPLEMENTER_WORKTREE_ID,
  sessionId: SESSION_ID,
};

// THE TWO PAIRS ARE THE SCENARIO'S OWN, and a case takes the one its subject scripts.
// The fixture answers a subject for exactly the comparison that subject resolves, so a
// literal written here would drift into an unscripted pair the moment either moved —
// and every case below would then be asserting a refusal it did not mean to ask for.

const controllers: DiffArtifactCreationController[] = [];

function open(
  subject: DiffCreateSubject,
  bridge: ConsoleBridge = createFixtureBridge({ scenario: REPOS_SCENARIO }),
): { readonly controller: DiffArtifactCreationController; readonly clock: ManualClock } {
  const clock = new ManualClock();
  const controller = new DiffArtifactCreationController({
    bridge,
    subject,
    sessionStore: new SessionStore({ sessionId: REPOS_SCENARIO.sessionId }),
    clock,
  });
  controllers.push(controller);
  return { controller, clock };
}

/** Move past the debounce and let the attribution land. */
async function settleResolution(
  controller: DiffArtifactCreationController,
  clock: ManualClock,
): Promise<void> {
  controller.start();
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
  clock.advance(REFRESH_DEBOUNCE_MS);
  for (
    let turn = 0;
    turn < 50 && controller.snapshot.prerequisite.status === "reading";
    turn += 1
  ) {
    await Promise.resolve();
  }
}

afterEach(() => {
  while (controllers.length > 0) {
    controllers.pop()?.dispose();
  }
});

describe("DiffArtifactCreationController — which key the subject resolves to", () => {
  it("takes a workspace id as the fallback arm's key without asking anything", async () => {
    const { controller, clock } = open(WORKSPACE_SUBJECT);
    await settleResolution(controller, clock);
    const { prerequisite } = controller.snapshot;
    expect(prerequisite.status).toBe("read");
    expect(prerequisite.status === "read" && prerequisite.value).toStrictEqual({
      attributionMode: "workspace_fallback",
      workspaceId: GIT_WORKSPACE_ID,
    });
  });

  it("reads the run that provisioned an execution root off the session's own roots", async () => {
    const { controller, clock } = open(IMPLEMENTER_SUBJECT);
    await settleResolution(controller, clock);
    const { prerequisite } = controller.snapshot;
    expect(prerequisite.status === "read" && prerequisite.value).toStrictEqual({
      attributionMode: "run_attributed",
      runId: IMPLEMENTER_RUN_ID,
    });
  });

  it("refuses a root that names no run rather than picking one for it", async () => {
    // The reviewer's root is the fixture's prepared-ahead-of-a-run case:
    // `worktrees.created_by_run_id` is nullable and this row leaves it absent.
    const { controller, clock } = open({
      kind: "worktree",
      worktreeId: REVIEWER_WORKTREE_ID,
      sessionId: SESSION_ID,
    });
    await settleResolution(controller, clock);
    const { prerequisite } = controller.snapshot;
    expect(prerequisite.status).toBe("refused");
    expect(prerequisite.status === "refused" && prerequisite.refusal.detail).toBe(
      WORKTREE_WITHOUT_RUN_DETAIL,
    );
  });

  it("refuses a root this session's read does not contain", async () => {
    const { controller, clock } = open({
      kind: "worktree",
      worktreeId: "9f2c4a10-0000-4000-8000-0000000000ff",
      sessionId: SESSION_ID,
    });
    await settleResolution(controller, clock);
    const { prerequisite } = controller.snapshot;
    expect(prerequisite.status === "refused" && prerequisite.refusal.detail).toBe(
      WORKTREE_NOT_IN_SESSION_DETAIL,
    );
  });
});

describe("DiffArtifactCreationController — the mint and the payload read", () => {
  it("puts a parsed change set on the reading for the workspace arm", async () => {
    const { controller, clock } = open(WORKSPACE_SUBJECT);
    await settleResolution(controller, clock);
    await controller.createDiff(WORKSPACE_FALLBACK_COMPARED_STATES);
    const { act } = controller.snapshot;
    expect(act.status).toBe("created");
    if (act.status !== "created") {
      return;
    }
    // The attribution the model wears is the arm that was SENT, never a member of the
    // reply — the create answers three ids and no attribution at all.
    expect(act.diff.attribution).toStrictEqual({
      mode: "workspace_fallback",
      workspaceId: GIT_WORKSPACE_ID,
    });
    // The scenario's workspace patch, parsed: a textual change, a mode change, and a
    // binary file. This is also the proof that the fixture's patch text is a patch —
    // the parser refuses one whose hunk headers and hunks disagree.
    expect(act.diff.files.map((file) => file.path)).toStrictEqual([
      "apps/desktop/src/renderer/src/console/repos/repos.css",
      "scripts/prepare-execution-root.sh",
      "apps/desktop/resources/icon.png",
    ]);
  });

  it("puts the run-attributed change set on the reading for the worktree arm", async () => {
    const { controller, clock } = open(IMPLEMENTER_SUBJECT);
    await settleResolution(controller, clock);
    await controller.createDiff(RUN_ATTRIBUTED_COMPARED_STATES);
    const { act } = controller.snapshot;
    expect(act.status === "created" && act.diff.attribution).toStrictEqual({
      mode: "run_attributed",
      runId: IMPLEMENTER_RUN_ID,
    });
    // Two files and a rename among them, which is the case a renderer deriving its
    // file notes from hunk counts alone reports as nothing having happened.
    expect(act.status === "created" && act.diff.files.length).toBe(2);
  });

  it("negative control: the mint alone is not a change set, so a refused payload read refuses", async () => {
    // The create answers three ids and no bytes. A surface that stopped at the mint
    // would hold a manifest id it cannot open, and this is what proves it does not:
    // the mint is left scripted and only the SECOND call is refused.
    const { controller, clock } = open(
      WORKSPACE_SUBJECT,
      fixtureBridgeWithGrowth(REPOS_SCENARIO, { artifactRead: growthRefusing("artifactRead") }),
    );
    await settleResolution(controller, clock);
    await controller.createDiff(WORKSPACE_FALLBACK_COMPARED_STATES);
    expect(controller.snapshot.act.status).toBe("refused");
  });

  it("names a served payload that is not a patch, rather than reporting a failure", async () => {
    // The deferred arm is a SERVED answer — the daemon handed back a handle instead of
    // bytes, and no registered call fetches a payload by one — so the scenario answers
    // it here rather than a stand-in doing so: the same reply, asked without
    // `includePayload`, which is the wire's own discriminator between the two arms.
    const deferring = createFixtureBridge({ scenario: REPOS_SCENARIO });
    const { controller, clock } = open(
      WORKSPACE_SUBJECT,
      fixtureBridgeWithGrowth(REPOS_SCENARIO, {
        artifactRead: async (request) =>
          await deferring.growth.artifactRead({ artifactId: request.artifactId }),
      }),
    );
    await settleResolution(controller, clock);
    await controller.createDiff(WORKSPACE_FALLBACK_COMPARED_STATES);
    const { act } = controller.snapshot;
    expect(act.status).toBe("refused");
    expect(act.status === "refused" && act.refusal.code).toBe("payload-not-a-patch");
  });

  it("settles a typed daemon rejection under the daemon's own code, not the seam's", async () => {
    // The mint reaches the scenario over the real port, so a refusal it throws arrives
    // as the port's `call-rejected` with the daemon's refusal on `cause`. Published as
    // it arrived, the form drew `call-rejected` and a seam sentence for every typed
    // refusal these two legs can receive — and the code a person would paste reached no
    // surface at all. An unscripted comparison over a subject this session DOES hold is
    // the shortest route to that shape.
    const { controller, clock } = open(WORKSPACE_SUBJECT);
    await settleResolution(controller, clock);
    await controller.createDiff({ baseRef: "foo", headRef: "bar" });
    const { act } = controller.snapshot;
    expect(act.status).toBe("refused");
    expect(act.status === "refused" && act.refusal.code).toBe(UNSCRIPTED_COMPARISON_REFUSAL_CODE);
    // The daemon's own sentence travels with its code: a controller that unwrapped the
    // code and kept the seam's detail would put two halves of two refusals on screen.
    // The sentence names the comparison THIS subject resolves — the workspace pair,
    // because that is the subject the case opened.
    expect(act.status === "refused" && act.refusal.detail).toContain(
      WORKSPACE_FALLBACK_COMPARED_STATES.baseRef,
    );
  });

  it("negative control: a seam refusal carrying no daemon word keeps its own code", async () => {
    // The unwrap must be a no-op where there is nothing wrapped. `growthRefusing`
    // answers the port's own `wire-unregistered` — a refusal with no `cause` — and a
    // reader that reached for one unconditionally would publish `undefined` here.
    const { controller, clock } = open(
      WORKSPACE_SUBJECT,
      fixtureBridgeWithGrowth(REPOS_SCENARIO, {
        gitflowDiffArtifactCreate: growthRefusing("gitflowDiffArtifactCreate"),
      }),
    );
    await settleResolution(controller, clock);
    await controller.createDiff(WORKSPACE_FALLBACK_COMPARED_STATES);
    const { act } = controller.snapshot;
    expect(act.status === "refused" && act.refusal.code).toBe("wire-unregistered");
    expect(act.status === "refused" && act.refusal.detail.length).toBeGreaterThan(0);
  });

  it("negative control: a press before the attribution resolves says so instead of doing nothing", async () => {
    const { controller } = open(IMPLEMENTER_SUBJECT);
    await controller.createDiff(RUN_ATTRIBUTED_COMPARED_STATES);
    const { act } = controller.snapshot;
    expect(act.status === "refused" && act.refusal.code).toBe("subject-unresolved");
    expect(act.status === "refused" && act.refusal.detail).toBe(SUBJECT_NOT_RESOLVED_DETAIL);
  });
});
