const path = require('path');
require('dotenv').config();

function int(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

const root = path.join(__dirname, '..');

module.exports = {
  httpPort: int('HTTP_PORT', 1945),
  tcpPort: int('TCP_PORT', 8001),
  tcpIdleTimeoutMs: int('TCP_IDLE_TIMEOUT_MS', 35000),
  dbPath: process.env.DB_PATH
    ? path.isAbsolute(process.env.DB_PATH)
      ? process.env.DB_PATH
      : path.join(root, process.env.DB_PATH)
    : path.join(root, 'data', 'telemetry.db'),
  publicDir: process.env.PUBLIC_DIR
    ? path.isAbsolute(process.env.PUBLIC_DIR)
      ? process.env.PUBLIC_DIR
      : path.join(root, process.env.PUBLIC_DIR)
    : path.join(root, 'public'),
};
