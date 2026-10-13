const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
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
  'https://seller-vn.tiktok.com/ads-creation/dashboard?origin=SC_ads_tab_button_PC&btm_pre_unit_params=%7B%22btm_origin%22%3A%22sidebar_menu_Qu%E1%BA%A3ng+c%C3%A1o+c%E1%BB%ADa+h%C3%A0ng%22%7D';
// Khong gan cung khoang thoi gian: de TikTok tu mo ngay hien tai
const DEFAULT_ORDERS = 'https://seller-vn.tiktok.com/order?selected_sort=6&tab=all';

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
  return true;
});

ipcMain.handle('members:get', () => readMembers());
ipcMain.handle('members:save', (_e, members) => {
  writeJson(membersFile(), Array.isArray(members) ? members : []);
  return true;
});

ipcMain.handle('auth:get', () => {
  const s = readJson(settingsFile(), {});
  return {
    adminUser: s.adminUser || 'admin',
    adminPass: s.adminPass || '123456',
    requireLogin: Boolean(s.requireLogin)
  };
});

ipcMain.handle('auth:save', (_e, cfg) => {
  const s = readJson(settingsFile(), {});
  if (cfg && typeof cfg === 'object') {
    if (cfg.adminUser) s.adminUser = String(cfg.adminUser).trim();
    if (cfg.adminPass) s.adminPass = String(cfg.adminPass).trim();
    if (typeof cfg.requireLogin === 'boolean') s.requireLogin = cfg.requireLogin;
  }
  writeJson(settingsFile(), s);
  return true;
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
        adsUrl: item.adsUrl || item.sellerUrl || DEFAULT_ADS,
        ordersUrl: item.ordersUrl || DEFAULT_ORDERS,
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
const proxyForwarders = new Map();

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
    if (pid && isProcessAlive(pid)) {
      runningShops.set(s.id, pid);
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

// Dong cua so Chrome cua 1 gian hang
function closeShopProcess(id) {
  return new Promise((resolve) => {
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
      stopProxyForwarder(id);
      try {
        fs.unlinkSync(pidFile);
      } catch {}
      notifyRunningChanged(true);
      resolve({ ok: true });
    };

    if (!pid || !isProcessAlive(pid)) {
      return finish();
    }

    if (process.platform === 'win32') {
      const tk = spawn('taskkill', ['/PID', String(pid), '/T'], { windowsHide: true, stdio: 'ignore' });
      tk.on('close', () => {
        setTimeout(() => {
          if (isProcessAlive(pid)) {
            const tkForce = spawn('taskkill', ['/F', '/PID', String(pid), '/T'], {
              windowsHide: true,
              stdio: 'ignore'
            });
            tkForce.on('close', finish);
            tkForce.on('error', finish);
          } else {
            finish();
          }
        }, 400);
      });
      tk.on('error', finish);
    } else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
      setTimeout(() => {
        if (isProcessAlive(pid)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {}
        }
        finish();
      }, 400);
    }
  });
}

ipcMain.handle('shop:close', (_e, id) => closeShopProcess(id));

ipcMain.handle('shops:closeAll', async () => {
  const ids = syncRunningShops();
  for (const id of ids) {
    await closeShopProcess(id);
  }
  return { ok: true, closedCount: ids.length };
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
ipcMain.handle('shop:open', async (_e, id, which) => {
  const shop = readShops().find((s) => s.id === id);
  if (!shop) return { ok: false, error: 'Khong tim thay gian hang' };

  const browser = findBrowser();
  if (!browser) return { ok: false, error: 'NO_BROWSER' };

  const urls = [];
  if (which === 'ads' || which === 'both') urls.push(shop.adsUrl || shop.sellerUrl || DEFAULT_ADS);
  if (which === 'orders' || which === 'both') urls.push(shop.ordersUrl || DEFAULT_ORDERS);
  if (!urls.length) return { ok: false, error: 'Thieu link de mo' };

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

  const extDir = getExtensionDir();

  // Kiem tra neu Chrome cua gian nay dang chay: dua cua so cu len tren va KHONG mo Chrome moi
  const focusRes = await focusShopWindow(knownPid, dir);
  if (focusRes.ok) {
    runningShops.set(id, focusRes.pid);
    try {
      fs.writeFileSync(pidFile, String(focusRes.pid), 'utf8');
    } catch {}
    if (extDir) {
      loadExtensionViaCDP(dir, extDir);
    }
    notifyRunningChanged(true);
    return { ok: true, alreadyOpen: true };
  }

  // Chuan bi extension TikTok GMV Video Selector de tu dong nap vao Chrome
  ensureExtensionPinned(dir);
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

  if (extDir) {
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
      try {
        fs.writeFileSync(pidFile, String(child.pid), 'utf8');
      } catch {}

      notifyRunningChanged(true);

      if (extDir) {
        loadExtensionViaCDP(dir, extDir);
      }

      child.once('exit', () => {
        runningShops.delete(id);
        stopProxyForwarder(id);
        try {
          fs.unlinkSync(pidFile);
        } catch {}
        notifyRunningChanged(true);
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
  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 820,
    minHeight: 560,
    title: '186 HOME - TikTok MultiShop',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#111418',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile('index.html');
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
