// Minting one diff and reading its payload back: the two calls, in order.
//
// TWO CALLS FOR ONE CHANGE SET, AND THE ORDER IS THE CONTRACT'S RATHER THAN A CHOICE.
// `DiffArtifactCreateResponse` carries three ids and no bytes, so the mint establishes
// that a change set EXISTS and hands back the manifest its computed payload was written
// under; the patch itself comes back through the artifact plane's own read. A surface
// that stopped at the mint would hold an id it cannot open.
//
// THE SUBJECT RESOLUTION IS THE PREREQUISITE AND NOT A STEP INSIDE THE ACT, which is
// `store/act-reading.ts`'s own seam: the wire is keyed by a run or by a workspace, and
// which key this pane's address resolves to is a question that fails for reasons that
// are not failures of the create — an execution root this session does not hold, a root
// nothing ran in. Folded into the act, those would have been reported as "the diff was
// refused" to somebody who has not pressed anything yet.
//
// AND THE WORKSPACE ARM RESOLVES WITHOUT ASKING ANYTHING, which is an answer rather
// than an omission: a workspace id IS the fallback arm's key, so the question has an
// answer the console already holds. It takes the round's signal and neither hands it to
// a door nor waits on one, because it makes no call and returns inside the same
// microtask — the round's own settle guard is what keeps a superseded resolution from
// installing, exactly as it does for the arm that does call.
//
// NOTHING HERE RE-READS AFTER A SETTLEMENT. A minted diff is a durable artifact and the
// pane renders the model it parsed; a controller that also re-read would put a second
// call on the wire for one press.

import type { ConsoleBridge } from "../../../bridge/index.js";
import { refuse, type ConsoleClock } from "../../../core/index.js";
import { ActSurfaceController, type ActOutcome, type SessionStore } from "../../../store/index.js";
import { readGrowthAnswer } from "../../growth-call.js";
import { REPO_LIFECYCLE_EVENT_KINDS } from "../../repo-lifecycle-events.js";
import { readWorktreeStatus, REPO_READS_REFUSAL_ORIGIN } from "../../repo-reads.js";
import type { ConsoleDiffModel } from "../diff-model.js";
import { parseUnifiedPatch, type ComparedStates } from "../patch-parse.js";
import {
  diffAttributionFor,
  diffCreateRequestFor,
  diffCreateSubjectKey,
  trimmedComparedStates,
  type DiffCreateSubject,
  type ResolvedDiffCreateSubject,
} from "./diff-create-subject.js";
import { diffPayloadReadingFrom } from "./diff-payload-reading.js";
import {
  DIFF_CREATE_REFUSAL_ORIGIN,
  patchUnparsableDetail,
  payloadNotAPatchDetail,
  SUBJECT_NOT_RESOLVED_DETAIL,
  WORKTREE_NOT_IN_SESSION_DETAIL,
  WORKTREE_WITHOUT_RUN_DETAIL,
  type DiffCreatedArm,
  type DiffCreateRefusalCode,
} from "./diff-creation-model.js";

/** This console's own names for the two growth legs, for a reply it could not use. */
const MINT_LEG = "diff artifact create";
const PAYLOAD_LEG = "diff payload read";

/** What one creation controller is scoped to, and what it collaborates with. */
export interface DiffCreationControllerOptions {
  readonly bridge: ConsoleBridge;
  readonly subject: DiffCreateSubject;
  /** The session whose reconnect edge and repo frames re-ask the attribution. */
  readonly sessionStore: SessionStore;
  /** The window's one clock, so this refresh coalesces on the pane's time base. */
  readonly clock: ConsoleClock;
}

/** Resolves one diff's attribution, then mints and reads one change set. */
export class DiffArtifactCreationController extends ActSurfaceController<
  ResolvedDiffCreateSubject,
  DiffCreatedArm
