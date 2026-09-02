// The agent console's binding column: the roster, one card, and the two mutations.
//
// WHY THIS IS A SEPARATE COMPONENT FROM THE PANE. Every read here needs the models,
// and the models need a bridge and a session store — both of which an auxiliary
// address may legitimately fail to name. Hooks cannot be called conditionally, so the
// column that NEEDS them is its own component, mounted only where they exist, and the
// pane renders the absence when they do not. The alternative is a pane full of
// optional hooks, each of which would have to invent a defined-enough value to run on.
//
// WHAT IT OWNS: the attach form's lifetime, the dialog's open state, and the last
// reply from each mutation. Nothing else — the reads belong to the models and the
// rendering belongs to the `agents/` surfaces this file composes.

import { useCallback, useEffect, useMemo, useReducer, useState } from "react";

import {
  AgentCard,
  AgentRosterEmpty,
  AttachSidekick,
  AttachSidekickForm,
  ProviderSwitch,
  type AgentAttachReading,
  type AgentConsoleModels,
  type AgentSwitchSettlement,
  type ProviderAxis,
} from "../../agents/index.js";
import type { ConsoleRefusal } from "../../core/index.js";
import { consoleRefusalFrom, usePushDrivenRead } from "../../collaboration/push-driven-read.js";
import { Nothing, RefusalCard } from "../../primitives/index.js";

/** Names a mutation's failure where the thrown value carried no refusal of its own. */
const AGENT_MUTATION_ORIGIN = "agent-mutation";

interface AttachOutcome {
  readonly confirmation?: AgentAttachReading | undefined;
  readonly refusal?: ConsoleRefusal | undefined;
}

interface SwitchOutcome {
  readonly settlement?: AgentSwitchSettlement | undefined;
  readonly refusal?: ConsoleRefusal | undefined;
}

export interface AgentBindingColumnProps {
  readonly models: AgentConsoleModels;
  /** The agent this console is about. `undefined` shows the whole roster. */
  readonly agentId: string | undefined;
}

export function AgentBindingColumn(props: AgentBindingColumnProps): React.JSX.Element {
  const { models, agentId } = props;
  const rosterState = usePushDrivenRead(models.roster);
  const catalogState = usePushDrivenRead(models.driverCatalog);
  const definitionsState = usePushDrivenRead(models.definitions);

  // The form is a store, so it is built by a hook's initializer and never in a render
  // body: a body would build a fresh one on every pass React discarded and every edit
  // in it would be lost. It notifies through its own emitter rather than React state,
  // so this render is re-run by a counter nothing reads — the value is not the point,
  // the notification is.
  const [attachForm] = useState(() => new AttachSidekickForm());
  const [, noteFormEdited] = useReducer((edits: number) => edits + 1, 0);
  const [isAttachOpen, setAttachOpen] = useState(false);
  const [attachOutcome, setAttachOutcome] = useState<AttachOutcome>({});
  const [switchOutcome, setSwitchOutcome] = useState<SwitchOutcome>({});

  useEffect(() => attachForm.onChange(noteFormEdited), [attachForm, noteFormEdited]);

  const submitAttach = useCallback((): void => {
    const readiness = attachForm.readiness();
    if (readiness.status !== "ready") {
      return;
    }
    models
      .attach(readiness.request)
      .then((confirmation) => {
        setAttachOutcome({ confirmation });
      })
      .catch((error: unknown) => {
        setAttachOutcome({ refusal: consoleRefusalFrom(error, AGENT_MUTATION_ORIGIN) });
      });
  }, [attachForm, models]);

  const applySwitch = useCallback(
    (
      targetAgentId: string,
      axes: Partial<Record<ProviderAxis, string>>,
      interruptAndSwitch: boolean,
    ): void => {
      models
        .updateConfig(targetAgentId, axes, interruptAndSwitch)
        .then((reply) => {
          setSwitchOutcome({ settlement: reply.switch });
        })
        .catch((error: unknown) => {
          setSwitchOutcome({ refusal: consoleRefusalFrom(error, AGENT_MUTATION_ORIGIN) });
        });
    },
    [models],
  );

  const detachAgent = useCallback(
    (targetAgentId: string): void => {
      models.detach(targetAgentId).catch((error: unknown) => {
        setSwitchOutcome({ refusal: consoleRefusalFrom(error, AGENT_MUTATION_ORIGIN) });
      });
    },
    [models],
  );

  const agents = rosterState.kind === "loaded" ? rosterState.value.agents : [];
  const shownAgents = useMemo(
    () => (agentId === undefined ? agents : agents.filter((row) => row.agentId === agentId)),
    [agents, agentId],
  );
  const soleAgent = shownAgents.length === 1 ? shownAgents[0] : undefined;

  return (
    <>
      {rosterState.kind === "not-loaded" ? (
        <Nothing kind="not-loaded" title="Reading this session's agents" />
      ) : null}
      {rosterState.kind === "failed" ? <RefusalCard {...rosterState.refusal} /> : null}
      {rosterState.kind === "loaded" && shownAgents.length === 0 ? (
        <AgentRosterEmpty onAttach={() => setAttachOpen(true)} />
      ) : null}

      {shownAgents.map((agent) => (
        <AgentCard key={agent.agentId} agent={agent} onDetach={detachAgent} />
      ))}

      {soleAgent === undefined ? null : (
        <ProviderSwitch
          agent={soleAgent}
          catalog={catalogState}
          onApply={(axes, interruptAndSwitch) => {
            applySwitch(soleAgent.agentId, axes, interruptAndSwitch);
          }}
          settlement={switchOutcome.settlement}
          refusal={switchOutcome.refusal}
        />
      )}

      <button
        type="button"
        className="meridian-agent-card__action"
        onClick={() => setAttachOpen(true)}
      >
        Attach a sidekick
      </button>

      <AttachSidekick
        open={isAttachOpen}
        onOpenChange={setAttachOpen}
        form={attachForm}
        catalog={catalogState}
        definitions={definitionsState}
        onSubmit={submitAttach}
        confirmation={attachOutcome.confirmation}
        refusal={attachOutcome.refusal}
      />
    </>
  );
}
