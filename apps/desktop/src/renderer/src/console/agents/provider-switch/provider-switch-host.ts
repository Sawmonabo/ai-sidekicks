// What a family hosting `ProviderSwitch` has to hold, and where each half already lives.
//
// THE FORM HOLDS NEITHER OF THEM, WHICH IS WHY THIS MODULE EXISTS. `ProviderSwitch`
// renders the catalog's refusal and owns no stream, and it says the controls are busy
// and owns no latch — both are stated on its props and both are the HOST's. The agent
// console composes them out of its own models; a second family with no models of its
// own would otherwise compose them again, and the copy that drifts is the one nobody
// diffs.
//
// SO WHAT IS HOISTED IS THE COMPOSITION AND NEVER A SECOND MECHANISM. The read factory
// is `run-console/agent-console-reads.ts`'s, the latch is `agent-console/
// mutation-control.ts`'s, the lifetime holder is `store/subject-scoped-resource.ts`'s,
// and the refusal translation is `seats/push-driven-read.ts`'s. Each of the four still
// has exactly one home; what is here is the wiring a host repeats, plus the two leaves
// a second caller would have had to restate — the mutation's origin string and the
// `agent.configUpdate` call itself.
//
// AND THE AGENT CONSOLE TAKES THOSE TWO LEAVES FROM HERE. `AgentConsoleModels`
// delegates `updateConfig` to {@link requestAgentConfigUpdate} and the binding column
// names {@link AGENT_MUTATION_ORIGIN} for both of its latches, so the wire call and the
// refusal's subsystem name are single-homed across the two families. What that console
// does NOT take is {@link useAgentBindingSwitch}: its latch is shared with detach —
// "one mutation at a time on this agent's binding" is one rule — and its settlement is
// scoped by a roster column that may be showing several cards. A host with one control
// and one agent is a different composition over the same parts, and pretending
// otherwise would put a roster column's membership test inside a popover.

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  consoleClockFor,
  type AgentConfigUpdateReading,
  type AgentSwitchSettlement,
  type ConsoleBridge,
} from "../../bridge/index.js";
import type { ConsoleRefusal } from "../../core/index.js";
import {
  servedGrowthValueOrRaise,
  usePushDrivenRead,
  type PushDrivenReadState,
} from "../../seats/index.js";
import { useSubjectScopedResource, type SubjectScopedDisposal } from "../../store/index.js";
import {
  AgentMutationControl,
  useAgentMutationControl,
} from "../agent-console/mutation-control.js";
import type { DriverCatalogReading } from "../driver-catalog.js";
import { createDriverCatalog, type DriverCatalogRead } from "../run-console/agent-console-reads.js";
import type { AxisDraft } from "./provider-switch-draft.js";

/**
 * Names a mutation's failure where the thrown value carried no refusal of its own.
 *
 * ONE STRING FOR THE WHOLE AGENT PLANE'S WRITES, which is what makes a refusal
 * readable: a person told the origin is `agent-mutation` learns which subsystem
 * refused, and a second family inventing its own name would put two vocabularies
 * behind one wire.
 */
export const AGENT_MUTATION_ORIGIN = "agent-mutation";

/**
 * The key the catalog reading is held under, per bridge.
 *
 * A CONSTANT AND NOT THE SESSION, because the catalog is neither session-scoped nor
 * agent-scoped: `driver.listModels` and `driver.listCapabilities` are asked of the node
 * and answer the same thing whichever session asked. The bridge is the subject — every
 * call travels through it, so its replacement is what retires the reading — and this
 * key is what states that the address never moves underneath it.
 */
const DRIVER_CATALOG_KEY = "driver-catalog";

/**
 * The TERMINAL arm: `dispose()` ends a push-driven read rather than releasing it.
 *
 * At module level so the holder's dependency lists compare stable identities across
 * renders rather than a fresh literal each pass.
 */
const driverCatalogDisposal: SubjectScopedDisposal<DriverCatalogRead> = {
  dispose: (read: DriverCatalogRead): void => {
    read.dispose();
  },
  isClosed: (read: DriverCatalogRead): boolean => read.isDisposed,
};

/** Move provider axes on one running agent. Never a second run control. */
export async function requestAgentConfigUpdate(
  bridge: ConsoleBridge,
  agentId: string,
  axes: AxisDraft,
  interruptAndSwitch: boolean,
): Promise<AgentConfigUpdateReading> {
  return servedGrowthValueOrRaise(
    await bridge.growth.agentConfigUpdate({ agentId, interruptAndSwitch, ...axes }),
  );
}

/** The catalog half of `ProviderSwitchProps`, ready to hand over. */
export interface DriverCatalogHolder {
  /** Straight onto `ProviderSwitchProps.catalog`. */
  readonly catalog: PushDrivenReadState<DriverCatalogReading>;
  /** Straight onto `ProviderSwitchProps.onCatalogReopen`. Stable between reads. */
  readonly reopen: () => void;
}

/**
 * Hold one driver-catalog reading for as long as this mount shows one bridge.
 *
 * HELD BY `useSubjectScopedResource` AND NOT BY `useMemo`, for the reason
 * `shell/composer/chips/agent-binding-read.ts` records: a memo plus a cleanup effect
 * disposes the read on React's double-mount and then re-commits the value it just
 * disposed, leaving the surface on a read that refuses every later request for the life
 * of the window. The holder recognises that corpse through the terminal disposal above.
 *
 * THE READ IS STARTED FROM AN EFFECT, never from the factory. Starting opens a
 * subscription and arms a scheduler, and a render pass React discards would leave both
 * behind with no committed cleanup to reach them. `start()` is idempotent while the
 * subscription is held, so a re-run costs nothing.
 *
 * The catalog announces no change on any wire, so the reading performs one read and
 * re-arms on nothing — which is why {@link DriverCatalogHolder.reopen} is the only way
 * back from a refusal and why every host handing this form a catalog owes it one.
 */
