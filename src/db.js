const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

/**
 * @param {string} dbPath
 */
function openDatabase(dbPath) {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at TEXT NOT NULL,
      lon REAL NOT NULL,
      lat REAL NOT NULL,
      h INTEGER NOT NULL,
      m INTEGER NOT NULL,
      s INTEGER NOT NULL,
      alt INTEGER NOT NULL,
      gx REAL NOT NULL,
      gy REAL NOT NULL,
      gz REAL NOT NULL,
      ax REAL NOT NULL,
      ay REAL NOT NULL,
      az REAL NOT NULL,
      tmp INTEGER NOT NULL,
      mx REAL NOT NULL,
      my REAL NOT NULL,
      mz REAL NOT NULL,
      v REAL NOT NULL,
      i REAL NOT NULL,
      w REAL NOT NULL,
      wh REAL NOT NULL,
      spd INTEGER NOT NULL,
      bat INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_telemetry_received_at ON telemetry(received_at);
  `);

  const insert = db.prepare(`
    INSERT INTO telemetry (
      received_at, lon, lat, h, m, s, alt,
      gx, gy, gz, ax, ay, az, tmp, mx, my, mz,
      v, i, w, wh, spd, bat
    ) VALUES (
      @received_at, @lon, @lat, @h, @m, @s, @alt,
      @gx, @gy, @gz, @ax, @ay, @az, @tmp, @mx, @my, @mz,
      @v, @i, @w, @wh, @spd, @bat
    )
  `);

  /**
   * @param {object} row
   * @param {string} row.received_at ISO string
   */
  function insertTelemetry(row) {
    insert.run(row);
  }

  /**
   * @param {{ since?: string, until?: string, limit?: number, offset?: number }} opts
   * @returns {object[]}
   */
  function queryTelemetry(opts = {}) {
    const since = opts.since || null;
    const until = opts.until || null;
    const limit = Math.min(Math.max(Number(opts.limit) || 10000, 1), 100000);
    const offset = Math.max(Number(opts.offset) || 0, 0);
    
    // YENİ: Sıralama yönünü belirliyoruz (Varsayılan ASC, istenirse DESC)
    const order = opts.order === 'desc' ? 'DESC' : 'ASC'; 
    
    const conditions = [];
    const params = [];
    if (since) {
      conditions.push('received_at >= ?');
      params.push(since);
    }
    if (until) {
      conditions.push('received_at <= ?');
      params.push(until);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `
      SELECT id, received_at, lon, lat, h, m, s, alt,
        gx, gy, gz, ax, ay, az, tmp, mx, my, mz,
        v, i, w, wh, spd, bat
      FROM telemetry
      ${where}
      ORDER BY id ${order}
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);
    return db.prepare(sql).all(...params);
  }

  function clearTelemetry() {
    db.prepare('DELETE FROM telemetry').run();
  }

  return { db, insertTelemetry, queryTelemetry, clearTelemetry };
}

module.exports = { openDatabase };
