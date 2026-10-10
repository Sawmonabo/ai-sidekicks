// The parts of a dedicated worker the page drives, typed by what each side sends, so a connection
// can start the real worker in the app and a stand-in where no worker runs.

/** One dedicated worker as its page drives it: what it says back, how it fails, and its end. */
export interface WorkerPort<Request, Reply> {
  onmessage: ((event: MessageEvent<Reply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  /** Sends `request`, moving the buffers in `transfer` to the worker rather than copying them. */
  postMessage(request: Request, transfer?: Transferable[]): void;
  terminate(): void;
}

/** Starts one worker of a kind. */
export type WorkerStart<Request, Reply> = () => WorkerPort<Request, Reply>;
