// Which providers this node can actually run, and the three acts the step offers.
//
// A VIEW OVER THE ACCOUNT PLANE THAT MINTS NOTHING. The readiness projection arrives
// on `providerAccount.list` as a REQUIRED member with exactly one entry per selected
// provider, so this model composes no state of its own from account fields: it holds
// what the reply said and what this window has done since. `Spec-029` is emphatic
// that readiness is a derivation of the registry served from the STORED last-probe
// result — a registry read spawns no provider process — and that it authorizes
// nothing, so nothing here gates anything.
//
// NOTHING POLLS, AND THERE IS NO STALENESS TEST. The contract carries no read-path
// age member and no stale arm, so `observedAt` is displayed as what it is and never
// compared against a clock. A re-check is a deliberate act a person performs, which
// is why `providerAccount.probe` is reached only from a control.
//
// AND THE READ GOES THROUGH THE ONE SCHEDULER, which is what separates "nothing
// polls" from "nothing can ask again". This model used to read once from the step's
// own arrival and hold whatever that answered for the life of the window: current at
// mount and stale the first time somebody came back to it, with nothing on screen
// saying so. It is a `ReadTriggerTarget` the walkthrough WIRES now — declaring the
// contract and never being handed to it is the same staleness with a green gate — so
// the two reasons a node-scoped reading takes, a surface arriving and a window
// regaining focus, reach it through `requestRead` and are coalesced by
// `RefreshScheduler`, exactly as `onboarding-flow.ts` next door takes them. A
// repaired connection is a SESSION's reason, and this reading holds no session.
//
// THE SCOPE ARRIVES THROUGH ONE VERB AND THE READ LEAVES THROUGH ANOTHER, which is
// why `addressAt` exists and why no read is public at all. An activation names which
// account the readiness read is addressed at, and a scheduler keyed on nothing could
// not tell two scopes apart — so the walkthrough ADDRESSES this model at that scope
// before its trigger set opens, this model remembers it, and every reason afterwards
// — the arrival included — re-reads THAT scope rather than silently widening to the
// provider default. A public read beside a routed one is what let the arrival bypass
// the scheduler in the first place, so there is no longer one to reach for.
//
// AND A CHANGE OF SCOPE RETIRES WHAT THE PREVIOUS ONE PUT ON SCREEN. Everything this
// model holds is ABOUT the account it was addressed at, so a scope that moves while a
// call is out has to retire that call: the previous account's reply would otherwise
// install its projection over the new account's, and the previous account's hand-off
// and re-check outcomes would stay rendered — and stay pressable — beside a scope that
// never produced them.
//
// THE THREE ACTS, and why there is no fourth. Sign-in hands the
// participant to the provider's own first-party flow through the growth port — the
// daemon spawns the unmodified login binary and this console reads nothing it writes.
// A re-check probes ONE account and then re-reads, because the probe answers about an
// account and the readiness derivation answers about a provider. And the read itself,
// optionally scoped to one account for the post-refusal path. Registration and
// choosing a default are MUTATING REGISTRY VERBS that belong to the account registry's
// own page; this step renders the remedy for them as text, which is what the design
// requires of a remedy in any case.
//
// AND THE RE-CHECK IS ITSELF A MUTATION, SO THE SUPERVISOR'S CONDITION CLOSES IT.
// `Spec-023 §Daemon Supervision Lifecycle` step 3 blocks mutating operations while the
// supervisor is not serving, and `providerAccount.probe` is one — so a re-check
// dispatched while the shell is starting, reconnecting, offline, stopped, or
// version-incompatible is a write this window had no business putting. The
// classification is NOT made here: the method name is bound to the store family's own
// closed tuple at compile time and asked of `shellBlockForMethod`, the one seam every
// dispatching control goes through — which is also why the read beside it survives the
// same outage, since that seam answers about a method and not about the window.
//
// SUPERSESSION IS THE FLOW'S RULE, AND THE TWO HALVES ANSWER IT DIFFERENTLY. A read
// rides a round on a line addressed at the scope, so a newer read supersedes an older
// one and a re-address or a retirement ENDS the line — which stops the call rather
// than only ignoring its reply. An act carries a stamp instead, because a mutation is
// never handed a signal; `provider-readiness-acts.ts` holds that register with the two
// acts it belongs to, and both `addressAt` and `supersede` advance it.
//
// AND WHAT A SURFACE SUBSCRIBES TO IS ONE SNAPSHOT, on `onboarding-flow.ts`' rule next
// door. The acts move without the projection — a hand-off publishes `handing-off` and
// touches no reading — so a surface reading the projection alone compared a value
// `Object.is` had no reason to call different: React suppressed the render, and a row
// stayed pressable with its refusal off screen until a later read replaced the reading.
//
// The vocabulary those surfaces read is `provider-readiness-reading.ts` beside this
// file, and the two mutations are `provider-readiness-acts.ts`; what is left here is
// the reading — how it is kept current, and what a scope change costs it.

