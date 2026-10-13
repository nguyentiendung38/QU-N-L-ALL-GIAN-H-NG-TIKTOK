const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
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

function loadExtensionViaCDP(profileDir, extDir) {
  if (!extDir || typeof WebSocket === 'undefined') return;
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  let attempts = 0;

  const timer = setInterval(() => {
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

    clearInterval(timer);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
      const closeTimer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
      }, 5000);

      ws.onopen = () => {
        try {
          ws.send(
            JSON.stringify({
              id: 1,
              method: 'Extensions.loadUnpacked',
              params: { path: extDir }
            })
          );
        } catch {}
      };
      ws.onmessage = () => {
        clearTimeout(closeTimer);
        try {
          ws.close();
        } catch {}
      };
      ws.onerror = () => {
        clearTimeout(closeTimer);
      };
    } catch {}
  }, 250);
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
    } catch { }
  }

  // Kiem tra neu Chrome cua gian nay dang chay: dua cua so cu len tren va KHONG mo Chrome moi
  const focusRes = await focusShopWindow(knownPid, dir);
  if (focusRes.ok) {
    runningShops.set(id, focusRes.pid);
    try {
      fs.writeFileSync(pidFile, String(focusRes.pid), 'utf8');
    } catch { }
    return { ok: true, alreadyOpen: true };
  }

  // Chuan bi extension TikTok GMV Video Selector de tu dong nap vao Chrome
  const extDir = getExtensionDir();
  ensureExtensionPinned(dir);
  try {
    fs.unlinkSync(path.join(dir, 'DevToolsActivePort'));
  } catch {}

  // Neu chua mo hoac da dong: mo Chrome moi kem extension
  const args = [
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window'
  ];
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
      } catch { }

      if (extDir) {
        loadExtensionViaCDP(dir, extDir);
      }

      child.once('exit', () => {
        runningShops.delete(id);
        try {
          fs.unlinkSync(pidFile);
        } catch { }
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
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'Khong xoa duoc. Hay dong cua so Chrome cua gian nay roi thu lai.' };
  }
});

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 760,
    minHeight: 520,
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

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
