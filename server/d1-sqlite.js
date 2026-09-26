// A D1-compatible facade over node:sqlite, so src/index.js runs unchanged on
// Node. It implements only the part of the D1 API the Worker uses:
//   db.prepare(sql).bind(...values).first() / .all() / .run()
//   db.batch([statements])   (atomic, like D1)
// If src/index.js starts using more of D1, extend this file.

export class D1Database {
  /** @param {import("node:sqlite").DatabaseSync} sqlite */
  constructor(sqlite) {
    this.sqlite = sqlite;
    this.cache = new Map();
  }

  prepare(sql) {
    return new D1PreparedStatement(this, sql, []);
  }

  statement(sql) {
    let stmt = this.cache.get(sql);
    if (!stmt) {
      stmt = this.sqlite.prepare(sql);
      this.cache.set(sql, stmt);
    }
    return stmt;
  }

  async batch(statements) {
    return transaction(this.sqlite, () => statements.map((s) => s.execute()));
  }
}

class D1PreparedStatement {
  constructor(db, sql, params) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values) {
    return new D1PreparedStatement(this.db, this.sql, values.map(toSQLite));
  }

  async first(column) {
    const row = this.db.statement(this.sql).get(...this.params);
    if (row === undefined) return null;
    return column === undefined ? { ...row } : row[column];
  }

  async all() {
    return this.execute();
  }

  async run() {
    return this.execute();
  }

  execute() {
    const stmt = this.db.statement(this.sql);
    if (stmt.columns().length > 0) {
      const results = stmt.all(...this.params).map((row) => ({ ...row }));
      return { success: true, results, meta: { rows_read: results.length } };
    }
    const { changes, lastInsertRowid } = stmt.run(...this.params);
    return { success: true, results: [], meta: { changes, last_row_id: Number(lastInsertRowid) } };
  }
}

/** Run fn inside BEGIN IMMEDIATE ... COMMIT, rolling back on any error. */
export function transaction(sqlite, fn) {
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    sqlite.exec("COMMIT");
    return result;
  } catch (err) {
    sqlite.exec("ROLLBACK");
    throw err;
  }
}

// D1 converts booleans to 0/1 and rejects undefined; mirror that.
function toSQLite(value) {
  if (value === undefined) throw new TypeError("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}
