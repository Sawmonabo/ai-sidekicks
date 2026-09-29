// The frames the repos mounts re-read on — THE FEATURE'S ONE EVENT-KIND CENSUS.
//
// `REPO_LIFECYCLE_EVENT_KINDS` is derived from the contract's registry by namespace
// prefix and never hand-listed.
//
// The mechanism — window focus, the store's repair edge, and a named frame, each routed
// to a `RefreshScheduler` — is `store/reads/session-refresh-triggers.ts`'s, and it is shared with
// every other view that performs its own reads. What is THIS feature's is which
// frames count as the terminal events for a repository, and that is the whole of this
// module.
//
// A SET RATHER THAN A CLASS: the shared answer that matters is the KIND SET, so two
// readers cannot watch different frames while reading the same rows.
//
// THE WATCHED SET INCLUDES THE TERMINAL HALF, NOT ONLY `workspace.stale`, the frame that
// says a workspace BROKE: every frame that says one was repaired, archived, or
// provisioned changes what a card draws. An explicit mode switch answers `preparing`
// with no execution root (the root does not exist yet), the daemon later emits
// `workspace.ready` carrying it, and without that frame the section would keep drawing
// the provisioning row until a focus, a reconnect, or another mutation arrived. The
// section learns its mounts from its workspaces, so the `workspace.*` frames are also
// what change the mount list, and the five `worktree.*` transitions change the execution
// roots.
//
// A MOUNT SENDS NO FRAME OF ITS OWN. It belongs to the machine rather than to a session, so
// an attach is announced on no session's stream, and a detach reaches a session as
// `workspace.archived` on each workspace it archived. That is why the mount rows re-read
// on the frames of the workspaces bound to them.
//
// ONE READ PER BURST, WHICH IS WHY A WIDER SET COSTS NOTHING. `SessionRefreshTriggers`
// asks the READING for a read when a transition carries ANY watched kind — once per
// transition, not once per frame — and the scheduler behind that request coalesces it
// into the window it is already holding. So a workspace that reprovisions through
// `preparing` and `ready`, and the five worktree transitions behind it, are one
// re-read rather than seven.

import { SESSION_EVENT_CATEGORY_BY_TYPE, type SessionEventType } from "@ai-sidekicks/contracts";

/**
 * The wire namespaces whose frames can change what this feature has read.
 *
 * The two entities a session's stream announces: a workspace (`repo.workspaceList` and
 * the per-workspace capabilities read, and through it the mounts the section draws) and
 * an execution root (`repo.worktreeStatusRead`). A frame in either changes a row, a
 * state, or a health verdict.
 */
const REPO_EVENT_NAMESPACE_PREFIXES = ["workspace.", "worktree."] as const;

/**
 * Every registered lifecycle frame that names a workspace or an execution root.
 *
 * DERIVED FROM THE CONTRACT'S OWN CENSUS rather than hand-listed, so a kind the wire
 * adds in one of these namespaces is watched the day it is registered and a kind it
 * renames stops matching nothing silently. `SESSION_EVENT_CATEGORY_BY_TYPE` is the
 * canonical type registry — its keys are the whole census — and the filter selects by
 * NAMESPACE, which is the question this feature is asking ("does this frame name a
 * workspace or a worktree"). It deliberately does not infer a category from a
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
