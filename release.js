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
    files: ['main.js', 'main-core.js', 'security.js', 'index.html', 'renderer.js', 'preload.js', 'version.json']
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

  // 1. Git commit & push files lên GitHub TRƯỚC
  // (ota:apply sẽ tải từng file từ GitHub raw — không cần bytebin)
  const updateFiles = Array.from(new Set([
    ...(Array.isArray(verData.files) ? verData.files : []),
    'main.js',
    'main-core.js',
    'security.js',
    'index.html',
    'renderer.js',
    'preload.js',
    'version.json'
  ]));

  try {
    console.log('\n📦 Đang git add & git commit & git push...');
    const sourceFiles = Array.from(new Set([
      ...updateFiles,
      'release.js',
      'package.json',
      'package-lock.json'
    ]));
    execSync(`git add -- ${sourceFiles.map((file) => `"${file}"`).join(' ')}`, { stdio: 'inherit' });
    execSync(
      `git commit -m "release: v${verData.version} - ${verData.notes}" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"`,
      { stdio: 'inherit' }
    );
    execSync('git push', { stdio: 'inherit' });
    console.log('\n✅ ĐÃ ĐẨY LÊN GITHUB THÀNH CÔNG!');
  } catch (e) {
    throw new Error(`Không commit/push được source release: ${e.message}`);
  }

  // 2. Kích hoạt OTA manifest trên keyvalue — chỉ lưu "github-{buildNumber}"
  //    main-core.js ota:check/apply sẽ fallback tải từng file từ GitHub raw nếu không có bbKey
  console.log('\n☁️ Đang kích hoạt OTA manifest trên Cloud...');
  const manifest = `github-${verData.buildNumber}`;
  const mRes = await httpsReq(
    `https://keyvalue.immanuel.co/api/KeyVal/UpdateValue/${CLOUD_APP_KEY}/otamanifest/${manifest}`,
    'POST',
    ''
  );
  if (mRes.status !== 200) {
    throw new Error(`Đã push source nhưng không kích hoạt được OTA manifest: HTTP ${mRes.status} ${mRes.error || ''}`);
  }
  console.log(`✅ Đã kích hoạt OTA v${verData.version} (Build ${verData.buildNumber}). Máy khách có thể bấm "Cập nhật ngay".\n`);
})();
