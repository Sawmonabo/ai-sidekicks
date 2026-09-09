// The auxiliary-window plane, as the console reaches it.
//
// WHY IT IS BESIDE THE GROWTH PORT RATHER THAN INSIDE IT, which is the same reading
// `console-bridge.ts` records for the runtime-node roster: the port refuses what the
// corpus has not registered, and this wire IS registered — `SidekicksBridge.window` is
// on the preload contract and `src/main/auxiliary-window-ipc.ts` serves it. Putting a
// registered wire on the growth port would owe a slate row for a contract that already
// exists, and would keep the live bridge refusing an operation the shell answers.
//
// WHY IT IS NOT REACHED AS `bridge.sidekicks.window` DIRECTLY. Two bridges answer this
// plane and they answer it differently — one over IPC to a shell, one out of a model
// with no shell behind it — and neither answer may REJECT: every caller dispatches
// from an effect or an event handler, where a rejection reaches nobody and leaves the
// deck's placeholder claiming a window that was never opened. So the port is the
// settling seam: it answers `served` or `unavailable` and never throws, and the
// refusal it carries is the console's own shape rather than an Electron error string.
//
// TWO REFUSAL CODES AND NOT ONE, because the two facts have different remedies. A
// build with no shell cannot open a window at all and never will in that build; a
// shell that refused may answer the next press. A single code would send a person
// looking for a fix to a state that has none.
//
// THE SUBSCRIPTIONS ARE ADAPTED, NOT RESHAPED. The preload contract carries a callback
// subscription, because that is what survives `contextBridge`; the watch above this
// module drains an async iterable, because that is what lets one lifecycle serve both
// signals. `window-signal-stream.ts` is the queue between them, and it is the same
// queue the no-shell arm pushes into — so a report reaches a watch by one path in
// every build.

import type {
  AuxiliaryWindowDetachRequest,
  AuxiliaryWindowHandle,
  AuxiliaryWindowPaneError,
  AuxiliaryWindowPaneReturn,
  SidekicksBridge,
} from "@ai-sidekicks/contracts";

import { lossyStringify, refuse, type NarrowedRefusal } from "../core/index.js";
import { WindowSignalStreams, type WindowSignalStream } from "./window-signal-stream.js";

/**
 * Why the auxiliary-window plane could not answer. Closed; a third is a decision.
 *
 *   • `shell-absent` — this build has no shell to open a window in. A fact about the
 *     BUILD, which no retry changes, and the honest answer for a console running in a
 *     browser rather than inside Electron.
 *   • `shell-refused` — the shell was asked and answered with a fault: an unknown
 *     route, a handle it is no longer holding, a preload that did not finish
 *     installing. A different press may succeed.
 *
 * A TYPE and not a `readonly` tuple, unlike the composer's refusal vocabularies: those
 * are iterated — a recognizer tests membership, a suite asserts the set has no
 * duplicate — and this one is not. Nothing here reads the codes at runtime; the two
 * constructors below name their code as a literal and the checker binds it. A tuple
 * declared for symmetry would be a value with no reader, which is what the dead-code
 * gate reports.
 */
type AuxiliaryWindowRefusalCode = "shell-absent" | "shell-refused";

/** The subsystem name every refusal this module raises carries. */
const AUXILIARY_WINDOW_REFUSAL_ORIGIN = "auxiliary-windows";

/** A typed plane refusal — `core`'s one refusal shape, narrowed on `code`. */
export type AuxiliaryWindowRefusal = NarrowedRefusal<AuxiliaryWindowRefusalCode>;

/** What one plane call answers with: the value, or the refusal — never a rejection. */
export type AuxiliaryWindowOutcome<TValue> =
  | { readonly status: "served"; readonly value: TValue }
  | ({ readonly status: "unavailable" } & AuxiliaryWindowRefusal);

/**
 * The plane, as every console surface holds it.
 *
 * Method names are the bridge namespace's own, so a reader moving between the port
 * and the contract reads one vocabulary. Every method resolves; none rejects.
 */
export interface AuxiliaryWindowPort {
  detachPane(
    request: AuxiliaryWindowDetachRequest,
  ): Promise<AuxiliaryWindowOutcome<AuxiliaryWindowHandle>>;
  focusAuxiliary(request: AuxiliaryWindowHandle): Promise<AuxiliaryWindowOutcome<void>>;
  closeAuxiliary(request: AuxiliaryWindowHandle): Promise<AuxiliaryWindowOutcome<void>>;
  subscribePaneErrors(): Promise<
    AuxiliaryWindowOutcome<WindowSignalStream<AuxiliaryWindowPaneError>>
  >;
  subscribePaneReturns(): Promise<
    AuxiliaryWindowOutcome<WindowSignalStream<AuxiliaryWindowPaneReturn>>
  >;
}

