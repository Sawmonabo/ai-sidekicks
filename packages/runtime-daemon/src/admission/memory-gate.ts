// The memory gate: what admits a person's run, an ingest worker or a workflow step to start. Ready
// entries wait in one line in the order they became ready; the gate weighs only the head, against
// the machine's available memory read afresh, less a headroom, less the reservation of everything
// admitted and not yet finished. When nothing is admitted the head starts whatever its size, so
// work never stalls on a full machine. A start whose size is an estimate waits 1.5 s after the
// last such start, so the reading shows the first one's growth before the next is weighed.
// The gate weighs when an entry joins the line or gives up its reservation, when the spacing
// ends, and when the caller's tick asks; it never polls.

import { totalmem } from "node:os";

import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";

import type { ProcessPeakReader } from "./process-peak/contract.js";

const MEBIBYTE = 1024 * 1024;

// Kept free of every reservation: a fifth of physical memory, and never less than 1 GiB.
const HEADROOM_SHARE = 0.2;
const HEADROOM_FLOOR_BYTES = 1024 * MEBIBYTE;

const ESTIMATED_START_SPACING_MS = 1_500;

// Each estimated kind's reservation, as footprint, until a peak is learned on this machine.
const ESTIMATED_STARTING_BYTES = {
  claude: 288 * MEBIBYTE,
  codex: 64 * MEBIBYTE,
  "codex-starting-service": 96 * MEBIBYTE,
  bun: 160 * MEBIBYTE,
  python: 160 * MEBIBYTE,
} as const;

type EstimatedKind = keyof typeof ESTIMATED_STARTING_BYTES;

// A quick step's thread beyond its interpreter's budget, and the most it holds per input byte.
const QUICK_THREAD_BYTES = 32 * MEBIBYTE;
const QUICK_INPUT_MULTIPLE = 9;

// An ingest worker's own memory beyond the file it reads, and what each pixel it draws costs.
const INGEST_WORKER_BYTES = 128 * MEBIBYTE;
const INGEST_BYTES_PER_PIXEL = 9;

/**
 * What an admitted entry runs, which sets its reservation. A provider process and a bun or Python
 * step are estimates, replaced by the peak their workflow node, or else their kind, last reached;
 * a quick Code step reserves its budget, replaced by its node's interpreter peak, plus its thread
 * and nine times its input; an ingest worker reserves its file, its picture and its own memory.
 * `workflowNodeKey` names the workflow node an entry runs, unique across workflows; a person's run
 * has none. Byte and pixel counts are whole numbers.
 */
export type AdmissionWork =
  | {
      readonly kind: "provider";
      readonly provider: Extract<ProviderName, "claude">;
      readonly workflowNodeKey?: string;
    }
  | {
      readonly kind: "provider";
      readonly provider: Extract<ProviderName, "codex">;
      /** Whether the conversation starts its account's service, there being none running. */
      readonly startsAccountService: boolean;
      readonly workflowNodeKey?: string;
    }
  | {
      readonly kind: "script";
      readonly runtime: "bun" | "python";
      readonly workflowNodeKey?: string;
    }
  | {
      readonly kind: "quick-code";
      readonly budgetBytes: number;
      readonly inputBytes: number;
      readonly workflowNodeKey: string;
    }
  | { readonly kind: "ingest"; readonly fileBytes: number; readonly picturePixels: number };

/**
 * Where an admission stands: in the line, holding its reservation, parked on a person or a
 * provider limit and holding nothing, or finished.
 */
type MemoryAdmissionState = "waiting" | "admitted" | "parked" | "released";

/** How a wait in the line ended: admitted, or released before its turn came. */
type AdmissionOutcome = "admitted" | "withdrawn";

