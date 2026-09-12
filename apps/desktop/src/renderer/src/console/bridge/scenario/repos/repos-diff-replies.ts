// What the diff-artifact mint and the payload read answer in the repos scenario.
//
// TWO CALLS FOR ONE DIFF, WHICH IS THE CONTRACT AND NOT A FIXTURE CONVENIENCE.
// `DiffArtifactCreateResponse` carries a `diffArtifactId`, the `artifactManifestId` its
// computed payload was written under, and an instant — and no bytes. So a surface that
// wants a change set on screen mints one and then reads that manifest's payload through
// the artifact plane, and both halves have to be scripted or the pane holds an id it
// cannot open.
//
// BOTH ARMS OF THE MINT ARE REACHABLE FROM THIS SCENARIO, and they answer with
// DIFFERENT change sets. Pretending a workspace diff is run-attributed is the
// pitfall, and a fixture whose two arms returned one patch could not show that
// the console tells them apart: the run arm answers the work the implementer's run did —
// the diff the scenario's own `diff.created` beat already names — and the workspace arm
// answers a change sitting in the git workspace's own checkout, ahead of the shared
// branch, that no run produced.
//
// EVERY OTHER SUBJECT REFUSES, WITH THE CODE THE DAEMON WOULD USE. A run or workspace
// this scenario does not model is `run.not_found` / `workspace.not_found`, and a payload
// read for an artifact it did not mint is `artifact.not_found` — which is
// the console's reading of the diff surface's refusals: a diff
// IS an artifact once minted, so the artifact codes are the ones its payload read
// refuses in. A scenario that served every request would leave both the refusal card and
// the create form's refused arm undrawn.
//
// AND SO DOES EVERY OTHER COMPARISON. The subject is half of what a create names: the
// registered request carries a `baseRef` and a `headRef` beside it, and a fixture that
// checked only the subject answered the row's prewritten patch for ANY pair — so
// `foo`..`bar` came back as a convincing change set labelled as that comparison, over a
// repository whose two arms are two working trees of one checkout and could not have
// answered one pair with two different patches anyway. Each row below therefore scripts
// the pair it IS, read off the scenario's own branch facts, and a pair no row scripts is
// refused.
//
// THE CODE THAT REFUSAL TAKES IS BORROWED, AND SAYING SO IS THE POINT.
// `docs/architecture/contracts/error-contracts.md` registers no `gitflow.*` namespace at
// all — the growth slate's `gitflow-actions` row names that namespace among the wires no
// document owes yet — so there is no registered code for a comparison whose refs the
// daemon cannot resolve, and inventing one would script this fixture against a string
// the live transport can never send. `workspace.branch_mismatch` is the nearest
// registered refusal and the only one in the whole registry whose subject is a
// caller-named git ref the checkout cannot honour; what is stretched is its PRODUCER
// (the registry describes bind-time verification) and not its meaning. It reads right on
// both arms because both resolve their repository through a workspace — the
// run-attributed arm through `run_execution_contexts.workspace_id` — so one code serves
// the pair rather than two approximations serving one arm each.
//
// AND THE PAYLOAD READ ANSWERS BOTH OF ITS OWN ARMS. `includePayload` is the wire's own
// discriminator between the manifest read and the byte fetch, so an unset one answers
// the DEFERRED arm — a handle and no bytes — which is a served answer the diff surface
// has to be able to draw and which no other scenario reaches.

import { measureUtf8ByteLength } from "../../../persistence/index.js";
import type { GrowthArtifactSummary } from "../../growth-values/index.js";
import type { ConsoleScenario } from "../runtime/index.js";

import { refuseAs } from "../computed-reply.js";
import { scenarioInstant } from "./repos-beats.js";
import { RUN_ATTRIBUTED_DIFF_PATCH, WORKSPACE_FALLBACK_DIFF_PATCH } from "./repos-diff-patches.js";
import {
  AGENT_IMPLEMENTER,
  DIFF_ARTIFACT_ID,
  DIFF_MANIFEST_ID,
  GIT_MOUNT_BASE_BRANCH,
  GIT_WORKSPACE_ID,
  IMPLEMENTER_BRANCH,
  IMPLEMENTER_RUN_ID,
  SESSION_ID,
  WORKSPACE_DIFF_ARTIFACT_ID,
  WORKSPACE_DIFF_MANIFEST_ID,
} from "./repos-fixture-data.js";

/**
 * How this scenario keys the payload read.
 *
 * THE `growth:` PREFIX, on `REPOS_EXECUTION_CONTEXT_CALL`'s rule: the artifact CRUD
 * method strings are a growth-slate row of their own and the corpus registers none of
 * them, so there is no method name to transcribe and inventing an `artifact.…` string
 * would script this fixture against a key the live transport can never send. The mint
 * beside it is keyed by its REGISTERED method string, because that row declares one.
 */
export const REPOS_ARTIFACT_READ_CALL = "growth:artifactRead";

/** The registered method the diff-artifact mint is keyed by. */
export const REPOS_DIFF_ARTIFACT_CREATE_CALL = "gitflow.diffArtifactCreate";

