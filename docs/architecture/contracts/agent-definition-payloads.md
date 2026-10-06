# Agent Definition Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-024 — Agent Definitions And Peer Invocation

Governed by [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md) and, for plugins, [Spec-029](../../specs/029-skills.md). Saved agents are managed through six `agent.*` verbs — `agent.definitionList`, `agent.definitionCreate`, `agent.definitionUpdate`, `agent.definitionDelete`, `agent.definitionExport` and `agent.definitionImport` — plus the live `agent.definitionSubscribe`, and the tool allowlist's catalog read `callbackTool.list`; the `agent.*` verbs register against the Plan-005 `MethodRegistry` when Plan-024 lands, inside the `agent` root Plan-013 registers — the CP-005-2 late-registration pattern. The person's own edits to definitions, export and import included, pass no policy check and no ownership refusal; the definition verbs carry no `sessionId`. A peer-invocation call is an ordinary tool call on the bridge, so it rides the existing `tool_execution` approval category through the approval pipeline at the session's own permission level. No `ApprovalCategory` value is added. Refusals: [error-contracts.md §Agent Definitions](./error-contracts.md#agent-definitions). **No event type is minted**: definition mutation is node-local configuration rather than session history, and every session-visible consequence of a peer invocation is already carried by the existing tool-activity and run-lifecycle events. A definition reaches the person's linked devices like every other screen, and otherwise leaves the machine only in the export files the person writes, with every binding's account left out.

