// The session controls the session's provider driver carries out: the Build or Plan mode, the side
// question, the provider's own review, and the live `/` list.
//
// - The registry parses each request against its descriptor's schema before the handler runs, and
//   the streaming primitive parses every emitted list against the descriptor's emission schema.
// - The driver is the one the session runs on, found by `resolveDriverForSession`; a session this
//   node does not hold is refused `session.not_found` before any driver is looked up.
// - The `/` list is gated on `provider_commands` before its subscription is allocated, so a
//   refusal leaves nothing behind.

import type { Handler, MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import type { SubscribeAckResponse } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import type {
  ProviderCommandEntry,
  ProviderCommandListResult,
} from "@ai-sidekicks/contracts/provider/driver/commands";
import {
  SESSION_CONTROL_METHOD_DESCRIPTORS,
  SideQuestionIdSchema,
  type SessionAddressedRequest,
  type SessionMode,
  type SessionProviderCommandList,
  type SessionServerPrompt,
} from "@ai-sidekicks/contracts/session/controls/methods";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { ProviderDriver } from "../../../provider/driver/contract.js";
import type { ProviderRegistry } from "../../../provider/driver/registry.js";
import { mintUuidV7 } from "../../../uuid-v7.js";
import type { StreamingPrimitive } from "../../streaming-primitive.js";
import { createSubscriptionAckBarrier } from "../../subscription-ack-barrier.js";
import { resolveDriverForSessionOrThrow, type SessionDriverDeps } from "../driver/resolution.js";
import { registerDescribedMethod } from "../register-described-method.js";

/** What the session control handlers call: the session's driver and the shared streaming. */
export interface SessionControlHandlerDeps extends SessionDriverDeps {
  /** `checkCapability` joins `lookup` because the `/` list is capability-gated. */
  readonly providerRegistry: Pick<ProviderRegistry, "lookup" | "checkCapability">;
  /** The primitive every streaming handler shares, so a disconnect cleans up all of them. */
  readonly streamingPrimitive: StreamingPrimitive;
  /** Stores the mode the provider took, which a restart resumes in. */
  readonly recordSessionMode: (sessionId: SessionId, mode: SessionMode) => Promise<void>;
}

/**
 * Binds `session.modeUpdate`, `session.sideQuestionAsk`, `session.reviewStart` and
 * `session.providerCommandsSubscribe` onto the registry. A session this node does not hold is
 * refused `session.not_found`, a driver this node has not loaded `driver.unavailable`, and a `/`
 * list on a driver without `provider_commands` `driver.capability_unsupported`; a second binding
 * on one registry throws.
 */
export function registerSessionControlMethods(
  registry: MethodRegistry,
  deps: SessionControlHandlerDeps,
): void {
  registerDescribedMethod(
    registry,
    SESSION_CONTROL_METHOD_DESCRIPTORS["session.modeUpdate"],
    async (request) => {
      const { driver } = resolveDriverForSessionOrThrow(deps, request.sessionId);
      await driver.updateSessionMode({ sessionId: request.sessionId, mode: request.mode });
      // Stored once the provider took it, so the record never names a mode it refused.
      await deps.recordSessionMode(request.sessionId, request.mode);
      return { sessionId: request.sessionId, mode: request.mode };
    },
  );

  registerDescribedMethod(
    registry,
    SESSION_CONTROL_METHOD_DESCRIPTORS["session.sideQuestionAsk"],
    async (request) => {
      const { driver } = resolveDriverForSessionOrThrow(deps, request.sessionId);
      // The answer's event carries this id, so it is minted like every other event-borne id.
      const sideQuestionId = SideQuestionIdSchema.parse(mintUuidV7());
      await driver.askSideQuestion({
        sessionId: request.sessionId,
        sideQuestionId,
        question: request.question,
      });
      return { sessionId: request.sessionId, sideQuestionId };
    },
  );

  registerDescribedMethod(
    registry,
    SESSION_CONTROL_METHOD_DESCRIPTORS["session.reviewStart"],
    async (request) => {
      const { driver } = resolveDriverForSessionOrThrow(deps, request.sessionId);
      await driver.startReview({ sessionId: request.sessionId, target: request.target });
      return { sessionId: request.sessionId };
    },
  );

  registerProviderCommandsSubscribe(registry, deps);
}

function registerProviderCommandsSubscribe(
  registry: MethodRegistry,
  deps: SessionControlHandlerDeps,
): void {
  const descriptor = SESSION_CONTROL_METHOD_DESCRIPTORS["session.providerCommandsSubscribe"];
  const subscribe: Handler<SessionAddressedRequest, SubscribeAckResponse> = async (
    request,
    context,
  ) => {
    if (context.transportId === undefined) {
      throw new Error(`${descriptor.method}: a subscription needs the transport it streams to`);
    }
    const driver = resolveCommandListDriver(deps, request.sessionId);

    const subscription = deps.streamingPrimitive.createSubscription<SessionProviderCommandList>(
      context.transportId,
      descriptor.emissionSchema,
    );
    // The driver hands over the current list while this call is still answering, so the barrier
    // holds it until the acknowledgement is written; a list the client got before its
    // subscription id would be dropped there as unknown.
    const barrier = createSubscriptionAckBarrier(subscription, descriptor.method);
    try {
      const unsubscribe = driver.subscribeProviderCommands(
        { sessionId: request.sessionId },
        (result) => {
          barrier.emit(composeSessionCommandList(request.sessionId, result));
        },
      );
      subscription.onCancel(unsubscribe);
    } catch (thrown) {
      // The client never received this id, so the subscription goes without an end frame.
      deps.streamingPrimitive.cancelSubscription(subscription.subscriptionId);
      throw thrown;
    }
    barrier.release();
    return { subscriptionId: subscription.subscriptionId };
  };

  registry.register(
    descriptor.method,
    descriptor.requestSchema,
    descriptor.responseSchema,
    subscribe as Handler<unknown, unknown>,
    { mutating: descriptor.mutating },
  );
}

// Resolves and gates the session's driver before the subscription exists.
function resolveCommandListDriver(
  deps: SessionControlHandlerDeps,
  sessionId: SessionId,
): ProviderDriver {
  const { driverName, driver } = resolveDriverForSessionOrThrow(deps, sessionId);
  deps.providerRegistry.checkCapability(driverName, "provider_commands");
  return driver;
}

// The wire's `/` list: the process's commands and skills, and each working server's prompts under
// that server's name. A server is named exactly on a prompt entry.
function composeSessionCommandList(
  sessionId: SessionId,
  result: ProviderCommandListResult,
): SessionProviderCommandList {
  const commands: ProviderCommandEntry[] = [];
  const serverPrompts: SessionServerPrompt[] = [];
  for (const group of result.bindings) {
    for (const entry of group.entries) {
      if (entry.server === undefined) {
        commands.push(entry);
      } else {
        serverPrompts.push({
          serverName: entry.server,
          name: entry.name,
          description: entry.description,
        });
      }
    }
  }
  return { sessionId, commands, serverPrompts };
}