/** The CAS handle the deferred arm hands back instead of bytes. */
const DEFERRED_PAYLOAD_HANDLE = "sha256:6d1f0b8c2a4e7d3f9b5c0a1e8d2f4c6b";

/** The two states one scripted change set is taken between. */
export interface ScenarioComparedStates {
  readonly baseRef: string;
  readonly headRef: string;
}

/** The member of a request this module reads, without trusting the request's shape. */
function requestedValue(request: unknown, member: string): unknown {
  if (typeof request !== "object" || request === null) {
    return undefined;
  }
  return (request as Readonly<Record<string, unknown>>)[member];
}

/**
 * The comparison the run-attributed change set IS.
 *
 * READ OFF THE IMPLEMENTER'S BRANCH CONTEXT rather than written beside the patch: that
 * context names `develop` as the base its head branch was cut from, and the work the
 * run did is exactly what sits between them. The two constants are the branch context's
 * own, so a fixture that moved either would move this comparison with it.
 */
export const RUN_ATTRIBUTED_COMPARED_STATES: ScenarioComparedStates = {
  baseRef: GIT_MOUNT_BASE_BRANCH,
  headRef: IMPLEMENTER_BRANCH,
};

/**
 * The comparison the workspace-fallback change set IS.
 *
 * THE CHECKOUT'S OWN BRANCH AGAINST ITS UPSTREAM, which is the two-ref form of the fact
 * the fallback arm exists for: work sitting in the git workspace that no run produced
 * and that is not on the shared branch yet. The wire's request carries two refs and
 * nothing else, so a working tree is not nameable on it — `origin/develop`..`develop` is
 * what a person comparing this workspace actually types, and it is a DIFFERENT pair from
 * the run arm's, which is the property the two arms turn on: both roots are working
 * trees of one repository, so one pair could not honestly answer with two patches.
 */
export const WORKSPACE_FALLBACK_COMPARED_STATES: ScenarioComparedStates = {
  baseRef: `origin/${GIT_MOUNT_BASE_BRANCH}`,
  headRef: GIT_MOUNT_BASE_BRANCH,
};

/** One diff this scenario can mint, as the two ids the create answers with. */
interface ScenarioDiff {
  readonly diffArtifactId: string;
  readonly artifactManifestId: string;
  /** The patch the manifest's payload carries, as `git diff` would emit it. */
  readonly patch: string;
  /** The one comparison this row answers for. Any other pair is refused. */
  readonly comparedStates: ScenarioComparedStates;
  /** Absent on the workspace arm, which is what makes it the fallback attribution. */
  readonly runId?: string;
}

/**
 * The two change sets, keyed by the manifest a payload read names.
 *
 * A table rather than two branches, because both the mint and the read walk it: the
 * mint answers with a row's two ids and the read answers with that same row's bytes, so
 * a manifest id that resolved in one and not the other would be a fixture minting
 * artifacts it cannot open.
 */
const SCENARIO_DIFFS: readonly ScenarioDiff[] = [
  {
    diffArtifactId: DIFF_ARTIFACT_ID,
    artifactManifestId: DIFF_MANIFEST_ID,
    patch: RUN_ATTRIBUTED_DIFF_PATCH,
    comparedStates: RUN_ATTRIBUTED_COMPARED_STATES,
    runId: IMPLEMENTER_RUN_ID,
  },
  {
    diffArtifactId: WORKSPACE_DIFF_ARTIFACT_ID,
    artifactManifestId: WORKSPACE_DIFF_MANIFEST_ID,
    patch: WORKSPACE_FALLBACK_DIFF_PATCH,
    comparedStates: WORKSPACE_FALLBACK_COMPARED_STATES,
  },
];

/**
 * The code an unscripted comparison is refused under, named once.
 *
 * BORROWED AND NOT INVENTED — the module header says from where and why the stretch is
 * in the producer rather than in the meaning. Named here so the fixture and the cases
 * that pin it read one string.
 */
export const UNSCRIPTED_COMPARISON_REFUSAL_CODE = "workspace.branch_mismatch";

/**
 * What the mint answers, per attribution arm.
 *
 * THE ARM IS READ OFF `attributionMode` AND NOT GUESSED FROM WHICH KEY IS PRESENT. The
 * registered request is discriminated on that member precisely so the two keys cannot
 * both arrive, and a fixture sniffing for `runId` would accept a request the wire's own
 * union forbids — which is the shape a surface must never learn is acceptable.
 */
function diffArtifactCreateResultFor(request: unknown): unknown {
  const attributionMode = requestedValue(request, "attributionMode");
  if (attributionMode === "run_attributed") {
    if (requestedValue(request, "runId") !== IMPLEMENTER_RUN_ID) {
      refuseAs("run.not_found", "No run by that id is recorded in this session.");
    }
    return mintedDiff(DIFF_MANIFEST_ID, request);
  }
  if (attributionMode === "workspace_fallback") {
    if (requestedValue(request, "workspaceId") !== GIT_WORKSPACE_ID) {
      // The plain-directory mount's workspace lands here too, and the code is right for
      // it: that mount is `none`-vcs, so the daemon resolves no repository to diff and
      // the workspace it was handed names nothing it can answer about.
      refuseAs("workspace.not_found", "No git-backed workspace by that id is bound here.");
    }
    return mintedDiff(WORKSPACE_DIFF_MANIFEST_ID, request);
  }
  // A request carrying neither arm is a shape the registered union does not admit. It
  // is refused rather than defaulted, because defaulting would answer a diff for an
  // attribution the caller never named.
  return refuseAs("workspace.not_found", "The create named no attribution mode.");
}

