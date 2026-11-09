// The lead's model as the speed chip reads it: the binding the session's agent list gives the lead,
// found in the session's driver catalog, with the speed levels that row offers and the level the
// lead runs at now. Nothing is read twice: the agent list is the session's shared one and the
// catalog is read once per mount.

import { useContext, useEffect } from "react";

import type { AgentSubscribeEntry } from "@ai-sidekicks/contracts/agent/methods";
import type { ProviderModel } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import { findProviderModelRow } from "@ai-sidekicks/contracts/provider/driver/model-row";
import type { ProviderSection } from "@ai-sidekicks/contracts/provider/settings";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { CONTROLLER_DISPOSAL } from "#renderer/lib/subject-scoped/disposal.js";
import { useSubjectScopedResource } from "#renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import {
  modelsFor,
  outputSpeedLevelsFor,
  type DriverCatalogReading,
} from "#renderer/lib/provider-binding/driver-catalog.js";
import { agentListFeedFor } from "#renderer/services/daemon/agent-list.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { createDriverCatalogRead } from "#renderer/services/provider-models/catalog.js";
import { useSessionAgentList } from "#renderer/store/agents/hooks/useSessionAgentList.js";
import type { SessionAgentListState } from "#renderer/store/agents/list.js";
import { ProviderSectionsContext } from "#renderer/store/providers/hooks/useProviderSections.js";
import { usePushDrivenRead } from "#renderer/store/reads/hooks/usePushDrivenRead.js";

/** The lead's model row, its speed levels and the level it runs at, each absent until read. */
export interface LeadModel {
  readonly model: ProviderModel | undefined;
  readonly levels: readonly string[] | undefined;
  readonly runningLevel: string | undefined;
}

/** Read the lead's model for `sessionId` while the caller is mounted. */
export function useLeadModel(bridge: PlatformBridge, sessionId: SessionId): LeadModel {
  const clock = useClock();
  const agents = useSessionAgentList(agentListFeedFor(bridge), sessionId);
  const { value: catalogRead } = useSubjectScopedResource(
    bridge,
    sessionId,
    () => createDriverCatalogRead(bridge, clock, sessionId),
    CONTROLLER_DISPOSAL,
  );
  useEffect(() => {
    catalogRead.start();
  }, [catalogRead]);
  const catalog = usePushDrivenRead(catalogRead);
  const sections = useContext(ProviderSectionsContext);
  const lead = leadOf(agents);
  if (lead === undefined || catalog.kind !== "loaded") {
    return NOTHING_READ;
  }
  return leadModelIn(catalog.value, sections?.status === "served" ? sections.sections : [], lead);
}

/** The session's lead: the one agent with no ancestry. */
function leadOf(agents: SessionAgentListState): AgentSubscribeEntry | undefined {
  return agents.status === "served"
    ? agents.agents.find((agent) => agent.ancestry.length === 0)
    : undefined;
}

/** The lead's row in `catalog`, its levels from the row or its provider's section. */
function leadModelIn(
  catalog: DriverCatalogReading,
  sections: readonly ProviderSection[],
  lead: AgentSubscribeEntry,
): LeadModel {
  const { providerName, modelId, largerWindow, outputSpeed } = lead.binding;
  const choice = { modelId, largerWindow: largerWindow !== undefined };
  return {
    model: findProviderModelRow(modelsFor(catalog, providerName), modelId, choice.largerWindow),
    levels: outputSpeedLevelsFor(catalog, sections, providerName, choice),
    runningLevel: lead.observedOutputSpeed?.declared ?? outputSpeed,
  };
}

/** What is known before the lead and the catalog are read. */
const NOTHING_READ: LeadModel = { model: undefined, levels: undefined, runningLevel: undefined };