> {
  readonly #bridge: ConsoleBridge;
  readonly #subject: DiffCreateSubject;

  public constructor(options: DiffCreationControllerOptions) {
    super({
      label: "diff artifact creation reading",
      clock: options.clock,
      sessionStore: options.sessionStore,
      // THE FAMILY'S CENSUS AND NOT A LIST OF ITS OWN, on `repo-mounts-reader.ts`'s
      // rule: an execution root appearing, being retired, or changing state is exactly
      // what changes whether this session still holds the root a diff would be
      // attributed through, and two readers of one answer must not disagree about when
      // that answer goes stale.
      triggeringEventKinds: new Set<string>(REPO_LIFECYCLE_EVENT_KINDS),
      refusalOrigin: REPO_READS_REFUSAL_ORIGIN,
    });
    this.#bridge = options.bridge;
    this.#subject = options.subject;
  }

  /**
   * Arm the triggers and resolve the attribution. Idempotent.
   *
   * The question exists the moment the form opens — it is the address the pane was
   * opened at — so this asks rather than only arming, which is the half of
   * `ActController.ask`'s contract that arms the triggers on its way past.
   */
  public start(): void {
    this.askPrerequisite(diffCreateSubjectKey(this.#subject), "subscribe");
  }

  /** Ask the attribution again after a refused resolution. */
  public retryResolution(): void {
    this.retryPrerequisite();
  }

  /**
   * Mint a diff between the two named states, and read its payload back.
   *
   * AN UNRESOLVED SUBJECT SETTLES AS A REFUSAL RATHER THAN AS A NO-OP.
   * `Spec-023 §Console Design (Meridian)` rule 8 admits no silent nothing: the control
   * is held shut while the attribution is unresolved, and a press that arrives anyway —
   * a keyboard activation racing a refusal that has just landed — says what did not
   * happen instead of appearing to do nothing.
   */
  public async createDiff(comparedStates: ComparedStates): Promise<void> {
    const resolved = this.prerequisiteValue;
    const named = trimmedComparedStates(comparedStates);
    await this.sendAct(
      async () =>
        resolved === undefined
          ? {
              status: "refused" as const,
              refusal: refuse(
                DIFF_CREATE_REFUSAL_ORIGIN,
                "subject-unresolved" satisfies DiffCreateRefusalCode,
                SUBJECT_NOT_RESOLVED_DETAIL,
              ),
            }
          : await this.#mintAndRead(resolved, named),
      (diff: ConsoleDiffModel) => ({ status: "created" as const, diff }),
    );
  }

  /**
   * Which of the wire's two attribution keys this pane's address resolves to.
   *
   * THE WORKTREE ARM IS THE ONE THAT ASKS. `worktrees.created_by_run_id` is the
   * `run_attributed` arm's key and it is not on the address, so it is read off the
   * session's own roots projection — and both ways that read can fail to name a run are
   * refusals that SAY which one it was, never a quiet fall through to the other
   * attribution arm.
   */
  protected override async readPrerequisite(
    // The question is the machine's supersession register rather than an input: this
    // controller is scoped to one subject, so the key it was asked under names the
    // subject the field below already holds. `act-controller.ts`'s own `_reasons` is
    // the same shape — a parameter taken because the contract passes it.
    _question: string,
    signal: AbortSignal,
  ): Promise<ActOutcome<ResolvedDiffCreateSubject>> {
    // READ ONCE INTO A LOCAL, because narrowing a field does not survive the `await`
    // below: TypeScript drops what it knows about a property across a suspension point,
    // so the worktree arm's members would be unreachable on the far side of the read.
    const subject = this.#subject;
    if (subject.kind === "workspace") {
      return {
        status: "served",
        value: { attributionMode: "workspace_fallback", workspaceId: subject.workspaceId },
      };
    }
    const reply = await readWorktreeStatus(this.#bridge, subject.sessionId, signal);
    if (reply.status === "refused") {
      return reply;
    }
    const record = reply.value.worktrees.find((row) => row.worktreeId === subject.worktreeId);
    if (record === undefined) {
      return this.#unresolved(WORKTREE_NOT_IN_SESSION_DETAIL);
    }
    if (record.createdByRunId === undefined) {
      return this.#unresolved(WORKTREE_WITHOUT_RUN_DETAIL);
    }
    return {
      status: "served",
      value: { attributionMode: "run_attributed", runId: record.createdByRunId },
    };
  }

  /** The mint, then the payload read, then the parse — refusing at whichever stops. */
  async #mintAndRead(
    resolved: ResolvedDiffCreateSubject,
    comparedStates: ComparedStates,
  ): Promise<ActOutcome<ConsoleDiffModel>> {
    const minted = await readGrowthAnswer("gitflowDiffArtifactCreate", MINT_LEG, async () =>
      this.#bridge.growth.gitflowDiffArtifactCreate(diffCreateRequestFor(resolved, comparedStates)),
    );
    if (minted.status === "refused") {
      return minted;
    }
    const artifactId = minted.value.artifactManifestId;
    // `includePayload` IS THE WIRE'S OWN DISCRIMINATOR and is set because this leg wants
    // the bytes: unset, the same method answers the manifest read, which is the arm the
    // artifact pane takes and the one a surface after a change set cannot use.
    const payload = await readGrowthAnswer("artifactRead", PAYLOAD_LEG, async () =>
      this.#bridge.growth.artifactRead({ artifactId, includePayload: true }),
    );
    if (payload.status === "refused") {
      return payload;
    }
    const payloadReading = diffPayloadReadingFrom(payload.value);
    if (payloadReading.status !== "patch") {
      return {
        status: "refused",
        refusal: refuse(
          DIFF_CREATE_REFUSAL_ORIGIN,
          "payload-not-a-patch" satisfies DiffCreateRefusalCode,
          payloadNotAPatchDetail(payloadReading),
        ),
      };
    }
    try {
      return {
        status: "served",
        value: parseUnifiedPatch(
          payloadReading.patchText,
          diffAttributionFor(resolved),
          comparedStates,
        ),
      };
    } catch {
      // THE THROWN MESSAGE IS DELIBERATELY NOT READ. A parse refusal can carry the
      // patch text that caused it, which is repository content, so the sentence is the
      // console's own constant and the artifact id is the handle instead.
      return {
        status: "refused",
        refusal: refuse(
          DIFF_CREATE_REFUSAL_ORIGIN,
          "patch-unparsable" satisfies DiffCreateRefusalCode,
          patchUnparsableDetail(artifactId),
        ),
      };
    }
  }

  /** One unresolved-subject refusal, so the two ways to reach it share a shape. */
  #unresolved(detail: string): ActOutcome<ResolvedDiffCreateSubject> {
    return {
      status: "refused",
      refusal: refuse(
        DIFF_CREATE_REFUSAL_ORIGIN,
        "subject-unresolved" satisfies DiffCreateRefusalCode,
        detail,
      ),
    };
  }
}