/**
 * The three registered response members, from the table's own row.
 *
 * THE SUBJECT IS CHECKED BY THE CALLER AND THE COMPARISON IS CHECKED HERE, in that
 * order, because they are refused with different codes and the subject's is the more
 * specific fact: a request naming a run this session does not hold has not got as far
 * as being a comparison. Once the row is in hand, the pair it scripts is the only pair
 * it can answer for — the alternative is a fixture handing back one prewritten patch
 * under whatever two refs a caller typed.
 */
function mintedDiff(artifactManifestId: string, request: unknown): unknown {
  const diff = SCENARIO_DIFFS.find((row) => row.artifactManifestId === artifactManifestId);
  if (diff === undefined) {
    refuseAs("workspace.not_found", "No diff is scripted for that subject.");
  }
  const { baseRef, headRef } = diff.comparedStates;
  if (
    requestedValue(request, "baseRef") !== baseRef ||
    requestedValue(request, "headRef") !== headRef
  ) {
    // The refs the caller named are NOT echoed back. They are user input, and a
    // refusal that quoted them would put unbounded text on screen through a sentence
    // the console renders verbatim; what the daemon's own message can honestly carry is
    // the comparison this subject does resolve.
    refuseAs(
      UNSCRIPTED_COMPARISON_REFUSAL_CODE,
      `This checkout resolves no such comparison. It is on ${headRef}, taken against ${baseRef}.`,
    );
  }
  return {
    diffArtifactId: diff.diffArtifactId,
    artifactManifestId: diff.artifactManifestId,
    createdAt: scenarioInstant(0),
  };
}

/**
 * The manifest a diff's payload hangs off.
 *
 * `artifactType: "diff"` and `visibility: "local-only"`, which agree with the scenario's
 * own `diff.created` beat — a diff artifact this node computed and published to nobody —
 * and a local-only artifact carries no `replicationStatus`, because it has no
 * replication to report. `createdBy` is the agent whose run produced the run-attributed
 * one and is absent on the workspace arm, where no run and no caller produced it.
 */
function diffManifest(diff: ScenarioDiff): GrowthArtifactSummary {
  return {
    artifactId: diff.artifactManifestId,
    sessionId: SESSION_ID,
    ...(diff.runId === undefined ? {} : { runId: diff.runId, createdBy: AGENT_IMPLEMENTER }),
    artifactType: "diff",
    digest: `sha256:${diff.artifactManifestId.replaceAll("-", "")}`,
    // The payload's byte length, which for a `utf8` payload is what a decoder reads.
    // Derived from the patch rather than written beside it, so the two cannot disagree,
    // and measured through the console's one byte measurement rather than an encoder of
    // this module's own — a fixture that rules its own bytes is a second answer to a
    // question the durable path already answers.
    size: measureUtf8ByteLength(diff.patch),
    annotations: {},
    visibility: "local-only",
    state: "published",
    metadata: {},
    createdAt: scenarioInstant(0),
  };
}

/**
 * What the payload read answers, per artifact and per `includePayload`.
 *
 * THE MANIFEST COMES BACK ON BOTH ARMS, because the registered response nests it beside
 * whichever way the bytes are reached. What differs is the reach: `includePayload` set
 * answers the inline arm with the encoding to read the bytes by, and unset answers the
 * deferred arm with a handle — a served answer, not an absence, and the one a surface
 * has to draw as "I asked for the bytes and did not get them inline".
 */
function artifactReadResultFor(request: unknown): unknown {
  const artifactId = requestedValue(request, "artifactId");
  const diff = SCENARIO_DIFFS.find((row) => row.artifactManifestId === artifactId);
  if (diff === undefined) {
    refuseAs("artifact.not_found", "No artifact by that id exists on this node.");
  }
  const manifest = diffManifest(diff);
  if (requestedValue(request, "includePayload") !== true) {
    return { manifest, payloadHandle: DEFERRED_PAYLOAD_HANDLE };
  }
  return {
    manifest,
    payloadHandle: DEFERRED_PAYLOAD_HANDLE,
    // `utf8` and never base64: a unified patch IS text, and encoding it would make the
    // fixture exercise a decode path the daemon has no reason to take for this type.
    payload: diff.patch,
    payloadEncoding: "utf8",
  };
}

/** The diff plane's two entries, spread into the scenario's one reply list. */
export const REPOS_DIFF_REPLIES: ConsoleScenario["replies"] = [
  { call: REPOS_DIFF_ARTIFACT_CREATE_CALL, resultFor: diffArtifactCreateResultFor },
  { call: REPOS_ARTIFACT_READ_CALL, resultFor: artifactReadResultFor },
];
