% ════════════════════════════════════════════════════════════════
% Shell Eco-marathon — Asenkron TCP Telemetri Başlatıcı Script
% ════════════════════════════════════════════════════════════════
clear; clc;

% 1. TCP Bağlantı Ayarları
TCP_IP = '192.168.1.10'; % SIM800C Modülünüzün veya Sunucunuzun IP adresi
TCP_PORT = 1945;         % Hedef TCP Portu

% 2. Telemetry Objesini Başlat (JSON Bağlantısını Açar)
telemetry = TelemetryServer(TCP_IP, TCP_PORT);

% 3. EKF / Kontrol (MPC) Fonksiyonunu Tanımla (Anında Tetikleyici)
% TCP'den JSON paketi başarıyla parse edildiği an bu fonksiyon tetiklenir.
telemetry.runCalculations = @() runMyControlAlgorithms(telemetry);

disp('Sistem Asenkron (Event-Driven JSON) olarak çalışıyor.');
disp('Durdurmak için komut satırına "telemetry.stop()" yazabilirsiniz.');


% ════════════════════════════════════════════════════════════════
% Dışarıdan Tetiklenen Algoritma Bloğu (EKF, PI, MPC vb.)
% ════════════════════════════════════════════════════════════════
function runMyControlAlgorithms(tel)
    % tel: O an güncellenmiş olan TelemetryServer objesinin ta kendisidir.
    
    persistent lapCount;
    persistent totalLaps;
    persistent isFarFromStart;
    persistent startLat;
    persistent startLon;
    
    if isempty(lapCount)
        lapCount = 1;
        totalLaps = 11;
        isFarFromStart = false;
        
        % Başlangıç çizgisi koordinatları (Örn: SEM EU 2025 Start noktası)
        startLat = 50.529275;
        startLon = 18.096017;
    end
    
    distToStart = 0;
    % İlk geçerli GPS verisi gelene kadar bekle
    if tel.lat ~= 0 && tel.lon ~= 0
        % Opsiyonel: İlk alınan konumu başlangıç kabul etmek isterseniz 
        % aşağıdaki yorum satırlarını açabilirsiniz:
        % if startLat == 0
        %     startLat = tel.lat; startLon = tel.lon;
        % end

        % Haversine Formülü ile başlangıç çizgisine uzaklık (Metre)
        R_earth = 6371000; 
        dLat = deg2rad(tel.lat - startLat);
        dLon = deg2rad(tel.lon - startLon);
        a = sin(dLat/2)^2 + cos(deg2rad(startLat)) * cos(deg2rad(tel.lat)) * sin(dLon/2)^2;
        c = 2 * atan2(sqrt(a), sqrt(1-a));
        distToStart = R_earth * c;
        
        % Tur Sayacı Mantığı (Çizgi Geçişi Algılama)
        % Araç başlangıç çizgisinden en az 100 metre uzaklaşmalı ki yanlış tetikleme olmasın
        if distToStart > 100
            isFarFromStart = true;
        elseif distToStart < 20 && isFarFromStart
            % Araç tekrar çizgiye yaklaştı (20m yarıçapına girdi) ve daha önce uzaklaşmıştı
            if lapCount < totalLaps
                lapCount = lapCount + 1;
            end
            isFarFromStart = false;
        end
    end

    % Örnek çıktı (TUR SAYACI ve GPS/Batarya verisi eklendi)
    fprintf('[%s] TUR: %d/%d | Hız: %.1f km/h | Batarya: %%%.0f | Sıcaklık: %.1fC | GPS: %.4f, %.4f | Çizgiye Uzaklık: %.1fm\n', ...
            datestr(now, 'HH:MM:SS.FFF'), lapCount, totalLaps, tel.spd, tel.bat, tel.tmp, tel.lat, tel.lon, distToStart);
            
    % Örnek İvmeölçer verileri:
    % fprintf('   İvme (X, Y, Z): %.2f, %.2f, %.2f\n', tel.ax, tel.ay, tel.az);
            
    % Kendi EKF veya Control algoritmalarınızı BURAYA yazabilirsiniz:
    % [x_est, P_est] = ExtendedKalmanFilter(tel.spd, tel.lat, tel.lon, tel.ax, tel.ay);
end
