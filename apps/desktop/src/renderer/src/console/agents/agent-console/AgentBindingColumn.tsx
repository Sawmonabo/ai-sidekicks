// The agent console's binding column: the roster, one card, and the two mutations.
//
// WHY THIS IS A SEPARATE COMPONENT FROM THE PANE. Every read here needs the models,
// and the models need a bridge and a session store — both of which an auxiliary
// address may legitimately fail to name. Hooks cannot be called conditionally, so the
// column that NEEDS them is its own component, mounted only where they exist, and the
// pane renders the absence when they do not. The alternative is a pane full of
// optional hooks, each of which would have to invent a defined-enough value to run on.
//
// WHAT IT OWNS: the attach form's lifetime, the dialog's open state, two mutation
// latches, and the agent each latch's settlement belongs to. Nothing else — the reads
// belong to the models and the rendering belongs to the `agents/` surfaces this file
// composes.
//
// TWO LATCHES, ONE PER SUBJECT. `agent.attach` creates an agent and takes its own;
// `agent.configUpdate` and `agent.detach` act on an agent that already exists, are
// each durable — a config update can mint or supersede a pending switch — and share
// one, because "one mutation at a time on this agent's binding" is a single rule and
// two latches would be two answers to it. Both are held by `mutation-control.ts`
// rather than by pairs of state variables here: the latch it keeps is written
// synchronously, which a `useState` flag is not, and a second press inside one task
// would otherwise reach the wire twice.
//
// A SETTLEMENT BELONGS TO THE SUBJECT IT WAS SUBMITTED FOR — the session for an
// attach, the session AND the agent for a binding move. This component stays mounted
// when the console moves between either, so the subject each submission named is
// recorded and its settlement renders only under that subject. A comparison at render
// rather than an effect: an effect would leave one committed render showing agent A's
// settlement under agent B.
//
// AND A REPLY WHOSE SUBJECT IS GONE INSTALLS NOTHING. The render-time comparison hides
// such a settlement; it does not stop it arriving, so the latch stayed busy for a
// subject this column had left and the reply installed into state nothing would show —
// and if the subject came back, the stale answer was there waiting. Each latch is
// therefore SUPERSEDED when its own subject moves, which abandons the round in flight
// without pretending the call was cancelled (nothing behind the bridge is cancellable)
// and hands the control back to a person for the subject they are actually looking at.
// The two halves are the pair `mutation-control.ts` documents: the latch admits one
// round, and the generation decides which round may install.

import { useCallback, useEffect, useMemo, useReducer, useState } from "react";

import { AgentCard } from "../AgentCard.js";
import { AgentRosterEmpty } from "../AgentRosterEmpty.js";
import { type ProviderAxis } from "../agent-wire.js";
import { AttachSidekick } from "../attach/AttachSidekick.js";
import { AttachSidekickForm } from "../attach/attach-model.js";
import { ProviderSwitch } from "../provider-switch/ProviderSwitch.js";
import { type AgentConsoleModels } from "../run-console/agent-console-model.js";
import type { AgentAttachReading, AgentSwitchSettlement } from "../../bridge/index.js";
import { usePushDrivenRead } from "../../seats/index.js";
import { Nothing, RefusalCard } from "../../primitives/index.js";
import { useSubjectScopedState } from "../../store/index.js";
import {
  AgentMutationControl,
  IDLE_MUTATION_ATTEMPT,
  useAgentMutationControl,
} from "./mutation-control.js";

/** Names a mutation's failure where the thrown value carried no refusal of its own. */
const AGENT_MUTATION_ORIGIN = "agent-mutation";

/**
 * One submitted binding move: which agent it is about, and through which control.
 *
 * The control is held because it decides WHERE the settlement renders, and the two
 * moves are pressed in two places — detach on the agent's card, a switch in the form
 * below it. Recorded at submission rather than derived at render, because by the time
 * a refusal lands the roster may have moved and the pressed control may be gone.
 */
interface BindingMove {
  readonly agentId: string;
  readonly control: "detach" | "switch";
}

export interface AgentBindingColumnProps {
  readonly models: AgentConsoleModels;
  /** The agent this console is about. `undefined` shows the whole roster. */
  readonly agentId: string | undefined;
}

