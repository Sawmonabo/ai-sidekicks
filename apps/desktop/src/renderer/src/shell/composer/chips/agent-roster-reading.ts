// The addressed agent's roster read, as a reading rather than a one-shot effect.
//
// WHY THIS IS A CLASS AND NOT THE `useEffect` IT REPLACES. The read was armed once
// per `(bridge, sessionId, agentId)` and never again — no focus trigger, no repair
// trigger, no timeline trigger — which `Spec-023 §Rules every console surface obeys`
// forbids for exactly the reason this chip demonstrates: `agent.list` is how a client
// that did not issue the mutation learns a provider switch is queued, so a
// collaborator queueing one after this composer mounted left the chip showing no
// pending switch indefinitely. The label half beside it DID refresh — the
// account-plane reading wires the window triggers — so one chip carried two
// staleness rules.
//
// `store/read-triggers.ts` owns the four moments and `store/scheduling.ts` owns what
// asking costs; what this class adds is the `ReadTriggerTarget` shape that makes it
// wireable, which is what the console's other four readings are and what the
// architecture tier holds every reading to.
//
// THE TRIGGERING KINDS ARE THE AGENT LIFECYCLE'S, AND THEIR PAYLOADS ARE NEVER READ.
// The `approvals-wire.ts` rule, for the same reason: the roster read is the single
// source of what a binding is, and a second reading taken from a signal's payload
// would be a second source that could disagree with it.
//
// A CHANNEL-ADDRESSED COMPOSER NAMES NO AGENT AND SO ASKS NOTHING. The reading is
// still minted — a hook may not be called conditionally — and it answers `not-checked`
// for as long as no agent is addressed, which is the honest reading of a question
// nobody put rather than an empty roster.
//
// AND THE READ IS TOTAL, WHICH IS WHAT THE SCHEDULER'S SWALLOW RESTS ON. `agent.list`
// can REJECT rather than answer: the fixture throws for a scripted reply it cannot
// read, and a live transport rejects whenever the call itself fails. A rejection
// travelled to `RefreshScheduler`'s `onError`, which drops it — so the chip sat on
// `loading` with nothing said, indefinitely, and the comment beside that `onError`
// claiming the refusal had already been published was the only thing standing where
// the publish should have been. The read now catches its own rejection and publishes
// it as this reading's `refused` phase, which is what makes that claim true and what
// the console's four other readings already do.

import type { AgentPendingSwitch } from "../../../console/bridge/index.js";
import type { ConsoleBridge } from "../../../console/bridge/index.js";
import {
  normalizeWireRejection,
  type ConsoleClock,
  type ConsoleRefusal,
} from "../../../console/core/index.js";
import {
  RefreshScheduler,
  type ReadTriggerTarget,
  type RefreshReason,
} from "../../../console/store/index.js";

/** Where the binding read has got to, on the console's four-arm absence rule. */
export type AgentBindingPhase = "not-checked" | "loading" | "read" | "refused";

/**
 * The subsystem name a rejection of this reading's own call is refused under.
 *
 * This reading's and not the growth port's: a rejection never reached the port's
 * outcome arms, so wearing `growth-port` would name a refusal the port did not make
 * and send a reader to the slate row for a wire that is registered.
 */
export const AGENT_ROSTER_REFUSAL_ORIGIN = "agent-roster";

/**
 * The roster half, before the account plane's label is joined onto it.
 *
 * A separate shape from what the chip reads because the two halves settle at
 * different times and from different seams: the roster is this reading's own
 * asynchronous read, and the label is whatever the window's account-plane reading
 * holds when the chip renders. Fusing them is what made this module's predecessor
 * take a `providerAccount.list` of its own.
 */
export interface AgentRosterReadout {
  readonly phase: AgentBindingPhase;
  /** The daemon-minted handle the roster named, before any label is joined to it. */
  readonly payingAccountId: string | undefined;
  readonly isProviderDefaultAccount: boolean;
  readonly pendingSwitch: AgentPendingSwitch | undefined;
  readonly refusal: ConsoleRefusal | undefined;
}

/**
 * The agent-lifecycle signals whose arrival owes this reading a fresh read.
 *
 * All three, because all three change what the roster would answer: an attach and a
 * detach change who is on it, and a config update is where a provider switch is
 * accepted. Their payloads are never decoded — see the header.
 */
export const AGENT_ROSTER_TRIGGERING_EVENT_KINDS: ReadonlySet<string> = Object.freeze(
  new Set<string>(["agent.attached", "agent.detached", "agent.config_updated"]),
);

/** Nothing has been asked. The seed for a composer addressed at no agent. */
const NOTHING_ASKED: AgentRosterReadout = Object.freeze({
  phase: "not-checked",
  payingAccountId: undefined,
  isProviderDefaultAccount: false,
  pendingSwitch: undefined,
  refusal: undefined,
});

/** What one reading is built over. */
export interface AgentRosterReadingOptions {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
  /** The addressed agent, or `undefined` while the composer names a channel. */
  readonly agentId: string | undefined;
  /**
   * The clock every timer this reading arms is minted through.
   *
   * Required rather than defaulted, on `ApprovalsReader`'s rule: a caller cannot
   * accidentally leave the fixture reading the wall clock.
   */
  readonly clock: ConsoleClock;
}