import type { ProviderAccountId } from "@ai-sidekicks/contracts";

import { Emitter, type Unsubscribe } from "../../core/index.js";
import { callDaemon, consoleClockFor, type ConsoleBridge } from "../../bridge/index.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  ReadScope,
  RefreshScheduler,
  shellBlockForMethod,
  shellBlocksAreEqual,
  type FrameStore,
  type ReadTriggerTarget,
  type RefreshReason,
  type ShellMutationBlock,
} from "../../store/index.js";
import { ProviderActs, RECHECK_METHOD } from "./provider-readiness-acts.js";
import {
  IDLE_PROVIDER_ACTION,
  zeroStateSnapshot,
  type ProviderActionReading,
  type ProviderReadinessReading,
  type ProviderReadinessSnapshot,
} from "./provider-readiness-reading.js";

export class ProviderReadinessModel implements ReadTriggerTarget {
  /**
   * Nothing in any session's timeline says this node's provider accounts changed.
   *
   * The empty set is a claim read off the contract rather than an omission: the
   * provider-account registry is un-evented by design — its own subscribe verb
   * "carries a WIRE-ONLY notification and NEVER an `EventEnvelope`", because a
   * node-local operator act on a node-local registry has no session to belong to. So
   * there is no session event kind that could legitimately re-trigger this read, and
   * the sign-in completion is one of those wire notifications rather than an event.
   * This reading goes stale when the window has been away, and never because one
   * session appended something — which is exactly what the account plane's other
   * reading, `NodeProviderQuotaReading`, states at the same field.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = NO_TRIGGERING_EVENT_KINDS;
  readonly #bridge: ConsoleBridge;
  readonly #frameStore: FrameStore;
  readonly #refresh: RefreshScheduler;
  readonly #changes = new Emitter<void>("provider readiness");
  /** Dropped at supersession, so a retired model stops deriving from a live store. */
  readonly #stopWatchingShell: Unsubscribe;
  #snapshot: ProviderReadinessSnapshot;
  /**
   * The scope this model is addressed at. Read by every reason, written by one verb.
   *
   * Held rather than re-derived, because the activation that named it is gone by the
   * time a reconnect asks for a fresh read — and a refresh that quietly widened to
   * the provider default would answer about a different account from the one the
   * person is looking at.
   */
  #accountScope: ProviderAccountId | undefined = undefined;
  /**
   * The line every readiness read is on, whichever reason opened it.
   *
   * IT ANSWERS BOTH SUPERSESSION QUESTIONS A READ HAS. Which of two overlapping reads
   * may publish — the arrival read and a focus refresh used to share one generation,
   * so the OLDER of two replies passed the check and installed a projection the
   * daemon had already replaced — and whether the reads on it are still anybody's,
   * which is what `addressAt` and `supersede` answer by ending the line. Owned by the
   * READING and not the scheduler, on `bridge/quotas/provider-account-quota.ts`'
   * reading: a per-fire round orders the scheduler's own fires and nothing else, and
   * the arrival read never goes through the scheduler at all.
   *
   * RE-MINTED AND NOT RESET, because a line is addressed at a scope exactly as
   * `useReadScope` addresses one at a `(subject, key)` pairing: the reads of the
   * previous account are not reads of this one, so that line ENDS — which stops the
   * calls on it rather than only ignoring their replies — and the reads that follow
   * belong to a fresh one.
   */
  #readLine = new ReadScope();
  /**
   * The two mutations a provider row dispatches, and the register that retires them.
   *
   * Composed rather than inherited, and holding the generation the acts alone need:
   * `provider-readiness-acts.ts` states why the two halves separate.
   */
  readonly #acts: ProviderActs;

