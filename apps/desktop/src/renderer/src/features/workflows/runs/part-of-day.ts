// The part of the day `Nothing waiting · you answered 4 runs this morning` names, on this machine's
// clock, and when it next turns over, so the line moves at noon and at six without a poll.

/** The part of the day, as `you answered 4 runs this …` says it. */
export type PartOfDay = "morning" | "afternoon" | "evening";

/** The part of the day `epochMilliseconds` falls in on this machine's clock. */
export function partOfDayAt(epochMilliseconds: number): PartOfDay {
  const hour = new Date(epochMilliseconds).getHours();
  return hour < AFTERNOON_STARTS_AT_HOUR
    ? "morning"
    : hour < EVENING_STARTS_AT_HOUR
      ? "afternoon"
      : "evening";
}

/** The next instant after `epochMilliseconds` at which {@link partOfDayAt} reads differently. */
export function partOfDayChangesAt(epochMilliseconds: number): number {
  const now = new Date(epochMilliseconds);
  const hour = now.getHours();
  const nextStartHour =
    hour < AFTERNOON_STARTS_AT_HOUR
      ? AFTERNOON_STARTS_AT_HOUR
      : hour < EVENING_STARTS_AT_HOUR
        ? EVENING_STARTS_AT_HOUR
        : HOURS_PER_DAY;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), nextStartHour).getTime();
}

const AFTERNOON_STARTS_AT_HOUR = 12;
const EVENING_STARTS_AT_HOUR = 18;
const HOURS_PER_DAY = 24;
