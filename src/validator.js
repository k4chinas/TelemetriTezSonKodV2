/**
 * Telemetri JSON doğrulama ve normalize (sunucu tarafı tipler).
 * CSV simülasyon verisi sadece temel alanları (spd, lat, lon, v, i, w, wh) içerebilir.
 * Eksik sensör alanları (gx, gy, ..., mx, my, ...) varsayılan 0 ile doldurulur.
 * @param {unknown} raw
 * @returns {object} normalize edilmiş düz nesne
 */
function validateTelemetry(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Geçersiz gövde: nesne bekleniyor');
  }

  const o = /** @type {Record<string, unknown>} */ (raw);

  // En az lat veya lon veya spd gibi temel bir alan olmalı
  const hasAnyUseful = ['lat', 'lon', 'spd', 'v', 'i', 'w', 'wh'].some(k => k in o && o[k] !== undefined);
  if (!hasAnyUseful) {
    throw new Error('Hiçbir kullanılabilir telemetri alanı bulunamadı');
  }

  const lon = safeFloat(o.lon, 0);
  const lat = safeFloat(o.lat, 0);
  const gx = safeFloat(o.gx, 0);
  const gy = safeFloat(o.gy, 0);
  const gz = safeFloat(o.gz, 0);
  const ax = safeFloat(o.ax, 0);
  const ay = safeFloat(o.ay, 0);
  const az = safeFloat(o.az, 0);
  const mx = safeFloat(o.mx, 0);
  const my = safeFloat(o.my, 0);
  const mz = safeFloat(o.mz, 0);
  const v = safeFloat(o.v, 0);
  const i = safeFloat(o.i, 0);
  const w = safeFloat(o.w, 0);
  const wh = safeFloat(o.wh, 0);

  const h = safeInt(o.h, 0);
  const m = safeInt(o.m, 0);
  const s = safeInt(o.s, 0);
  const alt = safeInt(o.alt, 0);
  const tmp = safeInt(o.tmp, 0);
  const spd = safeInt(o.spd, 0);
  const bat = safeInt(o.bat, 0);

  return {
    lon: roundTo(lon, 6),
    lat: roundTo(lat, 6),
    h, m, s, alt, tmp, spd, bat,
    gx: roundTo(gx, 4),
    gy: roundTo(gy, 4),
    gz: roundTo(gz, 4),
    ax: roundTo(ax, 4),
    ay: roundTo(ay, 4),
    az: roundTo(az, 4),
    mx: roundTo(mx, 4),
    my: roundTo(my, 4),
    mz: roundTo(mz, 4),
    v: roundTo(v, 2),
    i: roundTo(i, 2),
    w: roundTo(w, 2),
    wh: roundTo(wh, 2),
  };
}

/** Parse float, use defaultVal if undefined/null/NaN */
function safeFloat(v, defaultVal) {
  if (v === undefined || v === null || v === '') return defaultVal;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : defaultVal;
}

/** Parse int (rounded), use defaultVal if undefined/null/NaN */
function safeInt(v, defaultVal) {
  if (v === undefined || v === null || v === '') return defaultVal;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return defaultVal;
  return Math.round(n);
}

function roundTo(n, decimals) {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

module.exports = { validateTelemetry };

