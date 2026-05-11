% MATLAB Strategy Integration - Final v6
% strategy_report.csv dosyasini okur ve aracin anlik mesafesine gore
% hedef hiz / hedef Wh degerlerini sunucuya gonderir.
clear; clc;

BASE_URL        = 'http://89.168.106.46:1945';
STRATEGY_URL    = [BASE_URL '/api/v1/strategy'];
STATUS_URL      = [BASE_URL '/api/v1/simulation/status'];
STRATEGY_CSV    = [BASE_URL '/strategy/strategy_report.csv'];
UPDATE_INTERVAL = 1.0;

disp('MATLAB Strategy Integration v6 baslatiliyor...');
eskiTimerlar = timerfindall;
if ~isempty(eskiTimerlar)
    stop(eskiTimerlar);
    delete(eskiTimerlar);
end

% --- Strategy CSV yi indir ve parse et ---
strategyTable = [];
try
    csvText = webread(STRATEGY_CSV, weboptions('Timeout', 10, 'ContentType', 'text'));
    % Satir satir ayir (\n, \r\n destekli)
    csvLines = strsplit(csvText, {'\r\n', '\n', '\r'});
    % Bos satirlari temizle
    csvLines = csvLines(~cellfun('isempty', strtrim(csvLines)));

    if length(csvLines) < 2
        error('CSV dosyasi bos veya tek satirli');
    end

    % Header i oku ve ayiracyi belirle
    headerLine = csvLines{1};
    if contains(headerLine, ';')
        sep = ';';
    else
        sep = ',';
    end
    headers = strtrim(strsplit(headerLine, sep));

    % Veri satirlarini parse et
    nRows = length(csvLines) - 1;
    strategyTable = struct();
    strategyTable.startM   = zeros(nRows, 1);
    strategyTable.endM     = zeros(nRows, 1);
    strategyTable.eylem    = cell(nRows, 1);
    strategyTable.girisHiz = zeros(nRows, 1);
    strategyTable.cikisHiz = zeros(nRows, 1);
    strategyTable.topSure  = zeros(nRows, 1);

    for r = 1:nRows
        vals = strtrim(strsplit(csvLines{r+1}, sep));
        if length(vals) >= 8
            strategyTable.startM(r)   = str2double(vals{1});
            strategyTable.endM(r)     = str2double(vals{2});
            strategyTable.eylem{r}    = vals{4};
            strategyTable.girisHiz(r) = str2double(vals{5});
            strategyTable.cikisHiz(r) = str2double(vals{6});
            strategyTable.topSure(r)  = str2double(vals{8});
        end
    end
    fprintf('Strategy CSV basariyla okundu: %d segment\n', nRows);
catch ME
    fprintf('UYARI: Strategy CSV okunamadi: %s\n', ME.message);
    fprintf('Varsayilan kurallara gore calisilacak.\n');
end

t = timer('ExecutionMode', 'fixedRate', ...
          'Period', UPDATE_INTERVAL, ...
          'TimerFcn', @(~,~) processServerTelemetry(BASE_URL, STRATEGY_URL, STATUS_URL, strategyTable));
start(t);
disp('Sunucu dinleniyor. Durdurmak icin: stop(t); delete(t);');

