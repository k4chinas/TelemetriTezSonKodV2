%%  Shell Eco-marathon 2025 EU - Tadpole Trike Track Analysis
clear; clc; close all; load('track_data.mat');
figure; plot(x,y,'-','Color',[.7 .7 .7],'LineWidth',1.5); hold on;
for k=1:numel(corners), c=corners(k);
  idx=find(s>=c.s_entry & s<=c.s_exit);
  if strcmp(c.direction,'L'), plot(x(idx),y(idx),'b-','LineWidth',2.5);
  else, plot(x(idx),y(idx),'r-','LineWidth',2.5); end
  ai=find(s>=c.s_apex,1); text(x(ai),y(ai),num2str(c.id),'FontSize',8,'FontWeight','bold');
end
plot(x(1),y(1),'g^','MarkerSize',12,'MarkerFaceColor','g');
axis equal; grid on; title('Pist Plani');
figure; area(s,v_max_kmh,'FaceAlpha',0.4); hold on;
yline(v_limit_kmh,'r--'); ylim([0 40]); grid on; title('Hiz Profili');
xlabel('Mesafe (m)'); ylabel('Hiz (km/h)');
figure; semilogy(s,R,'b.','MarkerSize',2); hold on; yline(300,'r--'); grid on; title('Yaricap');
figure;
subplot(2,2,1); plot(s,z,'k-'); grid on; title('Rakim');
subplot(2,2,2); area(s,grade,'FaceAlpha',0.4); grid on; title('Egim');
subplot(2,2,3); plot(s,v_max_kmh,'b-'); hold on; yline(v_limit_kmh,'r--'); ylim([0 40]); grid on; title('Hiz');
subplot(2,2,4); semilogy(s,R,'b.','MarkerSize',2); hold on; yline(300,'r--'); grid on; title('R');
fprintf('\n=== VIRAJ TABLOSU ===\n');
for k=1:numel(corners), c=corners(k);
  fprintf('Viraj %2d | Giris:%6.1fm | Apex:%6.1fm | R_min:%6.1fm | %s | %.1f deg | v:%.1f km/h\n',...
    c.id,c.s_entry,c.s_apex,c.R_min,c.direction,c.angle_deg,c.v_apex); end
fprintf('Pist: %.1fm | Viraj: %d | Tur: %.1fs\n',track_length,n_corners,T_lap_estimate);
assert(abs(s(end)-track_length)<1,'Mesafe uyusmuyor');
fprintf('Dogrulama OK!\n');
