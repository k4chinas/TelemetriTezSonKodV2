% global_params.m - MERKEZİ KONFİGÜRASYON
global params;

% Değişkenleri "params" yapısı altında topluyoruz
params.m_veh = 110;          % Araç ağırlığı (kg)
params.v_limit = 35 / 3.6;   % Hız limiti (m/s)
params.start_coord = [50.5292755, 18.0960175]; % Başlangıç çizgisi [Lat, Lon]

% Veri dosyalarını otomatik yükle
if isfile('track_data.mat')
    load('track_data.mat');
    disp('✅ track_data.mat yüklendi.');
end

if isfile('vehicle_data.mat')
    load('vehicle_data.mat');
    disp('✅ vehicle_data.mat yüklendi.');
end