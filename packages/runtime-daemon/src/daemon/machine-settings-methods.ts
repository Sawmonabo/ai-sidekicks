// Registers the service's three machine-settings verbs: the read, the one write
// the main process and every other device go through, and the live read every
// console window listens on.
import {
  DAEMON_ENVIRONMENT_NAME_REFUSED_CODE,
  JsonRpcErrorCode,
  MACHINE_SETTINGS_METHOD_DESCRIPTORS,
  environmentNameRefusal,
  type DaemonEnvironmentNameRefusedDetails,
  type Handler,
  type MachineSettingsChange,
  type MachineSettingsReading,
  type MachineSettingsSubscribeRequest,
  type MethodRegistry,
  type SubscribeAckResponse,
} from "@ai-sidekicks/contracts";

import { DaemonDomainError } from "../ipc/domain-error.js";
import { registerDescribedMethod } from "../ipc/handlers/register-described-method.js";
import type { StreamingPrimitive } from "../ipc/streaming-primitive.js";

import type { MachineSettingsFile } from "./machine-settings-file.js";

export interface MachineSettingsMethodsDeps {
  readonly settingsFile: MachineSettingsFile;
  /** The primitive every streaming handler shares, so a disconnect cleans up all of them. */
  readonly streamingPrimitive: StreamingPrimitive;
}

// A row whose name the app sets, that looks like a credential, or that is not a
// name at all is refused before anything is written, naming the row.
function refuseEnvironmentNames(change: MachineSettingsChange): void {
  for (const row of change.environmentRows ?? []) {
    const reason = environmentNameRefusal(row.name);
    if (reason !== null) {
      const detail: DaemonEnvironmentNameRefusedDetails = { name: row.name, reason };
      throw new DaemonDomainError(`environment row "${row.name}" refused: ${reason}`, {
        code: DAEMON_ENVIRONMENT_NAME_REFUSED_CODE,
        jsonRpcCode: JsonRpcErrorCode.InvalidParams,
        detail: { ...detail },
      });
    }
  }
}

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
      refuseEnvironmentNames(change);
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

    // The first reading arrives while this call is still answering, so it is
    // held and sent after the acknowledgement: a reading that reached the client
    // before its subscription id would be dropped there as unknown.
    const heldReadings: MachineSettingsReading[] = [];
    let acknowledged = false;
    const emit = (reading: MachineSettingsReading): void => {
      // A reading the emission schema refuses is the service's own fault, and
      // the file's writer must not fail because one listener did: this
      // subscription ends and says why, and every other one keeps listening.
      try {
        subscription.next(reading);
      } catch (error) {
        subscription.cancel();
        console.error(
          `[daemon.machineSettingsSubscribe] emission failed for subscriptionId=${subscription.subscriptionId}; subscription canceled`,
          error,
        );
      }
    };
    try {
      const unsubscribe = await deps.settingsFile.subscribe((reading) => {
        if (acknowledged) {
          emit(reading);
        } else {
          heldReadings.push(reading);
        }
      });
      subscription.onCancel(unsubscribe);
    } catch (error) {
      subscription.cancel();
      throw error;
    }
    setImmediate(() => {
      acknowledged = true;
      for (const reading of heldReadings.splice(0)) {
        emit(reading);
      }
    });
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
