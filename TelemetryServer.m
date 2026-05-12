classdef TelemetryServer < handle
    % TELEMETRYSERVER TCP Asenkron Telemetri Sınıfı (JSON Formatı)
    % Gelen JSON formatındaki TCP verilerini asenkron olarak yakalar, parse eder
    % ve anında kontrol algoritmalarını (EKF/MPC) tetikler.
    
    properties
        tcpObj          % TCP Client objesi
        
        % --- Sensör Verileri (JSON'dan parse edilecek 22 Değişken) ---
        lon, lat, h, m, s, alt
        gx, gy, gz
        ax, ay, az
        tmp
        mx, my, mz
        v, i, w, wh
        spd, bat
        
        % --- Kayıt / Veritabanı ---
        data            % Gelen verilerin zaman damgalı tutulduğu tablo
        
        % --- Callback (Tetikleyici) ---
        runCalculations % Veri gelir gelmez çalıştırılacak fonksiyon
        
        % Ham veri buffer'ı (Paket bölünmelerine karşı)
        dataBuffer
    end
    
    methods
        function obj = TelemetryServer(IP, Port)
            % Kurucu Fonksiyon (Constructor)
            obj.data = table(); % Boş tablo başlat
            obj.runCalculations = @() disp('Veri alindi, hesaplama atanmadi.');
            obj.dataBuffer = "";
            
            % 1. TCP Bağlantısını Kur
            fprintf('Bağlantı kuruluyor: %s:%d...\n', IP, Port);
            obj.tcpObj = tcpclient(IP, Port);
            
            % 2. Asenkron Callback Ayarı
            % JSON verisinin uzunluğu değişkendir, bu yüzden "terminator" veya
            % byte geldiğinde tetiklenen bir yapı kuruyoruz.
            % En sağlıklısı buffer'a veri düştükçe okumaktır.
            configureCallback(obj.tcpObj, "byte", 1, @obj.readTCPData);
            
            disp('TCP Asenkron dinleme aktif. JSON verisi bekleniyor...');
        end
        
        function readTCPData(obj, src, ~)
            % TCP Buffer'ında okumaya hazır kaç byte var?
            bytesAvailable = src.BytesAvailable;
            if bytesAvailable == 0
                return;
            end
            
            % Ham byte'ları okuyup karaktere çevir ve buffer'a ekle
            rawData = read(src, bytesAvailable, 'uint8');
            newStr = char(rawData);
            obj.dataBuffer = obj.dataBuffer + string(newStr);
            
            % Buffer içinde tam bir JSON ({...}) var mı kontrol et
            % Node.js sunucusu genellikle veriyi {} içinde gönderir.
            startIdx = strfind(obj.dataBuffer, '{');
            endIdx = strfind(obj.dataBuffer, '}');
            
            if ~isempty(startIdx) && ~isempty(endIdx) && endIdx(end) > startIdx(1)
                % Geçerli bir tam JSON paketi bulduk!
                jsonStr = extractBetween(obj.dataBuffer, startIdx(1), endIdx(end));
                jsonStr = "{" + jsonStr(1) + "}"; % Sınırları onar
                
                % Okunan kısmı buffer'dan temizle
                obj.dataBuffer = extractAfter(obj.dataBuffer, endIdx(end));
                
                try
                    % 3. JSON Çözümleme (Parsing)
                    parsed = jsondecode(jsonStr);
                    
                    % 4. Obje property'lerini eşleştir
                    % Zaman/Konum
                    obj.lon = parsed.lon; obj.lat = parsed.lat; obj.alt = parsed.alt;
                    obj.h = parsed.h; obj.m = parsed.m; obj.s = parsed.s;
                    % İvmeölçer / Gyro / Manyetometre / Sıcaklık
                    obj.gx = parsed.gx; obj.gy = parsed.gy; obj.gz = parsed.gz;
                    obj.ax = parsed.ax; obj.ay = parsed.ay; obj.az = parsed.az;
                    obj.mx = parsed.mx; obj.my = parsed.my; obj.mz = parsed.mz;
                    obj.tmp = parsed.tmp;
                    % Elektriksel ve Motor
                    obj.v = parsed.v; obj.i = parsed.i; obj.w = parsed.w; 
                    obj.wh = parsed.wh; obj.spd = parsed.spd; obj.bat = parsed.bat;
                    
                    % 5. Tabloyu Güncelle
                    newRow = table(datetime('now'), obj.lat, obj.lon, obj.spd, obj.tmp, obj.v, obj.i, obj.bat, ...
                                   'VariableNames', {'Timestamp', 'Lat', 'Lon', 'Speed', 'Temp', 'Volt', 'Amp', 'Battery'});
                    obj.data = [obj.data; newRow];
                    
                    % 6. Anında Hesaplama (Calculation Trigger)
                    if ~isempty(obj.runCalculations)
                        obj.runCalculations();
                    end
                    
                catch ME
                    % JSON eksik gelmişse veya parse hatası varsa yoksay
                    % warning('JSON Parse Hatası: %s', ME.message);
                end
            end
        end
        
        function stop(obj)
            % Bağlantıyı temiz bir şekilde kapat
            if ~isempty(obj.tcpObj)
                configureCallback(obj.tcpObj, "off");
                clear obj.tcpObj;
                disp('TCP bağlantısı güvenli şekilde kapatıldı.');
            end
        end
    end
end
