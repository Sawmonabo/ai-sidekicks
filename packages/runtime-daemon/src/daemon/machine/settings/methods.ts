// Registers the service's three machine-settings verbs: the read, the one write
// the main process and every other device go through, and the live read every
// console window listens on.
import {
  MACHINE_SETTINGS_METHOD_DESCRIPTORS,
  type BranchPatternRefusalReason,
  type MachineSettingsReading,
  type MachineSettingsSubscribeRequest,
} from "@ai-sidekicks/contracts/machine-settings";
import type { Handler, MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc/registry";
import type { SubscribeAckResponse } from "@ai-sidekicks/contracts/jsonrpc/streaming";

import { registerDescribedMethod } from "../../../ipc/handlers/register-described-method.js";
import type { StreamingPrimitive } from "../../../ipc/streaming-primitive.js";
import { createSubscriptionAckBarrier } from "../../../ipc/subscription-ack-barrier.js";

import type { MachineSettingsFile } from "./file.js";
import { refuseBranchPattern, refuseEnvironmentRows } from "./refusals.js";

/**
 * What the machine-settings verbs need: the settings file, the shared streaming primitive and the
 * branch-name pattern's check.
 */
export interface MachineSettingsMethodsDeps {
  readonly settingsFile: MachineSettingsFile;
  /** The primitive every streaming handler shares, so a disconnect cleans up all of them. */
  readonly streamingPrimitive: StreamingPrimitive;
  /** Why a `Branch names` pattern cannot be saved, or `null` when it can. */
  readonly findBranchPatternRefusal: (
    pattern: string,
  ) => Promise<BranchPatternRefusalReason | null>;
}

/**
 * Registers `daemon.machineSettingsRead`, `daemon.machineSettingsUpdate` and
 * `daemon.machineSettingsSubscribe`. An update with a refused environment row or branch-name
 * pattern fails with `InvalidParams` before anything is written.
 */
export function registerMachineSettingsMethods(
  registry: MethodRegistry,
  deps: MachineSettingsMethodsDeps,
): void {
  registerDescribedMethod(
    registry,
    MACHINE_SETTINGS_METHOD_DESCRIPTORS["daemon.machineSettingsRead"],
    () => deps.settingsFile.read(),
  );

  registerDescribedMethod(
    registry,
    MACHINE_SETTINGS_METHOD_DESCRIPTORS["daemon.machineSettingsUpdate"],
    async ({ change }) => {
      refuseEnvironmentRows(change.environmentRows ?? []);
      if (change.branchNamePattern !== undefined) {
        refuseBranchPattern(await deps.findBranchPatternRefusal(change.branchNamePattern));
      }
      return { settings: await deps.settingsFile.update(change) };
    },
  );

  const subscribeDescriptor =
    MACHINE_SETTINGS_METHOD_DESCRIPTORS["daemon.machineSettingsSubscribe"];
  const subscribe: Handler<MachineSettingsSubscribeRequest, SubscribeAckResponse> = async (
    _request,
    context,
  ) => {
    if (context.transportId === undefined) {
      throw new Error(
        "daemon.machineSettingsSubscribe: a subscription needs the transport it streams to",
      );
    }
    const subscription = deps.streamingPrimitive.createSubscription<MachineSettingsReading>(
      context.transportId,
      subscribeDescriptor.emissionSchema,
    );

    // The first reading arrives while this call is still answering, so the barrier holds it
    // until the acknowledgement is written: a reading that reached the client before its
    // subscription id would be dropped there as unknown. A reading the emission schema refuses
    // ends this subscription only, so the file's writer never fails because one listener did.
    const barrier = createSubscriptionAckBarrier(subscription, subscribeDescriptor.method);
    try {
      const unsubscribe = await deps.settingsFile.subscribe((reading) => {
        barrier.emit(reading);
      });
      subscription.onCancel(unsubscribe);
    } catch (error) {
      // The client never received this id, so the subscription goes without an end frame.
      deps.streamingPrimitive.cancelSubscription(subscription.subscriptionId);
      throw error;
    }
    barrier.release();
    return { subscriptionId: subscription.subscriptionId };
  };
  registry.register(
    subscribeDescriptor.method,
    subscribeDescriptor.requestSchema,
    subscribeDescriptor.responseSchema,
    subscribe as Handler<unknown, unknown>,
    { mutating: subscribeDescriptor.mutating },
  );
}