/** The refusal a build with no shell answers every operation with. */
export function refuseWithoutShell(): AuxiliaryWindowOutcome<never> {
  return {
    status: "unavailable",
    ...refuseAuxiliaryWindow(
      "shell-absent",
      "This build has no window shell, so a pane cannot be moved into a window of its own.",
    ),
  };
}

/**
 * The shell-backed plane, over the preload bridge's own namespace.
 *
 * TOTAL OVER FAILURE, which is the whole reason this wrapper exists rather than the
 * handoff calling `sidekicks.window` itself. Three things can go wrong on that
 * boundary and all three arrive as a rejection or a synchronous throw: the main
 * handler refused the descriptor, the handle names a window the shell is no longer
 * holding, or the preload never finished installing and the member is still the
 * contract's throwing stub. Each becomes `shell-refused` carrying what was said.
 */
export function createShellAuxiliaryWindowPort(sidekicks: SidekicksBridge): AuxiliaryWindowPort {
  const paneErrors = new ShellSignalBridge<AuxiliaryWindowPaneError>((handler) =>
    sidekicks.window.subscribePaneErrors(handler),
  );
  const paneReturns = new ShellSignalBridge<AuxiliaryWindowPaneReturn>((handler) =>
    sidekicks.window.subscribePaneReturns(handler),
  );
  return {
    detachPane: async (request) => settledShellCall(() => sidekicks.window.detachPane(request)),
    focusAuxiliary: async (request) =>
      settledShellCall(() => sidekicks.window.focusAuxiliary(request)),
    closeAuxiliary: async (request) =>
      settledShellCall(() => sidekicks.window.closeAuxiliary(request)),
    subscribePaneErrors: async () => paneErrors.open(),
    subscribePaneReturns: async () => paneReturns.open(),
  };
}

/** Build one plane refusal. The two codes' sentences are the caller's own. */
function refuseAuxiliaryWindow(
  code: AuxiliaryWindowRefusalCode,
  detail: string,
): AuxiliaryWindowRefusal {
  return refuse(AUXILIARY_WINDOW_REFUSAL_ORIGIN, code, detail);
}

/**
 * One shell call, settled.
 *
 * The `try` wraps the CALL as well as the await, because the contract's Tier-1 stub
 * throws synchronously — a window whose preload did not install the real namespace
 * never reaches a promise at all, and a bare `await` on the result would throw out of
 * this function rather than answering.
 */
async function settledShellCall<TValue>(
  call: () => Promise<TValue>,
): Promise<AuxiliaryWindowOutcome<TValue>> {
  try {
    return { status: "served", value: await call() };
  } catch (rejection: unknown) {
    return {
      status: "unavailable",
      ...refuseAuxiliaryWindow("shell-refused", describeShellFailure(rejection)),
    };
  }
}

/**
 * The preload's callback subscription, as the drainable stream a watch reads.
 *
 * ONE REGISTRATION PER SIGNAL AND MANY STREAMS OVER IT, which is what the fan-out
 * below buys: the watch opens and closes its stream every time the detached set
 * empties and refills, and re-registering an `ipcRenderer` listener on each of those
 * would leak one per cycle if a close ever failed to land. The registration is made
 * once, on the first open, and the listener stays for the window's life — a listener
 * over a signal nobody is draining reaches an empty fan-out and costs nothing.
 *
 * A class rather than a closure pair because the registration is STATE: whether the
 * listener is installed decides what `open` does, and a module-level flag would make
 * two windows in one process share one reading.
 */
class ShellSignalBridge<TEvent> {
  readonly #subscribe: (handler: (event: TEvent) => void) => () => void;
  readonly #streams = new WindowSignalStreams<TEvent>();
  #isRegistered = false;

  public constructor(subscribe: (handler: (event: TEvent) => void) => () => void) {
    this.#subscribe = subscribe;
  }

  public open(): AuxiliaryWindowOutcome<WindowSignalStream<TEvent>> {
    if (!this.#isRegistered) {
      try {
        this.#subscribe((event) => {
          this.#streams.report(event);
        });
      } catch (rejection: unknown) {
        return {
          status: "unavailable",
          ...refuseAuxiliaryWindow("shell-refused", describeShellFailure(rejection)),
        };
      }
      this.#isRegistered = true;
    }
    return { status: "served", value: this.#streams.subscribe() };
  }
}

/**
 * An unknown thrown value as one sentence, without inventing a shape for it.
 *
 * `lossyStringify` rather than `String`: a caught value may be a revoked proxy, a
 * null-prototype object, or a `toString` that throws — and a `contextBridge` boundary
 * is exactly where an exotic value arrives — and `String` on any of those throws out
 * of the handler written to keep a failure from escaping.
 */
function describeShellFailure(rejection: unknown): string {
  return rejection instanceof Error ? rejection.message : lossyStringify(rejection);
}
