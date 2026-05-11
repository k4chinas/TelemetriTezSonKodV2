// --- DEĞİŞKENLER VE DURUMLAR ---
let telemetryData = [];
let isRecording = false;
let isPaused = false;
let recordedRows = [];
let lastDataTime = 0;
const CONNECTION_TIMEOUT = 60000; // 1 dakika (60 saniye) veri gelmezse Offline

// Harita Değişkenleri
let map, marker, satelliteLayer, defaultLayer;
let isSatellite = true;
let lastLat = 0, lastLon = 0;
let raceMapInitialized = false;

// Strateji Odak Değişkeni
window.isStrategyFocusEnabled = localStorage.getItem('strategyFocus') !== 'false';
setTimeout(() => {
    const focusBtn = document.getElementById('focus-toggle-btn');
    if (focusBtn) {
        focusBtn.innerHTML = window.isStrategyFocusEnabled ? '🎯 Odak: AÇIK' : '🎯 Odak: KAPALI';
        focusBtn.style.opacity = window.isStrategyFocusEnabled ? '1' : '0.5';

        focusBtn.addEventListener('click', () => {
            window.isStrategyFocusEnabled = !window.isStrategyFocusEnabled;
            localStorage.setItem('strategyFocus', window.isStrategyFocusEnabled);
            focusBtn.innerHTML = window.isStrategyFocusEnabled ? '🎯 Odak: AÇIK' : '🎯 Odak: KAPALI';
            focusBtn.style.opacity = window.isStrategyFocusEnabled ? '1' : '0.5';

            if (!window.isStrategyFocusEnabled) {
                document.querySelectorAll('#strategy-table-body tr').forEach(r => r.classList.remove('row-active'));
            }
        });
    }
}, 500);

// --- KRONOMETRE DEĞİŞKENLERİ ---
let totalStartTime = 0;
let lapStartTime = 0;
let currentLapTracker = 0;
let timerInterval = null;

function formatTime(ms) {
    let totalSec = Math.floor(ms / 1000);
    let min = Math.floor(totalSec / 60).toString().padStart(2, '0');
    let sec = (totalSec % 60).toString().padStart(2, '0');
    let milli = Math.floor((ms % 1000) / 10).toString().padStart(2, '0');
    return `${min}:${sec}.${milli}`;
}

function startTimers() {
    if (!timerInterval) {
        timerInterval = setInterval(() => {
            let now = Date.now();
            if (totalStartTime > 0) document.getElementById('total-time-val').textContent = formatTime(now - totalStartTime);
            if (lapStartTime > 0) document.getElementById('lap-time-val').textContent = formatTime(now - lapStartTime);
        }, 50); // Saliselerin akması için 50ms yenileme hızı
    }
}

function stopTimers() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
}

function resetTimers() {
    stopTimers();
    totalStartTime = 0;
    lapStartTime = 0;
    currentLapTracker = 0;
    localStorage.removeItem('race_totalStartTime');
    localStorage.removeItem('race_lapStartTime');
    localStorage.removeItem('race_currentLapTracker');
    const lapTimeEl = document.getElementById('lap-time-val');
    const totalTimeEl = document.getElementById('total-time-val');
    const lapValEl = document.getElementById('lap-val');
    if (lapTimeEl) lapTimeEl.textContent = '00:00.00';
    if (totalTimeEl) totalTimeEl.textContent = '00:00.00';
    if (lapValEl) lapValEl.textContent = '--/--';
}

// Grafikler İçin Obje
const charts = {};
const chartHistory = { speed: [], voltage: [], current: [], power: [], energy: [], battery: [], time: [] };
const MAX_CHART_POINTS = 30;

// --- İLK KURULUM (INIT) ---
document.addEventListener("DOMContentLoaded", () => {
    initMap();
    initCharts();
    setupThemeToggle();
    setupRecordingControls();
    setupRaceStrategy();
    setupSimulation();

    // FIX #3: Socket.IO bağlantısı — gerçek zamanlı veri için birincil yol
    // Önceden socket.io hiç kullanılmıyordu; TCP'den gelen veriler dashboard'a ulaşmıyordu.
    const socket = io();

    socket.on('connect', () => {
        console.log('[Socket.IO] Bağlandı:', socket.id);
    });

    // Sunucu bağlantı durumunu doğrudan bildiriyor
    socket.on('status', ({ online }) => {
        updateConnectionStatus(online);
        if (online) lastDataTime = Date.now();
    });

    // Gerçek zamanlı telemetri verisi (TCP veya HTTP POST kaynaklı)
    socket.on('telemetry', (data) => {
        updateUI(data);
        handleRecording(data);
        lastDataTime = Date.now();
        updateConnectionStatus(true);
        const now = new Date();
        document.getElementById('last-time').textContent =
            `${now.toLocaleTimeString()} | ${now.toLocaleDateString()}`;

        // Race Strategy sayfası açıksa telemetri verisini de harita/tablo için kullan
        if (typeof window.updateStrategyUI === 'function' && data.lat && data.lon) {
            window.updateStrategyUI({
                speed: data.spd || 0,
                wh: data.wh || 0,
                watt: data.w || 0,
                voltage: data.v || 0,
                current: data.i || 0,
                bat: data.bat || 0,
                tmp: data.tmp || 0,
                alt: data.alt || 0,
                lat: data.lat,
                lon: data.lon,
                distance: data.distance // if provided by some source
            });
        }
    });

    // Strategy event from MATLAB
    socket.on('strategy', (data) => {
        // Tabloya MATLAB'dan gelen veriyi yansıtmak yerine
        // sadece UI'da vurgulama vb. güncellemesini çağır.
        if (typeof window.updateStrategyUI === 'function') {
            window.updateStrategyUI(data);
        }
    });

    socket.on('telemetry_error', ({ message, detail }) => {
        console.warn('[Telemetri Hatası]', message, detail || '');
    });

    // Simülasyon ilerleme güncellemeleri
    socket.on('simulation_status', (data) => {
        if (typeof window._onSimulationStatus === 'function') {
            window._onSimulationStatus(data);
        }
    });

    socket.on('disconnect', () => {
        console.log('[Socket.IO] Bağlantı kesildi');
        updateConnectionStatus(false);
    });

    // Sayfa ilk açıldığında son kaydı REST'ten çek (Socket.IO henüz veri göndermeden önce)
    fetchLatestTelemetry();

    // Bağlantı kontrol döngüsü (veri gelmeyi bırakırsa Offline yap)
    setInterval(checkConnection, 1000);
});

// --- İLK YÜKLEMEDEKİ REST SORGULAMA ---
// Sadece sayfa yüklenirken son satırı çeker; sonrasını Socket.IO halleder.
async function fetchLatestTelemetry() {
    try {
        // FIX #4: Doğru endpoint — önceden sadece /api/telemetry vardı, frontend /api/v1/telemetry arıyordu
        const response = await fetch('/api/v1/telemetry?limit=1');
        if (!response.ok) return;
        const data = await response.json();
        // FIX #5: Yanıt { ok, count, rows:[...] } formatında gelir; önceden tüm nesne updateUI'a gönderiliyordu
        if (data && data.ok && data.rows && data.rows.length > 0) {
            const latest = data.rows[data.rows.length - 1];
            updateUI(latest);
            lastDataTime = Date.now();
            updateConnectionStatus(true);
            const now = new Date();
            document.getElementById('last-time').textContent =
                `${now.toLocaleTimeString()} | ${now.toLocaleDateString()}`;
        }
    } catch (error) {
        // Sunucu henüz hazır değil — sessizce geç
    }
}

function checkConnection() {
    if (lastDataTime > 0 && Date.now() - lastDataTime > CONNECTION_TIMEOUT) {
        updateConnectionStatus(false);
    }
}

function updateConnectionStatus(isOnline) {
    const el = document.getElementById('connection-status');
    const text = document.getElementById('conn-text');
    if (isOnline) {
        el.className = 'status-badge online';
        text.textContent = 'Online';
    } else {
        el.className = 'status-badge offline';
        text.textContent = 'Offline';
    }
}

// --- ARAYÜZ GÜNCELLEME ---
function updateUI(data) {
    // FIX #6: Tüm alan adları düzeltildi.
    // Sunucu kısa adlar gönderiyor: spd, v, i, w, wh, bat, tmp, alt
    // Önceki kod data.speed, data.voltage vb. arıyordu — bunlar hiçbir zaman gelmiyordu.

    // 1. Ana Metrikler
    updateMetricCard('speed', data.spd || 0);
    updateMetricCard('volt', data.v || 0);
    updateMetricCard('curr', data.i || 0);
    updateMetricCard('power', data.w || 0);
    updateMetricCard('energy', data.wh || 0);
    updateMetricCard('batt', data.bat || 0);

    // 2. MPU Sensörleri
    document.getElementById('mpu-temp').textContent = (data.tmp || 0).toFixed(2);
    document.getElementById('gx-val').textContent = (data.gx || 0).toFixed(2);
    document.getElementById('gy-val').textContent = (data.gy || 0).toFixed(2);
    document.getElementById('gz-val').textContent = (data.gz || 0).toFixed(2);
    document.getElementById('ax-val').textContent = (data.ax || 0).toFixed(2);
    document.getElementById('ay-val').textContent = (data.ay || 0).toFixed(2);
    document.getElementById('az-val').textContent = (data.az || 0).toFixed(2);
    document.getElementById('mx-val').textContent = (data.mx || 0).toFixed(2);
    document.getElementById('my-val').textContent = (data.my || 0).toFixed(2);
    document.getElementById('mz-val').textContent = (data.mz || 0).toFixed(2);

    // 3. Harita ve Konum
    if (data.lat && data.lon) {
        document.getElementById('lat-val').textContent = data.lat.toFixed(6);
        document.getElementById('lon-val').textContent = data.lon.toFixed(6);
        // FIX: data.altitude → data.alt
        document.getElementById('alt-val').textContent = (data.alt || 0).toFixed(1);
        updateMap(data.lat, data.lon);
    }

    // 4. Grafikleri Güncelle
    updateCharts(data);
}

function updateMetricCard(prefix, currentValue) {
    document.getElementById(`${prefix}-val`).textContent = currentValue;

    if (!telemetryData[prefix]) telemetryData[prefix] = [];
    telemetryData[prefix].push(parseFloat(currentValue));
    if (telemetryData[prefix].length > 30) telemetryData[prefix].shift();

    const avg = telemetryData[prefix].reduce((a, b) => a + b, 0) / telemetryData[prefix].length;
    document.getElementById(`${prefix}-avg`).textContent = avg.toFixed(1);
}

