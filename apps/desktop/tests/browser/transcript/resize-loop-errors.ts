// The resize loop errors a window raises while a case runs. A row that grows inside a resize report
// leaves the conversation's report of it undelivered to the next frame, which the browser raises as
// an error the run would only log.

/** Hears the window's resize loop errors until `stop`, which answers them. */
export function hearResizeLoopErrors(): { readonly stop: () => readonly string[] } {
  const messages: string[] = [];
  const hear = (event: ErrorEvent): void => {
    if (event.message.includes("ResizeObserver loop")) {
      messages.push(event.message);
    }
  };
  window.addEventListener("error", hear);
  return {
    stop: () => {
      window.removeEventListener("error", hear);
      return messages;
    },
  };
}