/** What one binding submission was about, so its settlement can be shown under it. */
export function AgentBindingColumn(props: AgentBindingColumnProps): React.JSX.Element {
  const { models, agentId } = props;
  // Read once, beside the models it comes from, so the two values the handlers below
  // depend on are both named in their dependency lists rather than one being reached
  // through the other.
  const { sessionId } = models;
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
  // The latches, held for the life of this mount. Built by initializers for the
  // form's reason: a body would mint a fresh one on every discarded render pass,
  // and a latch that is replaced mid-flight admits the press it exists to refuse.
  const [attachAttempt] = useState(
    () => new AgentMutationControl<AgentAttachReading>({ origin: AGENT_MUTATION_ORIGIN }),
  );
  const [bindingAttempt] = useState(
    () =>
      new AgentMutationControl<AgentSwitchSettlement | undefined>({
        origin: AGENT_MUTATION_ORIGIN,
      }),
  );
  const attachState = useAgentMutationControl(attachAttempt);
  const bindingState = useAgentMutationControl(bindingAttempt);
  // WHICH SUBJECT EACH OUTSTANDING ACT WAS FOR, held by the console's one holder and
  // keyed on the session. The session half of both comparisons is the KEY, so it is
  // never compared here at all: the render that first sees a new session already
  // reads that session's own seed, which is "nothing was submitted here". What is
  // left on the value is the part the session does not settle — whether an attach was
  // submitted, and which agent a binding move was about THROUGH WHICH CONTROL.
  const { value: wasAttachSubmittedHere, publish: publishAttachSubmitted } =
    useSubjectScopedState<boolean>(models, sessionId, () => false);
  const { value: bindingMove, publish: publishBindingMove } = useSubjectScopedState<
    BindingMove | undefined
  >(models, sessionId, () => undefined);

  useEffect(() => attachForm.onChange(noteFormEdited), [attachForm, noteFormEdited]);

  // An attach is about the SESSION, so the session moving is what retires its round.
  // The agent the console is pointed at is not its subject: an attach outstanding
  // while the route moves from one agent to another still creates an agent in this
  // session, and abandoning it would discard a confirmation that is about to be true.
  useEffect(() => {
    attachAttempt.supersede();
  }, [attachAttempt, models]);

  // A binding move is about the session AND the agent, so either moving retires it.
  // Keyed on the `agentId` PROP rather than on the agent the roster resolved: the
  // prop is what this console is pointed at, while the resolved row comes and goes
  // with a read that can refuse and refresh, and a round abandoned by a roster
  // refresh would be a mutation dropped for no act of the participant's.
  useEffect(() => {
    bindingAttempt.supersede();
    publishBindingMove(undefined);
  }, [bindingAttempt, models, agentId, publishBindingMove]);

  // A press while one attach is outstanding reaches the latch and stops there —
  // `submit` admits nothing in flight, so a double click costs one request and the
  // confirmation shown is the settled reply's rather than whichever landed last.
  const submitAttach = useCallback((): void => {
    // The session and the catalog are both bound HERE rather than in the form: the
    // models own both reads, and a copy inside the form would be a second answer to
    // a question already asked. The catalog is what the form's readiness check tests
    // its entered driver, model, and effort against, so an unread one is passed as
    // the `undefined` it is and the submission fails closed rather than composing a
    // request out of values nothing vouches for.
    const catalog = catalogState.kind === "loaded" ? catalogState.value : undefined;
    const readiness = attachForm.readiness(sessionId, catalog);
    if (readiness.status !== "ready") {
      return;
    }
    if (attachAttempt.submit(async () => await models.attach(readiness.request))) {
      publishAttachSubmitted(true);
    }
  }, [attachAttempt, attachForm, catalogState, models, sessionId, publishAttachSubmitted]);

  // BOTH BINDING MOVES GO THROUGH ONE ADMISSION, and that is a correctness property
  // rather than tidiness. Each was written out separately, and one of them left
  // `publishBindingAgentId` off its dependency list — so after a re-address it held
  // the previous visit's publisher, whose writes the holder drops by design. A detach
  // was then admitted and mutated the agent while the column showed no busy state and
  // rendered no refusal, because the value that decides both is published here and
  // that press published nothing. Written once, the publisher is named once and
  // neither caller can omit it.
  //
  // The settlement published is the SETTLED reply's, never whichever landed last: one
  // request per intended action means there is no second reply to race.
  const submitBindingMove = useCallback(
    (submitted: BindingMove, move: () => Promise<AgentSwitchSettlement | undefined>): void => {
      if (bindingAttempt.submit(move)) {
        publishBindingMove(submitted);
      }
    },
    [bindingAttempt, publishBindingMove],
  );

  const applySwitch = useCallback(
    (
      targetAgentId: string,
      axes: Partial<Record<ProviderAxis, string>>,
      interruptAndSwitch: boolean,
    ): void => {
      submitBindingMove({ agentId: targetAgentId, control: "switch" }, async () => {
        const reply = await models.updateConfig(targetAgentId, axes, interruptAndSwitch);
        return reply.switch;
      });
    },
    [models, submitBindingMove],
  );

  // Detach shares the switch's latch and settles with nothing to show: a detach
  // publishes no switch settlement, and a refusal reaches a line of its own, because
  // both are this agent's binding refusing to move.
  const detachAgent = useCallback(
    (targetAgentId: string): void => {
      submitBindingMove({ agentId: targetAgentId, control: "detach" }, async () => {
        await models.detach(targetAgentId);
        return undefined;
      });
    },
    [models, submitBindingMove],
  );

  const agents = rosterState.kind === "loaded" ? rosterState.value.agents : [];
  const shownAgents = useMemo(
    () => (agentId === undefined ? agents : agents.filter((row) => row.agentId === agentId)),
    [agents, agentId],
  );
  const soleAgent = shownAgents.length === 1 ? shownAgents[0] : undefined;
  // WHICH SHOWN ROW THE OUTSTANDING ROUND IS ABOUT, and never "the sole agent".
  // Only the agent is compared, because the session is what both values are HELD
  // under: a value published for another session is not read here at all. The
  // `undefined` arm is explicit rather than implied — a binding nothing has moved and
  // a column showing no such row are both `undefined`, and comparing them would show
  // one agent's settlement on a column that is not about it.
  //
  // Scoped to the SOLE agent this admitted a detach that reached the wire and
  // rendered nothing. A bare auxiliary address in a session with two or more agents
  // shows the whole roster, so there is no sole agent: the round read as idle, every
  // card rendered enabled with no `aria-busy`, and the daemon's refusal reached no
  // pixel, because the switch form was the only element here that carried one and it
  // is not rendered in that shape. Membership of the shown roster is the real
  // question and it is the same question in every shape the console is addressed at.
  const movingAgentId =
    bindingMove !== undefined && shownAgents.some((row) => row.agentId === bindingMove.agentId)
      ? bindingMove.agentId
      : undefined;
  const shownBinding = movingAgentId === undefined ? IDLE_MUTATION_ATTEMPT : bindingState;
  const shownAttach = wasAttachSubmittedHere ? attachState : IDLE_MUTATION_ATTEMPT;
  const isBindingMutating = shownBinding.status === "in-flight";
  // WHERE THAT ROUND'S REFUSAL RENDERS. Beside the control that was pressed while
  // that control is on screen, and on the agent's own card otherwise — rule 9 puts an
  // inline refusal on the control that produced it, and for a switch that control is
  // the form. But the form is rendered only where the console shows exactly one
  // agent, and a roster that gained a second one while the round was in flight takes
  // it away. So the card is a FALLBACK and not a second home: the two arms are
  // disjoint by construction, and every refusal lands on exactly one of them.
  const bindingRefusal = shownBinding.status === "refused" ? shownBinding.refusal : undefined;
  const isSwitchFormShowingTheMovedAgent =
    soleAgent !== undefined && soleAgent.agentId === movingAgentId;
  const switchRefusal =
    bindingMove?.control === "switch" && isSwitchFormShowingTheMovedAgent
      ? bindingRefusal
      : undefined;
  const cardRefusal = switchRefusal === undefined ? bindingRefusal : undefined;

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
        <AgentCard
          key={agent.agentId}
          agent={agent}
          onDetach={detachAgent}
          isMutating={isBindingMutating && agent.agentId === movingAgentId}
          bindingRefusal={agent.agentId === movingAgentId ? cardRefusal : undefined}
        />
      ))}

      {soleAgent === undefined ? null : (
        // Keyed by the agent: the draft inside is about ONE agent's binding, and a
        // key is React's own statement that this is a different subject. A reset
        // effect would leave one render committed with the previous agent's draft.
        <ProviderSwitch
          key={soleAgent.agentId}
          agent={soleAgent}
          catalog={catalogState}
          onApply={(axes, interruptAndSwitch) => {
            applySwitch(soleAgent.agentId, axes, interruptAndSwitch);
          }}
          isSubmitting={isBindingMutating}
          settlement={shownBinding.status === "settled" ? shownBinding.settlement : undefined}
          refusal={switchRefusal}
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
        sessionId={models.sessionId}
        catalog={catalogState}
        definitions={definitionsState}
        onSubmit={submitAttach}
        // The latch's own arm, projected onto the control. The form holds no flag
        // of its own, so what is disabled and what is refused cannot disagree.
        isSubmitting={shownAttach.status === "in-flight"}
        confirmation={shownAttach.status === "settled" ? shownAttach.settlement : undefined}
        refusal={shownAttach.status === "refused" ? shownAttach.refusal : undefined}
      />
    </>
  );
}
