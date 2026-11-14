// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Each query's and mutation's two checks, loaded on first use from their checks files.

import type { SchemaCheck } from "../schema-check.js";

/** One method's request check and reply check. */
export interface MethodCheckPair<Request, Response> {
  readonly requestCheck: SchemaCheck<Request>;
  readonly responseCheck: SchemaCheck<Response>;
}

/** Each query's and mutation's checks loader, by the method's wire name. */
export const METHOD_CHECK_LOADERS = {
  "account.delete": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "account.export": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./account.js").AccountExportResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateAccountExportResponse: responseCheck } = await import("./checks/account.js");
    return { requestCheck, responseCheck };
  },
  "agent.callbackTool.list": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./callback-tool.js").AgentCallbackToolListResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateAgentCallbackToolListResponse: responseCheck } =
      await import("./checks/callback-tool.js");
    return { requestCheck, responseCheck };
  },
  "agent.childRun.interrupt": async (): Promise<
    MethodCheckPair<
      import("./run/children.js").AgentChildRunInterruptRequest,
      import("./run/children.js").AgentChildRunInterruptResponse
    >
  > => {
    const { validateAgentChildRunInterruptRequest: requestCheck } =
      await import("./checks/run/children.js");
    const { validateAgentChildRunInterruptResponse: responseCheck } =
      await import("./checks/run/children.js");
    return { requestCheck, responseCheck };
  },
  "agent.childRun.paused.update": async (): Promise<
    MethodCheckPair<
      import("./run/children.js").AgentChildRunPausedUpdateRequest,
      import("./run/children.js").AgentChildRunPausedUpdateResponse
    >
  > => {
    const { validateAgentChildRunPausedUpdateRequest: requestCheck } =
      await import("./checks/run/children.js");
    const { validateAgentChildRunPausedUpdateResponse: responseCheck } =
      await import("./checks/run/children.js");
    return { requestCheck, responseCheck };
  },
  "agent.childRun.steer": async (): Promise<
    MethodCheckPair<
      import("./run/children.js").AgentChildRunSteerRequest,
      import("./run/queue.js").AgentQueueItemCreateResponse
    >
  > => {
    const { validateAgentChildRunSteerRequest: requestCheck } =
      await import("./checks/run/children.js");
    const { validateAgentQueueItemCreateResponse: responseCheck } =
      await import("./checks/run/queue.js");
    return { requestCheck, responseCheck };
  },
  "agent.childRun.stopAll": async (): Promise<
    MethodCheckPair<
      import("./run/children.js").AgentChildRunStopAllRequest,
      import("./run/children.js").AgentChildRunStopAllResponse
    >
  > => {
    const { validateAgentChildRunStopAllRequest: requestCheck } =
      await import("./checks/run/children.js");
    const { validateAgentChildRunStopAllResponse: responseCheck } =
      await import("./checks/run/children.js");
    return { requestCheck, responseCheck };
  },
  "agent.childRunLink.list": async (): Promise<
    MethodCheckPair<
      import("./orchestration.js").AgentChildRunLinkListRequest,
      import("./orchestration.js").AgentChildRunLinkListResponse
    >
  > => {
    const { validateAgentChildRunLinkListRequest: requestCheck } =
      await import("./checks/orchestration.js");
    const { validateAgentChildRunLinkListResponse: responseCheck } =
      await import("./checks/orchestration.js");
    return { requestCheck, responseCheck };
  },
  "agent.command.background": async (): Promise<
    MethodCheckPair<
      import("./command.js").AgentCommandBackgroundRequest,
      import("./command.js").AgentCommandBackgroundResponse
    >
  > => {
    const { validateAgentCommandBackgroundRequest: requestCheck } =
      await import("./checks/command.js");
    const { validateAgentCommandBackgroundResponse: responseCheck } =
      await import("./checks/command.js");
    return { requestCheck, responseCheck };
  },
  "agent.command.stop": async (): Promise<
    MethodCheckPair<
      import("./command.js").AgentCommandStopRequest,
      import("./command.js").AgentCommandStopResponse
    >
  > => {
    const { validateAgentCommandStopRequest: requestCheck } = await import("./checks/command.js");
    const { validateAgentCommandStopResponse: responseCheck } = await import("./checks/command.js");
    return { requestCheck, responseCheck };
  },
  "agent.command.write": async (): Promise<
    MethodCheckPair<
      import("./command.js").AgentCommandWriteRequest,
      import("./method-descriptor.js").NullPayload
    >
  > => {
    const { validateAgentCommandWriteRequest: requestCheck } = await import("./checks/command.js");
    const { validateNullPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "agent.config.update": async (): Promise<
    MethodCheckPair<
      import("./agent/methods.js").AgentConfigUpdateRequest,
      import("./agent/methods.js").AgentConfigUpdateResponse
    >
  > => {
    const { validateAgentConfigUpdateRequest: requestCheck } =
      await import("./checks/agent/methods.js");
    const { validateAgentConfigUpdateResponse: responseCheck } =
      await import("./checks/agent/methods.js");
    return { requestCheck, responseCheck };
  },
  "agent.definition.create": async (): Promise<
    MethodCheckPair<
      import("./agent/definition.js").AgentDefinitionCreateRequest,
      import("./agent/definition.js").AgentDefinitionCreateResponse
    >
  > => {
    const { validateAgentDefinitionCreateRequest: requestCheck } =
      await import("./checks/agent/definition.js");
    const { validateAgentDefinitionCreateResponse: responseCheck } =
      await import("./checks/agent/definition.js");
    return { requestCheck, responseCheck };
  },
  "agent.definition.delete": async (): Promise<
    MethodCheckPair<
      import("./agent/definition.js").AgentDefinitionDeleteRequest,
      import("./agent/definition.js").AgentDefinitionDeleteResponse
    >
  > => {
    const { validateAgentDefinitionDeleteRequest: requestCheck } =
      await import("./checks/agent/definition.js");
    const { validateAgentDefinitionDeleteResponse: responseCheck } =
      await import("./checks/agent/definition.js");
    return { requestCheck, responseCheck };
  },
  "agent.definition.export": async (): Promise<
    MethodCheckPair<
      import("./agent/definition.js").AgentDefinitionExportRequest,
      import("./agent/definition.js").AgentDefinitionExportResponse
    >
  > => {
    const { validateAgentDefinitionExportRequest: requestCheck } =
      await import("./checks/agent/definition.js");
    const { validateAgentDefinitionExportResponse: responseCheck } =
      await import("./checks/agent/definition.js");
    return { requestCheck, responseCheck };
  },
  "agent.definition.import": async (): Promise<
    MethodCheckPair<
      import("./agent/definition.js").AgentDefinitionImportRequest,
      import("./agent/definition.js").AgentDefinitionImportResponse
    >
  > => {
    const { validateAgentDefinitionImportRequest: requestCheck } =
      await import("./checks/agent/definition.js");
    const { validateAgentDefinitionImportResponse: responseCheck } =
      await import("./checks/agent/definition.js");
    return { requestCheck, responseCheck };
  },
  "agent.definition.list": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./agent/definition.js").AgentDefinitionListResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateAgentDefinitionListResponse: responseCheck } =
      await import("./checks/agent/definition.js");
    return { requestCheck, responseCheck };
  },
  "agent.definition.update": async (): Promise<
    MethodCheckPair<
      import("./agent/definition.js").AgentDefinitionUpdateRequest,
      import("./agent/definition.js").AgentDefinitionUpdateResponse
    >
  > => {
    const { validateAgentDefinitionUpdateRequest: requestCheck } =
      await import("./checks/agent/definition.js");
    const { validateAgentDefinitionUpdateResponse: responseCheck } =
      await import("./checks/agent/definition.js");
    return { requestCheck, responseCheck };
  },
  "agent.queueItem.cancel": async (): Promise<
    MethodCheckPair<
      import("./run/queue.js").AgentQueueItemCancelRequest,
      import("./run/queue.js").AgentQueueItemCancelResponse
    >
  > => {
    const { validateAgentQueueItemCancelRequest: requestCheck } =
      await import("./checks/run/queue.js");
    const { validateAgentQueueItemCancelResponse: responseCheck } =
      await import("./checks/run/queue.js");
    return { requestCheck, responseCheck };
  },
  "agent.queueItem.create": async (): Promise<
    MethodCheckPair<
      import("./run/queue.js").AgentQueueItemCreateRequest,
      import("./run/queue.js").AgentQueueItemCreateResponse
    >
  > => {
    const { validateAgentQueueItemCreateRequest: requestCheck } =
      await import("./checks/run/queue.js");
    const { validateAgentQueueItemCreateResponse: responseCheck } =
      await import("./checks/run/queue.js");
    return { requestCheck, responseCheck };
  },
  "agent.queueItem.list": async (): Promise<
    MethodCheckPair<
      import("./run/queue.js").AgentQueueItemListRequest,
      import("./run/queue.js").AgentQueueItemListResponse
    >
  > => {
    const { validateAgentQueueItemListRequest: requestCheck } =
      await import("./checks/run/queue.js");
    const { validateAgentQueueItemListResponse: responseCheck } =
      await import("./checks/run/queue.js");
    return { requestCheck, responseCheck };
  },
  "agent.queueItem.reorder": async (): Promise<
    MethodCheckPair<
      import("./run/queue.js").AgentQueueItemReorderRequest,
      import("./run/queue.js").AgentQueueItemListResponse
    >
  > => {
    const { validateAgentQueueItemReorderRequest: requestCheck } =
      await import("./checks/run/queue.js");
    const { validateAgentQueueItemListResponse: responseCheck } =
      await import("./checks/run/queue.js");
    return { requestCheck, responseCheck };
  },
  "agent.run.context.compact": async (): Promise<
    MethodCheckPair<
      import("./provider/driver/methods.js").AgentRunContextCompactRequest,
      import("./provider/driver/compaction.js").AgentRunContextCompactResponse
    >
  > => {
    const { validateAgentRunContextCompactRequest: requestCheck } =
      await import("./checks/provider/driver/methods.js");
    const { validateAgentRunContextCompactResponse: responseCheck } =
      await import("./checks/provider/driver/compaction.js");
    return { requestCheck, responseCheck };
  },
  "agent.run.create": async (): Promise<
    MethodCheckPair<
      import("./orchestration.js").AgentRunCreateRequest,
      import("./orchestration.js").AgentRunCreateResponse
    >
  > => {
    const { validateAgentRunCreateRequest: requestCheck } =
      await import("./checks/orchestration.js");
    const { validateAgentRunCreateResponse: responseCheck } =
      await import("./checks/orchestration.js");
    return { requestCheck, responseCheck };
  },
  "agent.run.intervene": async (): Promise<
    MethodCheckPair<
      import("./run/intervention.js").AgentRunInterveneRequest,
      import("./run/intervention.js").AgentRunInterveneResponse
    >
  > => {
    const { validateAgentRunInterveneRequest: requestCheck } =
      await import("./checks/run/intervention.js");
    const { validateAgentRunInterveneResponse: responseCheck } =
      await import("./checks/run/intervention.js");
    return { requestCheck, responseCheck };
  },
  "agent.run.pause": async (): Promise<
    MethodCheckPair<
      import("./run/control.js").AgentRunPauseRequest,
      import("./run/control.js").AgentRunControlResponse
    >
  > => {
    const { validateAgentRunPauseRequest: requestCheck } = await import("./checks/run/control.js");
    const { validateAgentRunControlResponse: responseCheck } =
      await import("./checks/run/control.js");
    return { requestCheck, responseCheck };
  },
  "agent.run.recovery.resolve": async (): Promise<
    MethodCheckPair<
      import("./run/control.js").AgentRunRecoveryResolveRequest,
      import("./run/control.js").AgentRunControlResponse
    >
  > => {
    const { validateAgentRunRecoveryResolveRequest: requestCheck } =
      await import("./checks/run/control.js");
    const { validateAgentRunControlResponse: responseCheck } =
      await import("./checks/run/control.js");
    return { requestCheck, responseCheck };
  },
  "agent.run.refusalChoice.resolve": async (): Promise<
    MethodCheckPair<
      import("./run/provider-choice.js").AgentRunRefusalChoiceResolveRequest,
      import("./run/control.js").AgentRunControlResponse
    >
  > => {
    const { validateAgentRunRefusalChoiceResolveRequest: requestCheck } =
      await import("./checks/run/provider-choice.js");
    const { validateAgentRunControlResponse: responseCheck } =
      await import("./checks/run/control.js");
    return { requestCheck, responseCheck };
  },
  "agent.run.resume": async (): Promise<
    MethodCheckPair<
      import("./run/control.js").AgentRunResumeRequest,
      import("./run/control.js").AgentRunControlResponse
    >
  > => {
    const { validateAgentRunResumeRequest: requestCheck } = await import("./checks/run/control.js");
    const { validateAgentRunControlResponse: responseCheck } =
      await import("./checks/run/control.js");
    return { requestCheck, responseCheck };
  },
  "agent.run.usageCreditsChoice.resolve": async (): Promise<
    MethodCheckPair<
      import("./run/provider-choice.js").AgentRunUsageCreditsChoiceResolveRequest,
      import("./run/control.js").AgentRunControlResponse
    >
  > => {
    const { validateAgentRunUsageCreditsChoiceResolveRequest: requestCheck } =
      await import("./checks/run/provider-choice.js");
    const { validateAgentRunControlResponse: responseCheck } =
      await import("./checks/run/control.js");
    return { requestCheck, responseCheck };
  },
  "approval.denial.override": async (): Promise<
    MethodCheckPair<
      import("./approval.js").ApprovalDenialOverrideRequest,
      import("./approval.js").ApprovalDenialOverrideResponse
    >
  > => {
    const { validateApprovalDenialOverrideRequest: requestCheck } =
      await import("./checks/approval.js");
    const { validateApprovalDenialOverrideResponse: responseCheck } =
      await import("./checks/approval.js");
    return { requestCheck, responseCheck };
  },
  "approval.list": async (): Promise<
    MethodCheckPair<
      import("./approval.js").ApprovalListRequest,
      import("./approval.js").ApprovalListResponse
    >
  > => {
    const { validateApprovalListRequest: requestCheck } = await import("./checks/approval.js");
    const { validateApprovalListResponse: responseCheck } = await import("./checks/approval.js");
    return { requestCheck, responseCheck };
  },
  "approval.resolve": async (): Promise<
    MethodCheckPair<
      import("./approval.js").ApprovalResolveRequest,
      import("./approval.js").ApprovalResolveResponse
    >
  > => {
    const { validateApprovalResolveRequest: requestCheck } = await import("./checks/approval.js");
    const { validateApprovalResolveResponse: responseCheck } = await import("./checks/approval.js");
    return { requestCheck, responseCheck };
  },
  "approval.rule.list": async (): Promise<
    MethodCheckPair<
      import("./approval.js").ApprovalRuleListRequest,
      import("./approval.js").ApprovalRuleListResponse
    >
  > => {
    const { validateApprovalRuleListRequest: requestCheck } = await import("./checks/approval.js");
    const { validateApprovalRuleListResponse: responseCheck } =
      await import("./checks/approval.js");
    return { requestCheck, responseCheck };
  },
  "approval.rule.revoke": async (): Promise<
    MethodCheckPair<
      import("./approval.js").ApprovalRuleRevokeRequest,
      import("./approval.js").ApprovalRuleRevokeResponse
    >
  > => {
    const { validateApprovalRuleRevokeRequest: requestCheck } =
      await import("./checks/approval.js");
    const { validateApprovalRuleRevokeResponse: responseCheck } =
      await import("./checks/approval.js");
    return { requestCheck, responseCheck };
  },
  "artifact.ingest.complete": async (): Promise<
    MethodCheckPair<
      import("./artifacts/ingest.js").ArtifactIngestCompleteRequest,
      import("./artifacts/ingest.js").ArtifactIngestCompleteResponse
    >
  > => {
    const { validateArtifactIngestCompleteRequest: requestCheck } =
      await import("./checks/artifacts/ingest.js");
    const { validateArtifactIngestCompleteResponse: responseCheck } =
      await import("./checks/artifacts/ingest.js");
    return { requestCheck, responseCheck };
  },
  "artifact.ingest.start": async (): Promise<
    MethodCheckPair<
      import("./artifacts/ingest.js").ArtifactIngestStartRequest,
      import("./artifacts/ingest.js").ArtifactIngestStartResponse
    >
  > => {
    const { validateArtifactIngestStartRequest: requestCheck } =
      await import("./checks/artifacts/ingest.js");
    const { validateArtifactIngestStartResponse: responseCheck } =
      await import("./checks/artifacts/ingest.js");
    return { requestCheck, responseCheck };
  },
  "artifact.ingest.write": async (): Promise<
    MethodCheckPair<
      import("./artifacts/ingest.js").ArtifactIngestWriteRequest,
      import("./artifacts/ingest.js").ArtifactIngestWriteResponse
    >
  > => {
    const { validateArtifactIngestWriteRequest: requestCheck } =
      await import("./checks/artifacts/ingest.js");
    const { validateArtifactIngestWriteResponse: responseCheck } =
      await import("./checks/artifacts/ingest.js");
    return { requestCheck, responseCheck };
  },
  "artifact.list": async (): Promise<
    MethodCheckPair<
      import("./artifacts/operations.js").ArtifactListRequest,
      import("./artifacts/operations.js").ArtifactListResponse
    >
  > => {
    const { validateArtifactListRequest: requestCheck } =
      await import("./checks/artifacts/operations.js");
    const { validateArtifactListResponse: responseCheck } =
      await import("./checks/artifacts/operations.js");
    return { requestCheck, responseCheck };
  },
  "artifact.publish": async (): Promise<
    MethodCheckPair<
      import("./artifacts/publication.js").ArtifactPublishRequest,
      import("./artifacts/publication.js").ArtifactPublishResponse
    >
  > => {
    const { validateArtifactPublishRequest: requestCheck } =
      await import("./checks/artifacts/publication.js");
    const { validateArtifactPublishResponse: responseCheck } =
      await import("./checks/artifacts/publication.js");
    return { requestCheck, responseCheck };
  },
  "artifact.read": async (): Promise<
    MethodCheckPair<
      import("./artifacts/operations.js").ArtifactReadRequest,
      import("./artifacts/operations.js").ArtifactReadResponse
    >
  > => {
    const { validateArtifactReadRequest: requestCheck } =
      await import("./checks/artifacts/operations.js");
    const { validateArtifactReadResponse: responseCheck } =
      await import("./checks/artifacts/operations.js");
    return { requestCheck, responseCheck };
  },
  "attention.banner.settle": async (): Promise<
    MethodCheckPair<
      import("./attention.js").AttentionBannerSettleRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateAttentionBannerSettleRequest: requestCheck } =
      await import("./checks/attention.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "attention.delivery.list": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./attention.js").AttentionDeliveryListResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateAttentionDeliveryListResponse: responseCheck } =
      await import("./checks/attention.js");
    return { requestCheck, responseCheck };
  },
  "attention.delivery.test": async (): Promise<
    MethodCheckPair<
      import("./attention.js").AttentionDeliveryTestRequest,
      import("./attention.js").AttentionDeliveryTestResponse
    >
  > => {
    const { validateAttentionDeliveryTestRequest: requestCheck } =
      await import("./checks/attention.js");
    const { validateAttentionDeliveryTestResponse: responseCheck } =
      await import("./checks/attention.js");
    return { requestCheck, responseCheck };
  },
  "attention.mailPassword.delete": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "attention.mailPassword.update": async (): Promise<
    MethodCheckPair<
      import("./attention.js").AttentionMailPasswordUpdateRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateAttentionMailPasswordUpdateRequest: requestCheck } =
      await import("./checks/attention.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "attention.seen.update": async (): Promise<
    MethodCheckPair<
      import("./attention.js").AttentionSeenUpdateRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateAttentionSeenUpdateRequest: requestCheck } =
      await import("./checks/attention.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "attention.webAddress.delete": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "attention.webAddress.secret.rotate": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./attention.js").AttentionWebAddressSecretRotateResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateAttentionWebAddressSecretRotateResponse: responseCheck } =
      await import("./checks/attention.js");
    return { requestCheck, responseCheck };
  },
  "attention.webAddress.update": async (): Promise<
    MethodCheckPair<
      import("./attention.js").AttentionWebAddressUpdateRequest,
      import("./attention.js").AttentionWebAddressUpdateResponse
    >
  > => {
    const { validateAttentionWebAddressUpdateRequest: requestCheck } =
      await import("./checks/attention.js");
    const { validateAttentionWebAddressUpdateResponse: responseCheck } =
      await import("./checks/attention.js");
    return { requestCheck, responseCheck };
  },
  "browser.chromium.fetch": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./browser.js").BrowserChromiumFetchResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateBrowserChromiumFetchResponse: responseCheck } =
      await import("./checks/browser.js");
    return { requestCheck, responseCheck };
  },
  "browser.chromium.read": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./browser.js").BrowserChromiumReadResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateBrowserChromiumReadResponse: responseCheck } =
      await import("./checks/browser.js");
    return { requestCheck, responseCheck };
  },
  "browser.cookie.clear": async (): Promise<
    MethodCheckPair<
      import("./browser.js").BrowserSiteRequest,
      import("./browser.js").BrowserCookieClearResponse
    >
  > => {
    const { validateBrowserSiteRequest: requestCheck } = await import("./checks/browser.js");
    const { validateBrowserCookieClearResponse: responseCheck } =
      await import("./checks/browser.js");
    return { requestCheck, responseCheck };
  },
  "browser.site.signIn": async (): Promise<
    MethodCheckPair<
      import("./browser.js").BrowserSiteRequest,
      import("./browser.js").BrowserSiteSignInResponse
    >
  > => {
    const { validateBrowserSiteRequest: requestCheck } = await import("./checks/browser.js");
    const { validateBrowserSiteSignInResponse: responseCheck } =
      await import("./checks/browser.js");
    return { requestCheck, responseCheck };
  },
  "browser.siteData.clear": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./browser.js").BrowserSiteDataClearResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateBrowserSiteDataClearResponse: responseCheck } =
      await import("./checks/browser.js");
    return { requestCheck, responseCheck };
  },
  "browser.siteData.forget": async (): Promise<
    MethodCheckPair<
      import("./browser.js").BrowserSiteRequest,
      import("./browser.js").BrowserSiteDataForgetResponse
    >
  > => {
    const { validateBrowserSiteRequest: requestCheck } = await import("./checks/browser.js");
    const { validateBrowserSiteDataForgetResponse: responseCheck } =
      await import("./checks/browser.js");
    return { requestCheck, responseCheck };
  },
  "browser.siteData.list": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./browser.js").BrowserSiteDataListResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateBrowserSiteDataListResponse: responseCheck } =
      await import("./checks/browser.js");
    return { requestCheck, responseCheck };
  },
  "cloud.task.apply": async (): Promise<
    MethodCheckPair<
      import("./cloud.js").CloudTaskAttemptRequest,
      import("./cloud.js").CloudTaskApplyResponse
    >
  > => {
    const { validateCloudTaskAttemptRequest: requestCheck } = await import("./checks/cloud.js");
    const { validateCloudTaskApplyResponse: responseCheck } = await import("./checks/cloud.js");
    return { requestCheck, responseCheck };
  },
  "cloud.task.diff.read": async (): Promise<
    MethodCheckPair<
      import("./cloud.js").CloudTaskAttemptRequest,
      import("./cloud.js").CloudTaskDiffReadResponse
    >
  > => {
    const { validateCloudTaskAttemptRequest: requestCheck } = await import("./checks/cloud.js");
    const { validateCloudTaskDiffReadResponse: responseCheck } = await import("./checks/cloud.js");
    return { requestCheck, responseCheck };
  },
  "cloud.task.read": async (): Promise<
    MethodCheckPair<import("./cloud.js").CloudTaskReadRequest, import("./cloud.js").CloudWork>
  > => {
    const { validateCloudTaskReadRequest: requestCheck } = await import("./checks/cloud.js");
    const { validateCloudWork: responseCheck } = await import("./checks/cloud.js");
    return { requestCheck, responseCheck };
  },
  "cloud.task.start": async (): Promise<
    MethodCheckPair<
      import("./cloud.js").CloudTaskStartRequest,
      import("./cloud.js").CloudTaskStartResponse
    >
  > => {
    const { validateCloudTaskStartRequest: requestCheck } = await import("./checks/cloud.js");
    const { validateCloudTaskStartResponse: responseCheck } = await import("./checks/cloud.js");
    return { requestCheck, responseCheck };
  },
  "controlPlane.call": async (): Promise<
    MethodCheckPair<
      import("./device.js").ControlPlaneCallRequest,
      import("./device.js").ControlPlaneCallResponse
    >
  > => {
    const { validateControlPlaneCallRequest: requestCheck } = await import("./checks/device.js");
    const { validateControlPlaneCallResponse: responseCheck } = await import("./checks/device.js");
    return { requestCheck, responseCheck };
  },
  "daemon.appDiagnostic.record": async (): Promise<
    MethodCheckPair<
      import("./daemon/app-diagnostic.js").AppDiagnosticRecord,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateAppDiagnosticRecord: requestCheck } =
      await import("./checks/daemon/app-diagnostic.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "daemon.backup.read": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./daemon/backup.js").DaemonBackupReadResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateDaemonBackupReadResponse: responseCheck } =
      await import("./checks/daemon/backup.js");
    return { requestCheck, responseCheck };
  },
  "daemon.backup.start": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "daemon.config.read": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./daemon/config.js").DaemonConfig
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateDaemonConfig: responseCheck } = await import("./checks/daemon/config.js");
    return { requestCheck, responseCheck };
  },
  "daemon.config.update": async (): Promise<
    MethodCheckPair<
      import("./daemon/config.js").DaemonConfigUpdateRequest,
      import("./daemon/config.js").DaemonConfig
    >
  > => {
    const { validateDaemonConfigUpdateRequest: requestCheck } =
      await import("./checks/daemon/config.js");
    const { validateDaemonConfig: responseCheck } = await import("./checks/daemon/config.js");
    return { requestCheck, responseCheck };
  },
  "daemon.crashReport.list": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./daemon/status.js").DaemonCrashReportListResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateDaemonCrashReportListResponse: responseCheck } =
      await import("./checks/daemon/status.js");
    return { requestCheck, responseCheck };
  },
  "daemon.data.erase": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./daemon/data.js").DaemonDataEraseResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateDaemonDataEraseResponse: responseCheck } =
      await import("./checks/daemon/data.js");
    return { requestCheck, responseCheck };
  },
  "daemon.dataExport.cancel": async (): Promise<
    MethodCheckPair<
      import("./daemon/data.js").DaemonDataExportCancelRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateDaemonDataExportCancelRequest: requestCheck } =
      await import("./checks/daemon/data.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "daemon.dataExport.start": async (): Promise<
    MethodCheckPair<
      import("./daemon/data.js").DaemonDataExportStartRequest,
      import("./daemon/data.js").DaemonDataExportStartResponse
    >
  > => {
    const { validateDaemonDataExportStartRequest: requestCheck } =
      await import("./checks/daemon/data.js");
    const { validateDaemonDataExportStartResponse: responseCheck } =
      await import("./checks/daemon/data.js");
    return { requestCheck, responseCheck };
  },
  "daemon.flush": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./daemon/lifecycle.js").DaemonFlushResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateDaemonFlushResponse: responseCheck } =
      await import("./checks/daemon/lifecycle.js");
    return { requestCheck, responseCheck };
  },
  "daemon.packageCache.clear": async (): Promise<
    MethodCheckPair<
      import("./daemon/config.js").DaemonPackageCacheClearRequest,
      import("./daemon/config.js").DaemonPackageCacheReading
    >
  > => {
    const { validateDaemonPackageCacheClearRequest: requestCheck } =
      await import("./checks/daemon/config.js");
    const { validateDaemonPackageCacheReading: responseCheck } =
      await import("./checks/daemon/config.js");
    return { requestCheck, responseCheck };
  },
  "daemon.packageCache.list": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./daemon/config.js").DaemonPackageCacheReading
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateDaemonPackageCacheReading: responseCheck } =
      await import("./checks/daemon/config.js");
    return { requestCheck, responseCheck };
  },
  "daemon.ping": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "daemon.restart": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./daemon/lifecycle.js").DaemonLifecycleAccepted
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateDaemonLifecycleAccepted: responseCheck } =
      await import("./checks/daemon/lifecycle.js");
    return { requestCheck, responseCheck };
  },
  "daemon.retention.purge": async (): Promise<
    MethodCheckPair<
      import("./daemon/retention.js").DaemonRetentionPurgeRequest,
      import("./daemon/retention.js").DaemonRetentionPurgeResponse
    >
  > => {
    const { validateDaemonRetentionPurgeRequest: requestCheck } =
      await import("./checks/daemon/retention.js");
    const { validateDaemonRetentionPurgeResponse: responseCheck } =
      await import("./checks/daemon/retention.js");
    return { requestCheck, responseCheck };
  },
  "daemon.retention.read": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./daemon/retention.js").DaemonRetentionReadResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateDaemonRetentionReadResponse: responseCheck } =
      await import("./checks/daemon/retention.js");
    return { requestCheck, responseCheck };
  },
  "daemon.retention.update": async (): Promise<
    MethodCheckPair<
      import("./daemon/retention.js").DaemonRetentionUpdateRequest,
      import("./daemon/retention.js").DaemonRetentionBounds
    >
  > => {
    const { validateDaemonRetentionUpdateRequest: requestCheck } =
      await import("./checks/daemon/retention.js");
    const { validateDaemonRetentionBounds: responseCheck } =
      await import("./checks/daemon/retention.js");
    return { requestCheck, responseCheck };
  },
  "daemon.status.read": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./daemon/status.js").DaemonStatusReadResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateDaemonStatusReadResponse: responseCheck } =
      await import("./checks/daemon/status.js");
    return { requestCheck, responseCheck };
  },
  "daemon.stop": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./daemon/lifecycle.js").DaemonLifecycleAccepted
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateDaemonLifecycleAccepted: responseCheck } =
      await import("./checks/daemon/lifecycle.js");
    return { requestCheck, responseCheck };
  },
  "device.forget": async (): Promise<
    MethodCheckPair<
      import("./device.js").DeviceForgetRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateDeviceForgetRequest: requestCheck } = await import("./checks/device.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "device.link.cancel": async (): Promise<
    MethodCheckPair<
      import("./device.js").DeviceLinkCancelRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateDeviceLinkCancelRequest: requestCheck } = await import("./checks/device.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "device.link.confirm": async (): Promise<
    MethodCheckPair<
      import("./device.js").DeviceLinkConfirmRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateDeviceLinkConfirmRequest: requestCheck } = await import("./checks/device.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "device.link.redeem": async (): Promise<
    MethodCheckPair<
      import("./device.js").DeviceLinkRedeemRequest,
      import("./device.js").DeviceLinkRedeemResponse
    >
  > => {
    const { validateDeviceLinkRedeemRequest: requestCheck } = await import("./checks/device.js");
    const { validateDeviceLinkRedeemResponse: responseCheck } = await import("./checks/device.js");
    return { requestCheck, responseCheck };
  },
  "device.link.start": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./device.js").DeviceLinkStartResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateDeviceLinkStartResponse: responseCheck } = await import("./checks/device.js");
    return { requestCheck, responseCheck };
  },
  "device.notificationSettings.update": async (): Promise<
    MethodCheckPair<
      import("./device.js").DeviceNotificationSettingsUpdateRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateDeviceNotificationSettingsUpdateRequest: requestCheck } =
      await import("./checks/device.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "device.push.send": async (): Promise<
    MethodCheckPair<
      import("./push.js").DevicePushSendRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateDevicePushSendRequest: requestCheck } = await import("./checks/push.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "device.pushAddress.update": async (): Promise<
    MethodCheckPair<
      import("./device.js").DevicePushAddressUpdateRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateDevicePushAddressUpdateRequest: requestCheck } =
      await import("./checks/device.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "device.rename": async (): Promise<
    MethodCheckPair<
      import("./device.js").DeviceRenameRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateDeviceRenameRequest: requestCheck } = await import("./checks/device.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "device.revoke": async (): Promise<
    MethodCheckPair<
      import("./device.js").DeviceRevokeRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateDeviceRevokeRequest: requestCheck } = await import("./checks/device.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "device.statement.apply": async (): Promise<
    MethodCheckPair<
      import("./device.js").DeviceStatementApplyRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateDeviceStatementApplyRequest: requestCheck } =
      await import("./checks/device.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "device.statement.list": async (): Promise<
    MethodCheckPair<
      import("./device.js").DeviceStatementListRequest,
      import("./device.js").DeviceStatementListResponse
    >
  > => {
    const { validateDeviceStatementListRequest: requestCheck } = await import("./checks/device.js");
    const { validateDeviceStatementListResponse: responseCheck } =
      await import("./checks/device.js");
    return { requestCheck, responseCheck };
  },
  "device.trusted.list": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./device.js").DeviceTrustedListResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateDeviceTrustedListResponse: responseCheck } = await import("./checks/device.js");
    return { requestCheck, responseCheck };
  },
  "git.action.execute": async (): Promise<
    MethodCheckPair<
      import("./git/local.js").GitActionExecuteRequest,
      import("./git/local.js").GitActionExecuteResponse
    >
  > => {
    const { validateGitActionExecuteRequest: requestCheck } = await import("./checks/git/local.js");
    const { validateGitActionExecuteResponse: responseCheck } =
      await import("./checks/git/local.js");
    return { requestCheck, responseCheck };
  },
  "git.action.preview": async (): Promise<
    MethodCheckPair<
      import("./git/local.js").GitActionPreviewRequest,
      import("./git/local.js").GitActionPreviewResponse
    >
  > => {
    const { validateGitActionPreviewRequest: requestCheck } = await import("./checks/git/local.js");
    const { validateGitActionPreviewResponse: responseCheck } =
      await import("./checks/git/local.js");
    return { requestCheck, responseCheck };
  },
  "git.branchContext.read": async (): Promise<
    MethodCheckPair<
      import("./git/hosting.js").GitSessionRequest,
      import("./git/local.js").GitBranchContextReadResponse
    >
  > => {
    const { validateGitSessionRequest: requestCheck } = await import("./checks/git/hosting.js");
    const { validateGitBranchContextReadResponse: responseCheck } =
      await import("./checks/git/local.js");
    return { requestCheck, responseCheck };
  },
  "git.changeRequest.text.generate": async (): Promise<
    MethodCheckPair<
      import("./git/hosting.js").GitSessionRequest,
      import("./git/local.js").GitChangeRequestTextGenerateResponse
    >
  > => {
    const { validateGitSessionRequest: requestCheck } = await import("./checks/git/hosting.js");
    const { validateGitChangeRequestTextGenerateResponse: responseCheck } =
      await import("./checks/git/local.js");
    return { requestCheck, responseCheck };
  },
  "git.checkLog.read": async (): Promise<
    MethodCheckPair<
      import("./git/hosting.js").GitCheckLogReadRequest,
      import("./git/hosting.js").GitCheckLogReadResponse
    >
  > => {
    const { validateGitCheckLogReadRequest: requestCheck } =
      await import("./checks/git/hosting.js");
    const { validateGitCheckLogReadResponse: responseCheck } =
      await import("./checks/git/hosting.js");
    return { requestCheck, responseCheck };
  },
  "git.commitMessage.generate": async (): Promise<
    MethodCheckPair<
      import("./git/hosting.js").GitSessionRequest,
      import("./git/local.js").GitCommitMessageGenerateResponse
    >
  > => {
    const { validateGitSessionRequest: requestCheck } = await import("./checks/git/hosting.js");
    const { validateGitCommitMessageGenerateResponse: responseCheck } =
      await import("./checks/git/local.js");
    return { requestCheck, responseCheck };
  },
  "git.diff.read": async (): Promise<
    MethodCheckPair<
      import("./git/local.js").GitDiffReadRequest,
      import("./git/local.js").GitDiffReadResponse
    >
  > => {
    const { validateGitDiffReadRequest: requestCheck } = await import("./checks/git/local.js");
    const { validateGitDiffReadResponse: responseCheck } = await import("./checks/git/local.js");
    return { requestCheck, responseCheck };
  },
  "git.host.add": async (): Promise<
    MethodCheckPair<
      import("./git/hosting.js").GitHostAddRequest,
      import("./git/hosting.js").GitHostAddResponse
    >
  > => {
    const { validateGitHostAddRequest: requestCheck } = await import("./checks/git/hosting.js");
    const { validateGitHostAddResponse: responseCheck } = await import("./checks/git/hosting.js");
    return { requestCheck, responseCheck };
  },
  "git.host.list": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./git/hosting.js").GitHostListResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateGitHostListResponse: responseCheck } = await import("./checks/git/hosting.js");
    return { requestCheck, responseCheck };
  },
  "git.host.remove": async (): Promise<
    MethodCheckPair<
      import("./git/hosting.js").GitHostRemoveRequest,
      import("./git/hosting.js").GitHostRemoveResponse
    >
  > => {
    const { validateGitHostRemoveRequest: requestCheck } = await import("./checks/git/hosting.js");
    const { validateGitHostRemoveResponse: responseCheck } =
      await import("./checks/git/hosting.js");
    return { requestCheck, responseCheck };
  },
  "git.label.list": async (): Promise<
    MethodCheckPair<
      import("./git/hosting.js").GitSessionRequest,
      import("./git/hosting.js").GitLabelListResponse
    >
  > => {
    const { validateGitSessionRequest: requestCheck } = await import("./checks/git/hosting.js");
    const { validateGitLabelListResponse: responseCheck } = await import("./checks/git/hosting.js");
    return { requestCheck, responseCheck };
  },
  "git.review.submit": async (): Promise<
    MethodCheckPair<
      import("./git/hosting.js").GitReviewSubmitRequest,
      import("./git/hosting.js").GitReviewSubmitResponse
    >
  > => {
    const { validateGitReviewSubmitRequest: requestCheck } =
      await import("./checks/git/hosting.js");
    const { validateGitReviewSubmitResponse: responseCheck } =
      await import("./checks/git/hosting.js");
    return { requestCheck, responseCheck };
  },
  "git.reviewThread.reply": async (): Promise<
    MethodCheckPair<
      import("./git/hosting.js").GitReviewThreadReplyRequest,
      import("./git/hosting.js").GitReviewThreadReplyResponse
    >
  > => {
    const { validateGitReviewThreadReplyRequest: requestCheck } =
      await import("./checks/git/hosting.js");
    const { validateGitReviewThreadReplyResponse: responseCheck } =
      await import("./checks/git/hosting.js");
    return { requestCheck, responseCheck };
  },
  "git.reviewThread.resolve": async (): Promise<
    MethodCheckPair<
      import("./git/hosting.js").GitReviewThreadResolveRequest,
      import("./git/hosting.js").GitReviewThreadResolveResponse
    >
  > => {
    const { validateGitReviewThreadResolveRequest: requestCheck } =
      await import("./checks/git/hosting.js");
    const { validateGitReviewThreadResolveResponse: responseCheck } =
      await import("./checks/git/hosting.js");
    return { requestCheck, responseCheck };
  },
  "git.reviewer.list": async (): Promise<
    MethodCheckPair<
      import("./git/hosting.js").GitReviewerListRequest,
      import("./git/hosting.js").GitReviewerListResponse
    >
  > => {
    const { validateGitReviewerListRequest: requestCheck } =
      await import("./checks/git/hosting.js");
    const { validateGitReviewerListResponse: responseCheck } =
      await import("./checks/git/hosting.js");
    return { requestCheck, responseCheck };
  },
  "highlight.read": async (): Promise<
    MethodCheckPair<
      import("./highlight.js").HighlightReadRequest,
      import("./highlight.js").HighlightReadResponse
    >
  > => {
    const { validateHighlightReadRequest: requestCheck } = await import("./checks/highlight.js");
    const { validateHighlightReadResponse: responseCheck } = await import("./checks/highlight.js");
    return { requestCheck, responseCheck };
  },
  "machine.folder.list": async (): Promise<
    MethodCheckPair<
      import("./repo/folders.js").MachineFolderListRequest,
      import("./repo/folders.js").MachineFolderListResponse
    >
  > => {
    const { validateMachineFolderListRequest: requestCheck } =
      await import("./checks/repo/folders.js");
    const { validateMachineFolderListResponse: responseCheck } =
      await import("./checks/repo/folders.js");
    return { requestCheck, responseCheck };
  },
  "machine.settings.read": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./machine/settings.js").MachineSettingsReading
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateMachineSettingsReading: responseCheck } =
      await import("./checks/machine/settings.js");
    return { requestCheck, responseCheck };
  },
  "machine.settings.update": async (): Promise<
    MethodCheckPair<
      import("./machine/settings.js").MachineSettingsUpdateRequest,
      import("./machine/settings.js").MachineSettingsUpdateResponse
    >
  > => {
    const { validateMachineSettingsUpdateRequest: requestCheck } =
      await import("./checks/machine/settings.js");
    const { validateMachineSettingsUpdateResponse: responseCheck } =
      await import("./checks/machine/settings.js");
    return { requestCheck, responseCheck };
  },
  "mcp.registry.search": async (): Promise<
    MethodCheckPair<
      import("./mcp/server.js").McpRegistrySearchRequest,
      import("./mcp/server.js").McpRegistrySearchResponse
    >
  > => {
    const { validateMcpRegistrySearchRequest: requestCheck } =
      await import("./checks/mcp/server.js");
    const { validateMcpRegistrySearchResponse: responseCheck } =
      await import("./checks/mcp/server.js");
    return { requestCheck, responseCheck };
  },
  "mcp.resource.list": async (): Promise<
    MethodCheckPair<
      import("./session/controls/methods.js").McpResourceListRequest,
      import("./session/controls/methods.js").McpResourceListResponse
    >
  > => {
    const { validateMcpResourceListRequest: requestCheck } =
      await import("./checks/session/controls/methods.js");
    const { validateMcpResourceListResponse: responseCheck } =
      await import("./checks/session/controls/methods.js");
    return { requestCheck, responseCheck };
  },
  "mcp.server.delete": async (): Promise<
    MethodCheckPair<
      import("./mcp/server.js").McpServerDeleteRequest,
      import("./mcp/server.js").McpServerDeleteResponse
    >
  > => {
    const { validateMcpServerDeleteRequest: requestCheck } = await import("./checks/mcp/server.js");
    const { validateMcpServerDeleteResponse: responseCheck } =
      await import("./checks/mcp/server.js");
    return { requestCheck, responseCheck };
  },
  "mcp.server.enabled.update": async (): Promise<
    MethodCheckPair<
      import("./mcp/server.js").McpServerEnabledUpdateRequest,
      import("./mcp/server.js").McpServerMutationResponse
    >
  > => {
    const { validateMcpServerEnabledUpdateRequest: requestCheck } =
      await import("./checks/mcp/server.js");
    const { validateMcpServerMutationResponse: responseCheck } =
      await import("./checks/mcp/server.js");
    return { requestCheck, responseCheck };
  },
  "mcp.server.list": async (): Promise<
    MethodCheckPair<
      import("./mcp/server.js").McpServerListRequest,
      import("./mcp/server.js").McpServerListResponse
    >
  > => {
    const { validateMcpServerListRequest: requestCheck } = await import("./checks/mcp/server.js");
    const { validateMcpServerListResponse: responseCheck } = await import("./checks/mcp/server.js");
    return { requestCheck, responseCheck };
  },
  "mcp.server.read": async (): Promise<
    MethodCheckPair<
      import("./mcp/server.js").McpServerBindingRef,
      import("./mcp/server.js").McpServerReadResponse
    >
  > => {
    const { validateMcpServerBindingRef: requestCheck } = await import("./checks/mcp/server.js");
    const { validateMcpServerReadResponse: responseCheck } = await import("./checks/mcp/server.js");
    return { requestCheck, responseCheck };
  },
  "mcp.server.reconnect": async (): Promise<
    MethodCheckPair<
      import("./mcp/server.js").McpServerReconnectRequest,
      import("./mcp/server.js").McpServerReconnectResponse
    >
  > => {
    const { validateMcpServerReconnectRequest: requestCheck } =
      await import("./checks/mcp/server.js");
    const { validateMcpServerReconnectResponse: responseCheck } =
      await import("./checks/mcp/server.js");
    return { requestCheck, responseCheck };
  },
  "mcp.server.signIn": async (): Promise<
    MethodCheckPair<
      import("./mcp/server.js").McpServerSignInRequest,
      import("./mcp/server.js").McpServerSignInResponse
    >
  > => {
    const { validateMcpServerSignInRequest: requestCheck } = await import("./checks/mcp/server.js");
    const { validateMcpServerSignInResponse: responseCheck } =
      await import("./checks/mcp/server.js");
    return { requestCheck, responseCheck };
  },
  "mcp.server.signOut": async (): Promise<
    MethodCheckPair<
      import("./mcp/server.js").McpServerSignOutRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateMcpServerSignOutRequest: requestCheck } =
      await import("./checks/mcp/server.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "mcp.server.upsert": async (): Promise<
    MethodCheckPair<
      import("./mcp/server.js").McpServerUpsertRequest,
      import("./mcp/server.js").McpServerMutationResponse
    >
  > => {
    const { validateMcpServerUpsertRequest: requestCheck } = await import("./checks/mcp/server.js");
    const { validateMcpServerMutationResponse: responseCheck } =
      await import("./checks/mcp/server.js");
    return { requestCheck, responseCheck };
  },
  "mcp.toolOverride.clear": async (): Promise<
    MethodCheckPair<
      import("./mcp/server.js").McpToolOverrideClearRequest,
      import("./mcp/server.js").McpToolOverrideMutationResponse
    >
  > => {
    const { validateMcpToolOverrideClearRequest: requestCheck } =
      await import("./checks/mcp/server.js");
    const { validateMcpToolOverrideMutationResponse: responseCheck } =
      await import("./checks/mcp/server.js");
    return { requestCheck, responseCheck };
  },
  "mcp.toolOverride.update": async (): Promise<
    MethodCheckPair<
      import("./mcp/server.js").McpToolOverrideUpdateRequest,
      import("./mcp/server.js").McpToolOverrideMutationResponse
    >
  > => {
    const { validateMcpToolOverrideUpdateRequest: requestCheck } =
      await import("./checks/mcp/server.js");
    const { validateMcpToolOverrideMutationResponse: responseCheck } =
      await import("./checks/mcp/server.js");
    return { requestCheck, responseCheck };
  },
  "plan.resolve": async (): Promise<
    MethodCheckPair<import("./plan.js").PlanResolveRequest, import("./plan.js").PlanResolveResponse>
  > => {
    const { validatePlanResolveRequest: requestCheck } = await import("./checks/plan.js");
    const { validatePlanResolveResponse: responseCheck } = await import("./checks/plan.js");
    return { requestCheck, responseCheck };
  },
  "plugin.app.list": async (): Promise<
    MethodCheckPair<
      import("./plugin.js").PluginAppListRequest,
      import("./plugin.js").PluginAppListResponse
    >
  > => {
    const { validatePluginAppListRequest: requestCheck } = await import("./checks/plugin.js");
    const { validatePluginAppListResponse: responseCheck } = await import("./checks/plugin.js");
    return { requestCheck, responseCheck };
  },
  "plugin.catalog.list": async (): Promise<
    MethodCheckPair<
      import("./plugin.js").PluginCatalogListRequest,
      import("./plugin.js").PluginCatalogListResponse
    >
  > => {
    const { validatePluginCatalogListRequest: requestCheck } = await import("./checks/plugin.js");
    const { validatePluginCatalogListResponse: responseCheck } = await import("./checks/plugin.js");
    return { requestCheck, responseCheck };
  },
  "plugin.install": async (): Promise<
    MethodCheckPair<
      import("./plugin.js").PluginInstallRequest,
      import("./plugin.js").PluginInstallResponse
    >
  > => {
    const { validatePluginInstallRequest: requestCheck } = await import("./checks/plugin.js");
    const { validatePluginInstallResponse: responseCheck } = await import("./checks/plugin.js");
    return { requestCheck, responseCheck };
  },
  "plugin.installed.list": async (): Promise<
    MethodCheckPair<
      import("./plugin.js").PluginInstalledListRequest,
      import("./plugin.js").PluginInstalledListResponse
    >
  > => {
    const { validatePluginInstalledListRequest: requestCheck } = await import("./checks/plugin.js");
    const { validatePluginInstalledListResponse: responseCheck } =
      await import("./checks/plugin.js");
    return { requestCheck, responseCheck };
  },
  "plugin.marketplace.add": async (): Promise<
    MethodCheckPair<
      import("./plugin.js").PluginMarketplaceAddRequest,
      import("./plugin.js").PluginMarketplaceAddResponse
    >
  > => {
    const { validatePluginMarketplaceAddRequest: requestCheck } =
      await import("./checks/plugin.js");
    const { validatePluginMarketplaceAddResponse: responseCheck } =
      await import("./checks/plugin.js");
    return { requestCheck, responseCheck };
  },
  "plugin.marketplace.remove": async (): Promise<
    MethodCheckPair<
      import("./plugin.js").PluginMarketplaceRemoveRequest,
      import("./plugin.js").PluginMarketplaceRemoveResponse
    >
  > => {
    const { validatePluginMarketplaceRemoveRequest: requestCheck } =
      await import("./checks/plugin.js");
    const { validatePluginMarketplaceRemoveResponse: responseCheck } =
      await import("./checks/plugin.js");
    return { requestCheck, responseCheck };
  },
  "plugin.read": async (): Promise<
    MethodCheckPair<import("./plugin.js").PluginRef, import("./plugin.js").PluginReadResponse>
  > => {
    const { validatePluginRef: requestCheck } = await import("./checks/plugin.js");
    const { validatePluginReadResponse: responseCheck } = await import("./checks/plugin.js");
    return { requestCheck, responseCheck };
  },
  "plugin.uninstall": async (): Promise<
    MethodCheckPair<import("./plugin.js").PluginRef, import("./plugin.js").PluginUninstallResponse>
  > => {
    const { validatePluginRef: requestCheck } = await import("./checks/plugin.js");
    const { validatePluginUninstallResponse: responseCheck } = await import("./checks/plugin.js");
    return { requestCheck, responseCheck };
  },
  "presence.heartbeat.send": async (): Promise<
    MethodCheckPair<
      import("./presence.js").PresenceHeartbeatSendRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validatePresenceHeartbeatSendRequest: requestCheck } =
      await import("./checks/presence.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "presence.read": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./presence.js").MachinePresence
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateMachinePresence: responseCheck } = await import("./checks/presence.js");
    return { requestCheck, responseCheck };
  },
  "preview.mark.send": async (): Promise<
    MethodCheckPair<
      import("./preview/methods.js").PreviewMarkSendRequest,
      import("./preview/methods.js").PreviewMarkSendResponse
    >
  > => {
    const { validatePreviewMarkSendRequest: requestCheck } =
      await import("./checks/preview/methods.js");
    const { validatePreviewMarkSendResponse: responseCheck } =
      await import("./checks/preview/methods.js");
    return { requestCheck, responseCheck };
  },
  "preview.page.activate": async (): Promise<
    MethodCheckPair<
      import("./preview/methods.js").PreviewPageRequest,
      import("./preview/methods.js").PreviewPageActivateResponse
    >
  > => {
    const { validatePreviewPageRequest: requestCheck } =
      await import("./checks/preview/methods.js");
    const { validatePreviewPageActivateResponse: responseCheck } =
      await import("./checks/preview/methods.js");
    return { requestCheck, responseCheck };
  },
  "preview.page.close": async (): Promise<
    MethodCheckPair<
      import("./preview/methods.js").PreviewPageRequest,
      import("./preview/methods.js").PreviewPageCloseResponse
    >
  > => {
    const { validatePreviewPageRequest: requestCheck } =
      await import("./checks/preview/methods.js");
    const { validatePreviewPageCloseResponse: responseCheck } =
      await import("./checks/preview/methods.js");
    return { requestCheck, responseCheck };
  },
  "preview.page.cookie.clear": async (): Promise<
    MethodCheckPair<
      import("./preview/page-host.js").PreviewPageCookieClearRequest,
      import("./preview/page-host.js").PreviewClearedResponse
    >
  > => {
    const { validatePreviewPageCookieClearRequest: requestCheck } =
      await import("./checks/preview/page-host.js");
    const { validatePreviewClearedResponse: responseCheck } =
      await import("./checks/preview/page-host.js");
    return { requestCheck, responseCheck };
  },
  "preview.page.cookie.list": async (): Promise<
    MethodCheckPair<
      import("./preview/page-host.js").PreviewPageCookieListRequest,
      import("./preview/page-host.js").PreviewPageCookieListResponse
    >
  > => {
    const { validatePreviewPageCookieListRequest: requestCheck } =
      await import("./checks/preview/page-host.js");
    const { validatePreviewPageCookieListResponse: responseCheck } =
      await import("./checks/preview/page-host.js");
    return { requestCheck, responseCheck };
  },
  "preview.page.cookie.update": async (): Promise<
    MethodCheckPair<
      import("./preview/page-host.js").PreviewPageCookieUpdateRequest,
      import("./preview/page-host.js").PreviewPageCookieUpdateResponse
    >
  > => {
    const { validatePreviewPageCookieUpdateRequest: requestCheck } =
      await import("./checks/preview/page-host.js");
    const { validatePreviewPageCookieUpdateResponse: responseCheck } =
      await import("./checks/preview/page-host.js");
    return { requestCheck, responseCheck };
  },
  "preview.page.debugger.report": async (): Promise<
    MethodCheckPair<
      import("./preview/page-host.js").PreviewPageDebuggerMessageRequest,
      import("./preview/page-host.js").PreviewReceivedResponse
    >
  > => {
    const { validatePreviewPageDebuggerMessageRequest: requestCheck } =
      await import("./checks/preview/page-host.js");
    const { validatePreviewReceivedResponse: responseCheck } =
      await import("./checks/preview/page-host.js");
    return { requestCheck, responseCheck };
  },
  "preview.page.debugger.send": async (): Promise<
    MethodCheckPair<
      import("./preview/page-host.js").PreviewPageDebuggerMessageRequest,
      import("./preview/page-host.js").PreviewReceivedResponse
    >
  > => {
    const { validatePreviewPageDebuggerMessageRequest: requestCheck } =
      await import("./checks/preview/page-host.js");
    const { validatePreviewReceivedResponse: responseCheck } =
      await import("./checks/preview/page-host.js");
    return { requestCheck, responseCheck };
  },
  "preview.page.download.report": async (): Promise<
    MethodCheckPair<
      import("./preview/page-host.js").PreviewPageDownloadReportRequest,
      import("./preview/page-host.js").PreviewPageDownloadReportResponse
    >
  > => {
    const { validatePreviewPageDownloadReportRequest: requestCheck } =
      await import("./checks/preview/page-host.js");
    const { validatePreviewPageDownloadReportResponse: responseCheck } =
      await import("./checks/preview/page-host.js");
    return { requestCheck, responseCheck };
  },
  "preview.page.edit": async (): Promise<
    MethodCheckPair<
      import("./preview/page-host.js").PreviewPageEditRequest,
      import("./preview/methods.js").PreviewMenuEditResponse
    >
  > => {
    const { validatePreviewPageEditRequest: requestCheck } =
      await import("./checks/preview/page-host.js");
    const { validatePreviewMenuEditResponse: responseCheck } =
      await import("./checks/preview/methods.js");
    return { requestCheck, responseCheck };
  },
  "preview.page.localInput.report": async (): Promise<
    MethodCheckPair<
      import("./preview/page-host.js").PreviewPageLocalInputReportRequest,
      import("./preview/page-host.js").PreviewReceivedResponse
    >
  > => {
    const { validatePreviewPageLocalInputReportRequest: requestCheck } =
      await import("./checks/preview/page-host.js");
    const { validatePreviewReceivedResponse: responseCheck } =
      await import("./checks/preview/page-host.js");
    return { requestCheck, responseCheck };
  },
  "preview.page.menu.report": async (): Promise<
    MethodCheckPair<
      import("./preview/page-host.js").PreviewPageMenuReportRequest,
      import("./preview/page-host.js").PreviewReceivedResponse
    >
  > => {
    const { validatePreviewPageMenuReportRequest: requestCheck } =
      await import("./checks/preview/page-host.js");
    const { validatePreviewReceivedResponse: responseCheck } =
      await import("./checks/preview/page-host.js");
    return { requestCheck, responseCheck };
  },
  "preview.page.navigate": async (): Promise<
    MethodCheckPair<
      import("./preview/methods.js").PreviewPageNavigateRequest,
      import("./preview/methods.js").PreviewPageNavigateResponse
    >
  > => {
    const { validatePreviewPageNavigateRequest: requestCheck } =
      await import("./checks/preview/methods.js");
    const { validatePreviewPageNavigateResponse: responseCheck } =
      await import("./checks/preview/methods.js");
    return { requestCheck, responseCheck };
  },
  "preview.page.open": async (): Promise<
    MethodCheckPair<
      import("./preview/methods.js").PreviewPageOpenRequest,
      import("./preview/methods.js").PreviewPageOpenResponse
    >
  > => {
    const { validatePreviewPageOpenRequest: requestCheck } =
      await import("./checks/preview/methods.js");
    const { validatePreviewPageOpenResponse: responseCheck } =
      await import("./checks/preview/methods.js");
    return { requestCheck, responseCheck };
  },
  "preview.page.reorder": async (): Promise<
    MethodCheckPair<
      import("./preview/methods.js").PreviewPageReorderRequest,
      import("./preview/methods.js").PreviewPageReorderResponse
    >
  > => {
    const { validatePreviewPageReorderRequest: requestCheck } =
      await import("./checks/preview/methods.js");
    const { validatePreviewPageReorderResponse: responseCheck } =
      await import("./checks/preview/methods.js");
    return { requestCheck, responseCheck };
  },
  "preview.page.siteData.clear": async (): Promise<
    MethodCheckPair<
      import("./preview/page-host.js").PreviewPageSiteDataClearRequest,
      import("./preview/page-host.js").PreviewClearedResponse
    >
  > => {
    const { validatePreviewPageSiteDataClearRequest: requestCheck } =
      await import("./checks/preview/page-host.js");
    const { validatePreviewClearedResponse: responseCheck } =
      await import("./checks/preview/page-host.js");
    return { requestCheck, responseCheck };
  },
  "preview.page.stagingFolder.read": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./preview/page-host.js").PreviewPageStagingFolderReadResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validatePreviewPageStagingFolderReadResponse: responseCheck } =
      await import("./checks/preview/page-host.js");
    return { requestCheck, responseCheck };
  },
  "preview.page.target.report": async (): Promise<
    MethodCheckPair<
      import("./preview/page-host.js").PreviewPageTargetReportRequest,
      import("./preview/page-host.js").PreviewReceivedResponse
    >
  > => {
    const { validatePreviewPageTargetReportRequest: requestCheck } =
      await import("./checks/preview/page-host.js");
    const { validatePreviewReceivedResponse: responseCheck } =
      await import("./checks/preview/page-host.js");
    return { requestCheck, responseCheck };
  },
  "preview.page.zoom.update": async (): Promise<
    MethodCheckPair<
      import("./preview/methods.js").PreviewPageZoomUpdateRequest,
      import("./preview/methods.js").PreviewPageZoomUpdateResponse
    >
  > => {
    const { validatePreviewPageZoomUpdateRequest: requestCheck } =
      await import("./checks/preview/methods.js");
    const { validatePreviewPageZoomUpdateResponse: responseCheck } =
      await import("./checks/preview/methods.js");
    return { requestCheck, responseCheck };
  },
  "preview.portShare.add": async (): Promise<
    MethodCheckPair<
      import("./preview/port.js").PreviewPortRequest,
      import("./preview/port.js").PreviewPortShareAddResponse
    >
  > => {
    const { validatePreviewPortRequest: requestCheck } = await import("./checks/preview/port.js");
    const { validatePreviewPortShareAddResponse: responseCheck } =
      await import("./checks/preview/port.js");
    return { requestCheck, responseCheck };
  },
  "preview.portShare.remove": async (): Promise<
    MethodCheckPair<
      import("./preview/port.js").PreviewPortRequest,
      import("./preview/port.js").PreviewPortShareRemoveResponse
    >
  > => {
    const { validatePreviewPortRequest: requestCheck } = await import("./checks/preview/port.js");
    const { validatePreviewPortShareRemoveResponse: responseCheck } =
      await import("./checks/preview/port.js");
    return { requestCheck, responseCheck };
  },
  "preview.portTicket.issue": async (): Promise<
    MethodCheckPair<
      import("./preview/port.js").PreviewPortRequest,
      import("./preview/port.js").PreviewPortTicketIssueResponse
    >
  > => {
    const { validatePreviewPortRequest: requestCheck } = await import("./checks/preview/port.js");
    const { validatePreviewPortTicketIssueResponse: responseCheck } =
      await import("./checks/preview/port.js");
    return { requestCheck, responseCheck };
  },
  "preview.save.read": async (): Promise<
    MethodCheckPair<
      import("./preview/page-host.js").PreviewSaveReadRequest,
      import("./preview/page-host.js").PreviewSaveReadResponse
    >
  > => {
    const { validatePreviewSaveReadRequest: requestCheck } =
      await import("./checks/preview/page-host.js");
    const { validatePreviewSaveReadResponse: responseCheck } =
      await import("./checks/preview/page-host.js");
    return { requestCheck, responseCheck };
  },
  "preview.screencast.acknowledge": async (): Promise<
    MethodCheckPair<
      import("./preview/methods.js").PreviewScreencastAcknowledgeRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validatePreviewScreencastAcknowledgeRequest: requestCheck } =
      await import("./checks/preview/methods.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "preview.screencast.edit": async (): Promise<
    MethodCheckPair<
      import("./preview/methods.js").PreviewScreencastEditRequest,
      import("./preview/methods.js").PreviewMenuEditResponse
    >
  > => {
    const { validatePreviewScreencastEditRequest: requestCheck } =
      await import("./checks/preview/methods.js");
    const { validatePreviewMenuEditResponse: responseCheck } =
      await import("./checks/preview/methods.js");
    return { requestCheck, responseCheck };
  },
  "preview.screencast.file.choose": async (): Promise<
    MethodCheckPair<
      import("./preview/methods.js").PreviewScreencastFileChooseRequest,
      import("./preview/methods.js").PreviewScreencastFileChooseResponse
    >
  > => {
    const { validatePreviewScreencastFileChooseRequest: requestCheck } =
      await import("./checks/preview/methods.js");
    const { validatePreviewScreencastFileChooseResponse: responseCheck } =
      await import("./checks/preview/methods.js");
    return { requestCheck, responseCheck };
  },
  "preview.screencast.input.send": async (): Promise<
    MethodCheckPair<
      import("./preview/methods.js").PreviewScreencastInputSendRequest,
      import("./preview/methods.js").PreviewScreencastInputSendResponse
    >
  > => {
    const { validatePreviewScreencastInputSendRequest: requestCheck } =
      await import("./checks/preview/methods.js");
    const { validatePreviewScreencastInputSendResponse: responseCheck } =
      await import("./checks/preview/methods.js");
    return { requestCheck, responseCheck };
  },
  "preview.screencast.save.acknowledge": async (): Promise<
    MethodCheckPair<
      import("./preview/methods.js").PreviewScreencastSaveAcknowledgeRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validatePreviewScreencastSaveAcknowledgeRequest: requestCheck } =
      await import("./checks/preview/methods.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "project.archive": async (): Promise<
    MethodCheckPair<
      import("./project.js").ProjectStateChangeRequest,
      import("./project.js").ProjectEditResponse
    >
  > => {
    const { validateProjectStateChangeRequest: requestCheck } = await import("./checks/project.js");
    const { validateProjectEditResponse: responseCheck } = await import("./checks/project.js");
    return { requestCheck, responseCheck };
  },
  "project.branch.list": async (): Promise<
    MethodCheckPair<
      import("./repo/git-reads.js").ProjectBranchListRequest,
      import("./repo/git-reads.js").ProjectBranchListResponse
    >
  > => {
    const { validateProjectBranchListRequest: requestCheck } =
      await import("./checks/repo/git-reads.js");
    const { validateProjectBranchListResponse: responseCheck } =
      await import("./checks/repo/git-reads.js");
    return { requestCheck, responseCheck };
  },
  "project.branchPattern.update": async (): Promise<
    MethodCheckPair<
      import("./project.js").ProjectBranchPatternUpdateRequest,
      import("./project.js").ProjectEditResponse
    >
  > => {
    const { validateProjectBranchPatternUpdateRequest: requestCheck } =
      await import("./checks/project.js");
    const { validateProjectEditResponse: responseCheck } = await import("./checks/project.js");
    return { requestCheck, responseCheck };
  },
  "project.clone.answer": async (): Promise<
    MethodCheckPair<
      import("./repo/clone.js").ProjectCloneAnswerRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateProjectCloneAnswerRequest: requestCheck } =
      await import("./checks/repo/clone.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "project.clone.cancel": async (): Promise<
    MethodCheckPair<
      import("./repo/clone.js").ProjectCloneRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateProjectCloneRequest: requestCheck } = await import("./checks/repo/clone.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "project.clone.folder.read": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./repo/clone.js").ProjectCloneFolderReadResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateProjectCloneFolderReadResponse: responseCheck } =
      await import("./checks/repo/clone.js");
    return { requestCheck, responseCheck };
  },
  "project.clone.start": async (): Promise<
    MethodCheckPair<
      import("./repo/clone.js").ProjectCloneStartRequest,
      import("./repo/clone.js").ProjectCloneStartResponse
    >
  > => {
    const { validateProjectCloneStartRequest: requestCheck } =
      await import("./checks/repo/clone.js");
    const { validateProjectCloneStartResponse: responseCheck } =
      await import("./checks/repo/clone.js");
    return { requestCheck, responseCheck };
  },
  "project.environment.update": async (): Promise<
    MethodCheckPair<
      import("./project.js").ProjectEnvironmentUpdateRequest,
      import("./project.js").ProjectEditResponse
    >
  > => {
    const { validateProjectEnvironmentUpdateRequest: requestCheck } =
      await import("./checks/project.js");
    const { validateProjectEditResponse: responseCheck } = await import("./checks/project.js");
    return { requestCheck, responseCheck };
  },
  "project.file.read": async (): Promise<
    MethodCheckPair<
      import("./repo/git-reads.js").ProjectFileReadRequest,
      import("./repo/git-reads.js").ProjectFileReadResponse
    >
  > => {
    const { validateProjectFileReadRequest: requestCheck } =
      await import("./checks/repo/git-reads.js");
    const { validateProjectFileReadResponse: responseCheck } =
      await import("./checks/repo/git-reads.js");
    return { requestCheck, responseCheck };
  },
  "project.largeFile.pull": async (): Promise<
    MethodCheckPair<
      import("./repo/clone.js").ProjectCloneRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateProjectCloneRequest: requestCheck } = await import("./checks/repo/clone.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "project.reactivate": async (): Promise<
    MethodCheckPair<
      import("./project.js").ProjectStateChangeRequest,
      import("./project.js").ProjectEditResponse
    >
  > => {
    const { validateProjectStateChangeRequest: requestCheck } = await import("./checks/project.js");
    const { validateProjectEditResponse: responseCheck } = await import("./checks/project.js");
    return { requestCheck, responseCheck };
  },
  "project.rename": async (): Promise<
    MethodCheckPair<
      import("./project.js").ProjectRenameRequest,
      import("./project.js").ProjectEditResponse
    >
  > => {
    const { validateProjectRenameRequest: requestCheck } = await import("./checks/project.js");
    const { validateProjectEditResponse: responseCheck } = await import("./checks/project.js");
    return { requestCheck, responseCheck };
  },
  "project.setup.update": async (): Promise<
    MethodCheckPair<
      import("./project.js").ProjectSetupUpdateRequest,
      import("./project.js").ProjectEditResponse
    >
  > => {
    const { validateProjectSetupUpdateRequest: requestCheck } = await import("./checks/project.js");
    const { validateProjectEditResponse: responseCheck } = await import("./checks/project.js");
    return { requestCheck, responseCheck };
  },
  "provider.account.credentialHome.reset": async (): Promise<
    MethodCheckPair<
      import("./provider/account/sign-in.js").ProviderAccountCredentialHomeResetRequest,
      import("./provider/account/sign-in.js").ProviderAccountCredentialHomeResetResponse
    >
  > => {
    const { validateProviderAccountCredentialHomeResetRequest: requestCheck } =
      await import("./checks/provider/account/sign-in.js");
    const { validateProviderAccountCredentialHomeResetResponse: responseCheck } =
      await import("./checks/provider/account/sign-in.js");
    return { requestCheck, responseCheck };
  },
  "provider.account.current.update": async (): Promise<
    MethodCheckPair<
      import("./provider/account/methods.js").ProviderAccountCurrentUpdateRequest,
      import("./provider/account/methods.js").ProviderAccountCurrentUpdateResponse
    >
  > => {
    const { validateProviderAccountCurrentUpdateRequest: requestCheck } =
      await import("./checks/provider/account/methods.js");
    const { validateProviderAccountCurrentUpdateResponse: responseCheck } =
      await import("./checks/provider/account/methods.js");
    return { requestCheck, responseCheck };
  },
  "provider.account.delete": async (): Promise<
    MethodCheckPair<
      import("./provider/account/methods.js").ProviderAccountDeleteRequest,
      import("./provider/account/methods.js").ProviderAccountDeleteResponse
    >
  > => {
    const { validateProviderAccountDeleteRequest: requestCheck } =
      await import("./checks/provider/account/methods.js");
    const { validateProviderAccountDeleteResponse: responseCheck } =
      await import("./checks/provider/account/methods.js");
    return { requestCheck, responseCheck };
  },
  "provider.account.list": async (): Promise<
    MethodCheckPair<
      import("./provider/account/record.js").ProviderAccountListRequest,
      import("./provider/account/record.js").ProviderAccountListResponse
    >
  > => {
    const { validateProviderAccountListRequest: requestCheck } =
      await import("./checks/provider/account/record.js");
    const { validateProviderAccountListResponse: responseCheck } =
      await import("./checks/provider/account/record.js");
    return { requestCheck, responseCheck };
  },
  "provider.account.memory.import": async (): Promise<
    MethodCheckPair<
      import("./provider/account/methods.js").ProviderAccountMemoryImportRequest,
      import("./provider/account/record.js").ProviderAccountMemoryImportOutcome
    >
  > => {
    const { validateProviderAccountMemoryImportRequest: requestCheck } =
      await import("./checks/provider/account/methods.js");
    const { validateProviderAccountMemoryImportOutcome: responseCheck } =
      await import("./checks/provider/account/record.js");
    return { requestCheck, responseCheck };
  },
  "provider.account.probe": async (): Promise<
    MethodCheckPair<
      import("./provider/account/methods.js").ProviderAccountProbeRequest,
      import("./provider/account/methods.js").ProviderAccountProbeResponse
    >
  > => {
    const { validateProviderAccountProbeRequest: requestCheck } =
      await import("./checks/provider/account/methods.js");
    const { validateProviderAccountProbeResponse: responseCheck } =
      await import("./checks/provider/account/methods.js");
    return { requestCheck, responseCheck };
  },
  "provider.account.register": async (): Promise<
    MethodCheckPair<
      import("./provider/account/sign-in.js").ProviderAccountRegisterRequest,
      import("./provider/account/sign-in.js").ProviderAccountRegisterResponse
    >
  > => {
    const { validateProviderAccountRegisterRequest: requestCheck } =
      await import("./checks/provider/account/sign-in.js");
    const { validateProviderAccountRegisterResponse: responseCheck } =
      await import("./checks/provider/account/sign-in.js");
    return { requestCheck, responseCheck };
  },
  "provider.account.signIn": async (): Promise<
    MethodCheckPair<
      import("./provider/account/sign-in.js").ProviderAccountSignInRequest,
      import("./provider/account/sign-in.js").ProviderAccountSignInResponse
    >
  > => {
    const { validateProviderAccountSignInRequest: requestCheck } =
      await import("./checks/provider/account/sign-in.js");
    const { validateProviderAccountSignInResponse: responseCheck } =
      await import("./checks/provider/account/sign-in.js");
    return { requestCheck, responseCheck };
  },
  "provider.account.signInAttempt.cancel": async (): Promise<
    MethodCheckPair<
      import("./provider/account/sign-in.js").ProviderAccountSignInAttemptCancelRequest,
      import("./provider/account/sign-in.js").ProviderAccountSignInAttemptCancelResponse
    >
  > => {
    const { validateProviderAccountSignInAttemptCancelRequest: requestCheck } =
      await import("./checks/provider/account/sign-in.js");
    const { validateProviderAccountSignInAttemptCancelResponse: responseCheck } =
      await import("./checks/provider/account/sign-in.js");
    return { requestCheck, responseCheck };
  },
  "provider.account.signInCode.submit": async (): Promise<
    MethodCheckPair<
      import("./provider/account/sign-in.js").ProviderAccountSignInCodeSubmitRequest,
      import("./provider/account/sign-in.js").ProviderAccountSignInCodeSubmitResponse
    >
  > => {
    const { validateProviderAccountSignInCodeSubmitRequest: requestCheck } =
      await import("./checks/provider/account/sign-in.js");
    const { validateProviderAccountSignInCodeSubmitResponse: responseCheck } =
      await import("./checks/provider/account/sign-in.js");
    return { requestCheck, responseCheck };
  },
  "provider.account.update": async (): Promise<
    MethodCheckPair<
      import("./provider/account/methods.js").ProviderAccountUpdateRequest,
      import("./provider/account/methods.js").ProviderAccountUpdateResponse
    >
  > => {
    const { validateProviderAccountUpdateRequest: requestCheck } =
      await import("./checks/provider/account/methods.js");
    const { validateProviderAccountUpdateResponse: responseCheck } =
      await import("./checks/provider/account/methods.js");
    return { requestCheck, responseCheck };
  },
  "provider.account.usage.list": async (): Promise<
    MethodCheckPair<
      import("./provider/account/methods.js").ProviderAccountUsageListRequest,
      import("./provider/account/methods.js").ProviderAccountUsageListResponse
    >
  > => {
    const { validateProviderAccountUsageListRequest: requestCheck } =
      await import("./checks/provider/account/methods.js");
    const { validateProviderAccountUsageListResponse: responseCheck } =
      await import("./checks/provider/account/methods.js");
    return { requestCheck, responseCheck };
  },
  "provider.command.list": async (): Promise<
    MethodCheckPair<
      import("./provider/driver/methods.js").ProviderCommandListRequest,
      import("./provider/driver/commands.js").ProviderCommandListResponse
    >
  > => {
    const { validateProviderCommandListRequest: requestCheck } =
      await import("./checks/provider/driver/methods.js");
    const { validateProviderCommandListResponse: responseCheck } =
      await import("./checks/provider/driver/commands.js");
    return { requestCheck, responseCheck };
  },
  "provider.install.start": async (): Promise<
    MethodCheckPair<
      import("./provider/settings.js").ProviderPlaceRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateProviderPlaceRequest: requestCheck } =
      await import("./checks/provider/settings.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "provider.install.stop": async (): Promise<
    MethodCheckPair<
      import("./provider/settings.js").ProviderPlaceRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateProviderPlaceRequest: requestCheck } =
      await import("./checks/provider/settings.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "provider.installUpdate.start": async (): Promise<
    MethodCheckPair<
      import("./provider/settings.js").ProviderPlaceRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateProviderPlaceRequest: requestCheck } =
      await import("./checks/provider/settings.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "provider.list": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./provider/settings.js").ProviderListResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateProviderListResponse: responseCheck } =
      await import("./checks/provider/settings.js");
    return { requestCheck, responseCheck };
  },
  "provider.mode.list": async (): Promise<
    MethodCheckPair<
      import("./provider/driver/methods.js").ProviderModeListRequest,
      import("./provider/driver/methods.js").ProviderModeListResponse
    >
  > => {
    const { validateProviderModeListRequest: requestCheck } =
      await import("./checks/provider/driver/methods.js");
    const { validateProviderModeListResponse: responseCheck } =
      await import("./checks/provider/driver/methods.js");
    return { requestCheck, responseCheck };
  },
  "provider.model.list": async (): Promise<
    MethodCheckPair<
      import("./provider/driver/methods.js").ProviderModelListRequest,
      import("./provider/driver/methods.js").ProviderModelListResponse
    >
  > => {
    const { validateProviderModelListRequest: requestCheck } =
      await import("./checks/provider/driver/methods.js");
    const { validateProviderModelListResponse: responseCheck } =
      await import("./checks/provider/driver/methods.js");
    return { requestCheck, responseCheck };
  },
  "provider.probe": async (): Promise<
    MethodCheckPair<
      import("./provider/settings.js").ProviderPlaceRequest,
      import("./provider/settings.js").ProviderSettingsResponse
    >
  > => {
    const { validateProviderPlaceRequest: requestCheck } =
      await import("./checks/provider/settings.js");
    const { validateProviderSettingsResponse: responseCheck } =
      await import("./checks/provider/settings.js");
    return { requestCheck, responseCheck };
  },
  "provider.protectedPath.list": async (): Promise<
    MethodCheckPair<
      import("./provider/settings.js").ProviderRequest,
      import("./provider/settings.js").ProviderProtectedPathListResponse
    >
  > => {
    const { validateProviderRequest: requestCheck } = await import("./checks/provider/settings.js");
    const { validateProviderProtectedPathListResponse: responseCheck } =
      await import("./checks/provider/settings.js");
    return { requestCheck, responseCheck };
  },
  "provider.standingRule.list": async (): Promise<
    MethodCheckPair<
      import("./provider/settings.js").ProviderRequest,
      import("./provider/settings.js").ProviderStandingRuleListResponse
    >
  > => {
    const { validateProviderRequest: requestCheck } = await import("./checks/provider/settings.js");
    const { validateProviderStandingRuleListResponse: responseCheck } =
      await import("./checks/provider/settings.js");
    return { requestCheck, responseCheck };
  },
  "provider.standingRule.revoke": async (): Promise<
    MethodCheckPair<
      import("./provider/settings.js").ProviderStandingRuleRevokeRequest,
      import("./provider/settings.js").ProviderStandingRuleRevokeResponse
    >
  > => {
    const { validateProviderStandingRuleRevokeRequest: requestCheck } =
      await import("./checks/provider/settings.js");
    const { validateProviderStandingRuleRevokeResponse: responseCheck } =
      await import("./checks/provider/settings.js");
    return { requestCheck, responseCheck };
  },
  "provider.terminalPlugin.update": async (): Promise<
    MethodCheckPair<
      import("./provider/settings.js").ProviderTerminalPluginUpdateRequest,
      import("./provider/settings.js").ProviderSettingsResponse
    >
  > => {
    const { validateProviderTerminalPluginUpdateRequest: requestCheck } =
      await import("./checks/provider/settings.js");
    const { validateProviderSettingsResponse: responseCheck } =
      await import("./checks/provider/settings.js");
    return { requestCheck, responseCheck };
  },
  "provider.terminalSession.list": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./session/controls/methods.js").ProviderTerminalSessionListResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateProviderTerminalSessionListResponse: responseCheck } =
      await import("./checks/session/controls/methods.js");
    return { requestCheck, responseCheck };
  },
  "provider.update": async (): Promise<
    MethodCheckPair<
      import("./provider/settings.js").ProviderUpdateRequest,
      import("./provider/settings.js").ProviderSettingsResponse
    >
  > => {
    const { validateProviderUpdateRequest: requestCheck } =
      await import("./checks/provider/settings.js");
    const { validateProviderSettingsResponse: responseCheck } =
      await import("./checks/provider/settings.js");
    return { requestCheck, responseCheck };
  },
  "question.resolve": async (): Promise<
    MethodCheckPair<
      import("./question.js").QuestionResolveRequest,
      import("./question.js").QuestionResolveResponse
    >
  > => {
    const { validateQuestionResolveRequest: requestCheck } = await import("./checks/question.js");
    const { validateQuestionResolveResponse: responseCheck } = await import("./checks/question.js");
    return { requestCheck, responseCheck };
  },
  "relay.repin": async (): Promise<
    MethodCheckPair<
      import("./relay.js").RelayRepinRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateRelayRepinRequest: requestCheck } = await import("./checks/relay.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "repoMount.attach": async (): Promise<
    MethodCheckPair<
      import("./repo/folders.js").RepoMountAttachRequest,
      import("./repo/folders.js").RepoMountAttachResponse
    >
  > => {
    const { validateRepoMountAttachRequest: requestCheck } =
      await import("./checks/repo/folders.js");
    const { validateRepoMountAttachResponse: responseCheck } =
      await import("./checks/repo/folders.js");
    return { requestCheck, responseCheck };
  },
  "repoMount.detach": async (): Promise<
    MethodCheckPair<
      import("./repo/folders.js").RepoMountRequest,
      import("./repo/folders.js").RepoMountDetachResponse
    >
  > => {
    const { validateRepoMountRequest: requestCheck } = await import("./checks/repo/folders.js");
    const { validateRepoMountDetachResponse: responseCheck } =
      await import("./checks/repo/folders.js");
    return { requestCheck, responseCheck };
  },
  "repoMount.list": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./repo/folders.js").RepoMountListResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateRepoMountListResponse: responseCheck } =
      await import("./checks/repo/folders.js");
    return { requestCheck, responseCheck };
  },
  "repoMount.read": async (): Promise<
    MethodCheckPair<
      import("./repo/folders.js").RepoMountRequest,
      import("./repo/folders.js").RepoMountReadResponse
    >
  > => {
    const { validateRepoMountRequest: requestCheck } = await import("./checks/repo/folders.js");
    const { validateRepoMountReadResponse: responseCheck } =
      await import("./checks/repo/folders.js");
    return { requestCheck, responseCheck };
  },
  "repoMount.reattach": async (): Promise<
    MethodCheckPair<
      import("./repo/folders.js").RepoMountRequest,
      import("./repo/folders.js").RepoMountReattachResponse
    >
  > => {
    const { validateRepoMountRequest: requestCheck } = await import("./checks/repo/folders.js");
    const { validateRepoMountReattachResponse: responseCheck } =
      await import("./checks/repo/folders.js");
    return { requestCheck, responseCheck };
  },
  "session.archive": async (): Promise<
    MethodCheckPair<
      import("./session/methods.js").SessionTargetRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateSessionTargetRequest: requestCheck } =
      await import("./checks/session/methods.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "session.attachment.add": async (): Promise<
    MethodCheckPair<
      import("./session/draft.js").SessionAttachmentAddRequest,
      import("./session/draft.js").SessionAttachmentAddResponse
    >
  > => {
    const { validateSessionAttachmentAddRequest: requestCheck } =
      await import("./checks/session/draft.js");
    const { validateSessionAttachmentAddResponse: responseCheck } =
      await import("./checks/session/draft.js");
    return { requestCheck, responseCheck };
  },
  "session.attachment.cover": async (): Promise<
    MethodCheckPair<
      import("./session/draft.js").SessionAttachmentCoverRequest,
      import("./session/draft.js").SessionAttachmentCoverResponse
    >
  > => {
    const { validateSessionAttachmentCoverRequest: requestCheck } =
      await import("./checks/session/draft.js");
    const { validateSessionAttachmentCoverResponse: responseCheck } =
      await import("./checks/session/draft.js");
    return { requestCheck, responseCheck };
  },
  "session.attachment.remove": async (): Promise<
    MethodCheckPair<
      import("./session/draft.js").SessionAttachmentRemoveRequest,
      import("./session/draft.js").SessionAttachmentRemoveResponse
    >
  > => {
    const { validateSessionAttachmentRemoveRequest: requestCheck } =
      await import("./checks/session/draft.js");
    const { validateSessionAttachmentRemoveResponse: responseCheck } =
      await import("./checks/session/draft.js");
    return { requestCheck, responseCheck };
  },
  "session.autoCompact.update": async (): Promise<
    MethodCheckPair<
      import("./session/controls/methods.js").SessionAutoCompactUpdateRequest,
      import("./session/controls/methods.js").SessionAutoCompactUpdateResponse
    >
  > => {
    const { validateSessionAutoCompactUpdateRequest: requestCheck } =
      await import("./checks/session/controls/methods.js");
    const { validateSessionAutoCompactUpdateResponse: responseCheck } =
      await import("./checks/session/controls/methods.js");
    return { requestCheck, responseCheck };
  },
  "session.autoMemory.update": async (): Promise<
    MethodCheckPair<
      import("./session/inspector.js").SessionAutoMemoryUpdateRequest,
      import("./session/inspector.js").SessionAutoMemoryUpdateResponse
    >
  > => {
    const { validateSessionAutoMemoryUpdateRequest: requestCheck } =
      await import("./checks/session/inspector.js");
    const { validateSessionAutoMemoryUpdateResponse: responseCheck } =
      await import("./checks/session/inspector.js");
    return { requestCheck, responseCheck };
  },
  "session.budget.read": async (): Promise<
    MethodCheckPair<
      import("./session/cost.js").SessionBudgetReadRequest,
      import("./session/cost.js").SessionBudgetState
    >
  > => {
    const { validateSessionBudgetReadRequest: requestCheck } =
      await import("./checks/session/cost.js");
    const { validateSessionBudgetState: responseCheck } = await import("./checks/session/cost.js");
    return { requestCheck, responseCheck };
  },
  "session.close": async (): Promise<
    MethodCheckPair<
      import("./session/methods.js").SessionTargetRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateSessionTargetRequest: requestCheck } =
      await import("./checks/session/methods.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "session.codeReview.start": async (): Promise<
    MethodCheckPair<
      import("./session/controls/methods.js").SessionCodeReviewStartRequest,
      import("./run/queue.js").AgentQueueItemCreateResponse
    >
  > => {
    const { validateSessionCodeReviewStartRequest: requestCheck } =
      await import("./checks/session/controls/methods.js");
    const { validateAgentQueueItemCreateResponse: responseCheck } =
      await import("./checks/run/queue.js");
    return { requestCheck, responseCheck };
  },
  "session.conversion.skippedFile.list": async (): Promise<
    MethodCheckPair<
      import("./session/convert.js").SessionConversionSkippedFileListRequest,
      import("./session/convert.js").SessionConversionSkippedFileListResponse
    >
  > => {
    const { validateSessionConversionSkippedFileListRequest: requestCheck } =
      await import("./checks/session/convert.js");
    const { validateSessionConversionSkippedFileListResponse: responseCheck } =
      await import("./checks/session/convert.js");
    return { requestCheck, responseCheck };
  },
  "session.convert": async (): Promise<
    MethodCheckPair<
      import("./session/convert.js").SessionConvertRequest,
      import("./session/convert.js").SessionConvertResponse
    >
  > => {
    const { validateSessionConvertRequest: requestCheck } =
      await import("./checks/session/convert.js");
    const { validateSessionConvertResponse: responseCheck } =
      await import("./checks/session/convert.js");
    return { requestCheck, responseCheck };
  },
  "session.costReceipt.read": async (): Promise<
    MethodCheckPair<
      import("./session/cost.js").SessionCostReceiptReadRequest,
      import("./session/cost.js").SessionCostReceipt
    >
  > => {
    const { validateSessionCostReceiptReadRequest: requestCheck } =
      await import("./checks/session/cost.js");
    const { validateSessionCostReceipt: responseCheck } = await import("./checks/session/cost.js");
    return { requestCheck, responseCheck };
  },
  "session.create": async (): Promise<
    MethodCheckPair<
      import("./session/directory.js").SessionCreateRequest,
      import("./session/directory.js").SessionCreateResponse
    >
  > => {
    const { validateSessionCreateRequest: requestCheck } =
      await import("./checks/session/directory.js");
    const { validateSessionCreateResponse: responseCheck } =
      await import("./checks/session/directory.js");
    return { requestCheck, responseCheck };
  },
  "session.definition.reload": async (): Promise<
    MethodCheckPair<
      import("./session/controls/methods.js").SessionAddressedRequest,
      import("./session/controls/methods.js").SessionAcknowledgment
    >
  > => {
    const { validateSessionAddressedRequest: requestCheck } =
      await import("./checks/session/controls/methods.js");
    const { validateSessionAcknowledgment: responseCheck } =
      await import("./checks/session/controls/methods.js");
    return { requestCheck, responseCheck };
  },
  "session.draft.update": async (): Promise<
    MethodCheckPair<
      import("./session/draft.js").SessionDraftUpdateRequest,
      import("./session/draft.js").SessionDraftUpdateResponse
    >
  > => {
    const { validateSessionDraftUpdateRequest: requestCheck } =
      await import("./checks/session/draft.js");
    const { validateSessionDraftUpdateResponse: responseCheck } =
      await import("./checks/session/draft.js");
    return { requestCheck, responseCheck };
  },
  "session.file.search": async (): Promise<
    MethodCheckPair<
      import("./session/methods.js").SessionFileSearchRequest,
      import("./session/methods.js").SessionFileSearchResponse
    >
  > => {
    const { validateSessionFileSearchRequest: requestCheck } =
      await import("./checks/session/methods.js");
    const { validateSessionFileSearchResponse: responseCheck } =
      await import("./checks/session/methods.js");
    return { requestCheck, responseCheck };
  },
  "session.fork": async (): Promise<
    MethodCheckPair<
      import("./session/directory.js").SessionForkRequest,
      import("./session/directory.js").SessionForkResponse
    >
  > => {
    const { validateSessionForkRequest: requestCheck } =
      await import("./checks/session/directory.js");
    const { validateSessionForkResponse: responseCheck } =
      await import("./checks/session/directory.js");
    return { requestCheck, responseCheck };
  },
  "session.goal.clear": async (): Promise<
    MethodCheckPair<
      import("./session/goal.js").SessionGoalClearRequest,
      import("./session/controls/methods.js").SessionAcknowledgment
    >
  > => {
    const { validateSessionGoalClearRequest: requestCheck } =
      await import("./checks/session/goal.js");
    const { validateSessionAcknowledgment: responseCheck } =
      await import("./checks/session/controls/methods.js");
    return { requestCheck, responseCheck };
  },
  "session.goal.update": async (): Promise<
    MethodCheckPair<
      import("./session/goal.js").SessionGoalUpdateRequest,
      import("./session/goal.js").SessionGoalUpdateResponse
    >
  > => {
    const { validateSessionGoalUpdateRequest: requestCheck } =
      await import("./checks/session/goal.js");
    const { validateSessionGoalUpdateResponse: responseCheck } =
      await import("./checks/session/goal.js");
    return { requestCheck, responseCheck };
  },
  "session.group.create": async (): Promise<
    MethodCheckPair<
      import("./session/groups.js").SessionGroupCreateRequest,
      import("./session/groups.js").SessionGroupCreateResponse
    >
  > => {
    const { validateSessionGroupCreateRequest: requestCheck } =
      await import("./checks/session/groups.js");
    const { validateSessionGroupCreateResponse: responseCheck } =
      await import("./checks/session/groups.js");
    return { requestCheck, responseCheck };
  },
  "session.group.move": async (): Promise<
    MethodCheckPair<
      import("./session/groups.js").SessionGroupMoveRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateSessionGroupMoveRequest: requestCheck } =
      await import("./checks/session/groups.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "session.group.rename": async (): Promise<
    MethodCheckPair<
      import("./session/groups.js").SessionGroupRenameRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateSessionGroupRenameRequest: requestCheck } =
      await import("./checks/session/groups.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "session.group.ungroup": async (): Promise<
    MethodCheckPair<
      import("./session/groups.js").SessionGroupUngroupRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateSessionGroupUngroupRequest: requestCheck } =
      await import("./checks/session/groups.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "session.hook.list": async (): Promise<
    MethodCheckPair<
      import("./session/controls/methods.js").SessionAddressedRequest,
      import("./session/inspector.js").SessionHookListResponse
    >
  > => {
    const { validateSessionAddressedRequest: requestCheck } =
      await import("./checks/session/controls/methods.js");
    const { validateSessionHookListResponse: responseCheck } =
      await import("./checks/session/inspector.js");
    return { requestCheck, responseCheck };
  },
  "session.import.preview": async (): Promise<
    MethodCheckPair<
      import("./provider/import.js").SessionImportRequest,
      import("./provider/import.js").SessionImportPreviewResponse
    >
  > => {
    const { validateSessionImportRequest: requestCheck } =
      await import("./checks/provider/import.js");
    const { validateSessionImportPreviewResponse: responseCheck } =
      await import("./checks/provider/import.js");
    return { requestCheck, responseCheck };
  },
  "session.import.start": async (): Promise<
    MethodCheckPair<
      import("./provider/import.js").SessionImportRequest,
      import("./provider/import.js").SessionImportStartResponse
    >
  > => {
    const { validateSessionImportRequest: requestCheck } =
      await import("./checks/provider/import.js");
    const { validateSessionImportStartResponse: responseCheck } =
      await import("./checks/provider/import.js");
    return { requestCheck, responseCheck };
  },
  "session.import.stop": async (): Promise<
    MethodCheckPair<
      import("./provider/import.js").SessionImportStopRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateSessionImportStopRequest: requestCheck } =
      await import("./checks/provider/import.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "session.link.add": async (): Promise<
    MethodCheckPair<
      import("./session/links.js").SessionLinkRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateSessionLinkRequest: requestCheck } = await import("./checks/session/links.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "session.link.remove": async (): Promise<
    MethodCheckPair<
      import("./session/links.js").SessionLinkRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateSessionLinkRequest: requestCheck } = await import("./checks/session/links.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "session.maxSteps.update": async (): Promise<
    MethodCheckPair<
      import("./session/controls/methods.js").SessionMaxStepsUpdateRequest,
      import("./session/controls/methods.js").SessionMaxStepsUpdateResponse
    >
  > => {
    const { validateSessionMaxStepsUpdateRequest: requestCheck } =
      await import("./checks/session/controls/methods.js");
    const { validateSessionMaxStepsUpdateResponse: responseCheck } =
      await import("./checks/session/controls/methods.js");
    return { requestCheck, responseCheck };
  },
  "session.mcpServer.enabled.update": async (): Promise<
    MethodCheckPair<
      import("./session/controls/methods.js").SessionMcpServerEnabledUpdateRequest,
      import("./session/controls/methods.js").SessionMcpServerEnabledUpdateResponse
    >
  > => {
    const { validateSessionMcpServerEnabledUpdateRequest: requestCheck } =
      await import("./checks/session/controls/methods.js");
    const { validateSessionMcpServerEnabledUpdateResponse: responseCheck } =
      await import("./checks/session/controls/methods.js");
    return { requestCheck, responseCheck };
  },
  "session.memory.read": async (): Promise<
    MethodCheckPair<
      import("./session/controls/methods.js").SessionAddressedRequest,
      import("./session/inspector.js").SessionMemoryReadResponse
    >
  > => {
    const { validateSessionAddressedRequest: requestCheck } =
      await import("./checks/session/controls/methods.js");
    const { validateSessionMemoryReadResponse: responseCheck } =
      await import("./checks/session/inspector.js");
    return { requestCheck, responseCheck };
  },
  "session.mode.update": async (): Promise<
    MethodCheckPair<
      import("./session/controls/methods.js").SessionModeUpdateRequest,
      import("./session/controls/methods.js").SessionModeUpdateResponse
    >
  > => {
    const { validateSessionModeUpdateRequest: requestCheck } =
      await import("./checks/session/controls/methods.js");
    const { validateSessionModeUpdateResponse: responseCheck } =
      await import("./checks/session/controls/methods.js");
    return { requestCheck, responseCheck };
  },
  "session.mute": async (): Promise<
    MethodCheckPair<
      import("./session/methods.js").SessionTargetRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateSessionTargetRequest: requestCheck } =
      await import("./checks/session/methods.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "session.overview.read": async (): Promise<
    MethodCheckPair<
      import("./session/directory.js").SessionOverviewReadRequest,
      import("./session/directory.js").SessionOverviewReadResponse
    >
  > => {
    const { validateSessionOverviewReadRequest: requestCheck } =
      await import("./checks/session/directory.js");
    const { validateSessionOverviewReadResponse: responseCheck } =
      await import("./checks/session/directory.js");
    return { requestCheck, responseCheck };
  },
  "session.permissionLevel.update": async (): Promise<
    MethodCheckPair<
      import("./session/controls/methods.js").SessionPermissionLevelUpdateRequest,
      import("./session/controls/methods.js").SessionPermissionLevelUpdateResponse
    >
  > => {
    const { validateSessionPermissionLevelUpdateRequest: requestCheck } =
      await import("./checks/session/controls/methods.js");
    const { validateSessionPermissionLevelUpdateResponse: responseCheck } =
      await import("./checks/session/controls/methods.js");
    return { requestCheck, responseCheck };
  },
  "session.pin": async (): Promise<
    MethodCheckPair<
      import("./session/methods.js").SessionTargetRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateSessionTargetRequest: requestCheck } =
      await import("./checks/session/methods.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "session.reactivate": async (): Promise<
    MethodCheckPair<
      import("./session/methods.js").SessionTargetRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateSessionTargetRequest: requestCheck } =
      await import("./checks/session/methods.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "session.read": async (): Promise<
    MethodCheckPair<
      import("./session/methods.js").SessionReadRequest,
      import("./session/methods.js").SessionReadResponse
    >
  > => {
    const { validateSessionReadRequest: requestCheck } =
      await import("./checks/session/methods.js");
    const { validateSessionReadResponse: responseCheck } =
      await import("./checks/session/methods.js");
    return { requestCheck, responseCheck };
  },
  "session.recovery.continue": async (): Promise<
    MethodCheckPair<
      import("./session/methods.js").SessionTargetRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateSessionTargetRequest: requestCheck } =
      await import("./checks/session/methods.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "session.recovery.delete": async (): Promise<
    MethodCheckPair<
      import("./session/methods.js").SessionTargetRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateSessionTargetRequest: requestCheck } =
      await import("./checks/session/methods.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "session.rename": async (): Promise<
    MethodCheckPair<
      import("./session/methods.js").SessionRenameRequest,
      import("./session/methods.js").SessionRenameResponse
    >
  > => {
    const { validateSessionRenameRequest: requestCheck } =
      await import("./checks/session/methods.js");
    const { validateSessionRenameResponse: responseCheck } =
      await import("./checks/session/methods.js");
    return { requestCheck, responseCheck };
  },
  "session.restart": async (): Promise<
    MethodCheckPair<
      import("./session/methods.js").SessionTargetRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateSessionTargetRequest: requestCheck } =
      await import("./checks/session/methods.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "session.restore": async (): Promise<
    MethodCheckPair<
      import("./session/restore.js").SessionRestoreRequest,
      import("./session/restore.js").SessionRestoreOutcome
    >
  > => {
    const { validateSessionRestoreRequest: requestCheck } =
      await import("./checks/session/restore.js");
    const { validateSessionRestoreOutcome: responseCheck } =
      await import("./checks/session/restore.js");
    return { requestCheck, responseCheck };
  },
  "session.restore.preview": async (): Promise<
    MethodCheckPair<
      import("./session/restore.js").SessionRestorePreviewRequest,
      import("./session/restore.js").SessionRestorePreviewResponse
    >
  > => {
    const { validateSessionRestorePreviewRequest: requestCheck } =
      await import("./checks/session/restore.js");
    const { validateSessionRestorePreviewResponse: responseCheck } =
      await import("./checks/session/restore.js");
    return { requestCheck, responseCheck };
  },
  "session.reviewNote.add": async (): Promise<
    MethodCheckPair<
      import("./review-note.js").SessionReviewNoteAddRequest,
      import("./review-note.js").SessionReviewNoteResponse
    >
  > => {
    const { validateSessionReviewNoteAddRequest: requestCheck } =
      await import("./checks/review-note.js");
    const { validateSessionReviewNoteResponse: responseCheck } =
      await import("./checks/review-note.js");
    return { requestCheck, responseCheck };
  },
  "session.reviewNote.delete": async (): Promise<
    MethodCheckPair<
      import("./review-note.js").SessionReviewNoteDeleteRequest,
      import("./review-note.js").SessionReviewNoteDeleteResponse
    >
  > => {
    const { validateSessionReviewNoteDeleteRequest: requestCheck } =
      await import("./checks/review-note.js");
    const { validateSessionReviewNoteDeleteResponse: responseCheck } =
      await import("./checks/review-note.js");
    return { requestCheck, responseCheck };
  },
  "session.reviewNote.update": async (): Promise<
    MethodCheckPair<
      import("./review-note.js").SessionReviewNoteUpdateRequest,
      import("./review-note.js").SessionReviewNoteResponse
    >
  > => {
    const { validateSessionReviewNoteUpdateRequest: requestCheck } =
      await import("./checks/review-note.js");
    const { validateSessionReviewNoteResponse: responseCheck } =
      await import("./checks/review-note.js");
    return { requestCheck, responseCheck };
  },
  "session.search": async (): Promise<
    MethodCheckPair<
      import("./session/methods.js").SessionSearchRequest,
      import("./session/methods.js").SessionSearchResponse
    >
  > => {
    const { validateSessionSearchRequest: requestCheck } =
      await import("./checks/session/methods.js");
    const { validateSessionSearchResponse: responseCheck } =
      await import("./checks/session/methods.js");
    return { requestCheck, responseCheck };
  },
  "session.sideQuestion.ask": async (): Promise<
    MethodCheckPair<
      import("./session/controls/methods.js").SessionSideQuestionAskRequest,
      import("./session/controls/methods.js").SessionSideQuestionAskResponse
    >
  > => {
    const { validateSessionSideQuestionAskRequest: requestCheck } =
      await import("./checks/session/controls/methods.js");
    const { validateSessionSideQuestionAskResponse: responseCheck } =
      await import("./checks/session/controls/methods.js");
    return { requestCheck, responseCheck };
  },
  "session.snapshot.list": async (): Promise<
    MethodCheckPair<
      import("./session/restore.js").SessionSnapshotListRequest,
      import("./session/restore.js").SessionSnapshotListResponse
    >
  > => {
    const { validateSessionSnapshotListRequest: requestCheck } =
      await import("./checks/session/restore.js");
    const { validateSessionSnapshotListResponse: responseCheck } =
      await import("./checks/session/restore.js");
    return { requestCheck, responseCheck };
  },
  "session.spendLimit.update": async (): Promise<
    MethodCheckPair<
      import("./session/controls/methods.js").SessionSpendLimitUpdateRequest,
      import("./session/cost.js").SessionBudgetState
    >
  > => {
    const { validateSessionSpendLimitUpdateRequest: requestCheck } =
      await import("./checks/session/controls/methods.js");
    const { validateSessionBudgetState: responseCheck } = await import("./checks/session/cost.js");
    return { requestCheck, responseCheck };
  },
  "session.tag.add": async (): Promise<
    MethodCheckPair<
      import("./session/tags.js").SessionTagRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateSessionTagRequest: requestCheck } = await import("./checks/session/tags.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "session.tag.list": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./session/tags.js").SessionTagListResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateSessionTagListResponse: responseCheck } =
      await import("./checks/session/tags.js");
    return { requestCheck, responseCheck };
  },
  "session.tag.remove": async (): Promise<
    MethodCheckPair<
      import("./session/tags.js").SessionTagRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateSessionTagRequest: requestCheck } = await import("./checks/session/tags.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "session.tokensPerRun.update": async (): Promise<
    MethodCheckPair<
      import("./session/controls/methods.js").SessionTokensPerRunUpdateRequest,
      import("./session/cost.js").SessionBudgetState
    >
  > => {
    const { validateSessionTokensPerRunUpdateRequest: requestCheck } =
      await import("./checks/session/controls/methods.js");
    const { validateSessionBudgetState: responseCheck } = await import("./checks/session/cost.js");
    return { requestCheck, responseCheck };
  },
  "session.unmute": async (): Promise<
    MethodCheckPair<
      import("./session/methods.js").SessionTargetRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateSessionTargetRequest: requestCheck } =
      await import("./checks/session/methods.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "session.unpin": async (): Promise<
    MethodCheckPair<
      import("./session/methods.js").SessionTargetRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateSessionTargetRequest: requestCheck } =
      await import("./checks/session/methods.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "session.workingFolder.update": async (): Promise<
    MethodCheckPair<
      import("./session/directory.js").SessionWorkingFolderUpdateRequest,
      import("./session/directory.js").SessionWorkingFolderUpdateResponse
    >
  > => {
    const { validateSessionWorkingFolderUpdateRequest: requestCheck } =
      await import("./checks/session/directory.js");
    const { validateSessionWorkingFolderUpdateResponse: responseCheck } =
      await import("./checks/session/directory.js");
    return { requestCheck, responseCheck };
  },
  "skill.availability.update": async (): Promise<
    MethodCheckPair<
      import("./skill.js").SkillAvailabilityUpdateRequest,
      import("./skill.js").SkillAvailabilityUpdateResponse
    >
  > => {
    const { validateSkillAvailabilityUpdateRequest: requestCheck } =
      await import("./checks/skill.js");
    const { validateSkillAvailabilityUpdateResponse: responseCheck } =
      await import("./checks/skill.js");
    return { requestCheck, responseCheck };
  },
  "skill.callForm.read": async (): Promise<
    MethodCheckPair<
      import("./skill.js").SkillCallFormReadRequest,
      import("./skill.js").SkillCallFormReadResponse
    >
  > => {
    const { validateSkillCallFormReadRequest: requestCheck } = await import("./checks/skill.js");
    const { validateSkillCallFormReadResponse: responseCheck } = await import("./checks/skill.js");
    return { requestCheck, responseCheck };
  },
  "skill.create": async (): Promise<
    MethodCheckPair<
      import("./skill.js").SkillCreateRequest,
      import("./skill.js").SkillEntryResponse
    >
  > => {
    const { validateSkillCreateRequest: requestCheck } = await import("./checks/skill.js");
    const { validateSkillEntryResponse: responseCheck } = await import("./checks/skill.js");
    return { requestCheck, responseCheck };
  },
  "skill.file.read": async (): Promise<
    MethodCheckPair<
      import("./skill.js").SkillFileReadRequest,
      import("./skill.js").SkillFileReadResponse
    >
  > => {
    const { validateSkillFileReadRequest: requestCheck } = await import("./checks/skill.js");
    const { validateSkillFileReadResponse: responseCheck } = await import("./checks/skill.js");
    return { requestCheck, responseCheck };
  },
  "skill.list": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./skill.js").SkillListResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateSkillListResponse: responseCheck } = await import("./checks/skill.js");
    return { requestCheck, responseCheck };
  },
  "skill.record.discard": async (): Promise<
    MethodCheckPair<
      import("./skill.js").SkillRecordDiscardRequest,
      import("./skill.js").SkillRecordDiscardResponse
    >
  > => {
    const { validateSkillRecordDiscardRequest: requestCheck } = await import("./checks/skill.js");
    const { validateSkillRecordDiscardResponse: responseCheck } = await import("./checks/skill.js");
    return { requestCheck, responseCheck };
  },
  "skill.record.reattach": async (): Promise<
    MethodCheckPair<
      import("./skill.js").SkillRecordReattachRequest,
      import("./skill.js").SkillEntryResponse
    >
  > => {
    const { validateSkillRecordReattachRequest: requestCheck } = await import("./checks/skill.js");
    const { validateSkillEntryResponse: responseCheck } = await import("./checks/skill.js");
    return { requestCheck, responseCheck };
  },
  "skill.scan": async (): Promise<
    MethodCheckPair<import("./skill.js").SkillScanRequest, import("./skill.js").SkillScanResponse>
  > => {
    const { validateSkillScanRequest: requestCheck } = await import("./checks/skill.js");
    const { validateSkillScanResponse: responseCheck } = await import("./checks/skill.js");
    return { requestCheck, responseCheck };
  },
  "skill.update": async (): Promise<
    MethodCheckPair<
      import("./skill.js").SkillUpdateRequest,
      import("./skill.js").SkillEntryResponse
    >
  > => {
    const { validateSkillUpdateRequest: requestCheck } = await import("./checks/skill.js");
    const { validateSkillEntryResponse: responseCheck } = await import("./checks/skill.js");
    return { requestCheck, responseCheck };
  },
  "terminal.appearance.report": async (): Promise<
    MethodCheckPair<
      import("./terminal.js").TerminalAppearanceReportRequest,
      import("./method-descriptor.js").NullPayload
    >
  > => {
    const { validateTerminalAppearanceReportRequest: requestCheck } =
      await import("./checks/terminal.js");
    const { validateNullPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "terminal.close": async (): Promise<
    MethodCheckPair<
      import("./terminal.js").TerminalCloseRequest,
      import("./method-descriptor.js").NullPayload
    >
  > => {
    const { validateTerminalCloseRequest: requestCheck } = await import("./checks/terminal.js");
    const { validateNullPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "terminal.control.take": async (): Promise<
    MethodCheckPair<
      import("./terminal.js").TerminalControlTakeRequest,
      import("./terminal.js").TerminalControlTakeResponse
    >
  > => {
    const { validateTerminalControlTakeRequest: requestCheck } =
      await import("./checks/terminal.js");
    const { validateTerminalControlTakeResponse: responseCheck } =
      await import("./checks/terminal.js");
    return { requestCheck, responseCheck };
  },
  "terminal.flowControl.update": async (): Promise<
    MethodCheckPair<
      import("./terminal.js").TerminalFlowControlUpdateRequest,
      import("./terminal.js").TerminalFlowControlUpdateResponse
    >
  > => {
    const { validateTerminalFlowControlUpdateRequest: requestCheck } =
      await import("./checks/terminal.js");
    const { validateTerminalFlowControlUpdateResponse: responseCheck } =
      await import("./checks/terminal.js");
    return { requestCheck, responseCheck };
  },
  "terminal.open": async (): Promise<
    MethodCheckPair<
      import("./terminal.js").TerminalOpenRequest,
      import("./terminal.js").TerminalOpenResponse
    >
  > => {
    const { validateTerminalOpenRequest: requestCheck } = await import("./checks/terminal.js");
    const { validateTerminalOpenResponse: responseCheck } = await import("./checks/terminal.js");
    return { requestCheck, responseCheck };
  },
  "terminal.reorder": async (): Promise<
    MethodCheckPair<
      import("./terminal.js").TerminalReorderRequest,
      import("./method-descriptor.js").NullPayload
    >
  > => {
    const { validateTerminalReorderRequest: requestCheck } = await import("./checks/terminal.js");
    const { validateNullPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "terminal.resize": async (): Promise<
    MethodCheckPair<
      import("./terminal.js").TerminalResizeRequest,
      import("./method-descriptor.js").NullPayload
    >
  > => {
    const { validateTerminalResizeRequest: requestCheck } = await import("./checks/terminal.js");
    const { validateNullPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "terminal.write": async (): Promise<
    MethodCheckPair<
      import("./terminal.js").TerminalWriteRequest,
      import("./method-descriptor.js").NullPayload
    >
  > => {
    const { validateTerminalWriteRequest: requestCheck } = await import("./checks/terminal.js");
    const { validateNullPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "transcript.body.read": async (): Promise<
    MethodCheckPair<
      import("./transcript/operations.js").TranscriptBodyReadRequest,
      import("./transcript/operations.js").TranscriptBodyReadResponse
    >
  > => {
    const { validateTranscriptBodyReadRequest: requestCheck } =
      await import("./checks/transcript/operations.js");
    const { validateTranscriptBodyReadResponse: responseCheck } =
      await import("./checks/transcript/operations.js");
    return { requestCheck, responseCheck };
  },
  "transcript.childRun.expand": async (): Promise<
    MethodCheckPair<
      import("./transcript/operations.js").TranscriptChildRunExpandRequest,
      import("./transcript/operations.js").TranscriptChildRunExpandResponse
    >
  > => {
    const { validateTranscriptChildRunExpandRequest: requestCheck } =
      await import("./checks/transcript/operations.js");
    const { validateTranscriptChildRunExpandResponse: responseCheck } =
      await import("./checks/transcript/operations.js");
    return { requestCheck, responseCheck };
  },
  "transcript.patch.list": async (): Promise<
    MethodCheckPair<
      import("./transcript/operations.js").TranscriptPatchListRequest,
      import("./transcript/operations.js").TranscriptPatchListResponse
    >
  > => {
    const { validateTranscriptPatchListRequest: requestCheck } =
      await import("./checks/transcript/operations.js");
    const { validateTranscriptPatchListResponse: responseCheck } =
      await import("./checks/transcript/operations.js");
    return { requestCheck, responseCheck };
  },
  "transcript.read": async (): Promise<
    MethodCheckPair<
      import("./transcript/operations.js").TranscriptReadRequest,
      import("./transcript/operations.js").TranscriptReadResponse
    >
  > => {
    const { validateTranscriptReadRequest: requestCheck } =
      await import("./checks/transcript/operations.js");
    const { validateTranscriptReadResponse: responseCheck } =
      await import("./checks/transcript/operations.js");
    return { requestCheck, responseCheck };
  },
  "transcript.reasoning.read": async (): Promise<
    MethodCheckPair<
      import("./transcript/operations.js").TranscriptReasoningReadRequest,
      import("./transcript/operations.js").TranscriptReasoningReadResponse
    >
  > => {
    const { validateTranscriptReasoningReadRequest: requestCheck } =
      await import("./checks/transcript/operations.js");
    const { validateTranscriptReasoningReadResponse: responseCheck } =
      await import("./checks/transcript/operations.js");
    return { requestCheck, responseCheck };
  },
  "transcript.search": async (): Promise<
    MethodCheckPair<
      import("./transcript/search.js").TranscriptSearchRequest,
      import("./transcript/search.js").TranscriptSearchResponse
    >
  > => {
    const { validateTranscriptSearchRequest: requestCheck } =
      await import("./checks/transcript/search.js");
    const { validateTranscriptSearchResponse: responseCheck } =
      await import("./checks/transcript/search.js");
    return { requestCheck, responseCheck };
  },
  "voice.call.start": async (): Promise<
    MethodCheckPair<
      import("./voice.js").VoiceCallStartRequest,
      import("./voice.js").VoiceCallStartResponse
    >
  > => {
    const { validateVoiceCallStartRequest: requestCheck } = await import("./checks/voice.js");
    const { validateVoiceCallStartResponse: responseCheck } = await import("./checks/voice.js");
    return { requestCheck, responseCheck };
  },
  "voice.call.stop": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "voice.dictation.start": async (): Promise<
    MethodCheckPair<
      import("./voice.js").VoiceDictationStartRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateVoiceDictationStartRequest: requestCheck } = await import("./checks/voice.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "voice.dictation.stop": async (): Promise<
    MethodCheckPair<
      import("./voice.js").VoiceDictationStopRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateVoiceDictationStopRequest: requestCheck } = await import("./checks/voice.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "voice.dictation.write": async (): Promise<
    MethodCheckPair<
      import("./voice.js").VoiceDictationWriteRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateVoiceDictationWriteRequest: requestCheck } = await import("./checks/voice.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "voice.list": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./voice.js").VoiceListResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateVoiceListResponse: responseCheck } = await import("./checks/voice.js");
    return { requestCheck, responseCheck };
  },
  "voice.state.update": async (): Promise<
    MethodCheckPair<import("./voice.js").VoiceState, import("./voice.js").VoiceState>
  > => {
    const { validateVoiceState: requestCheck } = await import("./checks/voice.js");
    const { validateVoiceState: responseCheck } = await import("./checks/voice.js");
    return { requestCheck, responseCheck };
  },
  "webauthn.authentication.verify": async (): Promise<
    MethodCheckPair<
      import("./webauthn/ceremony.js").WebAuthnAuthenticationVerifyRequest,
      import("./webauthn/ceremony.js").WebAuthnAuthenticationVerifyResponse
    >
  > => {
    const { validateWebAuthnAuthenticationVerifyRequest: requestCheck } =
      await import("./checks/webauthn/ceremony.js");
    const { validateWebAuthnAuthenticationVerifyResponse: responseCheck } =
      await import("./checks/webauthn/ceremony.js");
    return { requestCheck, responseCheck };
  },
  "webauthn.authenticationOptions.issue": async (): Promise<
    MethodCheckPair<
      import("./webauthn/ceremony.js").WebAuthnAuthenticationOptionsIssueRequest,
      import("./webauthn/ceremony.js").WebAuthnAuthenticationOptionsIssueResponse
    >
  > => {
    const { validateWebAuthnAuthenticationOptionsIssueRequest: requestCheck } =
      await import("./checks/webauthn/ceremony.js");
    const { validateWebAuthnAuthenticationOptionsIssueResponse: responseCheck } =
      await import("./checks/webauthn/ceremony.js");
    return { requestCheck, responseCheck };
  },
  "webauthn.credential.revoke": async (): Promise<
    MethodCheckPair<
      import("./webauthn/credential.js").WebAuthnCredentialRevokeRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateWebAuthnCredentialRevokeRequest: requestCheck } =
      await import("./checks/webauthn/credential.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "webauthn.registration.verify": async (): Promise<
    MethodCheckPair<
      import("./webauthn/ceremony.js").WebAuthnRegistrationVerifyRequest,
      import("./webauthn/ceremony.js").WebAuthnRegistrationVerifyResponse
    >
  > => {
    const { validateWebAuthnRegistrationVerifyRequest: requestCheck } =
      await import("./checks/webauthn/ceremony.js");
    const { validateWebAuthnRegistrationVerifyResponse: responseCheck } =
      await import("./checks/webauthn/ceremony.js");
    return { requestCheck, responseCheck };
  },
  "webauthn.registrationOptions.issue": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./webauthn/ceremony.js").WebAuthnRegistrationOptionsIssueResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateWebAuthnRegistrationOptionsIssueResponse: responseCheck } =
      await import("./checks/webauthn/ceremony.js");
    return { requestCheck, responseCheck };
  },
  "workflow.backgroundBrowser.update": async (): Promise<
    MethodCheckPair<
      import("./workflow/definition/builder.js").WorkflowBackgroundBrowserUpdateRequest,
      import("./workflow/definition/builder.js").WorkflowBackgroundBrowserUpdateResponse
    >
  > => {
    const { validateWorkflowBackgroundBrowserUpdateRequest: requestCheck } =
      await import("./checks/workflow/definition/builder.js");
    const { validateWorkflowBackgroundBrowserUpdateResponse: responseCheck } =
      await import("./checks/workflow/definition/builder.js");
    return { requestCheck, responseCheck };
  },
  "workflow.definition.create": async (): Promise<
    MethodCheckPair<
      import("./workflow/definition/methods.js").WorkflowDefinitionCreateRequest,
      import("./workflow/definition/methods.js").WorkflowDefinitionCreateResponse
    >
  > => {
    const { validateWorkflowDefinitionCreateRequest: requestCheck } =
      await import("./checks/workflow/definition/methods.js");
    const { validateWorkflowDefinitionCreateResponse: responseCheck } =
      await import("./checks/workflow/definition/methods.js");
    return { requestCheck, responseCheck };
  },
  "workflow.definition.delete": async (): Promise<
    MethodCheckPair<
      import("./workflow/definition/methods.js").WorkflowDefinitionDeleteRequest,
      import("./workflow/definition/methods.js").WorkflowDefinitionDeleteResponse
    >
  > => {
    const { validateWorkflowDefinitionDeleteRequest: requestCheck } =
      await import("./checks/workflow/definition/methods.js");
    const { validateWorkflowDefinitionDeleteResponse: responseCheck } =
      await import("./checks/workflow/definition/methods.js");
    return { requestCheck, responseCheck };
  },
  "workflow.definition.export": async (): Promise<
    MethodCheckPair<
      import("./workflow/definition/methods.js").WorkflowDefinitionExportRequest,
      import("./workflow/definition/methods.js").WorkflowDefinitionExportResponse
    >
  > => {
    const { validateWorkflowDefinitionExportRequest: requestCheck } =
      await import("./checks/workflow/definition/methods.js");
    const { validateWorkflowDefinitionExportResponse: responseCheck } =
      await import("./checks/workflow/definition/methods.js");
    return { requestCheck, responseCheck };
  },
  "workflow.definition.import": async (): Promise<
    MethodCheckPair<
      import("./workflow/definition/methods.js").WorkflowDefinitionImportRequest,
      import("./workflow/definition/methods.js").WorkflowDefinitionCreateResponse
    >
  > => {
    const { validateWorkflowDefinitionImportRequest: requestCheck } =
      await import("./checks/workflow/definition/methods.js");
    const { validateWorkflowDefinitionCreateResponse: responseCheck } =
      await import("./checks/workflow/definition/methods.js");
    return { requestCheck, responseCheck };
  },
  "workflow.definition.list": async (): Promise<
    MethodCheckPair<
      import("./workflow/definition/methods.js").WorkflowDefinitionListRequest,
      import("./workflow/definition/methods.js").WorkflowDefinitionListResponse
    >
  > => {
    const { validateWorkflowDefinitionListRequest: requestCheck } =
      await import("./checks/workflow/definition/methods.js");
    const { validateWorkflowDefinitionListResponse: responseCheck } =
      await import("./checks/workflow/definition/methods.js");
    return { requestCheck, responseCheck };
  },
  "workflow.definition.read": async (): Promise<
    MethodCheckPair<
      import("./workflow/definition/methods.js").WorkflowDefinitionReadRequest,
      import("./workflow/definition/methods.js").WorkflowDefinitionReadResponse
    >
  > => {
    const { validateWorkflowDefinitionReadRequest: requestCheck } =
      await import("./checks/workflow/definition/methods.js");
    const { validateWorkflowDefinitionReadResponse: responseCheck } =
      await import("./checks/workflow/definition/methods.js");
    return { requestCheck, responseCheck };
  },
  "workflow.definition.update": async (): Promise<
    MethodCheckPair<
      import("./workflow/definition/methods.js").WorkflowDefinitionUpdateRequest,
      import("./workflow/definition/methods.js").WorkflowDefinitionUpdateResponse
    >
  > => {
    const { validateWorkflowDefinitionUpdateRequest: requestCheck } =
      await import("./checks/workflow/definition/methods.js");
    const { validateWorkflowDefinitionUpdateResponse: responseCheck } =
      await import("./checks/workflow/definition/methods.js");
    return { requestCheck, responseCheck };
  },
  "workflow.draft.read": async (): Promise<
    MethodCheckPair<
      import("./workflow/definition/builder.js").WorkflowDraftReadRequest,
      import("./workflow/definition/builder.js").WorkflowDraftReadResponse
    >
  > => {
    const { validateWorkflowDraftReadRequest: requestCheck } =
      await import("./checks/workflow/definition/builder.js");
    const { validateWorkflowDraftReadResponse: responseCheck } =
      await import("./checks/workflow/definition/builder.js");
    return { requestCheck, responseCheck };
  },
  "workflow.draft.update": async (): Promise<
    MethodCheckPair<
      import("./workflow/definition/builder.js").WorkflowDraftUpdateRequest,
      import("./workflow/definition/builder.js").WorkflowDraftUpdateResponse
    >
  > => {
    const { validateWorkflowDraftUpdateRequest: requestCheck } =
      await import("./checks/workflow/definition/builder.js");
    const { validateWorkflowDraftUpdateResponse: responseCheck } =
      await import("./checks/workflow/definition/builder.js");
    return { requestCheck, responseCheck };
  },
  "workflow.enabled.update": async (): Promise<
    MethodCheckPair<
      import("./workflow/definition/builder.js").WorkflowEnabledUpdateRequest,
      import("./workflow/definition/builder.js").WorkflowEnabledUpdateResponse
    >
  > => {
    const { validateWorkflowEnabledUpdateRequest: requestCheck } =
      await import("./checks/workflow/definition/builder.js");
    const { validateWorkflowEnabledUpdateResponse: responseCheck } =
      await import("./checks/workflow/definition/builder.js");
    return { requestCheck, responseCheck };
  },
  "workflow.expression.preview": async (): Promise<
    MethodCheckPair<
      import("./workflow/definition/builder.js").WorkflowExpressionPreviewRequest,
      import("./workflow/definition/builder.js").WorkflowExpressionPreviewResponse
    >
  > => {
    const { validateWorkflowExpressionPreviewRequest: requestCheck } =
      await import("./checks/workflow/definition/builder.js");
    const { validateWorkflowExpressionPreviewResponse: responseCheck } =
      await import("./checks/workflow/definition/builder.js");
    return { requestCheck, responseCheck };
  },
  "workflow.fixSession.create": async (): Promise<
    MethodCheckPair<
      import("./workflow/run/step/record.js").WorkflowStepKey,
      import("./workflow/run/step/methods.js").WorkflowFixSessionCreateResponse
    >
  > => {
    const { validateWorkflowStepKey: requestCheck } =
      await import("./checks/workflow/run/step/record.js");
    const { validateWorkflowFixSessionCreateResponse: responseCheck } =
      await import("./checks/workflow/run/step/methods.js");
    return { requestCheck, responseCheck };
  },
  "workflow.gate.resolve": async (): Promise<
    MethodCheckPair<
      import("./workflow/run/step/methods.js").WorkflowGateResolveRequest,
      import("./workflow/run/step/methods.js").WorkflowGateResolveResponse
    >
  > => {
    const { validateWorkflowGateResolveRequest: requestCheck } =
      await import("./checks/workflow/run/step/methods.js");
    const { validateWorkflowGateResolveResponse: responseCheck } =
      await import("./checks/workflow/run/step/methods.js");
    return { requestCheck, responseCheck };
  },
  "workflow.humanForm.draft.update": async (): Promise<
    MethodCheckPair<
      import("./workflow/run/step/methods.js").WorkflowHumanFormDraftUpdateRequest,
      import("./workflow/run/step/methods.js").WorkflowHumanFormDraftUpdateResponse
    >
  > => {
    const { validateWorkflowHumanFormDraftUpdateRequest: requestCheck } =
      await import("./checks/workflow/run/step/methods.js");
    const { validateWorkflowHumanFormDraftUpdateResponse: responseCheck } =
      await import("./checks/workflow/run/step/methods.js");
    return { requestCheck, responseCheck };
  },
  "workflow.humanForm.read": async (): Promise<
    MethodCheckPair<
      import("./workflow/run/step/record.js").WorkflowStepKey,
      import("./workflow/run/step/methods.js").WorkflowHumanFormReadResponse
    >
  > => {
    const { validateWorkflowStepKey: requestCheck } =
      await import("./checks/workflow/run/step/record.js");
    const { validateWorkflowHumanFormReadResponse: responseCheck } =
      await import("./checks/workflow/run/step/methods.js");
    return { requestCheck, responseCheck };
  },
  "workflow.humanForm.submit": async (): Promise<
    MethodCheckPair<
      import("./workflow/run/step/methods.js").WorkflowHumanFormSubmitRequest,
      import("./workflow/run/step/methods.js").WorkflowHumanFormSubmitResponse
    >
  > => {
    const { validateWorkflowHumanFormSubmitRequest: requestCheck } =
      await import("./checks/workflow/run/step/methods.js");
    const { validateWorkflowHumanFormSubmitResponse: responseCheck } =
      await import("./checks/workflow/run/step/methods.js");
    return { requestCheck, responseCheck };
  },
  "workflow.keptValue.clear": async (): Promise<
    MethodCheckPair<
      import("./workflow/kept-values.js").WorkflowKeptValueClearRequest,
      import("./workflow/kept-values.js").WorkflowKeptValueClearResponse
    >
  > => {
    const { validateWorkflowKeptValueClearRequest: requestCheck } =
      await import("./checks/workflow/kept-values.js");
    const { validateWorkflowKeptValueClearResponse: responseCheck } =
      await import("./checks/workflow/kept-values.js");
    return { requestCheck, responseCheck };
  },
  "workflow.kind.list": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./workflow/kind.js").WorkflowKindListResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateWorkflowKindListResponse: responseCheck } =
      await import("./checks/workflow/kind.js");
    return { requestCheck, responseCheck };
  },
  "workflow.layout.update": async (): Promise<
    MethodCheckPair<
      import("./workflow/definition/builder.js").WorkflowLayoutUpdateRequest,
      import("./workflow/definition/builder.js").WorkflowDefinitionSettingResponse
    >
  > => {
    const { validateWorkflowLayoutUpdateRequest: requestCheck } =
      await import("./checks/workflow/definition/builder.js");
    const { validateWorkflowDefinitionSettingResponse: responseCheck } =
      await import("./checks/workflow/definition/builder.js");
    return { requestCheck, responseCheck };
  },
  "workflow.newRunHold.update": async (): Promise<
    MethodCheckPair<
      import("./workflow/run/new-run-hold.js").WorkflowNewRunHoldUpdateRequest,
      import("./workflow/run/new-run-hold.js").WorkflowNewRunHoldState
    >
  > => {
    const { validateWorkflowNewRunHoldUpdateRequest: requestCheck } =
      await import("./checks/workflow/run/new-run-hold.js");
    const { validateWorkflowNewRunHoldState: responseCheck } =
      await import("./checks/workflow/run/new-run-hold.js");
    return { requestCheck, responseCheck };
  },
  "workflow.node.execute": async (): Promise<
    MethodCheckPair<
      import("./workflow/run/control.js").WorkflowNodeExecuteRequest,
      import("./workflow/run/control.js").WorkflowNodeExecuteResponse
    >
  > => {
    const { validateWorkflowNodeExecuteRequest: requestCheck } =
      await import("./checks/workflow/run/control.js");
    const { validateWorkflowNodeExecuteResponse: responseCheck } =
      await import("./checks/workflow/run/control.js");
    return { requestCheck, responseCheck };
  },
  "workflow.permissionLevel.update": async (): Promise<
    MethodCheckPair<
      import("./workflow/definition/builder.js").WorkflowPermissionLevelUpdateRequest,
      import("./workflow/definition/builder.js").WorkflowPermissionLevelUpdateResponse
    >
  > => {
    const { validateWorkflowPermissionLevelUpdateRequest: requestCheck } =
      await import("./checks/workflow/definition/builder.js");
    const { validateWorkflowPermissionLevelUpdateResponse: responseCheck } =
      await import("./checks/workflow/definition/builder.js");
    return { requestCheck, responseCheck };
  },
  "workflow.pinData.update": async (): Promise<
    MethodCheckPair<
      import("./workflow/definition/builder.js").WorkflowPinDataUpdateRequest,
      import("./workflow/definition/builder.js").WorkflowPinDataUpdateResponse
    >
  > => {
    const { validateWorkflowPinDataUpdateRequest: requestCheck } =
      await import("./checks/workflow/definition/builder.js");
    const { validateWorkflowPinDataUpdateResponse: responseCheck } =
      await import("./checks/workflow/definition/builder.js");
    return { requestCheck, responseCheck };
  },
  "workflow.provider.update": async (): Promise<
    MethodCheckPair<
      import("./workflow/definition/builder.js").WorkflowProviderUpdateRequest,
      import("./workflow/definition/builder.js").WorkflowProviderUpdateResponse
    >
  > => {
    const { validateWorkflowProviderUpdateRequest: requestCheck } =
      await import("./checks/workflow/definition/builder.js");
    const { validateWorkflowProviderUpdateResponse: responseCheck } =
      await import("./checks/workflow/definition/builder.js");
    return { requestCheck, responseCheck };
  },
  "workflow.results.post": async (): Promise<
    MethodCheckPair<
      import("./workflow/run/control.js").WorkflowResultsPostRequest,
      import("./workflow/run/control.js").WorkflowResultsPostResponse
    >
  > => {
    const { validateWorkflowResultsPostRequest: requestCheck } =
      await import("./checks/workflow/run/control.js");
    const { validateWorkflowResultsPostResponse: responseCheck } =
      await import("./checks/workflow/run/control.js");
    return { requestCheck, responseCheck };
  },
  "workflow.run.attention.list": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./workflow/run/attention.js").WorkflowRunAttentionListResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateWorkflowRunAttentionListResponse: responseCheck } =
      await import("./checks/workflow/run/attention.js");
    return { requestCheck, responseCheck };
  },
  "workflow.run.cancel": async (): Promise<
    MethodCheckPair<
      import("./workflow/run/control.js").WorkflowRunCancelRequest,
      import("./workflow/run/control.js").WorkflowRunCancelResponse
    >
  > => {
    const { validateWorkflowRunCancelRequest: requestCheck } =
      await import("./checks/workflow/run/control.js");
    const { validateWorkflowRunCancelResponse: responseCheck } =
      await import("./checks/workflow/run/control.js");
    return { requestCheck, responseCheck };
  },
  "workflow.run.delete": async (): Promise<
    MethodCheckPair<
      import("./workflow/run/retention.js").WorkflowRunDeleteRequest,
      import("./workflow/run/retention.js").WorkflowRunDeleteResponse
    >
  > => {
    const { validateWorkflowRunDeleteRequest: requestCheck } =
      await import("./checks/workflow/run/retention.js");
    const { validateWorkflowRunDeleteResponse: responseCheck } =
      await import("./checks/workflow/run/retention.js");
    return { requestCheck, responseCheck };
  },
  "workflow.run.keep.update": async (): Promise<
    MethodCheckPair<
      import("./workflow/run/retention.js").WorkflowRunKeepSet,
      import("./workflow/run/retention.js").WorkflowRunKeepSet
    >
  > => {
    const { validateWorkflowRunKeepSet: requestCheck } =
      await import("./checks/workflow/run/retention.js");
    const { validateWorkflowRunKeepSet: responseCheck } =
      await import("./checks/workflow/run/retention.js");
    return { requestCheck, responseCheck };
  },
  "workflow.run.list": async (): Promise<
    MethodCheckPair<
      import("./workflow/run/list.js").WorkflowRunListRequest,
      import("./workflow/run/list.js").WorkflowRunListResponse
    >
  > => {
    const { validateWorkflowRunListRequest: requestCheck } =
      await import("./checks/workflow/run/list.js");
    const { validateWorkflowRunListResponse: responseCheck } =
      await import("./checks/workflow/run/list.js");
    return { requestCheck, responseCheck };
  },
  "workflow.run.purge": async (): Promise<
    MethodCheckPair<
      import("./workflow/run/retention.js").WorkflowRunPurgeRequest,
      import("./workflow/run/retention.js").WorkflowRunPurgeResponse
    >
  > => {
    const { validateWorkflowRunPurgeRequest: requestCheck } =
      await import("./checks/workflow/run/retention.js");
    const { validateWorkflowRunPurgeResponse: responseCheck } =
      await import("./checks/workflow/run/retention.js");
    return { requestCheck, responseCheck };
  },
  "workflow.run.purge.preview": async (): Promise<
    MethodCheckPair<
      import("./workflow/run/retention.js").WorkflowRunPurgeRequest,
      import("./workflow/run/retention.js").WorkflowRunPurgePreviewResponse
    >
  > => {
    const { validateWorkflowRunPurgeRequest: requestCheck } =
      await import("./checks/workflow/run/retention.js");
    const { validateWorkflowRunPurgePreviewResponse: responseCheck } =
      await import("./checks/workflow/run/retention.js");
    return { requestCheck, responseCheck };
  },
  "workflow.run.read": async (): Promise<
    MethodCheckPair<
      import("./workflow/run/records.js").WorkflowRunReadRequest,
      import("./workflow/run/records.js").WorkflowRunReadResponse
    >
  > => {
    const { validateWorkflowRunReadRequest: requestCheck } =
      await import("./checks/workflow/run/records.js");
    const { validateWorkflowRunReadResponse: responseCheck } =
      await import("./checks/workflow/run/records.js");
    return { requestCheck, responseCheck };
  },
  "workflow.run.rerun": async (): Promise<
    MethodCheckPair<
      import("./workflow/run/control.js").WorkflowRunRerunRequest,
      import("./workflow/run/control.js").WorkflowRunStartResponse
    >
  > => {
    const { validateWorkflowRunRerunRequest: requestCheck } =
      await import("./checks/workflow/run/control.js");
    const { validateWorkflowRunStartResponse: responseCheck } =
      await import("./checks/workflow/run/control.js");
    return { requestCheck, responseCheck };
  },
  "workflow.run.resume": async (): Promise<
    MethodCheckPair<
      import("./workflow/run/control.js").WorkflowRunResumeRequest,
      import("./workflow/run/control.js").WorkflowRunResumeResponse
    >
  > => {
    const { validateWorkflowRunResumeRequest: requestCheck } =
      await import("./checks/workflow/run/control.js");
    const { validateWorkflowRunResumeResponse: responseCheck } =
      await import("./checks/workflow/run/control.js");
    return { requestCheck, responseCheck };
  },
  "workflow.run.retry": async (): Promise<
    MethodCheckPair<
      import("./workflow/run/control.js").WorkflowRunRetryRequest,
      import("./workflow/run/control.js").WorkflowRunRetryResponse
    >
  > => {
    const { validateWorkflowRunRetryRequest: requestCheck } =
      await import("./checks/workflow/run/control.js");
    const { validateWorkflowRunRetryResponse: responseCheck } =
      await import("./checks/workflow/run/control.js");
    return { requestCheck, responseCheck };
  },
  "workflow.run.start": async (): Promise<
    MethodCheckPair<
      import("./workflow/run/control.js").WorkflowRunStartRequest,
      import("./workflow/run/control.js").WorkflowRunStartResponse
    >
  > => {
    const { validateWorkflowRunStartRequest: requestCheck } =
      await import("./checks/workflow/run/control.js");
    const { validateWorkflowRunStartResponse: responseCheck } =
      await import("./checks/workflow/run/control.js");
    return { requestCheck, responseCheck };
  },
  "workflow.secret.create": async (): Promise<
    MethodCheckPair<
      import("./workflow/secret.js").WorkflowSecretCreateRequest,
      import("./workflow/secret.js").WorkflowSecretSummary
    >
  > => {
    const { validateWorkflowSecretCreateRequest: requestCheck } =
      await import("./checks/workflow/secret.js");
    const { validateWorkflowSecretSummary: responseCheck } =
      await import("./checks/workflow/secret.js");
    return { requestCheck, responseCheck };
  },
  "workflow.secret.delete": async (): Promise<
    MethodCheckPair<
      import("./workflow/secret.js").WorkflowSecretDeleteRequest,
      import("./workflow/secret.js").WorkflowSecretActResponse
    >
  > => {
    const { validateWorkflowSecretDeleteRequest: requestCheck } =
      await import("./checks/workflow/secret.js");
    const { validateWorkflowSecretActResponse: responseCheck } =
      await import("./checks/workflow/secret.js");
    return { requestCheck, responseCheck };
  },
  "workflow.secret.list": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./workflow/secret.js").WorkflowSecretListResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateWorkflowSecretListResponse: responseCheck } =
      await import("./checks/workflow/secret.js");
    return { requestCheck, responseCheck };
  },
  "workflow.secret.update": async (): Promise<
    MethodCheckPair<
      import("./workflow/secret.js").WorkflowSecretUpdateRequest,
      import("./workflow/secret.js").WorkflowSecretActResponse
    >
  > => {
    const { validateWorkflowSecretUpdateRequest: requestCheck } =
      await import("./checks/workflow/secret.js");
    const { validateWorkflowSecretActResponse: responseCheck } =
      await import("./checks/workflow/secret.js");
    return { requestCheck, responseCheck };
  },
  "workflow.step.output.list": async (): Promise<
    MethodCheckPair<
      import("./workflow/run/step/methods.js").WorkflowStepOutputListRequest,
      import("./workflow/run/step/methods.js").WorkflowStepOutputListResponse
    >
  > => {
    const { validateWorkflowStepOutputListRequest: requestCheck } =
      await import("./checks/workflow/run/step/methods.js");
    const { validateWorkflowStepOutputListResponse: responseCheck } =
      await import("./checks/workflow/run/step/methods.js");
    return { requestCheck, responseCheck };
  },
  "workflow.step.read": async (): Promise<
    MethodCheckPair<
      import("./workflow/run/step/methods.js").WorkflowStepReadRequest,
      import("./workflow/run/step/methods.js").WorkflowStepReadResponse
    >
  > => {
    const { validateWorkflowStepReadRequest: requestCheck } =
      await import("./checks/workflow/run/step/methods.js");
    const { validateWorkflowStepReadResponse: responseCheck } =
      await import("./checks/workflow/run/step/methods.js");
    return { requestCheck, responseCheck };
  },
  "workflow.step.tabArtifact.create": async (): Promise<
    MethodCheckPair<
      import("./workflow/run/step/methods.js").WorkflowStepTabArtifactCreateRequest,
      import("./workflow/run/step/methods.js").WorkflowStepTabArtifactCreateResponse
    >
  > => {
    const { validateWorkflowStepTabArtifactCreateRequest: requestCheck } =
      await import("./checks/workflow/run/step/methods.js");
    const { validateWorkflowStepTabArtifactCreateResponse: responseCheck } =
      await import("./checks/workflow/run/step/methods.js");
    return { requestCheck, responseCheck };
  },
  "workflow.tags.update": async (): Promise<
    MethodCheckPair<
      import("./workflow/definition/builder.js").WorkflowTagsUpdateRequest,
      import("./workflow/definition/builder.js").WorkflowDefinitionSettingResponse
    >
  > => {
    const { validateWorkflowTagsUpdateRequest: requestCheck } =
      await import("./checks/workflow/definition/builder.js");
    const { validateWorkflowDefinitionSettingResponse: responseCheck } =
      await import("./checks/workflow/definition/builder.js");
    return { requestCheck, responseCheck };
  },
  "workflow.version.diff.read": async (): Promise<
    MethodCheckPair<
      import("./workflow/definition/versions.js").WorkflowVersionDiffReadRequest,
      import("./workflow/definition/versions.js").WorkflowVersionDiffReadResponse
    >
  > => {
    const { validateWorkflowVersionDiffReadRequest: requestCheck } =
      await import("./checks/workflow/definition/versions.js");
    const { validateWorkflowVersionDiffReadResponse: responseCheck } =
      await import("./checks/workflow/definition/versions.js");
    return { requestCheck, responseCheck };
  },
  "workflow.version.list": async (): Promise<
    MethodCheckPair<
      import("./workflow/definition/versions.js").WorkflowVersionListRequest,
      import("./workflow/definition/versions.js").WorkflowVersionListResponse
    >
  > => {
    const { validateWorkflowVersionListRequest: requestCheck } =
      await import("./checks/workflow/definition/versions.js");
    const { validateWorkflowVersionListResponse: responseCheck } =
      await import("./checks/workflow/definition/versions.js");
    return { requestCheck, responseCheck };
  },
  "workflow.version.read": async (): Promise<
    MethodCheckPair<
      import("./workflow/definition/versions.js").WorkflowVersionReadRequest,
      import("./workflow/definition/versions.js").WorkflowVersionReadResponse
    >
  > => {
    const { validateWorkflowVersionReadRequest: requestCheck } =
      await import("./checks/workflow/definition/versions.js");
    const { validateWorkflowVersionReadResponse: responseCheck } =
      await import("./checks/workflow/definition/versions.js");
    return { requestCheck, responseCheck };
  },
  "workflow.webhookListener.read": async (): Promise<
    MethodCheckPair<
      import("./method-descriptor.js").EmptyPayload,
      import("./workflow/definition/builder.js").WorkflowWebhookListenerReadResponse
    >
  > => {
    const { validateEmptyPayload: requestCheck } = await import("./checks/method-descriptor.js");
    const { validateWorkflowWebhookListenerReadResponse: responseCheck } =
      await import("./checks/workflow/definition/builder.js");
    return { requestCheck, responseCheck };
  },
  "workflow.webhookToken.rotate": async (): Promise<
    MethodCheckPair<
      import("./workflow/definition/builder.js").WorkflowWebhookTokenRotateRequest,
      import("./workflow/definition/builder.js").WorkflowWebhookTokenRotateResponse
    >
  > => {
    const { validateWorkflowWebhookTokenRotateRequest: requestCheck } =
      await import("./checks/workflow/definition/builder.js");
    const { validateWorkflowWebhookTokenRotateResponse: responseCheck } =
      await import("./checks/workflow/definition/builder.js");
    return { requestCheck, responseCheck };
  },
  "workspace.bind": async (): Promise<
    MethodCheckPair<
      import("./repo/workspace.js").WorkspaceBindRequest,
      import("./repo/workspace.js").WorkspaceBindResponse
    >
  > => {
    const { validateWorkspaceBindRequest: requestCheck } =
      await import("./checks/repo/workspace.js");
    const { validateWorkspaceBindResponse: responseCheck } =
      await import("./checks/repo/workspace.js");
    return { requestCheck, responseCheck };
  },
  "workspace.executionRoot.prepare": async (): Promise<
    MethodCheckPair<
      import("./worktree/lifecycle.js").WorkspaceExecutionRootPrepareRequest,
      import("./worktree/lifecycle.js").WorkspaceExecutionRootPrepareResponse
    >
  > => {
    const { validateWorkspaceExecutionRootPrepareRequest: requestCheck } =
      await import("./checks/worktree/lifecycle.js");
    const { validateWorkspaceExecutionRootPrepareResponse: responseCheck } =
      await import("./checks/worktree/lifecycle.js");
    return { requestCheck, responseCheck };
  },
  "workspace.list": async (): Promise<
    MethodCheckPair<
      import("./repo/workspace.js").WorkspaceListRequest,
      import("./repo/workspace.js").WorkspaceListResponse
    >
  > => {
    const { validateWorkspaceListRequest: requestCheck } =
      await import("./checks/repo/workspace.js");
    const { validateWorkspaceListResponse: responseCheck } =
      await import("./checks/repo/workspace.js");
    return { requestCheck, responseCheck };
  },
  "worktree.removed.delete": async (): Promise<
    MethodCheckPair<
      import("./worktree/removed.js").RemovedWorktreeRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateRemovedWorktreeRequest: requestCheck } =
      await import("./checks/worktree/removed.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "worktree.removed.list": async (): Promise<
    MethodCheckPair<
      import("./worktree/removed.js").WorktreeRemovedListRequest,
      import("./worktree/removed.js").WorktreeRemovedListResponse
    >
  > => {
    const { validateWorktreeRemovedListRequest: requestCheck } =
      await import("./checks/worktree/removed.js");
    const { validateWorktreeRemovedListResponse: responseCheck } =
      await import("./checks/worktree/removed.js");
    return { requestCheck, responseCheck };
  },
  "worktree.restore": async (): Promise<
    MethodCheckPair<
      import("./worktree/removed.js").RemovedWorktreeRequest,
      import("./worktree/removed.js").WorktreeRestoreResponse
    >
  > => {
    const { validateRemovedWorktreeRequest: requestCheck } =
      await import("./checks/worktree/removed.js");
    const { validateWorktreeRestoreResponse: responseCheck } =
      await import("./checks/worktree/removed.js");
    return { requestCheck, responseCheck };
  },
  "worktree.retire": async (): Promise<
    MethodCheckPair<
      import("./worktree/lifecycle.js").WorktreeRetireRequest,
      import("./worktree/lifecycle.js").WorktreeRetireResponse
    >
  > => {
    const { validateWorktreeRetireRequest: requestCheck } =
      await import("./checks/worktree/lifecycle.js");
    const { validateWorktreeRetireResponse: responseCheck } =
      await import("./checks/worktree/lifecycle.js");
    return { requestCheck, responseCheck };
  },
  "worktree.setup.retry": async (): Promise<
    MethodCheckPair<
      import("./worktree/setup.js").WorktreeSetupRequest,
      import("./method-descriptor.js").EmptyPayload
    >
  > => {
    const { validateWorktreeSetupRequest: requestCheck } =
      await import("./checks/worktree/setup.js");
    const { validateEmptyPayload: responseCheck } = await import("./checks/method-descriptor.js");
    return { requestCheck, responseCheck };
  },
  "worktree.status.read": async (): Promise<
    MethodCheckPair<
      import("./worktree/lifecycle.js").WorktreeStatusReadRequest,
      import("./worktree/lifecycle.js").WorktreeStatusReadResponse
    >
  > => {
    const { validateWorktreeStatusReadRequest: requestCheck } =
      await import("./checks/worktree/lifecycle.js");
    const { validateWorktreeStatusReadResponse: responseCheck } =
      await import("./checks/worktree/lifecycle.js");
    return { requestCheck, responseCheck };
  },
} as const;
