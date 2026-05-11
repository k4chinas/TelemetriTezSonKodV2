const net = require('net');
const { normalizeIncomingPayload } = require('./payload-normalize');
const { validateTelemetry } = require('./validator');

/**
 * Tek cihaz: yeni bağlantı gelirse önceki soket kapatılır.
 * @param {import('socket.io').Server} io
 * @param {{ insertTelemetry: (r: object) => void }} store
 * @param {{ tcpPort: number, tcpIdleTimeoutMs: number }} config
 * @param {{ setOnline: (b: boolean) => void, isOnline: () => boolean }} device
 */
function createTcpServer(io, store, config, device) {
  let activeSocket = null;
  let idleTimer = null;

  function clearIdle() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function scheduleIdle(socket) {
    clearIdle();
    if (config.tcpIdleTimeoutMs <= 0) return;
    idleTimer = setTimeout(() => {
      try {
        socket.destroy();
      } catch (_) {
        /* ignore */
      }
    }, config.tcpIdleTimeoutMs);
  }

  function setOnline(online) {
    device.setOnline(online);
    io.emit('status', { online });
  }

  function attachSocket(socket) {
    if (activeSocket && activeSocket !== socket) {
      try {
        activeSocket.destroy();
      } catch (_) {
        /* ignore */
      }
    }
    activeSocket = socket;
    setOnline(true);
    scheduleIdle(socket);

    let buf = '';

    socket.setEncoding('utf8');

    socket.on('data', (chunk) => {
      scheduleIdle(socket);
      buf += chunk;
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() || '';
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed;
        try {
          parsed = JSON.parse(trimmed);
        } catch (e) {
          io.emit('telemetry_error', { message: 'JSON parse hatası', detail: String(e) });
          continue;
        }
        let data;
        try {
          const normalized = normalizeIncomingPayload(parsed);
          data = validateTelemetry(normalized);
        } catch (e) {
          io.emit('telemetry_error', { message: String(e.message || e) });
          continue;
        }
        const receivedAt = new Date().toISOString();
        const serverTs = Date.now();
        try {
          store.insertTelemetry({ ...data, received_at: receivedAt });
        } catch (e) {
          io.emit('telemetry_error', { message: 'Veritabanı yazım hatası', detail: String(e) });
          continue;
        }
        io.emit('telemetry', { ...data, server_ts: serverTs, received_at: receivedAt });
      }
    });

    const onGone = () => {
      clearIdle();
      if (activeSocket === socket) {
        activeSocket = null;
        setOnline(false);
      }
    };

    socket.on('close', onGone);
    socket.on('error', onGone);
    socket.on('end', onGone);
  }

  const server = net.createServer((socket) => {
    attachSocket(socket);
  });

  server.listen(config.tcpPort, () => {
    // eslint-disable-next-line no-console
    console.log(`[TCP] Dinleniyor: ${config.tcpPort}`);
  });

  return server;
}

module.exports = { createTcpServer };
