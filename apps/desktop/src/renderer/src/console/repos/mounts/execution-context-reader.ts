// One workspace's execution-context read: scheduled, published, and never polled.
//
// A READER OF ITS OWN, RATHER THAN A LEG OF THE SECTION'S BURST. The mounts reader
// answers a SESSION-scoped question — which mounts, which workspaces, which roots — in
// one burst per read, and this is a WORKSPACE-scoped one: a session holding six
// workspaces would add six calls to that burst, five of which no open disclosure is
// reading. It is also on a different wire. The section's legs are registered daemon
// methods parsed by the call door; this one is a growth-slate row with no registered
// method behind it, so its ordinary answer in a shipped build is a typed absence
// naming the document that owes the wire — which is a fact about ONE row rather than
// about the section, and folding it into the burst would have made the whole reading
// carry a refusal for a wire nothing else in it needs.
//
// IT REFRESHES THROUGH THE CONSOLE'S ONE SCHEDULER AND ARMS NO TIMER. `Spec-023 §Rules
// every console surface obeys` fixes the policy — reads happen on subscribe, on window
// focus, on reconnect, and on the terminal events the owning spec names, under "No
// interval polling" — so this class hands itself to a `SessionRefreshTriggers` exactly
// as `repo-mounts-reader.ts` beside it does and owns no listener of its own. A reader
// that read once at construction would be correct at mount and stale from the first
// reconnect, with nothing on screen saying so; the execution root a workspace runs
// against is exactly the fact a `workspace.stale` frame changes.
//
// IT WATCHES THE FAMILY'S OWN EVENT CENSUS AND NOT A LIST WRITTEN HERE. Which frames
// change this answer is a property of the QUESTION rather than of the surface asking
// it, and `repo-lifecycle-events.ts` derives the family's census from the contract's
// own registry — so a kind list restated here would be two readers of one answer
// disagreeing about when it goes stale.
//
// THE CLASS HOLDS THE STATE, WHICH IS `apps/desktop/AGENTS.md`'S RULE FOR ANYTHING
// STATEFUL: the reading, the in-flight guard, and the disposal flag are private
// fields, and the surface reaches them through `useSyncExternalStore` in the binding
// beside this class rather than through a value a render body built.

import { Emitter, type ConsoleClock, type Unsubscribe } from "../../core/index.js";
import { growthUnavailableFromRejection, type ConsoleBridge } from "../../bridge/index.js";
import {
  RefreshScheduler,
  SessionRefreshTriggers,
  type ReadTriggerTarget,
  type RefreshReason,
  type SessionStore,
} from "../../store/index.js";
import { readGrowthAnswer } from "../growth-call.js";
import { REPO_LIFECYCLE_EVENT_KINDS } from "../repo-lifecycle-events.js";
import {
  EXECUTION_CONTEXT_NOT_READ,
  type ExecutionContextReading,
  type WorkspaceExecutionContext,
} from "./execution-context-model.js";

/** This console's own name for the read, for a reply it could not use. */
const EXECUTION_CONTEXT_LEG = "workspace execution context";

/** What one reader is scoped to: a workspace, the session it sits in, and the clock. */
export interface WorkspaceExecutionContextReaderOptions {
  readonly bridge: ConsoleBridge;
  readonly workspaceId: string;
  /** The session whose reconnect edge and lifecycle frames re-ask this question. */
  readonly sessionStore: SessionStore;
  /** The window's one clock, so this refresh coalesces on the section's time base. */
  readonly clock: ConsoleClock;
}

/**
 * Reads one workspace's execution context and publishes what came back.
 *
 * `start` IS IDEMPOTENT and arms the triggers once: a strict-mode double effect, a
 * re-subscribe, and a re-render all call it, and a reader that armed a second trigger
 * set for each would answer one reconnect with as many reads as it had been rendered.
 */
export class WorkspaceExecutionContextReader implements ReadTriggerTarget {
  /**
   * The frames that owe this reading a fresh read.
   *
   * THE FAMILY'S CENSUS AND NOT A LIST OF ITS OWN, on `repo-mounts-reader.ts`'s rule:
   * an execution root is bound, rebound, and invalidated by exactly the repo-lifecycle
   * frames that census names, and two readers of one answer must not disagree about
   * when it goes stale.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = new Set<string>(
    REPO_LIFECYCLE_EVENT_KINDS,
  );
  readonly #bridge: ConsoleBridge;
  readonly #workspaceId: string;
  readonly #scheduler: RefreshScheduler;
  readonly #triggers: SessionRefreshTriggers;
  readonly #changes = new Emitter<ExecutionContextReading>("workspace execution context reading");
  #reading: ExecutionContextReading = EXECUTION_CONTEXT_NOT_READ;
  #started = false;
  #disposed = false;

  public constructor(options: WorkspaceExecutionContextReaderOptions) {
    this.#bridge = options.bridge;
    this.#workspaceId = options.workspaceId;
    this.#scheduler = new RefreshScheduler({
      clock: options.clock,
      perform: async () => {
        await this.#performRead();
      },
      // A read that threw past its own refusal handling reaches nobody from inside a
      // scheduler callback, so it lands in the reading as a refusal instead — the
      // disclosure renders it rather than holding whatever it held before.
      onError: (error: unknown) => {
        this.#publish({
          status: "refused",
          refusal: growthUnavailableFromRejection("workspaceExecutionContextRead", error),
        });
      },
    });
    this.#triggers = new SessionRefreshTriggers({
      target: this,
      sessionStore: options.sessionStore,
    });
  }

  public get snapshot(): ExecutionContextReading {
    return this.#reading;
  }

  /**
   * Whether this reader has been ended.
   *
   * Read by the resource seam beside `dispose`, which is terminal here: a disposed
   * reader publishes nothing ever again, so a seam that re-committed one would hold a
   * value whose surface never updates. The pair travels together for that reason.
   */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  public subscribe(sink: (reading: ExecutionContextReading) => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /** Arm the refresh triggers and take the first read. Idempotent. */
  public start(): void {
    if (this.#started || this.#disposed) {
      return;
    }
    this.#started = true;
    this.#triggers.start();
    this.requestRead("subscribe");
  }

  /**
   * Ask for a read, on one of the four reasons the policy admits.
   *
   * COALESCED BY THE SCHEDULER AND NEVER SENT FROM HERE, which is what makes a
   * reconnect landing beside a lifecycle frame one call rather than two.
   */
  public requestRead(reason: RefreshReason): void {
    if (this.#disposed) {
      return;
    }
    if (this.#reading.status === "not-read") {
      this.#publish({ status: "reading" });
    }
    this.#scheduler.request(reason);
  }

  public dispose(): void {
    this.#disposed = true;
    this.#scheduler.dispose();
    this.#triggers.dispose();
    this.#changes.clear();
  }

  async #performRead(): Promise<void> {
    const answer = await readGrowthAnswer(
      "workspaceExecutionContextRead",
      EXECUTION_CONTEXT_LEG,
      () => this.#bridge.growth.workspaceExecutionContextRead({ workspaceId: this.#workspaceId }),
    );
    if (this.#disposed) {
      // The surface that asked has gone. Publishing here would call sinks the seam
      // has already dropped, which is the leak the disposal flag exists to prevent.
      return;
    }
    if (answer.status === "refused") {
      this.#publish({ status: "refused", refusal: answer.refusal });
      return;
    }
    this.#publish({ status: "read", context: answer.value satisfies WorkspaceExecutionContext });
  }

  #publish(reading: ExecutionContextReading): void {
    this.#reading = reading;
    this.#changes.emit(reading);
  }
}
