# Forge Contracts, Desktop Shell, and Infrastructure Exploration

**Source:** `/home/sabossedgh/dev/forge/` -- exhaustive source-code read of `packages/contracts/src/`, `packages/shared/src/`, `apps/desktop/src/`, and root configuration.

---

## 1. Package Structure

### Monorepo Layout

```
forge/
  apps/
    desktop/       -- Electron shell (main process, preload, daemon lifecycle)
    server/        -- Node.js WebSocket server (Codex/Claude app-server wrapper)
    web/           -- React/Vite UI
  packages/
    contracts/     -- Effect/Schema type contracts (schema-only, no runtime logic)
    shared/        -- Runtime utilities (subpath exports, no barrel index)
  scripts/         -- Build, dev, release tooling
  design/          -- Design assets/specs
```

### Build System

- **Package manager:** Bun 1.3.9, Node 24.13.1
- **Build orchestrator:** Turborepo (`turbo.json`)
- **Type system:** TypeScript 5.7.3, strict mode, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`
- **Test runner:** Vitest 4.x (root `vitest.config.ts` with path aliases)
- **Linter:** oxlint; **Formatter:** oxfmt
- **Schema library:** Effect 4.0.0-beta.43 (core dependency for all contracts)
- **Target:** ES2023, ESNext modules, Bundler resolution
- **Desktop bundler:** electron-builder (via `scripts/build-desktop-artifact.ts`)

### Workspace Catalog (Pinned Dependencies)

| Package                      | Version           |
|------------------------------|-------------------|
| effect                       | 4.0.0-beta.43     |
| @effect/atom-react           | 4.0.0-beta.43     |
| @effect/platform-bun         | 4.0.0-beta.43     |
| @effect/platform-node        | 4.0.0-beta.43     |
| @effect/sql-sqlite-bun       | 4.0.0-beta.43     |
| typescript                   | ^5.7.3            |
| vitest                       | ^4.0.0            |

### Turbo Tasks

- `build` -- depends on `^build`, outputs `dist/**`, `dist-electron/**`
- `dev` -- depends on `@forgetools/contracts#build`, persistent, no cache
- `typecheck` -- depends on `^typecheck`, no cache
- `test` -- depends on `^build`, no cache

---

## 2. Type Contract Inventory (packages/contracts/src/)

### Base Schemas (`baseSchemas.ts`)

**Primitive types:**
- `TrimmedString` -- `Schema.Trim`
- `TrimmedNonEmptyString` -- trimmed + non-empty check
- `NonNegativeInt` -- integer >= 0
- `PositiveInt` -- integer >= 1
- `IsoDateTime` -- string alias for ISO timestamps

**Entity IDs (branded non-empty trimmed strings):**
- `ThreadId`, `ProjectId`, `CommandId`, `EventId`, `MessageId`, `TurnId`
- `WorkflowId`, `WorkflowPhaseId`, `PhaseRunId`
- `ChannelId`, `ChannelMessageId`, `LinkId`, `InteractiveRequestId`
- `ProviderItemId`, `RuntimeSessionId`, `RuntimeItemId`, `RuntimeRequestId`, `RuntimeTaskId`
- `ApprovalRequestId`, `CheckpointRef`, `DesignArtifactId`

### Channel Types (`channel.ts`)

**Enums:**
- `ChannelType` -- `"guidance" | "deliberation" | "review" | "system"`
- `ChannelStatus` -- `"open" | "concluded" | "closed"`
- `ChannelParticipantType` -- `"human" | "agent" | "system"`
- `DeliberationStrategy` -- `"ping-pong"`
- `InjectionStatus` -- `"injected" | "response-received" | "persisted"`

**Structs:**
- `ChannelMessage` -- id, channelId, sequence, fromType, fromId, fromRole, content, createdAt
- `Channel` -- id, threadId, phaseRunId, type, status, createdAt, updatedAt
- `InjectionState` -- sessionId, injectedAtSequence, turnCorrelationId, status
- `DeliberationState` -- strategy, currentSpeaker, turnCount, maxTurns, conclusionProposals, concluded, lastPostTimestamp, nudgeCount, maxNudges, stallTimeoutMs, injectionState

**Functions:**
- `createInitialDeliberationState(maxTurns)` -- factory for ping-pong deliberation

### Model Types (`model.ts`)

**Enums:**
- `CODEX_REASONING_EFFORT_OPTIONS` -- `["xhigh", "high", "medium", "low"]`
- `CLAUDE_CODE_EFFORT_OPTIONS` -- `["low", "medium", "high", "max", "ultrathink"]`

**Structs:**
- `CodexModelOptions` -- reasoningEffort, fastMode
- `ClaudeModelOptions` -- thinking, effort, fastMode, contextWindow
- `ProviderModelOptions` -- codex, claudeAgent (optional sub-structs)
- `EffortOption` -- value, label, isDefault
- `ContextWindowOption` -- value, label, isDefault
- `ModelCapabilities` -- reasoningEffortLevels, supportsFastMode, supportsThinkingToggle, contextWindowOptions, promptInjectedEffortLevels

**Constants:**
- `DEFAULT_MODEL_BY_PROVIDER` -- `{ codex: "gpt-5.4", claudeAgent: "claude-sonnet-4-6" }`
- `DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER` -- `{ codex: "gpt-5.4-mini", claudeAgent: "claude-haiku-4-5" }`
- `MODEL_SLUG_ALIASES_BY_PROVIDER` -- maps short names (e.g., `"5.4"`, `"opus"`, `"sonnet"`) to canonical slugs
- `PROVIDER_DISPLAY_NAMES` -- `{ codex: "Codex", claudeAgent: "Claude" }`

---

## 3. Orchestration Event Types (orchestration/)

### Event Type Taxonomy (`events.ts`)

**OrchestrationEventType (base events):**
`"project.created"`, `"project.meta-updated"`, `"project.deleted"`, `"thread.created"`, `"thread.deleted"`, `"thread.archived"`, `"thread.unarchived"`, `"thread.pinned"`, `"thread.unpinned"`, `"thread.meta-updated"`, `"thread.runtime-mode-set"`, `"thread.interaction-mode-set"`, `"thread.message-sent"`, `"thread.turn-start-requested"`, `"thread.turn-interrupt-requested"`, `"thread.interactive-request-response-requested"`, `"thread.checkpoint-revert-requested"`, `"thread.reverted"`, `"thread.session-stop-requested"`, `"thread.summary-requested"`, `"thread.session-set"`, `"thread.proposed-plan-upserted"`, `"thread.turn-diff-completed"`, `"thread.agent-diff-upserted"`, `"thread.activity-appended"`, `"thread.activity-inline-diff-upserted"`, `"thread.forked"`

**ForgeEventType (extensions beyond orchestration):**
`"thread.status-changed"`, `"thread.completed"`, `"thread.failed"`, `"thread.cancelled"`, `"thread.phase-started"`, `"thread.phase-completed"`, `"thread.phase-failed"`, `"thread.phase-skipped"`, `"thread.phase-output-edited"`, `"thread.quality-check-started"`, `"thread.quality-check-completed"`, `"thread.correction-queued"`, `"thread.correction-delivered"`, `"thread.bootstrap-queued"`, `"thread.bootstrap-started"`, `"thread.bootstrap-completed"`, `"thread.bootstrap-failed"`, `"thread.bootstrap-skipped"`, `"thread.turn-requested"`, `"thread.turn-started"`, `"thread.turn-completed"`, `"thread.turn-restarted"`, `"thread.link-added"`, `"thread.link-removed"`, `"thread.restarted"`, `"thread.promoted"`, `"thread.dependency-added"`, `"thread.dependency-removed"`, `"thread.dependencies-satisfied"`, `"thread.synthesis-completed"`, `"thread.checkpoint-captured"`, `"thread.checkpoint-diff-completed"`, `"thread.checkpoint-reverted"`, `"channel.created"`, `"channel.message-posted"`, `"channel.messages-read"`, `"channel.conclusion-proposed"`, `"channel.concluded"`, `"channel.closed"`, `"request.opened"`, `"request.resolved"`, `"request.stale"`, `"thread.design.artifact-rendered"`, `"thread.design.options-presented"`, `"thread.design.option-chosen"`

**Aggregate Kinds:**
- `OrchestrationAggregateKind` -- `"project" | "thread"`
- `ForgeAggregateKind` -- `"project" | "thread" | "channel" | "request"`
- `OrchestrationActorKind` -- `"client" | "server" | "provider"`

**Event Base Fields:**
Every event carries: `sequence`, `eventId`, `aggregateKind`, `aggregateId`, `occurredAt`, `commandId`, `causationEventId`, `correlationId`, `metadata`

**Event Metadata:**
`OrchestrationEventMetadata` -- providerTurnId, providerItemId, adapterKey, requestId, ingestedAt

### Event Payloads (exhaustive list)

**Project payloads:** `ProjectCreatedPayload`, `ProjectMetaUpdatedPayload`, `ProjectDeletedPayload`

**Session lifecycle payloads:** `SessionCreatedPayload`, `SessionStatusChangedPayload`, `SessionCompletedPayload`, `SessionFailedPayload`, `SessionCancelledPayload`, `SessionArchivedPayload`, `SessionUnarchivedPayload`, `SessionMetaUpdatedPayload`, `SessionRestartedPayload`

**Thread payloads:** `ThreadCreatedPayload`, `ThreadDeletedPayload`, `ThreadArchivedPayload`, `ThreadUnarchivedPayload`, `ThreadPinnedPayload`, `ThreadUnpinnedPayload`, `ThreadMetaUpdatedPayload`, `ThreadForkedPayload`, `ThreadRuntimeModeSetPayload`, `ThreadInteractionModeSetPayload`

**Message/Turn payloads:** `ThreadMessageSentPayload`, `ThreadTurnStartRequestedPayload`, `ThreadTurnInterruptRequestedPayload`, `ThreadInteractiveRequestResponseRequestedPayload`, `ThreadCheckpointRevertRequestedPayload`, `ThreadRevertedPayload`, `ThreadSessionStopRequestedPayload`, `ThreadSummaryRequestedPayload`, `ThreadSessionSetPayload`, `ThreadProposedPlanUpsertedPayload`, `SessionTurnRequestedPayload`, `SessionTurnStartedPayload`, `SessionTurnCompletedPayload`, `SessionTurnRestartedPayload`, `SessionMessageSentPayload`

**Diff/Checkpoint payloads:** `ThreadTurnDiffCompletedPayload`, `ThreadAgentDiffUpsertedPayload`, `SessionCheckpointCapturedPayload`, `SessionCheckpointDiffCompletedPayload`, `SessionCheckpointRevertedPayload`

**Activity payloads:** `ThreadActivityAppendedPayload`, `ThreadActivityInlineDiffUpsertedPayload`

**Phase payloads:** `ThreadPhaseStartedPayload`, `ThreadPhaseCompletedPayload`, `ThreadPhaseFailedPayload`, `ThreadPhaseSkippedPayload`, `ThreadPhaseOutputEditedPayload`

**Quality check payloads:** `ThreadQualityCheckStartedPayload`, `ThreadQualityCheckCompletedPayload`

**Bootstrap payloads:** `ThreadBootstrapQueuedPayload`, `ThreadBootstrapStartedPayload`, `ThreadBootstrapCompletedPayload`, `ThreadBootstrapFailedPayload`, `ThreadBootstrapSkippedPayload`

**Correction payloads:** `ThreadCorrectionQueuedPayload`, `ThreadCorrectionDeliveredPayload`

**Link/Dependency payloads:** `ThreadLinkAddedPayload`, `ThreadLinkRemovedPayload`, `ThreadPromotedPayload`, `ThreadDependencyAddedPayload`, `ThreadDependencyRemovedPayload`, `ThreadDependenciesSatisfiedPayload`, `ThreadSynthesisCompletedPayload`

**Channel payloads:** `ChannelCreatedPayload`, `ChannelMessagePostedPayload`, `ChannelMessagesReadPayload`, `ChannelConclusionProposedPayload`, `ChannelConcludedPayload`, `ChannelClosedPayload`

**Request payloads:** `InteractiveRequestOpenedPayload`, `InteractiveRequestResolvedPayload`

### Orchestration Core Types (`types.ts`)

**Session/Runtime enums:**
- `ForgeSessionType` -- `"agent" | "workflow" | "chat"`
- `RuntimeMode` -- `"approval-required" | "full-access"` (default: `"full-access"`)
- `ThreadSpawnMode` -- `"local" | "worktree"`
- `ProviderInteractionMode` -- `"default" | "plan" | "design"` (default: `"default"`)
- `ProviderRequestKind` -- `"command" | "file-read" | "file-change"`
- `AssistantDeliveryMode` -- `"buffered" | "streaming"`
- `OrchestrationSessionStatus` -- `"idle" | "starting" | "running" | "ready" | "interrupted" | "stopped" | "error"`
- `OrchestrationCheckpointStatus` -- `"ready" | "missing" | "error"`
- `OrchestrationAgentDiffSource` -- `"native_turn_diff" | "derived_tool_results"`
- `OrchestrationAgentDiffCoverage` -- `"complete" | "partial" | "unavailable"`
- `OrchestrationThreadActivityTone` -- `"info" | "tool" | "approval" | "error"`
- `OrchestrationLatestTurnState` -- `"running" | "interrupted" | "completed" | "error"`
- `OrchestrationToolInlineDiffAvailability` -- `"exact_patch" | "summary_only"`
- `ProjectScriptIcon` -- `"play" | "test" | "lint" | "configure" | "build" | "debug"`

**Core data structs:**
- `OrchestrationProject` -- id, title, workspaceRoot, defaultModelSelection, scripts, timestamps
- `OrchestrationThread` -- id, projectId, title, modelSelection, runtimeMode, interactionMode, branch, worktreePath, spawnMode, latestTurn, timestamps, messages, proposedPlans, activities, checkpoints, agentDiffs, session, childThreadIds, bootstrapStatus, and many more fields
- `OrchestrationMessage` -- id, role, text, attachments, attribution, turnId, streaming, timestamps
- `OrchestrationSession` -- threadId, status, providerName, runtimeMode, activeTurnId, lastError
- `OrchestrationProposedPlan` -- id, turnId, planMarkdown, implementedAt, implementationThreadId
- `OrchestrationCheckpointSummary` -- turnId, checkpointTurnCount, checkpointRef, status, files, assistantMessageId
- `OrchestrationAgentDiffSummary` -- turnId, files, source, coverage, assistantMessageId
- `OrchestrationThreadActivity` -- id, tone, kind, summary, payload, turnId, sequence
- `OrchestrationLatestTurn` -- turnId, state, requestedAt, startedAt, completedAt, assistantMessageId, sourceProposedPlan
- `OrchestrationCheckpointFile` -- path, kind, additions, deletions
- `OrchestrationDiffFileChange` -- path, kind, additions, deletions
- `OrchestrationToolInlineDiff` -- availability, files, additions, deletions, unifiedDiff
- `OrchestrationMessageAttribution` -- sourceThreadId, role, model
- `ProjectScript` -- id, name, command, icon, runOnWorktreeCreate

**Attachment types:**
- `ChatImageAttachment` -- type "image", id, name, mimeType, sizeBytes
- `UploadChatImageAttachment` -- adds dataUrl for upload
- `ChatAttachment` -- union of attachment types
- `UploadChatAttachment` -- union of upload attachment types

**Constants:**
- `PROVIDER_SEND_TURN_MAX_INPUT_CHARS` = 120,000
- `PROVIDER_SEND_TURN_MAX_ATTACHMENTS` = 8
- `PROVIDER_SEND_TURN_MAX_IMAGE_BYTES` = 10MB

### Read Models (`readModels.ts`)

**Enums:**
- `SessionStatus` -- `"created" | "running" | "needs-attention" | "paused" | "completed" | "failed" | "cancelled"`

**Structs:**
- `OrchestrationReadModel` -- snapshotSequence, projects, threads, phaseRuns, channels, pendingRequests, workflows, updatedAt
- `ForgeReadModel` -- snapshotSequence, projects, sessions, phaseRuns, channels, pendingRequests, workflows, updatedAt (flattened session view)
- `ForgeClientSnapshot` -- same shape as ForgeReadModel but with lighter sub-structs
- `SessionSummary` -- threadId, projectId, sessionType, status, role, provider, model, runtimeMode, workflowId, currentPhaseId, discussionId, branch, bootstrapStatus, childThreadIds, timestamps
- `WorkflowSummary` -- workflowId, name, description, builtIn, projectId, hasDeliberation
- `OrchestrationReadModelPhaseRun` -- phaseRunId, threadId, phaseId, phaseName, phaseType, iteration, status, timestamps
- `OrchestrationReadModelWorkflow` -- workflowId, name, description, builtIn

### Commands (`commands.ts`)

**Client-dispatchable commands (19 types):**
- `ProjectCreateCommand`, `ProjectMetaUpdateCommand`, `ProjectDeleteCommand`
- `ThreadCreateCommand`, `ThreadDeleteCommand`, `ThreadForkCommand`
- `ThreadArchiveCommand`, `ThreadUnarchiveCommand`, `ThreadPinCommand`, `ThreadUnpinCommand`
- `ThreadMetaUpdateCommand`, `ThreadRuntimeModeSetCommand`, `ThreadInteractionModeSetCommand`
- `ThreadTurnStartCommand` / `ClientThreadTurnStartCommand`
- `ThreadTurnInterruptCommand`, `ThreadInteractiveRequestRespondCommand`
- `ThreadCheckpointRevertCommand`, `ThreadSessionStopCommand`, `ThreadSummaryRequestCommand`

**Forge session commands:**
- `SessionCreateCommand`, `SessionPauseCommand`, `SessionResumeCommand`, `SessionRecoverCommand`, `SessionCancelCommand`, `SessionRestartCommand`, `SessionMetaUpdateCommand`
- `SessionSendTurnCommand`, `SessionRestartTurnCommand`, `SessionSendMessageCommand`

**Phase commands:**
- `ThreadStartPhaseCommand`, `ThreadCompletePhaseCommand`, `ThreadFailPhaseCommand`, `ThreadSkipPhaseCommand`
- `ThreadEditPhaseOutputCommand`, `ThreadQualityCheckStartCommand`, `ThreadQualityCheckCompleteCommand`
- `ThreadBootstrapStartedCommand`, `ThreadBootstrapCompletedCommand`, `ThreadBootstrapFailedCommand`, `ThreadBootstrapSkippedCommand`
- `ThreadCorrectCommand`

**Link/Dependency commands:**
- `ThreadAddLinkCommand`, `ThreadRemoveLinkCommand`, `ThreadPromoteCommand`
- `ThreadAddDependencyCommand`, `ThreadRemoveDependencyCommand`
- `LinkType` -- `"pr" | "issue" | "ci-run" | "promoted-from" | "promoted-to" | "related"`

**Channel commands:**
- `ChannelCreateCommand`, `ChannelPostMessageCommand`, `ChannelReadMessagesCommand`
- `ChannelConcludeCommand`, `ChannelMarkConcludedCommand`, `ChannelCloseCommand`

**Request commands:**
- `RequestOpenCommand`, `RequestResolveCommand`, `RequestMarkStaleCommand`

**Design commands:**
- `ThreadDesignArtifactRenderedCommand`, `ThreadDesignOptionsPresentedCommand`, `ThreadDesignOptionChosenCommand`
- `DesignOptionSchema` -- id, title, description, artifactId, artifactPath

**Internal commands (streamed by server):**
- `ThreadSessionSetCommand`, `ThreadMessageAssistantDeltaCommand`, `ThreadMessageAssistantCompleteCommand`
- `ThreadMessageAppendCommand`, `ThreadProposedPlanUpsertCommand`, `ThreadTurnDiffCompleteCommand`
- `ThreadAgentDiffUpsertCommand`, `ThreadActivityAppendCommand`, `ThreadActivityInlineDiffUpsertCommand`
- `ThreadRevertCompleteCommand`

**Command unions:**
- `ClientOrchestrationCommand` -- all client-dispatchable commands
- `OrchestrationCommand` -- client + internal commands
- `ForgeCommand` -- full Forge command set including session/phase/channel/request/design commands

---

## 4. RPC Schema Definitions (rpc.ts, orchestration/rpcSchemas.ts)

### Orchestration RPC Schemas

| Method                                | Input                                         | Output                                          |
|---------------------------------------|-----------------------------------------------|--------------------------------------------------|
| `orchestration.getSnapshot`           | `OrchestrationGetSnapshotInput`               | `OrchestrationReadModel`                         |
| `orchestration.dispatchCommand`       | `ClientOrchestrationCommand`                  | `DispatchResult { sequence }`                    |
| `orchestration.getTurnDiff`           | `OrchestrationGetTurnDiffInput`               | `ThreadTurnDiff`                                 |
| `orchestration.getFullThreadDiff`     | `OrchestrationGetFullThreadDiffInput`         | `ThreadTurnDiff`                                 |
| `orchestration.getCommandOutput`      | `OrchestrationGetCommandOutputInput`          | `OrchestrationGetCommandOutputResult`            |
| `orchestration.getSubagentActivityFeed` | `OrchestrationGetSubagentActivityFeedInput` | `OrchestrationGetSubagentActivityFeedResult`     |
| `orchestration.getTurnAgentDiff`      | `OrchestrationGetTurnAgentDiffInput`          | `OrchestrationGetTurnAgentDiffResult`            |
| `orchestration.getFullThreadAgentDiff`| `OrchestrationGetFullThreadAgentDiffInput`    | `OrchestrationGetFullThreadAgentDiffResult`      |
| `orchestration.replayEvents`          | `OrchestrationReplayEventsInput`              | `ForgeEvent[]`                                   |

**RPC-specific types:**
- `TurnCountRange` -- fromTurnCount, toTurnCount (validated: from <= to)
- `CommandOutputSource` -- `"final" | "stream"`
- `ProviderSessionRuntimeStatus` -- `"starting" | "running" | "stopped" | "error"`
- `ProjectionThreadTurnStatus` -- `"running" | "completed" | "interrupted" | "error"`
- `ProjectionCheckpointRow` -- thread checkpoint projection
- `ProjectionPendingApprovalStatus` -- `"pending" | "resolved"`

### WebSocket RPC Methods (WS_METHODS + FORGE_WS_METHODS)

**Project registry:** `projects.list`, `projects.add`, `projects.remove`, `projects.searchEntries`, `projects.writeFile`

**Shell:** `shell.openInEditor`

**Git:** `git.pull`, `git.status`, `git.workingTreeDiff`, `git.runStackedAction` (streaming), `git.listBranches`, `git.createWorktree`, `git.removeWorktree`, `git.createBranch`, `git.checkout`, `git.init`, `git.resolvePullRequest`, `git.preparePullRequestThread`

**Terminal:** `terminal.open`, `terminal.write`, `terminal.resize`, `terminal.clear`, `terminal.restart`, `terminal.close`

**Server meta:** `server.getConfig`, `server.refreshProviders`, `server.upsertKeybinding`, `server.getSettings`, `server.updateSettings`

**Streaming subscriptions:** `subscribeOrchestrationDomainEvents`, `subscribeTerminalEvents`, `subscribeServerConfig`, `subscribeServerLifecycle`

**Forge thread operations:** `thread.create`, `thread.correct`, `thread.pause`, `thread.resume`, `thread.cancel`, `thread.archive`, `thread.unarchive`, `thread.sendTurn`, `thread.getTranscript`, `thread.getChildren`, `session.getTranscript`, `session.getChildren`

**Gate operations:** `gate.approve`, `gate.reject`

**Request operations:** `request.resolve`

**Channel operations:** `channel.getMessages`, `channel.getChannel`, `channel.intervene`

**Phase run operations:** `phaseRun.list`, `phaseRun.get`, `phaseOutput.get`, `phaseOutput.update`

**Workflow operations:** `workflow.list`, `workflow.get`, `workflow.create`, `workflow.update`

**Discussion operations:** `discussion.list`, `discussion.get`, `discussion.listManaged`, `discussion.getManaged`, `discussion.create`, `discussion.update`, `discussion.delete`

**Push subscriptions:** `subscribeWorkflowEvents`, `subscribeChannelMessages`, `workflow.phase`, `workflow.quality-check`, `workflow.bootstrap`, `workflow.gate`, `channel.message`

---

## 5. Provider Schemas (`providerSchemas.ts`, `provider.ts`, `providerRuntime.ts`)

### Provider Kind and Selection (`providerSchemas.ts`)

- `ProviderKind` -- `"codex" | "claudeAgent"`
- `ProviderApprovalPolicy` -- `"untrusted" | "on-failure" | "on-request" | "never"`
- `ProviderSandboxMode` -- `"read-only" | "workspace-write" | "danger-full-access"`
- `ProviderApprovalDecision` -- `"accept" | "acceptForSession" | "decline" | "cancel"`
- `CodexModelSelection` -- provider "codex", model string, optional CodexModelOptions
- `ClaudeModelSelection` -- provider "claudeAgent", model string, optional ClaudeModelOptions
- `ModelSelection` -- union of CodexModelSelection | ClaudeModelSelection
- `DEFAULT_PROVIDER_KIND` = `"codex"`

### Provider Runtime (`providerRuntime.ts`)

**Session management:**
- `ProviderSession` -- provider, status, runtimeMode, cwd, model, threadId, resumeCursor, activeTurnId, timestamps, lastError
- `ProviderSessionStartInput` -- threadId, provider, cwd, modelSelection, resumeCursor, approvalPolicy, sandboxMode, runtimeMode, systemPrompt
- `ProviderSendTurnInput` -- threadId, input, attachments, modelSelection, interactionMode
- `ProviderTurnStartResult` -- threadId, turnId, resumeCursor
- `ProviderInterruptTurnInput` -- threadId, turnId
- `ProviderStopSessionInput` -- threadId
- `ProviderRespondToInteractiveRequestInput` -- threadId, requestId, resolution

**Provider events:**
- `ProviderEvent` -- id, kind, provider, threadId, createdAt, method, message, turnId, itemId, requestId, requestKind, textDelta, payload
- Provider event kind: `"session" | "notification" | "request" | "error"`
- Session status: `"connecting" | "ready" | "running" | "error" | "closed"`

---

## 6. Workflow and Discussion Types

### Workflow Types (`workflow.ts`)

**Phase system:**
- `PhaseType` -- `"single-agent" | "multi-agent" | "automated" | "human"`
- `GateAfter` -- `"auto-continue" | "quality-checks" | "human-approval" | "done"`
- `GateOnFail` -- `"retry" | "go-back-to" | "stop"`
- `PhaseRunStatus` -- `"pending" | "running" | "completed" | "failed" | "skipped"`
- `GateResultStatus` -- `"passed" | "failed" | "waiting-human"`
- `AgentOutputMode` -- `"schema" | "channel" | "conversation"`

**Core structs:**
- `WorkflowPhase` -- id, name, type, agent, deliberation, sandboxMode, inputFrom, gate, qualityChecks, codexMode
- `WorkflowDefinition` -- id, name, description, phases (min 1), builtIn, projectId, onCompletion, timestamps
- `WorkflowCompletionConfig` -- autoCommit, autoPush, createPr
- `PhaseGate` -- after, qualityChecks, onFail, retryPhase, maxRetries (default 3)
- `GateResult` -- status, qualityCheckResults, humanDecision, correction, evaluatedAt
- `AgentDefinition` -- prompt, output, model
- `AgentOutputConfig` -- union of AgentOutputSchema/Channel/Conversation
- `DeliberationConfig` -- participants (min 2), maxTurns (default 20)
- `DeliberationParticipant` -- role, agent
- `QualityCheckReference` -- check name, required flag
- `QualityCheckResult` -- check name, passed, output
- `QualityCheckConfig` -- command, timeout (default 300s), required
- `BootstrapConfig` -- command, timeout (default 300s)
- `ForgeProjectConfig` -- qualityChecks map, bootstrap, defaultModel
- `PromptTemplate` -- name, description, system, initial
- `InputFromReference` -- simple string or key-value map

**Functions:**
- `workflowHasDeliberation(phases)` -- checks if any phase is multi-agent with deliberation
- `defaultSandboxMode(phaseType)` -- single-agent/automated/human -> workspace-write, multi-agent -> read-only

### Discussion Types (`discussion.ts`)

- `DiscussionParticipant` -- role, description, optional model, system prompt
- `DiscussionSettings` -- maxTurns (default 20)
- `DiscussionDefinition` -- name, description, participants (min 2), settings
- `DiscussionScope` -- `"project" | "global"`
- `DiscussionSummary` -- name, description, participantRoles, scope
- `DiscussionRecord` -- full definition + scope
- `DiscussionManagedSummary` -- summary + effective flag

---

## 7. Git Operation Types (`git.ts`)

### Domain Enums

- `GitStackedAction` -- `"commit" | "push" | "create_pr" | "commit_push" | "commit_push_pr"`
- `GitActionProgressPhase` -- `"branch" | "commit" | "push" | "pr"`
- `GitActionProgressKind` -- `"action_started" | "phase_started" | "hook_started" | "hook_output" | "hook_finished" | "action_finished" | "action_failed"`
- `GitActionProgressStream` -- `"stdout" | "stderr"`
- Step statuses: `GitCommitStepStatus`, `GitPushStepStatus`, `GitBranchStepStatus`, `GitPrStepStatus`, `GitStatusPrState`, `GitPullRequestState`, `GitPreparePullRequestThreadMode`

### RPC Inputs

- `GitStatusInput` -- cwd
- `GitWorkingTreeDiffInput` -- cwd
- `GitPullInput` -- cwd
- `GitRunStackedActionInput` -- actionId, cwd, action, commitMessage, featureBranch, filePaths
- `GitListBranchesInput` -- cwd, query, cursor, limit (max 200)
- `GitCreateWorktreeInput` -- cwd, branch, newBranch, path
- `GitPullRequestRefInput` -- cwd, reference
- `GitPreparePullRequestThreadInput` -- cwd, reference, mode (local/worktree)
- `GitRemoveWorktreeInput` -- cwd, path, force
- `GitCreateBranchInput` -- cwd, branch
- `GitCheckoutInput` -- cwd, branch
- `GitInitInput` -- cwd

### RPC Results

- `GitStatusResult` -- isRepo, hasOriginRemote, isDefaultBranch, branch, hasWorkingTreeChanges, workingTree (files with insertions/deletions), hasUpstream, aheadCount, behindCount, pr (number, title, url, state)
- `GitWorkingTreeDiffResult` -- diff string
- `GitListBranchesResult` -- branches (GitBranch[]), isRepo, hasOriginRemote, nextCursor, totalCount
- `GitBranch` -- name, isRemote, remoteName, current, isDefault, worktreePath
- `GitCreateWorktreeResult` -- worktree { path, branch }
- `GitResolvePullRequestResult` -- pullRequest { number, title, url, baseBranch, headBranch, state }
- `GitPreparePullRequestThreadResult` -- pullRequest, branch, worktreePath
- `GitRunStackedActionResult` -- action, branch step, commit step, push step, pr step, toast
- `GitPullResult` -- status (pulled/skipped_up_to_date), branch, upstreamBranch
- `GitRunStackedActionToast` -- title, description, cta (none/open_pr/run_action)

### Progress Events

- `GitActionProgressEvent` -- union of 7 event types: started, phase_started, hook_started, hook_output, hook_finished, finished, failed

### Error Types

- `GitCommandError` -- operation, command, cwd, detail
- `GitHubCliError` -- operation, detail
- `TextGenerationError` -- operation, detail
- `GitManagerError` -- operation, detail
- `GitManagerServiceError` -- union of all four

---

## 8. Settings and Configuration Types (`settings.ts`, `server.ts`)

### Client Settings (local-only)

- `TimestampFormat` -- `"locale" | "12-hour" | "24-hour"`
- `SidebarProjectSortOrder` -- `"updated_at" | "created_at" | "manual"`
- `SidebarThreadSortOrder` -- `"updated_at" | "created_at"`
- `ClientSettingsSchema` -- confirmThreadArchive, confirmThreadDelete, diffWordWrap, sidebarProjectSortOrder, sidebarThreadSortOrder, timestampFormat

### Server Settings

- `ThreadEnvMode` -- `"local" | "worktree"`
- `ServerSettings` fields:
  - `enableAssistantStreaming` (default false)
  - `defaultThreadEnvMode` (default "local")
  - `worktreeBranchPrefix` (default "forge")
  - `textGenerationModelSelection` (default codex/gpt-5.4-mini)
  - `providers.codex` -- CodexSettings (enabled, binaryPath, homePath, customModels)
  - `providers.claudeAgent` -- ClaudeSettings (enabled, binaryPath, customModels)
  - `observability` -- ObservabilitySettings (otlpTracesUrl, otlpMetricsUrl)
  - `notifications` -- NotificationSettings (sessionNeedsAttention, sessionCompleted, deliberationConcluded)
  - `appearance` -- AppearanceSettings (version, typography, light theme, dark theme)

### Appearance Theming System

Deeply nested theme configuration:
- `AppearanceTypographySettings` -- uiFontFamily, monoFontFamily, font sizes (xs/sm/md/lg/xl), line heights, terminal font size/line height
- `AppearanceThemeSettings` -- ui, workbench, sidebar, diff, terminal, feature (each theme has light + dark variants)
- `AppearanceUiSettings` -- 24 CSS color tokens (background, foreground, card, primary, secondary, muted, accent, border, input, ring, info, success, warning, destructive, etc.)
- `AppearanceWorkbenchSettings` -- panel, panelElevated, panelActive, panelInset, listHover, listActive, listMutedBadge
- `AppearanceSidebarSettings` -- background, foreground, border, accent, accentForeground
- `AppearanceDiffSettings` -- context, hover, separator, addition, additionEmphasis, deletion, deletionEmphasis
- `AppearanceTerminalSettings` -- background, foreground, cursor, selectionBackground, scrollbar colors, ansi (16 ANSI colors)
- `AppearanceFeatureSettings` -- providerClaude, discussion colors, phase type colors, phase status colors, rolePalette

### Server Configuration (`server.ts`)

- `ServerConfigIssue` -- union of keybindings/appearance malformed/invalid issues
- `ServerProviderState` -- `"ready" | "warning" | "error" | "disabled"`
- `ServerProviderAuthStatus` -- `"authenticated" | "unauthenticated" | "unknown"`
- `ServerProviderAuth` -- status, type, label
- `ServerProviderModel` -- slug, name, isCustom, capabilities
- `ServerProvider` -- provider, enabled, installed, version, status, auth, checkedAt, message, models
- `ServerConfig` -- cwd, keybindingsConfigPath, settingsPath, keybindings, issues, providers, availableEditors, observability, settings
- `ServerObservability` -- logsDirectoryPath, localTracingEnabled, otlp trace/metrics URLs and enabled flags

**Server lifecycle:**
- `ServerLifecycleWelcomePayload` -- cwd, projectName, daemonVersion, protocolVersion, bootstrapProjectId, bootstrapThreadId
- `FORGE_DAEMON_LIFECYCLE_PROTOCOL_VERSION` = 1
- `ServerLifecycleStreamEvent` -- union of welcome + ready events
- `ServerConfigStreamEvent` -- union of snapshot, keybindingsUpdated, providerStatuses, settingsUpdated, rateLimitsUpdated

**Rate limiting:**
- `RateLimitWindow` -- usedPercent, windowDurationMins, resetsAt
- `RateLimitEntry` -- limitId, limitName, primary window, secondary window
- `RateLimitsSnapshot` -- provider, updatedAt, limits

---

## 9. IPC Bridge Contract (`ipc.ts`)

### DesktopBridge (renderer -> main process)

Exposed via `contextBridge.exposeInMainWorld("desktopBridge", ...)`:

```typescript
interface DesktopBridge {
  getWsUrl(): string | null;
  pickFolder(): Promise<string | null>;
  confirm(message: string): Promise<boolean>;
  setTheme(theme: DesktopTheme): Promise<void>;
  showContextMenu(items, position?): Promise<T | null>;
  openExternal(url: string): Promise<boolean>;
  onMenuAction(listener): () => void;
  getUpdateState(): Promise<DesktopUpdateState>;
  checkForUpdate(): Promise<DesktopUpdateCheckResult>;
  downloadUpdate(): Promise<DesktopUpdateActionResult>;
  installUpdate(): Promise<DesktopUpdateActionResult>;
  onUpdateState(listener): () => void;
  getConnectionConfig(): Promise<ConnectionConfig | null>;
  testConnection(wsUrl: string): Promise<ConnectionTestResult>;
  saveConnection(config: ConnectionConfig): Promise<void>;
  clearConnection(): Promise<void>;
  getWslDistros(): Promise<WslDistroInfo[]>;
  checkWslForge(distro: string): Promise<WslForgeCheckResult>;
  openInEditor(target: string, editor: EditorId): Promise<boolean>;
  getAvailableEditors(): Promise<EditorId[] | null>;
}
```

### NativeApi (WebSocket server -> renderer)

```typescript
interface NativeApi {
  dialogs: { pickFolder, confirm }
  terminal: { open, write, resize, clear, restart, close, onEvent }
  projects: { searchEntries, writeFile }
  shell: { openInEditor, openExternal }
  git: { listBranches, createWorktree, removeWorktree, createBranch, checkout, init,
         resolvePullRequest, preparePullRequestThread, pull, status, getWorkingTreeDiff }
  contextMenu: { show }
  server: { getConfig, refreshProviders, upsertKeybinding, getSettings, updateSettings }
  orchestration: { getSnapshot, dispatchCommand, getTurnDiff, getFullThreadDiff,
                   getCommandOutput, getSubagentActivityFeed, getTurnAgentDiff,
                   getFullThreadAgentDiff, replayEvents, onDomainEvent }
}
```

### IPC Types

- `ContextMenuItem<T>` -- id, label, destructive, disabled
- `DesktopUpdateStatus` -- `"disabled" | "idle" | "checking" | "up-to-date" | "available" | "downloading" | "downloaded" | "error"`
- `DesktopRuntimeArch` -- `"arm64" | "x64" | "other"`
- `DesktopTheme` -- `"light" | "dark" | "system"`
- `DesktopRuntimeInfo` -- hostArch, appArch, runningUnderArm64Translation
- `DesktopUpdateState` -- enabled, status, currentVersion, arch info, availableVersion, downloadedVersion, downloadPercent, checkedAt, message, errorContext, canRetry
- `DesktopUpdateActionResult` -- accepted, completed, state
- `DesktopUpdateCheckResult` -- checked, state
- `WslDistroInfo` -- name, isDefault, state, version
- `WslForgeCheckResult` -- path or error
- `ConnectionConfig` -- mode (local/wsl/external), WSL fields, external fields
- `ConnectionTestResult` -- success, error

### Interactive Request Types (`interactiveRequest.ts`)

- `InteractiveRequestType` -- `"approval" | "user-input" | "permission" | "mcp-elicitation" | "gate" | "bootstrap-failed" | "correction-needed" | "design-option"`
- `InteractiveRequestStatus` -- `"pending" | "resolved" | "stale"`

**Request payloads (8 types):**
- `ApprovalRequestPayload` -- requestType, detail, toolName, toolInput, suggestions
- `UserInputRequestPayload` -- questions with options (single/multi select)
- `PermissionRequestPayload` -- reason, permissions (network + filesystem)
- `McpElicitationRequestPayload` -- form mode (serverName, message, schema, questions) or url mode
- `GateRequestPayload` -- gateType, phaseRunId, phaseOutput, qualityCheckResults
- `BootstrapFailedRequestPayload` -- error, stdout, command
- `CorrectionNeededRequestPayload` -- reason, context
- `DesignOptionRequestPayload` -- prompt, options with artifact references

**Resolution payloads (8 types):**
- `ApprovalRequestResolution` -- decision, updatedPermissions
- `UserInputRequestResolution` -- answers map
- `PermissionRequestResolution` -- scope (turn/session), permissions
- `McpElicitationRequestResolution` -- action (accept/decline/cancel), content, meta
- `GateRequestResolution` -- decision (approve/reject), correction
- `BootstrapFailedRequestResolution` -- action (retry/skip/fail)
- `CorrectionNeededRequestResolution` -- correction string
- `DesignOptionRequestResolution` -- chosenOptionId

**Permission types:**
- `AdditionalFileSystemPermissions` -- read paths, write paths
- `AdditionalNetworkPermissions` -- enabled flag
- `RequestPermissionProfile` / `GrantedPermissionProfile` -- network + fileSystem
- `PermissionGrantScope` -- `"turn" | "session"`

---

## 10. Desktop Shell Architecture (apps/desktop/src/)

### Main Process (`main.ts`)

**Initialization:**
- Sets up `RotatingFileSink` for packaged logging (max 10MB, 10 files)
- Installs stdout/stderr capture for packaged builds
- Registers custom `forge://` protocol scheme with standard/secure/fetch/CORS privileges
- Single instance lock via `requestSingleInstanceOrQuit`
- Linux: sets WM_CLASS, desktop entry name
- macOS: resolves destructive menu icons from named images

**IPC Channel Constants (22 channels):**
`desktop:pick-folder`, `desktop:confirm`, `desktop:set-theme`, `desktop:context-menu`, `desktop:open-external`, `desktop:menu-action`, `desktop:update-state`, `desktop:update-get-state`, `desktop:update-download`, `desktop:update-install`, `desktop:update-check`, `desktop:get-ws-url`, `desktop:wsl-distros`, `desktop:wsl-check-forge`, `desktop:connection-config`, `desktop:connection-test`, `desktop:connection-save`, `desktop:connection-clear`, `desktop:open-in-editor`, `desktop:available-editors`

**Connection modes:** local daemon, WSL, external server

**State management:**
- `mainWindow` -- single BrowserWindow instance
- `backendWsUrl` -- active WebSocket URL
- `isQuitting` -- quit flag
- `daemonStatus` -- "running" | "starting" | "error"
- `connectionMode` -- "local" | "wsl" | "external"
- `updateState` -- DesktopUpdateState (reducer pattern)

**Window URL resolution:**
- Dev mode: Vite dev server URL
- Production: `forge://app/index.html` via custom protocol handler
- Serves static files from `apps/server/dist/client` or `apps/web/dist`

### Preload Bridge (`preload.ts`)

Implements `DesktopBridge` interface via `contextBridge.exposeInMainWorld("desktopBridge", ...)`.
All 22 IPC channels are wired to `ipcRenderer.invoke` or `ipcRenderer.sendSync`.

### Connection Config (`connectionConfig.ts`)

- `resolveConnectionMode(env, userDataPath)` -- priority: FORGE_WS_URL env -> connection.json -> win32 defaults to WSL -> local
- `readConnectionConfig` / `writeConnectionConfig` / `clearConnectionConfig` -- JSON persistence in user data
- `validateWsUrl(rawUrl)` -- ws:// or wss://, valid host, port or pathname
- `probeServerHealth(host, port, timeout, useHttps)` -- HTTP GET /health
- `generateAuthToken()` -- 32 random bytes -> 64 hex chars

### Daemon Lifecycle (`daemonLifecycle.ts`)

**Core functions:**
- `pingDaemon(socketPath, timeout)` -- JSON-RPC ping via Unix socket with trust verification
- `stopDaemon(socketPath)` -- JSON-RPC stop command, polls until socket goes away
- `stopDesktopDaemon(input)` -- graceful stop -> read manifest -> kill process
- `ensureDaemonConnection(input)` -- find existing daemon or spawn new one, poll until ready
- `launchDetachedDaemon(plan)` -- spawn detached child process
- `buildDetachedDaemonLaunchPlan` -- sets up `node <entry> --mode daemon --no-browser --base-dir <dir>` with `ELECTRON_RUN_AS_NODE=1`
- `buildWslDaemonLaunchPlan` -- `wsl.exe -d <distro> -- forge --mode web --host 0.0.0.0 --no-browser --base-dir <dir> --port <port> --auth-token <token>`

**Protocol URL handling:**
- `extractProtocolUrlFromArgv` -- finds `forge://` URLs in process.argv
- `parseSessionProtocolUrl` -- parses `forge://session/<threadId>`
- `buildDesktopWindowUrl` -- builds app URL with optional thread hash fragment

**Lifecycle helpers:**
- `requestSingleInstanceOrQuit`, `registerProtocolClient`, `isDesktopUiReady`, `handleDesktopBeforeQuit`

### Daemon State (`daemonState.ts`)

- `resolveDesktopBaseDir` -- `FORGE_HOME` env or `~/.forge`
- `resolveDesktopDaemonPaths` -- `{baseDir}/forge.sock`, `{baseDir}/daemon.json`
- `resolveDesktopStateDir` -- dev mode adds `/dev` suffix
- `buildDaemonWsUrl(info)` -- `ws://127.0.0.1:{port}/?token={token}`
- `createDesktopWsUrlResolver` -- cached WS URL resolver with async prime/poll

### Daemon Launch (`daemonLaunch.ts`)

- `resolveDesktopBackendLaunchSpec` -- dev: `bun apps/server/src/bin.ts`, prod: `node apps/server/dist/bin.mjs`

### Daemon Env (`daemonEnv.ts`)

- `resolveDaemonProcessEnv` -- strips FORGE_PORT, FORGE_AUTH_TOKEN, FORGE_MODE, FORGE_NO_BROWSER, FORGE_HOST; preserves FORGE_DEBUG from initial env

### Auto-Update System (`updateMachine.ts`, `updateState.ts`)

**State machine reducers (pure functions):**
- `createInitialDesktopUpdateState` -- disabled by default
- `reduceDesktopUpdateStateOnCheckStart`, `...OnCheckFailure`, `...OnUpdateAvailable`, `...OnNoUpdate`
- `reduceDesktopUpdateStateOnDownloadStart`, `...OnDownloadProgress`, `...OnDownloadFailure`, `...OnDownloadComplete`
- `reduceDesktopUpdateStateOnInstallFailure`

**Helpers:**
- `shouldBroadcastDownloadProgress` -- throttles to 10% steps
- `nextStatusAfterDownloadFailure` -- falls back to "available" if version known
- `getAutoUpdateDisabledReason` -- checks dev/packaged/platform/env

**Update constants:** startup delay 15s, poll interval 4 hours, channel "latest", no prereleases

### WSL Integration (`wsl.ts`)

- `isWslAvailable()` -- checks for wsl.exe on win32
- `parseDistroOutput(decoded)` -- parses `wsl -l -v` UTF-16LE output
- `listDistros()` -- returns WslDistro[] (name, isDefault, state, version)
- `resolveWslHome(distro)` -- runs `bash -lc 'echo $HOME'` in distro
- `checkWslForgeBinary(distro)` -- checks `command -v forge` then validates `forge --help`
- `toWslUncPath(distro, linuxPath)` -- `/home/user/.forge` -> `\\wsl.localhost\Ubuntu\home\user\.forge`
- `windowsToWslPath(windowsPath, distro)` -- handles UNC paths and drive letters

### Editor Launch (`editorLaunch.ts`)

- `isWindowsCommandAvailable(command, env)` -- scans PATH with PATHEXT resolution
- `resolveWslEditorLaunch(distro, target, editorId)` -- resolves command+args for WSL path translation
- `getWindowsAvailableEditors(env)` -- scans for all known editor commands

### Runtime Architecture (`runtimeArch.ts`)

- `resolveDesktopRuntimeInfo` -- determines host vs app architecture, arm64 translation detection
- `isArm64HostRunningIntelBuild` -- detects Rosetta/arm64 translation

### Other Desktop Modules

- `confirmDialog.ts` -- native Electron confirm dialog (Yes/No)
- `syncShellEnvironment.ts` -- reads PATH and SSH_AUTH_SOCK from login shell on macOS/Linux

---

## 11. Shared Utilities (packages/shared/src/)

### Model Helpers (`model.ts`)

- `hasEffortLevel`, `getDefaultEffort`, `resolveEffort` -- effort level resolution against capabilities
- `hasContextWindowOption`, `getDefaultContextWindow`, `resolveContextWindow` -- context window resolution
- `normalizeCodexModelOptionsWithCapabilities`, `normalizeClaudeModelOptionsWithCapabilities` -- normalize options against capabilities
- `isClaudeUltrathinkPrompt` -- detects "ultrathink" in text
- `normalizeModelSlug(model, provider)` -- resolves aliases to canonical slugs
- `resolveSelectableModel` -- resolves user input against available model options
- `resolveModelSlug`, `resolveModelSlugForProvider` -- resolves to default if null/empty
- `resolveApiModelId(modelSelection)` -- appends context window suffix for Claude (e.g., `[1m]`)
- `applyClaudePromptEffortPrefix` -- prepends "Ultrathink:" for ultrathink effort
- `trimOrNull` -- trims string, returns null for empty

### Daemon Helpers (`daemon.ts`)

- `ForgeDaemonManifest` -- pid, wsPort, wsToken, socketPath, startedAt
- `OWNER_ONLY_FILE_MODE` = 0o600
- `parseDaemonManifest(value)` -- validates and parses raw JSON to manifest
- `isTrustedDaemonManifest` -- checks socket path match and file permissions
- `isTrustedDaemonSocketStat` -- verifies socket type and permissions
- `readTrustedDaemonManifest` / `readTrustedDaemonManifestSync` -- reads and validates daemon.json with symlink protection (O_NOFOLLOW)
- `readTrustedDaemonSocketStat` -- lstat-based socket verification
- `stripInheritedDaemonRuntimeEnv` -- removes FORGE_AUTH_TOKEN, FORGE_BOOTSTRAP_FD, FORGE_HOST, FORGE_MODE, FORGE_NO_BROWSER, FORGE_PORT
- `isForgeDaemonWsToken` -- validates 64 hex char token pattern
- `hasOwnerOnlyFileMode`, `hasExpectedDaemonSocketPath`, `shouldRequireOwnerOnlyPermissions`

### Logging (`logging.ts`)

- `RotatingFileSink` -- file-based rotating log sink
  - Constructor: filePath, maxBytes, maxFiles, throwOnError
  - `write(chunk)` -- auto-rotates when size exceeded
  - Rotation: renames chain (N -> N+1), prunes overflow backups

### Git Utilities (`git.ts`)

- `FORGE_WORKTREE_BRANCH_PREFIX` = "forge"
- `buildForgePrefixedBranchName` -- creates `forge/<fragment>` branches
- `isForgeTemporaryWorktreeBranch` -- matches `forge/<8-hex-chars>` pattern
- `sanitizeBranchFragment` -- normalizes to lowercase, strips special chars, caps at 64 chars
- `sanitizeFeatureBranchName` -- ensures `feature/` prefix
- `resolveAutoFeatureBranchName` -- finds unique feature branch name
- `deriveLocalBranchNameFromRemoteRef` -- strips leading remote name
- `dedupeRemoteBranchesWithLocalMatches` -- filters redundant origin/* refs

### Shell Utilities (`shell.ts`)

- `resolveLoginShell(platform, shell)` -- defaults to /bin/zsh (macOS) or /bin/bash (Linux)
- `readPathFromLoginShell` / `readEnvironmentFromLoginShell` -- captures env vars from login shell via marker-delimited output
- `extractPathFromShellOutput` -- parses captured PATH from shell output

### Server Settings (`serverSettings.ts`)

- `normalizePersistedServerSettingString` -- trims to undefined for empty
- `extractPersistedServerObservabilitySettings` -- extracts OTLP URLs
- `parsePersistedServerObservabilitySettings` -- parses from lenient JSON

### Networking (`Net.ts`)

- `NetService` (Effect Service) -- canListenOnHost, isPortAvailableOnLoopback, reserveLoopbackPort, findAvailablePort
- `NetError` -- tagged error for port operations

### Thread Workspace (`threadWorkspace.ts`)

- `resolveThreadSpawnMode` -- determines "local" or "worktree" from thread state
- `resolveThreadSpawnWorkspace` -- resolves effective branch/worktree path

### Worker Patterns

- `DrainableWorker<A>` -- queue-based worker with `drain()` for deterministic testing
- `KeyedCoalescingWorker<K,V>` -- keyed worker that coalesces pending updates per key

### Other Utilities

- `Struct.ts` -- `DeepPartial<T>` type + `deepMerge` for nested object patching
- `String.ts` -- `truncate(text, maxLength)` with ellipsis
- `narrowing.ts` -- `asRecord`, `asString`, `asTrimmedString`, `asFiniteNumber`, `asArray`, `asBoolean`, `truncateDetail`
- `debug.ts` -- `parseDebugTopics`, `isDebugTopicEnabled` (supports `FORGE_DEBUG=all` or comma/space-separated topics)
- `schemaJson.ts` -- `fromLenientJson` (tolerates trailing commas and comments), `decodeJsonResult`, `formatSchemaError`

---

## 12. Project Documentation

### CLAUDE.md / AGENTS.md (identical content)

**Project identity:** "T3 Code" -- minimal web GUI for coding agents (Codex and Claude). Very early WIP.

**Core priorities:** Performance first, reliability first, predictable behavior under load/failures.

**Package roles:**
- `apps/server` -- Node.js WebSocket server, wraps Codex app-server (JSON-RPC over stdio)
- `apps/web` -- React/Vite UI
- `packages/contracts` -- schema-only, no runtime logic
- `packages/shared` -- runtime utilities, explicit subpath exports

**Codex integration:**
- Codex-first architecture
- `codex app-server` per provider session (JSON-RPC over stdio)
- Events streamed to browser via WebSocket push on `orchestration.domainEvent`
- Key files: codexAppServerManager.ts, providerManager.ts, wsServer.ts

**Task completion requirements:** `bun fmt`, `bun lint`, `bun typecheck` must all pass. Use `bun run test` (never bare `bun test`).

**Debugging:** Use `FORGE_DEBUG` env var (comma/space-separated topics or `all`).

### CONTRIBUTING.md

- Not actively accepting contributions
- Accepts: small focused bug fixes, reliability fixes, performance improvements
- Rejects: large PRs, drive-by features, opinionated rewrites
- PR trust labels: `vouch:*` status, `size:*` diff size

### REMOTE.md

**CLI/env configuration:**
- `--mode <web|desktop>` / `FORGE_MODE`
- `--port` / `FORGE_PORT`
- `--host` / `FORGE_HOST`
- `--base-dir` / `FORGE_HOME`
- `--dev-url` / `VITE_DEV_SERVER_URL`
- `--no-browser` / `FORGE_NO_BROWSER`
- `--auth-token` / `FORGE_AUTH_TOKEN`
- `--bootstrap-fd` / `FORGE_BOOTSTRAP_FD` (one-shot JSON envelope via inherited FD)

**Security:** Always set auth-token before exposing outside localhost. Prefer trusted interfaces.

### KEYBINDINGS.md

- Config path: `~/.forge/keybindings.json`
- Available commands: terminal.toggle/split/new/close, diff.toggle, chat.new/newLocal, editor.openFavorite, thread.previous/next/jump.N, script.{id}.run
- Key syntax: mod (cmd on macOS, ctrl otherwise), cmd/meta, ctrl, shift, alt
- When conditions: terminalFocus, terminalOpen, with !, &&, ||, parentheses
- Precedence: last matching rule wins

---

## Editor Definitions (`editor.ts`)

| ID               | Label              | Command          | Launch Style |
|------------------|--------------------|------------------|--------------|
| cursor           | Cursor             | cursor           | goto         |
| trae             | Trae               | trae             | goto         |
| vscode           | VS Code            | code             | goto         |
| vscode-insiders  | VS Code Insiders   | code-insiders    | goto         |
| vscodium         | VSCodium           | codium           | goto         |
| zed              | Zed                | zed              | direct-path  |
| antigravity      | Antigravity        | agy              | goto         |
| idea             | IntelliJ IDEA      | idea             | line-column  |
| file-manager     | File Manager       | (null)           | direct-path  |

- `EditorLaunchStyle` -- `"direct-path" | "goto" | "line-column"`
- `OpenInEditorInput` -- cwd, editor
- `OpenError` -- tagged error

---

## Terminal Types (`terminal.ts`)

**Input schemas:** `TerminalOpenInput` (threadId, terminalId, cwd, cols, rows, env), `TerminalWriteInput`, `TerminalResizeInput`, `TerminalClearInput`, `TerminalRestartInput`, `TerminalCloseInput`

**Session:** `TerminalSessionSnapshot` -- threadId, terminalId, cwd, status, pid, history, exitCode, exitSignal, updatedAt

**Events (7 types):** `TerminalEvent` -- started (with snapshot), output (data), exited (code/signal), error (message), cleared, restarted (with snapshot), activity (hasRunningSubprocess)

**Status:** `TerminalSessionStatus` -- `"starting" | "running" | "exited" | "error"`

**Errors:** `TerminalCwdError`, `TerminalHistoryError`, `TerminalSessionLookupError`, `TerminalNotRunningError`

**Constants:** `DEFAULT_TERMINAL_ID` = "default", cols 20-400, rows 5-200, max env 128 keys

---

## Project Types (`project.ts`)

- `ProjectSearchEntriesInput` -- cwd, query (max 256), limit (max 200)
- `ProjectEntry` -- path, kind (file/directory), parentPath
- `ProjectSearchEntriesResult` -- entries, truncated flag
- `ProjectWriteFileInput` -- cwd, relativePath (max 512), contents
- `ProjectWriteFileResult` -- relativePath
- Errors: `ProjectSearchEntriesError`, `ProjectWriteFileError`

---

## Keybinding Types (`keybindings.ts`)

- Commands: terminal.toggle/split/new/close, diff.toggle, chat.new/newLocal, editor.openFavorite, thread.previous/next/jump.1-9, script.{id}.run
- `KeybindingRule` -- key, command, optional when expression
- `KeybindingsConfig` -- array of rules (max 256)
- `KeybindingShortcut` -- key, metaKey, ctrlKey, shiftKey, altKey, modKey
- `KeybindingWhenNode` -- recursive AST: identifier, not, and, or
- `ResolvedKeybindingRule` -- command, shortcut, whenAst
- Constants: `MAX_KEYBINDING_VALUE_LENGTH` = 64, `MAX_WHEN_EXPRESSION_DEPTH` = 64, `MAX_SCRIPT_ID_LENGTH` = 24, `MAX_KEYBINDINGS_COUNT` = 256