/** One entry's place in the gate, from joining the line until it is released. */
export interface MemoryAdmission {
  readonly work: AdmissionWork;
  readonly state: MemoryAdmissionState;
  /** Settles when the latest wait in the line ends, at once when it already has. */
  admitted(): Promise<AdmissionOutcome>;
  /**
   * Reads the peak of process `processId`, which the entry runs, and keeps the largest seen; the
   * release learns it. Called while admitted or parked and while the process still exists; a
   * process no longer readable adds nothing.
   */
  observeProcessPeak(processId: number): Promise<void>;
  /** Keeps a quick step's interpreter peak, in bytes, for the release to learn. */
  observeInterpreterPeak(peakBytes: number): void;
  /**
   * Gives up the reservation while the entry waits on a person or a provider limit; throws unless
   * admitted.
   */
  park(): void;
  /**
   * Rejoins the line at its tail after a park, taking a reservation again at admission; throws
   * unless parked.
   */
  resume(): void;
  /**
   * Ends the entry: a waiting one leaves the line, its wait settling `withdrawn`; an admitted one
   * frees its reservation; a provider, script or quick entry's observed peak is learned. Throws
   * when already released.
   */
  release(): void;
}

/** The clock the gate times its spacing by: a monotonic now in milliseconds, and a timer. */
interface MemoryGateClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): void;
}

/** What the gate reads the machine through; tests replace the reading and the clock. */
interface MemoryGateOptions {
  readonly peakReader: ProcessPeakReader;
  /** Bytes the system can give now; defaults to `process.availableMemory()`. */
  readonly readAvailableMemory?: () => number;
  /** The machine's physical memory in bytes; defaults to `os.totalmem()`. */
  readonly physicalMemoryBytes?: number;
  readonly clock?: MemoryGateClock;
}

/** The daemon's one memory gate. Learned peaks live only in its memory, so a restart re-learns. */
export interface MemoryGate {
  /** Puts `work` at the tail of the line and weighs at once, so `state` is current on return. */
  enqueue(work: AdmissionWork): MemoryAdmission;
  /** Weighs the head against a fresh reading; the caller's tick calls it to see memory freed. */
  weigh(): void;
}

// The daemon's own timer, which never keeps the process alive by itself.
const SYSTEM_CLOCK: MemoryGateClock = {
  now: () => performance.now(),
  schedule: (callback, delayMs) => {
    setTimeout(callback, delayMs).unref();
  },
};

interface AdmissionEntry {
  readonly work: AdmissionWork;
  state: MemoryAdmissionState;
  heldBytes: number;
  observedPeakBytes: number | undefined;
  wait: PromiseWithResolvers<AdmissionOutcome>;
}

