const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const device = require('./device-state');
const { validateTelemetry } = require('./validator');
const { normalizeIncomingPayload } = require('./payload-normalize');

function createHttpServer(config, store = null) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: true },
  });

  app.use(express.json({ limit: '48kb' }));

  // --- SİMÜLASYON DURUMU ---
  let simTimer = null;
  let simStatus = { running: false, file: null, row: 0, total: 0 };

  // MATLAB'ın polling yapacağı flag — simülasyon başlayınca true olur
  let isMatlabSimulationActive = false;

  function stopSimulation() {
    if (simTimer) { clearTimeout(simTimer); simTimer = null; }
    simStatus.running = false;
    isMatlabSimulationActive = false; // ✅ Her iki flag birlikte sıfırlanır
  }

  // --- MATLAB DURUM SORGUSU ---
  // MATLAB bu adresi polling yapar: simStatus.running VE isMatlabSimulationActive
  // ikisi de true olduğunda MATLAB telemetri çekmeye başlar.
  app.get('/api/v1/status', (req, res) => {
    res.json({
      isActive:   isMatlabSimulationActive,
      simRunning: simStatus.running,
    });
  });

  // Simülasyon durumunu sorgula (MATLAB /simulation/status'u polling yapıyor)
  app.get('/api/v1/simulation/status', (req, res) => {
    res.json({
      ok:       true,
      running:  simStatus.running,          // ✅ CSV oynatılıyor mu?
      isActive: isMatlabSimulationActive,   // ✅ MATLAB flag
    });
  });

  // Simülasyon için CSV dosyalarını listele
  app.get('/api/v1/simulation/files', (req, res) => {
    const simDir = path.join(__dirname, '../simulation_data');
    try {
      if (!fs.existsSync(simDir)) fs.mkdirSync(simDir, { recursive: true });
      const files = fs.readdirSync(simDir)
        .filter(f => f.toLowerCase().endsWith('.csv'))
        .sort();
      res.json({ ok: true, files });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message) });
    }
  });

  // ✅ TEK BİR simulation/start HANDLER — çakışma yok
  app.post('/api/v1/simulation/start', (req, res) => {
    // req.body kontrolü: Content-Type eksikse body undefined olabilir
    if (!req.body) {
      return res.status(400).json({ ok: false, error: 'Request body eksik veya Content-Type hatalı' });
    }

    const { file, speed = 1 } = req.body;

    if (!file) {
      // Dosya verilmeden gelen istek (sadece MATLAB toggle başlatmak isteyen çağrı)
      isMatlabSimulationActive = true;
      return res.json({ ok: true, message: 'MATLAB modu aktif, CSV başlatılmadı', isActive: true });
    }

    stopSimulation(); // Önceki simülasyonu temizle

    // ✅ Yeni simülasyon başlarken eski telemetri verisini sil
    if (store && typeof store.clearTelemetry === 'function') {
      store.clearTelemetry();
      console.log('[SIM] Eski telemetri temizlendi.');
    }

    const filePath = path.join(__dirname, '../simulation_data', path.basename(file));
    if (!fs.existsSync(filePath))
      return res.status(404).json({ ok: false, error: 'Dosya bulunamadı' });

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      const sep = lines[0].includes(';') ? ';' : ',';
      const headers = lines[0].split(sep).map(h => h.trim());

      const rows = [];
      for (let i = 1; i < lines.length; i++) {
        const vals = lines[i].split(sep).map(v => v.trim());
        if (vals.length >= 2) {
          const obj = {};
          headers.forEach((h, idx) => { obj[h] = vals[idx] || ''; });
          rows.push(obj);
        }
      }

      if (rows.length === 0)
        return res.status(400).json({ ok: false, error: 'CSV boş veya hatalı' });

      // 1x hızda saniyede 1 satır oynat (1000ms)
      const interval = Math.max(50, Math.round(1000 / Math.max(0.1, speed)));

      // ✅ Her iki flag da birlikte true yapılıyor
      isMatlabSimulationActive = true;
      simStatus = { running: true, file, row: 0, total: rows.length };
      io.emit('simulation_status', { ...simStatus });

      let idx = 0;
      function playNext() {
        if (!simStatus.running || idx >= rows.length) {
          stopSimulation();
          io.emit('simulation_status', { ...simStatus, running: false, finished: true });
          return;
        }
        try {
          const normalized = normalizeIncomingPayload(rows[idx]);
          const data = validateTelemetry(normalized);
          const receivedAt = new Date().toISOString();
          const serverTs = Date.now();
          if (store && typeof store.insertTelemetry === 'function')
            store.insertTelemetry({ ...data, received_at: receivedAt });
          io.emit('telemetry', { ...data, server_ts: serverTs, received_at: receivedAt });
        } catch (rowErr) {
          // İlk 3 hatalı satırı logla (çok fazla spam olmasın)
          if (idx < 3) console.warn(`[SIM] Satır ${idx} atlandı:`, rowErr.message);
        }
        simStatus.row = ++idx;
        if (idx % 20 === 0 || idx === rows.length)
          io.emit('simulation_status', { ...simStatus });
        simTimer = setTimeout(playNext, interval);
      }
      playNext();

      res.json({ ok: true, total: rows.length, interval, isActive: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message) });
    }
  });

  // ✅ TEK BİR simulation/stop HANDLER
  app.post('/api/v1/simulation/stop', (req, res) => {
    stopSimulation(); // running=false ve isMatlabSimulationActive=false
    io.emit('simulation_status', { ...simStatus });
    res.json({ ok: true, isActive: false });
  });

  // Telemetri sorgulama
  function handleQueryTelemetry(req, res) {
    if (!store || typeof store.queryTelemetry !== 'function') {
      res.status(503).json({ ok: false, error: 'Sorgu kullanılamıyor' });
      return;
    }
    try {
      const since  = req.query.since  ? String(req.query.since)  : undefined;
      const until  = req.query.until  ? String(req.query.until)  : undefined;
      const limit  = req.query.limit  !== undefined ? Number(req.query.limit)  : undefined;
      const offset = req.query.offset !== undefined ? Number(req.query.offset) : undefined;
      const order  = req.query.order  ? String(req.query.order).toLowerCase()  : undefined;
      const rows   = store.queryTelemetry({ since, until, limit, offset, order });
      res.json({ ok: true, count: rows.length, rows });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  }

  app.get('/api/telemetry',    handleQueryTelemetry);
  app.get('/api/v1/telemetry', handleQueryTelemetry);

  // ARAÇTAN GELEN TELEMETRİ
  app.post('/api/v1/telemetry', (req, res) => {
    if (!store || typeof store.insertTelemetry !== 'function') {
      res.status(503).json({ ok: false, error: 'Kayıt kullanılamıyor' });
      return;
    }
    try {
      const normalized  = normalizeIncomingPayload(req.body);
      const data        = validateTelemetry(normalized);
      const receivedAt  = new Date().toISOString();
      const serverTs    = Date.now();
      store.insertTelemetry({ ...data, received_at: receivedAt });
      io.emit('telemetry', { ...data, server_ts: serverTs, received_at: receivedAt });
      res.status(200).json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  });

  // MATLAB'DEN GELEN STRATEJİ
  let lastStrategyData = null;

  app.post('/api/v1/strategy', (req, res) => {
    try {
      lastStrategyData = req.body;
      io.emit('strategy', req.body);
      res.status(200).json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  });

  app.get('/api/v1/strategy', (req, res) => {
    if (lastStrategyData) {
      res.json({ ok: true, data: lastStrategyData });
    } else {
      res.json({ ok: false, data: null });
    }
  });

  app.get('/api/server-time', (_req, res) => {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const y  = now.getFullYear();
    const mo = pad(now.getMonth() + 1);
    const d  = pad(now.getDate());
    const h  = pad(now.getHours());
    const mi = pad(now.getMinutes());
    const s  = pad(now.getSeconds());
    const filenameSuffix = `${y}-${mo}-${d}_${h}-${mi}-${s}`;
    res.json({ iso: now.toISOString(), filenameSuffix, display: `${y}-${mo}-${d} ${h}:${mi}:${s}` });
  });

  app.get('/strategy/strategy_report.csv', (req, res) => {
    const filePath = path.join(__dirname, '../strategy/strategy_report.csv');
    if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      res.status(404).send('strategy_report.csv not found');
    }
  });

  app.use(express.static(config.publicDir));

  io.on('connection', (socket) => {
    socket.emit('status', { online: device.isOnline() });
  });

  return { app, server, io };
}

module.exports = { createHttpServer };