// Which console surface each growth-slate row is waited on BY — the ledger's other half.
//
// SPLIT OFF `growth-slate.ts` BY CONSUMER, WHICH IS NOT A SPLIT BY SIZE. The rule that
// data tables are never split for size is untouched here: what separates these
// sixty-two sentences from the sixty-two beside them is who reads them. `wire` is read at run time —
// `growth-refusals.ts` composes the sentence a person sees out of it — and
// `owningDocument` travels on every growth refusal's ledger. Nothing in a running
// console has ever read `consumingSurface`: it is written for a reader of
// `Plan-023 §Console growth slate`, and its only mechanical reader is the pair of
// checks below it.
//
// SO IT IS OFF THE INITIAL IMPORT GRAPH, which is the point. `growth-slate.ts` is
// reached from the bridge door on every launch, so every byte in it is on the document
// each session downloads; this half is reached from a co-located test and from nowhere
// else, and the bundler follows that.
//
// THE TWO HALVES CANNOT DRIFT. This is a `Record` over the same closed id union the
// rows are keyed by, so a row added with no surface beneath it and a surface filed
// under an id no row carries are both compile errors — the same pairing
// `GROWTH_SLATE_ROWS_BY_ID` gets from the union, applied to the half that left.

import type { GrowthSlateRowId } from "./growth-slate-row.js";

/**
 * The surface each row's wire is owed to, in the plan table's own words.
 *
 * Prose, and deliberately so: a surface is proved to reach for a row by a module
 * calling that row's operation, never by a string naming it. What this table is for is
 * the person reading the plan, and what the compiler holds is that every row has one.
 */
export const GROWTH_SLATE_CONSUMING_SURFACES: Readonly<Record<GrowthSlateRowId, string>> = {
  "browser-pane-namespace": "browser pane",
  "browser-tool-relay": "browser pane",
  "terminal-pane": "terminal pane",
  "dev-server-probe": "browser pane (the dev-server chip)",
  "session-lifecycle-verbs": "all-sessions list, workspace header",
  "session-directory-read":
    "session-store initialisation, all-sessions list, auxiliary context picker",
  "daemon-control-methods": "settings daemon page",
  "onboarding-methods": "first-run frame",
  "shell-config-preferences": "settings pages",
  "invites-list": "invites surface",
  "health-subscribe": "health strip, park banner",
  "agent-snapshot-axes": "agent console, cast bar",
  "child-run-linkage": "agent console run-linkage panel",
  "agent-provider-switch-failure": "composer (the target chip)",
  "agent-provider-switch-terminal":
    "agent console (the switch settlement line), runs pane (the status row)",
  "gitflow-actions": "repos, diffs, and pull-request surfaces",
  // TWO SURFACES ON BOTH ROWS, WHICH IS WHAT THE COMPOSER'S AFFORDANCE ADDED. The
  // artifact pane READS what was ingested; the composer's attachment strip is where a
  // file becomes an ingest at all — drop, paste, or the `+` menu's picker — so the
  // three-call trio and the abort are dispatched from the composer and their manifests
  // are read in the pane. A row naming one of them would send a reader owed this wire
  // to half the surfaces that stop working without it.
  "artifact-ingest-and-crud": "composer attachment strip, artifact pane",
  "artifact-allowlist-and-abort": "composer attachment strip, artifact pane",
  "worktree-setup-recipe": "repos surface",
  "workflow-event-registration": "workflow-run pane",
  "workflow-definition-scope": "workflow-builder pane",
  "timeline-epoch-attestation": "timeline pane",
  "timeline-path-reference": "timeline pane",
  "approval-method-payloads": "approvals pane",
  "approval-remembered-rule": "approvals pane",
  "approval-amendment-arm": "approvals pane",
  "session-goal-methods": "approvals pane (the session goal card)",
  "session-search": "palette, all-sessions list",
  "provider-session-import": "import flow",
  "attention-plane": "notification centre, icon-rail attention marker",
  "workflow-run-control": "workflow-run pane, workflow builder",
  "workflow-run-enumeration":
    "workflows destination (the runs it holds), channel timeline pane (the pinned progress card)",
  "caller-participant-identity":
    "members surface (invite create), approvals pane (the role-gated control)",
  "callback-tool-registry-read": "approvals pane",
  "sidekick-definition-registry":
    "sidekick-definitions page, agent console peer-invocation control",
  "hydrated-event-read": "timeline pane, ledger rows",
  "cost-receipt-read": "cost-receipt settings page, cost meters",
  "workflow-version-chain": "workflow-run pane (the resume control's re-pin picker)",
  "health-status-read":
    "cast bar health form, health strip, diagnostics settings page (its banner)",
  "daemon-version-negotiation": "frame version banner",
  "timeline-live-resubscribe": "ledger gap fill",
  "workspace-execution-context":
    "repos surface (the workspace card's three-path disclosure and its fallback badge)",
  "mount-health-identity-verdict":
    "repos surface (the mount card's health chip and the re-attach control the permanent verdict carries); settings mounts page (the mount row's verdict)",
  "channel-lifecycle-verbs": "channel list (mute / unmute / archive), create-a-channel form",
  "channel-roster-read": "channel list (the audience badge and the direct-pair label)",
  "membership-roster-read": "membership ledger (the four membership.update controls)",
  "participant-presence-detail": "roster (the per-device detail behind a row)",
  "terminal-control-holder": "roster (the holder mark on the holding participant's row)",
  "presence-activity-fields": "typing and agent-activity indicators (channel rows, roster rows)",
  "control-plane-host": "invites surface (the one-time link reveal)",
  "pending-invite-namespace": "invite confirmation (the deep-link surface)",
  "notification-permission-read":
    "notification centre (the OS-notifications-denied arm); notifications settings page (the permission notice)",
  "shell-status-signals":
    "frame shell-state chrome — the daemon chip, the version banner, the reconnect and read-only banners, and the loopback/keystore notice strip",
  "onboarding-desktop-surface": "first-run onboarding (group A)",
  "workflow-definition-authoring":
    "workflow-builder pane (the definition detail and its authoring acts), definitions browser",
  "health-diagnostics-reads": "diagnostics settings page",
  "provider-account-signin-and-token":
    "provider-accounts settings page (the sign-in card and the write-only token field)",
  "mcp-governance-plane": "MCP servers settings page",
  "node-self-declaration": "settings runtime-nodes page (the attach control)",
  "workflow-human-form-schema": "workflow-run pane (the human form a parked phase opens)",
  "intervention-history-read": "runs pane intervention history",
  "queue-item-run-binding": "runs pane queue list, composer queue shelf",
};
