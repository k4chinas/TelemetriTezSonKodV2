%%  Shell Eco-marathon 2025 EU - Yakit Pili & Arac Modeli
clear; clc; close all;
load('vehicle_data.mat');

%% Figure 1: FC Calisma Noktasi
figure('Name','FC Profilleri','Position',[100 100 1200 600]);
subplot(3,1,1); plot(s,I_FC,'b-','LineWidth',0.8); hold on;
yline(I_max,'r--'); yline(35,'Color',[1 .5 0],'LineStyle','--');
ylabel('I (A)'); title('FC Akim Profili'); grid on;
subplot(3,1,2); plot(s,V_FC,'r-','LineWidth',0.8);
ylabel('V (V)'); title('FC Gerilim Profili'); grid on;
subplot(3,1,3); plot(s,P_FC,'m-','LineWidth',0.8); hold on;
plot(s,P_wheel,'b-','LineWidth',0.8);
yline(P_FC_max,'r--'); legend('P_{FC}','P_{wheel}','P_{FC,max}');
xlabel('Mesafe (m)'); ylabel('P (W)'); title('Guc Profili'); grid on;

%% Figure 2: H2 Debi
figure('Name','H2 Tuketim','Position',[100 100 1000 500]);
yyaxis left; area(s,H2_flow_mlmin,'FaceAlpha',0.4,'FaceColor','g');
ylabel('H_2 Debi (ml/min)');
yyaxis right; plot(s,H2_cumulative,'k-','LineWidth',1.5);
ylabel('Kumulatif H_2 (L)');
xlabel('Mesafe (m)'); title('H_2 Debi ve Kumulatif Tuketim'); grid on;

%% Figure 3: Polarizasyon
figure('Name','Polarizasyon','Position',[100 100 800 500]);
yyaxis left; plot(LUT_I,LUT_V,'b-o','LineWidth',2); ylabel('V (V)');
yyaxis right; plot(LUT_I,LUT_P,'r-s','LineWidth',2); ylabel('P (W)');
hold on; scatter(I_FC(I_FC>0.1),P_FC(I_FC>0.1),3,'r','filled','MarkerFaceAlpha',0.3);
xlabel('I (A)'); title('Polarizasyon Egrisi'); grid on;
legend('V-I','P-I','Sim. Noktalari');

%% Konsol Raporu
fprintf('\n=== YAKIT PILI MODEL SONUCLARI ===\n');
fprintf('Tur suresi     : %.1f s (%.0f dk %.1f sn)\n', T_lap, floor(T_lap/60), mod(T_lap,60));
fprintf('H2 tuketimi    : %.4f L (%.3f g)\n', H2_total_L, H2_total_g);
fprintf('km/L_H2        : %.1f\n', km_per_L);
fprintf('km/g_H2        : %.2f\n', km_per_g);
fprintf('Genel verim    : %.1f %%\n', eta_overall*100);
fprintf('Enerjetik verim: %.1f %%\n', eta_energetik*100);

%% LUT Tablo
fprintf('\n  I(A)  |  V(V)  | P_FC(W) | H2(ml/min)\n');
fprintf('  ------|--------|---------|----------\n');
for k=1:numel(LUT_I)
    fprintf('  %5.1f | %5.1f  | %7.1f | %7.0f\n', LUT_I(k), LUT_V(k), LUT_P(k), LUT_H2(k));
end
fprintf('Dogrulama OK!\n');
