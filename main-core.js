const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { initSecurity } = require('./security');

// He thong bao ve (chong DevTools / debug) giu nguyen nhu ban truoc
initSecurity();

// App nay chi la bang dieu khien: moi gian mo bang Chrome that, nen khong can GPU/webview nang.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const DEFAULT_ADS =
  'https://seller-vn.tiktok.com/ads-creation/dashboard?origin=SC_ads_tab_button_PC&btm_pre_unit_params=%7B%22btm_origin%22%3A%22sidebar_menu_Qu%E1%BA%A3ng+c%C3%A1o+c%E1%BB%ADa+h%C3%A0ng%22%7D&mpa=1&activated_tab_id=0&shop_region=VN';
// Khong gan cung khoang thoi gian: de TikTok tu mo ngay hien tai
const DEFAULT_ORDERS = 'https://seller-vn.tiktok.com/order?selected_sort=6&tab=all';
const DEFAULT_SHOPEE_URL = 'https://subaccount.shopee.com/login/';
const DEFAULT_CSKH_CHAT =
  'https://seller-vn.tiktok.com/chat/inbox/current?oec_seller_id=7494826072462165266&shop_region=VN&lang=en&from=seller_center_navigation_im';
const DEFAULT_CSKH_ORDERS =
  'https://seller-vn.tiktok.com/order?order_status[]=1&selected_sort=11&tab=to_ship';

// Ma dong bo Cloud chung mac dinh cho toan he thong 186 HOME (Admin & Nhan vien khac may tu dong dong bo)
const DEFAULT_CLOUD_KEY = 'v6ippqsk';

const shopsFile = () => path.join(app.getPath('userData'), 'shops.json');
const membersFile = () => path.join(app.getPath('userData'), 'members.json');
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const profilesRoot = () => path.join(app.getPath('userData'), 'profiles');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function readShops() {
  const own = readJson(shopsFile(), null);
  if (Array.isArray(own)) return own;
  // Lan dau chay: nhap danh sach gian tu ban app cu (neu co)
  const old = [
    path.join(app.getPath('appData'), 'tiktok-multishop', 'shops.json'),
    path.join(app.getPath('appData'), '186 HOME - TikTok MultiShop', 'shops.json')
  ];
  for (const f of old) {
    const d = readJson(f, null);
    if (Array.isArray(d) && d.length) return d;
  }
  return [];
}

function readMembers() {
  const own = readJson(membersFile(), null);
  return Array.isArray(own) ? own : [];
}

function readAuthObj() {
  const s = readJson(settingsFile(), {});
  return {
    adminUser: s.adminUser || 'admin',
    adminPass: s.adminPass || '123456',
    requireLogin: true,
    cloudKey: s.cloudKey || DEFAULT_CLOUD_KEY,
    lastCloudUpdatedAt: Number(s.lastCloudUpdatedAt) || 0
  };
}

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 15000,
  maxSockets: 30,
  timeout: 8000
});

function httpsReq(url, method = 'GET', body = null, extraHeaders = {}) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const r = https.request(
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          method,
          agent: httpsAgent,
          timeout: 8000,
          headers: {
            'User-Agent': 'Mozilla/5.0',
            ...extraHeaders,
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
        try {
          r.destroy();
        } catch {}
        resolve({ status: 0, error: 'TIMEOUT' });
      });
      if (body !== null) r.write(body);
      r.end();
    } catch (e) {
      resolve({ status: 0, error: e.message });
    }
  });
}

