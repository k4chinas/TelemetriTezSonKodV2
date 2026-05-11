const config = require('./config');
const { openDatabase } = require('./db');
const { createHttpServer } = require('./http-server');
const { createTcpServer } = require('./tcp-server');
const device = require('./device-state');

const { db, insertTelemetry, queryTelemetry, clearTelemetry } = openDatabase(config.dbPath);
const { server, io } = createHttpServer(config, { queryTelemetry, insertTelemetry, clearTelemetry });

createTcpServer(io, { insertTelemetry }, config, device);

server.listen(config.httpPort, () => {
  // eslint-disable-next-line no-console
  console.log(`[HTTP] Arayüz: http://localhost:${config.httpPort}`);
  // eslint-disable-next-line no-console
  console.log(`[TCP]  Donanım: host:${config.tcpPort} (ham TCP, satır başına JSON)`);
  // eslint-disable-next-line no-console
  console.log(`[HTTP] POST telemetri: /api/v1/telemetry (JSON, GSM uyumlu alan adları)`);
});

function shutdown() {
  try {
    io.close();
  } catch (_) {
    /* ignore */
  }
  try {
    server.close();
  } catch (_) {
    /* ignore */
  }
  try {
    db.close();
  } catch (_) {
    /* ignore */
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
