// Main forwards the renderer's daemon calls and subscriptions to the daemon client it holds. The
// renderer is untrusted, so a call is checked here, where it enters main: only a method the app
// calls goes, its params checked against the method's contract before anything is sent and its
// reply after, with each file token the method takes put back as its path and a token minted for
// each path the reply offers to open (`file-path/relay.ts`). A subscription opens only under a
// stream name the app opens (`#shared/daemon/streams.ts`): the daemon runs whatever method a
// subscription names, so any other name would reach a method `call()` refuses. Its params go to the
// daemon, which checks them, except for the one main types itself, the machine's settings, which
// is checked against its contract on both sides. Nothing main holds for its own connection crosses
// back: a refusal carries only the wire error's code, message and data, and any other failure only
// its message. Over a refused handshake the console is read-only: no mutating call is sent, and
// reads and subscriptions still go. The two calls that end work, `daemon.stop` and
// `daemon.restart`, go only over a link that reads connected with a compatible handshake; the
// daemon's own gate is the check that decides, and this one answers the renderer in its terms.
// They go through the supervisor, which flushes first and ends a service that keeps running after
// it took the request.
//
// `daemon.status` is main's own topic on the same channel: it delivers the link's state, the
// current one first, while no service answers too, and ends only when the page closes it or goes.
// A daemon subscription whose reply carries more than its id, as a list subscription's carries the
// list, hands that reply whole to the page as its first value, ahead of every push. One that ends
// while the page still holds it is told to the page as an end.