// --- HARİTA VE YÖN BULMA (GPS) ---
function initMap() {
    map = L.map('map').setView([39.92077, 32.85411], 15);

    satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 });
    defaultLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 });

    satelliteLayer.addTo(map);

    const arrowIcon = L.divIcon({
        className: 'custom-div-icon',
        html: `<div id="map-arrow" style="transform: rotate(0deg); font-size: 24px; color: red; text-shadow: 0 0 5px white;">➤</div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12]
    });

    marker = L.marker([39.92077, 32.85411], { icon: arrowIcon }).addTo(map);

    document.getElementById('btn-map-toggle').addEventListener('click', () => {
        if (isSatellite) {
            map.removeLayer(satelliteLayer);
            defaultLayer.addTo(map);
        } else {
            map.removeLayer(defaultLayer);
            satelliteLayer.addTo(map);
        }
        isSatellite = !isSatellite;
    });
}

function updateMap(lat, lon) {
    if (lastLat !== 0 && lastLon !== 0) {
        const dy = lat - lastLat;
        const dx = Math.cos(Math.PI / 180 * lastLat) * (lon - lastLon);
        let angle = Math.atan2(dy, dx) * (180 / Math.PI);
        angle = (90 - angle + 360) % 360;
        const arrow = document.getElementById('map-arrow');
        if (arrow) arrow.style.transform = `rotate(${angle - 90}deg)`;
    }
    const newLatLng = new L.LatLng(lat, lon);
    marker.setLatLng(newLatLng);
    map.panTo(newLatLng);
    lastLat = lat;
    lastLon = lon;
}

// --- KART GENİŞLETME VE GRAFİKLER ---
function toggleCard(metric) {
    const cards = document.querySelectorAll('.metric-card');
    cards.forEach(card => {
        if (card.getAttribute('onclick').includes(metric)) {
            card.classList.toggle('expanded');
            card.style.borderBottomColor = card.classList.contains('expanded') ? 'transparent' : card.dataset.color;
        }
    });
}

function initCharts() {
    Chart.defaults.color = '#a1a1aa';
    Chart.defaults.font.family = 'monospace';

    createChart('chart-speed', 'Hız (km/h)', '#ef4444');
    createChart('chart-voltage', 'Voltaj (V)', '#eab308');
    createChart('chart-current', 'Akım (A)', '#3b82f6');
    createChart('chart-power', 'Güç (W)', '#a855f7');
    createChart('chart-energy', 'Enerji (Wh)', '#06b6d4');
    createChart('chart-battery', 'Batarya (%)', '#22c55e');
}

function createChart(canvasId, label, color) {
    const ctx = document.getElementById(canvasId).getContext('2d');
    charts[canvasId] = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: label,
                data: [],
                borderColor: color,
                backgroundColor: color + '33',
                borderWidth: 2,
                fill: true,
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { x: { display: false }, y: { grid: { color: '#27272a' } } },
            animation: false
        }
    });
}

function updateCharts(data) {
    const time = new Date().toLocaleTimeString();
    chartHistory.time.push(time);
    // FIX #7: Grafik alan adları da düzeltildi (spd, v, i, w, wh, bat)
    chartHistory.speed.push(data.spd || 0);
    chartHistory.voltage.push(data.v || 0);
    chartHistory.current.push(data.i || 0);
    chartHistory.power.push(data.w || 0);
    chartHistory.energy.push(data.wh || 0);
    chartHistory.battery.push(data.bat || 0);

    if (chartHistory.time.length > MAX_CHART_POINTS) {
        for (let key in chartHistory) chartHistory[key].shift();
    }

    updateSingleChart('chart-speed', chartHistory.speed);
    updateSingleChart('chart-voltage', chartHistory.voltage);
    updateSingleChart('chart-current', chartHistory.current);
    updateSingleChart('chart-power', chartHistory.power);
    updateSingleChart('chart-energy', chartHistory.energy);
    updateSingleChart('chart-battery', chartHistory.battery);
}

function updateSingleChart(canvasId, dataArr) {
    charts[canvasId].data.labels = chartHistory.time;
    charts[canvasId].data.datasets[0].data = dataArr;
    charts[canvasId].update();
}

// --- KAYIT (RECORDING) MEKANİZMASI ---
function setupRecordingControls() {
    const btnStart = document.getElementById('btn-start-record');
    const btnPause = document.getElementById('btn-pause-record');
    const btnResume = document.getElementById('btn-resume-record');
    const btnFinish = document.getElementById('btn-finish-record');

    const divActive = document.getElementById('recording-active');
    const divPaused = document.getElementById('recording-paused');
    const countBadge = document.getElementById('record-count');

    btnStart.addEventListener('click', () => {
        isRecording = true; isPaused = false; recordedRows = [];
        btnStart.classList.add('hidden');
        divActive.classList.remove('hidden');
        countBadge.textContent = '0 satır';
    });

    btnPause.addEventListener('click', () => {
        isPaused = true;
        divActive.classList.add('hidden');
        divPaused.classList.remove('hidden');
    });

    btnResume.addEventListener('click', () => {
        isPaused = false;
        divPaused.classList.add('hidden');
        divActive.classList.remove('hidden');
    });

    btnFinish.addEventListener('click', () => {
        isRecording = false; isPaused = false;
        divPaused.classList.add('hidden');
        btnStart.classList.remove('hidden');
        downloadCSV();
    });
}

function handleRecording(data) {
    if (isRecording && !isPaused) {
        data.timestamp = new Date().toISOString();
        recordedRows.push(data);
        document.getElementById('record-count').textContent = `${recordedRows.length} satır`;
    }
}

function downloadCSV() {
    if (recordedRows.length === 0) return alert('Kaydedilecek veri bulunamadı.');

    const headers = Object.keys(recordedRows[0]).join(',');
    const csvContent = recordedRows.map(row => Object.values(row).join(',')).join('\n');
    const finalCSV = headers + '\n' + csvContent;

    const blob = new Blob([finalCSV], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.setAttribute('href', url);
    a.setAttribute('download', `telemetri_kayit_${new Date().getTime()}.csv`);
    a.click();
}

// --- TEMA AYARI ---
function setupThemeToggle() {
    const btn = document.getElementById('theme-toggle');
    btn.addEventListener('click', () => {
        const html = document.documentElement;
        if (html.getAttribute('data-theme') === 'dark') {
            html.setAttribute('data-theme', 'light');
            btn.textContent = '🌙';
            Chart.defaults.color = '#52525b';
        } else {
            html.setAttribute('data-theme', 'dark');
            btn.textContent = '☀️';
            Chart.defaults.color = '#a1a1aa';
        }
        Object.values(charts).forEach(c => c.update());
    });
}

function setupRaceStrategy() {
    const btnOpen = document.getElementById('race-strategy-btn');
    const panel = document.getElementById('race-strategy-panel');
    const dashboard = document.getElementById('dashboard-page');
    const pageHeading = document.getElementById('page-heading');

    const trackData = [
        [50.5292755, 18.0960175], [50.5292706, 18.0960293], [50.5292657, 18.0960412], [50.5292607, 18.096053], [50.5292558, 18.0960648], [50.5292509, 18.0960766], [50.529246, 18.0960884], [50.5292411, 18.0961003], [50.5292362, 18.0961121], [50.5292313, 18.0961239], [50.5292263, 18.0961357], [50.5292213, 18.0961474], [50.5292164, 18.0961592], [50.5292114, 18.096171], [50.5292065, 18.0961828], [50.5292015, 18.0961946], [50.5291966, 18.0962063], [50.5291915, 18.096218], [50.5291864, 18.0962297], [50.5291814, 18.0962413], [50.5291763, 18.096253], [50.5291712, 18.0962646], [50.5291661, 18.0962762], [50.529161, 18.0962879], [50.5291559, 18.0962995], [50.5291509, 18.0963112], [50.5291458, 18.0963228], [50.5291407, 18.0963345], [50.5291356, 18.0963461], [50.5291305, 18.0963577], [50.5291254, 18.0963694], [50.5291203, 18.096381], [50.5291153, 18.0963926], [50.5291102, 18.0964043], [50.5291051, 18.0964159], [50.5291, 18.0964276], [50.5290949, 18.0964392], [50.5290898, 18.0964509], [50.5290848, 18.0964625], [50.5290797, 18.0964741], [50.5290746, 18.0964858], [50.5290695, 18.0964974], [50.5290644, 18.0965091], [50.5290593, 18.0965207], [50.5290544, 18.0965325], [50.5290494, 18.0965442], [50.5290444, 18.096556], [50.5290394, 18.0965677], [50.5290344, 18.0965795], [50.5290294, 18.0965912], [50.5290244, 18.0966029], [50.5290194, 18.0966147], [50.5290145, 18.0966264], [50.5290095, 18.0966382], [50.5290045, 18.0966499], [50.5289995, 18.0966617], [50.5289945, 18.0966734], [50.5289895, 18.0966852], [50.5289845, 18.0966969], [50.5289796, 18.0967087], [50.5289746, 18.0967204], [50.5289696, 18.0967321], [50.5289646, 18.0967439], [50.5289596, 18.0967556], [50.5289546, 18.0967674], [50.5289496, 18.0967791], [50.5289446, 18.0967909], [50.5289397, 18.0968026], [50.5289347, 18.0968144], [50.5289297, 18.0968261], [50.5289247, 18.0968379], [50.5289197, 18.0968496], [50.5289147, 18.0968613], [50.5289097, 18.0968731], [50.5289048, 18.0968848], [50.5288998, 18.0968966], [50.5288948, 18.0969083], [50.5288898, 18.0969201], [50.5288848, 18.0969318], [50.5288798, 18.0969436], [50.5288743, 18.0969546], [50.5288684, 18.0969654], [50.5288626, 18.0969761], [50.5288567, 18.0969867], [50.5288508, 18.0969974], [50.5288449, 18.097008], [50.528839, 18.0970187], [50.5288331, 18.0970294], [50.5288272, 18.0970401], [50.5288213, 18.0970507], [50.5288154, 18.0970613], [50.5288094, 18.0970719], [50.5288034, 18.0970824], [50.5287974, 18.0970929], [50.5287914, 18.0971035], [50.5287854, 18.097114], [50.5287794, 18.0971244], [50.5287733, 18.0971347], [50.5287672, 18.0971451], [50.5287611, 18.0971555], [50.528755, 18.0971659], [50.5287489, 18.0971763], [50.5287427, 18.0971865], [50.5287365, 18.0971968], [50.5287303, 18.097207], [50.5287241, 18.0972171], [50.5287177, 18.0972272], [50.5287114, 18.0972372], [50.528705, 18.0972472], [50.5286986, 18.0972571], [50.5286921, 18.0972669], [50.5286856, 18.0972766], [50.5286791, 18.0972862], [50.5286725, 18.0972959], [50.5286659, 18.0973054], [50.5286591, 18.0973148], [50.5286523, 18.097324], [50.5286455, 18.0973331], [50.5286385, 18.097342], [50.5286315, 18.0973508], [50.5286244, 18.0973595], [50.5286172, 18.0973679], [50.5286099, 18.0973762], [50.5286024, 18.0973841], [50.5285949, 18.097392], [50.5285873, 18.0973994], [50.5285796, 18.0974068], [50.5285718, 18.0974138], [50.528564, 18.0974208], [50.5285561, 18.0974275], [50.5285481, 18.097434], [50.52854, 18.0974401], [50.5285319, 18.0974461], [50.5285236, 18.0974517], [50.5285153, 18.0974572], [50.528507, 18.0974624], [50.5284986, 18.0974674], [50.5284901, 18.0974721], [50.5284815, 18.0974765], [50.5284729, 18.0974806], [50.5284643, 18.0974845], [50.5284556, 18.0974882], [50.5284468, 18.0974915], [50.5284381, 18.0974945], [50.5284292, 18.097497], [50.5284203, 18.0974994], [50.5284114, 18.0975013], [50.5284025, 18.0975032], [50.5283936, 18.0975045], [50.5283846, 18.0975058], [50.5283756, 18.0975064], [50.5283666, 18.097507], [50.5283576, 18.097507], [50.5283486, 18.0975069], [50.5283396, 18.0975063], [50.5283307, 18.0975055], [50.5283217, 18.0975044], [50.5283128, 18.0975029], [50.5283038, 18.0975011], [50.5282949, 18.0974991], [50.5282861, 18.0974968], [50.5282773, 18.097494], [50.5282684, 18.097491], [50.5282597, 18.0974876], [50.528251, 18.097484], [50.5282424, 18.0974798], [50.5282339, 18.0974756], [50.5282254, 18.0974707], [50.528217, 18.0974658], [50.5282087, 18.0974604], [50.5282004, 18.0974548], [50.5281923, 18.0974488], [50.5281842, 18.0974427], [50.5281762, 18.0974361], [50.5281684, 18.0974292], [50.5281606, 18.097422], [50.528153, 18.0974145], [50.5281455, 18.0974067], [50.5281382, 18.0973986], [50.5281309, 18.0973902], [50.528124, 18.0973812], [50.5281172, 18.097372], [50.5281107, 18.0973622], [50.5281043, 18.0973523], [50.5280984, 18.0973417], [50.5280925, 18.0973311], [50.5280872, 18.0973196], [50.528082, 18.0973081], [50.5280773, 18.097296], [50.5280729, 18.0972838], [50.5280688, 18.0972712], [50.5280651, 18.0972584], [50.5280619, 18.0972452], [50.5280591, 18.0972318], [50.5280568, 18.0972181], [50.5280549, 18.0972043], [50.5280535, 18.0971904], [50.5280525, 18.0971764], [50.5280518, 18.0971623], [50.5280516, 18.0971482], [50.5280517, 18.0971341], [50.5280523, 18.0971201], [50.528053, 18.097106], [50.5280544, 18.0970921], [50.5280559, 18.0970781], [50.5280579, 18.0970644], [50.5280601, 18.0970507], [50.5280628, 18.0970372], [50.5280656, 18.0970238], [50.5280687, 18.0970106], [50.5280718, 18.0969973], [50.5280753, 18.0969843], [50.5280788, 18.0969713], [50.5280826, 18.0969585], [50.5280864, 18.0969457], [50.5280903, 18.0969331], [50.5280943, 18.0969204], [50.5280983, 18.0969078], [50.5281024, 18.0968952], [50.5281065, 18.0968826], [50.5281106, 18.0968701], [50.5281147, 18.0968575], [50.5281188, 18.0968449], [50.5281229, 18.0968323], [50.5281269, 18.0968198], [50.5281309, 18.0968072], [50.528135, 18.0967945], [50.5281389, 18.0967819], [50.5281429, 18.0967692], [50.5281469, 18.0967566], [50.5281509, 18.0967439], [50.5281548, 18.0967312], [50.5281588, 18.0967185], [50.5281627, 18.0967058], [50.5281666, 18.0966931], [50.5281704, 18.0966803], [50.5281742, 18.0966675], [50.528178, 18.0966547], [50.5281817, 18.0966419], [50.5281855, 18.0966291], [50.5281892, 18.0966162], [50.5281928, 18.0966033], [50.5281965, 18.0965904], [50.5282, 18.0965775], [50.5282036, 18.0965645], [50.528207, 18.0965514], [50.5282104, 18.0965384], [50.5282138, 18.0965253], [50.5282172, 18.0965122], [50.5282205, 18.0964991], [50.5282238, 18.096486], [50.5282271, 18.0964728], [50.5282303, 18.0964597], [50.5282335, 18.0964464], [50.5282366, 18.0964333], [50.5282398, 18.09642], [50.5282429, 18.0964068], [50.528246, 18.0963935], [50.528249, 18.0963802], [50.528252, 18.0963669], [50.5282549, 18.0963536], [50.5282579, 18.0963403], [50.5282608, 18.0963269], [50.5282637, 18.0963135], [50.5282665, 18.0963002], [50.5282693, 18.0962867], [50.528272, 18.0962733], [50.5282748, 18.0962598], [50.5282774, 18.0962463], [50.52828, 18.0962328], [50.5282826, 18.0962193], [50.5282851, 18.0962057], [50.5282875, 18.0961922], [50.5282899, 18.0961786], [50.5282922, 18.0961649], [50.5282945, 18.0961513], [50.5282968, 18.0961376], [50.528299, 18.096124], [50.5283012, 18.0961103], [50.5283033, 18.0960966], [50.5283054, 18.0960828], [50.5283075, 18.0960691], [50.5283096, 18.0960554], [50.5283116, 18.0960416], [50.5283135, 18.0960278], [50.5283154, 18.096014], [50.5283173, 18.0960002], [50.5283192, 18.0959864], [50.528321, 18.0959726], [50.5283228, 18.0959588], [50.5283245, 18.0959449], [50.5283262, 18.0959311], [50.5283279, 18.0959172], [50.5283296, 18.0959034], [50.5283312, 18.0958895], [50.5283328, 18.0958756], [50.5283343, 18.0958617], [50.5283358, 18.0958478], [50.5283372, 18.0958338], [50.5283387, 18.0958199], [50.52834, 18.0958059], [50.5283414, 18.095792], [50.5283426, 18.095778], [50.5283439, 18.095764], [50.5283451, 18.0957501], [50.5283463, 18.0957361], [50.5283474, 18.0957221], [50.5283485, 18.0957081], [50.5283496, 18.095694], [50.5283506, 18.09568], [50.5283515, 18.095666], [50.5283525, 18.095652], [50.5283534, 18.0956379], [50.5283543, 18.0956239], [50.5283551, 18.0956098], [50.5283559, 18.0955958], [50.5283567, 18.0955817], [50.5283575, 18.0955677], [50.5283583, 18.0955536], [50.528359, 18.0955395], [50.5283598, 18.0955255], [50.5283606, 18.0955114], [50.5283614, 18.0954974], [50.5283621, 18.0954833], [50.5283629, 18.0954692], [50.5283636, 18.0954552], [50.5283643, 18.0954411], [50.5283651, 18.095427], [50.5283658, 18.095413], [50.5283666, 18.0953989], [50.5283673, 18.0953848], [50.528368, 18.0953708], [50.5283688, 18.0953567], [50.5283696, 18.0953427], [50.5283703, 18.0953286], [50.528371, 18.0953145], [50.5283718, 18.0953005], [50.5283725, 18.0952864], [50.5283732, 18.0952723], [50.5283739, 18.0952583], [50.5283746, 18.0952442], [50.5283752, 18.0952301], [50.5283759, 18.095216], [50.5283764, 18.0952019], [50.528377, 18.0951879], [50.5283775, 18.0951738], [50.528378, 18.0951597], [50.5283785, 18.0951456], [50.5283789, 18.0951315], [50.5283793, 18.0951174], [50.5283797, 18.0951033], [50.5283801, 18.0950892], [50.5283805, 18.0950751], [50.5283809, 18.095061, 206.16, 353.0], [50.5283813, 18.0950469, 206.16, 354.0], [50.5283817, 18.0950328, 206.16, 355.0], [50.528382, 18.0950187, 206.17, 356.0], [50.5283824, 18.0950046, 206.16, 357.0], [50.5283827, 18.0949905, 206.16, 358.0], [50.5283831, 18.0949764, 206.15, 359.0], [50.5283834, 18.0949623, 206.15, 360.0], [50.5283838, 18.0949482, 206.16, 361.0], [50.5283841, 18.0949341, 206.15, 362.0], [50.5283845, 18.09492, 206.15, 363.0], [50.5283848, 18.0949059, 206.14, 364.0], [50.5283851, 18.0948918, 206.13, 365.0], [50.5283854, 18.0948777, 206.14, 366.0], [50.5283858, 18.0948636, 206.12, 367.0], [50.5283861, 18.0948495, 206.13, 368.0], [50.5283864, 18.0948354, 206.13, 369.0], [50.5283868, 18.0948213, 206.13, 370.0], [50.5283872, 18.0948072, 206.13, 371.0], [50.5283874, 18.0947931, 206.13, 372.0], [50.5283877, 18.094779, 206.14, 373.0], [50.528388, 18.0947649, 206.12, 374.0], [50.5283882, 18.0947508, 206.13, 375.0], [50.5283885, 18.0947367, 206.1, 376.0], [50.5283887, 18.0947225, 206.11, 377.0], [50.5283889, 18.0947084, 206.13, 378.0], [50.5283891, 18.0946943, 206.11, 379.0], [50.5283893, 18.0946802, 206.11, 380.0], [50.5283894, 18.0946661, 206.11, 381.0], [50.5283896, 18.094652, 206.11, 382.0], [50.5283898, 18.0946379, 206.12, 383.0], [50.5283899, 18.0946238, 206.11, 384.0], [50.52839, 18.0946097, 206.08, 385.0], [50.5283902, 18.0945956, 206.07, 386.0], [50.5283903, 18.0945814, 206.09, 387.0], [50.5283905, 18.0945673, 206.08, 388.0], [50.5283906, 18.0945532, 206.08, 389.0], [50.5283907, 18.0945391, 206.06, 390.0], [50.5283908, 18.094525, 206.08, 391.0], [50.5283909, 18.0945109, 206.07, 392.0], [50.528391, 18.0944968, 206.07, 393.0], [50.5283911, 18.0944827, 206.06, 394.0], [50.5283912, 18.0944686, 206.07, 395.0], [50.5283913, 18.0944545, 206.07, 396.0], [50.5283915, 18.0944403, 206.05, 397.0], [50.5283916, 18.0944262, 206.06, 398.0], [50.5283917, 18.0944121, 206.05, 399.0], [50.5283919, 18.094398, 206.02, 400.0], [50.5283921, 18.0943839, 206.04, 401.0], [50.5283923, 18.0943698, 206.02, 402.0], [50.5283925, 18.0943557, 206.04, 403.0], [50.5283928, 18.0943416, 206.05, 404.0], [50.528393, 18.0943275, 206.05, 405.0], [50.5283933, 18.0943134, 206.02, 406.0], [50.5283937, 18.0942993, 206.03, 407.0], [50.5283941, 18.0942852, 206.01, 408.0], [50.5283945, 18.0942711, 206.04, 409.0], [50.5283948, 18.094257, 206.02, 410.0], [50.5283953, 18.0942429, 206.03, 411.0], [50.5283957, 18.0942288, 206.03, 412.0], [50.5283962, 18.0942147, 206.01, 413.0], [50.5283967, 18.0942006, 206.0, 414.0], [50.5283972, 18.0941865, 206.0, 415.0], [50.5283978, 18.0941724, 205.99, 416.0], [50.5283986, 18.0941584, 206.02, 417.0], [50.5283994, 18.0941443, 206.0, 418.0], [50.5284005, 18.0941303, 205.98, 419.0], [50.5284015, 18.0941163, 205.99, 420.0], [50.5284027, 18.0941023, 206.01, 421.0], [50.5284039, 18.0940883, 205.99, 422.0], [50.5284053, 18.0940744, 205.99, 423.0], [50.5284069, 18.0940605, 205.98, 424.0], [50.5284086, 18.0940466, 205.98, 425.0], [50.5284105, 18.0940328, 205.98, 426.0], [50.5284126, 18.0940191, 205.97, 427.0], [50.5284149, 18.0940055, 205.97, 428.0], [50.5284173, 18.0939919, 205.92, 429.0], [50.52842, 18.0939784, 205.99, 430.0], [50.5284228, 18.093965, 205.96, 431.0], [50.5284259, 18.0939517, 205.93, 432.0], [50.5284291, 18.0939386, 205.95, 433.0], [50.5284327, 18.0939256, 205.94, 434.0], [50.5284363, 18.0939127, 205.95, 435.0], [50.5284403, 18.0939001, 205.93, 436.0], [50.5284444, 18.0938875, 205.92, 437.0], [50.528449, 18.0938754, 205.91, 438.0], [50.5284537, 18.0938633, 205.9, 439.0], [50.5284587, 18.0938517, 205.9, 440.0], [50.5284639, 18.0938401, 205.91, 441.0], [50.5284693, 18.0938288, 205.9, 442.0], [50.5284748, 18.0938177, 205.91, 443.0], [50.5284807, 18.093807, 205.91, 444.0], [50.5284866, 18.0937964, 205.89, 445.0], [50.5284929, 18.0937862, 205.89, 446.0], [50.5284992, 18.0937762, 205.91, 447.0], [50.5285056, 18.0937663, 205.9, 448.0], [50.5285122, 18.0937566, 205.9, 449.0], [50.5285188, 18.0937471, 205.9, 450.0], [50.5285254, 18.0937376, 205.88, 451.0], [50.5285321, 18.0937281, 205.9, 452.0], [50.5285387, 18.0937186, 205.89, 453.0], [50.5285454, 18.093709, 205.88, 454.0], [50.528552, 18.0936994, 205.88, 455.0], [50.5285585, 18.0936898, 205.88, 456.0], [50.528565, 18.09368, 205.87, 457.0], [50.5285715, 18.0936702, 205.87, 458.0], [50.5285776, 18.0936599, 205.85, 459.0], [50.5285837, 18.0936495, 205.84, 460.0], [50.5285896, 18.0936389, 205.83, 461.0], [50.5285954, 18.0936281, 205.84, 462.0], [50.528601, 18.0936171, 205.81, 463.0], [50.5286066, 18.093606, 205.8, 464.0], [50.5286119, 18.0935946, 205.81, 465.0], [50.5286171, 18.0935831, 205.8, 466.0], [50.5286221, 18.0935713, 205.79, 467.0], [50.5286269, 18.0935594, 205.78, 468.0], [50.5286316, 18.0935473, 205.79, 469.0], [50.5286361, 18.0935352, 205.77, 470.0], [50.5286404, 18.0935228, 205.76, 471.0], [50.5286447, 18.0935104, 205.78, 472.0], [50.5286487, 18.0934977, 205.76, 473.0], [50.5286526, 18.093485, 205.75, 474.0], [50.5286563, 18.0934722, 205.76, 475.0], [50.5286598, 18.0934592, 205.75, 476.0], [50.5286632, 18.0934461, 205.75, 477.0], [50.5286664, 18.0934329, 205.73, 478.0], [50.5286694, 18.0934196, 205.73, 479.0], [50.5286723, 18.0934062, 205.75, 480.0], [50.528675, 18.0933928, 205.73, 481.0], [50.5286777, 18.0933793, 205.73, 482.0], [50.5286802, 18.0933658, 205.74, 483.0], [50.5286827, 18.0933522, 205.72, 484.0], [50.5286849, 18.0933385, 205.73, 485.0], [50.5286871, 18.0933248, 205.72, 486.0], [50.5286891, 18.0933111, 205.73, 487.0], [50.5286911, 18.0932973, 205.73, 488.0], [50.5286929, 18.0932835, 205.73, 489.0], [50.5286947, 18.0932697, 205.71, 490.0], [50.5286963, 18.0932558, 205.71, 491.0], [50.5286979, 18.0932419, 205.73, 492.0], [50.5286993, 18.0932279, 205.7, 493.0], [50.5287006, 18.093214, 205.71, 494.0], [50.5287018, 18.0932, 205.7, 495.0], [50.528703, 18.093186, 205.69, 496.0], [50.5287041, 18.093172, 205.71, 497.0], [50.5287051, 18.093158, 205.69, 498.0], [50.528706, 18.093144, 205.69, 499.0], [50.528707, 18.0931299, 205.7, 500.0], [50.5287077, 18.0931159, 205.68, 501.0], [50.5287084, 18.0931018, 205.68, 502.0], [50.5287089, 18.0930877, 205.66, 503.0], [50.5287095, 18.0930736, 205.66, 504.0], [50.5287099, 18.0930595, 205.66, 505.0], [50.5287102, 18.0930454, 205.65, 506.0], [50.5287104, 18.0930313, 205.65, 507.0], [50.5287106, 18.0930172, 205.65, 508.0], [50.5287107, 18.0930031, 205.65, 509.0], [50.5287107, 18.092989, 205.66, 510.0], [50.5287106, 18.0929749, 205.64, 511.0], [50.5287105, 18.0929607, 205.63, 512.0], [50.5287103, 18.0929466, 205.63, 513.0], [50.5287101, 18.0929325, 205.64, 514.0], [50.5287098, 18.0929184, 205.64, 515.0], [50.5287095, 18.0929043, 205.65, 516.0], [50.5287091, 18.0928902, 205.62, 517.0], [50.5287087, 18.0928761, 205.59, 518.0], [50.5287083, 18.092862, 205.61, 519.0], [50.5287078, 18.0928479, 205.62, 520.0], [50.5287073, 18.0928339, 205.61, 521.0], [50.5287068, 18.0928198, 205.64, 522.0], [50.5287062, 18.0928057, 205.62, 523.0], [50.5287056, 18.0927916, 205.58, 524.0], [50.5287049, 18.0927775, 205.59, 525.0], [50.5287043, 18.0927634, 205.6, 526.0], [50.5287036, 18.0927494, 205.59, 527.0], [50.528703, 18.0927353, 205.58, 528.0], [50.5287023, 18.0927212, 205.59, 529.0], [50.5287015, 18.0927072, 205.58, 530.0], [50.5287007, 18.0926931, 205.58, 531.0], [50.5286999, 18.0926791, 205.57, 532.0], [50.5286991, 18.092665, 205.55, 533.0], [50.5286982, 18.0926509, 205.59, 534.0], [50.5286974, 18.0926369, 205.55, 535.0], [50.5286965, 18.0926229, 205.57, 536.0], [50.5286956, 18.0926088, 205.56, 537.0], [50.5286947, 18.0925948, 205.55, 538.0], [50.5286937, 18.0925807, 205.54, 539.0], [50.5286928, 18.0925667, 205.52, 540.0], [50.5286918, 18.0925527, 205.53, 541.0], [50.5286908, 18.0925387, 205.53, 542.0], [50.5286897, 18.0925247, 205.52, 543.0], [50.5286886, 18.0925107, 205.51, 544.0], [50.5286875, 18.0924966, 205.52, 545.0], [50.5286864, 18.0924826, 205.53, 546.0], [50.5286853, 18.0924686, 205.53, 547.0], [50.5286841, 18.0924546, 205.52, 548.0], [50.5286829, 18.0924407, 205.52, 549.0], [50.5286818, 18.0924267, 205.52, 550.0], [50.5286806, 18.0924127, 205.5, 551.0], [50.5286795, 18.0923987, 205.5, 552.0], [50.5286783, 18.0923847, 205.49, 553.0], [50.5286771, 18.0923707, 205.49, 554.0], [50.528676, 18.0923567, 205.51, 555.0], [50.5286748, 18.0923427, 205.49, 556.0], [50.5286737, 18.0923287, 205.48, 557.0], [50.5286724, 18.0923147, 205.47, 558.0], [50.5286712, 18.0923007, 205.47, 559.0], [50.5286701, 18.0922867, 205.46, 560.0], [50.5286689, 18.0922727, 205.46, 561.0], [50.5286678, 18.0922587, 205.47, 562.0], [50.5286667, 18.0922447, 205.46, 563.0], [50.5286656, 18.0922307, 205.45, 564.0], [50.5286644, 18.0922167, 205.44, 565.0], [50.5286632, 18.0922027, 205.44, 566.0], [50.5286621, 18.0921887, 205.44, 567.0], [50.528661, 18.0921747, 205.45, 568.0], [50.5286599, 18.0921607, 205.44, 569.0], [50.5286588, 18.0921467, 205.44, 570.0], [50.5286578, 18.0921327, 205.43, 571.0], [50.5286567, 18.0921187, 205.42, 572.0], [50.5286557, 18.0921047, 205.45, 573.0], [50.5286546, 18.0920906, 205.42, 574.0], [50.5286536, 18.0920766, 205.41, 575.0], [50.5286525, 18.0920626, 205.44, 576.0], [50.5286515, 18.0920486, 205.38, 577.0], [50.5286505, 18.0920346, 205.36, 578.0], [50.5286495, 18.0920206, 205.39, 579.0], [50.5286485, 18.0920065, 205.39, 580.0], [50.5286476, 18.0919925, 205.38, 581.0], [50.5286466, 18.0919784, 205.38, 582.0], [50.5286457, 18.0919644, 205.36, 583.0], [50.5286447, 18.0919504, 205.36, 584.0], [50.5286438, 18.0919364, 205.35, 585.0], [50.5286428, 18.0919223, 205.34, 586.0], [50.5286419, 18.0919083, 205.35, 587.0], [50.528641, 18.0918942, 205.33, 588.0], [50.52864, 18.0918802, 205.34, 589.0], [50.5286391, 18.0918662, 205.33, 590.0], [50.5286382, 18.0918521, 205.34, 591.0], [50.5286373, 18.0918381, 205.33, 592.0], [50.5286364, 18.091824, 205.33, 593.0], [50.5286355, 18.09181, 205.34, 594.0], [50.5286346, 18.091796, 205.32, 595.0], [50.5286337, 18.0917819, 205.32, 596.0], [50.5286329, 18.0917679, 205.32, 597.0], [50.528632, 18.0917538, 205.33, 598.0], [50.5286311, 18.0917398, 205.31, 599.0], [50.5286303, 18.0917257, 205.32, 600.0], [50.5286295, 18.0917117, 205.3, 601.0], [50.5286287, 18.0916976, 205.32, 602.0], [50.5286279, 18.0916836, 205.32, 603.0], [50.5286271, 18.0916695, 205.31, 604.0], [50.5286264, 18.0916554, 205.29, 605.0], [50.5286256, 18.0916414, 205.31, 606.0], [50.5286248, 18.0916273, 205.3, 607.0], [50.5286241, 18.0916133, 205.3, 608.0], [50.5286234, 18.0915992, 205.32, 609.0], [50.5286227, 18.0915851, 205.33, 610.0], [50.528622, 18.091571, 205.29, 611.0], [50.5286214, 18.091557, 205.31, 612.0], [50.5286207, 18.0915429, 205.3, 613.0], [50.5286201, 18.0915288, 205.31, 614.0], [50.5286196, 18.0915147, 205.29, 615.0], [50.528619, 18.0915006, 205.29, 616.0], [50.5286185, 18.0914865, 205.29, 617.0], [50.528618, 18.0914725, 205.28, 618.0], [50.5286175, 18.0914584, 205.28, 619.0], [50.5286171, 18.0914443, 205.28, 620.0], [50.5286167, 18.0914302, 205.25, 621.0], [50.5286164, 18.0914161, 205.25, 622.0], [50.528616, 18.091402, 205.28, 623.0], [50.5286157, 18.0913879, 205.28, 624.0], [50.5286155, 18.0913738, 205.28, 625.0], [50.5286153, 18.0913597, 205.24, 626.0], [50.5286152, 18.0913455, 205.27, 627.0], [50.5286152, 18.0913314, 205.27, 628.0], [50.5286152, 18.0913173, 205.28, 629.0], [50.5286153, 18.0913032, 205.25, 630.0], [50.5286154, 18.0912891, 205.26, 631.0], [50.5286157, 18.091275, 205.25, 632.0], [50.528616, 18.0912609, 205.24, 633.0], [50.5286163, 18.0912468, 205.24, 634.0], [50.5286168, 18.0912327, 205.23, 635.0], [50.5286173, 18.0912186, 205.22, 636.0], [50.5286178, 18.0912045, 205.24, 637.0], [50.5286185, 18.0911904, 205.23, 638.0], [50.5286192, 18.0911764, 205.24, 639.0], [50.52862, 18.0911623, 205.22, 640.0], [50.5286209, 18.0911483, 205.22, 641.0], [50.528622, 18.0911343, 205.21, 642.0], [50.5286231, 18.0911203, 205.18, 643.0], [50.5286243, 18.0911063, 205.17, 644.0], [50.5286256, 18.0910923, 205.2, 645.0], [50.5286269, 18.0910783, 205.18, 646.0], [50.5286284, 18.0910644, 205.16, 647.0], [50.5286299, 18.0910505, 205.15, 648.0], [50.5286316, 18.0910366, 205.13, 649.0], [50.5286333, 18.0910228, 205.13, 650.0], [50.5286351, 18.091009, 205.13, 651.0], [50.528637, 18.0909952, 205.13, 652.0], [50.5286391, 18.0909814, 205.12, 653.0], [50.5286412, 18.0909677, 205.11, 654.0], [50.5286435, 18.0909541, 205.1, 655.0], [50.5286458, 18.0909405, 205.1, 656.0], [50.5286483, 18.0909269, 205.09, 657.0], [50.5286509, 18.0909134, 205.09, 658.0], [50.5286537, 18.0909, 205.07, 659.0], [50.5286566, 18.0908866, 205.07, 660.0], [50.5286597, 18.0908734, 205.07, 661.0], [50.5286629, 18.0908602, 205.06, 662.0], [50.5286662, 18.090847, 204.99, 663.0], [50.5286696, 18.090834, 205.04, 664.0], [50.5286731, 18.090821, 204.99, 665.0], [50.5286768, 18.0908081, 205.02, 666.0], [50.5286806, 18.0907953, 205.0, 667.0], [50.5286845, 18.0907826, 205.0, 668.0], [50.5286885, 18.09077, 204.98, 669.0], [50.5286926, 18.0907575, 204.98, 670.0], [50.5286969, 18.090745, 204.96, 671.0], [50.5287013, 18.0907327, 204.93, 672.0], [50.5287057, 18.0907204, 204.94, 673.0], [50.5287104, 18.0907083, 204.95, 674.0], [50.5287151, 18.0906963, 204.93, 675.0], [50.5287199, 18.0906844, 204.9, 676.0], [50.5287248, 18.0906726, 204.87, 677.0], [50.5287299, 18.090661, 204.89, 678.0], [50.528735, 18.0906493, 204.87, 679.0], [50.5287404, 18.090638, 204.85, 680.0], [50.5287457, 18.0906267, 204.87, 681.0], [50.5287512, 18.0906155, 204.84, 682.0], [50.5287568, 18.0906044, 204.82, 683.0], [50.5287625, 18.0905936, 204.8, 684.0], [50.5287683, 18.0905827, 204.8, 685.0], [50.5287743, 18.0905723, 204.81, 686.0], [50.5287804, 18.0905619, 204.78, 687.0], [50.5287867, 18.0905518, 204.79, 688.0], [50.5287931, 18.0905418, 204.77, 689.0], [50.5287996, 18.0905321, 204.75, 690.0], [50.5288061, 18.0905224, 204.74, 691.0], [50.5288128, 18.0905129, 204.72, 692.0], [50.5288196, 18.0905036, 204.73, 693.0], [50.5288265, 18.0904947, 204.71, 694.0], [50.5288336, 18.090486, 204.71, 695.0], [50.5288408, 18.0904775, 204.68, 696.0], [50.5288481, 18.0904694, 204.67, 697.0], [50.5288556, 18.0904615, 204.66, 698.0], [50.5288633, 18.0904541, 204.62, 699.0], [50.528871, 18.0904469, 204.64, 700.0], [50.5288789, 18.0904401, 204.62, 701.0], [50.5288868, 18.0904333, 204.62, 702.0], [50.5288949, 18.0904272, 204.63, 703.0], [50.528903, 18.0904211, 204.6, 704.0], [50.5289113, 18.0904157], [50.5289196, 18.0904103], [50.5289281, 18.0904055], [50.5289365, 18.0904007], [50.5289451, 18.0903966], [50.5289537, 18.0903925], [50.5289625, 18.090389, 204.53], [50.5289712, 18.0903856], [50.52898, 18.0903827], [50.5289888, 18.09038], [50.5289977, 18.0903777], [50.5290066, 18.0903756], [50.5290155, 18.0903739], [50.5290245, 18.0903725], [50.5290334, 18.0903713], [50.5290424, 18.0903706], [50.5290514, 18.0903701], [50.5290604, 18.09037], [50.5290694, 18.0903701], [50.5290784, 18.0903706], [50.5290874, 18.0903713], [50.5290963, 18.0903725], [50.5291053, 18.0903738], [50.5291142, 18.0903756], [50.5291231, 18.0903774], [50.529132, 18.0903799], [50.5291408, 18.0903824], [50.5291497, 18.0903852], [50.5291584, 18.0903882], [50.5291672, 18.0903915], [50.5291759, 18.090395], [50.5291846, 18.0903986], [50.5291933, 18.0904024], [50.5292019, 18.0904064], [50.5292105, 18.0904106], [50.529219, 18.0904149], [50.5292275, 18.0904195], [50.529236, 18.0904242], [50.5292446, 18.0904287], [50.5292531, 18.0904332], [50.5292616, 18.0904377], [50.5292701, 18.0904423], [50.5292786, 18.0904469], [50.5292871, 18.0904516], [50.5292956, 18.0904563], [50.529304, 18.0904611], [50.5293125, 18.0904659], [50.5293209, 18.0904708], [50.5293293, 18.0904758], [50.5293377, 18.0904809], [50.5293461, 18.0904862], [50.5293544, 18.0904914], [50.5293627, 18.0904969], [50.529371, 18.0905024], [50.5293792, 18.0905081], [50.5293875, 18.0905137], [50.5293957, 18.0905194], [50.5294039, 18.0905252], [50.5294121, 18.090531], [50.5294203, 18.0905369], [50.5294284, 18.0905428], [50.5294366, 18.0905487], [50.5294448, 18.0905546], [50.529453, 18.0905605], [50.5294611, 18.0905665], [50.5294693, 18.0905724], [50.5294775, 18.0905783], [50.5294856, 18.0905841], [50.5294938, 18.09059], [50.529502, 18.0905958], [50.5295102, 18.0906017], [50.5295184, 18.0906076], [50.5295265, 18.0906136], [50.5295347, 18.0906194], [50.5295429, 18.0906253], [50.5295511, 18.0906312], [50.5295592, 18.090637], [50.5295674, 18.0906429], [50.5295756, 18.0906487], [50.5295838, 18.0906546], [50.529592, 18.0906604], [50.5296002, 18.0906662], [50.5296084, 18.090672], [50.5296166, 18.0906778], [50.5296248, 18.0906836], [50.529633, 18.0906894], [50.5296412, 18.0906952], [50.5296494, 18.090701], [50.5296576, 18.0907068], [50.5296658, 18.0907126], [50.529674, 18.0907183], [50.5296822, 18.0907241], [50.5296904, 18.0907299], [50.5296986, 18.0907357], [50.5297068, 18.0907415], [50.5297151, 18.0907472], [50.5297233, 18.090753], [50.5297315, 18.0907587], [50.5297397, 18.0907644], [50.5297479, 18.0907702], [50.5297561, 18.090776], [50.5297644, 18.0907817], [50.5297726, 18.0907873], [50.5297808, 18.090793], [50.5297891, 18.0907987], [50.5297973, 18.0908044], [50.5298055, 18.0908101], [50.5298138, 18.0908157], [50.529822, 18.0908214], [50.5298303, 18.090827], [50.5298385, 18.0908326], [50.5298468, 18.0908382], [50.529855, 18.0908438], [50.5298633, 18.0908494], [50.5298716, 18.090855], [50.5298798, 18.0908605], [50.5298881, 18.0908661], [50.5298964, 18.0908717], [50.5299046, 18.0908772], [50.5299129, 18.0908828], [50.5299212, 18.0908883], [50.5299294, 18.0908939], [50.5299377, 18.0908994], [50.529946, 18.0909049], [50.5299543, 18.0909104], [50.5299626, 18.0909159], [50.5299708, 18.0909214], [50.5299791, 18.090927], [50.5299874, 18.0909324], [50.5299957, 18.0909379], [50.530004, 18.0909435], [50.5300122, 18.090949], [50.5300205, 18.0909545], [50.5300288, 18.0909601], [50.530037, 18.0909657], [50.5300453, 18.0909713], [50.5300535, 18.090977], [50.5300618, 18.0909826], [50.53007, 18.0909882], [50.5300783, 18.0909939], [50.5300865, 18.0909997], [50.5300947, 18.0910054], [50.5301029, 18.0910112], [50.5301111, 18.0910169], [50.5301193, 18.0910227], [50.5301275, 18.0910286], [50.5301357, 18.0910344], [50.5301439, 18.0910404], [50.530152, 18.0910465], [50.5301601, 18.0910526], [50.5301682, 18.0910588], [50.5301762, 18.0910652], [50.5301842, 18.0910717], [50.5301921, 18.0910784], [50.5302, 18.0910851], [50.5302078, 18.0910922], [50.5302155, 18.0910994], [50.5302231, 18.0911069], [50.5302307, 18.0911145], [50.5302382, 18.0911224], [50.5302456, 18.0911304], [50.5302528, 18.0911388], [50.53026, 18.0911473], [50.5302669, 18.0911563], [50.5302738, 18.0911654], [50.5302805, 18.0911749], [50.530287, 18.0911845], [50.5302933, 18.0911946], [50.5302995, 18.0912049], [50.5303055, 18.0912154], [50.5303112, 18.0912262], [50.5303168, 18.0912373], [50.530322, 18.0912488], [50.5303272, 18.0912604], [50.5303319, 18.0912724], [50.5303366, 18.0912844], [50.5303408, 18.0912968], [50.530345, 18.0913094], [50.5303487, 18.0913223], [50.5303521, 18.0913352], [50.5303553, 18.0913485], [50.5303581, 18.0913619], [50.5303607, 18.0913754], [50.5303629, 18.0913891], [50.5303649, 18.0914028], [50.5303664, 18.0914167], [50.5303678, 18.0914307], [50.5303687, 18.0914447], [50.5303695, 18.0914588], [50.5303697, 18.0914729], [50.5303699, 18.091487], [50.5303697, 18.0915011], [50.5303692, 18.0915152], [50.5303684, 18.0915292], [50.5303672, 18.0915432], [50.5303658, 18.0915571], [50.5303641, 18.091571], [50.5303622, 18.0915848], [50.5303599, 18.0915984], [50.5303575, 18.091612], [50.5303546, 18.0916254], [50.5303517, 18.0916388], [50.5303484, 18.0916519], [50.530345, 18.091665], [50.5303413, 18.0916778], [50.5303375, 18.0916906], [50.5303334, 18.0917031], [50.5303291, 18.0917155], [50.5303246, 18.0917278], [50.5303199, 18.0917398], [50.5303151, 18.0917517], [50.5303101, 18.0917634], [50.5303049, 18.091775], [50.5302996, 18.0917864], [50.5302942, 18.0917976], [50.5302885, 18.0918086], [50.5302828, 18.0918195], [50.5302769, 18.0918302], [50.530271, 18.0918408], [50.5302649, 18.0918511], [50.5302587, 18.0918614], [50.5302523, 18.0918714], [50.5302459, 18.0918813], [50.5302394, 18.0918911], [50.5302329, 18.0919008], [50.5302263, 18.0919103], [50.5302196, 18.0919198], [50.530213, 18.0919293], [50.5302062, 18.0919386], [50.5301994, 18.0919479], [50.5301925, 18.091957], [50.5301856, 18.0919659], [50.5301787, 18.091975], [50.5301718, 18.091984], [50.5301648, 18.091993], [50.5301579, 18.0920019], [50.5301509, 18.0920109], [50.530144, 18.0920198], [50.530137, 18.0920287], [50.53013, 18.0920376], [50.530123, 18.0920464], [50.5301159, 18.0920552], [50.5301089, 18.092064], [50.5301019, 18.0920728], [50.5300948, 18.0920816], [50.5300878, 18.0920905], [50.5300808, 18.0920993], [50.5300738, 18.0921081], [50.5300667, 18.0921168], [50.5300596, 18.0921256], [50.5300526, 18.0921343], [50.5300455, 18.0921431], [50.5300385, 18.0921518], [50.5300314, 18.0921605], [50.5300244, 18.0921693], [50.5300173, 18.0921781], [50.5300102, 18.0921867], [50.5300031, 18.0921954], [50.529996, 18.092204], [50.5299888, 18.0922125], [50.5299817, 18.0922211], [50.5299745, 18.0922297], [50.5299674, 18.0922383], [50.5299602, 18.0922468], [50.5299531, 18.0922553], [50.5299459, 18.0922639], [50.5299388, 18.0922725], [50.5299316, 18.092281], [50.5299244, 18.0922895], [50.5299172, 18.092298], [50.5299101, 18.0923065], [50.5299029, 18.092315], [50.5298957, 18.0923235], [50.5298885, 18.092332], [50.5298813, 18.0923405], [50.5298742, 18.0923491], [50.529867, 18.0923576], [50.5298599, 18.0923661], [50.5298527, 18.0923746], [50.5298455, 18.0923831], [50.5298383, 18.0923916], [50.5298311, 18.0924001], [50.529824, 18.0924087], [50.5298168, 18.0924172], [50.5298096, 18.0924257], [50.5298025, 18.0924342], [50.5297953, 18.0924428], [50.5297881, 18.0924512], [50.5297809, 18.0924597], [50.5297737, 18.0924683], [50.5297666, 18.0924768], [50.5297594, 18.0924853], [50.5297522, 18.0924938], [50.529745, 18.0925023], [50.5297378, 18.0925108], [50.5297307, 18.0925194], [50.5297235, 18.0925279], [50.5297164, 18.0925364], [50.5297092, 18.0925448], [50.529702, 18.0925533], [50.5296948, 18.0925619], [50.5296877, 18.0925704], [50.5296805, 18.092579], [50.5296734, 18.0925876], [50.5296662, 18.0925961], [50.529659, 18.0926046], [50.5296518, 18.0926131], [50.5296447, 18.0926216], [50.5296375, 18.0926302], [50.5296304, 18.0926389], [50.5296233, 18.0926475], [50.5296162, 18.0926562], [50.5296091, 18.0926649], [50.5296021, 18.0926736], [50.529595, 18.0926824], [50.529588, 18.0926912], [50.529581, 18.0927001], [50.529574, 18.092709], [50.5295671, 18.0927181], [50.5295603, 18.0927271], [50.5295534, 18.0927363], [50.5295466, 18.0927455], [50.5295399, 18.0927549], [50.5295331, 18.0927643], [50.5295265, 18.0927738], [50.5295198, 18.0927833], [50.5295133, 18.092793], [50.5295068, 18.0928027], [50.5295003, 18.0928125], [50.5294939, 18.0928223], [50.5294876, 18.0928324], [50.5294813, 18.0928426], [50.5294752, 18.0928529], [50.5294691, 18.0928633], [50.5294632, 18.0928739], [50.5294573, 18.0928846], [50.5294515, 18.0928954], [50.5294458, 18.0929063], [50.5294403, 18.0929174], [50.5294348, 18.0929286], [50.5294295, 18.09294], [50.5294242, 18.0929515], [50.5294191, 18.0929631], [50.5294141, 18.0929747], [50.5294092, 18.0929866], [50.5294044, 18.0929985], [50.5293998, 18.0930107], [50.5293954, 18.093023], [50.5293911, 18.0930354], [50.529387, 18.0930479], [50.529383, 18.0930606], [50.5293792, 18.0930734], [50.5293756, 18.0930863], [50.5293722, 18.0930994], [50.529369, 18.0931125], [50.5293659, 18.0931258], [50.529363, 18.0931392], [50.5293604, 18.0931526], [50.529358, 18.0931662], [50.5293557, 18.0931799], [50.5293537, 18.0931937], [50.5293519, 18.0932075], [50.5293503, 18.0932214], [50.529349, 18.0932353], [50.5293479, 18.0932493], [50.529347, 18.0932634], [50.5293464, 18.0932774], [50.5293459, 18.0932915], [50.5293458, 18.0933057], [50.5293457, 18.0933198], [50.529346, 18.0933339], [50.5293465, 18.093348], [50.5293473, 18.093362], [50.5293482, 18.093376], [50.5293494, 18.09339], [50.5293508, 18.093404], [50.5293525, 18.0934178], [50.5293543, 18.0934316], [50.5293566, 18.0934453], [50.529359, 18.0934589], [50.5293618, 18.0934723], [50.5293646, 18.0934857], [50.5293679, 18.0934988], [50.5293713, 18.0935119], [50.5293751, 18.0935247], [50.5293789, 18.0935375], [50.5293832, 18.0935498], [50.5293876, 18.0935622], [50.5293923, 18.0935742], [50.5293971, 18.0935862], [50.5294023, 18.0935977], [50.5294075, 18.0936092], [50.529413, 18.0936203], [50.5294186, 18.0936314], [50.5294245, 18.093642], [50.5294304, 18.0936527], [50.5294366, 18.0936629], [50.5294429, 18.093673], [50.5294494, 18.0936827], [50.5294559, 18.0936924], [50.5294628, 18.0937016], [50.5294696, 18.0937108], [50.5294767, 18.0937194], [50.5294839, 18.093728], [50.5294912, 18.0937362], [50.5294985, 18.0937443], [50.5295061, 18.093752], [50.5295137, 18.0937596], [50.5295213, 18.093767], [50.529529, 18.0937744], [50.5295367, 18.0937817], [50.5295444, 18.0937889], [50.5295523, 18.0937958], [50.5295601, 18.0938026], [50.5295681, 18.0938093], [50.529576, 18.093816], [50.529584, 18.0938225], [50.529592, 18.093829], [50.5296, 18.0938352], [50.5296081, 18.0938415], [50.5296162, 18.0938476], [50.5296243, 18.0938538], [50.5296324, 18.0938599], [50.5296405, 18.093866], [50.5296487, 18.0938719], [50.5296568, 18.0938778], [50.529665, 18.0938837], [50.5296732, 18.0938896], [50.5296814, 18.0938954], [50.5296896, 18.0939012], [50.5296978, 18.093907], [50.529706, 18.0939129], [50.5297142, 18.0939187], [50.5297224, 18.0939245], [50.5297306, 18.0939302], [50.5297388, 18.093936], [50.529747, 18.0939419], [50.5297552, 18.0939477], [50.5297633, 18.0939538], [50.5297714, 18.0939599], [50.5297794, 18.0939662], [50.5297875, 18.0939726], [50.5297954, 18.0939792], [50.5298033, 18.0939859], [50.5298111, 18.093993], [50.5298188, 18.0940002], [50.5298264, 18.0940077], [50.5298339, 18.0940156], [50.5298413, 18.0940236], [50.5298485, 18.094032], [50.5298557, 18.0940406], [50.5298626, 18.0940496], [50.5298694, 18.0940588], [50.5298759, 18.0940686], [50.5298822, 18.0940786], [50.5298882, 18.0940891], [50.5298941, 18.0940998], [50.5298996, 18.094111], [50.529905, 18.0941223], [50.5299099, 18.0941341], [50.5299145, 18.0941462], [50.5299188, 18.0941586], [50.5299227, 18.0941713], [50.5299263, 18.0941842], [50.5299296, 18.0941974], [50.5299325, 18.0942107], [50.5299348, 18.0942243], [50.529937, 18.094238], [50.5299385, 18.0942519], [50.5299399, 18.0942659], [50.5299407, 18.0942799], [50.5299411, 18.094294], [50.5299408, 18.0943081], [50.5299404, 18.0943222], [50.5299401, 18.0943363], [50.5299391, 18.0943503], [50.5299378, 18.0943643], [50.5299359, 18.0943781], [50.5299339, 18.0943918], [50.5299313, 18.0944054], [50.5299287, 18.0944189], [50.5299257, 18.0944321], [50.5299225, 18.0944454], [50.5299192, 18.0944585], [50.5299157, 18.0944715], [50.5299118, 18.0944842], [50.529908, 18.094497], [50.529904, 18.0945096], [50.5298999, 18.0945222], [50.5298957, 18.0945347], [50.5298915, 18.0945471], [50.5298871, 18.0945595], [50.5298827, 18.0945718], [50.5298782, 18.094584], [50.5298737, 18.0945962], [50.5298691, 18.0946083], [50.5298645, 18.0946204], [50.5298598, 18.0946325], [50.5298551, 18.0946445], [50.5298504, 18.0946565], [50.5298456, 18.0946685], [50.5298408, 18.0946805], [50.5298361, 18.0946924], [50.5298313, 18.0947044], [50.5298265, 18.0947163], [50.5298216, 18.0947282], [50.5298168, 18.0947401], [50.5298119, 18.0947519], [50.529807, 18.0947638], [50.5298021, 18.0947756], [50.5297972, 18.0947874], [50.5297923, 18.0947993], [50.5297873, 18.0948111], [50.5297824, 18.0948229], [50.5297775, 18.0948347], [50.5297726, 18.0948465], [50.5297676, 18.0948583], [50.5297627, 18.09487], [50.5297577, 18.0948818], [50.5297527, 18.0948935], [50.5297477, 18.0949053], [50.5297427, 18.094917], [50.5297377, 18.0949287], [50.5297327, 18.0949404], [50.5297276, 18.0949522], [50.5297227, 18.0949639], [50.5297177, 18.0949757], [50.5297127, 18.0949874], [50.5297077, 18.0949991], [50.5297027, 18.0950109], [50.5296977, 18.0950226], [50.5296928, 18.0950344], [50.5296878, 18.0950462], [50.5296828, 18.095058], [50.5296778, 18.0950697], [50.5296729, 18.0950814], [50.5296679, 18.0950932], [50.5296629, 18.095105], [50.529658, 18.0951167], [50.529653, 18.0951285], [50.529648, 18.0951402], [50.529643, 18.095152], [50.529638, 18.0951637], [50.529633, 18.0951754], [50.5296279, 18.0951871], [50.529623, 18.0951988], [50.529618, 18.0952106], [50.529613, 18.0952224], [50.529608, 18.0952341], [50.529603, 18.0952458], [50.529598, 18.0952575], [50.529593, 18.0952692], [50.529588, 18.095281], [50.5295829, 18.0952927], [50.5295779, 18.0953044], [50.5295729, 18.0953161], [50.5295679, 18.0953278], [50.5295628, 18.0953395], [50.5295578, 18.0953512], [50.5295528, 18.0953629], [50.5295478, 18.0953746], [50.5295427, 18.0953863], [50.5295377, 18.095398], [50.5295327, 18.0954097], [50.5295276, 18.0954214], [50.5295226, 18.0954331], [50.5295176, 18.0954448], [50.5295125, 18.0954565], [50.5295075, 18.0954682], [50.5295025, 18.09548], [50.5294975, 18.0954917], [50.5294925, 18.0955034], [50.5294875, 18.0955151], [50.5294825, 18.0955268], [50.5294775, 18.0955386], [50.5294725, 18.0955503], [50.5294675, 18.095562], [50.5294625, 18.0955738], [50.5294575, 18.0955855], [50.5294525, 18.0955972], [50.5294475, 18.095609], [50.5294425, 18.0956207], [50.5294375, 18.0956325], [50.5294325, 18.0956442], [50.5294275, 18.0956558], [50.5294224, 18.0956675], [50.5294174, 18.0956792], [50.5294123, 18.0956909], [50.5294073, 18.0957026], [50.5294023, 18.0957144], [50.5293973, 18.0957261], [50.5293923, 18.0957378], [50.5293873, 18.0957496], [50.5293823, 18.0957613], [50.5293773, 18.0957731], [50.5293724, 18.0957848], [50.5293674, 18.0957966], [50.5293624, 18.0958083], [50.5293575, 18.0958201], [50.5293525, 18.0958319], [50.5293476, 18.0958437], [50.5293427, 18.0958555], [50.5293377, 18.0958673], [50.5293328, 18.0958791], [50.5293279, 18.0958909], [50.529323, 18.0959028], [50.5293181, 18.0959146], [50.5293132, 18.0959264], [50.5293083, 18.0959383], [50.5293034, 18.0959501], [50.5292985, 18.0959619], [50.5292936, 18.0959738], [50.5292887, 18.0959856], [50.5292838, 18.0959974], [50.5292789, 18.0960093], [50.5292758, 18.0960167]
    ];

    let raceMap;
    let raceMarker;

    const initRaceMap = () => {
        if (raceMapInitialized) return;
        const raceMapContainer = document.getElementById('race-map');
        if (!raceMapContainer || !window.L) return;

        const trackLatLngs = trackData.map(point => [point[0], point[1]]);
        raceMap = L.map(raceMapContainer, {
            zoomControl: false,
            scrollWheelZoom: false,
            doubleClickZoom: false,
            touchZoom: false,
            boxZoom: false,
            keyboard: false,
            dragging: false
        }).fitBounds(L.latLngBounds(trackLatLngs), { padding: [8, 8], maxZoom: 17 });

        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
            subdomains: 'abcd',
            maxZoom: 20
        }).addTo(raceMap);

        L.polyline(trackLatLngs, { color: '#00000033', weight: 24, lineCap: 'round', lineJoin: 'round' }).addTo(raceMap);
        L.polyline(trackLatLngs, { color: '#888', weight: 18, lineCap: 'round', lineJoin: 'round' }).addTo(raceMap);
        L.polyline(trackLatLngs, { color: '#555', weight: 14, lineCap: 'round', lineJoin: 'round' }).addTo(raceMap);
        window.dashTrackLine = L.polyline(trackLatLngs, { color: '#fff', weight: 1.5, opacity: 0.4, dashArray: '8 10', lineCap: 'square' }).addTo(raceMap);

        window.strategyPolylines = [];
        window.drawStrategyOnMap = () => {
            if (!raceMapInitialized || !window.strategyDataList || !raceMap) return;

            // Clean up old ones
            window.strategyPolylines.forEach(pl => raceMap.removeLayer(pl));
            window.strategyPolylines = [];

            if (window.dashTrackLine) { raceMap.removeLayer(window.dashTrackLine); }

            const R = 6371000;
            const getDistance = (p1, p2) => {
                const dLat = (p2[0] - p1[0]) * Math.PI / 180;
                const dLon = (p2[1] - p1[1]) * Math.PI / 180;
                const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(p1[0] * Math.PI / 180) * Math.cos(p2[0] * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
                return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            };

            const getEylemAtDist = (dist) => {
                for (let i = 0; i < window.strategyDataList.length; i++) {
                    let rowDist = parseFloat(window.strategyDataList[i]['Baslangic_Metresi (m)'] || window.strategyDataList[i]['Mesafe (m)'] || window.strategyDataList[i]['Mesafe'] || 0);
                    let nextDist = (i < window.strategyDataList.length - 1)
                        ? parseFloat(window.strategyDataList[i + 1]['Baslangic_Metresi (m)'] || window.strategyDataList[i + 1]['Mesafe (m)'] || window.strategyDataList[i + 1]['Mesafe'] || Infinity)
                        : Infinity;
                    if (dist >= rowDist && dist < nextDist) {
                        return window.strategyDataList[i]['Eylem'] || window.strategyDataList[i]['Action'] || '';
                    }
                }
                return '';
            };

            let currentDist = 0;
            let currentSegmentPts = [[trackData[0][0], trackData[0][1]]];
            let currentEylem = getEylemAtDist(0).toUpperCase();

            for (let i = 0; i < trackData.length - 1; i++) {
                let p1 = trackData[i];
                let p2 = trackData[i + 1];
                let segDist = getDistance(p1, p2);
                currentDist += segDist;

                let eylem = getEylemAtDist(currentDist).toUpperCase();

                let isEylemChanged = false;
                let isBurn1 = currentEylem.includes('GAZLA') || currentEylem.includes('BURN');
                let isBurn2 = eylem.includes('GAZLA') || eylem.includes('BURN');
                let isCoast1 = currentEylem.includes('SUZUL') || currentEylem.includes('COAST') || currentEylem.includes('SÜZÜL');
                let isCoast2 = eylem.includes('SUZUL') || eylem.includes('COAST') || eylem.includes('SÜZÜL');

                if (isBurn1 !== isBurn2 || isCoast1 !== isCoast2) {
                    isEylemChanged = true;
                }

                currentSegmentPts.push([p2[0], p2[1]]);

                if (isEylemChanged || i === trackData.length - 2) {
                    let color = '#555';
                    if (isBurn1) color = '#ef4444'; // Red
                    else if (isCoast1) color = '#3b82f6'; // Blue

                    let pl = L.polyline(currentSegmentPts, { color: color, weight: 14, lineCap: 'round', lineJoin: 'round' }).addTo(raceMap);
                    window.strategyPolylines.push(pl);

                    currentSegmentPts = [[p2[0], p2[1]]];
                    currentEylem = eylem;
                }
            }

            window.dashTrackLine = L.polyline(trackLatLngs, { color: '#fff', weight: 1.5, opacity: 0.4, dashArray: '8 10', lineCap: 'square' }).addTo(raceMap);
        };

        const arrowIcon = L.divIcon({
            className: 'custom-div-icon',
            html: `<div id="race-map-arrow" style="transform: rotate(0deg); font-size: 24px; color: black; text-shadow: 0 0 5px white;">➤</div>`,
            iconSize: [24, 24],
            iconAnchor: [12, 12]
        });

        raceMarker = L.marker([trackData[0][0], trackData[0][1]], { icon: arrowIcon }).addTo(raceMap);

        // RL / DP Optimizasyonu'na göre hesaplanan zaman etiketleri (Toplam Tur: ~3:33)
        const markersData = [
            { idx: Math.floor(trackData.length * 0.25), time: "0:54" },
            { idx: Math.floor(trackData.length * 0.50), time: "1:47" },
            { idx: Math.floor(trackData.length * 0.75), time: "2:41" },
            { idx: Math.floor(trackData.length * 0.95), time: "3:23" }
        ];

        markersData.forEach(m => {
            const pt = trackData[m.idx];
            if (pt) {
                const icon = L.divIcon({
                    className: 'custom-time-marker',
                    html: `
                        <div class="time-marker-wrapper">
                            <div class="time-marker-dot"></div>
                            <div class="time-marker-label">${m.time}</div>
                        </div>
                    `,
                    iconSize: [12, 12],
                    iconAnchor: [6, 6]
                });
                L.marker([pt[0], pt[1]], { icon: icon }).addTo(raceMap);
            }
        });

        raceMapInitialized = true;
    };

    // Strateji harita ve mesafe izleme için önceki koordinatlar
    let prevStratLat = 0, prevStratLon = 0;
    let cumulativeDistM = 0;

    const updateStrategyUI = (data) => {

        // speed UI
        const spdVal = document.getElementById('strat-speed-val');
        const spdTarget = document.getElementById('strat-speed-target');
        const spdIcon = document.getElementById('strat-speed-icon');

        if (spdVal && spdTarget && spdIcon) {
            if (data.speed !== undefined) spdVal.textContent = data.speed.toFixed(1);
            if (data.targetSpeed !== undefined) spdTarget.textContent = data.targetSpeed.toFixed(1);

            const s = parseFloat(spdVal.textContent) || 0;
            const t = parseFloat(spdTarget.textContent) || 0;

            spdVal.className = '';
            spdIcon.className = 'dir-icon';
            if (s < t) {
                spdVal.classList.add('text-yellow');
                spdIcon.classList.add('text-yellow');
                spdIcon.textContent = '↑';
            } else if (s > t) {
                spdVal.classList.add('text-red');
                spdIcon.classList.add('text-red');
                spdIcon.textContent = '↓';
            } else {
                spdVal.classList.add('text-green');
                spdIcon.classList.add('text-green');
                spdIcon.textContent = '-';
            }
        }

        // Wh UI
        const whVal = document.getElementById('strat-wh-val');
        const whTarget = document.getElementById('strat-wh-target');
        if (whVal && whTarget) {
            if (data.wh !== undefined) whVal.textContent = data.wh.toFixed(2);
            if (data.targetWh !== undefined) whTarget.textContent = data.targetWh.toFixed(2);

            const w = parseFloat(whVal.textContent) || 0;
            const tw = parseFloat(whTarget.textContent) || 0;

            whVal.className = 'text-white';
            if (w > tw) {
                whVal.classList.add('text-red');
            } else if (w < tw) {
                whVal.classList.add('text-green');
            }
        }

        const fuelCellEfficiency = 0.50;
        const energyPerGram = 33.32 * fuelCellEfficiency;
        const litersPerGram = 11.12;
        // MATLAB'den gelen veya ana veriden gelen data.wh kullanılıyor
        const consumedH2Liters = (data.wh / energyPerGram) * litersPerGram;

        const stratH2Val = document.getElementById('strat-h2-val');
        if (stratH2Val) {
            if (data.wh !== undefined && !isNaN(data.wh)) {
                stratH2Val.textContent = consumedH2Liters.toFixed(2);
            }

            // Hedef Wh aşıldıysa Litre rengini kırmızı yapma
            const w = parseFloat(document.getElementById('strat-wh-val')?.textContent) || 0;
            const tw = parseFloat(document.getElementById('strat-wh-target')?.textContent) || 0;
            if (w > tw && tw > 0) {
                stratH2Val.classList.add('text-red');
                stratH2Val.classList.remove('text-white');
            } else {
                stratH2Val.classList.add('text-white');
                stratH2Val.classList.remove('text-red');
            }
        }

        // Lap counter & Timers
        const lapVal = document.getElementById('lap-val');
        if (lapVal && data.lap) {
            lapVal.textContent = data.lap;

            // "1/11" formatından sadece "1" rakamını al
            let lapNum = parseInt(data.lap.split('/')[0]);

            // Eğer sayaçlar hiç başlamadıysa (İlk Veri)
            if (currentLapTracker === 0 && lapNum > 0) {
                totalStartTime = Date.now();
                lapStartTime = Date.now();
                currentLapTracker = lapNum;
                // localStorage'a kaydet — sayfa yenilenince sıfırlanmasın
                localStorage.setItem('race_totalStartTime', String(totalStartTime));
                localStorage.setItem('race_lapStartTime', String(lapStartTime));
                localStorage.setItem('race_currentLapTracker', String(currentLapTracker));
                startTimers();
            }
            // MATlAB'den "YENİ TUR" bilgisi geldiyse
            else if (lapNum > currentLapTracker) {
                lapStartTime = Date.now(); // Lap süresini SIFIRLA
                currentLapTracker = lapNum; // Yeni turu kaydet
                // Güncel değerleri kaydet
                localStorage.setItem('race_lapStartTime', String(lapStartTime));
                localStorage.setItem('race_currentLapTracker', String(currentLapTracker));

                // Havalı bir CSS parlaması efekti
                document.getElementById('lap-time-val').style.color = '#fff';
                setTimeout(() => document.getElementById('lap-time-val').style.color = '#eab308', 500);
            }
        }

        // Harita ok yönü ve konum güncellemesi
        if (raceMapInitialized && raceMarker && data.lat && data.lon) {
            const newLatLng = new L.LatLng(data.lat, data.lon);
            raceMarker.setLatLng(newLatLng);

            // Açı hesapla: önceki koordinatlardan yön bul
            let headingAngle = data.angle; // MATLAB gönderdiyse onu kullan
            if (headingAngle === undefined && prevStratLat !== 0 && prevStratLon !== 0) {
                // GPS noktalarından bearing hesapla
                const dy = data.lat - prevStratLat;
                const dx = Math.cos(Math.PI / 180 * prevStratLat) * (data.lon - prevStratLon);
                if (Math.abs(dy) > 1e-8 || Math.abs(dx) > 1e-8) {
                    headingAngle = Math.atan2(dy, dx) * (180 / Math.PI);
                    headingAngle = (90 - headingAngle + 360) % 360;
                }
            }
            if (headingAngle !== undefined) {
                const arrow = document.getElementById('race-map-arrow');
                if (arrow) arrow.style.transform = `rotate(${headingAngle - 90}deg)`;
            }

            // Kümülatif mesafe hesapla (MATLAB distance yoksa)
            if (data.distance !== undefined) {
                cumulativeDistM = parseFloat(data.distance);
            } else if (prevStratLat !== 0 && prevStratLon !== 0) {
                const R = 6371000;
                const dLat = (data.lat - prevStratLat) * Math.PI / 180;
                const dLon = (data.lon - prevStratLon) * Math.PI / 180;
                const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                    Math.cos(prevStratLat * Math.PI / 180) * Math.cos(data.lat * Math.PI / 180) *
                    Math.sin(dLon / 2) * Math.sin(dLon / 2);
                cumulativeDistM += R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            }
            prevStratLat = data.lat;
            prevStratLon = data.lon;
        }

        const targetSpdEl = document.getElementById('target-spd-val');
        if (targetSpdEl && data.targetSpeed !== undefined) {
            targetSpdEl.textContent = `Hedef: ${parseFloat(data.targetSpeed).toFixed(1)}`;
        }

        const targetWhEl = document.getElementById('target-wh-val');
        if (targetWhEl && data.targetWh !== undefined) {
            targetWhEl.textContent = `Hedef: ${parseFloat(data.targetWh).toFixed(2)}`;
        }

        // 4. Aktif Satırı Canlı Vurgulama
        // MATLAB distance veya frontend hesaplı mesafeyi kullan
        const effectiveDist = (data.distance !== undefined) ? parseFloat(data.distance) : cumulativeDistM;
        if (effectiveDist > 0 && window.strategyDataList && window.strategyDataList.length > 0) {
            // Pist uzunluğunu al ve mesafeyi modüler yap (çoklu tur desteği)
            const lastRow = window.strategyDataList[window.strategyDataList.length - 1];
            const trackLen = parseFloat(lastRow['Bitis_Metresi (m)'] || lastRow['Mesafe (m)'] || 1500);
            const lapDist = effectiveDist % trackLen;

            const tableRows = document.querySelectorAll('#strategy-table-body tr');

            tableRows.forEach(row => {
                row.classList.remove('row-active');
            });

            for (let i = 0; i < window.strategyDataList.length; i++) {
                let rowDist = parseFloat(window.strategyDataList[i]['Baslangic_Metresi (m)'] || window.strategyDataList[i]['Mesafe (m)'] || window.strategyDataList[i]['Mesafe'] || 0);
                let nextDist = (i < window.strategyDataList.length - 1)
                    ? parseFloat(window.strategyDataList[i + 1]['Baslangic_Metresi (m)'] || window.strategyDataList[i + 1]['Mesafe (m)'] || window.strategyDataList[i + 1]['Mesafe'] || Infinity)
                    : Infinity;

                if (lapDist >= rowDist && lapDist < nextDist) {
                    if (tableRows[i]) {
                        tableRows[i].classList.add('row-active');
                        // Sadece odak modu açıksa otomatik kaydır
                        if (window.isStrategyFocusEnabled !== false) {
                            const scrollContainer = tableRows[i].closest('.table-scroll');
                            if (scrollContainer) {
                                // tableRows[i].offsetTop is relative to the table body/parent.
                                // It already represents the vertical distance from the top of the scrollable content.
                                const rowTop = tableRows[i].offsetTop;
                                const scrollTarget = rowTop - scrollContainer.clientHeight / 2 + tableRows[i].clientHeight / 2;
                                scrollContainer.scrollTo({ top: scrollTarget, behavior: 'smooth' });
                            }
                        }
                    }
                    break;
                }
            }
        }

    };

    // attach to window to be accessible from main socket listener if needed
    window.updateStrategyUI = updateStrategyUI;

    const isRacePage = () => new URLSearchParams(window.location.search).get('page') === 'race';
    const updateView = (race) => {
        if (!panel || !dashboard || !btnOpen) return;
        panel.classList.toggle('hidden', !race);
        dashboard.classList.toggle('hidden', race);

        const lapContainer = document.getElementById('lap-counter-container');
        if (lapContainer) lapContainer.classList.toggle('hidden', !race);

        btnOpen.textContent = race ? 'Anasayfa' : 'Race Strategy';
        if (pageHeading) pageHeading.textContent = race ? 'Race Strategy' : 'Telemetri Dashboard';
        document.title = race ? 'Race Strategy - Telemetri Dashboard' : 'Telemetri Dashboard';
        if (race) {
            initRaceMap();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    };

    const goToRacePage = () => {
        const url = `${window.location.origin}${window.location.pathname}?page=race`;
        window.open(url, '_blank');
    };

    const goToHomePage = () => {
        window.location.href = `${window.location.origin}${window.location.pathname}`;
    };

    btnOpen?.addEventListener('click', () => {
        if (isRacePage()) {
            goToHomePage();
        } else {
            goToRacePage();
        }
    });



    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && isRacePage()) {
            goToHomePage();
        }
    });

    // Sayaç sıfırlama butonu
    document.getElementById('btn-reset-timer')?.addEventListener('click', () => {
        if (confirm('Sayaç ve tur bilgisi sıfırlansın mı?')) {
            resetTimers();
        }
    });

    updateView(isRacePage());

    if (isRacePage()) {
        loadStrategyCSV();
        //fetchLastStrategy(); // Sayfa yenilenince son MATLAB verisini geri yükle
        restoreTimerState(); // Sayfa yenilenince sayaçları kaldığı yerden devam ettir
    }
}

// --- SİMÜLASYON YÖNETİMİ ---
function setupSimulation() {
    const modal = document.getElementById('sim-modal');
    const openBtn = document.getElementById('sim-open-btn');
    const closeBtn = document.getElementById('sim-modal-close');
    const fileList = document.getElementById('sim-file-list');
    const startBtn = document.getElementById('sim-start-btn');
    const stopBtn = document.getElementById('sim-stop-btn');
    const progressArea = document.getElementById('sim-progress-area');
    const progressBar = document.getElementById('sim-progress-bar');
    const progressPct = document.getElementById('sim-progress-pct');
    const progressLbl = document.getElementById('sim-progress-label');
    const speedBtns = document.querySelectorAll('.sim-speed-btn');

    if (!modal) return;

    let selectedFile = null;
    let selectedSpeed = 1;
    let simRunning = false;

    // Hız butonu seçimi
    speedBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            speedBtns.forEach(b => {
                b.style.background = 'var(--bg-main)';
                b.style.borderColor = 'var(--border-color)';
                b.style.color = 'var(--text-muted)';
            });
            btn.style.background = 'rgba(168,85,247,0.2)';
            btn.style.borderColor = '#a855f7';
            btn.style.color = '#a855f7';
            selectedSpeed = parseFloat(btn.dataset.speed);
        });
    });

    // Modalı aç ve dosya listesini yükle
    openBtn?.addEventListener('click', async () => {
        modal.style.display = 'flex';
        await loadFileList();
    });

    // Modalı kapat
    closeBtn?.addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });

    async function loadFileList() {
        fileList.innerHTML = '<div style="padding:16px; color:var(--text-muted); text-align:center; font-size:13px;">Yükleniyor...</div>';
        try {
            const res = await fetch('/api/v1/simulation/files');
            const data = await res.json();
            if (!data.ok || data.files.length === 0) {
                fileList.innerHTML = '<div style="padding:16px; color:#ef4444; text-align:center; font-size:13px;">⚠️ simulation_data/ klasöründe CSV bulunamadı.</div>';
                return;
            }
            fileList.innerHTML = '';
            data.files.forEach(fname => {
                const item = document.createElement('div');
                item.textContent = '📄 ' + fname;
                item.style.cssText = 'padding:12px 16px; cursor:pointer; font-size:13px; font-family:monospace; border-bottom:1px solid var(--border-color); color:var(--text-main); transition:background 0.15s;';
                item.addEventListener('mouseenter', () => item.style.background = 'var(--border-color)');
                item.addEventListener('mouseleave', () => {
                    item.style.background = selectedFile === fname ? 'rgba(168,85,247,0.15)' : 'transparent';
                });
                item.addEventListener('click', () => {
                    document.querySelectorAll('#sim-file-list div').forEach(d => d.style.background = 'transparent');
                    item.style.background = 'rgba(168,85,247,0.15)';
                    selectedFile = fname;
                    // Başlat butonunu aktif et
                    startBtn.style.opacity = '1';
                    startBtn.style.pointerEvents = 'auto';
                });
                fileList.appendChild(item);
            });
        } catch (e) {
            fileList.innerHTML = '<div style="padding:16px; color:#ef4444; text-align:center; font-size:13px;">⚠️ Sunucuya bağlanılamadı.</div>';
        }
    }

    // Simülasyonu başlat
    startBtn?.addEventListener('click', async () => {
        if (!selectedFile || simRunning) return;
        try {
            const res = await fetch('/api/v1/simulation/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file: selectedFile, speed: selectedSpeed })
            });
            const data = await res.json();
            if (!data.ok) { alert('Hata: ' + data.error); return; }
            simRunning = true;
            setSimRunningUI(true, 0, data.total);
        } catch (e) {
            alert('Simülasyon başlatılamadı: ' + e.message);
        }
    });

    // Simülasyonu durdur
    stopBtn?.addEventListener('click', async () => {
        await fetch('/api/v1/simulation/stop', { method: 'POST' });
        simRunning = false;
        setSimRunningUI(false, 0, 0);
    });

    // Sunucudan gelen ilerleme güncelleme
    const socket = window._simSocket || (function () {
        // Ana socket zaten DOMContentLoaded içinde kuruldu, ona erişmek için window üzerinden paylaşacağız
        return null;
    })();

    // Socket.IO simülasyon_status eventini dinle
    // (Ana socket listener DOMContentLoaded'da kuruldu, buradan erişemeyiz — bu yüzden global bir hook kullanıyoruz)
    window._onSimulationStatus = (data) => {
        if (data.finished) {
            simRunning = false;
            setSimRunningUI(false, data.total, data.total);
            progressLbl.textContent = '✅ Tamamlandı!';
            progressBar.style.background = '#22c55e';
            return;
        }
        if (data.running) {
            setSimRunningUI(true, data.row, data.total);
        }
    };

    function setSimRunningUI(running, row, total) {
        startBtn.classList.toggle('hidden', running);
        stopBtn.classList.toggle('hidden', !running);
        progressArea.style.display = running ? 'block' : 'none';
        if (running && total > 0) {
            const pct = Math.round((row / total) * 100);
            progressBar.style.width = pct + '%';
            progressBar.style.background = '#a855f7';
            progressPct.textContent = pct + '%';
            progressLbl.textContent = `Oynatılıyor... (${row} / ${total} satır)`;
        }
        // Butonu renk/stil güncelle
        openBtn.style.background = running ? 'rgba(239,68,68,0.15)' : 'rgba(168,85,247,0.15)';
        openBtn.style.borderColor = running ? '#ef4444' : '#a855f7';
        openBtn.style.color = running ? '#ef4444' : '#a855f7';
        openBtn.textContent = running ? '⏹ Simülasyon' : '▶ Simülasyon';
    }
}

// --- SAYAÇ VE STRATEJİ GERİ YÜKLEME (SAYFA YENİLEME SONRASI) ---

// localStorage'dan sayaç durumunu geri yükler ve kaldığı yerden devam ettirir
function restoreTimerState() {
    const savedTotal = parseInt(localStorage.getItem('race_totalStartTime') || '0', 10);
    const savedLap = parseInt(localStorage.getItem('race_lapStartTime') || '0', 10);
    const savedLapNum = parseInt(localStorage.getItem('race_currentLapTracker') || '0', 10);

    if (savedTotal > 0) {
        totalStartTime = savedTotal;
        lapStartTime = savedLap || savedTotal;
        currentLapTracker = savedLapNum;
        startTimers();
        console.log('[Timer] Kaldığı yerden devam ediyor — toplam başlangıç:', new Date(savedTotal).toLocaleTimeString());
    }
}

// Sunucudan en son MATLAB strateji verisini çeker (sayfa yenileme sonrası UI'ı doldurur)
async function fetchLastStrategy() {
    try {
        const response = await fetch('/api/v1/strategy');
        if (!response.ok) return;
        const result = await response.json();
        if (result.ok && result.data && typeof window.updateStrategyUI === 'function') {
            window.updateStrategyUI(result.data);
            console.log('[Strategy] Son MATLAB verisi sunucudan geri yüklendi.');
        }
    } catch (e) {
        // Sunucu henüz hazır değil veya veri yok — sessizce geç
    }
}

// --- 3. Kurşun Geçirmez CSV Okuyucu ---
window.strategyDataList = [];

async function loadStrategyCSV() {
    try {
        const response = await fetch('strategy/strategy_report.csv');
        if (!response.ok) {
            throw new Error('Dosya sunucuda yok');
        }

        const text = await response.text();
        // HTML hata sayfası dönmüş mü kontrolü
        if (text.trim().toLowerCase().startsWith('<!doctype html>') || text.includes('<html')) {
            throw new Error('Dosya yerine HTML hata sayfası döndü');
        }

        // Ayraç tespiti (, veya ;)
        const firstLine = text.split('\n')[0];
        const separator = firstLine.includes(';') ? ';' : ',';

        const lines = text.split('\n').filter(line => line.trim().length > 0);
        const headers = lines[0].split(separator).map(h => h.trim());

        const dataList = [];
        for (let i = 1; i < lines.length; i++) {
            const values = lines[i].split(separator).map(v => v.trim());
            if (values.length === headers.length || values.length > 1) {
                let obj = {};
                headers.forEach((header, index) => {
                    obj[header] = values[index] || '';
                });
                dataList.push(obj);
            }
        }

        window.strategyDataList = dataList;
        renderStrategyTable(dataList);
        if (typeof window.drawStrategyOnMap === 'function') {
            window.drawStrategyOnMap();
        }

    } catch (error) {
        console.warn('Strategy CSV yükleme hatası:', error.message);
        const tbody = document.getElementById('strategy-table-body');
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:#ef4444; padding:15px; font-weight:bold;">⚠️ Dosya bulunamadı: ${error.message}</td></tr>`;
        }
    }
}