/** One addressed agent's binding, read off the roster and kept current. */
export class AgentRosterReading implements ReadTriggerTarget {
  public readonly triggeringEventKinds: ReadonlySet<string> = AGENT_ROSTER_TRIGGERING_EVENT_KINDS;
  readonly #bridge: ConsoleBridge;
  readonly #sessionId: string;
  readonly #agentId: string | undefined;
  readonly #scheduler: RefreshScheduler;
  readonly #listeners = new Set<() => void>();
  #readout: AgentRosterReadout = NOTHING_ASKED;
  /**
   * Which read attempt a reply belongs to.
   *
   * A reply whose ordinal has moved on is dropped rather than published: a re-read
   * asked for by a repair can settle before the mount read it superseded, and the
   * older answer landing last would put a pre-repair roster on screen.
   */
  #readOrdinal = 0;
  #disposed = false;

  public constructor(options: AgentRosterReadingOptions) {
    this.#bridge = options.bridge;
    this.#sessionId = options.sessionId;
    this.#agentId = options.agentId;
    this.#scheduler = new RefreshScheduler({
      clock: options.clock,
      perform: async () => {
        await this.#read();
      },
      // A read that rejects publishes its own refusal — see `#read` — so re-throwing
      // would surface the same fact again as an unhandled rejection. This arm is
      // therefore for a defect in the publish itself, and it says nothing about the
      // wire; the sibling readings all carry it for the same reason.
      onError: () => undefined,
    });
  }

  /** What the chip reads. Stable between transitions, so `Object.is` works. */
  public get readout(): AgentRosterReadout {
    return this.#readout;
  }

  /**
   * Whether {@link dispose} has run. Read by whoever HOLDS this reading.
   *
   * `dispose` is one-way — it drops the scheduler and refuses every later
   * `requestRead` — so a holder that re-commits a disposed reading holds something
   * that will never answer again, and says nothing about it. That state is invisible
   * from the outside without this, which is why `store/subject-scoped-resource.ts`
   * takes a terminal disposal only together with a reading of it.
   */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /** Watch for a new readout. Returns an idempotent unsubscribe. */
  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Ask for a read.
   *
   * `subscribe` on mount, `window-focus` on return, `reconnect` when the session
   * store's degraded cause clears, and `terminal-event` for one of the three agent
   * signals — the four reasons and no interval. A composer addressed at a channel
   * names no agent and so asks nothing, whatever the reason.
   */
  public requestRead(reason: RefreshReason): void {
    if (this.#disposed || this.#agentId === undefined) {
      return;
    }
    if (this.#readout.phase === "not-checked") {
      this.#publish({ ...NOTHING_ASKED, phase: "loading" });
    }
    this.#scheduler.request(reason);
  }

  /** Drop anything armed and stop publishing. Terminal, and the unmount path. */
  public dispose(): void {
    this.#disposed = true;
    this.#scheduler.dispose();
    this.#listeners.clear();
  }

  async #read(): Promise<void> {
    const agentId = this.#agentId;
    if (agentId === undefined) {
      return;
    }
    this.#readOrdinal += 1;
    const ordinal = this.#readOrdinal;
    let roster;
    try {
      roster = await this.#bridge.growth.agentList({ sessionId: this.#sessionId });
    } catch (rejection) {
      if (this.#disposed || ordinal !== this.#readOrdinal) {
        return;
      }
      // THE CALL ITSELF FAILED, WHICH IS NOT ONE OF THE PORT'S ANSWERS. A fixture
      // whose scripted reply cannot be read throws, and a live transport rejects
      // whenever the call does not complete — neither arrives as an outcome, so
      // neither can be carried through the way the unavailable arm below is. The
      // console's one rejection normalizer turns it into the same refusal shape every
      // surface renders, under this reading's own name.
      this.#publish({
        ...NOTHING_ASKED,
        phase: "refused",
        refusal: normalizeWireRejection(AGENT_ROSTER_REFUSAL_ORIGIN, rejection),
      });
      return;
    }
    if (this.#disposed || ordinal !== this.#readOrdinal) {
      return;
    }
    if (roster.status !== "served") {
      // The unavailable arm IS the refusal — `GrowthUnavailable` extends
      // `ConsoleRefusal` — so it is carried through untouched. Re-minting one here
      // would lose the operation, the slate row, and the document that owes the wire.
      this.#publish({ ...NOTHING_ASKED, phase: "refused", refusal: roster });
      return;
    }
    const summary = roster.value.agents.find((candidate) => candidate.agentId === agentId);
    if (summary === undefined) {
      // The roster served and this agent is not on it. A reading and not a refusal:
      // the daemon answered, and what it answered is that this session holds no such
      // agent — which the chip renders as knowing nothing about a binding rather than
      // as a read that failed.
      this.#publish({ ...NOTHING_ASKED, phase: "read" });
      return;
    }
    // THE EFFECTIVE BINDING AND NEVER THE PENDING ONE. `config` carries what the
    // agent runs under now; a row that carries no binding half at all is the same
    // fact as one whose binding names no account, and both mean the provider's
    // registered default is paying — which is why the two absences fold here rather
    // than being told apart by a surface that has no different sentence for them.
    const payingAccountId = summary.config?.providerAccountId;
    this.#publish({
      phase: "read",
      payingAccountId,
      isProviderDefaultAccount: payingAccountId === undefined,
      pendingSwitch: summary.pendingSwitch,
      refusal: undefined,
    });
  }

  #publish(readout: AgentRosterReadout): void {
    this.#readout = readout;
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
