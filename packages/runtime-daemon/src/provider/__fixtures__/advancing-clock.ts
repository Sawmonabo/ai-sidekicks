/**
 * A test clock whose every call returns a timestamp one minute later than the last, so a test can
 * tell a write that moved a stamp from one that left it alone.
 */
export function makeAdvancingClock(): () => string {
  let minute: number = 0;
  return () => {
    const stamp: string = `2026-06-02T12:${minute.toString().padStart(2, "0")}:00.000Z`;
    minute += 1;
    return stamp;
  };
}