let cloudPushTimer = null;
async function pushToCloudNow() {
  try {
    const s = readJson(settingsFile(), {});
    const cloudKey = (s.cloudKey || DEFAULT_CLOUD_KEY).trim();
    const shops = readShops();
    const members = readMembers();
    const updatedAt = Date.now();

    const payload = {
      version: 2,
      updatedAt,
      adminUser: s.adminUser || 'admin',
      adminPass: s.adminPass || '123456',
      shops,
      members
    };

    const jsonStr = JSON.stringify(payload);

    // 1. Upload full JSON len bytebin (nhanh, khong gioi han dung luong)
    let bbKey = 'NONE';
    const bbRes = await httpsReq('https://bytebin.lucko.me/post', 'POST', jsonStr, {
      'Content-Type': 'application/json'
    });
    if (bbRes.status === 201 && bbRes.body) {
      try {
        bbKey = JSON.parse(bbRes.body).key || 'NONE';
      } catch {}
    }

    // 2. Dong thoi nen va luu cac chunk len keyvalue.immanuel.co (du phong kep 100%)
    const compressed = zlib.deflateRawSync(Buffer.from(jsonStr, 'utf8')).toString('base64url');
    const chunkSize = 180;
    const chunks = [];
    for (let i = 0; i < compressed.length; i += chunkSize) {
      chunks.push(compressed.slice(i, i + chunkSize));
    }

    await Promise.all(
      chunks.map((ch, idx) =>
        httpsReq(`https://keyvalue.immanuel.co/api/KeyVal/UpdateValue/${cloudKey}/c_${idx}/${ch}`, 'POST', '')
      )
    );

    const manifest = `${bbKey}_${chunks.length}_${updatedAt}`;
    const mRes = await httpsReq(
      `https://keyvalue.immanuel.co/api/KeyVal/UpdateValue/${cloudKey}/manifest/${manifest}`,
      'POST',
      ''
    );

    s.lastCloudUpdatedAt = updatedAt;
    writeJson(settingsFile(), s);
    return { ok: mRes.status === 200, updatedAt };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function scheduleCloudPush() {
  clearTimeout(cloudPushTimer);
  cloudPushTimer = setTimeout(() => {
    pushToCloudNow();
  }, 250);
}

async function pullFromCloud(force = false) {
  try {
    const s = readJson(settingsFile(), {});
    const cloudKey = (s.cloudKey || DEFAULT_CLOUD_KEY).trim();
    const localUpdatedAt = Number(s.lastCloudUpdatedAt) || 0;

    const mRes = await httpsReq(`https://keyvalue.immanuel.co/api/KeyVal/GetValue/${cloudKey}/manifest`, 'GET');
    if (mRes.status !== 200 || !mRes.body) {
      return {
        ok: false,
        error: 'CLOUD_UNREACHABLE',
        shops: readShops(),
        members: readMembers(),
        authConfig: readAuthObj()
      };
    }

    let manifestStr = '';
    try {
      manifestStr = JSON.parse(mRes.body) || '';
    } catch {
      manifestStr = String(mRes.body || '').replace(/^"|"$/g, '');
    }

    // Neu Cloud chua co du lieu nao ma may nay dang co san shop/member -> day len Cloud luon
    if (!manifestStr || !manifestStr.includes('_')) {
      const localShops = readShops();
      const localMembers = readMembers();
      if (localShops.length > 0 || localMembers.length > 0) {
        await pushToCloudNow();
      }
      return {
        ok: true,
        updated: false,
        shops: localShops,
        members: localMembers,
        authConfig: readAuthObj()
      };
    }

    const parts = manifestStr.split('_');
    const bbKey = parts[0];
    const chunkCount = parseInt(parts[1], 10) || 0;
    const remoteUpdatedAt = parseInt(parts[2], 10) || 0;

    const localShopsNow = readShops();
    if (!force && remoteUpdatedAt <= localUpdatedAt && localShopsNow.length > 0) {
      return {
        ok: true,
        updated: false,
        updatedAt: remoteUpdatedAt,
        shops: localShopsNow,
        members: readMembers(),
        authConfig: readAuthObj()
      };
    }

    let remoteData = null;

    // Uu tien 1: Tai nhanh tu bytebin
    if (bbKey && bbKey !== 'NONE') {
      const bbRes = await httpsReq(`https://bytebin.lucko.me/${bbKey}`, 'GET');
      if (bbRes.status === 200 && bbRes.body) {
        try {
          remoteData = JSON.parse(bbRes.body);
        } catch {}
      }
    }

    // Uu tien 2 (Du phong): Ghep cac chunk tu keyvalue.immanuel.co
    if (!remoteData && chunkCount > 0) {
      const chunkResponses = await Promise.all(
        Array.from({ length: chunkCount }, (_, i) =>
          httpsReq(`https://keyvalue.immanuel.co/api/KeyVal/GetValue/${cloudKey}/c_${i}`, 'GET')
        )
      );
      const joined = chunkResponses
        .map((r) => {
          try {
            return JSON.parse(r.body) || '';
          } catch {
            return String(r.body || '').replace(/^"|"$/g, '');
          }
        })
        .join('');
      if (joined) {
        const rawJson = zlib.inflateRawSync(Buffer.from(joined, 'base64url')).toString('utf8');
        remoteData = JSON.parse(rawJson);
      }
    }

    if (!remoteData || typeof remoteData !== 'object') {
      return {
        ok: false,
        error: 'INVALID_CLOUD_DATA',
        shops: localShopsNow,
        members: readMembers(),
        authConfig: readAuthObj()
      };
    }

    if (Array.isArray(remoteData.shops)) {
      writeJson(shopsFile(), remoteData.shops);
    }
    if (Array.isArray(remoteData.members)) {
      writeJson(membersFile(), remoteData.members);
    }

    const updatedSettings = readJson(settingsFile(), {});
    if (remoteData.adminUser) updatedSettings.adminUser = remoteData.adminUser;
    if (remoteData.adminPass) updatedSettings.adminPass = remoteData.adminPass;
    updatedSettings.lastCloudUpdatedAt = remoteUpdatedAt || Date.now();
    writeJson(settingsFile(), updatedSettings);

    return {
      ok: true,
      updated: true,
      updatedAt: updatedSettings.lastCloudUpdatedAt,
      shops: readShops(),
      members: readMembers(),
      authConfig: readAuthObj()
    };
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      shops: readShops(),
      members: readMembers(),
      authConfig: readAuthObj()
    };
  }
}

// ---- HE THONG TU DONG CAP NHAT CODE TRUC TIEP (LIVE OTA HOT-UPDATE) ----
const liveAppDir = () => path.join(app.getPath('userData'), 'live_app');

function getActiveAppPath() {
  const liveDir = liveAppDir();
  const liveVerFile = path.join(liveDir, 'version.json');
  const requiredLiveFiles = ['index.html', 'renderer.js', 'preload.js', 'main-core.js', 'version.json'];
  const bundledVerFile = path.join(__dirname, 'version.json');

  if (requiredLiveFiles.every((file) => fs.existsSync(path.join(liveDir, file)))) {
    try {
      const liveVer = readJson(liveVerFile, {});
      const bundledVer = readJson(bundledVerFile, {});
      const liveBuild = Number(liveVer.buildNumber) || 0;
      const bundledBuild = Number(bundledVer.buildNumber) || 0;
      if (liveBuild >= bundledBuild) {
        return liveDir;
      }
    } catch {}
  }
  return __dirname;
}

function getCurrentVersionInfo() {
  const activeDir = getActiveAppPath();
  const ver = readJson(path.join(activeDir, 'version.json'), null);
  if (ver && ver.version) return ver;
  return readJson(path.join(__dirname, 'version.json'), {
    version: '2.1.0',
    buildNumber: 210,
    updatedAt: '2026-10-13',
    notes: 'Bản phát hành chính thức'
  });
}

const GITHUB_RAW_BASE =
  'https://raw.githubusercontent.com/nguyentiendung38/QU-N-L-ALL-GIAN-H-NG-TIKTOK/main';

ipcMain.handle('ota:check', async () => {
  try {
    const current = getCurrentVersionInfo();
    const currentBuild = Number(current.buildNumber) || 0;

    // 1. Kiem tra Cloud OTA Manifest (nhanh, public, khong bi chan boi GitHub private repo)
    const cloudManifestUrl = `https://keyvalue.immanuel.co/api/KeyVal/GetValue/${DEFAULT_CLOUD_KEY}/otamanifest`;
    const mRes = await httpsReq(cloudManifestUrl, 'GET');
    let bbKey = '';
    let remoteBuild = 0;
    if (mRes.status === 200 && mRes.body) {
      let rawM = '';
      try {
        rawM = JSON.parse(mRes.body) || '';
      } catch {
        rawM = String(mRes.body).replace(/^"|"$/g, '');
      }
      if (rawM && rawM.includes('-')) {
        const parts = rawM.split('-');
        bbKey = parts[0];
        remoteBuild = parseInt(parts[1], 10) || 0;
      }
    }

    if (bbKey && remoteBuild > 0) {
      const hasUpdate = remoteBuild > currentBuild;
      let notes = 'Cập nhật tính năng mới từ hệ thống';
      let latestVersion = '2.1.' + remoteBuild;

      if (hasUpdate) {
        try {
          const bbInfo = await httpsReq(`https://bytebin.lucko.me/${bbKey}`, 'GET');
          if (bbInfo.status === 200 && bbInfo.body) {
            const parsed = JSON.parse(bbInfo.body);
            if (parsed.version) latestVersion = parsed.version;
            if (parsed.notes) notes = parsed.notes;
          }
        } catch {}
      }

      return {
        ok: true,
        hasUpdate,
        currentVersion: current.version,
        latestVersion,
        buildNumber: remoteBuild,
        notes,
        bbKey
      };
    }

    // 2. Du phong kiem tra GitHub Raw (neu repo duoc set public)
    const verUrl = `${GITHUB_RAW_BASE}/version.json?t=${Date.now()}`;
    const r = await httpsReq(verUrl, 'GET');
    if (r.status === 200 && r.body) {
      const remote = JSON.parse(r.body);
      const gitBuild = Number(remote.buildNumber) || 0;
      const hasUpdate = gitBuild > currentBuild || remote.version !== current.version;
      return {
        ok: true,
        hasUpdate,
        currentVersion: current.version,
        latestVersion: remote.version,
        buildNumber: gitBuild,
        notes: remote.notes || 'Cập nhật tính năng mới',
        updatedAt: remote.updatedAt || ''
      };
    }

    return {
      ok: true,
      hasUpdate: false,
      currentVersion: current.version,
      latestVersion: current.version
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('ota:apply', async () => {
  try {
    const targetDir = liveAppDir();
    fs.mkdirSync(targetDir, { recursive: true });

    let appliedVersion = '';
    let appliedNotes = '';

    // 1. Uu tien tai bundle truc tiep tu Cloud OTA (nhanh trong 1 giay)
    const cloudManifestUrl = `https://keyvalue.immanuel.co/api/KeyVal/GetValue/${DEFAULT_CLOUD_KEY}/otamanifest`;
    const mRes = await httpsReq(cloudManifestUrl, 'GET');
    let bbKey = '';
    if (mRes.status === 200 && mRes.body) {
      let rawM = '';
      try {
        rawM = JSON.parse(mRes.body) || '';
      } catch {
        rawM = String(mRes.body).replace(/^"|"$/g, '');
      }
      if (rawM && rawM.includes('-')) {
        bbKey = rawM.split('-')[0];
      }
    }

    if (bbKey) {
      const bbRes = await httpsReq(`https://bytebin.lucko.me/${bbKey}`, 'GET');
      if (bbRes.status === 200 && bbRes.body) {
        const bundle = JSON.parse(bbRes.body);
        if (bundle && bundle.files) {
          for (const [fname, content] of Object.entries(bundle.files)) {
            fs.writeFileSync(path.join(targetDir, fname), content, 'utf8');
          }
          appliedVersion = bundle.version || '2.1.x';
          appliedNotes = bundle.notes || 'Cập nhật thành công';
        }
      }
    }

    // 2. Du phong: tai tung file tu GitHub
    if (!appliedVersion) {
      const verUrl = `${GITHUB_RAW_BASE}/version.json?t=${Date.now()}`;
      const verRes = await httpsReq(verUrl, 'GET');
      if (verRes.status === 200 && verRes.body) {
        const remote = JSON.parse(verRes.body);
        const filesToDownload = Array.isArray(remote.files) && remote.files.length
          ? remote.files
          : ['index.html', 'renderer.js', 'preload.js', 'version.json'];

        for (const f of filesToDownload) {
          const fRes = await httpsReq(`${GITHUB_RAW_BASE}/${f}?t=${Date.now()}`, 'GET');
          if (fRes.status === 200 && fRes.body && fRes.body.length > 50) {
            fs.writeFileSync(path.join(targetDir, f), fRes.body, 'utf8');
          }
        }
        appliedVersion = remote.version;
        appliedNotes = remote.notes;
      }
    }

    if (!appliedVersion) {
      return { ok: false, error: 'Không tải được gói cập nhật mới từ hệ thống' };
    }

    // Sao chep cac file tai nguyen logo/icon sang thu muc live_app
    try {
      const logoSrc = path.join(__dirname, 'logo.png');
      const iconSrc = path.join(__dirname, 'icon.png');
      if (fs.existsSync(logoSrc)) fs.copyFileSync(logoSrc, path.join(targetDir, 'logo.png'));
      if (fs.existsSync(iconSrc)) fs.copyFileSync(iconSrc, path.join(targetDir, 'icon.png'));
    } catch {}

    return { ok: true, version: appliedVersion, notes: appliedNotes };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

let isRestartingApp = false;
const OTA_RESTART_FLAG = '--after-ota-update';

function getOtaRestartArgs() {
  return [...process.argv.slice(1).filter((arg) => arg !== OTA_RESTART_FLAG), OTA_RESTART_FLAG];
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function startWindowsRestartSupervisor() {
  const executablePath = process.execPath;
  const restartArgs = getOtaRestartArgs();
  const encodedScript = [
    `$parentPid = ${process.pid}`,
    'while (Get-Process -Id $parentPid -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 250 }',
    `$executablePath = ${quotePowerShell(executablePath)}`,
    `$restartArgs = @(${restartArgs.map(quotePowerShell).join(',')})`,
    '& $executablePath @restartArgs'
  ].join('\n');
  const encodedCommand = Buffer.from(encodedScript, 'utf16le').toString('base64');

  return new Promise((resolve, reject) => {
    const supervisor = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encodedCommand],
      { detached: true, windowsHide: true, stdio: 'ignore' }
    );
    supervisor.once('error', reject);
    supervisor.once('spawn', () => {
      supervisor.unref();
      resolve();
    });
  });
}

ipcMain.handle('app:wasOtaRestart', () => process.argv.includes(OTA_RESTART_FLAG));

ipcMain.handle('app:restart', async () => {
  if (isRestartingApp) return { ok: true, restarting: true };
  try {
    if (process.platform === 'win32') {
      let restartScheduled = false;
      try {
        app.relaunch({ args: getOtaRestartArgs() });
        restartScheduled = true;
      } catch (error) {
        console.error('Không đặt lịch khởi động lại bằng Electron được:', error);
      }
      try {
        await startWindowsRestartSupervisor();
        restartScheduled = true;
      } catch (error) {
        console.error('Không tạo được tiến trình chờ khởi động lại:', error);
      }
      if (!restartScheduled) {
        throw new Error('Không thể đặt lịch khởi động lại ứng dụng');
      }
      isRestartingApp = true;
      setTimeout(() => app.quit(), 300);
    } else {
      app.relaunch({
        execPath: process.execPath,
        args: getOtaRestartArgs()
      });
      isRestartingApp = true;
      setTimeout(() => app.quit(), 300);
    }
    return { ok: true, restarting: true };
  } catch (error) {
    isRestartingApp = false;
    return { ok: false, error: error.message };
  }
});

// Tim Chrome (hoac Edge neu khong co Chrome). Co the chon tay trong phan cai dat.
function findBrowser() {
  const s = readJson(settingsFile(), {});
  if (s.browserPath && fs.existsSync(s.browserPath)) return s.browserPath;

  const env = process.env;
  let list = [];
  if (process.platform === 'win32') {
    const pf = env['PROGRAMFILES'] || 'C:\\Program Files';
    const pf86 = env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const local = env['LOCALAPPDATA'] || '';
    list = [
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ];
  } else if (process.platform === 'darwin') {
    list = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ];
  } else {
    list = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  }
  return list.find((p) => p && fs.existsSync(p)) || null;
}

const safeId = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '_');

ipcMain.handle('shops:get', () => readShops());
ipcMain.handle('shops:save', (_e, shops) => {
  writeJson(shopsFile(), shops);
  scheduleCloudPush();
  return true;
});

ipcMain.handle('members:get', () => readMembers());
ipcMain.handle('members:save', (_e, members) => {
  writeJson(membersFile(), Array.isArray(members) ? members : []);
  scheduleCloudPush();
  return true;
});

ipcMain.handle('auth:get', () => readAuthObj());

ipcMain.handle('auth:save', async (_e, cfg) => {
  const s = readJson(settingsFile(), {});
  if (cfg && typeof cfg === 'object') {
    if (cfg.adminUser) s.adminUser = String(cfg.adminUser).trim();
    if (cfg.adminPass) s.adminPass = String(cfg.adminPass).trim();
    if (cfg.cloudKey) s.cloudKey = String(cfg.cloudKey).trim();
    if (typeof cfg.requireLogin === 'boolean') s.requireLogin = cfg.requireLogin;
  }
  writeJson(settingsFile(), s);
  await pushToCloudNow();
  return true;
});

ipcMain.handle('auth:getSavedLogin', () => {
  const s = readJson(settingsFile(), {});
  return s.savedLogin || null;
});

ipcMain.handle('auth:saveLogin', (_e, creds) => {
  const s = readJson(settingsFile(), {});
  s.savedLogin = creds && creds.user ? { user: String(creds.user).trim(), pass: String(creds.pass || '') } : null;
  writeJson(settingsFile(), s);
  return true;
});

ipcMain.handle('auth:clearSavedLogin', () => {
  const s = readJson(settingsFile(), {});
  delete s.savedLogin;
  writeJson(settingsFile(), s);
  return true;
});

ipcMain.handle('cloud:push', () => pushToCloudNow());
ipcMain.handle('cloud:pull', (_e, force) => pullFromCloud(Boolean(force)));

// Cache trang thai hoat dong online trong bo nho de chong lag / chong chop giat khi mang rot nhip
const cloudActiveCache = new Map(); // userKey -> { who, role, time, shops, lastFetched }
let lastActiveFetchWarningAt = 0;

function normalizeActiveActivity(event, userKey, userName) {
  if (!event || !['open', 'close', 'login', 'logout'].includes(event.action)) return null;
  const isShopEvent = event.action === 'open' || event.action === 'close';
  const id = String(event.id || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
  if (!id) return null;
  return {
    id,
    action: event.action,
    userKey,
    userName,
    shopId: isShopEvent ? String(event.shopId || '').trim().slice(0, 80) : '',
    shopName: isShopEvent ? String(event.shopName || '').trim().slice(0, 80) : '',
    time: Number(event.time) || Date.now()
  };
}

function decodeCloudString(body) {
  let value = String(body || '').trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      value = JSON.parse(value);
    } catch {}
  }
  return value;
}

function activeStatusUrl(cloudKey, userKey, payload) {
  const value = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `https://keyvalue.immanuel.co/api/KeyVal/UpdateValue/${encodeURIComponent(cloudKey)}/act_${encodeURIComponent(userKey)}/${value}`;
}

function activeShopsUrl(cloudKey, userKey, chunkIndex, value) {
  return `https://keyvalue.immanuel.co/api/KeyVal/UpdateValue/${encodeURIComponent(cloudKey)}/actshops_${encodeURIComponent(userKey)}_${chunkIndex}/${value}`;
}

function cloudResponseError(response, action) {
  if (response.error) return response.error;
  const detail = decodeCloudString(response.body).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return `${action} (HTTP ${response.status})${detail ? `: ${detail.slice(0, 240)}` : ''}`;
}

// Dong bo trang thai dang mo / dang dong cua cac gian hang qua Cloud giua may Admin va Nhan vien
ipcMain.handle('cloud:reportActive', async (_e, data) => {
  try {
    const s = readJson(settingsFile(), {});
    const cloudKey = (s.cloudKey || DEFAULT_CLOUD_KEY).trim();
    const rawKey = (data && data.userKey ? String(data.userKey).trim() : 'admin');
    const userKey = rawKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    const who = (data && data.userName ? String(data.userName).trim() : 'Admin').slice(0, 40);
    const role = (data && data.role ? String(data.role).trim() : 'cskh').slice(0, 20);
    const shops = (data && Array.isArray(data.shopIds))
      ? Array.from(new Set(data.shopIds.map((id) => String(id).trim().slice(0, 80)).filter(Boolean)))
      : [];
    const proxyIssues = data && Array.isArray(data.proxyIssues)
      ? data.proxyIssues.map((id) => String(id).slice(0, 100)).slice(0, 100)
      : [];
    const activityPending = Math.max(0, Math.min(100, parseInt(data && data.activityPending, 10) || 0));
    const latestActivity = normalizeActiveActivity(data && data.latestActivity, rawKey, who);
    const now = Date.now();
    // Cap nhat cache cuc bo ngay lap tuc de may nay thay trang thai ngay
    cloudActiveCache.set(userKey, {
      who,
      role,
      time: now,
      shops,
      proxyIssues,
      activityPending,
      latestActivity,
      lastFetched: now
    });

    const encodedShops = zlib.deflateRawSync(Buffer.from(JSON.stringify(shops), 'utf8')).toString('base64url');
    const shopChunks = encodedShops.match(/.{1,100}/g) || [];
    const basePayload = { who, role, time: now, shops: [], proxyIssues, activityPending };
    const candidatePayload = { ...basePayload, latestActivity };
    const inlinePayload = shops.length ? { ...candidatePayload, shops } : candidatePayload;
    const inlineUrl = activeStatusUrl(cloudKey, userKey, inlinePayload);
    const statusPayload = inlineUrl.length <= 240
      ? inlinePayload
      : { ...basePayload, shopChunks: shopChunks.length };
    let url = activeStatusUrl(cloudKey, userKey, statusPayload);

    if (url.length > 240 && statusPayload.latestActivity) {
      delete statusPayload.latestActivity;
      url = activeStatusUrl(cloudKey, userKey, statusPayload);
    }
    if (url.length > 240 && statusPayload.proxyIssues) {
      delete statusPayload.proxyIssues;
      delete statusPayload.activityPending;
      url = activeStatusUrl(cloudKey, userKey, statusPayload);
    }
    if (url.length > 240) {
      return { ok: false, error: 'Dữ liệu trạng thái vượt giới hạn URL Cloud; không thể gửi trạng thái shop.' };
    }

    if (statusPayload.shopChunks) {
      for (let index = 0; index < shopChunks.length; index++) {
        const chunkResult = await httpsReq(
          activeShopsUrl(cloudKey, userKey, index, shopChunks[index]),
          'POST',
          ''
        );
        if (chunkResult.status !== 200) {
          return {
            ok: false,
            error: cloudResponseError(chunkResult, `Không lưu được danh sách shop (phần ${index + 1}/${shopChunks.length})`),
            status: chunkResult.status
          };
        }
      }
    }

    let r;
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await httpsReq(url, 'POST', '');
      if (r.status === 200) return { ok: true };
      if (attempt < 2) {
        await new Promise((res) => setTimeout(res, 300 * (attempt + 1)));
      }
    }
    return { ok: false, error: cloudResponseError(r, 'Không lưu được trạng thái nhân viên lên Cloud'), status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('cloud:getActive', async () => {
  try {
    const s = readJson(settingsFile(), {});
    const cloudKey = (s.cloudKey || DEFAULT_CLOUD_KEY).trim();
    const members = readMembers();
    const keysToCheck = ['admin', ...members.map((m) => String(m.id).trim().replace(/[^a-zA-Z0-9_-]/g, '_'))];
    const uniqueKeys = Array.from(new Set(keysToCheck));
    let activeReadError = '';

    // Tai song song trang thai cua tat ca nhan vien
    await Promise.all(
      uniqueKeys.map(async (k) => {
        try {
          const res = await httpsReq(`https://keyvalue.immanuel.co/api/KeyVal/GetValue/${encodeURIComponent(cloudKey)}/act_${encodeURIComponent(k)}`, 'GET');
          if (res.status === 200 && res.body) {
            let raw = res.body.trim();
            if (raw.startsWith('"') && raw.endsWith('"')) {
              try { raw = JSON.parse(raw); } catch {}
            }
            if (raw && raw !== 'OFF' && raw.length > 5) {
              const parsed = parseCloudJsonValue(raw);
              if (parsed && typeof parsed === 'object') {
                let activeShops = Array.isArray(parsed.shops) ? parsed.shops : [];
                const chunkCount = Math.max(0, Math.min(1000, parseInt(parsed.shopChunks, 10) || 0));
                if (chunkCount) {
                  const chunks = [];
                  for (let index = 0; index < chunkCount; index++) {
                    const chunkResponse = await httpsReq(
                      `https://keyvalue.immanuel.co/api/KeyVal/GetValue/${encodeURIComponent(cloudKey)}/actshops_${encodeURIComponent(k)}_${index}`,
                      'GET'
                    );
                    if (chunkResponse.status !== 200) {
                      throw new Error(cloudResponseError(chunkResponse, `Không đọc được danh sách shop của ${k}`));
                    }
                    chunks.push(decodeCloudString(chunkResponse.body));
                  }
                  activeShops = JSON.parse(
                    zlib.inflateRawSync(Buffer.from(chunks.join(''), 'base64url')).toString('utf8')
                  );
                  if (!Array.isArray(activeShops)) {
                    throw new Error(`Danh sách shop của ${k} trên Cloud không hợp lệ`);
                  }
                }
                cloudActiveCache.set(k, {
                  who: parsed.who || 'Nhân viên',
                  role: parsed.role || 'cskh',
                  time: Number(parsed.time) || 0,
                  shops: activeShops,
                  proxyIssues: Array.isArray(parsed.proxyIssues) ? parsed.proxyIssues : [],
                  activityPending: Math.max(0, Math.min(100, parseInt(parsed.activityPending, 10) || 0)),
                  latestActivity: normalizeActiveActivity(parsed.latestActivity, parsed.userKey || k, parsed.who || 'Nhân viên'),
                  lastFetched: Date.now()
                });
                return;
              }
            } else if (raw === 'OFF') {
              cloudActiveCache.delete(k);
              return;
            }
          } else if (res.status !== 404) {
            activeReadError = activeReadError || res.error || `Cloud trả về HTTP ${res.status} khi đọc trạng thái ${k}`;
          }
        } catch (e) {
          activeReadError = activeReadError || e.message;
          const now = Date.now();
          if (now - lastActiveFetchWarningAt >= 60000) {
            console.warn('Không đọc được trạng thái nhân viên từ Cloud:', e.message);
            lastActiveFetchWarningAt = now;
          }
        }
      })
    );

    const activeMap = {};
    const usersMap = {};
    const now = Date.now();
    const TTL = 180 * 1000; // 3 phut timeout

    for (const k of uniqueKeys) {
      const item = cloudActiveCache.get(k);
      if (!item) {
        usersMap[k] = {
          userKey: k,
          who: 'Nhân viên',
          role: 'cskh',
          time: 0,
          isOnline: false,
          isRunning: false,
          shops: [],
          proxyIssues: [],
          activityPending: 0,
          latestActivity: null
        };
        continue;
      }
      const { who, role, time, shops } = item;
      const t = Number(time) || 0;
      const isAlive = (t > 0 && Math.abs(now - t) <= TTL);
      const activeShops = (isAlive && Array.isArray(shops)) ? shops : [];

      usersMap[k] = {
        userKey: k,
        who: who || 'Nhân viên',
        role: role || 'cskh',
        time: t,
        isOnline: isAlive,
        isRunning: isAlive && activeShops.length > 0,
        shops: activeShops,
        proxyIssues: Array.isArray(item.proxyIssues) ? item.proxyIssues : [],
        activityPending: Math.max(0, Math.min(100, parseInt(item.activityPending, 10) || 0)),
        latestActivity: item.latestActivity || null
      };

      if (isAlive && Array.isArray(shops)) {
        for (const sid of shops) {
          activeMap[sid] = {
            who: who || 'Nhân viên',
            role: role || 'cskh',
            userKey: k,
            time: t
          };
        }
      }
    }
    return {
      shops: activeMap,
      users: usersMap,
      ...(activeReadError ? { error: activeReadError } : {})
    };
  } catch (e) {
    return { shops: {}, users: {}, error: e.message };
  }
});

function parseCloudJsonValue(body) {
  let raw = decodeCloudString(body);
  if (!raw) return null;
  if (!raw || raw === 'OFF') return null;
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    try {
      return JSON.parse(zlib.inflateRawSync(Buffer.from(raw, 'base64url')).toString('utf8'));
    } catch {}
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

function activityCloudUrl(cloudKey, key, value, compressed = false) {
  const baseUrl = `https://keyvalue.immanuel.co/api/KeyVal/UpdateValue/${encodeURIComponent(cloudKey)}/${encodeURIComponent(key)}`;
  if (value === undefined) return baseUrl;
  const json = Buffer.from(JSON.stringify(value), 'utf8');
  const encoded = compressed
    ? zlib.deflateRawSync(json, { level: 9 }).toString('base64url')
    : json.toString('base64url');
  return `${baseUrl}/${encoded}`;
}

async function saveCloudActivityEvent(cloudKey, userKey, event) {
  const eventKey = `event_${userKey}_${event.id}`;
  const compactEvent = {
    action: event.action,
    shopId: String(event.shopId || '').slice(0, 80),
    time: Number(event.time) || Date.now()
  };
  const saved = await httpsReq(activityCloudUrl(cloudKey, eventKey, compactEvent, true), 'POST', '');
  if (saved.status !== 200) {
    return { ok: false, error: cloudResponseError(saved, 'Không lưu được sự kiện hoạt động lên Cloud') };
  }
  return { ok: true };
}

async function readCloudActivityIndex(cloudKey, userKey, stored) {
  const chunkCount = Math.max(0, Math.min(1000, parseInt(stored && stored.indexChunks, 10) || 0));
  if (!chunkCount) return stored;

  const chunks = [];
  for (let index = 0; index < chunkCount; index++) {
    const url = `https://keyvalue.immanuel.co/api/KeyVal/GetValue/${encodeURIComponent(cloudKey)}/historychunks_${encodeURIComponent(userKey)}_${index}`;
    const response = await httpsReq(url, 'GET');
    if (response.status !== 200) {
      throw new Error(cloudResponseError(response, `Không đọc được chỉ mục hoạt động của ${userKey}`));
    }
    chunks.push(decodeCloudString(response.body));
  }
  const expanded = parseCloudJsonValue(chunks.join(''));
  if (!expanded || typeof expanded !== 'object') {
    throw new Error(`Chỉ mục hoạt động của ${userKey} trên Cloud không hợp lệ`);
  }
  return expanded;
}

async function saveCloudActivityIndex(cloudKey, userKey, eventIds) {
  const valueKey = `history_${userKey}`;
  const packedIndex = zlib.deflateRawSync(Buffer.from(JSON.stringify({ ids: eventIds }), 'utf8'), { level: 9 })
    .toString('base64url');
  let url = activityCloudUrl(cloudKey, valueKey, { ids: eventIds }, true);

  if (url.length > 240) {
    const chunks = packedIndex.match(/.{1,100}/g) || [];
    for (let index = 0; index < chunks.length; index++) {
      const chunkUrl = `https://keyvalue.immanuel.co/api/KeyVal/UpdateValue/${encodeURIComponent(cloudKey)}/historychunks_${encodeURIComponent(userKey)}_${index}/${chunks[index]}`;
      const chunkResponse = await httpsReq(chunkUrl, 'POST', '');
      if (chunkResponse.status !== 200) {
        return {
          ok: false,
          error: cloudResponseError(chunkResponse, `Không lưu được chỉ mục hoạt động (phần ${index + 1}/${chunks.length})`)
        };
      }
    }
    url = activityCloudUrl(cloudKey, valueKey, { indexChunks: chunks.length }, true);
  }

  if (url.length > 240) {
    return { ok: false, error: 'Chỉ mục hoạt động vượt giới hạn URL Cloud.' };
  }
  const response = await httpsReq(url, 'POST', '');
  return response.status === 200
    ? { ok: true }
    : { ok: false, error: cloudResponseError(response, 'Không lưu được danh sách lịch sử Cloud') };
}

ipcMain.handle('cloud:appendActivity', async (_e, event) => {
  try {
    if (!event || !['open', 'close', 'login', 'logout'].includes(event.action)) {
      return { ok: false, error: 'Loại hoạt động không hợp lệ' };
    }
    const rawKey = String(event.userKey || 'admin').trim();
    const userKey = rawKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    const shopId = String(event.shopId || '').trim().slice(0, 80);
    const shopName = String(event.shopName || '').trim().slice(0, 80);
    const isShopEvent = event.action === 'open' || event.action === 'close';
    if (!userKey || (isShopEvent && (!shopId || !shopName))) {
      return { ok: false, error: 'Thiếu thông tin nhân viên hoặc shop' };
    }

    const settings = readJson(settingsFile(), {});
    const cloudKey = (settings.cloudKey || DEFAULT_CLOUD_KEY).trim();
    const valueKey = `history_${userKey}`;
    const getUrl = `https://keyvalue.immanuel.co/api/KeyVal/GetValue/${encodeURIComponent(cloudKey)}/${encodeURIComponent(valueKey)}`;
    const current = await httpsReq(getUrl, 'GET');
    if (current.status !== 200 && current.status !== 404) {
      return { ok: false, error: current.error || `Không đọc được lịch sử Cloud (HTTP ${current.status})` };
    }

    const storedValue = current.status === 200 ? parseCloudJsonValue(current.body) : null;
    const stored = await readCloudActivityIndex(cloudKey, userKey, storedValue);
    const events = Array.isArray(stored && stored.events) ? stored.events : [];
    const eventId = String(event.id || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 50);
    const nextEvent = {
      id: eventId,
      action: event.action,
      userKey,
      userName: String(event.userName || 'Nhân viên').trim().slice(0, 40),
      shopId: isShopEvent ? shopId : '',
      shopName: isShopEvent ? shopName : '',
      time: Number(event.time) || Date.now()
    };

    let eventIds = Array.isArray(stored && stored.ids)
      ? stored.ids.map((id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '_')).slice(-14)
      : [];
    if (!eventIds.length && Array.isArray(stored && stored.events)) {
      const legacyEvents = stored.events
        .filter((item) => item && item.id && ['open', 'close', 'login', 'logout'].includes(item.action))
        .slice(-14);
      for (const oldEvent of legacyEvents) {
        const safeEvent = {
          ...oldEvent,
          id: String(oldEvent.id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50),
          userKey
        };
        const migrated = await saveCloudActivityEvent(cloudKey, userKey, safeEvent);
        if (!migrated.ok) return migrated;
        eventIds.push(safeEvent.id);
      }
    }

    const savedEvent = await saveCloudActivityEvent(cloudKey, userKey, nextEvent);
    if (!savedEvent.ok) return savedEvent;
    eventIds = [...eventIds.filter((id) => id !== eventId), eventId].slice(-15);
    const savedIndex = await saveCloudActivityIndex(cloudKey, userKey, eventIds);
    if (!savedIndex.ok) return savedIndex;
    return { ok: true, event: nextEvent };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('cloud:getActivity', async () => {
  try {
    const settings = readJson(settingsFile(), {});
    const cloudKey = (settings.cloudKey || DEFAULT_CLOUD_KEY).trim();
    const members = readMembers();
    const userKeys = Array.from(new Set([
      'admin',
      ...members.map((member) => String(member.id).trim().replace(/[^a-zA-Z0-9_-]/g, '_'))
    ]));
    const memberNames = new Map(
      members.map((member) => [String(member.id).trim().replace(/[^a-zA-Z0-9_-]/g, '_'), member.name])
    );
    const shopNames = new Map(readShops().map((shop) => [shop.id, shop.name]));
    const results = await Promise.all(userKeys.map(async (userKey) => {
      const url = `https://keyvalue.immanuel.co/api/KeyVal/GetValue/${encodeURIComponent(cloudKey)}/history_${encodeURIComponent(userKey)}`;
      const response = await httpsReq(url, 'GET');
      if (response.status === 404 || (response.status === 200 && !response.body.trim())) {
        return { events: [], error: null };
      }
      if (response.status !== 200) {
        return { events: [], error: response.error || `HTTP ${response.status}` };
      }
      const storedValue = parseCloudJsonValue(response.body);
      const stored = await readCloudActivityIndex(cloudKey, userKey, storedValue);
      if (Array.isArray(stored && stored.events)) {
        return { events: stored.events, error: null };
      }
      const eventIds = Array.isArray(stored && stored.ids)
        ? stored.ids.map((id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '_')).slice(-15)
        : [];
      const eventResults = await Promise.all(eventIds.map(async (eventId) => {
        const eventKey = `event_${userKey}_${eventId}`;
        const eventUrl = `https://keyvalue.immanuel.co/api/KeyVal/GetValue/${encodeURIComponent(cloudKey)}/${encodeURIComponent(eventKey)}`;
        const eventResponse = await httpsReq(eventUrl, 'GET');
        if (eventResponse.status === 404 || (eventResponse.status === 200 && !eventResponse.body.trim())) {
          return { event: null, error: null };
        }
        if (eventResponse.status !== 200) {
          return { event: null, error: eventResponse.error || `HTTP ${eventResponse.status}` };
        }
        const parsed = parseCloudJsonValue(eventResponse.body);
        return {
          event: parsed && typeof parsed === 'object'
            ? {
                ...parsed,
                id: parsed.id || eventId,
                userKey: parsed.userKey || userKey,
                userName: parsed.userName || memberNames.get(userKey) || (userKey === 'admin' ? readAuthObj().adminUser : 'Nhân viên'),
                shopName: parsed.shopName || shopNames.get(parsed.shopId) || ''
              }
            : null,
          error: null
        };
      }));
      const eventError = eventResults.find((result) => result.error);
      return {
        events: eventResults.map((result) => result.event).filter(Boolean),
        error: eventError ? eventError.error : null
      };
    }));
    const events = results
      .flatMap((result) => result.events)
      .sort((a, b) => Number(b.time) - Number(a.time))
      .slice(0, 100);
    const errors = results.filter((result) => result.error).map((result) => result.error);
    return {
      ok: errors.length === 0,
      events,
      error: errors.length ? `Không tải được một số lịch sử hoạt động: ${errors[0]}` : null
    };
  } catch (e) {
    return { ok: false, events: [], error: e.message };
  }
});

// Xuat danh sach gian hang + tai khoan cua 1 thanh vien ra file JSON de gui cho nhan vien do
ipcMain.handle('shops:exportMember', async (_e, payload) => {
  const member = payload && payload.member ? payload.member : null;
  const memberName = (member && member.name) || (payload && payload.memberName) || 'member';
  const memberShops = payload && Array.isArray(payload.shops) ? payload.shops : [];
  const safeName = String(memberName).trim().replace(/[^a-zA-Z0-9_-]/g, '-') || 'member';
  const dateStr = new Date().toISOString().slice(0, 10);
  const r = await dialog.showSaveDialog({
    title: `Xuất gói phân quyền gian hàng cho nhân viên: ${memberName}`,
    defaultPath: `tiktok-phanquyen-${safeName}-${dateStr}.json`,
    filters: [{ name: 'JSON Files', extensions: ['json'] }]
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    const pkg = {
      version: 2,
      type: 'member_package',
      member,
      shops: memberShops
    };
    fs.writeFileSync(r.filePath, JSON.stringify(pkg, null, 2), 'utf8');
    return { ok: true, count: memberShops.length, filePath: r.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Xuat danh sach gian hang + thanh vien ra file JSON (Backup)
ipcMain.handle('shops:export', async () => {
  const shops = readShops();
  const members = readMembers();
  const dateStr = new Date().toISOString().slice(0, 10);
  const r = await dialog.showSaveDialog({
    title: 'Xuất dữ liệu hệ thống (Gian hàng + Thành viên)',
    defaultPath: `tiktok-shops-backup-${dateStr}.json`,
    filters: [{ name: 'JSON Files', extensions: ['json'] }]
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    const pkg = {
      version: 2,
      type: 'full_backup',
      shops,
      members
    };
    fs.writeFileSync(r.filePath, JSON.stringify(pkg, null, 2), 'utf8');
    return { ok: true, count: shops.length, filePath: r.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Nhap danh sach gian hang & thanh vien tu file JSON (Restore / Merge / Nhan vien nhap file phan quyen)
ipcMain.handle('shops:import', async () => {
  const r = await dialog.showOpenDialog({
    title: 'Nhập dữ liệu gian hàng / Gói phân quyền nhân viên (.json)',
    properties: ['openFile'],
    filters: [{ name: 'JSON Files', extensions: ['json'] }]
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
  try {
    const raw = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.shops) ? raw.shops : null);
    if (!Array.isArray(list)) {
      return { ok: false, error: 'File JSON không hợp lệ (không phải danh sách gian hàng)' };
    }
    const current = readShops();
    let added = 0;
    let updated = 0;
    for (const item of list) {
      if (!item || typeof item !== 'object' || !item.name) continue;
      const clean = {
        id: item.id ? String(item.id) : (Date.now() + Math.floor(Math.random() * 10000)).toString(36),
        name: String(item.name).trim(),
        platform: item.platform === 'shopee' ? 'shopee' : 'tiktok',
        sellerUrl: typeof item.sellerUrl === 'string' ? item.sellerUrl.trim() : '',
        adsUrl: item.adsUrl || (item.platform === 'shopee' ? DEFAULT_ADS : item.sellerUrl) || DEFAULT_ADS,
        ordersUrl: item.ordersUrl || DEFAULT_ORDERS,
        cskhChatUrl: item.cskhChatUrl || DEFAULT_CSKH_CHAT,
        cskhOrdersUrl: item.cskhOrdersUrl || DEFAULT_CSKH_ORDERS,
        linkMode: item.linkMode || 'ads',
        color: item.color || '#0f9d94',
        group: item.group ? String(item.group).trim() : '',
        note: item.note ? String(item.note).trim() : '',
        proxy: item.proxy ? String(item.proxy).trim() : '',
        memberIds: Array.isArray(item.memberIds) ? item.memberIds.map(String) : []
      };
      const existingIdx = current.findIndex((x) => x.id === clean.id);
      if (existingIdx >= 0) {
        current[existingIdx] = { ...current[existingIdx], ...clean };
        updated++;
      } else {
        current.push(clean);
        added++;
      }
    }
    writeJson(shopsFile(), current);

    // Neu file co kem thong tin thanh vien (full_backup hoac member_package)
    const currentMembers = readMembers();
    const incomingMembers = [];
    if (raw && Array.isArray(raw.members)) {
      incomingMembers.push(...raw.members);
    }
    if (raw && raw.member && typeof raw.member === 'object' && raw.member.id) {
      incomingMembers.push(raw.member);
    }
    for (const m of incomingMembers) {
      if (!m || !m.id || !m.name) continue;
      const mIdx = currentMembers.findIndex((x) => x.id === m.id);
      if (mIdx >= 0) {
        currentMembers[mIdx] = { ...currentMembers[mIdx], ...m };
      } else {
        currentMembers.push(m);
      }
    }
    if (incomingMembers.length > 0) {
      writeJson(membersFile(), currentMembers);
    }

    return {
      ok: true,
      shops: current,
      members: currentMembers,
      importedMember: (raw && raw.member) || null,
      added,
      updated
    };
  } catch (e) {
    return { ok: false, error: 'Không đọc được file: ' + e.message };
  }
});

ipcMain.handle('browser:get', () => findBrowser());
ipcMain.handle('browser:pick', async () => {
  const filters = process.platform === 'win32' ? [{ name: 'Chrome / Edge', extensions: ['exe'] }] : [];
  const r = await dialog.showOpenDialog({
    title: 'Chon file chrome.exe (hoac msedge.exe)',
    properties: ['openFile'],
    filters
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const s = readJson(settingsFile(), {});
  s.browserPath = r.filePaths[0];
  writeJson(settingsFile(), s);
  return r.filePaths[0];
});

// Quan ly cac tien trinh Chrome dang mo theo tung shop
const runningShops = new Map();
const shopChildProcesses = new Map();
const proxyForwarders = new Map();
const profileProbePending = new Set();

function isProcessAlive(pid) {
  const p = parseInt(pid, 10);
  if (!p || p <= 0) return false;
  try {
    process.kill(p, 0);
    return true;
  } catch {
    return false;
  }
}

function isProfileLocked(profileDir) {
  if (process.platform === 'win32') return false;
  const lock = path.join(profileDir, 'lockfile');
  if (!fs.existsSync(lock)) return false;
  try {
    const fd = fs.openSync(lock, 'r+');
    fs.closeSync(fd);
    return false;
  } catch (e) {
    return e.code === 'EBUSY' || e.code === 'EPERM';
  }
}

function stopProxyForwarder(shopId) {
  const srv = proxyForwarders.get(shopId);
  if (srv) {
    try {
      srv.close();
    } catch {}
    proxyForwarders.delete(shopId);
  }
}

function syncRunningShops() {
  const shops = readShops();
  const activeIds = [];
  for (const s of shops) {
    const dir = path.join(profilesRoot(), safeId(s.id));
    const pidFile = path.join(dir, '.chrome_pid');
    let pid = runningShops.get(s.id);
    if (!pid && fs.existsSync(pidFile)) {
      try {
        const saved = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
        if (saved > 0) pid = saved;
      } catch {}
    }
    if (profileProbePending.has(s.id)) {
      activeIds.push(s.id);
      continue;
    }
    // Tren Windows, PID moi la dau hieu dang tin cay; lockfile co the con lai sau khi Chrome dong.
    const alive = (pid && isProcessAlive(pid)) || isProfileLocked(dir);
    if (alive) {
      if (!runningShops.has(s.id) && pid) runningShops.set(s.id, pid);
      activeIds.push(s.id);
    } else {
      if (runningShops.has(s.id)) runningShops.delete(s.id);
      stopProxyForwarder(s.id);
      if (fs.existsSync(pidFile)) {
        try {
          fs.unlinkSync(pidFile);
        } catch {}
      }
    }
  }
  return activeIds;
}

let lastRunningSignature = '';
function notifyRunningChanged(force = false) {
  const ids = syncRunningShops();
  const sig = ids.slice().sort().join(',');
  if (!force && sig === lastRunningSignature) return ids;
  lastRunningSignature = sig;
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send('shops:runningChanged', ids);
    } catch {}
  }
  return ids;
}

ipcMain.handle('shops:running', () => notifyRunningChanged(true));

// Phan tich chuoi Proxy: ho tro IP:Port, IP:Port:User:Pass, http://user:pass@ip:port, socks5://ip:port
function parseProxyString(raw) {
  if (!raw || !String(raw).trim()) return null;
  const str = String(raw).trim();

  try {
    if (str.includes('://')) {
      const u = new URL(str);
      return {
        protocol: u.protocol.replace(':', '') || 'http',
        host: u.hostname,
        port: parseInt(u.port, 10),
        username: decodeURIComponent(u.username || ''),
        password: decodeURIComponent(u.password || '')
      };
    }
  } catch {}

  const parts = str.split(':');
  if (parts.length === 2) {
    return {
      protocol: 'http',
      host: parts[0],
      port: parseInt(parts[1], 10),
      username: '',
      password: ''
    };
  }
  if (parts.length >= 4) {
    return {
      protocol: 'http',
      host: parts[0],
      port: parseInt(parts[1], 10),
      username: parts[2],
      password: parts.slice(3).join(':')
    };
  }
  return null;
}

// Kiem tra Proxy Live hay Die, tra ve IP thuc te, Quoc gia va do tre (ms)
function checkProxyHealth(rawProxy) {
  return new Promise((resolve) => {
    const cfg = parseProxyString(rawProxy);
    if (!cfg || !cfg.host || !cfg.port || Number.isNaN(cfg.port)) {
      return resolve({
        ok: false,
        error: 'Sai định dạng Proxy (VD đúng: IP:Port hoặc IP:Port:User:Pass)'
      });
    }

    const t0 = Date.now();
    const headers = {
      Host: 'ip-api.com',
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json'
    };
    if (cfg.username) {
      headers['Proxy-Authorization'] =
        'Basic ' + Buffer.from(`${cfg.username}:${cfg.password || ''}`).toString('base64');
    }

    let settled = false;
    const done = (resObj) => {
      if (settled) return;
      settled = true;
      resolve(resObj);
    };

    const req = http.request(
      {
        host: cfg.host,
        port: cfg.port,
        method: 'GET',
        path: 'http://ip-api.com/json/?fields=status,countryCode,query',
        headers,
        timeout: 6500
      },
      (res) => {
        if (res.statusCode === 407) {
          res.resume();
          return done({ ok: false, error: 'Sai User hoặc Pass của Proxy (Lỗi 407)' });
        }
        let body = '';
        res.on('data', (d) => {
          body += d.toString();
        });
        res.on('end', () => {
          const ms = Date.now() - t0;
          try {
            const data = JSON.parse(body);
            if (data && data.query) {
              return done({
                ok: true,
                ip: data.query,
                country: data.countryCode || '',
                ms
              });
            }
          } catch {}
          if (res.statusCode >= 200 && res.statusCode < 400) {
            return done({ ok: true, ip: cfg.host, country: '', ms });
          }
          done({ ok: false, error: 'Proxy không phản hồi hợp lệ (Mã ' + res.statusCode + ')' });
        });
      }
    );

    req.on('timeout', () => {
      try {
        req.destroy();
      } catch {}
      done({ ok: false, error: 'Quá thời gian chờ (Timeout - Proxy Die)' });
    });

    req.on('error', () => {
      done({ ok: false, error: 'Không kết nối được Proxy (Proxy Die)' });
    });

    req.end();
  });
}

ipcMain.handle('proxy:check', (_e, rawProxy) => checkProxyHealth(rawProxy));

// Tao proxy local tu dong dien User/Pass de Chrome khong bao gio hoi popup dang nhap Proxy
function createAuthenticatedProxyForwarder(shopId, proxyCfg) {
  return new Promise((resolve) => {
    stopProxyForwarder(shopId);
    if (!proxyCfg || !proxyCfg.host || !proxyCfg.port) return resolve(null);

    if (!proxyCfg.username) {
      const scheme = proxyCfg.protocol === 'socks5' ? 'socks5://' : 'http://';
      return resolve(`${scheme}${proxyCfg.host}:${proxyCfg.port}`);
    }

    const authHeader =
      'Basic ' + Buffer.from(`${proxyCfg.username}:${proxyCfg.password || ''}`).toString('base64');

    const server = http.createServer((clientReq, clientRes) => {
      const options = {
        host: proxyCfg.host,
        port: proxyCfg.port,
        method: clientReq.method,
        path: clientReq.url,
        headers: {
          ...clientReq.headers,
          'Proxy-Authorization': authHeader
        }
      };
      const proxyReq = http.request(options, (proxyRes) => {
        clientRes.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(clientRes);
      });
      proxyReq.on('error', () => {
        try {
          clientRes.writeHead(502);
          clientRes.end('Proxy Error');
        } catch {}
      });
      clientReq.pipe(proxyReq);
    });

    server.on('connect', (req, clientSocket, head) => {
      const upstream = net.connect(proxyCfg.port, proxyCfg.host, () => {
        const connectReq =
          `CONNECT ${req.url} HTTP/1.1\r\n` +
          `Host: ${req.url}\r\n` +
          `Proxy-Authorization: ${authHeader}\r\n` +
          `Proxy-Connection: keep-alive\r\n\r\n`;
        upstream.write(connectReq);
        if (head && head.length) upstream.write(head);

        let headerBuf = Buffer.alloc(0);
        const onData = (chunk) => {
          headerBuf = Buffer.concat([headerBuf, chunk]);
          const idx = headerBuf.indexOf('\r\n\r\n');
          if (idx !== -1) {
            upstream.removeListener('data', onData);
            const firstLine = headerBuf.slice(0, idx).toString('utf8').split('\r\n')[0];
            if (firstLine.includes(' 200 ')) {
              clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
              const rest = headerBuf.slice(idx + 4);
              if (rest.length) clientSocket.write(rest);
              upstream.pipe(clientSocket);
              clientSocket.pipe(upstream);
            } else {
              clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
              clientSocket.destroy();
              upstream.destroy();
            }
          }
        };
        upstream.on('data', onData);
      });

      upstream.on('error', () => {
        try {
          clientSocket.destroy();
        } catch {}
      });
      clientSocket.on('error', () => {
        try {
          upstream.destroy();
        } catch {}
      });
    });

    server.on('error', () => resolve(`${proxyCfg.host}:${proxyCfg.port}`));
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && addr.port) {
        proxyForwarders.set(shopId, server);
        resolve(`http://127.0.0.1:${addr.port}`);
      } else {
        resolve(`${proxyCfg.host}:${proxyCfg.port}`);
      }
    });
  });
}

function focusShopWindow(pid, profileDir) {
  return new Promise((resolve) => {
    const targetPid = parseInt(pid, 10) || 0;

    if (process.platform === 'darwin') {
      const escapedDir = (profileDir || '').replace(/(["\\$`])/g, '\\$1');
      const sh = `
pid=${targetPid}
if [ "$pid" -le 0 ] || ! kill -0 "$pid" 2>/dev/null; then
  pid=$(ps -ax -o pid=,command= | grep -F -- "--user-data-dir=${escapedDir}" | grep -v -- "--type=" | grep -v grep | head -n 1 | awk '{print $1}')
fi
if [ -n "$pid" ] && [ "$pid" -gt 0 ] 2>/dev/null && kill -0 "$pid" 2>/dev/null; then
  osascript -l JavaScript -e '
    ObjC.import("AppKit");
    var p = '"$pid"';
    var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(p);
    if (app && !app.isTerminated) {
      try {
        var se = Application("System Events");
        var procs = se.processes.whose({ unixId: p })();
        if (procs.length > 0) {
          var wins = procs[0].windows();
          if (wins.length === 0) {
            $.exit(1);
          }
          var anyUnminimized = false;
          for (var i = 0; i < wins.length; i++) {
            try {
              if (!wins[i].attributes.byName("AXMinimized").value()) {
                anyUnminimized = true;
                break;
              }
            } catch (e) { anyUnminimized = true; }
          }
          if (!anyUnminimized) {
            try { wins[0].attributes.byName("AXMinimized").value = false; } catch (e) {}
          }
        }
      } catch (e) {}
      app.activateWithOptions(3);
      console.log("ACTIVATED:" + p);
    }
  ' 2>&1
fi
`;
      try {
        const child = spawn('/bin/sh', ['-c', sh], { stdio: ['ignore', 'pipe', 'ignore'] });
        let stdout = '';
        child.stdout.on('data', (d) => {
          stdout += d.toString();
        });
        child.on('error', () => resolve({ ok: false }));
        child.on('close', () => {
          const match = stdout.match(/ACTIVATED:(\d+)/);
          if (match) {
            resolve({ ok: true, pid: parseInt(match[1], 10) });
          } else {
            resolve({ ok: false });
          }
        });
      } catch {
        resolve({ ok: false });
      }
      return;
    }

    if (process.platform !== 'win32') {
      return resolve({ ok: false });
    }

    const escapedDir = (profileDir || '').replace(/'/g, "''");

    const ps = `
Add-Type @'
  using System;
  using System.Text;
  using System.Collections.Generic;
  using System.Runtime.InteropServices;

  public class WinFocus {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

    [DllImport("user32.dll")]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    public static List<IntPtr> GetProcessWindows(uint pid) {
      List<IntPtr> list = new List<IntPtr>();
      EnumWindows((hWnd, lParam) => {
        uint p;
        GetWindowThreadProcessId(hWnd, out p);
        if (p == pid && IsWindowVisible(hWnd)) {
          IntPtr owner = GetWindow(hWnd, 4); // GW_OWNER = 4
          if (owner == IntPtr.Zero && GetWindowTextLength(hWnd) > 0) {
            var cls = new StringBuilder(256);
            GetClassName(hWnd, cls, 256);
            if (cls.ToString() == "Chrome_WidgetWin_1") {
              list.Add(hWnd);
            }
          }
        }
        return true;
      }, IntPtr.Zero);
      return list;
    }

    public static bool ActivateWindow(IntPtr hWnd) {
      // Chi khoi phuc (SW_RESTORE = 9) khi cua so dang bi thu nho xuong thanh Taskbar (IsIconic).
      // Neu cua so dang hien (du dang phong to Maximized hay kich thuoc tuy chinh),
      // giu nguyen 100% kich thuoc cua so, khong thu nho lai.
      if (IsIconic(hWnd)) {
        ShowWindow(hWnd, 9);
      }
      SetForegroundWindow(hWnd);
      SwitchToThisWindow(hWnd, true);
      return true;
    }
  }
'@

$targetPid = ${targetPid}
$targetDir = '${escapedDir}'

$found = $false

# 1. Kiem tra nhanh theo PID da luu truoc
if ($targetPid -gt 0) {
  $wins = [WinFocus]::GetProcessWindows([uint32]$targetPid)
  foreach ($w in $wins) {
    [WinFocus]::ActivateWindow($w) | Out-Null
    $found = $true
  }
  if ($found) {
    Write-Output "ACTIVATED:$targetPid"
    exit 0
  }
}

# 2. Neu chua tim thay, tim theo duong dan profile (--user-data-dir)
if ($targetDir -ne '') {
  try {
    $matched = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' or Name = 'msedge.exe'" | Where-Object { $_.CommandLine -like "*$targetDir*" }
    foreach ($m in $matched) {
      $p = [uint32]$m.ProcessId
      if ($p -eq $targetPid) { continue }
      $wins = [WinFocus]::GetProcessWindows($p)
      foreach ($w in $wins) {
        [WinFocus]::ActivateWindow($w) | Out-Null
        $found = $true
      }
      if ($found) {
        Write-Output "ACTIVATED:$p"
        exit 0
      }
    }
  } catch {}
}

Write-Output "NOT_FOUND"
`;

    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore']
      });
      let stdout = '';
      child.stdout.on('data', (d) => {
        stdout += d.toString();
      });
      child.on('error', () => resolve({ ok: false }));
      child.on('close', () => {
        const match = stdout.match(/ACTIVATED:(\d+)/);
        if (match) {
          resolve({ ok: true, pid: parseInt(match[1], 10) });
        } else {
          resolve({ ok: false });
        }
      });
      child.stdin.write(ps);
      child.stdin.end();
    } catch {
      resolve({ ok: false });
    }
  });
}

function findProfileProcessIds(profileDir, browserOnly = false) {
  return new Promise((resolve) => {
    const escapedDir = profileDir.replace(/'/g, "''");
    const browserOnlyValue = browserOnly ? '$true' : '$false';
    const script = `
$profileDir = '${escapedDir}'
$browserOnly = ${browserOnlyValue}
try {
  Get-CimInstance Win32_Process -ErrorAction Stop |
    Where-Object {
      $commandLine = [string]$_.CommandLine
      if (-not $commandLine -or ($_.Name -ine 'chrome.exe' -and $_.Name -ine 'msedge.exe')) {
        return $false
      }
      if ($browserOnly -and $commandLine -match '(?:^|\\s)--type(?:=|\\s)') {
        return $false
      }
      $profileIndex = $commandLine.IndexOf($profileDir, [StringComparison]::OrdinalIgnoreCase)
      if ($profileIndex -lt 0) {
        return $false
      }
      $profileEnd = $profileIndex + $profileDir.Length
      return $profileEnd -eq $commandLine.Length -or $commandLine[$profileEnd] -in @('"', "'", ' ', "\`t")
    } |
    ForEach-Object { $_.ProcessId }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ pids: [], error: 'Hết thời gian tìm tiến trình Chrome của shop' });
    }, 5000);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const pids = stdout
        .split(/\s+/)
        .map((value) => parseInt(value, 10))
        .filter((value) => value > 0);
      resolve({ pids, error: error && stderr.trim() ? `${error}: ${stderr.trim()}` : error });
    };
    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    child.once('error', (error) => finish(error.message));
    child.once('close', (code) => finish(code === 0 ? null : `PowerShell thoát với mã ${code}`));
    child.stdin.end(script);
  });
}

function verifyShopProcess(pid, profileDir) {
  return new Promise((resolve) => {
    const escapedDir = profileDir.replace(/'/g, "''");
    const script = `
$targetPid = ${parseInt(pid, 10) || 0}
$profileDir = '${escapedDir}'
try {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid" -ErrorAction Stop
  if (-not $process -or ($process.Name -ine 'chrome.exe' -and $process.Name -ine 'msedge.exe')) {
    Write-Output 'NOT_MATCH'
    exit 0
  }
  $commandLine = [string]$process.CommandLine
  $escapedProfile = [regex]::Escape($profileDir)
  if ($commandLine -match ('(?i)--user-data-dir="?'+$escapedProfile+'"?(?=\\s|$)')) {
    Write-Output 'MATCH'
  } else {
    Write-Output 'NOT_MATCH'
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ matches: false, error: 'Hết thời gian xác minh PID Chrome của shop' });
    }, 5000);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        resolve({ matches: false, error: stderr.trim() ? `${error}: ${stderr.trim()}` : error });
        return;
      }
      resolve({ matches: stdout.trim().split(/\s+/).includes('MATCH') });
    };
    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    child.once('error', (error) => finish(error.message));
    child.once('close', (code) => finish(code === 0 ? null : `PowerShell thoát với mã ${code}`));
    child.stdin.end(script);
  });
}

function killShopPid(pid) {
  return new Promise((resolve) => {
    const child = spawn('taskkill', ['/F', '/PID', String(pid), '/T'], {
      windowsHide: true,
      stdio: 'ignore'
    });
    child.once('error', (error) => resolve(error.message));
    child.once('close', (code) => resolve(code === 0 ? null : `taskkill thoát với mã ${code} cho PID ${pid}`));
  });
}

function waitForShopExit(id, pid, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const check = () => {
      const dir = path.join(profilesRoot(), safeId(id));
      if ((!pid || !isProcessAlive(pid)) && !isProfileLocked(dir)) {
        resolve(true);
      } else if (Date.now() - startedAt >= timeoutMs) {
        resolve(false);
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });
}

// Dong Chrome theo profile rieng cua shop va chi bao thanh cong khi profile da thoat.
async function closeShopProcess(id) {
  const dir = path.join(profilesRoot(), safeId(id));
  const pidFile = path.join(dir, '.chrome_pid');
  let pid = runningShops.get(id);
  if (!pid && fs.existsSync(pidFile)) {
    try {
      const saved = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (saved > 0) pid = saved;
    } catch {}
  }

  const finish = () => {
    runningShops.delete(id);
    shopChildProcesses.delete(id);
    stopProxyForwarder(id);
    try {
      fs.unlinkSync(pidFile);
    } catch {}
    notifyRunningChanged(true);
    return { ok: true };
  };

  if (process.platform === 'win32') {
    const result = await findProfileProcessIds(dir);
    if (result.error) {
      return { ok: false, error: result.error };
    }
    const pids = result.pids;
    const launchedChild = shopChildProcesses.get(id);
    if (
      launchedChild &&
      launchedChild.pid &&
      launchedChild.exitCode === null &&
      isProcessAlive(launchedChild.pid) &&
      !pids.includes(launchedChild.pid)
    ) {
      pids.push(launchedChild.pid);
    }
    if (!pids.length) {
      if (pid && isProcessAlive(pid)) {
        const verification = await verifyShopProcess(pid, dir);
        if (verification.error) {
          return { ok: false, error: `Không xác minh được PID Chrome (${pid}) của shop: ${verification.error}` };
        }
        if (verification.matches) {
          pids.push(pid);
        } else {
          return finish();
        }
      }
      if (!pids.length) return finish();
    }
    const killErrors = (await Promise.all(pids.map(killShopPid))).filter(Boolean);
    pid = pids.includes(pid) ? pid : 0;
    if (!(await waitForShopExit(id, pid, 2000))) {
      return { ok: false, error: 'Chưa đóng được Chrome. Hãy thử đóng lại hoặc kiểm tra cửa sổ Chrome của shop.' };
    }
    const remaining = await findProfileProcessIds(dir);
    if (remaining.error) {
      return { ok: false, error: remaining.error };
    }
    if (remaining.pids.length || isProfileLocked(dir)) {
      const detail = killErrors.length ? ` (${killErrors.join('; ')})` : '';
      return { ok: false, error: `Chrome vẫn còn chạy sau khi yêu cầu đóng. Hãy thử lại.${detail}` };
    }
    return finish();
  }

  if ((!pid || !isProcessAlive(pid)) && !isProfileLocked(dir)) {
    return finish();
  }

  if (pid && isProcessAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }

  if (await waitForShopExit(id, pid, 2000)) {
    return finish();
  }

  if (process.platform !== 'win32' && pid && isProcessAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
    if (await waitForShopExit(id, pid, 1500)) {
      return finish();
    }
  }

  return { ok: false, error: 'Chưa đóng được Chrome. Hãy thử đóng lại hoặc kiểm tra cửa sổ Chrome của shop.' };
}

ipcMain.handle('shop:close', (_e, id) => closeShopProcess(id));

ipcMain.handle('shops:closeAll', async () => {
  const ids = syncRunningShops();
  const results = await Promise.all(ids.map((id) => closeShopProcess(id)));
  const closedCount = results.filter((result) => result && result.ok).length;
  const errors = results.filter((result) => result && !result.ok).map((result) => result.error);
  return {
    ok: errors.length === 0,
    closedCount,
    closedIds: ids.filter((_id, index) => results[index] && results[index].ok),
    error: errors.length ? errors.join('; ') : undefined
  };
});

const EXTENSION_ID = 'elhkhdcolgkmokglojljlidmahmlnofh';
let cachedExtDir = null;

function getExtensionDir() {
  if (cachedExtDir && fs.existsSync(path.join(cachedExtDir, 'manifest.json'))) {
    return cachedExtDir;
  }

  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'extension'),
    path.join(__dirname, 'extension'),
    'F:\\tiktok-video-selector\\dist',
    'F:\\tiktok-video-selector'
  ].filter(Boolean);

  const src = candidates.find((p) => fs.existsSync(path.join(p, 'manifest.json')));
  if (!src) return null;

  try {
    const dest = path.join(app.getPath('userData'), 'extension');
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(src, dest, { recursive: true, force: true });
    cachedExtDir = dest;
    return dest;
  } catch {
    cachedExtDir = src;
    return src;
  }
}

function ensureExtensionPinned(profileDir) {
  try {
    const defDir = path.join(profileDir, 'Default');
    fs.mkdirSync(defDir, { recursive: true });
    const prefFile = path.join(defDir, 'Preferences');
    const prefs = readJson(prefFile, {});
    if (!prefs.extensions || typeof prefs.extensions !== 'object') {
      prefs.extensions = {};
    }
    if (!Array.isArray(prefs.extensions.pinned_extensions)) {
      prefs.extensions.pinned_extensions = [];
    }
    if (!prefs.extensions.pinned_extensions.includes(EXTENSION_ID)) {
      prefs.extensions.pinned_extensions.push(EXTENSION_ID);
      writeJson(prefFile, prefs);
    }
  } catch {}
}

function sendCdpCommand(port, wsPath, messageObj) {
  return new Promise((resolve) => {
    try {
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: wsPath,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': key
        },
        timeout: 4000
      });

      req.on('upgrade', (_res, socket) => {
        const payload = Buffer.from(JSON.stringify(messageObj), 'utf8');
        const mask = crypto.randomBytes(4);
        let header;
        if (payload.length < 126) {
          header = Buffer.alloc(2);
          header[0] = 0x81;
          header[1] = 0x80 | payload.length;
        } else {
          header = Buffer.alloc(4);
          header[0] = 0x81;
          header[1] = 0x80 | 126;
          header.writeUInt16BE(payload.length, 2);
        }
        const masked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) {
          masked[i] = payload[i] ^ mask[i & 3];
        }
        socket.write(Buffer.concat([header, mask, masked]));

        const closeTimer = setTimeout(() => {
          try {
            socket.destroy();
          } catch {}
          resolve(false);
        }, 4000);

        socket.on('data', (chunk) => {
          const str = chunk.toString('utf8');
          if (str.includes('result') || str.includes('error')) {
            clearTimeout(closeTimer);
            try {
              socket.destroy();
            } catch {}
            resolve(str.includes('result'));
          }
        });

        socket.on('error', () => {
          clearTimeout(closeTimer);
          resolve(false);
        });
      });

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        try {
          req.destroy();
        } catch {}
        resolve(false);
      });
      req.end();
    } catch {
      resolve(false);
    }
  });
}

function loadExtensionViaCDP(profileDir, extDir) {
  if (!extDir) return;
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  let attempts = 0;
  let busy = false;

  const timer = setInterval(async () => {
    if (busy) return;
    attempts++;
    if (attempts > 60) {
      clearInterval(timer);
      return;
    }
    if (!fs.existsSync(portFile)) return;

    let lines;
    try {
      lines = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
    } catch {
      return;
    }
    if (!lines || lines.length < 2) return;

    const port = parseInt(lines[0], 10);
    const wsPath = lines[1].trim();
    if (!port || !wsPath) return;

    busy = true;
    const ok = await sendCdpCommand(port, wsPath, {
      id: 1,
      method: 'Extensions.loadUnpacked',
      params: { path: extDir }
    });
    busy = false;
    if (ok) {
      clearInterval(timer);
    }
  }, 300);
}

// Mo gian: neu Chrome cua gian da mo thi dua len tren, neu chua thi chay Chrome voi profile rieng.
ipcMain.handle('shop:open', async (_e, id, which, overrideUrl, allowGmvExtension) => {
  const shop = readShops().find((s) => s.id === id);
  if (!shop) return { ok: false, error: 'Khong tim thay gian hang' };

  const browser = findBrowser();
  if (!browser) return { ok: false, error: 'NO_BROWSER' };

  const urls = [];
  if (shop.platform === 'shopee') {
    urls.push(shop.sellerUrl || DEFAULT_SHOPEE_URL);
  } else if (overrideUrl && typeof overrideUrl === 'string' && overrideUrl.startsWith('http')) {
    urls.push(overrideUrl);
  } else {
    if (which === 'tiktok' || which === 'seller') urls.push(shop.sellerUrl || 'https://seller-vn.tiktok.com/homepage');
    if (which === 'ads' || which === 'both') urls.push(shop.adsUrl || shop.sellerUrl || DEFAULT_ADS);
    if (which === 'orders' || which === 'both') urls.push(shop.ordersUrl || DEFAULT_ORDERS);
    if (which === 'cskh' || which === 'cskh_orders' || which === 'cskh_both' || which === 'cskh_chat') {
      urls.push(shop.cskhOrdersUrl || DEFAULT_CSKH_ORDERS);
    }
    if (!urls.length) urls.push(shop.sellerUrl || 'https://seller-vn.tiktok.com/homepage');
  }

  const dir = path.join(profilesRoot(), safeId(id));
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, error: 'Khong tao duoc thu muc profile: ' + e.message };
  }

  const pidFile = path.join(dir, '.chrome_pid');
  let knownPid = runningShops.get(id);
  if (!knownPid && fs.existsSync(pidFile)) {
    try {
      const saved = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (saved > 0) knownPid = saved;
    } catch {}
  }

  const extensionAllowed = shop.platform !== 'shopee' && allowGmvExtension === true;
  const extDir = extensionAllowed ? getExtensionDir() : null;

  // Chi quet cua so cu khi profile dang chay; tranh khoi dong PowerShell tren moi lan mo shop.
  const hasExistingProcess = Boolean((knownPid && isProcessAlive(knownPid)) || isProfileLocked(dir));
  const focusRes = hasExistingProcess
    ? await focusShopWindow(knownPid, dir)
    : { ok: false };
  if (focusRes.ok) {
    runningShops.set(id, focusRes.pid);
    try {
      fs.writeFileSync(pidFile, String(focusRes.pid), 'utf8');
    } catch {}
    if (extDir) {
      loadExtensionViaCDP(dir, extDir);
    }
    notifyRunningChanged(true);
    return {
      ok: true,
      alreadyOpen: true,
      extensionAccessNeedsRestart: shop.platform !== 'shopee' && !extensionAllowed
    };
  }

  // Chuan bi extension TikTok GMV Video Selector de tu dong nap vao Chrome
  if (extensionAllowed && extDir) ensureExtensionPinned(dir);
  try {
    fs.unlinkSync(path.join(dir, 'DevToolsActivePort'));
  } catch {}

  // Neu chua mo hoac da dong: mo Chrome moi kem extension va Proxy (neu co)
  const args = [
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window'
  ];
  if (!extensionAllowed) args.push('--disable-extensions');

  if (shop.proxy && String(shop.proxy).trim()) {
    const parsedProxy = parseProxyString(shop.proxy);
    if (parsedProxy) {
      const proxyArg = await createAuthenticatedProxyForwarder(id, parsedProxy);
      if (proxyArg) {
        args.push(`--proxy-server=${proxyArg}`);
      }
    }
  } else {
    stopProxyForwarder(id);
  }

  if (extensionAllowed && extDir) {
    args.push(
      '--enable-unsafe-extension-debugging',
      '--remote-debugging-port=0',
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      `--load-extension=${extDir}`
    );
  }
  args.push(...urls);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(browser, args, { detached: true, stdio: 'ignore' });
    } catch (e) {
      return resolve({ ok: false, error: e.message });
    }
    child.once('error', (e) => resolve({ ok: false, error: e.message }));
    child.once('spawn', () => {
      runningShops.set(id, child.pid);
      shopChildProcesses.set(id, child);
      try {
        fs.writeFileSync(pidFile, String(child.pid), 'utf8');
      } catch {}

      notifyRunningChanged(true);

      if (extensionAllowed && extDir) {
        loadExtensionViaCDP(dir, extDir);
      }

      child.once('exit', () => {
        if (shopChildProcesses.get(id) === child) {
          shopChildProcesses.delete(id);
        }
        profileProbePending.add(id);
        const reconcileExitedLaunch = async (attempt = 0) => {
          if (process.platform === 'win32') {
            const result = await findProfileProcessIds(dir, true);
            if (result.error) {
              if (attempt === 0) {
                console.warn(`Không xác minh được Chrome của shop ${id}:`, result.error);
              }
              if (attempt < 2) {
                setTimeout(() => reconcileExitedLaunch(attempt + 1), 1200);
                return;
              }
              setTimeout(() => reconcileExitedLaunch(), 5000);
              return;
            } else if (result.pids.length) {
              const profilePid = result.pids.find((pid) => isProcessAlive(pid));
              if (!profilePid) {
                profileProbePending.delete(id);
                notifyRunningChanged(true);
                return;
              }
              runningShops.set(id, profilePid);
              try {
                fs.writeFileSync(pidFile, String(profilePid), 'utf8');
              } catch (error) {
                console.warn(`Không lưu được PID Chrome của shop ${id}:`, error);
              }
              profileProbePending.delete(id);
              notifyRunningChanged(true);
              return;
            }
          } else if (isProfileLocked(dir)) {
            profileProbePending.delete(id);
            notifyRunningChanged(true);
            return;
          }

          if (shopChildProcesses.has(id)) {
            profileProbePending.delete(id);
            return;
          }
          if (runningShops.get(id) === child.pid) runningShops.delete(id);
          profileProbePending.delete(id);
          stopProxyForwarder(id);
          try {
            fs.unlinkSync(pidFile);
          } catch {}
          notifyRunningChanged(true);
        };
        setTimeout(() => reconcileExitedLaunch(), 1200);
      });

      child.unref();
      resolve({ ok: true, alreadyOpen: false });
    });
  });
});

// Xoa du lieu dang nhap cua 1 gian (phai dong cua so Chrome cua gian do truoc)
ipcMain.handle('shop:resetProfile', (_e, id) => {
  const dir = path.join(profilesRoot(), safeId(id));
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    runningShops.delete(id);
    stopProxyForwarder(id);
    notifyRunningChanged(true);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'Khong xoa duoc. Hay dong cua so Chrome cua gian nay roi thu lai.' };
  }
});

let win;
function createWindow() {
  const activeDir = getActiveAppPath();
  if (activeDir !== __dirname) {
    try {
      const logoSrc = path.join(__dirname, 'logo.png');
      const iconSrc = path.join(__dirname, 'icon.png');
      if (fs.existsSync(logoSrc)) fs.copyFileSync(logoSrc, path.join(activeDir, 'logo.png'));
      if (fs.existsSync(iconSrc)) fs.copyFileSync(iconSrc, path.join(activeDir, 'icon.png'));
    } catch {}
  }

  const preloadPath = fs.existsSync(path.join(activeDir, 'preload.js'))
    ? path.join(activeDir, 'preload.js')
    : path.join(__dirname, 'preload.js');

  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 820,
    minHeight: 560,
    title: '186 HOME - TikTok MultiShop',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#111418',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(activeDir, 'index.html'));
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  createWindow();
  setInterval(() => notifyRunningChanged(false), 2000);
  try {
    const extDir = getExtensionDir();
    const root = profilesRoot();
    if (extDir && fs.existsSync(root)) {
      for (const name of fs.readdirSync(root)) {
        const pDir = path.join(root, name);
        if (fs.existsSync(path.join(pDir, 'DevToolsActivePort'))) {
          loadExtensionViaCDP(pDir, extDir);
        }
      }
    }
  } catch {}
});
app.on('window-all-closed', () => app.quit());