export function useDriverCatalogReading(bridge: ConsoleBridge): DriverCatalogHolder {
  // The clock is the BRIDGE's, through the family door that owns the rule: a fixture
  // bridge running an engine shares that engine's frozen clock, and a second reading of
  // that rule is how a window ends up debouncing on wall time inside a frozen scenario.
  const openCatalog = useCallback(
    () => createDriverCatalog(bridge, consoleClockFor(bridge)),
    [bridge],
  );
  const { value: read } = useSubjectScopedResource<DriverCatalogRead>(
    bridge,
    DRIVER_CATALOG_KEY,
    openCatalog,
    driverCatalogDisposal,
  );
  useEffect(() => {
    read.start();
  }, [read]);
  const catalog = usePushDrivenRead(read);
  const reopen = useCallback((): void => {
    read.refresh("participant-request");
  }, [read]);
  return { catalog, reopen };
}

/**
 * One answered `agent.configUpdate` round.
 *
 * A VALUE FOR THE SETTLED ARM, because the reply's own `switch` member cannot stand in
 * for one. That member is optional — "absent on a pure rename or rebind" — so a holder
 * that published it bare collapsed `{ settled, settlement: undefined }` into a plain
 * `undefined`, which is indistinguishable from "nothing has been answered". The form
 * then reported nothing and every consumer keyed on the member's presence — the chip's
 * binding re-read among them — never fired: a press that appeared to do nothing at all
 * while the daemon had in fact answered.
 */
export interface AgentSwitchRound {
  /** The reply's `switch` member, verbatim. Absent on a pure rename or rebind. */
  readonly settlement: AgentSwitchSettlement | undefined;
}

/** The mutation half of `ProviderSwitchProps`, ready to hand over. */
export interface AgentBindingSwitchHolder {
  /** Straight onto `ProviderSwitchProps.isSubmitting`. */
  readonly isSubmitting: boolean;
  /**
   * Straight onto `ProviderSwitchProps.round`. Present once the daemon has answered.
   *
   * Stable by identity between rounds, which is what a consumer reading it in an effect
   * dependency rests on: a fresh record on every render would re-fire that effect for a
   * settlement nothing new had happened to.
   */
  readonly settled: AgentSwitchRound | undefined;
  /** Straight onto `ProviderSwitchProps.refusal`. Why the press did not happen. */
  readonly refusal: ConsoleRefusal | undefined;
  /** Straight onto `ProviderSwitchProps.onApply`. */
  readonly apply: (axes: AxisDraft, interruptAndSwitch: boolean) => void;
}

/**
 * Hold one `agent.configUpdate` latch for the agent this mount is addressed at.
 *
 * ONE ROUND AT A TIME, SYNCHRONOUSLY REFUSED. The mutation is durable — it can mint or
 * supersede a pending switch — so a second press inside one task must not reach the
 * wire, which a `useState` flag written on the next render cannot prevent.
 * `AgentMutationControl` is what holds that latch, and it is built by an initializer
 * rather than in a render body: a latch replaced mid-flight admits the press it exists
 * to refuse.
 *
 * A SETTLEMENT BELONGS TO THE SUBJECT IT WAS SUBMITTED FOR, and the subject here is the
 * bridge, the session, and the agent together. Any of the three moving supersedes the
 * round, which abandons it without pretending the call was cancelled — nothing behind
 * the bridge is cancellable — and hands the control back for the subject on screen.
 * Without it a reply for an agent this surface had left installed into a state nothing
 * showed, and was waiting there if that agent came back.
 *
 * A HOST ADDRESSED AT NO AGENT STILL CALLS THIS, because a hook may not be called
 * conditionally. {@link AgentBindingSwitchHolder.apply} then submits nothing: there is
 * no binding to move, and inventing an id to move one is the fabrication the composer's
 * own reads were rewritten to end.
 */
export function useAgentBindingSwitch(
  bridge: ConsoleBridge,
  sessionId: string,
  agentId: string | undefined,
): AgentBindingSwitchHolder {
  const [control] = useState(
    () =>
      new AgentMutationControl<AgentSwitchSettlement | undefined>({
        origin: AGENT_MUTATION_ORIGIN,
      }),
  );
  const state = useAgentMutationControl(control);
  // Derived from the control's own state and held to its identity: that state is stable
  // between changes, so this record is minted once per settled round rather than once
  // per render — which is what makes it safe to read in an effect dependency.
  const settled = useMemo(
    () => (state.status === "settled" ? { settlement: state.settlement } : undefined),
    [state],
  );
  useEffect(() => {
    control.supersede();
  }, [control, bridge, sessionId, agentId]);
  const apply = useCallback(
    (axes: AxisDraft, interruptAndSwitch: boolean): void => {
      if (agentId === undefined) {
        return;
      }
      control.submit(async () => {
        const reply = await requestAgentConfigUpdate(bridge, agentId, axes, interruptAndSwitch);
        return reply.switch;
      });
    },
    [bridge, control, agentId],
  );
  return {
    isSubmitting: state.status === "in-flight",
    settled,
    refusal: state.status === "refused" ? state.refusal : undefined,
    apply,
  };
}