import { JsonRpcRemoteError, type LocalSubscriptionConsumer } from "@ai-sidekicks/client-sdk";
import { DAEMON_LIFECYCLE_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/daemon/lifecycle";
import {
  JsonRpcErrorCode,
  TRANSPORT_UNAVAILABLE_CODE,
  type JsonRpcError,
} from "@ai-sidekicks/contracts/jsonrpc/message";
import { NEGOTIATION_VERSION_MISMATCH_CODE } from "@ai-sidekicks/contracts/jsonrpc/negotiation";
import { METHOD_NAME_FORMAT } from "@ai-sidekicks/contracts/jsonrpc/registry";
import { MACHINE_SETTINGS_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/machine-settings";
import type {
  AnyMethodDescriptor,
  MethodDescriptor,
} from "@ai-sidekicks/contracts/method-descriptor";
import { z, type ZodType } from "zod";

import { daemonMethodBindingFor } from "#shared/daemon/method-bindings.js";
import { isDaemonStream, MACHINE_SETTINGS_STREAM } from "#shared/daemon/streams.js";
import {
  DAEMON_SUBSCRIPTION_END_CHANNEL,
  DAEMON_SUBSCRIPTION_VALUE_CHANNEL,
} from "#shared/bridge-channels.js";
import type {
  DaemonCallOutcome,
  DaemonCallRequest,
  DaemonSubscriptionEnd,
  DaemonSubscriptionOpening,
  DaemonSubscriptionRequest,
} from "#shared/daemon/forwarding.js";
import { DAEMON_STATUS_TOPIC } from "#shared/daemon/status-topic.js";
import { NOT_CONNECTED_MESSAGE, type DaemonLink } from "../services/daemon/link/status.js";
import type { DaemonSupervisor, ServiceEndingMethod } from "../services/daemon/supervisor.js";
import type { MainDiagnosticLog } from "../services/diagnostic-log.js";
import { describeFailure } from "#shared/failure-message.js";
import { copiedFilePaths, mintTokensForPaths, swapTokensForPaths } from "./file-path/relay.js";
import type { FilePathRefOwner, FilePathRefs } from "./file-path/refs.js";
import type { PastedImages } from "./native/file-intake.js";
import { pageSafeMessage } from "./page-safe-message.js";

/**
 * The page a subscription delivers to: its id, the pushes its values and its end ride on, and the
 * two moments its subscriptions end, when it is destroyed and when it navigates to a new document.
 */
export interface DaemonSubscriber {
  readonly id: number;
  send(channel: string, subscriptionId: string, delivery: unknown): void;
  once(event: "destroyed", listener: () => void): unknown;
  on(event: "did-navigate", listener: () => void): unknown;
}

/**
 * What the forwarding reads the daemon through, the file tokens main handed the pages, the pasted
 * pictures removed once the service copied them, who carries the person's `Stop` and `Restart`,
 * and where a failed subscription is recorded.
 */
export interface DaemonForwardingOptions {
  readonly link: DaemonLink;
  readonly filePathRefs: FilePathRefs;
  readonly pastedImages: Pick<PastedImages, "removeCopied">;
  readonly supervisor: Pick<DaemonSupervisor, "endService">;
  readonly log: Pick<MainDiagnosticLog, "write">;
}

/**
 * How a call main types itself ended: as `DaemonCallOutcome`, its served value read against the
 * method's response contract.
 */
export type DescribedCallOutcome<Response> =
  | { readonly outcome: "served"; readonly value: Response }
  | Exclude<DaemonCallOutcome, { readonly outcome: "served" }>;

/** The renderer's calls that end work on the machine. */
const WORK_ENDING_METHODS: readonly ServiceEndingMethod[] = [
  DAEMON_LIFECYCLE_METHOD_DESCRIPTORS["daemon.stop"].method,
  DAEMON_LIFECYCLE_METHOD_DESCRIPTORS["daemon.restart"].method,
];

const methodNameSchema = z.string().regex(METHOD_NAME_FORMAT);

const daemonCallRequestSchema: z.ZodType<DaemonCallRequest> = z.object({
  method: methodNameSchema,
  params: z.unknown(),
});

const subscriptionIdSchema = z.uuid();

const daemonSubscriptionRequestSchema: z.ZodType<DaemonSubscriptionRequest> = z.object({
  subscriptionId: subscriptionIdSchema,
  event: methodNameSchema,
  params: z.unknown(),
});

/** A subscription's value main passes through unread: the daemon checks it, the page parses it. */
const wireValueSchema = z.unknown();

/** The status topic takes nothing. */
const statusRequestSchema = z.strictObject({});

/** A subscription's request and value schemas. */
interface DescribedSubscription {
  readonly requestSchema: ZodType;
  readonly emissionSchema: ZodType;
}

/** The contract main checks `event` against in both directions, if it types that stream itself. */
function describedSubscriptionOf(event: string): DescribedSubscription | undefined {
  return event === MACHINE_SETTINGS_STREAM
    ? MACHINE_SETTINGS_METHOD_DESCRIPTORS[MACHINE_SETTINGS_STREAM]
    : undefined;
}

/** One subscription a page holds open: how main ends it, set once it has started. */
interface OpenSubscription {
  close: () => void;
}

/** Main's half of the daemon's wire: the calls it forwards, and each page's open subscriptions. */
export class DaemonForwarding {
  readonly #link: DaemonLink;
  readonly #filePathRefs: FilePathRefs;
  readonly #pastedImages: Pick<PastedImages, "removeCopied">;
  readonly #supervisor: Pick<DaemonSupervisor, "endService">;
  readonly #log: Pick<MainDiagnosticLog, "write">;
  /** Each page's open subscriptions, by the id its preload named them with. */
  readonly #subscriptionsByPage = new Map<number, Map<string, OpenSubscription>>();

  public constructor(options: DaemonForwardingOptions) {
    this.#link = options.link;
    this.#filePathRefs = options.filePathRefs;
    this.#pastedImages = options.pastedImages;
    this.#supervisor = options.supervisor;
    this.#log = options.log;
  }

  /**
   * Forward one call from `page` and answer how it ended. A method the app does not call, params
   * off the method's contract and a value in a file member that is not a token `page` holds are
   * answered as failed before anything is sent, and a mutating call over a refused handshake as
   * refused. Throws a `ZodError` for a request that is not a method name and its params.
   */
  public async call(page: FilePathRefOwner, request: unknown): Promise<DaemonCallOutcome> {
    const { method, params } = daemonCallRequestSchema.parse(request);
    const workEndingMethod = WORK_ENDING_METHODS.find((ending) => ending === method);
    if (workEndingMethod !== undefined) {
      if (
        !DAEMON_LIFECYCLE_METHOD_DESCRIPTORS[workEndingMethod].requestSchema.safeParse(params)
          .success
      ) {
        return { outcome: "failed", message: `The ${method} request does not match its contract.` };
      }
      const refusal = workEndingRefusal(this.#link);
      return refusal === undefined
        ? this.#endService(workEndingMethod)
        : { outcome: "refused", refusal };
    }
    const binding = daemonMethodBindingFor(method);
    if (binding === undefined) {
      return { outcome: "failed", message: `The app does not call ${method}.` };
    }
    const versionRefusal = mutationRefusal(this.#link, binding);
    if (versionRefusal !== undefined) {
      return { outcome: "refused", refusal: versionRefusal };
    }
    let sendable: unknown;
    try {
      sendable = swapTokensForPaths(this.#filePathRefs, page, method, params);
    } catch (failure) {
      return { outcome: "failed", message: describeFailure(failure) };
    }
    const client = this.#link.client;
    if (client === undefined) {
      return { outcome: "failed", message: NOT_CONNECTED_MESSAGE };
    }
    try {
      // The client checks the params before anything is sent and the reply before it resolves.
      const value = await client.call(
        method,
        sendable,
        binding.requestSchema,
        binding.responseSchema,
      );
      this.#pastedImages.removeCopied(page, copiedFilePaths(method, sendable, value));
      const fileRefs = mintTokensForPaths(this.#filePathRefs, page, method, value);
      return Object.keys(fileRefs).length === 0
        ? { outcome: "served", value }
        : { outcome: "served", value, fileRefs };
    } catch (failure) {
      return unservedOutcomeOf(method, failure);
    }
  }

  /** Hand `daemon.stop` or `daemon.restart` to the supervisor, which flushes first. */
  async #endService(method: ServiceEndingMethod): Promise<DaemonCallOutcome> {
    try {
      return { outcome: "served", value: await this.#supervisor.endService(method) };
    } catch (failure) {
      return unservedOutcomeOf(method, failure);
    }
  }

  /**
   * Forward one call main types itself. The client checks the request against the method's
   * contract before anything is sent, answering a refused one as failed, and the reply after; a
   * mutating call over a refused handshake is answered as refused.
   */
  public async callDescribed<Request, Response>(
    contract: MethodDescriptor<string, Request, Response>,
    request: unknown,
  ): Promise<DescribedCallOutcome<Response>> {
    const versionRefusal = mutationRefusal(this.#link, contract);
    if (versionRefusal !== undefined) {
      return { outcome: "refused", refusal: versionRefusal };
    }
    const client = this.#link.client;
    if (client === undefined) {
      return { outcome: "failed", message: NOT_CONNECTED_MESSAGE };
    }
    try {
      const value = await client.call(
        contract.method,
        request as Request,
        contract.requestSchema,
        contract.responseSchema,
      );
      return { outcome: "served", value };
    } catch (failure) {
      return unservedOutcomeOf(contract.method, failure);
    }
  }

  /**
   * Open one subscription for a page and push its values to it until it is closed, ends, or the
   * page goes. Answers synchronously: opened, or why not. The status topic opens with no service
   * linked; a daemon subscription needs one, and a name that is not a stream the app opens is
   * refused before anything is sent.
   */
  public open(page: DaemonSubscriber, request: unknown): DaemonSubscriptionOpening {
    const parsed = daemonSubscriptionRequestSchema.safeParse(request);
    if (!parsed.success) {
      return {
        outcome: "failed",
        message: "A daemon subscription is opened with a new id, an event name and its request.",
      };
    }
    const { subscriptionId, event, params } = parsed.data;
    if (event === DAEMON_STATUS_TOPIC) {
      if (!statusRequestSchema.safeParse(params).success) {
        return { outcome: "failed", message: "The daemon.status topic is opened with nothing." };
      }
      return this.#adopt(page, subscriptionId, () =>
        this.#link.subscribe((state) => {
          page.send(DAEMON_SUBSCRIPTION_VALUE_CHANNEL, subscriptionId, state);
        }),
      );
    }
    if (!isDaemonStream(event)) {
      return { outcome: "failed", message: `The app does not subscribe to ${event}.` };
    }
    const described = describedSubscriptionOf(event);
    if (described !== undefined && !described.requestSchema.safeParse(params).success) {
      return { outcome: "failed", message: `The ${event} request does not match its contract.` };
    }
    const client = this.#link.client;
    if (client === undefined) {
      return { outcome: "failed", message: NOT_CONNECTED_MESSAGE };
    }
    return this.#adopt(page, subscriptionId, (entry) => {
      const consumer = client.subscribe(
        event,
        params,
        described?.requestSchema ?? wireValueSchema,
        described?.emissionSchema ?? wireValueSchema,
      );
      void this.#deliver(page, event, subscriptionId, entry, consumer);
      return () => {
        // `cancel()` never rejects: a failed cancel ends the stream with its error, which the
        // subscription's delivery loop logs.
        void consumer.cancel();
      };
    });
  }

  /**
   * Close one of a page's subscriptions. Closing one that already ended does nothing. Throws a
   * `ZodError` for an id that is not one.
   */
  public close(page: DaemonSubscriber, subscriptionId: unknown): void {
    const id = subscriptionIdSchema.parse(subscriptionId);
    const subscriptions = this.#subscriptionsByPage.get(page.id);
    const subscription = subscriptions?.get(id);
    if (subscriptions === undefined || subscription === undefined) {
      return;
    }
    subscriptions.delete(id);
    subscription.close();
  }

  /**
   * Hold a new subscription under the id the page named it with, refusing an id already open. It
   * starts only once the id is taken, handed its own entry so its delivery can tell whether the
   * page still holds it, and answers how to end it.
   */
  #adopt(
    page: DaemonSubscriber,
    subscriptionId: string,
    start: (entry: OpenSubscription) => () => void,
  ): DaemonSubscriptionOpening {
    const subscriptions = this.#subscriptionsOf(page);
    if (subscriptions.has(subscriptionId)) {
      return { outcome: "failed", message: "That daemon subscription is already open." };
    }
    const entry: OpenSubscription = { close: () => undefined };
    subscriptions.set(subscriptionId, entry);
    entry.close = start(entry);
    return { outcome: "opened" };
  }

  /** A page's subscriptions, ending them all when it is destroyed or loads a new document. */
  #subscriptionsOf(page: DaemonSubscriber): Map<string, OpenSubscription> {
    const known = this.#subscriptionsByPage.get(page.id);
    if (known !== undefined) {
      return known;
    }
    const subscriptions = new Map<string, OpenSubscription>();
    this.#subscriptionsByPage.set(page.id, subscriptions);
    page.on("did-navigate", () => {
      closeEvery(subscriptions);
    });
    page.once("destroyed", () => {
      closeEvery(subscriptions);
      this.#subscriptionsByPage.delete(page.id);
    });
    return subscriptions;
  }

  /**
   * Push the reply's opening value, when it has one, and then each value to the page while it holds
   * the subscription, then tell it how the subscription ended, unless the page closed it first. A
   * failure also goes to main's log.
   */
  async #deliver(
    page: DaemonSubscriber,
    event: string,
    subscriptionId: string,
    entry: OpenSubscription,
    consumer: LocalSubscriptionConsumer<unknown>,
  ): Promise<void> {
    const isHeld = (): boolean =>
      this.#subscriptionsByPage.get(page.id)?.get(subscriptionId) === entry;
    let end: DaemonSubscriptionEnd = { reason: "completed" };
    try {
      // The values that arrive meanwhile wait in the consumer, so the opening value goes first.
      const openingValue = await consumer.readOpeningValue();
      if (openingValue !== undefined) {
        if (!isHeld()) {
          return;
        }
        page.send(DAEMON_SUBSCRIPTION_VALUE_CHANNEL, subscriptionId, openingValue);
      }
      for await (const value of consumer) {
        if (!isHeld()) {
          return;
        }
        page.send(DAEMON_SUBSCRIPTION_VALUE_CHANNEL, subscriptionId, value);
      }
    } catch (failure) {
      this.#log.write({
        level: "error",
        source: "main/bridge/daemon",
        message: `The daemon subscription ${event} failed: ${describeFailure(failure)}`,
      });
      end =
        failure instanceof JsonRpcRemoteError
          ? { reason: "refused", refusal: wireErrorOf(failure) }
          : { reason: "failed", message: pageSafeMessage(event, failure) };
    }
    if (isHeld()) {
      this.#subscriptionsByPage.get(page.id)?.delete(subscriptionId);
      page.send(DAEMON_SUBSCRIPTION_END_CHANNEL, subscriptionId, end);
    }
  }
}

