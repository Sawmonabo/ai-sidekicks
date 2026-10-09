// A stand-in for a provider driver, for the code that holds drivers without running a provider:
// the registry's gate and the daemon's start and stop.

import type { DriverCompactionResult } from "@ai-sidekicks/contracts/provider/driver/compaction";
import type { ProviderCommandListResult } from "@ai-sidekicks/contracts/provider/driver/commands";

import type {
  CompactContextParams,
  GetCapabilitiesResult,
  ListProviderCommandsParams,
  ProviderDriver,
} from "../contract.js";

function refuseCall(operation: string): Error {
  return new Error(`${operation} is not part of this test`);
}

/**
 * A driver whose capability read answers as the test chose and whose stop holds no process to
 * end. Every other operation throws, so a call nobody expected fails the test loudly.
 */
export class FakeProviderDriver implements ProviderDriver {
  readonly #readCapabilities: () => Promise<GetCapabilitiesResult>;

  constructor(readCapabilities: () => Promise<GetCapabilitiesResult>) {
    this.#readCapabilities = readCapabilities;
  }

  getCapabilities(): Promise<GetCapabilitiesResult> {
    return this.#readCapabilities();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  compactContext(_params: CompactContextParams): Promise<DriverCompactionResult> {
    throw refuseCall("compactContext");
  }
  listProviderCommands(_params: ListProviderCommandsParams): Promise<ProviderCommandListResult> {
    throw refuseCall("listProviderCommands");
  }
  createSession(): never {
    throw refuseCall("createSession");
  }
  resumeSession(): never {
    throw refuseCall("resumeSession");
  }
  restartSession(): never {
    throw refuseCall("restartSession");
  }
  startRun(): never {
    throw refuseCall("startRun");
  }
  interruptRun(): never {
    throw refuseCall("interruptRun");
  }
  applyIntervention(): never {
    throw refuseCall("applyIntervention");
  }
  moveSessionToFork(): never {
    throw refuseCall("moveSessionToFork");
  }
  rewindConversation(): never {
    throw refuseCall("rewindConversation");
  }
  respondToRequest(): never {
    throw refuseCall("respondToRequest");
  }
  overrideDenial(): never {
    throw refuseCall("overrideDenial");
  }
  pauseRun(): never {
    throw refuseCall("pauseRun");
  }
  resumeRun(): never {
    throw refuseCall("resumeRun");
  }
  withdrawQueuedMessage(): never {
    throw refuseCall("withdrawQueuedMessage");
  }
  answerProviderChoice(): never {
    throw refuseCall("answerProviderChoice");
  }
  retryTurnOnFasterModel(): never {
    throw refuseCall("retryTurnOnFasterModel");
  }
  updatePermissionLevel(): never {
    throw refuseCall("updatePermissionLevel");
  }
  moveToProviderBuild(): never {
    throw refuseCall("moveToProviderBuild");
  }
  purgeSession(): never {
    throw refuseCall("purgeSession");
  }
  setSessionGoal(): never {
    throw refuseCall("setSessionGoal");
  }
  clearSessionGoal(): never {
    throw refuseCall("clearSessionGoal");
  }
  closeSession(): never {
    throw refuseCall("closeSession");
  }
  listModels(): never {
    throw refuseCall("listModels");
  }
  listModes(): never {
    throw refuseCall("listModes");
  }
  probeAuth(): never {
    throw refuseCall("probeAuth");
  }
  observedOutputSpeedFor(): never {
    throw refuseCall("observedOutputSpeedFor");
  }
  updateSessionMode(): never {
    throw refuseCall("updateSessionMode");
  }
  answerSessionCommand(): never {
    throw refuseCall("answerSessionCommand");
  }
  askSideQuestion(): never {
    throw refuseCall("askSideQuestion");
  }
  startReview(): never {
    throw refuseCall("startReview");
  }
  subscribeProviderCommands(): never {
    throw refuseCall("subscribeProviderCommands");
  }
}
