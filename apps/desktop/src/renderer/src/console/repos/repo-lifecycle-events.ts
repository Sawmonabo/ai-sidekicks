// The frames this family re-reads on — THE FAMILY'S ONE EVENT-KIND CENSUS.
//
// Two sets live here, both derived from the contract's registry by namespace prefix and
// neither hand-listed: `REPO_LIFECYCLE_EVENT_KINDS` for the mounts, and
// `ARTIFACT_TERMINAL_EVENT_KINDS` for the artifact pane. Both sit in one module because a
// derivation stated twice in two directories is the pair that drifts.
//
// The mechanism — window focus, the store's repair edge, and a named frame, each routed
// to a `RefreshScheduler` — is `store/read/refresh-triggers.ts`'s, and it is shared with
// every other surface that performs its own reads. What is THIS family's is which
// frames count as the terminal events for a repository, and that is the whole of this
// module.
//
// A SET RATHER THAN A CLASS: the shared answer that matters is the KIND SET, so two
// readers cannot watch different frames while reading the same rows.
//
// THE WATCHED SET INCLUDES THE TERMINAL HALF, NOT ONLY `workspace.stale`, the frame that
// says a workspace BROKE: every frame that says one was repaired, attached, detached, or
// provisioned changes what a card draws. An explicit mode switch answers `provisioning`
// with no execution root (the root does not exist yet), the daemon later emits
// `workspace.ready` carrying it, and without that frame the section would keep drawing
// the provisioning row until a focus, a reconnect, or another mutation arrived. The same
// holds for `repo.attached` / `repo.detached`, which change the mount list this section
// is drawn from, and the five `worktree.*` transitions, which change the execution
// roots.
//
// ONE READ PER BURST, WHICH IS WHY A WIDER SET COSTS NOTHING. `SessionRefreshTriggers`
// asks the READING for a read when a transition carries ANY watched kind — once per
// transition, not once per frame — and the scheduler behind that request coalesces it
// into the window it is already holding. So a workspace that reprovisions through
// `provisioning` and `ready`, and the five worktree transitions behind it, are one
// re-read rather than seven.

import { SESSION_EVENT_CATEGORY_BY_TYPE, type SessionEventType } from "@ai-sidekicks/contracts";

/**
 * The wire namespaces whose frames can change what this family has read.
 *
 * The three entities the two readers hold: a mount (`repo.mountRead`), a workspace
 * (`repo.workspaceList` and the per-workspace capabilities read), and an execution root
 * (`repo.worktreeStatusRead`). A frame in any of the three changes a row, a state, or a
 * health verdict.
 */
const REPO_EVENT_NAMESPACE_PREFIXES = ["repo.", "workspace.", "worktree."] as const;

/**
 * Every registered lifecycle frame that names one of this family's three entities.
 *
 * DERIVED FROM THE CONTRACT'S OWN CENSUS rather than hand-listed, so a kind the wire
 * adds in one of these namespaces is watched the day it is registered and a kind it
 * renames stops matching nothing silently. `SESSION_EVENT_CATEGORY_BY_TYPE` is the
 * canonical type registry — its keys are the whole census — and the filter selects by
 * NAMESPACE, which is the question this family is asking ("does this frame name a repo,
 * a workspace, or a worktree"). It deliberately does not infer a category from a
 * prefix, which `packages/contracts/src/event.ts` warns against: a type's category is
 * the registry's to state, and this set never reads one.
 *
 * The annotation is explicit rather than inferred, because `isolatedDeclarations`
 * requires one on every exported binding.
 */
export const REPO_LIFECYCLE_EVENT_KINDS: readonly SessionEventType[] = [
  ...SESSION_EVENT_CATEGORY_BY_TYPE.keys(),
].filter((eventType) =>
  REPO_EVENT_NAMESPACE_PREFIXES.some((prefix) => eventType.startsWith(prefix)),
);

/** The namespace every frame about an artifact is registered under. */
const ARTIFACT_EVENT_NAMESPACE_PREFIX = "artifact.";

/**
 * Every registered frame that names an artifact.
 *
 * DERIVED FROM THE CONTRACT'S OWN CENSUS rather than hand-listed, on
 * `REPO_LIFECYCLE_EVENT_KINDS`'s shape above, and for its reason: a hand-written list is
 * a snapshot of a registry that grows, so a new `artifact.*` kind — a retention sweep, a
 * re-publication — would reach this pane and be ignored, with the list on screen going
 * stale and nothing anywhere saying why. `SESSION_EVENT_CATEGORY_BY_TYPE` is the
 * canonical type registry and its keys are the whole census, so a kind is watched the
 * day it is registered and a kind renamed stops matching nothing silently rather than
 * compiling and doing so.
 *
 * THE SELECTOR IS THE NAMESPACE AND NOT THE CATEGORY, which is the question this pane
 * is actually asking. Both of its reads are about artifacts, so any frame that names
 * one changes what one of them would answer — while `artifact_publication`, the
 * category the three live in, also holds `diff.created`, `pr.prepared`, and
 * `pr.submitted`, which are publications of other entities and change neither read. It
 * deliberately does not infer a category from the prefix either, which
 * `packages/contracts/src/event.ts` warns against: a type's category is the registry's
 * to state, and this set never reads one.
 *
 * The annotation is explicit rather than inferred, because `isolatedDeclarations`
 * requires one on every exported binding.
 */
export const ARTIFACT_TERMINAL_EVENT_KINDS: readonly SessionEventType[] = [
  ...SESSION_EVENT_CATEGORY_BY_TYPE.keys(),
].filter((eventType) => eventType.startsWith(ARTIFACT_EVENT_NAMESPACE_PREFIX));