/** Builds the memory gate over the machine `options` reads. */
export function createMemoryGate(options: MemoryGateOptions): MemoryGate {
  const readAvailableMemory = options.readAvailableMemory ?? (() => process.availableMemory());
  const clock = options.clock ?? SYSTEM_CLOCK;
  const headroomBytes = Math.max(
    (options.physicalMemoryBytes ?? totalmem()) * HEADROOM_SHARE,
    HEADROOM_FLOOR_BYTES,
  );
  const line: AdmissionEntry[] = [];
  const learnedPeakByNode = new Map<string, number>();
  const learnedPeakByKind = new Map<EstimatedKind, number>();
  let heldBytes = 0;
  let admittedCount = 0;
  let lastEstimatedStartAt: number | undefined;
  let isSpacingTimerArmed = false;

  const reservationBytes = (work: AdmissionWork): number => {
    switch (work.kind) {
      case "quick-code":
        return (
          (learnedPeakByNode.get(work.workflowNodeKey) ?? work.budgetBytes) +
          QUICK_THREAD_BYTES +
          QUICK_INPUT_MULTIPLE * work.inputBytes
        );
      case "ingest":
        return work.fileBytes + work.picturePixels * INGEST_BYTES_PER_PIXEL + INGEST_WORKER_BYTES;
      default: {
        const kind = estimatedKind(work);
        const nodePeak =
          work.workflowNodeKey === undefined
            ? undefined
            : learnedPeakByNode.get(work.workflowNodeKey);
        return nodePeak ?? learnedPeakByKind.get(kind) ?? ESTIMATED_STARTING_BYTES[kind];
      }
    }
  };

  const learn = (entry: AdmissionEntry): void => {
    const peakBytes = entry.observedPeakBytes;
    const work = entry.work;
    if (peakBytes === undefined || work.kind === "ingest") {
      return;
    }
    if (work.workflowNodeKey !== undefined) {
      learnedPeakByNode.set(work.workflowNodeKey, peakBytes);
    }
    // A quick step's interpreter peak is bounded by its own node's budget, so it is never a kind's.
    if (work.kind !== "quick-code") {
      learnedPeakByKind.set(estimatedKind(work), peakBytes);
    }
  };

  const armSpacingTimer = (delayMs: number): void => {
    if (isSpacingTimerArmed) {
      return;
    }
    isSpacingTimerArmed = true;
    clock.schedule(() => {
      isSpacingTimerArmed = false;
      weigh();
    }, delayMs);
  };

  const weigh = (): void => {
    let roomBytes: number | undefined;
    for (let head = line[0]; head !== undefined; head = line[0]) {
      const isEstimate = head.work.kind === "provider" || head.work.kind === "script";
      if (isEstimate && lastEstimatedStartAt !== undefined) {
        const spacingLeftMs = lastEstimatedStartAt + ESTIMATED_START_SPACING_MS - clock.now();
        if (spacingLeftMs > 0) {
          armSpacingTimer(spacingLeftMs);
          return;
        }
      }
      const bytes = reservationBytes(head.work);
      if (admittedCount > 0) {
        roomBytes ??= readAvailableMemory() - headroomBytes;
        if (bytes > roomBytes - heldBytes) {
          return;
        }
      }
      line.shift();
      if (isEstimate) {
        lastEstimatedStartAt = clock.now();
      }
      head.state = "admitted";
      head.heldBytes = bytes;
      heldBytes += bytes;
      admittedCount += 1;
      head.wait.resolve("admitted");
    }
  };

  const freeReservation = (entry: AdmissionEntry): void => {
    heldBytes -= entry.heldBytes;
    entry.heldBytes = 0;
    admittedCount -= 1;
  };

  const requireState = (
    entry: AdmissionEntry,
    action: string,
    allowed: readonly MemoryAdmissionState[],
  ): void => {
    if (!allowed.includes(entry.state)) {
      throw new Error(`A memory admission that is ${entry.state} cannot ${action}.`);
    }
  };

  const enqueue = (work: AdmissionWork): MemoryAdmission => {
    const entry: AdmissionEntry = {
      work,
      state: "waiting",
      heldBytes: 0,
      observedPeakBytes: undefined,
      wait: Promise.withResolvers<AdmissionOutcome>(),
    };
    const keepPeak = (peakBytes: number): void => {
      entry.observedPeakBytes = Math.max(entry.observedPeakBytes ?? 0, peakBytes);
    };
    line.push(entry);
    weigh();
    return {
      work,
      get state() {
        return entry.state;
      },
      admitted: () => entry.wait.promise,
      observeProcessPeak: async (processId) => {
        requireState(entry, "observe a process peak", ["admitted", "parked"]);
        const peakBytes = await options.peakReader.readPeakBytes(processId);
        if (peakBytes !== undefined) {
          keepPeak(peakBytes);
          // A release during the read has learned already, so the read is learned on its own.
          if (entry.state === "released") {
            learn(entry);
          }
        }
      },
      observeInterpreterPeak: (peakBytes) => {
        requireState(entry, "observe an interpreter peak", ["admitted", "parked"]);
        keepPeak(peakBytes);
      },
      park: () => {
        requireState(entry, "park", ["admitted"]);
        entry.state = "parked";
        freeReservation(entry);
        weigh();
      },
      resume: () => {
        requireState(entry, "resume", ["parked"]);
        entry.state = "waiting";
        entry.wait = Promise.withResolvers<AdmissionOutcome>();
        line.push(entry);
        weigh();
      },
      release: () => {
        requireState(entry, "be released", ["waiting", "admitted", "parked"]);
        const previousState = entry.state;
        entry.state = "released";
        if (previousState === "waiting") {
          line.splice(line.indexOf(entry), 1);
          entry.wait.resolve("withdrawn");
        } else if (previousState === "admitted") {
          freeReservation(entry);
        }
        learn(entry);
        weigh();
      },
    };
  };

  return { enqueue, weigh };
}

// The estimated kind whose starting figure and learned peak a provider or script entry takes.
function estimatedKind(
  work: Extract<AdmissionWork, { kind: "provider" } | { kind: "script" }>,
): EstimatedKind {
  if (work.kind === "script") {
    return work.runtime;
  }
  if (work.provider === "claude") {
    return "claude";
  }
  return work.startsAccountService ? "codex-starting-service" : "codex";
}