function renderStrategyTable(dataList) {
    const thead = document.getElementById('strategy-table-head');
    const tbody = document.getElementById('strategy-table-body');
    if (!tbody) return;

    if (dataList.length > 0 && thead) {
        const headers = Object.keys(dataList[0]);
        let thHtml = '<tr>';
        headers.forEach(h => {
            thHtml += `<th>${h}</th>`;
        });
        thHtml += '</tr>';
        thead.innerHTML = thHtml;
    }

    tbody.innerHTML = '';

    dataList.forEach(row => {
        let tr = document.createElement('tr');

        let rowHtml = '';
        const headers = Object.keys(dataList[0]);
        headers.forEach(h => {
            let val = row[h] || '';
            const isEylem = h === 'Eylem' || h === 'Action';

            if (isEylem) {
                const eylemUpper = val.toUpperCase();
                if (eylemUpper.includes('GAZLA') || eylemUpper.includes('BURN')) {
                    val = `<span style="color: #ef4444; font-weight: bold;">${val}</span>`; // Red for Burn
                } else if (eylemUpper.includes('SUZUL') || eylemUpper.includes('COAST') || eylemUpper.includes('SÜZÜL')) {
                    val = `<span style="color: #3b82f6; font-weight: bold;">${val}</span>`; // Blue for Coast
                }
            } else if (!isNaN(parseFloat(val)) && val.trim() !== '') {
                val = parseFloat(val).toFixed(1);
            }
            rowHtml += `<td>${val}</td>`;
        });

        tr.innerHTML = rowHtml;
        tbody.appendChild(tr);
    });
}

// --- VERİ KAYNAĞI DEĞİŞTİRME ---
document.addEventListener('DOMContentLoaded', () => {
    const sourceBtn = document.getElementById('data-source-toggle');
    if (!sourceBtn) return;

    let currentMode = localStorage.getItem('raceDataSource') || 'sim';

    function updateButtonUI() {
        if (currentMode === 'live') {
            sourceBtn.innerHTML = '📡 Veri Kaynağı: Canlı (Araç)';
            sourceBtn.className = 'btn source-live';
        } else {
            sourceBtn.innerHTML = '💻 Veri Kaynağı: Simülasyon (MATLAB)';
            sourceBtn.className = 'btn source-sim';
        }
    }

    updateButtonUI();

    sourceBtn.addEventListener('click', () => {
        currentMode = (currentMode === 'sim') ? 'live' : 'sim';
