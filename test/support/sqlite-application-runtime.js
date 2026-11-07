// Test-only SQL runtime implementation copied from Images9462476733e68195c5cd4a97dcba8ec23930f637
// test/support/sqlite-application-runtime.js. E4/E5 use memory; E6 uses a real
// SQLite file across fresh processes. This is not distributed-backend acceptance.
import {DatabaseSync} from 'node:sqlite';

function isReader(sql) {
  return /^\s*SELECT\b/iu.test(sql) || /\bRETURNING\b/iu.test(sql);
}

function execute(database, sql, params = []) {
  const statement = database.prepare(sql);
  if (isReader(sql)) {
    const rows = statement.all(...params);
    return {success: true, rows, rowCount: rows.length};
  }
  const result = statement.run(...params);
  return {success: true, rows: [], affectedRows: Number(result.changes)};
}

function createSqliteApplicationRuntime(filename = ':memory:') {
  let database = null;
  let applicationDatabase = null;

  return {
    async start() {
      database = new DatabaseSync(filename);
      applicationDatabase = Object.freeze({
        async query(sql, params = []) {
          return execute(database, sql, params);
        },
        async transaction(work) {
          database.exec('BEGIN');
          let active = true;
          const transaction = Object.freeze({
            async query(sql, params = []) {
              if (!active) throw new TypeError('application transaction is closed');
              return execute(database, sql, params);
            },
          });
          try {
            const result = await work(transaction);
            database.exec('COMMIT');
            return result;
          } catch (error) {
            database.exec('ROLLBACK');
            throw error;
          } finally {
            active = false;
          }
        },
      });
    },
    openApplicationDatabase() {
      if (!applicationDatabase) throw new TypeError('runtime is not started');
      return applicationDatabase;
    },
    async stop() {
      database?.close();
      database = null;
      applicationDatabase = null;
    },
    listTables() {
      if (!database) throw new TypeError('runtime is not started');
      return database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      ).all().map(({name}) => name);
    },
  };
}

export {createSqliteApplicationRuntime};
