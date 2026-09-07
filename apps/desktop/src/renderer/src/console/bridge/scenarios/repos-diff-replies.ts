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
// DIFFERENT change sets. `Spec-011 §Pitfalls To Avoid` names pretending a workspace diff
// is run-attributed, and a fixture whose two arms returned one patch could not show that
// the console tells them apart: the run arm answers the work the implementer's run did —
// the diff the scenario's own `diff.created` beat already names — and the workspace arm
// answers an uncommitted change sitting in the git workspace that no run produced.
//
// EVERY OTHER SUBJECT REFUSES, WITH THE CODE THE DAEMON WOULD USE. A run or workspace
// this scenario does not model is `run.not_found` / `workspace.not_found`, and a payload
// read for an artifact it did not mint is `artifact.not_found` — which is
// `Spec-023 §Console Design (Meridian)`'s reading of the diff surface's refusals: a diff
// IS an artifact once minted, so the artifact codes are the ones its payload read
// refuses in. A scenario that served every request would leave both the refusal card and
// the create form's refused arm undrawn.
//
// AND THE PAYLOAD READ ANSWERS BOTH OF ITS OWN ARMS. `includePayload` is the wire's own
// discriminator between the manifest read and the byte fetch, so an unset one answers
// the DEFERRED arm — a handle and no bytes — which is a served answer the diff surface
// has to be able to draw and which no other scenario reaches.

import type { WireErrorEnvelope } from "../../core/index.js";
import type { GrowthArtifactSummary } from "../growth-values/index.js";
import type { ConsoleScenario } from "../scenario-runtime/index.js";

import { scenarioInstant } from "./repos-beats.js";
import { RUN_ATTRIBUTED_DIFF_PATCH, WORKSPACE_FALLBACK_DIFF_PATCH } from "./repos-diff-patches.js";
import {
  AGENT_IMPLEMENTER,
  DIFF_ARTIFACT_ID,
  DIFF_MANIFEST_ID,
  GIT_WORKSPACE_ID,
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

/** Refuse as the daemon would, in the shape the wire refuses in. */
function refuseAs(code: string, message: string): never {
  const envelope: WireErrorEnvelope = { code, message };
  throw envelope;
}

/** The member of a request this module reads, without trusting the request's shape. */
function requestedValue(request: unknown, member: string): unknown {
  if (typeof request !== "object" || request === null) {
    return undefined;
  }
  return (request as Readonly<Record<string, unknown>>)[member];
}

/** One diff this scenario can mint, as the two ids the create answers with. */
interface ScenarioDiff {
  readonly diffArtifactId: string;
  readonly artifactManifestId: string;
  /** The patch the manifest's payload carries, as `git diff` would emit it. */
  readonly patch: string;
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
    runId: IMPLEMENTER_RUN_ID,
  },
  {
    diffArtifactId: WORKSPACE_DIFF_ARTIFACT_ID,
    artifactManifestId: WORKSPACE_DIFF_MANIFEST_ID,
    patch: WORKSPACE_FALLBACK_DIFF_PATCH,
  },
];

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
    return mintedDiff(DIFF_MANIFEST_ID);
  }
  if (attributionMode === "workspace_fallback") {
    if (requestedValue(request, "workspaceId") !== GIT_WORKSPACE_ID) {
      // The plain-directory mount's workspace lands here too, and the code is right for
      // it: that mount is `none`-vcs, so the daemon resolves no repository to diff and
      // the workspace it was handed names nothing it can answer about.
      refuseAs("workspace.not_found", "No git-backed workspace by that id is bound here.");
    }
    return mintedDiff(WORKSPACE_DIFF_MANIFEST_ID);
  }
  // A request carrying neither arm is a shape the registered union does not admit. It
  // is refused rather than defaulted, because defaulting would answer a diff for an
  // attribution the caller never named.
  return refuseAs("workspace.not_found", "The create named no attribution mode.");
}

/** The three registered response members, from the table's own row. */
function mintedDiff(artifactManifestId: string): unknown {
  const diff = SCENARIO_DIFFS.find((row) => row.artifactManifestId === artifactManifestId);
  if (diff === undefined) {
    refuseAs("workspace.not_found", "No diff is scripted for that subject.");
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
    // Derived from the patch rather than written beside it, so the two cannot disagree.
    size: new TextEncoder().encode(diff.patch).length,
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