% -----------------------------------------------------------------------
function processServerTelemetry(baseUrl, strategyUrl, statusUrl, strategyTable)

    persistent lapStartWh lapNumber prevLat prevLon totalDistM simStartTime prevLapDist headingAngle lastRowId;
    if isempty(lapStartWh),   lapStartWh   = -1;  end
    if isempty(lapNumber),    lapNumber    = 1;    end
    if isempty(prevLat),      prevLat      = 0;    end
    if isempty(prevLon),      prevLon      = 0;    end
    if isempty(totalDistM),   totalDistM   = 0;    end
    if isempty(simStartTime), simStartTime = '';   end
    if isempty(prevLapDist),  prevLapDist  = 0;    end
    if isempty(headingAngle), headingAngle = 0;    end
    if isempty(lastRowId),    lastRowId    = -1;   end

    try
        options = weboptions('Timeout', 5);

        % 1. Simulasyon aktif mi?
        serverStatus = webread(statusUrl, options);
        if ~isfield(serverStatus, 'running') || serverStatus.running == false
            if ~isempty(simStartTime)
                disp('Simulasyon bitti, sifirlaniyor...');
                simStartTime = '';
                lapStartWh   = -1;
                lapNumber    = 1;
                prevLat      = 0;
                prevLon      = 0;
                totalDistM   = 0;
                prevLapDist  = 0;
            end
            fprintf('[%s] Beklemede...\n', datestr(now,'HH:MM:SS'));
            return;
        end

        % 2. Simulasyon yeni mi basladi?
        if isempty(simStartTime)
            try
                serverTime = webread([baseUrl '/api/server-time'], options);
                simStartTime = serverTime.iso;
            catch
                simStartTime = datestr(now - 5/86400, 'yyyy-mm-ddTHH:MM:SS.000Z');
            end
            fprintf('[%s] Yeni simulasyon algilandi. Since: %s\n', ...
                datestr(now,'HH:MM:SS'), simStartTime);
        end

        % 3. Son telemetri verisini cek
        telemetryUrl = [baseUrl '/api/v1/telemetry?limit=1&order=desc&since=' simStartTime];
        telemetryData = webread(telemetryUrl, options);

        if isempty(telemetryData) || ~isfield(telemetryData,'rows') || isempty(telemetryData.rows)
            fprintf('[%s] Henuz yeni veri yok, bekleniyor...\n', datestr(now,'HH:MM:SS'));
            return;
        end

        if iscell(telemetryData.rows)
            row = telemetryData.rows{1};
        else
            row = telemetryData.rows(1);
        end

        % Ayni satiri tekrar islememek icin id kontrolu
        if isfield(row, 'id')
            if row.id == lastRowId
                return; % Bu satiri zaten isledik
            end
            lastRowId = row.id;
        end

        % Alanlari oku (eksik alanlar artik 0 olarak geliyor)
        currentSpeed = double(row.spd);
        currentWh    = double(row.wh);
        watt         = double(row.w);
        voltage      = double(row.v);
        current_A    = double(row.i);
        lat          = double(row.lat);
        lon          = double(row.lon);
        alt          = double(row.alt);
        bat          = double(row.bat);
        tmp          = double(row.tmp);

        if watt == 0 && voltage > 0 && current_A > 0
            watt = voltage * current_A;
        end

        if lapStartWh < 0
            lapStartWh = currentWh;
        end

        % Mesafe birikimi ve yon hesabi
        if prevLat ~= 0
            dLat = deg2rad(lat - prevLat);
            dLon = deg2rad(lon - prevLon);
            a    = sin(dLat/2)^2 + cos(deg2rad(prevLat))*cos(deg2rad(lat))*sin(dLon/2)^2;
            stepDist = 6371000 * 2 * atan2(sqrt(a), sqrt(1-a));
            totalDistM = totalDistM + stepDist;

            % Yon acisi hesapla (bearing)
            if stepDist > 0.5
                dy = lat - prevLat;
                dx = cos(deg2rad(prevLat)) * (lon - prevLon);
                headingAngle = mod(90 - atan2d(dy, dx), 360);
            end
        end
        prevLat = lat;
        prevLon = lon;

        whThisLap = currentWh - lapStartWh;

        % --- Strateji Belirleme ---
        TOTAL_LAPS  = 11;
        targetSpeed = currentSpeed;
        targetWh    = currentWh;
        eylem       = 'KORU';

        if ~isempty(strategyTable) && isfield(strategyTable, 'startM')
            % Pistteki mesafeyi modular yap (bir turluk mesafe)
            trackLength = max(strategyTable.endM);
            
            % Start Line Coordinates for Start/Finish Sync
            START_LAT = 50.5292755;
            START_LON = 18.0960175;
            
            dLatStart = deg2rad(lat - START_LAT);
            dLonStart = deg2rad(lon - START_LON);
            aStart = sin(dLatStart/2)^2 + cos(deg2rad(START_LAT))*cos(deg2rad(lat))*sin(dLonStart/2)^2;
            distToStart = 6371000 * 2 * atan2(sqrt(aStart), sqrt(1-aStart));
            
            % Guncel turun icindeki tahmini mesafe
            lapDist = totalDistM - (lapNumber - 1) * trackLength;

            % Eger start line'a cok yakinsak (ornegin 30m icinde) VE turun en az %80'ini tamamlamissak
            if distToStart < 30 && lapDist > trackLength * 0.8
                lapNumber = lapNumber + 1;
                lapStartWh = currentWh;
                % Birikmis GPS hatasini sifirla ve mesafeyi tam tur katina kilitle
                totalDistM = (lapNumber - 1) * trackLength;
                lapDist = 0;
                fprintf('>>> YENI TUR: %d (Start Line Sync) <<<\n', lapNumber);
            end

            % GPS gurultusu yuzunden toplam mesafe trackLength'i asarsa ve henuz start'a gelmemissek,
            % sondaki satiri (trackLength) asmamak icin sinirla. 
            % Boylece tablo son duzlukte aniden basa donmez.
            if lapDist > trackLength - 0.1
                lapDist = trackLength - 0.1;
            end
            if lapDist < 0
                lapDist = 0;
            end

            % Hangi segmentteyiz?
            segIdx = -1;
            for k = 1:length(strategyTable.startM)
                if lapDist >= strategyTable.startM(k) && lapDist < strategyTable.endM(k)
                    segIdx = k;
                    break;
                end
            end

            if segIdx > 0
                eylem       = strategyTable.eylem{segIdx};
                targetSpeed = strategyTable.cikisHiz(segIdx);

                LAP_BUDGET_WH = 6.5;
                
                % Hedef Wh: Her turda biriken mutlak (absolute) hedef Wh
                targetWh = (lapNumber - 1) * LAP_BUDGET_WH + LAP_BUDGET_WH * ...
                    (strategyTable.topSure(segIdx) / max(1, strategyTable.topSure(end)));
            else
                % Son segmentin otesindeyiz
                eylem       = strategyTable.eylem{end};
                targetSpeed = strategyTable.cikisHiz(end);
                LAP_BUDGET_WH = 6.5;
                targetWh    = lapNumber * LAP_BUDGET_WH;
            end
        else
            % Strategy CSV yoksa eski kurallara don
            LAP_BUDGET_WH = 6.5;
            MAX_SPEED     = 45.0;
            MIN_SPEED     = 15.0;

            if (LAP_BUDGET_WH - whThisLap) < 0.5
                targetSpeed = MIN_SPEED;
                eylem = 'TASARRUF';
            elseif bat < 20
                targetSpeed = MIN_SPEED;
                eylem = 'DUSUK_BATARYA';
            elseif currentSpeed < 10
                targetSpeed = 25.0;
                eylem = 'HIZLAN';
            elseif watt > 200 && currentSpeed > 25
                targetSpeed = currentSpeed * 0.90;
                eylem = 'GUC_AZALT';
            elseif watt < 60 && currentSpeed > 0 && currentSpeed < MAX_SPEED
                targetSpeed = min(currentSpeed * 1.08, MAX_SPEED);
                eylem = 'HIZLAN';
            else
                targetSpeed = currentSpeed;
                eylem = 'KORU';
            end
            targetWh = lapStartWh + LAP_BUDGET_WH;
        end

        targetSpeed = max(10, min(45, targetSpeed));
        lapStr = sprintf('%d/%d', lapNumber, TOTAL_LAPS);

        % Sunucuya gonder
        strategyData = struct( ...
            'speed', currentSpeed, ...
            'targetSpeed', targetSpeed, ...
            'wh', currentWh, ...
            'targetWh', targetWh, ...
            'whThisLap', whThisLap, ...
            'watt', watt, ...
            'voltage', voltage, ...
            'current', current_A, ...
            'bat', bat, ...
            'tmp', tmp, ...
            'alt', alt, ...
            'lap', lapStr, ...
            'lat', lat, ...
            'lon', lon, ...
            'eylem', eylem, ...
            'distance', totalDistM, ...
            'angle', headingAngle ...
        );

        sendOptions = weboptions('MediaType', 'application/json', 'Timeout', 5);
        webwrite(strategyUrl, strategyData, sendOptions);

        fprintf('[%s] Lap:%s | Dist:%6.0fm | Hiz:%5.1f->%5.1f km/h | W:%6.1f | Wh:%6.2f | %s\n', ...
            datestr(now,'HH:MM:SS'), lapStr, totalDistM, currentSpeed, targetSpeed, watt, currentWh, eylem);

    catch ME
        fprintf('[%s] HATA: %s\n', datestr(now,'HH:MM:SS'), ME.message);
    end
end

function r = deg2rad(d)
    r = d * pi / 180;
end