```ts
// A daemon-minted opaque immutable identifier. NEVER the definition's name: the name is a mutable
// human label, and a rename must not orphan an audit row or a stored reference. Same discipline as
// ProviderAccountId (Plan-023) — the identity and the words a person reads are separate axes on purpose.
type AgentDefinitionId = string & { readonly __brand: "AgentDefinitionId" };

// A saved, node-local agent configuration. Configuration, not session state: not events-canonical,
// not rebuilt from the event log. Every axis below is one a run already carries, so this
// shape composes existing axes into a reusable named bundle and mints no new configuration dimension.
// One provider binding: which provider runs the agent, on which model, paying from which account, at
// which reasoning effort, and — on a running agent — at which output speed. A definition carries a
// DEFAULT binding and any number of overrides, so one saved agent runs on either provider without a
// second definition — the cross-provider bridge the library is for. The default is one of the bindings
// rather than a fallback beside them: there is no unbound state to resolve from. The same shape is a
// running agent's binding: `agent.configUpdate` moves its members, and the binding events
// (orchestration-payloads.md §Plan-013) carry it from and to.
// Both members of the provider pair are always present: `driverName` is null only when the file
// names a provider this app does not run, and then `unsupportedProviderName` holds that name as the
// file gave it, kept apart so a binding's provider is only ever one the app runs.
interface AgentProviderBinding {
  // provider driver key, matching the agent surface's driver axis; null only on a saved definition
  // whose file names a provider this app does not run, never on a live agent's binding, whose
  // driver is parsed as a ProviderName where agent.provider_binding_changed writes it
  driverName: ProviderName | null;
  // the provider name the file gave when `driverName` is null; null otherwise
  unsupportedProviderName: string | null;
  modelId: string;
  providerAccountId: ProviderAccountId | null; // null = follow the provider's current account — the one marked `Default`, which `providerAccount.setCurrent` moves — resolved AT THE MOMENT THE RUN STARTS and followed when the mark moves. Deliberately not a foreign key: a definition may name an account that is later removed, and that must surface as a typed resolution refusal the person can act on, not as a delete-time cascade that silently rewrites the definition
  effort: string | null; // null = the driver's default. Validated at RESOLUTION against the target model's driver-reported `effortLevels` — never against a hardcoded list, and never at save, because the vocabulary belongs to the model a run actually binds
  outputSpeed?: string; // set on a running agent's binding through agent.configUpdate; a saved definition's bindings leave it absent, because the editor authors no speed
}

interface AgentDefinition {
  definitionId: AgentDefinitionId;
  name: string; // mutable label; unique per origin and scope under full Unicode case folding, arbitrated by the unique
  // index over the stored `name_folded` key (I-024-7), so a provider's own `reviewer` sits beside ours; the
  // service pre-check is a legibility affordance
  description: string; // may be empty; written by the person
  // A glyph key from the console's own icon set. Icon and color are separate fields rather than one theme,
  // so a person can change either without the other. null = the generic agent mark.
  icon: string | null;
  // One step of the console's twelve-step hue wheel. null = no chosen hue, and the card draws the generic mark's own.
  accentHue: string | null;
  // The provider bindings. `overrides` is present on a stored row and may be empty, so a reader never has
  // to tell an empty set from a missing one.
  bindings: {
    default: AgentProviderBinding;
    overrides: AgentProviderBinding[];
  };
  instructions: string; // may be empty; system-prompt content the person writes
  goal: string | null;
  toolAllowlist: string[] | null; // null = the driver's defaults, [] = no tools at all, populated = exactly these. Collapsing null and [] would make "I did not choose" indistinguishable from "I chose nothing"
  // The number of turns this agent may take before it is stopped; null = no cap, and the daemon adds
  // none of its own. One number on both providers although only one enforces it natively: on the leg
  // that publishes no limit the daemon counts the agent's model rounds on the wire, and at the cap its
  // pre-tool hook denies every further call, so the agent reports what it completed and its turn ends.
  // It is not a budget — budgets and their ceilings are
  // [Spec-014 §Budget Policies](../../specs/014-multi-agent-orchestration.md#budget-policies)'s.
  turnCap: number | null;
  // The agent's own hooks, on every origin and both providers, in Claude Code's own shape — the form an
  // agent file's `hooks` key holds, one entry per event, each a list of `{ matcher?, hooks: [handler] }`.
  // null = none. The console's own pause hooks are the daemon's and never appear here.
  hooks: AgentHooks | null;
  // The agent's one memory, read on screen as `All projects`, `This project · in the repo`,
  // `This project · not in the repo` or `None`: "user" = every project, in the daemon's own
  // agent-memory folder, which every Claude Code config home links to; "project" = this project, kept
  // in the repository; "local" = this project, kept outside the repository; null = none. Claude Code
  // reads it natively and the daemon reads it for a Codex run, so either provider running the agent
  // reads and writes the same folder.
  memoryScope: "user" | "project" | "local" | null;
  createdAt: string; // ISO-8601
  updatedAt: string;
}

// Claude Code's own hook value, keyed by event name. Each handler is carried as that provider's hook
// schema spells it and validated against it at save; the editor draws one row per handler.
type AgentHooks = Record<
  string,
  Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>
>;

// The RESOLVED-CONFIGURATION ECHO: every field as actually applied, once a run has started under a
// definition. It rides the response of whichever request started that run — the scratch session a try-it
// starts, the workflow step's own record, and the agent row a name in a composer produces — so a resolved
// binding has exactly ONE home on the wire and no surface reconstructs it by merging its own request with
// a registry row that may already have moved. `instructions` is part of the echo rather than left out of
// it: without it a caller cannot tell which system prompt the run actually received except by re-reading
// the registry, which is the live-view read I-024-2 forbids. The goal is echoed as the definition set it;
// the agent also starts with it as its own goal command, which `session.goal_updated` records. Where the
// definition is bound plural the echo carries the RESOLVED BINDING in place of the folded axes, so a
// reader is told which side of the per-field merge won rather than which axes existed to merge.
type AgentResolvedConfiguration = {
  resolvedFromDefinitionId: AgentDefinitionId;
  resolvedBinding: AgentProviderBinding;
} & Pick<AgentDefinition, "toolAllowlist" | "instructions" | "goal">;

// agent.definitionList — node-local and unfiltered: every definition from the four origins — ours
// (`.ai-sidekicks/agents/`, global or in a project), Claude Code's own agent files, Codex's own, and a
// plugin's, which is read-only — one list serving the library, the composer's Sidekicks group, a
// workflow node's chooser and every label that names an agent. The daemon parses every file itself
// rather than trusting a provider's own load. The request carries no members, declared as an explicit
// empty interface rather than omitted, so every operation in this namespace has both halves of its pair
// and no handler signature special-cases a missing request type (the
// ProviderAccountSubscribeRequest precedent).
interface AgentDefinitionListRequest {}
// One definition as the list serves it: the record, where it lives, and two provider facts, each its
// own field and neither excluding another.
type AgentDefinitionListEntry = AgentDefinition & {
  origin: "ours" | "claude" | "codex" | "plugin";
  pluginName?: string; // present exactly on a plugin's agent
  scope: "global" | "project";
  projectId?: ProjectId; // present exactly when scope is "project"
  sourcePath: string; // the file the record lives in, or for an orphaned record the last path its file was known at; display-only data
  orphaned: boolean; // a provider's file was renamed or deleted outside the app: the record keeps its extras until it is reattached or discarded
  disabledInProvider: boolean; // the provider's own configuration switches the agent off
  loadError: string | null; // its file failed to load: the reason, from the daemon's own parse
  // A definition whose file names a provider this app doesn't run is listed too, its chip reading
  // `<name> · not supported here`. The read carries that name apart from the binding's ProviderName,
  // and starting the definition is refused with `agent.resolution_refused`, reason
  // `provider_unsupported`, until another provider is picked.
};
interface AgentDefinitionListResponse {
  definitions: AgentDefinitionListEntry[];
  // How many workflow definitions bind each definition, folded per reply over the current body of
  // every workflow definition on the node (each `agent`-typed param counted once per workflow) and
  // never stored. Optional as a whole, and absent only when the workflow store could not be read;
  // a listed definition no workflow binds maps to 0 (Spec-026 §Interfaces And Contracts).
  workflowUsage?: Record<AgentDefinitionId, number>;
  // When a session run or a workflow run last resolved each definition, folded per reply from the runs
  // that record their resolved-from definition and never stored. Optional as a whole, and absent only
  // when run history could not be read; a definition never run has no key.
  lastUsedAt?: Record<AgentDefinitionId, string>;
}

// agent.definitionCreate — every axis except name is optional; omitted axes store as the null
// ("inherit / default") state rather than a materialized value, so a definition never silently
// pins today's default forever. The daemon writes our file under the scope's `.ai-sidekicks/agents/`,
// holding every field, and the store row in one operation.
interface AgentDefinitionCreateRequest {
  name: string;
  description?: string;
  icon?: string | null;
  accentHue?: string | null;
  // `overrides` is OPTIONAL on the request and always present on the stored row — the same
  // stored-versus-draft grammar the rest of this surface uses: an author who has not added one submits
  // nothing, and the daemon stores an empty list rather than leaving the member absent.
  bindings: {
    default: AgentProviderBinding;
    overrides?: AgentProviderBinding[];
  };
  instructions?: string;
  goal?: string | null;
  toolAllowlist?: string[] | null;
  turnCap?: number | null;
  hooks?: AgentHooks | null;
  memoryScope?: AgentDefinition["memoryScope"];
  scope?: "global" | "project"; // the editor's Global or project control; omitted = "global"
  projectId?: ProjectId; // required when scope is "project"
}
interface AgentDefinitionCreateResponse {
  definition: AgentDefinitionListEntry;
}

// agent.definitionUpdate — a partial patch. An ABSENT key leaves the stored value alone; an
// explicit null CLEARS it back to the inherit state. That distinction is why the nullable axes are
// `field?: T | null` rather than `field?: T`: without it there is no wire way to say "stop pinning
// this", and the person could set an account or an effort but never unset one. A field the provider's
// own file holds is written into that file in place; a field it cannot hold is written only to our
// record beside it, so a provider's file never gains a key its provider does not read. Refused on a
// plugin's agent, which is read-only.
interface AgentDefinitionUpdateRequest {
  definitionId: AgentDefinitionId;
  name?: string;
  description?: string;
  icon?: string | null;
  accentHue?: string | null;
  // `bindings` patches as a WHOLE-OBJECT REPLACE, not per override: a per-override patch grammar would
  // need stable override identities and a three-way merge, which is more wire than the editor's own
  // save-the-whole-set gesture needs. Absent still leaves the stored bindings alone.
  bindings?: {
    default: AgentProviderBinding;
    overrides?: AgentProviderBinding[];
  };
  instructions?: string;
  goal?: string | null;
  toolAllowlist?: string[] | null;
  turnCap?: number | null;
  hooks?: AgentHooks | null; // a whole-object replace, as `bindings`
  memoryScope?: AgentDefinition["memoryScope"];
  // Reattaches an orphaned record to a provider's file: the token of the file the person picked with
  // `native.showOpenDialog`, which main's relay turns into a path (Spec-021 §Preload Bridge Contract).
  // Accepted only while the record is orphaned.
  reattachFile?: FilePathRef;
}
interface AgentDefinitionUpdateResponse {
  definition: AgentDefinitionListEntry; // the full post-update row, so a client never reconstructs it by merging its own patch
}

// agent.definitionDelete — never refused and never cascading. A session already running this
// agent keeps the configuration it was given, and a workflow node that references it refuses at its
// next run; the caller's own confirmation is where that consequence is named, so the wire carries no
// force flag and no dependency list (Spec-026 §State And Data Implications). On an agent that came
// from a provider's own file, the daemon checks that the path is the provider's agent file it read,
// deletes that file and the record beside it in one act, so the provider loses the agent too. On an
// orphaned record it discards the record.
interface AgentDefinitionDeleteRequest {
  definitionId: AgentDefinitionId;
}
interface AgentDefinitionDeleteResponse {
  deleted: true;
}

// agent.definitionExport — writes the chosen definitions into the folder the person picked with the
// platform's own dialog, one Markdown file per definition: each definition's record, icon, accent,
// hooks and memory scope, and every binding with the account left out. The notes in an agent's memory
// folder are never read into a file. The daemon leaves the accounts out itself and never relies on the
// caller to. The request carries the picked folder's token; main's relay turns it into the path the
// daemon writes, so no path string crosses the bridge (Spec-021 §Preload Bridge Contract). An unknown
// id refuses the whole export; a failed write refuses with `agent.export_write_failed`, carrying the
// operating system's cause.
interface AgentDefinitionExportRequest {
  definitionIds: AgentDefinitionId[]; // one or more
  folder: FilePathRef;
}
interface AgentDefinitionExportResponse {
  exportedCount: number;
}

// agent.definitionImport — reads the definition files in the folder the person picked with the
// platform's own dialog and creates every definition in them in one daemon transaction. It
// only ever creates and never overwrites, suffixes a colliding name as `Duplicate` does (checked
// against the store's unique name index), lands every definition in the global scope, because the
// files carry nothing tied to one machine, and keeps each definition's hooks and memory scope. The
// files carry no account, so an import never binds one. Every other file in the folder is skipped and
// listed once with its reason, as Claude Code treats its own agents folder; no import is refused whole
// for a file that is not a definition.
interface AgentDefinitionImportRequest {
  folder: FilePathRef;
}
interface AgentDefinitionImportResponse {
  definitions: AgentDefinitionListEntry[]; // the created rows, under their final, possibly suffixed, names
  skipped: Array<{ fileName: string; reason: "not_an_agent_definition" }>; // drawn `README.md · not an agent definition`
}

// agent.definitionSubscribe — the whole agent.definitionList reply again each time a definition
// changes: a save, delete or import from any window; a provider's file added, changed or removed on
// disk as the daemon's watch sees it; a plugin landing or leaving. Every open window's library,
// composer group and workflow chooser stay current without re-reading.
interface AgentDefinitionSubscribeRequest {}
type AgentDefinitionSubscribeStream = AsyncIterable<AgentDefinitionListResponse>;

// callbackTool.list — the daemon's callback tools, one of the allowlist picker's three sources beside
// the MCP catalog (`mcp.list`, mcp-governance-payloads.md §Plan-022) and each provider's own built-in tools (the `builtInTools`
// list on `driver.listCapabilities`, provider-driver-capability-payloads.md). Node-wide, because the editor has no session: a static
// catalog of the registrations in code — the bridge's verbs, the session tools and the
// workflow tools — whose names the daemon curates and never takes from provider output.
interface CallbackToolListRequest {}
interface CallbackToolListResponse {
  tools: Array<{
    name: string; // the wire name a provider sees
    label?: string; // the words a person reads, the one label the picker and the transcript both draw; absent = the name in sentence case
    description: string;
  }>;
}

// ---- Plugins: each provider's own plugin verbs, over one daemon-owned plugin home per provider ----
// Plugins install into a plugin home the daemon owns, one per provider, never an account home and
// never the person's own home: every `claude plugin` command runs with that folder as
// `CLAUDE_CONFIG_DIR`, and Codex's `plugin/*` and `marketplace/*` verbs are answered by a
// `codex app-server` the daemon starts on that folder while the view is open and stops 60 seconds
// after it closes. An installed plugin's agents and skills are the read-only plugin origin
// (`plugin · <name>`) of the definition list and the skills list. Under Codex the view lists what
// Codex's own `/plugins` lists for the account, the workspace's catalog and the plugins shared with
// the person included, each as its own section below Codex's catalog and each row installed like
// any other. Installing or removing a plugin raises the daemon's own `plugin.installed` /
// `plugin.uninstalled` signal, which the origin reader, `agent.definitionSubscribe` and the session
// pack follow; neither is a session event.
type PluginProvider = "claude" | "codex";
// plugin.catalogList — each provider's catalog, read once per opening of the view and held only while
// it is open. The daemon filters by `query`, because neither provider's verb takes one.
interface PluginCatalogListRequest {
  provider: PluginProvider;
  query?: string;
  cursor?: string;
}
interface PluginCatalogListResponse {
  plugins: Array<{
    id: string;
    provider: PluginProvider;
    name: string;
    displayName: string;
    description: string;
    marketplace: string;
    // The section the row is drawn under: the provider's catalog, or on Codex `Workspace`
    // (`workspace-directory`) or `Shared with me` (`shared-with-me`).
    section: "catalog" | "workspace-directory" | "shared-with-me";
    carries: { agents: number; skills: number; mcpServers: number; hooks: number };
    installed: boolean;
    installedInTerminal: boolean; // installed in the person's own terminal, read without writing; `Use in Sidekicks` installs the same plugin here
  }>;
  nextCursor?: string;
}
// plugin.read — what one plugin carries, each item by name and description, and its source.
interface PluginReadRequest {
  provider: PluginProvider;
  id: string;
}
interface PluginReadResponse {
  items: Array<{
    kind: "agent" | "skill" | "mcpServer" | "hook";
    name: string;
    description: string;
  }>;
  source: { marketplace: string; repository?: string; commit?: string }; // repository and commit for a plugin fetched from elsewhere
}
// plugin.install / plugin.uninstall — the provider's own install and uninstall in the daemon's plugin
// home. An install reaches a live session as a saved agent does: on Claude Code by the resume at the
// session's next idle moment, on Codex by forking the lead's conversation.
interface PluginInstallRequest {
  provider: PluginProvider;
  id: string;
}
interface PluginUninstallRequest {
  provider: PluginProvider;
  id: string;
}
interface PluginInstallResponse {
  plugin: {
    id: string;
    provider: PluginProvider;
    name: string;
    displayName: string;
    description: string;
    marketplace: string;
    installed: boolean;
    installedInTerminal: boolean;
  };
}
interface PluginUninstallResponse {
  uninstalled: true;
}
// plugin.installedList — the plugins in the daemon's plugin homes, and those the person installed in
// their own terminal (`installedInTerminal`).
interface PluginInstalledListRequest {
  provider?: PluginProvider;
}
interface PluginInstalledListResponse {
  plugins: PluginCatalogListResponse["plugins"];
}
// plugin.marketplaceAdd / plugin.marketplaceRemove — each provider's official marketplace is present
// without adding it.
interface PluginMarketplaceAddRequest {
  provider: PluginProvider;
  source: string; // a repository address or a folder
}
interface PluginMarketplaceRemoveRequest {
  provider: PluginProvider;
  name: string;
}
interface PluginMarketplaceChangeResponse {
  provider: PluginProvider;
  name: string;
}
// plugin.appList — a Codex plugin's apps, each with its link state on every Codex account, read from
// that account's own Codex service. `connectUrl` opens the app's page in the browser, where the person
// links it while signed in as that account. An API-key account carries no apps.
interface PluginAppListRequest {
  provider: "codex";
  pluginId: string;
}
interface PluginAppListResponse {
  apps: Array<{
    appId: string;
    name: string;
    accounts: Array<{ providerAccountId: ProviderAccountId; linked: boolean; connectUrl: string }>;
  }>;
}

// ---- The peer-invocation bridge: one tool server, six verbs (Plan-024 T4.1) ----
// The daemon serves a session exactly ONE tool server, carrying six verbs — run, message, wait, stop,
// close, list — registered as ordinary SessionCallbackTool entries through the existing callback-tool
// dispatch seam (Spec-004 §Required Behavior). The host is the daemon's own, sits OUTSIDE the Spec-024
// MCP governance model (Spec-024 §Non-Goals), and is never override-governed. Both legs reach the
// verbs on the daemon's one shared `sidekicks` tool server, through the one `url` entry each session
// carries — Claude Code in `--mcp-config`, Codex in the conversation's `mcp_servers` table at
// `thread/start`, never Codex `dynamicTools`. On a Codex lead the tool server itself is the
// interface — its own description lists every cross-provider agent by name and description, and the
// lead runs one by name. On a Claude Code lead a cross-provider agent is a session-pack entry whose
// ONLY tools are these six: the lead's own tool list never holds them, so the lead reaches the agent
// through that entry and nothing else.
// All six are registered at spawn UNCONDITIONALLY and adjudicated per invocation, exactly as every
// other daemon-registered tool is: the call rides the `tool_execution` approval category through the
// approval pipeline under the session's own permission level — an asking level raises the same
// approval card any tool call raises, an approval rule can answer it, and a level that never asks
// never asks for this either — and a decline answers `denied` rather than hiding the tool.
// State-gated registration is refused — it would make any change invisible until the
// next spawn, because `callbackTools` rides only CreateSessionParams / ResumeSessionParams and no
// live-registry mutation seam exists, so the person who changed what the session permits mid-session
// would see nothing change until the leg respawned. Per-call adjudication needs no such seam.
// One withholding is inherited rather than invented: while the daemon's approval service — the
// in-process create the callback-tool host waits on — is not running, Spec-004's fail-closed
// availability rule withholds the WHOLE callbackTools registry at spawn, and these go with it.
// A definition's `toolAllowlist` filters this registry like any other tool source (I-024-10): a run
// under a definition whose allowlist is `[]` receives NO bridge verbs, and one naming an explicit set
// receives them only if it names them — an allowlist that did not bind the daemon's own curated tools
// would report a restriction that is not in force.
// Outcomes map onto the EXISTING CallbackToolResult arms; no result arm is added and no code is minted.
// A declined approval or an admission refusal answers `denied` carrying its reason; an unknown target or
// schema-invalid arguments answers `failed`. No invocation is left unanswered.
// EVERY VERB THAT NAMES A TARGET NAMES AN AGENT. `run` names a saved definition; `message`, `wait`,
// `stop` and `close` name an agent already running in this session, by the handle `run` returned; `list`
// names none. `run` may also carry a model and a reasoning effort, as both providers' own spawn calls
// take them. A request naming a provider, an account or a node is REFUSED — the agent's binding names
// them, and the unit an agent addresses is another configured agent, never a vendor — which is why no
// free-form target string and no provider or account member appears in any shape below.
// STATE LIVES IN THE DAEMON, NEVER IN THE TOOL-SERVER PROCESS. The handles, the provider-side thread and
// process identities, and what each agent has produced are the daemon's own, which is why nothing below
// carries a provider-side identifier even though the daemon holds one. A provider restarts a tool server
// under a live session and state held in that process goes with it: measured, the restart lost the
// handles, the next wait answered that no such handle existed, and the agent's whole task was re-run
// from the start — a second billed turn nobody asked for.

// The bridge's address for one running agent, minted by the daemon when `run` admits it and the only
// address the other four verbs take. Opaque and session-scoped, and deliberately NOT a RunId, an
// AgentId, or any provider-side thread or process id: a caller that could name a provider object could
// reach past the daemon that owns it.
type AgentBridgeHandle = string & { readonly __brand: "AgentBridgeHandle" };

// run — start a saved agent and ANSWER AT ONCE with its handle, never blocking until the work is done.
// The daemon resolves the definition, starts that provider's own unit of work under it — a thread on the
// Codex leg, a process on the Claude leg — admits the run through the ordinary orchestration pipeline,
// and links it to the run that reached it, the link recording `reachedBy: "bridge_run"` (orchestration-payloads.md §Plan-013's
// ChildRunProvenance); this surface mints no run kind. The daemon shows a bridged agent under the lead
// that reached it and hands the lead its result.
// Admission is evaluated SYNCHRONOUSLY inside the creation call, so the verb can never answer with the
// handle of a run that then died at admission. No admission check bounds how deep the chain runs: an
// agent reached through the bridge may reach another, and that one another, to any depth. Because the daemon owns the started process it reads that agent's output word
// by word in both directions, unlike a provider's own in-session helper seen through its lead.
interface AgentBridgeRunArguments {
  definitionId: AgentDefinitionId; // the saved definition — never a name
  task: string;
  modelId?: string; // this run's model in place of the binding's, resolved as the binding's is
  effort?: string; // this run's reasoning effort in place of the binding's, resolved as the binding's is
  // A JSON Schema the agent's final answer must fit, which `wait` then returns as an object. On Claude
  // Code it is `--json-schema` on the agent's process, which binds every turn of that process, so a later
  // `run` with a different schema or none restarts the process on `--resume` at its next idle moment and
  // the same schema keeps it; on Codex it is `outputSchema` on the conversation's `turn/start`.
  outputSchema?: Record<string, unknown>;
}
interface AgentBridgeRunResult {
  handle: AgentBridgeHandle;
}

// message — send a running agent more words. A message to one that has ALREADY FINISHED continues the
// same conversation with its memory intact rather than opening a second one, so a follow-up costs one
// more turn rather than a whole repeat; the conversation stays open until `close` ends it.
interface AgentBridgeMessageArguments {
  handle: AgentBridgeHandle;
  text: string;
}

// wait — BOUNDED, and it always settles. It returns within 10 seconds whatever the agent's state is
// then — still running, with what the agent has produced so far, or the terminal it reached with its
// output — which is also the longest a steer from the lead waits. A blocking wait would make the agent
// unsteerable by construction — on the Claude leg a helper reads what it is sent only at a tool round,
// so each bounded wait is the round that lets a steer land. A Claude Code agent's run counts as
// finished only when its process has no turn running and no background task left, because a Claude
// Code turn can end while a helper it started still runs.
// A wait outstanding when the agent reaches a terminal state is SETTLED BY THAT TERMINAL. The agent's run
// id does not exist before admission, so the waiter cannot subscribe ahead of it: the waiter MUST
// capture the run-lifecycle stream cursor BEFORE admitting, then subscribe and catch up from that
// captured cursor, settling from whichever source presents the terminal first and deduping by
// `(runId, runVersion)`. Subscribing merely before the verb returns is insufficient and MUST NOT be
// relied on — a live subscription opened after admission never resends the terminal that landed in
// between, which is the one window this ordering closes.
interface AgentBridgeWaitArguments {
  handle: AgentBridgeHandle;
  // A REQUEST, not a grant: the daemon caps it at 10 seconds and waits the capped figure, never the
  // caller's. The cap and the close rule's 15 seconds live beside the bridge's argument schema in the daemon's
  // agent bridge (`packages/runtime-daemon/src/agents/`), and the handler declares none of its own.
  timeoutSeconds?: number;
}
interface AgentBridgeWaitResult {
  handle: AgentBridgeHandle;
  // Six arms. `running` carries what the agent has produced so far; the five terminals
  // carry the output it produced. `finished_with_nothing` is the honest arm for an agent that reached
  // the end having produced nothing: reporting it as `finished` with empty output would present a
  // non-answer as an answer, and reporting it as `failed` would claim something went wrong.
  state: "running" | "finished" | "finished_with_nothing" | "failed" | "canceled" | "interrupted";
  // The text produced, or — where `run` named an `outputSchema` — the agent's final answer as the
  // object that fits it.
  output: string | Record<string, unknown>;
}

// stop — interrupt what the agent is doing now. The daemon reaches the provider running it directly (an
// interrupt on its Codex thread, an interrupt on its Claude Code process); the handle stays addressable,
// so whoever reached the agent learns the outcome on its next wait.
interface AgentBridgeStopArguments {
  handle: AgentBridgeHandle;
}

// close — end the bridge's hold on the agent: its conversation ends and the handle stops resolving, so a
// later verb naming it answers `failed`. The daemon ALSO closes a run on its own initiative — no
// provider tells a tool server that its caller was stopped, so an agent whose caller has gone would
// otherwise run on, billed, with nobody reading it. The daemon closes a run, and interrupts what it was
// doing, once its caller has had neither a wait in flight nor a turn running for 15 seconds, and at once
// when the caller's process exits, so an abandoned agent is interrupted within 25 seconds. The daemon
// drives every caller's turns, so a lead busy with its own long command, or thinking long between two
// waits, keeps its run.
interface AgentBridgeCloseArguments {
  handle: AgentBridgeHandle;
}

// list — what is running in this session, and the one verb that names no target. Each row carries the
// handle, the definition the agent was run under, the provider running it, and its state, which is what
// the session's own tree draws its mark of which provider is running an agent from. The verb spellings
// are plumbing and never reach a screen: a row says what the agent is doing, not which verb carried it.
interface AgentBridgeListArguments {}
interface AgentBridgeListResult {
  running: Array<{
    handle: AgentBridgeHandle;
    definitionId: AgentDefinitionId;
    driverName: string; // the provider actually running this agent, which need not be the lead's
    state: AgentBridgeWaitResult["state"];
  }>;
}
```

**Why no receipt growth.** A peer-invoked child's spend lands in the account row of the account the target agent ran on, an ordinary row under the provider it ran on. Causation rides the existing `run_links` edge (`parentRunId` + `reachedBy`), not a receipt roll-up, so the causal fact is recorded where it happened, and every provider's rows keep summing to its subtotal and the subtotals to the session total unchanged.

**The definition verbs, with the storage folded under them.** The list's reply carries the binding fold above and each definition's origin facts; create gains the bindings, the icon, the hue, the scope, the hooks and the memory scope; update replaces the bindings and the hooks whole and can reattach an orphaned record; delete removes a provider's own file with the agent; export and import move definitions through a file the person picks. The provider columns fold into ONE bindings column on the definition table, beside nullable columns for the icon and the hue — a stored JSON value rather than a child table, because the corpus's convention carries a bounded list that is always read with its row inline, which the tool allowlist on that same table already does, and a binding is never queried across definitions. A definition from a provider's own file keeps in the store only what that file cannot hold — the icon, the accent and, for a Codex agent, its hooks and memory scope — attached to the file by its name and location, and the name index is unique per origin and scope.

**Two library readings are derived on the list reply.** How many workflows bind a definition is `workflowUsage`, a fold over the workflow definitions on the node, and when a definition was last used is `lastUsedAt`, a fold over the session runs and workflow runs that record their resolved-from definition. Both are computed per reply and never stored, so the card, the library's last-used order and the delete confirmation read figures that are true when they are drawn; where a source cannot be read, its reading is absent rather than zero.

**How a saved agent reaches a session.** The daemon hands every agent to each provider at launch in the session pack, under the `sidekicks` namespace; nothing here is a wire method. On Claude Code each agent rides the `agents` map of the process's `initialize` request under its namespaced name with every field of its record — its tools, model, effort, tool servers, hooks, turn cap and memory, and no permission mode, so every agent runs at the session's level — because Claude Code drops `hooks` and `mcpServers` from a plugin's agent file. That map is fixed for the process's life, so a save reaches a running Claude Code session by a resume at the session's next idle moment — no turn and no background task running — with the new map; several saves before that moment make one restart and one `conversation_reloaded` notice. On Codex a role file carries the agent, and what a role file cannot carry — its hooks, tool servers, sandbox and memory — rides the conversation's `thread/start` configuration, the hooks with their trust records and, for a helper the lead starts, gated on that helper's agent type, each handler kind Codex does not run filled by the daemon's command hook; a save reaches a running Codex session by forking the lead's conversation on the running service.
