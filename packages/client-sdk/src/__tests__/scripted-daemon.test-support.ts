// The test daemon every client-sdk test drives: an in-memory `ClientTransport` that records what
// the client sends and answers from a script, plus the frames and session events tests feed it.
// The package does not depend on the runtime daemon; both sides share the contract schemas.

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import type {
  JsonRpcError,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponseEnvelope,
} from "@ai-sidekicks/contracts/jsonrpc/message";
import type { SessionEvent } from "@ai-sidekicks/contracts/event/variant-types";
import type { SessionShape } from "@ai-sidekicks/contracts/session/methods";
import type { SessionId, UserId } from "@ai-sidekicks/contracts/session/id";
import { JSONRPC_VERSION, JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/message";
import { SUBSCRIPTION_NOTIFY_METHOD } from "@ai-sidekicks/contracts/jsonrpc/streaming";

import type { JsonRpcClientOptions } from "../transport/json-rpc-client.js";
import type { ClientTransport } from "../transport/contract.js";

/** A frame the daemon writes to the client: a reply or a notification. */
type InboundEnvelope = JsonRpcResponseEnvelope | JsonRpcNotification;

/** The client options the tests use; the queue bound is far above any test's stream. */
export const TEST_CLIENT_OPTIONS: JsonRpcClientOptions = {
  protocolVersion: "2026-05-01",
  maxQueuedValuesPerSubscription: 64,
};

/** The scripted daemon's answer to one request: a result and the notifies after it, or an error. */
export type ScriptedAnswer =
  | { readonly result: unknown; readonly followUp?: readonly JsonRpcNotification[] }
  | { readonly error: JsonRpcError };

/** The transport double plus the envelopes it captured. */
export interface ScriptedDaemon extends ClientTransport {
  /** Envelopes the client sent, in send order. */
  readonly sentEnvelopes: Array<JsonRpcRequest | JsonRpcNotification>;
  /** Delivers a frame to the client synchronously, as one transport read would. */
  deliverInbound(message: InboundEnvelope): void;
}

/**
 * Builds a transport that answers each request synchronously with `answer`. A request `answer`
 * returns `undefined` for gets no reply until the test delivers one.
 */
export function createScriptedDaemon(
  answer: (request: JsonRpcRequest) => ScriptedAnswer | undefined = () => undefined,
): ScriptedDaemon {
  const sentEnvelopes: Array<JsonRpcRequest | JsonRpcNotification> = [];
  let inboundHandler: ((message: InboundEnvelope) => void) | undefined;
  let closeHandler: ((reason?: Error) => void) | undefined;

  const deliverInbound = (message: InboundEnvelope): void => {
    if (inboundHandler === undefined) {
      throw new Error("A frame was delivered before the client registered its handler");
    }
    inboundHandler(message);
  };

  return {
    sentEnvelopes,
    deliverInbound,
    send(envelope): void {
      sentEnvelopes.push(envelope);
      if (!("id" in envelope)) {
        return;
      }
      const scripted = answer(envelope);
      if (scripted === undefined) {
        return;
      }
      if ("error" in scripted) {
        deliverInbound({ jsonrpc: JSONRPC_VERSION, id: envelope.id, error: scripted.error });
        return;
      }
      deliverInbound({ jsonrpc: JSONRPC_VERSION, id: envelope.id, result: scripted.result });
      for (const notification of scripted.followUp ?? []) {
        deliverInbound(notification);
      }
    },
    onMessage(handler): void {
      inboundHandler = handler;
    },
    onClose(handler): void {
      closeHandler = handler;
    },
    close(): Promise<void> {
      closeHandler?.(undefined);
      return Promise.resolve();
    },
  };
}

/** A scripted daemon's answers keyed by method name. */
export type ScriptedMethodTable = Readonly<
  Record<string, (request: JsonRpcRequest) => ScriptedAnswer>
>;

/**
 * Answers by method name; a method with no entry gets `MethodNotFound`, as the daemon's registry
 * answers a name it never bound.
 */
export function answerByMethod(
  table: ScriptedMethodTable,
): (request: JsonRpcRequest) => ScriptedAnswer {
  return (request) =>
    table[request.method]?.(request) ?? {
      error: { code: JsonRpcErrorCode.MethodNotFound, message: "Method not found" },
    };
}

/** The `$/subscription/notify` frame carrying `value` on `subscriptionId`. */
export function buildSubscriptionNotify(
  subscriptionId: string,
  value: unknown,
): JsonRpcNotification {
  return {
    jsonrpc: JSONRPC_VERSION,
    method: SUBSCRIPTION_NOTIFY_METHOD,
    params: { subscriptionId, value },
  };
}

/** What a `session.created` event varies by between tests. */
export interface SessionCreatedEventFields {
  readonly id: string;
  readonly sessionId: SessionId;
  readonly sequence: number;
  readonly occurredAt?: string;
  readonly shape?: SessionShape;
  readonly actor?: UserId | null;
}

/** A valid `session.created` event whose lead is a Claude agent named Implementer. */
export function buildSessionCreatedEvent(fields: SessionCreatedEventFields): SessionEvent {
  return {
    id: fields.id,
    sessionId: fields.sessionId,
    sequence: fields.sequence,
    occurredAt: fields.occurredAt ?? "2026-01-22T19:14:35.000Z",
    category: "session_lifecycle",
    type: "session.created",
    actor: fields.actor ?? null,
    version: "1.0" as SessionEvent["version"],
    payload: {
      sessionId: fields.sessionId,
      shape: fields.shape ?? "chat",
      mainAgent: {
        agentId: "00000000-0000-4000-8000-000000000044" as AgentId,
        name: "Implementer",
        binding: {
          driverName: "claude",
          modelId: "claude-sonnet-5",
          providerAccountId: null,
          effort: null,
        },
        ancestry: [],
        createdAt: "2026-01-22T19:14:35.000Z",
      },
    },
  };
}
