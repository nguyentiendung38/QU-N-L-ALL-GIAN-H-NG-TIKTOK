const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const notes = process.argv.slice(2).join(' ').trim() || 'Cập nhật tính năng mới';
const verFile = path.join(__dirname, 'version.json');

let verData = { version: '2.1.0', buildNumber: 210, updatedAt: '', notes: '', files: ['index.html', 'renderer.js', 'preload.js', 'version.json'] };
try {
  verData = JSON.parse(fs.readFileSync(verFile, 'utf8'));
} catch {}

verData.buildNumber = (Number(verData.buildNumber) || 210) + 1;
const parts = (verData.version || '2.1.0').split('.');
if (parts.length >= 3) {
  parts[2] = String(parseInt(parts[2], 10) + 1);
  verData.version = parts.join('.');
} else {
  verData.version = '2.1.' + verData.buildNumber;
}

verData.updatedAt = new Date().toISOString().slice(0, 10);
verData.notes = notes;

fs.writeFileSync(verFile, JSON.stringify(verData, null, 2), 'utf8');

console.log(`\n🚀 ĐÃ TĂNG PHIÊN BẢN LÊN: v${verData.version} (Build ${verData.buildNumber})`);
console.log(`📝 Nội dung thông báo: "${verData.notes}"\n`);

try {
  console.log('📦 Đang git add & git commit & git push...');
  execSync('git add .', { stdio: 'inherit' });
  execSync(`git commit -m "release: v${verData.version} - ${verData.notes}"`, { stdio: 'inherit' });
  execSync('git push', { stdio: 'inherit' });
  console.log('\n✅ ĐÃ ĐẨY LÊN GITHUB THÀNH CÔNG!');
  console.log('🔔 Tất cả máy nhân viên/khách hàng mở app sẽ thấy thông báo cập nhật này ngay lập tức!\n');
} catch (e) {
  console.error('Lỗi khi git push:', e.message);
}
