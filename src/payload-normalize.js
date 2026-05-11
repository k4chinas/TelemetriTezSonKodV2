/**
 * GSM_BuildTelemetryJSON (Türkçe / PascalCase / __Alan__ formatlı) veya
 * kanonik (küçük harf) gövdeyi validateTelemetry() girişine dönüştürür.
 *
 * Desteklenen formatlar:
 *   __Lon__  /  Lon  /  lon  /  LON
 *   __Saat__ /  Saat /  h    /  H
 *   ... vb.
 *
 * @param {unknown} body
 * @returns {Record<string, unknown>}
 */
function normalizeIncomingPayload(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Geçersiz gövde');
  }
  const raw = /** @type {Record<string, unknown>} */ (body);

  // __Alan__ → alan  dönüşümü: başta ve sondaki __ çiftlerini sil
  const o = {};
  for (const [k, v] of Object.entries(raw)) {
    const clean = k.replace(/^__(.+)__$/, '$1');
    o[clean] = v;
  }

  function pick(keys) {
    // Önce birebir eşleşme
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined && o[k] !== null) {
        return o[k];
      }
    }
    // Büyük/küçük harf fark etmeksizin eşleşme
    const entries = Object.keys(o);
    for (const k of keys) {
      const low = k.toLowerCase();
      const found = entries.find((ek) => ek.toLowerCase() === low);
      if (found !== undefined && o[found] !== undefined && o[found] !== null) {
        return o[found];
      }
    }
    return undefined;
  }

  // CSV header aliases: voltage→v, current→i, watt→w, speed→spd vb.
  return {
    lon: pick(['lon', 'Lon', 'LON', 'longitude']),
    lat: pick(['lat', 'Lat', 'LAT', 'latitude']),
    h:   pick(['h', 'H', 'Saat', 'saat']),
    m:   pick(['m', 'M', 'Dakika', 'dakika']),
    s:   pick(['s', 'S', 'Saniye', 'saniye']),
    alt: pick(['alt', 'Alt', 'Yukseklik', 'yukseklik', 'altitude']),
    gx:  pick(['gx', 'Gx', 'GX']),
    gy:  pick(['gy', 'Gy', 'GY']),
    gz:  pick(['gz', 'Gz', 'GZ']),
    ax:  pick(['ax', 'Ax', 'AX']),
    ay:  pick(['ay', 'Ay', 'AY']),
    az:  pick(['az', 'Az', 'AZ']),
    tmp: pick(['tmp', 'Tmp', 'TMP', 'Sicaklik', 'sicaklik', 'temp', 'temperature']),
    mx:  pick(['mx', 'Mx', 'MX']),
    my:  pick(['my', 'My', 'MY']),
    mz:  pick(['mz', 'Mz', 'MZ']),
    v:   pick(['v', 'V', 'Voltaj', 'voltaj', 'voltage', 'Voltage']),
    i:   pick(['i', 'I', 'Akim', 'akim', 'current', 'Current']),
    w:   pick(['w', 'W', 'Watt', 'watt', 'power', 'Power']),
    wh:  pick(['wh', 'Wh', 'WH', 'WattSaat', 'wattSaat']),
    spd: pick(['spd', 'Spd', 'SPD', 'Hiz', 'hiz', 'speed', 'Speed']),
    bat: pick(['bat', 'Bat', 'BAT', 'Kalan_Enerji', 'kalanEnerji', 'battery', 'Battery']),
  };
}

module.exports = { normalizeIncomingPayload };
