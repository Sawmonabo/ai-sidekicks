// The type detection thread: reads one payload's media type from its leading bytes, posts it and
// ends. It runs apart from the daemon's main thread so a parser that never returns holds only this
// thread, which the daemon terminates at its time bound.

import { parentPort, workerData } from "node:worker_threads";

import { fileTypeFromBuffer } from "file-type";

import type {
  DetectionThreadReply,
  DetectionThreadWorkerData,
  MediaTypeDetector,
  MediaTypeDetectorModule,
} from "./thread.js";

if (parentPort === null) {
  throw new Error("The type detection thread runs only as a worker thread");
}
const port = parentPort;
const { leadingBytes, detectorModuleUrl } = workerData as DetectionThreadWorkerData;

const detectWithFileType: MediaTypeDetector = async (bytes) =>
  (await fileTypeFromBuffer(bytes))?.mime;

try {
  const detectMediaType =
    detectorModuleUrl === undefined
      ? detectWithFileType
      : ((await import(detectorModuleUrl)) as MediaTypeDetectorModule).detectMediaType;
  const mediaType = await detectMediaType(leadingBytes);
  port.postMessage({ type: "detected", mediaType } satisfies DetectionThreadReply);
} catch (error) {
  port.postMessage({
    type: "failed",
    message: error instanceof Error ? error.message : String(error),
  } satisfies DetectionThreadReply);
}
