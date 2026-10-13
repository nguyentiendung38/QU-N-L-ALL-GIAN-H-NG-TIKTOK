const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const notes = process.argv.slice(2).join(' ').trim() || 'Cập nhật tính năng mới';
const verFile = path.join(__dirname, 'version.json');
const CLOUD_APP_KEY = 'v6ippqsk';

function httpsReq(url, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const r = https.request(
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          method,
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0',
            ...headers,
            ...(body !== null ? { 'Content-Length': Buffer.byteLength(body) } : {})
          }
        },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => resolve({ status: res.statusCode, body: d }));
        }
      );
      r.on('error', (e) => resolve({ status: 0, error: e.message }));
      r.on('timeout', () => {
        try { r.destroy(); } catch {}
        resolve({ status: 0, error: 'TIMEOUT' });
      });
      if (body !== null) r.write(body);
      r.end();
    } catch (e) {
      resolve({ status: 0, error: e.message });
    }
  });
}

(async () => {
  let verData = {
    version: '2.1.0',
    buildNumber: 210,
    updatedAt: '',
    notes: '',
    files: ['main.js', 'index.html', 'renderer.js', 'preload.js', 'version.json']
  };
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

  console.log(`\n======================================================`);
  console.log(`🚀 BẮT ĐẦU PHÁT HÀNH BẢN CẬP NHẬT: v${verData.version} (Build ${verData.buildNumber})`);
  console.log(`📝 Nội dung thông báo: "${verData.notes}"`);
  console.log(`======================================================\n`);

  // 1. Tạo gói bundle code mới để upload lên Cloud OTA (bytebin + keyvalue)
  console.log('☁️ Đang đóng gói và đẩy bản cập nhật lên Cloud OTA...');
  const bundle = {
    version: verData.version,
    buildNumber: verData.buildNumber,
    updatedAt: verData.updatedAt,
    notes: verData.notes,
    files: {
      'version.json': fs.readFileSync(verFile, 'utf8'),
      'main.js': fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8'),
      'index.html': fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'),
      'renderer.js': fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8'),
      'preload.js': fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8')
    }
  };

  const bbRes = await httpsReq('https://bytebin.lucko.me/post', 'POST', JSON.stringify(bundle), {
    'Content-Type': 'application/json'
  });

  let bbKey = '';
  if (bbRes.status === 201 && bbRes.body) {
    try {
      bbKey = JSON.parse(bbRes.body).key || '';
    } catch {}
  }

  if (bbKey) {
    console.log(`✅ Upload gói code thành công (Key: ${bbKey})!`);
    const manifest = `${bbKey}-${verData.buildNumber}`;
    const mRes = await httpsReq(
      `https://keyvalue.immanuel.co/api/KeyVal/UpdateValue/${CLOUD_APP_KEY}/otamanifest/${manifest}`,
      'POST',
      ''
    );
    if (mRes.status === 200) {
      console.log('✅ Đã kích hoạt bản cập nhật mới trên Cloud OTA!');
    } else {
      console.log('⚠️ Cảnh báo: Kích hoạt manifest trên Cloud trả về:', mRes.status);
    }
  } else {
    console.log('⚠️ Không upload được lên bytebin:', bbRes.status, bbRes.error);
  }

  // 2. Commit & Push lên GitHub
  try {
    console.log('\n📦 Đang git add & git commit & git push...');
    execSync('git add .', { stdio: 'inherit' });
    execSync(`git commit -m "release: v${verData.version} - ${verData.notes}"`, { stdio: 'inherit' });
    execSync('git push', { stdio: 'inherit' });
    console.log('\n✅ ĐÃ ĐẨY LÊN GITHUB THÀNH CÔNG!');
    console.log(`🔔 TẤT CẢ MÁY KHÁCH HÀNG / NHÂN VIÊN SẼ THẤY THÔNG BÁO CẬP NHẬT "v${verData.version}" NGAY LẬP TỨC!\n`);
  } catch (e) {
    console.error('Lỗi khi git push:', e.message);
  }
})();
