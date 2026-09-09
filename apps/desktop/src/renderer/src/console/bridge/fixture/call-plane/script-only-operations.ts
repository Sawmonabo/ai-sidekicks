// WHICH of the served growth operations the port can only answer FROM A SCRIPT.
//
// A MODULE OF ITS OWN, BESIDE THE SET IT NARROWS. Two claims with two rules: the served
// set next door decides whether an operation is IMPLEMENTED at all, and this one decides
// whether the implementation has an honest answer for a scenario that scripts nothing.
// They fail differently and they are read by different callers — the served set is
// ledgered by `scenario-runtime/scenario-manifest.ts` and published as the bridge's
// served set, while this subset is what the port sweep holds each unscripted answer to.
//
// A DECLARED SUBSET rather than a rule the sweep re-derives, because the sweep cannot
// see the difference: both arms answer through the same port method, and what separates
// them is whether an empty answer would be a lie.

import { FIXTURE_SERVED_COLLABORATION_OPERATION_IDS } from "../collaboration/collaboration-reads.js";
import type { FixtureServedGrowthOperationId } from "./served-operations.js";

/**
 * Which of those the port implements but can only answer FROM A SCRIPT.
 *
 * Every other served operation has an honest answer for a scenario that scripts
 * nothing — an empty ledger, an empty roster, a workspace with no branch context —
 * and answers `served` under any scenario at all. Two classes have no such answer.
 * A WRITE: there is no such thing as "the attach that happened and produced nothing",
 * and serving a synthesized receipt would tell a surface the daemon did something no
 * author said it did. And a READ ADDRESSED BY A SUBJECT: a run's snapshot, a finished
 * phase's outputs, a definition's version chain, a definition, one version's body —
 * each answers with facts ABOUT a named thing, so an empty form would assert that the
 * thing exists and holds nothing, which for a run no author declared is the same
 * invention as a receipt. The
 * enumerations beside them stay out of this set: a list of none is a real answer to
 * "what does this session hold". So these are implemented, and refuse by name under a
 * scenario that does not script them.
 *
 * A declared subset rather than a rule the sweep re-derives, because the sweep cannot
 * see the difference: both arms answer through the same port method, and what
 * separates them is whether an empty answer would be a lie.
 */
export const FIXTURE_SCRIPT_ONLY_GROWTH_OPERATION_IDS: readonly FixtureServedGrowthOperationId[] = [
  "shellStatusSubscribe",
  "daemonStatusRead",
  "daemonStop",
  "daemonRestart",
  "daemonStart",
  "agentAttach",
  "agentConfigUpdate",
  "agentDetach",
  "sidekickPeerInvocationSet",
  "workflowRunRead",
  "workflowPhaseOutputRead",
  "workflowVersionChainRead",
  "workflowDefinitionRead",
  "workflowVersionRead",
  "terminalAcquireWriteLease",
  "terminalReleaseWriteLease",
  "workspaceExecutionContextRead",
  ...FIXTURE_SERVED_COLLABORATION_OPERATION_IDS,
  // The three acts on a pending invitation. Each addresses a reference the scenario
  // minted, so a scenario that scripted no invitation has no reference for any of
  // them to name — and serving a receipt for one would tell the confirmation that
  // main accepted an invitation no author ever wrote down.
  "inviteConfirmPending",
  "inviteRetryPending",
  "inviteDismissPending",
  // Neither has an honest empty answer. "Nobody is composing anywhere" is a claim
  // about the room that nothing checked, and there is no empty host — a node either
  // answers on one or this fixture has not been told which.
  "presenceActivityRead",
  "controlPlaneHostRead",
  "shellNotificationPermissionRead",
  "providerSessionImportBegin",
  "providerSessionImportSubscribe",
  "onboardingStepAdvance",
  "onboardingStepSkip",
  "onboardingComplete",
  "onboardingPresentChoice",
  "onboardingTelemetryPrompt",
  "healthStatusRead",
  "healthFailureDetailRead",
  "healthStuckRunInspect",
  "healthRecoveryActionRequest",
  "providerAccountLogin",
  "providerAccountLoginCancel",
  "providerAccountRegister",
  "mcpSetEnabled",
  "mcpSetTrust",
  "gitflowDiffArtifactCreate",
  "artifactRead",
];
