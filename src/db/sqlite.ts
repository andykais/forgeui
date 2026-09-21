import { DatabaseSync, type StatementSync } from "node:sqlite";

/**
 * The slice of a SQLite driver this app uses, over Deno's built-in
 * `node:sqlite`.
 *
 * It exists so the call sites keep the row shapes they were written against:
 * `node:sqlite` returns every row as an object, while most queries here want
 * a positional tuple (`value`, `values`). Rebuilding the tuple from the
 * statement's own column list is what this adds; everything else is a thin
 * pass-through.
 *
 * Two things the previous driver needed and this does not. There is no native
 * library to download on first use, so nothing has to reach the network
 * before a test can open a database. And integers survive: `node:sqlite`
 * returns a SQLite INTEGER as a JavaScript number without an `int64` flag,
 * which is what every `created_at` in §7 depends on. Seeds are capped at
 * `Number.MAX_SAFE_INTEGER` (`MAX_SEED`), so nothing stored here reaches the
 * range where that would stop being exact.
 */

export class SqliteError extends Error {
  override readonly name = "SqliteError";
}

/** A row as the caller asked for it: a tuple in column order. */
function tuple(
  statement: StatementSync,
  row: Record<string, unknown> | undefined,
  sql: string,
): unknown[] | undefined {
  if (row === undefined) return undefined;
  const columns = statement.columns();
  const names = columns.map((column) => column.name);
  // `SELECT a.id, b.id` gives two columns of one name, and an object row can
  // only hold one of them. Positional access would then silently come back
  // short, so say so instead. Alias one of them and the query works.
  if (new Set(names).size !== names.length) {
    throw new SqliteError(
      `two result columns share a name, so a positional row would lose one; ` +
        `alias them in the query: ${sql.trim().slice(0, 120)}`,
    );
  }
  return names.map((name) => row[name]);
}

export class Statement {
  #statement: StatementSync;
  #sql: string;

  constructor(statement: StatementSync, sql: string) {
    this.#statement = statement;
    this.#sql = sql;
  }

  /** The first row as a tuple, or undefined when there is none. */
  value<T extends unknown[]>(...params: unknown[]): T | undefined {
    const row = this.#statement.get(...params as never[]) as
      | Record<string, unknown>
      | undefined;
    return tuple(this.#statement, row, this.#sql) as T | undefined;
  }

  /** Every row as a tuple. */
  values<T extends unknown[]>(...params: unknown[]): T[] {
    const rows = this.#statement.all(...params as never[]) as Record<
      string,
      unknown
    >[];
    return rows.map((row) => tuple(this.#statement, row, this.#sql) as T);
  }

  /** Every row as an object. */
  all<T = Record<string, unknown>>(...params: unknown[]): T[] {
    return this.#statement.all(...params as never[]) as T[];
  }

  /** The first row as an object, or undefined when there is none. */
  get<T = Record<string, unknown>>(...params: unknown[]): T | undefined {
    return this.#statement.get(...params as never[]) as T | undefined;
  }

  /** Run a statement for its effect; returns the number of rows changed. */
  run(...params: unknown[]): number {
    const result = this.#statement.run(...params as never[]);
    return Number(result.changes);
  }

  /** The rowid the last insert through this statement produced. */
  lastInsertRowId(...params: unknown[]): number {
    const result = this.#statement.run(...params as never[]);
    return Number(result.lastInsertRowid);
  }
}

export class Database {
  #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
  }

  prepare(sql: string): Statement {
    return new Statement(this.#db.prepare(sql), sql);
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  close(): void {
    this.#db.close();
  }
}
