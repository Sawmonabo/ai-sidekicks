// A SQL statement as the database writer takes it, and what running it reports.

/**
 * The database clock's current time as a SQL expression, in the same ISO 8601 form as every
 * stored time.
 */
export const DATABASE_NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** A statement's bound values: positional, or named by `@name`. */
type StatementBindings = readonly unknown[] | Readonly<Record<string, unknown>>;

/** One SQL statement for the writer to run. */
export interface WriteStatement {
  readonly sql: string;
  readonly bindings?: StatementBindings;
  /**
   * The rows the statement must change, or return when it reads; any other count refuses the
   * write and rolls it back whole.
   */
  readonly expectedRowCount?: number;
}

/** What one statement did: the rows it changed, or returned when it reads, and those rows. */
export interface StatementResult {
  readonly rowCount: number;
  readonly rows: readonly unknown[];
}