  public constructor(bridge: ConsoleBridge, frameStore: FrameStore) {
    this.#bridge = bridge;
    this.#frameStore = frameStore;
    this.#snapshot = zeroStateSnapshot(this.#currentRecheckBlock());
    // Arrows rather than bound methods, so the two private members an act reaches stay
    // private: what the acts hold is a pair of functions, not this model.
    this.#acts = new ProviderActs(bridge, {
      publishAction: (providerName, action) => {
        this.#publishAction(providerName, action);
      },
      readProjection: async () => {
        await this.#read();
      },
    });
    // The block is a fact about the window, so it is watched for the model's whole
    // life rather than sampled at construction: a shell that goes away while the step
    // is open has to close the control that is already on screen, and one that comes
    // back has to re-open it without waiting for a remount.
    this.#stopWatchingShell = frameStore.readable.subscribe(() => {
      this.#syncRecheckBlock();
    });
    this.#refresh = new RefreshScheduler({
      // The fixture's frozen clock wherever a scenario is playing and the real one
      // otherwise, resolved once per model.
      clock: consoleClockFor(bridge),
      // The round a performer is handed is deliberately not the one this read rides:
      // it orders the scheduler's own fires and nothing else, and a focus refresh has
      // to be superseded by an arrival read the scheduler never fired.
      perform: async () => {
        await this.#read();
      },
      // A refused read is already this model's own `unreadable` arm, so re-throwing
      // would surface the same fact a second time as an unhandled rejection.
      onError: () => undefined,
    });
  }

  public get reading(): ProviderReadinessReading {
    return this.#snapshot.reading;
  }

  /** The projection and this window's acts as one value, for a subscribed surface. */
  public get snapshot(): ProviderReadinessSnapshot {
    return this.#snapshot;
  }

  /**
   * Address this model at one account, or at the provider default.
   *
   * READS NOTHING, which is half of its job: the scope is a property of the
   * ACTIVATION and the read is the trigger set's, so folding them into one call
   * would put a second read beside the routed one and make which of the two answered
   * a question of ordering. Called before the trigger set opens, and again whenever a
   * later activation addresses this model somewhere else.
   *
   * A CHANGE OF SCOPE RETIRES WHAT THE PREVIOUS ONE PUT OUT, which is the other half,
   * and it is two acts because the two halves are retired by two mechanisms. The
   * per-provider acts are stamped, so the generation moves and a settlement about the
   * previous account neither renders nor stays pressable beside a scope that never
   * produced it; the reads are on a LINE addressed at that account, so the line ends
   * and a fresh one carries what follows. Both account-scoped fields return to the
   * zero state with them. Re-addressing at the SAME scope is not a change: it retires
   * nothing and publishes nothing, so an activation restating where this model already
   * points costs no read and no render.
   */
  public addressAt(accountScope: ProviderAccountId | undefined): void {
    if (accountScope === this.#accountScope) {
      return;
    }
    this.#accountScope = accountScope;
    this.#acts.retireInFlight();
    this.#readLine.abandon();
    this.#readLine = new ReadScope();
    this.#publish(zeroStateSnapshot(this.#snapshot.recheckBlock));
  }

  /**
   * Ask for a fresh readiness read, at whatever scope this model was addressed at.
   *
   * The ARRIVAL reads immediately, on `onboarding-flow.ts`' rule and for its reason:
   * this reading has no tail keeping it current and the fixture's clock is frozen, so
   * a first read parked behind the debounce window would never happen at all. The
   * other reason a node-scoped reading takes — a window regaining focus, which
   * arrives in bursts — is the scheduler's to coalesce.
   */
  public requestRead(reason: RefreshReason): void {
    if (reason === "subscribe") {
      void this.#read();
      return;
    }
    this.#refresh.request(reason);
  }

  /** What this window has done about one provider. Never `undefined` — idle is real. */
  public actionFor(providerName: string): ProviderActionReading {
    return this.#snapshot.actions.get(providerName) ?? IDLE_PROVIDER_ACTION;
  }

  public subscribe(listener: () => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  /** Drop this model's claim on anything unsettled. Nothing published after this. */
  public supersede(): void {
    this.#acts.retireInFlight();
    this.#stopWatchingShell();
    // The line is ended and not merely left behind: an outstanding read is dropped
    // where it stands, so a retired step neither awaits nor parses a reply nobody
    // will render. No line is minted after it — this one is terminal.
    this.#readLine.abandon();
    this.#refresh.dispose();
  }

  /** What the supervisor's condition currently costs a re-check. Derived, never held. */
  #currentRecheckBlock(): ShellMutationBlock | undefined {
    return shellBlockForMethod(this.#frameStore.getState().shellState, RECHECK_METHOD);
  }

  /**
   * Re-derive the re-check's block, and publish only where it actually moved.
   *
   * COMPARED RATHER THAN REPUBLISHED, because the store publishes on every cell it
   * holds and the shell state itself is replaced on every heartbeat that carries a new
   * timestamp — so an unguarded publish here would re-render every provider row
   * several times a minute for a cause that had not changed. The comparison is the
   * store family's own, beside the shape it compares.
   */
  #syncRecheckBlock(): void {
    const recheckBlock = this.#currentRecheckBlock();
    if (shellBlocksAreEqual(this.#snapshot.recheckBlock, recheckBlock)) {
      return;
    }
    this.#publish({ ...this.#snapshot, recheckBlock });
  }

  /**
   * Read the readiness projection at the scope this model holds.
   *
   * The scope exists for the post-refusal path alone: a run bound to a per-run
   * account override was refused about THAT account, and an unscoped read would hand
   * back the provider default's remedy — a different account, possibly healthy.
   *
   * EVERY READ OPENS A ROUND ON THIS MODEL'S LINE — the arrival, the scheduler's
   * fire, and the two acts' own re-reads alike — so the newest is the only one whose
   * reply may publish, a superseded one STOPS rather than being ignored, and a read
   * whose scope has moved is on a line that has ended. `settle` and not a comparison
   * beside it, so all three arms are one act: none publishes, and none renders the
   * door's own `read-abandoned` refusal as this step's `unreadable` arm.
   */
  async #read(): Promise<void> {
    const accountScope = this.#accountScope;
    const round = this.#readLine.openRound();
    const reply = await callDaemon(
      this.#bridge,
      "providerAccount.list",
      accountScope === undefined ? {} : { accountId: accountScope },
      { signal: round.signal },
    );
    round.settle(() => {
      this.#publish({
        ...this.#snapshot,
        reading:
          reply.status === "served"
            ? { kind: "read", entries: reply.value.readiness, accounts: reply.value.accounts }
            : { kind: "unreadable", refusal: reply.refusal },
      });
    });
  }

  /**
   * Hand the participant to one provider's own sign-in, and read again afterwards.
   *
   * The reading is resolved HERE and passed down, before the act's first await: the
   * remedy this control was rendered from names the account whose credential home the
   * invocation authenticates into, so what travels is the snapshot the person pressed
   * rather than whatever this model has published by the time the call goes out.
   */
  public async handOffSignIn(providerName: string): Promise<void> {
    await this.#acts.handOffSignIn(providerName, this.#snapshot.reading);
  }

  /**
   * Probe one account, then read the projection again.
   *
   * FAIL-CLOSED AT THE DISPATCH SITE, ahead of the in-flight publish and not only on
   * the control. The row is disabled from the same block and renders it, so a press
   * cannot ordinarily arrive here — but the block can land in the frame between the
   * render that enabled the control and the click that reaches this method, and what
   * must not happen then is a write. Publishing `rechecking` first would also leave a
   * spinner nothing settles, so the guard sits above the act; nothing is published at
   * all, because the cause is already on screen beside the control that was pressed.
   *
   * The guard is here rather than inside the act for the same reason it is fail-closed:
   * this is where the window state is, and an act reached from here has been admitted.
   */
  public async recheck(providerName: string, accountId: ProviderAccountId): Promise<void> {
    if (this.#currentRecheckBlock() !== undefined) {
      return;
    }
    await this.#acts.recheck(providerName, accountId);
  }

  /**
   * Record what this window has done about one provider.
   *
   * The replaced map is what makes the act visible: a row moving idle → handing-off
   * changes nothing about the projection. One entry per selected provider, so the
   * copy is of two.
   */
  #publishAction(providerName: string, action: ProviderActionReading): void {
    const actions = new Map(this.#snapshot.actions);
    actions.set(providerName, action);
    this.#publish({ ...this.#snapshot, actions });
  }

  #publish(snapshot: ProviderReadinessSnapshot): void {
    this.#snapshot = snapshot;
    this.#changes.emit();
  }
}
