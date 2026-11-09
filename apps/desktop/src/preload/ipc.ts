/**
 * The part of Electron's `ipcRenderer` the preload carries the bridge over; each member's module
 * takes the calls it makes.
 */
export interface PreloadIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  sendSync(channel: string, ...args: unknown[]): unknown;
  /** Sends `message` to main with `transfer`'s ports moved, not copied. */
  postMessage(channel: string, message: unknown, transfer: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}
