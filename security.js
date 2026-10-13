const electron = require('electron');
const app = electron && electron.app;
const ipcMain = electron && electron.ipcMain;
const crypto = require('crypto');
const os = require('os');
const { execSync } = require('child_process');


/**
 * Lay Hardware ID (HWID) duy nhat cua may tinh
 * Windows: MachineGuid (Registry)
 * macOS: IOPlatformUUID
 */
function getRawMachineId() {
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      const output = execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const match = output.match(/MachineGuid\s+REG_SZ\s+([A-Fa-f0-9-]+)/);
      if (match && match[1]) return match[1].trim();
    } else if (platform === 'darwin') {
      const output = execSync(
        'ioreg -rd1 -c IOPlatformExpertDevice | grep -i IOPlatformUUID',
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match && match[1]) return match[1].trim();
    }
  } catch {}

  // Fallback dua tren CPU, hostname va network interface
  const cpus = os.cpus().map(c => c.model).join(';');
  const network = Object.values(os.networkInterfaces())
    .flat()
    .filter(i => i && !i.internal && i.mac !== '00:00:00:00:00:00')
    .map(i => i.mac)
    .sort()
    .join(';');
  return `${os.hostname()}-${cpus}-${network}`;
}

/**
 * Tao HWID da duoc ma hoa voi Salt bi mat cua ung dung
 * Dinh dang: 186H-XXXX-XXXX-XXXX-XXXX
 */
function getHWID() {
  const raw = getRawMachineId();
  const salt = '186_HOME_TIKTOK_MULTISHOP_SECURITY_2026_SALT';
  const hash = crypto.createHmac('sha256', salt).update(raw).digest('hex').toUpperCase();
  return `186H-${hash.slice(0, 4)}-${hash.slice(4, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}`;
}

/**
 * Kiem tra xem co debugger hay hacker dang co gang hook vao app khong
 */
function checkTampering() {
  const argv = process.argv.join(' ').toLowerCase();
  const suspiciousFlags = [
    '--inspect',
    '--inspect-brk',
    '--remote-debugging-port',
    '--remote-debugging-pipe',
    '--enable-logging'
  ];

  for (const flag of suspiciousFlags) {
    if (argv.includes(flag)) {
      // Phat hien cong cu can thiep debug -> Lap tuc thoat ung dung
      if (app && app.exit) app.exit(0);
      else process.exit(0);
      return false;
    }
  }
  return true;
}

/**
 * Thiet lap bao ve chong DevTools, chong F12, chong kiem tra phan tu
 */
function secureWebContents(contents) {
  // Dong DevTools ngay lap tuc neu bi bat len bang bat ky cach nao
  contents.on('devtools-opened', () => {
    contents.closeDevTools();
  });

  // Chan chuot phai "Kiem tra phan tu" (Inspect Element) tren giao dien
  contents.on('context-menu', (e) => {
    e.preventDefault();
  });

  // Chan toan bo cac to hop phim tat de inspect hoac mo DevTools
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    const isCtrlOrCmd = process.platform === 'darwin' ? input.meta : input.control;
    const key = (input.key || '').toUpperCase();

    // F12
    if (key === 'F12') {
      event.preventDefault();
      return;
    }

    // Ctrl/Cmd + Shift + I (Inspect)
    // Ctrl/Cmd + Shift + J (Console)
    // Ctrl/Cmd + Shift + C (Inspect Element)
    if (isCtrlOrCmd && input.shift && ['I', 'J', 'C'].includes(key)) {
      event.preventDefault();
      return;
    }

    // Ctrl/Cmd + U (View Source)
    if (isCtrlOrCmd && key === 'U') {
      event.preventDefault();
      return;
    }
  });
}

function initSecurity() {
  checkTampering();

  if (ipcMain) {
    ipcMain.handle('security:getHWID', () => getHWID());
  }

  if (app) {
    app.on('web-contents-created', (_e, contents) => {
      secureWebContents(contents);
    });
  }
}

module.exports = {
  initSecurity,
  getHWID,
  secureWebContents,
  checkTampering
};
