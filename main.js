const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const liveDir = path.join(app.getPath('userData'), 'live_app');
const liveCore = path.join(liveDir, 'main-core.js');
const liveVersionFile = path.join(liveDir, 'version.json');
const bundledCore = path.join(__dirname, 'main-core.js');
const bundledVersionFile = path.join(__dirname, 'version.json');

function readBuildNumber(file) {
  try {
    return Number(JSON.parse(fs.readFileSync(file, 'utf8')).buildNumber) || 0;
  } catch {
    return 0;
  }
}

const useLiveCore =
  fs.existsSync(liveCore) &&
  readBuildNumber(liveVersionFile) > readBuildNumber(bundledVersionFile);

try {
  require(useLiveCore ? liveCore : bundledCore);
} catch (error) {
  if (!useLiveCore) throw error;
  console.error('Không nạp được main-core từ OTA, quay lại bản đóng gói:', error);
  require(bundledCore);
}