/**
 * Why a mutating call may not go over this link: a refused handshake is the daemon's own
 * `protocol.version_mismatch`, as its gate would answer. `undefined` for a read, and for any call
 * over a link that is not refused.
 */
function mutationRefusal(
  link: DaemonLink,
  contract: Pick<AnyMethodDescriptor, "mutating">,
): JsonRpcError | undefined {
  if (!contract.mutating || link.state.connection.kind !== "version_incompatible") {
    return undefined;
  }
  return {
    code: JsonRpcErrorCode.InvalidRequest,
    message: "The background service refused this app's version, so nothing that changes is sent.",
    data: { type: NEGOTIATION_VERSION_MISMATCH_CODE },
  };
}

/**
 * Why a call that ends work may not go now, in the error contract's registered codes: no link that
 * reads connected is `transport.unavailable` naming the link's state, and a refused handshake is
 * the daemon's own `protocol.version_mismatch`. `undefined` when it may go.
 */
function workEndingRefusal(link: DaemonLink): JsonRpcError | undefined {
  const connection = link.state.connection;
  if (connection.kind === "connected" && link.client !== undefined) {
    return undefined;
  }
  if (connection.kind === "version_incompatible") {
    return {
      code: JsonRpcErrorCode.InvalidRequest,
      message:
        "The background service refused this app's version, so nothing that ends work is sent.",
      data: { type: NEGOTIATION_VERSION_MISMATCH_CODE },
    };
  }
  return {
    code: JsonRpcErrorCode.InternalError,
    message: NOT_CONNECTED_MESSAGE,
    data: { type: TRANSPORT_UNAVAILABLE_CODE, fields: { reason: connection.kind } },
  };
}

/**
 * A call to `method` that threw: the daemon's refusal, or a failure on main's side by a message
 * that names no path.
 */
function unservedOutcomeOf(
  method: string,
  failure: unknown,
): Exclude<DaemonCallOutcome, { readonly outcome: "served" }> {
  return failure instanceof JsonRpcRemoteError
    ? { outcome: "refused", refusal: wireErrorOf(failure) }
    : { outcome: "failed", message: pageSafeMessage(method, failure) };
}

/** The refusal as the wire sent it: its code, message and data, and nothing else. */
function wireErrorOf(remote: JsonRpcRemoteError): JsonRpcError {
  if (remote.data === undefined) {
    return { code: remote.code, message: remote.message };
  }
  const { type, fields } = remote.data;
  return {
    code: remote.code,
    message: remote.message,
    data: fields === undefined ? { type } : { type, fields },
  };
}

function closeEvery(subscriptions: Map<string, OpenSubscription>): void {
  const open = [...subscriptions.values()];
  // Cleared first, so a delivery that settles as these close sees the page no longer holds it.
  subscriptions.clear();
  for (const subscription of open) {
    subscription.close();
  }
}
