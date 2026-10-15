const DEFAULT_ADS =
  'https://seller-vn.tiktok.com/ads-creation/dashboard?origin=SC_ads_tab_button_PC&btm_pre_unit_params=%7B%22btm_origin%22%3A%22sidebar_menu_Qu%E1%BA%A3ng+c%C3%A1o+c%E1%BB%ADa+h%C3%A0ng%22%7D&mpa=1&activated_tab_id=0&shop_region=VN';
const DEFAULT_ORDERS = 'https://seller-vn.tiktok.com/order?selected_sort=6&tab=all';
const DEFAULT_TIKTOK_URL = 'https://seller-vn.tiktok.com/homepage';
const DEFAULT_SHOPEE_URL = 'https://subaccount.shopee.com/login/';
const DEFAULT_CSKH_CHAT =
  'https://seller-vn.tiktok.com/chat/inbox/current?oec_seller_id=7494826072462165266&shop_region=VN&lang=en&from=seller_center_navigation_im';
const DEFAULT_CSKH_ORDERS =
  'https://seller-vn.tiktok.com/order?order_status[]=1&selected_sort=11&tab=to_ship';

let shops = [];
let members = [];
let authConfig = { adminUser: 'admin', adminPass: '123456', requireLogin: true };
let runningIds = new Set();
let onlineActiveUsers = {}; // { [userKey]: { who: string, role: string, isOnline: boolean, isRunning: boolean, shops: string[] } }
let closingShopIds = new Set();
let shopActivityLog = (function () {
  try {
    const stored = JSON.parse(localStorage.getItem('shopActivityLog') || '[]');
    return Array.isArray(stored) ? stored.slice(0, 100) : [];
  } catch {
    return [];
  }
})();
let sharedActivityLog = [];
let activitySyncError = '';
let isLoadingActivity = false;
let activityWriteQueue = Promise.resolve();
let activityFlushPromise = null;
let lastActivitySyncWarningAt = 0;
let isReloadingDashboardData = false;
let activeCloudError = '';
let activeStatusFetchError = '';
let isDeptMonitorCollapsed = (function () {
  try { return localStorage.getItem('deptMonitorCollapsed') === '1'; } catch { return false; }
})();
let isAdminDashboardCollapsed = (function () {
  try { return localStorage.getItem('adminDashboardCollapsed') === '1'; } catch { return false; }
})();
let isShopListCollapsed = (function () {
  try { return localStorage.getItem('shopListCollapsed') === '1'; } catch { return false; }
})();
let isShopeeListCollapsed = (function () {
  try { return localStorage.getItem('shopeeListCollapsed') === '1'; } catch { return false; }
})();
let selectedIds = new Set();
let proxyStatusMap = new Map();
let editingId = null;
let editingMemberId = null;
let currentDlgLinkMode = 'ads'; // 'ads' | 'cskh'
let searchQuery = '';
let searchRenderTimer = null;
let activeGroup = '__ALL__';
let activeMember = 'ALL';
let activePlatform = 'ALL';
let draggedShopId = null;
let shopNameTooltipTimer = null;
let shopNameTooltip = null;

const $ = (id) => document.getElementById(id);

async function persist() {
  await window.api.saveShops(shops);
}

async function persistMembers() {
  await window.api.saveMembers(members);
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function initials(name) {
  const words = (name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (name || '').trim().slice(0, 2).toUpperCase() || 'SH';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function showShopNameTooltip(target, name) {
  clearTimeout(shopNameTooltipTimer);
  shopNameTooltipTimer = setTimeout(() => {
    if (!shopNameTooltip) {
      shopNameTooltip = document.createElement('div');
      shopNameTooltip.className = 'shop-name-tooltip';
      document.body.appendChild(shopNameTooltip);
    }
    shopNameTooltip.textContent = name;
    shopNameTooltip.style.visibility = 'hidden';
    shopNameTooltip.classList.add('visible');

    const targetRect = target.getBoundingClientRect();
    const tooltipRect = shopNameTooltip.getBoundingClientRect();
    const left = Math.max(8, Math.min(targetRect.left, window.innerWidth - tooltipRect.width - 8));
    const top = targetRect.bottom + tooltipRect.height + 8 <= window.innerHeight
      ? targetRect.bottom + 6
      : Math.max(8, targetRect.top - tooltipRect.height - 6);

    shopNameTooltip.style.left = `${left}px`;
    shopNameTooltip.style.top = `${top}px`;
    shopNameTooltip.style.visibility = 'visible';
  }, 350);
}

function hideShopNameTooltip() {
  clearTimeout(shopNameTooltipTimer);
  if (shopNameTooltip) shopNameTooltip.classList.remove('visible');
}

function slugUsername(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function mkBtn(text, cls, onclick, title) {
  const b = document.createElement('button');
  b.className = 'btn ' + cls;
  b.textContent = text;
  if (title) b.title = title;
  b.onclick = onclick;
  return b;
}

function isMemberMode() {
  return Boolean(currentUser && currentUser.roleType === 'member' && currentUser.member);
}

function isShopActive(shopId) {
  return runningIds.has(shopId);
}

function getMyUserKey() {
  if (isMemberMode() && currentUser && currentUser.member) {
    return currentUser.member.id;
  }
  return 'admin';
}

function getMyUserName() {
  if (isMemberMode() && currentUser && currentUser.member) {
    return currentUser.member.name;
  }
  return (authConfig && authConfig.adminUser) || 'Admin';
}

let isReportingActive = false;
let needReportAgain = false;
let lastActiveReportWarningAt = 0;
async function reportMyActiveShops() {
  if (!currentUser) return { ok: false, error: 'Chưa đăng nhập' };
  if (isReportingActive) {
    needReportAgain = true;
    return { ok: false, queued: true };
  }
  isReportingActive = true;
  needReportAgain = false;
  let result = { ok: false, error: 'Không nhận được phản hồi từ Cloud' };
  try {
    const userKey = currentUser.isAdminPreview ? 'admin' : getMyUserKey();
    const userName = currentUser.isAdminPreview ? ((authConfig && authConfig.adminUser) || 'Admin') : getMyUserName();
    const role = (isMemberMode() && currentUser.member) ? (currentUser.member.permMode || 'cskh') : 'admin';
    const shopIds = Array.from(runningIds);
    result = await window.api.cloudReportActive({
      userKey,
      userName,
      role,
      shopIds,
      latestActivity: shopActivityLog[0] || null,
      proxyIssues: getVisibleShopsForRole()
        .filter((shop) => proxyStatusMap.get(shop.id)?.state === 'die')
        .map((shop) => shop.id),
      activityPending: shopActivityLog.filter((event) => !event.synced).length
    });
    if (result && result.ok) {
      activeCloudOk = true;
      activeCloudError = '';
    }
    if (!result || !result.ok) {
      if (result && result.queued) {
        return result;
      }
      activeCloudOk = false;
      activeCloudError = (result && result.error) || 'Không nhận được phản hồi từ Cloud';
      const now = Date.now();
      if (now - lastActiveReportWarningAt >= 30000) {
        console.warn('Không đồng bộ được trạng thái shop lên Cloud:', (result && result.error) || 'Lỗi không xác định');
        lastActiveReportWarningAt = now;
      }
      result = result || { ok: false, error: 'Không nhận được phản hồi từ Cloud' };
    }
  } catch (err) {
    activeCloudOk = false;
    activeCloudError = err.message;
    console.warn('reportMyActiveShops error:', err);
    result = { ok: false, error: err.message };
  } finally {
    isReportingActive = false;
    if (needReportAgain) {
      needReportAgain = false;
      setTimeout(reportMyActiveShops, 200);
    }
  }
  renderAdminDashboard();
  return result;
}

let activeRefreshPromise = null;
let activeCloudOk = false;
async function refreshOnlineActiveShops(force = false) {
  if (isMemberMode()) return { ok: false, error: 'Chỉ Admin mới tải được trạng thái toàn bộ nhân viên.' };
  if (activeRefreshPromise) {
    if (!force) return activeRefreshPromise;
    await activeRefreshPromise;
  }

  const refreshPromise = (async () => {
    try {
      const res = await window.api.cloudGetActive();
      if (!res || typeof res !== 'object') {
        throw new Error('Cloud không trả về dữ liệu trạng thái nhân viên hợp lệ.');
      }
      if (res.error) {
        activeCloudOk = false;
        activeStatusFetchError = res.error;
        console.warn('Không tải được trạng thái shop từ Cloud:', res.error);
        if (res.users) onlineActiveUsers = res.users;
      } else if (res.shops || res.users) {
        activeCloudOk = true;
        activeStatusFetchError = '';
        onlineActiveUsers = res.users || {};
      }
      const knownEventIds = new Set(sharedActivityLog.map((event) => event.id));
      Object.values(onlineActiveUsers).forEach((user) => {
        const event = user && user.latestActivity;
        if (event && event.id && !knownEventIds.has(event.id)) {
          sharedActivityLog.push(event);
          knownEventIds.add(event.id);
        }
      });
      sharedActivityLog = sharedActivityLog
        .sort((a, b) => Number(b.time) - Number(a.time))
        .slice(0, 100);
      if (currentUser) {
        updateCardsRunningStatus();
        renderDeptMonitor();
        renderAdminDashboard();
      }
      return res.error ? { ok: false, error: res.error } : { ok: true };
    } catch (err) {
      activeCloudOk = false;
      activeStatusFetchError = err.message;
      console.warn('refreshOnlineActiveShops error:', err);
      renderAdminDashboard();
      return { ok: false, error: err.message };
    }
  })();
  activeRefreshPromise = refreshPromise;
  try {
    return await refreshPromise;
  } finally {
    if (activeRefreshPromise === refreshPromise) activeRefreshPromise = null;
  }
}

function saveLocalActivity(event) {
  shopActivityLog = [event, ...shopActivityLog.filter((item) => item.id !== event.id)].slice(0, 100);
  try {
    localStorage.setItem('shopActivityLog', JSON.stringify(shopActivityLog));
  } catch (err) {
    console.warn('Không lưu được lịch sử hoạt động trên máy này:', err);
  }
}

function recordShopActivity(action, shop = null) {
  const event = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    action,
    userKey: currentUser && currentUser.isAdminPreview ? 'admin' : getMyUserKey(),
    userName: currentUser && currentUser.isAdminPreview ? ((authConfig && authConfig.adminUser) || 'Admin') : getMyUserName(),
    shopId: shop ? shop.id : '',
    shopName: shop ? shop.name : '',
    time: Date.now(),
    synced: false
  };
  saveLocalActivity(event);
  flushPendingActivity().catch((error) => {
    console.warn('Không đồng bộ được hoạt động:', error);
  });
  return event;
}

async function flushPendingActivity() {
  if (activityFlushPromise) {
    await activityFlushPromise;
    if (!activitySyncError && shopActivityLog.some((item) => !item.synced)) {
      return flushPendingActivity();
    }
    return;
  }
  if (!shopActivityLog.some((item) => !item.synced)) return;

  activitySyncError = '';
  let syncedAny = false;
  activityFlushPromise = (async () => {
    while (true) {
      const event = shopActivityLog.find((item) => !item.synced);
      if (!event) break;
      const write = activityWriteQueue.then(() => window.api.cloudAppendActivity(event));
      activityWriteQueue = write.then(() => undefined, () => undefined);
      try {
        const result = await write;
        if (!result || !result.ok) {
          activitySyncError = (result && result.error) || 'Không đồng bộ được lịch sử hoạt động lên Cloud';
          const now = Date.now();
          if (now - lastActivitySyncWarningAt >= 30000) {
            console.warn('Không đồng bộ được hoạt động lên Cloud:', activitySyncError);
            lastActivitySyncWarningAt = now;
          }
          break;
        }
        event.synced = true;
        saveLocalActivity(event);
        syncedAny = true;
      } catch (err) {
        activitySyncError = err.message;
        console.warn('Không đồng bộ được lịch sử hoạt động:', err);
        break;
      }
    }
  })();
  try {
    await activityFlushPromise;
  } finally {
    activityFlushPromise = null;
  }
  if (!isMemberMode() && !activitySyncError) {
    await refreshActivityHistory();
  }
  try {
    if (syncedAny) await reportMyActiveShops();
  } catch (err) {
    console.warn('Không cập nhật được heartbeat sau khi đồng bộ lịch sử:', err);
  }
  renderAdminDashboard();
}

function formatActivityTime(timestamp) {
  const time = Number(timestamp);
  if (!time) return 'Không rõ thời gian';
  return new Date(time).toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

let lastActivityFetchAt = 0;
let activityFetchPromise = null;
async function refreshActivityHistory(force = false) {
  if (isMemberMode()) return { ok: false, error: 'Chỉ Admin mới tải được hoạt động của nhân viên.' };
  if (activityFetchPromise) {
    if (!force) return activityFetchPromise;
    await activityFetchPromise;
  }
  if (!force && Date.now() - lastActivityFetchAt < 60000) return;
  isLoadingActivity = true;
  lastActivityFetchAt = Date.now();
  const refreshPromise = (async () => {
    try {
      const result = await window.api.cloudGetActivity();
      if (!result || !result.ok) {
        activitySyncError = (result && result.error) || 'Không tải được lịch sử hoạt động từ Cloud';
        return { ok: false, error: activitySyncError };
      }
      const mergedEvents = [
        ...(Array.isArray(result.events) ? result.events : []),
        ...sharedActivityLog
      ];
      const uniqueEvents = new Map();
      mergedEvents.forEach((event) => {
        if (event && event.id && !uniqueEvents.has(event.id)) uniqueEvents.set(event.id, event);
      });
      sharedActivityLog = Array.from(uniqueEvents.values())
        .sort((a, b) => Number(b.time) - Number(a.time))
        .slice(0, 100);
      activitySyncError = '';
      return { ok: true };
    } catch (err) {
      activitySyncError = err.message;
      console.warn('Không tải được lịch sử hoạt động:', err);
      return { ok: false, error: err.message };
    } finally {
      isLoadingActivity = false;
      renderAdminDashboard();
    }
  })();
  activityFetchPromise = refreshPromise;
  try {
    return await refreshPromise;
  } finally {
    if (activityFetchPromise === refreshPromise) activityFetchPromise = null;
  }
}

function updateCardsRunningStatus() {
  const cards = document.querySelectorAll('.card[data-shop-id]');
  cards.forEach((card) => {
    const sid = card.dataset.shopId;
    if (!sid) return;
    const isLocalRunning = runningIds.has(sid);
    const isRunning = isLocalRunning;

    card.classList.toggle('is-running', isRunning);

    const pill = card.querySelector('.status-pill');
    if (pill) {
      pill.className = 'status-pill ' + (isRunning ? 'running' : 'stopped');
      let statusText = 'Đang đóng';
      let statusTitle = 'Chưa mở cửa sổ Chrome';
      if (isLocalRunning) {
        statusText = 'Đang mở';
        statusTitle = 'Đang mở Chrome trên máy này';
      }

      pill.innerHTML = `<span class="dot"></span><span class="status-txt">${statusText}</span>`;
      pill.title = statusTitle;
    }
  });

  const filtered = getFilteredShops();
  updateStatsAndBatchBar(filtered);
}

function getShopMembers(shop) {
  const ids = Array.isArray(shop && shop.memberIds) ? shop.memberIds : [];
  if (!ids.length) return [];
  const assignedIds = new Set(ids);
  return members.filter((member) => assignedIds.has(member.id));
}

function getMemberShops(memberId) {
  return shops.filter((s) => Array.isArray(s.memberIds) && s.memberIds.includes(memberId));
}

function getPermModeLabel(permMode) {
  if (permMode === 'vanhanh') return '📦 Vận hành';
  if (permMode === 'ads') return '📈 Ads';
  return '💬 CSKH';
}

function getOpenActionForMode(permMode) {
  if (permMode === 'vanhanh') return 'cskh_orders';
  if (permMode === 'cskh') return 'cskh_orders';
  if (permMode === 'ads') return 'ads';
  return 'tiktok';
}

function canCurrentUserUseGmvExtension() {
  return !isMemberMode() || currentUser.member.gmvExtensionEnabled === true;
}

function getShopPermMode(shop) {
  // Neu dang dang nhap bang tai khoan nhan vien (hoac Admin dang xem thu giao dien nhan vien)
  if (isMemberMode()) {
    return currentUser.member.permMode || 'cskh';
  }
  // QUAN TRI VIEN (ADMIN) CO TOAN QUYEN TAT CA!
  return 'admin';
}

function getVisibleShopsForRole() {
  if (!currentUser) return [];
  if (isMemberMode()) {
    return getMemberShops(currentUser.member.id);
  }
  return shops;
}

function getMemberOnlineStatus(memberId) {
  if (!memberId) return null;
  const safeKey = String(memberId).trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  const u = onlineActiveUsers[safeKey] || onlineActiveUsers[memberId];
  if (u) return u;

  if (isMemberMode() && currentUser && currentUser.member && currentUser.member.id === memberId) {
    const rShops = Array.from(runningIds);
    return {
      userKey: safeKey,
      who: currentUser.member.name,
      role: currentUser.member.permMode || 'cskh',
      time: Date.now(),
      isOnline: true,
      isRunning: rShops.length > 0,
      shops: rShops
    };
  }
  return null;
}

window.filterByMember = function (memberId) {
  activeMember = memberId;
  if ($('memberFilterSelect')) {
    $('memberFilterSelect').value = memberId;
  }
  render();
  const m = members.find((x) => x.id === memberId);
  if (m) toast(`🔍 Đang lọc danh sách gian hàng của: ${m.name}`);
};

window.filterByDept = function (deptKey) {
  const deptMembers = members.filter((m) => (m.permMode || 'cskh') === deptKey);
  const deptName = deptKey === 'vanhanh' ? 'Vận hành' : (deptKey === 'ads' ? 'Ads' : 'CSKH');
  if (deptMembers.length > 0) {
    activeMember = deptMembers[0].id;
    if ($('memberFilterSelect')) $('memberFilterSelect').value = activeMember;
    render();
    toast(`🔍 Đang hiển thị gian hàng của bộ phận ${deptName} (${deptMembers.map((m) => m.name).join(', ')})`);
  } else {
    toast(`⚠️ Chưa có nhân viên nào thuộc bộ phận ${deptName}`);
  }
};

function renderDeptMonitor() {
  const container = $('deptMonitorSection');
  if (!container) return;
  if (isMemberMode()) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');

  if (!members || members.length === 0) {
    container.innerHTML = `
      <div class="dept-monitor-header">
        <div class="dept-monitor-title" title="Theo dõi trạng thái mở Chrome của nhân viên CSKH / Vận hành / Ads thời gian thực">
          <span class="dept-monitor-live-dot"></span>
          <span>Giám sát nhân viên theo bộ phận (Realtime)</span>
        </div>
        <div style="font-size:12px;color:var(--muted);">Chưa có nhân viên nào. Bấm Avatar Quản trị viên ➔ Quản lý thành viên để thêm nhân viên.</div>
      </div>
    `;
    return;
  }

  const depts = [
    { key: 'cskh', name: 'Bộ phận CSKH', icon: '🎧', tag: 'CSKH', cls: 'dept-badge-cskh' },
    { key: 'vanhanh', name: 'Bộ phận Vận hành', icon: '📦', tag: 'Vận hành', cls: 'dept-badge-vanhanh' },
    { key: 'ads', name: 'Bộ phận Ads', icon: '📈', tag: 'Ads', cls: 'dept-badge-ads' }
  ];

  const deptData = depts.map((d) => {
    const dMembers = members.filter((m) => (m.permMode || 'cskh') === d.key);
    let openCount = 0;
    let closedCount = 0;
    let onlineCount = 0;

    const list = dMembers.map((m) => {
      const mStatus = getMemberOnlineStatus(m.id);
      const isOnline = Boolean(mStatus && mStatus.isOnline);
      if (isOnline) onlineCount++;
      const isRunning = Boolean(
        mStatus && mStatus.isRunning && Array.isArray(mStatus.shops) && mStatus.shops.length > 0
      );
      if (isRunning) {
        openCount++;
      } else {
        closedCount++;
      }
      const runningShopIds = (mStatus && Array.isArray(mStatus.shops)) ? mStatus.shops : [];
      const runningNames = runningShopIds
        .map((sid) => {
          const s = shops.find((x) => x.id === sid);
          return s ? s.name : sid;
        })
        .filter(Boolean);

      const assignedCount = getMemberShops(m.id).length;

      return {
        member: m,
        isOnline,
        isRunning,
        runningShopIds,
        runningNames,
        assignedCount
      };
    });

    return {
      ...d,
      members: list,
      openCount,
      closedCount,
      onlineCount,
      totalCount: dMembers.length
    };
  });

  let headerHtml = `
    <div class="dept-monitor-header">
      <div class="dept-monitor-title" title="Theo dõi trạng thái mở Chrome của nhân viên CSKH / Vận hành / Ads thời gian thực">
        <span class="dept-monitor-live-dot"></span>
        <span>Giám sát nhân viên theo bộ phận (Realtime)</span>
      </div>
      <div class="dept-monitor-summary">
  `;

  deptData.forEach((d) => {
    const hasActive = d.openCount > 0;
    headerHtml += `
      <div class="dept-summary-pill ${hasActive ? 'active' : ''}" title="Bấm lọc các gian của bộ phận ${d.name}" onclick="filterByDept('${d.key}')">
        <span>${d.icon} ${d.tag}:</span>
        <span style="color:#3fb950;font-weight:700;">🟢 ${d.openCount} mở</span>
        <span style="color:var(--muted);">• ${d.onlineCount} online</span>
      </div>
    `;
  });

  headerHtml += `
        <button type="button" class="dept-toggle-btn" id="deptToggleBtn">
          ${isDeptMonitorCollapsed ? '▾ Mở rộng chi tiết' : '▴ Thu gọn'}
        </button>
      </div>
    </div>
  `;

  let bodyHtml = `<div class="dept-monitor-body ${isDeptMonitorCollapsed ? 'collapsed' : ''}">`;

  deptData.forEach((d) => {
    bodyHtml += `
      <div class="dept-column">
        <div class="dept-column-header">
          <span class="${d.cls}">${d.icon} ${d.name} (${d.totalCount})</span>
          <span class="dept-count-badge" style="color:${d.openCount > 0 ? '#3fb950' : 'var(--muted)'};">
            🟢 ${d.openCount} đang mở • ${d.onlineCount} online • ⚪ ${d.closedCount} đóng
          </span>
        </div>
        <div class="dept-member-list">
    `;

    if (d.members.length === 0) {
      bodyHtml += `<div class="dept-empty-hint">Chưa có nhân viên bộ phận này</div>`;
    } else {
      d.members.forEach((item) => {
        const m = item.member;
        const color = m.color || '#388bfd';
        const init = initials(m.name);
        const uname = m.username || slugUsername(m.name) || m.name;

        let shopsSub = '';
        if (item.isRunning) {
          const shopNames = item.runningNames
            .map((name) => `<span class="dept-shop-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>`)
            .join(', ');
          shopsSub = `🟢 Đang mở ${item.runningNames.length} shop: <b>${shopNames}</b>`;
        } else if (item.isOnline) {
          shopsSub = `🟢 Đang online • Chưa mở shop`;
        } else {
          shopsSub = `⚪ Đã đóng Chrome (Được giao ${item.assignedCount} gian)`;
        }

        bodyHtml += `
          <div class="dept-member-card ${item.isRunning ? 'is-active' : ''}" title="Bấm để lọc xem toàn bộ gian hàng của ${m.name}" onclick="filterByMember('${m.id}')">
            <div class="dept-member-left">
              <div class="dept-member-dot" style="background:${color}">${init}</div>
              <div class="dept-member-info">
                <div class="dept-member-name">${m.name} <span style="font-weight:400;color:var(--muted);font-size:11px;">(@${uname})</span></div>
                <div class="dept-member-shops">${shopsSub}</div>
              </div>
            </div>
            <div class="dept-member-status-pill ${item.isRunning || item.isOnline ? 'open' : 'closed'}">
              ${item.isRunning
                ? `🟢 Đang mở (${item.runningShopIds.length})`
                : item.isOnline ? '🟢 Online' : '⚪ Offline'}
            </div>
          </div>
        `;
      });
    }

    bodyHtml += `
        </div>
      </div>
    `;
  });

  bodyHtml += `</div>`;

  container.innerHTML = headerHtml + bodyHtml;

  const toggleBtn = $('deptToggleBtn');
  if (toggleBtn) {
    toggleBtn.onclick = (e) => {
      e.stopPropagation();
      isDeptMonitorCollapsed = !isDeptMonitorCollapsed;
      try { localStorage.setItem('deptMonitorCollapsed', isDeptMonitorCollapsed ? '1' : '0'); } catch {}
      renderDeptMonitor();
    };
  }
}

function renderAdminDashboard() {
  const container = $('adminDashboardSection');
  if (!container) return;
  if (isMemberMode() || !currentUser) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');

  const staff = members
    .map((member) => {
      const key = String(member.id).trim().replace(/[^a-zA-Z0-9_-]/g, '_');
      return onlineActiveUsers[key] || onlineActiveUsers[member.id];
    })
    .filter(Boolean);
  const onlineStaff = staff.filter((user) => user && user.isOnline);
  const activeShopIds = new Set(runningIds);
  onlineStaff.forEach((user) => {
    if (Array.isArray(user.shops)) user.shops.forEach((shopId) => activeShopIds.add(shopId));
  });
  const assignedShopIds = new Set();
  shops.forEach((shop) => {
    if (Array.isArray(shop.memberIds) && shop.memberIds.length) assignedShopIds.add(shop.id);
  });
  const proxyShops = shops.filter((shop) => shop.proxy && String(shop.proxy).trim());
  const failedProxyShops = proxyShops.filter((shop) => proxyStatusMap.get(shop.id)?.state === 'die');
  const localProxyIssueIds = new Set(failedProxyShops.map((shop) => shop.id));
  const liveProxyCount = proxyShops.filter((shop) => proxyStatusMap.get(shop.id)?.state === 'live').length;
  const uncheckedProxyCount = proxyShops.filter((shop) => !proxyStatusMap.has(shop.id)).length;
  const activity = [...sharedActivityLog];
  const knownEventIds = new Set(activity.map((event) => event.id));
  shopActivityLog.forEach((event) => {
    if (!knownEventIds.has(event.id)) activity.push(event);
  });
  activity.sort((a, b) => Number(b.time) - Number(a.time));

  const alerts = [];
  if (activeStatusFetchError) alerts.push(`Không tải được trạng thái nhân viên: ${activeStatusFetchError}`);
  if (activitySyncError) alerts.push(`Không đồng bộ được hoạt động gần đây: ${activitySyncError}`);
  const invalidActivityIndexMatch = activitySyncError.match(
    /Chỉ mục hoạt động của ([a-zA-Z0-9_-]+) trên Cloud không hợp lệ/
  );
  failedProxyShops.forEach((shop) => {
    const error = proxyStatusMap.get(shop.id)?.error || 'Proxy không kết nối được';
    alerts.push(`Proxy lỗi — ${shop.name}: ${error}`);
  });
  const remoteProxyIssueIds = new Set();
  onlineStaff.forEach((user) => {
    (Array.isArray(user.proxyIssues) ? user.proxyIssues : []).forEach((shopId) => {
      if (localProxyIssueIds.has(shopId) || remoteProxyIssueIds.has(shopId)) return;
      if (proxyStatusMap.get(shopId)?.state === 'live') return;
      const shop = shops.find((item) => item.id === shopId);
      remoteProxyIssueIds.add(shopId);
      alerts.push(`Proxy lỗi được báo bởi ${user.who || 'nhân viên'} — ${shop ? shop.name : shopId}.`);
    });
  });
  if (uncheckedProxyCount > 0) {
    alerts.push(`${uncheckedProxyCount} Proxy chưa được kiểm tra trên máy này.`);
  }

  const cloudStatus = activeCloudError || activeStatusFetchError || activitySyncError
    ? '<span class="dashboard-status error">⚠ Cần kiểm tra đồng bộ</span>'
    : activeCloudOk
      ? '<span class="dashboard-status ok">☁ Đang hoạt động</span>'
      : '<span class="dashboard-status pending">☁ Đang kiểm tra</span>';
  const activityRows = activity.map((event) => {
    const isOpen = event.action === 'open' || event.action === 'login';
    const actionLabel = {
      open: 'Mở shop',
      close: 'Đóng shop',
      login: 'Đăng nhập',
      logout: 'Đăng xuất'
    }[event.action] || 'Hoạt động';
    return `
      <div class="dashboard-activity-row">
        <span class="dashboard-activity-action ${isOpen ? 'open' : 'close'}">${actionLabel}</span>
        <span class="dashboard-activity-shop" title="${escapeHtml(event.shopName || '')}">${escapeHtml(event.shopName || (event.action === 'login' || event.action === 'logout' ? 'Tài khoản' : 'Shop'))}</span>
        <span class="dashboard-activity-user">${escapeHtml(event.userName || 'Người dùng')}</span>
        <time>${escapeHtml(formatActivityTime(event.time))}</time>
      </div>
    `;
  }).join('');

  const previousActivityScrollTop = $('adminDashboardSection')
    .querySelector('.dashboard-activity-scroll')?.scrollTop || 0;
  container.innerHTML = `
    <div class="admin-dashboard-header">
      <div>
        <div class="admin-dashboard-title">📊 Tổng quan hệ thống</div>
        <div class="admin-dashboard-subtitle">Cập nhật theo trạng thái shop, nhân viên và Proxy</div>
      </div>
      <div class="admin-dashboard-header-actions">
        <button type="button" class="btn small" id="adminDashboardReloadStaffBtn"
          ${isReloadingDashboardData ? 'disabled' : ''}>
          ${isReloadingDashboardData ? '⏳ Đang tải toàn bộ...' : '↻ Tải lại toàn bộ'}
        </button>
        ${cloudStatus}
        <button type="button" class="btn small" id="adminDashboardToggleBtn"
          aria-expanded="${!isAdminDashboardCollapsed}"
          title="${isAdminDashboardCollapsed ? 'Mở rộng tổng quan hệ thống' : 'Thu gọn tổng quan hệ thống'}">
          ${isAdminDashboardCollapsed ? '▾ Mở rộng' : '▴ Thu gọn'}
        </button>
      </div>
    </div>
    <div class="admin-dashboard-content${isAdminDashboardCollapsed ? ' collapsed' : ''}">
    <div class="dashboard-stat-grid">
      <div class="dashboard-stat-card">
        <span class="dashboard-stat-label">Tổng shop</span>
        <strong>${shops.length}</strong>
        <small>${assignedShopIds.size} shop đã phân công • ${shops.length - assignedShopIds.size} chưa phân công</small>
      </div>
      <div class="dashboard-stat-card">
        <span class="dashboard-stat-label">Shop đang mở</span>
        <strong>${activeShopIds.size}</strong>
        <small>${runningIds.size} trên máy Admin • trạng thái nhân viên từ Cloud</small>
      </div>
      <div class="dashboard-stat-card">
        <span class="dashboard-stat-label">Nhân viên online</span>
        <strong>${onlineStaff.length}<span> / ${members.length}</span></strong>
        <small>${onlineStaff.filter((user) => user.isRunning).length} người đang mở shop</small>
      </div>
      <div class="dashboard-stat-card ${failedProxyShops.length ? 'has-warning' : ''}">
        <span class="dashboard-stat-label">Tình trạng Proxy</span>
        <strong>${liveProxyCount}<span> / ${proxyShops.length} live</span></strong>
        <small>${failedProxyShops.length} lỗi • ${uncheckedProxyCount} chưa kiểm tra</small>
      </div>
    </div>
    <div class="dashboard-bottom-grid">
      <section class="dashboard-panel">
        <div class="dashboard-panel-header">
          <h3>🔔 Cảnh báo</h3>
          ${invalidActivityIndexMatch
            ? `<button type="button" class="btn small" id="dashboardRepairActivityIndexBtn">🛠 Sửa chỉ mục ${escapeHtml(invalidActivityIndexMatch[1])}</button>`
            : ''}
          <button type="button" class="btn small" id="dashboardCheckProxyBtn">🌐 Kiểm tra Proxy</button>
        </div>
        ${alerts.length
          ? `<ul class="dashboard-alert-list">${alerts.map((alert) => `<li>${escapeHtml(alert)}</li>`).join('')}</ul>`
          : '<div class="dashboard-all-clear">✓ Chưa phát hiện cảnh báo</div>'}
      </section>
      <section class="dashboard-panel">
        <div class="dashboard-panel-header">
          <h3>🕘 Hoạt động gần đây (${activity.length})</h3>
          <button type="button" class="btn small" id="dashboardExportActivityBtn">⬇ Xuất CSV</button>
          <button type="button" class="btn small" id="dashboardRefreshActivityBtn">↻ Làm mới</button>
        </div>
        ${activityRows
          ? `<div class="dashboard-activity-scroll"><div class="dashboard-activity-list">${activityRows}</div></div>`
          : '<div class="dashboard-all-clear">Chưa có hoạt động được ghi nhận</div>'}
      </section>
    </div>
    </div>
  `;

  const activityScroll = container.querySelector('.dashboard-activity-scroll');
  if (activityScroll) activityScroll.scrollTop = previousActivityScrollTop;

  const dashboardToggleBtn = $('adminDashboardToggleBtn');
  if (dashboardToggleBtn) {
    dashboardToggleBtn.onclick = () => {
      isAdminDashboardCollapsed = !isAdminDashboardCollapsed;
      try {
        localStorage.setItem('adminDashboardCollapsed', isAdminDashboardCollapsed ? '1' : '0');
      } catch (error) {
        console.warn('Không lưu được trạng thái thu gọn tổng quan:', error);
      }
      renderAdminDashboard();
    };
  }
  const reloadStaffBtn = $('adminDashboardReloadStaffBtn');
  if (reloadStaffBtn) {
    reloadStaffBtn.onclick = async () => {
      if (isReloadingDashboardData) return;
      isReloadingDashboardData = true;
      renderAdminDashboard();
      try {
        const cloudSynced = await syncFromCloud(true, true, false);
        const [activeResult, activityResult] = await Promise.all([
          refreshOnlineActiveShops(true),
          refreshActivityHistory(true)
        ]);
        renderDeptMonitor();
        renderAdminDashboard();

        const errors = [
          !cloudSynced ? activeCloudError : '',
          !activeResult.ok ? activeResult.error : '',
          !activityResult.ok ? activityResult.error : ''
        ].filter(Boolean);
        if (errors.length) {
          toast(`Đã tải lại một phần dữ liệu. Cần kiểm tra Cloud: ${errors[0]}`);
        } else {
          toast('Đã tải lại toàn bộ dữ liệu, trạng thái giám sát và hoạt động nhân viên.');
        }
      } catch (error) {
        toast(`Không tải lại được toàn bộ dữ liệu: ${error.message}`);
      } finally {
        isReloadingDashboardData = false;
        renderAdminDashboard();
      }
    };
  }
  const checkProxyBtn = $('dashboardCheckProxyBtn');
  if (checkProxyBtn) {
    checkProxyBtn.onclick = () => {
      const checkAllBtn = $('checkAllProxyBtn');
      if (checkAllBtn) checkAllBtn.click();
    };
  }
  const refreshActivityBtn = $('dashboardRefreshActivityBtn');
  if (refreshActivityBtn) {
    refreshActivityBtn.onclick = () => refreshActivityHistory(true);
  }
  const exportActivityBtn = $('dashboardExportActivityBtn');
  if (exportActivityBtn) {
    exportActivityBtn.onclick = async () => {
      exportActivityBtn.disabled = true;
      try {
        await refreshActivityHistory(true);
        const exportEvents = [...sharedActivityLog];
        const knownIds = new Set(exportEvents.map((event) => event.id));
        shopActivityLog.forEach((event) => {
          if (event && !knownIds.has(event.id)) {
            exportEvents.push(event);
            knownIds.add(event.id);
          }
        });
        const staffEvents = exportEvents
          .filter((event) => event.userKey && event.userKey !== 'admin')
          .sort((a, b) => Number(b.time) - Number(a.time));

        const result = await window.api.exportActivity(staffEvents);
        if (result && result.ok) {
          if (activitySyncError) {
            toast(`Đã xuất ${result.count} hoạt động có sẵn; một số dữ liệu có thể chưa đồng bộ từ Cloud.`);
          } else {
            toast(`Đã xuất ${result.count} hoạt động ra file CSV.`);
          }
        } else if (result && !result.canceled) {
          toast(`Lỗi xuất hoạt động: ${result.error || 'không rõ'}`);
        }
      } catch (error) {
        toast(`Lỗi xuất hoạt động: ${error.message}`);
      } finally {
        exportActivityBtn.disabled = false;
      }
    };
  }
  const repairActivityIndexBtn = $('dashboardRepairActivityIndexBtn');
  if (repairActivityIndexBtn) {
    repairActivityIndexBtn.onclick = async () => {
      const userKey = invalidActivityIndexMatch[1];
      const member = members.find(
        (item) => String(item.id).trim().replace(/[^a-zA-Z0-9_-]/g, '_') === userKey
      );
      const userLabel = userKey === 'admin'
        ? 'Admin'
        : (member ? `nhân viên ${member.name}` : `tài khoản ${userKey}`);
      const confirmed = confirm(
        `Chỉ mục hoạt động của ${userLabel} trên Cloud bị lỗi. Sửa chỉ mục sẽ bắt đầu danh sách hoạt động mới; các sự kiện cũ trên Cloud không bị xóa nhưng có thể không còn xuất hiện trong Hoạt động gần đây. Bạn có muốn tiếp tục không?`
      );
      if (!confirmed) return;

      repairActivityIndexBtn.disabled = true;
      try {
        const result = await window.api.cloudRepairActivityIndex(userKey);
        if (!result || !result.ok) {
          toast(`Không sửa được chỉ mục hoạt động: ${(result && result.error) || 'Lỗi không xác định'}`);
          repairActivityIndexBtn.disabled = false;
          return;
        }
        activitySyncError = '';
        if (result.repaired) {
          toast(`Đã sửa chỉ mục hoạt động của ${userLabel}. Lịch sử mới sẽ tiếp tục được đồng bộ.`);
        } else {
          toast(`Chỉ mục hoạt động của ${userLabel} chưa tồn tại; đang làm mới dữ liệu.`);
        }
        await refreshActivityHistory(true);
      } catch (error) {
        toast(`Không sửa được chỉ mục hoạt động: ${error.message}`);
        repairActivityIndexBtn.disabled = false;
      }
    };
  }
}

function applyRoleUI() {
  if (!currentUser) {
    document.body.classList.add('locked');
    return;
  }
  document.body.classList.remove('locked');
  const isMem = isMemberMode();

  const circle = $('userAvatarCircle');
  const nameEl = $('userAvatarName');
  const roleEl = $('userAvatarRole');
  const headName = $('userMenuHeaderName');
  const headSub = $('userMenuHeaderSub');

  if (isMem) {
    const m = currentUser.member;
    const permLabel = getPermModeLabel(m.permMode || 'cskh');
    if (circle) {
      circle.textContent = initials(m.name);
      circle.style.background = m.color || '#388bfd';
    }
    if (nameEl) nameEl.textContent = m.name;
    if (roleEl) roleEl.textContent = permLabel;
    if (headName) headName.textContent = `👤 ${m.name}`;
    if (headSub) headSub.textContent = `${permLabel} • Phụ trách gian hàng`;
    activeMember = m.id;
  } else {
    if (circle) {
      circle.textContent = 'AD';
      circle.style.background = 'linear-gradient(135deg, #0f9d94, #2ea043)';
    }
    if (nameEl) nameEl.textContent = 'Quản trị viên';
    if (roleEl) roleEl.textContent = authConfig.adminUser || 'admin';
    if (headName) headName.textContent = '👑 Quản trị viên';
    if (headSub) headSub.textContent = `${authConfig.adminUser || 'admin'} • Toàn quyền hệ thống`;
  }

  // An / Hien cac muc chi danh rieng cho Quản trị viên (Admin) trong menu
  document.querySelectorAll('.admin-only').forEach((el) => {
    el.classList.toggle('hidden', isMem);
  });

  if ($('membersMenuCount')) $('membersMenuCount').textContent = members.length;
  if ($('changeAdminPassBtn')) $('changeAdminPassBtn').classList.toggle('hidden', isMem);

  $('addBtn').classList.toggle('hidden', isMem);
  $('memberFilterSelect').classList.toggle('hidden', isMem);
  $('backToAdminBtn').classList.toggle('hidden', !(isMem && currentUser.isAdminPreview));

}

async function syncFromCloud(force = false, silent = true, refreshActive = true) {
  const statusEl = $('loginCloudStatus');
  const headerBtn = $('cloudSyncBtn');
  const headerTxt = $('cloudSyncText');
  if (!silent) {
    if (statusEl) statusEl.textContent = '⏳ Đang đồng bộ dữ liệu Online...';
    if (headerTxt) headerTxt.textContent = 'Đang đồng bộ...';
    else if (headerBtn) headerBtn.textContent = '⏳ Đang đồng bộ...';
  }
  const r = await window.api.cloudPull(force);
  if (r && r.ok) {
    activeCloudOk = true;
    activeCloudError = '';
    shops = r.shops || shops;
    members = r.members || members;
    if (r.authConfig) authConfig = r.authConfig;

    if (isMemberMode() && currentUser && currentUser.member) {
      const updatedMember = members.find((m) => m.id === currentUser.member.id);
      if (updatedMember) {
        currentUser.member = updatedMember;
      }
    }

    if (statusEl) {
      statusEl.textContent = `☁️ Online: ${shops.length} gian • ${members.length} TV`;
    }
    if (headerTxt) {
      headerTxt.textContent = 'Đã đồng bộ Online';
    } else if (headerBtn) {
      headerBtn.textContent = '☁️ Đã đồng bộ Online';
    }

    if (!currentUser) {
      renderLoginQuickAccounts();
    } else if (r.updated || !silent) {
      render();
    }
    if (refreshActive) await refreshOnlineActiveShops();
    renderAdminDashboard();

    if (!silent) {
      toast(`☁️ Đã đồng bộ Online mới nhất (${shops.length} gian hàng • ${members.length} thành viên)!`);
    }
    return true;
  } else {
    activeCloudOk = false;
    activeCloudError = (r && r.error) || 'Không kết nối được máy chủ Cloud';
    renderAdminDashboard();
    if (headerTxt) {
      headerTxt.textContent = 'Đồng bộ Online';
    } else if (headerBtn) {
      headerBtn.textContent = '☁️ Đồng bộ Online';
    }
    if (!silent) {
      toast('⚠️ Không kết nối được máy chủ Cloud, đang dùng dữ liệu trên máy.');
    }
    return false;
  }
}

// ---- MAN HINH DANG NHAP BAT BUOC KHI MO APP (ADMIN & NHAN VIEN) ----
function renderLoginQuickAccounts() {
  if ($('loginDefaultHint')) {
    $('loginDefaultHint').textContent =
      (authConfig.adminPass || '123456') === '123456'
        ? `TK Admin mặc định: ${authConfig.adminUser || 'admin'} / 123456`
        : `TK Admin: ${authConfig.adminUser || 'admin'}`;
  }
}

function showLoginScreen() {
  if (currentUser) {
    const userKey = currentUser.isAdminPreview ? 'admin' : getMyUserKey();
    const userName = currentUser.isAdminPreview ? 'Admin' : getMyUserName();
    const logoutEvent = recordShopActivity('logout');
    window.api.cloudReportActive({
      userKey,
      userName,
      role: isMemberMode() ? currentUser.member.permMode || 'cskh' : 'admin',
      shopIds: Array.from(runningIds),
      latestActivity: logoutEvent,
      proxyIssues: getVisibleShopsForRole()
        .filter((shop) => proxyStatusMap.get(shop.id)?.state === 'die')
        .map((shop) => shop.id),
      activityPending: shopActivityLog.filter((event) => !event.synced).length
    }).catch((error) => {
      console.warn('Không đồng bộ được trạng thái khi đăng xuất:', error);
    });
  }
  currentUser = null;
  document.body.classList.add('locked');
  if ($('grid')) $('grid').innerHTML = '';
  if ($('membersDlg') && $('membersDlg').open) $('membersDlg').close();
  if ($('dlg') && $('dlg').open) $('dlg').close();
  if ($('settingsDlg') && $('settingsDlg').open) $('settingsDlg').close();
  if ($('adminPassDlg') && $('adminPassDlg').open) $('adminPassDlg').close();

  $('loginError').classList.add('hidden');
  $('loginPass').value = '';
  renderLoginQuickAccounts();
  $('loginOverlay').classList.remove('hidden');
  setTimeout(() => {
    if ($('loginUser') && $('loginUser').value.trim()) {
      $('loginPass').focus();
    } else if ($('loginUser')) {
      $('loginUser').focus();
    }
  }, 50);
  syncFromCloud(false, true);
}

function findMatchingMember(u, p) {
  return members.find((m) => {
    const mUser = (m.username || slugUsername(m.name) || '').toLowerCase();
    const mName = (m.name || '').trim().toLowerCase();
    const mPass = m.password || '123456';
    return (u.toLowerCase() === mUser || u.toLowerCase() === mName) && p === mPass;
  });
}

async function doLogin(silent = false) {
  const u = $('loginUser').value.trim();
  const p = $('loginPass').value.trim();
  const errBox = $('loginError');

  if (!u || !p) {
    if (!silent) {
      errBox.textContent = '⚠️ Vui lòng nhập đầy đủ Tài khoản và Mật khẩu!';
      errBox.classList.remove('hidden');
    }
    return false;
  }

  const checkAdmin = () => {
    const adminU = (authConfig.adminUser || 'admin').toLowerCase();
    const adminP = authConfig.adminPass || '123456';
    return u.toLowerCase() === adminU && p === adminP;
  };

  // Neu chua khop ngay tren may -> tu dong tai du lieu Online moi nhat tu Cloud roi kiem tra lai
  if (!checkAdmin() && !findMatchingMember(u, p)) {
    if (!silent) {
      $('loginSubmitBtn').disabled = true;
      $('loginSubmitBtn').textContent = '⏳ Đang đồng bộ tài khoản Online...';
    }
    await syncFromCloud(true, true);
    if (!silent) {
      $('loginSubmitBtn').disabled = false;
      $('loginSubmitBtn').textContent = '🔐 Đăng nhập vào hệ thống';
    }
  }

  // Kiem tra tai khoan Admin
  if (checkAdmin()) {
    currentUser = { roleType: 'admin', member: null, isAdminPreview: false };
    activeMember = 'ALL';
    document.body.classList.remove('locked');
    $('loginOverlay').classList.add('hidden');
    render();
    if ($('rememberLoginChk') && $('rememberLoginChk').checked) {
      await window.api.saveSavedLogin({ user: u, pass: p });
    } else if (!silent) {
      await window.api.clearSavedLogin();
    }
    recordShopActivity('login');
    const loginStatusReport = reportMyActiveShops();
    await flushPendingActivity();
    toast('👑 Đã đăng nhập quyền Quản trị viên (Admin)!');
    const statusResult = await loginStatusReport;
    if (!statusResult.ok && !statusResult.queued) {
      toast('⚠️ Chưa gửi được trạng thái đăng nhập lên máy Admin: ' + (statusResult.error || 'Kiểm tra kết nối Cloud.'));
    }
    refreshOnlineActiveShops();
    refreshActivityHistory(true);
    syncFromCloud(false, true);
    return true;
  }

  // Kiem tra tai khoan Thanh vien (Nhan vien)
  const foundMember = findMatchingMember(u, p);
  if (foundMember) {
    currentUser = { roleType: 'member', member: foundMember, isAdminPreview: false };
    activeMember = foundMember.id;
    activeGroup = '__ALL__';
    document.body.classList.remove('locked');
    $('loginOverlay').classList.add('hidden');
    render();
    if ($('rememberLoginChk') && $('rememberLoginChk').checked) {
      await window.api.saveSavedLogin({ user: u, pass: p });
    } else if (!silent) {
      await window.api.clearSavedLogin();
    }
    recordShopActivity('login');
    const loginStatusReport = reportMyActiveShops();
    await flushPendingActivity();
    const assignedCount = getMemberShops(foundMember.id).length;
    toast(`👤 Xin chào ${foundMember.name}! Bạn đang quản lý ${assignedCount} gian hàng.`);
    const statusResult = await loginStatusReport;
    if (!statusResult.ok && !statusResult.queued) {
      toast('⚠️ Chưa gửi được trạng thái đăng nhập lên máy Admin: ' + (statusResult.error || 'Kiểm tra kết nối Cloud.'));
    }
    refreshOnlineActiveShops();
    syncFromCloud(false, true);
    return true;
  }

  if (!silent) {
    errBox.textContent = '❌ Sai tài khoản hoặc mật khẩu! Vui lòng kiểm tra lại.';
    errBox.classList.remove('hidden');
  }
  return false;
}

$('loginSubmitBtn').onclick = () => doLogin(false);
$('loginUser').onkeydown = (e) => {
  if (e.key === 'Enter') $('loginPass').focus();
};
$('loginPass').onkeydown = (e) => {
  if (e.key === 'Enter') doLogin(false);
};

if ($('userAvatarBtn')) {
  $('userAvatarBtn').onclick = (e) => {
    e.stopPropagation();
    const menu = $('userDropdownMenu');
    const wrap = $('userMenuWrap');
    if (!menu || !wrap) return;
    const isHidden = menu.classList.contains('hidden');
    if (isHidden) {
      menu.classList.remove('hidden');
      wrap.classList.add('open');
    } else {
      menu.classList.add('hidden');
      wrap.classList.remove('open');
    }
  };
}

document.addEventListener('click', (e) => {
  const wrap = $('userMenuWrap');
  const menu = $('userDropdownMenu');
  if (wrap && menu && !wrap.contains(e.target)) {
    menu.classList.add('hidden');
    wrap.classList.remove('open');
  }
});

document.querySelectorAll('.user-menu-item').forEach((item) => {
  item.addEventListener('click', () => {
    const menu = $('userDropdownMenu');
    const wrap = $('userMenuWrap');
    if (menu) menu.classList.add('hidden');
    if (wrap) wrap.classList.remove('open');
  });
});

$('switchAccountBtn').onclick = async () => {
  await window.api.clearSavedLogin();
  showLoginScreen();
  toast('🚪 Đã đăng xuất khỏi hệ thống');
};
$('backToAdminBtn').onclick = () => {
  currentUser = { roleType: 'admin', member: null, isAdminPreview: false };
  activeMember = 'ALL';
  render();
  toast('👑 Đã quay lại giao diện Quản trị viên (Admin)');
};

if ($('loginCloudSyncBtn')) {
  $('loginCloudSyncBtn').onclick = () => syncFromCloud(true, false);
}
if ($('cloudSyncBtn')) {
  $('cloudSyncBtn').onclick = async () => {
    if (!isMemberMode()) {
      await window.api.cloudPush();
    }
    await syncFromCloud(true, false);
  };
}

// ---- KIEM TRA VA CAP NHAT TRUC TIEP (LIVE OTA HOT-UPDATE) ----
async function checkAndUpdateOta(silent = true) {
  if (!window.api.checkOtaUpdate) return;
  const checkBtn = $('otaCheckBtn');
  const checkTxt = $('otaCheckText');
  if (!silent) {
    if (checkTxt) checkTxt.textContent = 'Đang kiểm tra OTA...';
    else if (checkBtn) checkBtn.textContent = '⏳ Đang kiểm tra...';
  }
  const res = await window.api.checkOtaUpdate();
  if (res && res.ok) {
    if (checkTxt) {
      checkTxt.textContent = res.hasUpdate
        ? `🔔 Có bản mới v${res.latestVersion}`
        : `Live OTA: v${res.currentVersion || '2.1.0'}`;
    } else if (checkBtn) {
      checkBtn.textContent = res.hasUpdate
        ? `🔔 Có bản mới v${res.latestVersion}`
        : `🔄 v${res.currentVersion || '2.1.0'}`;
    }
    if (res.hasUpdate) {
      const banner = $('otaUpdateBanner');
      if (banner) {
        $('otaBannerTitle').textContent = `🔔 Đã có bản cập nhật mới (Phiên bản v${res.latestVersion})!`;
        $('otaBannerNotes').textContent = `Nội dung cập nhật: ${res.notes || 'Bổ sung tính năng mới'} — Bấm cập nhật để áp dụng ngay (không tắt Chrome đang mở).`;
        banner.classList.remove('hidden');
      }
      if (!silent) {
        toast(`🔔 Phát hiện bản cập nhật mới v${res.latestVersion}! Hãy bấm "⚡ Cập nhật ngay".`);
      }
    } else if (!silent) {
      toast(`✅ Bạn đang sử dụng phiên bản mới nhất (v${res.currentVersion || '2.1.0'})!`);
    }
  } else if (!silent) {
    if (checkBtn) checkBtn.textContent = '🔄 Kiểm tra cập nhật';
    toast('⚠️ Không kiểm tra được bản cập nhật lúc này.');
  }
}

if ($('otaCheckBtn')) {
  $('otaCheckBtn').onclick = () => checkAndUpdateOta(false);
}
if ($('otaDismissBtn')) {
  $('otaDismissBtn').onclick = () => {
    $('otaUpdateBanner').classList.add('hidden');
  };
}
if ($('otaApplyBtn')) {
  $('otaApplyBtn').onclick = async () => {
    const btn = $('otaApplyBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Đang cập nhật (2s)...';
    toast('⏳ Đang tải bản cập nhật mới trực tiếp từ hệ thống...');
    const res = await window.api.applyOtaUpdate();
    if (!res || !res.ok) {
      btn.disabled = false;
      btn.textContent = '⚡ Cập nhật ngay (2s)';
      toast('❌ Lỗi cập nhật: ' + ((res && res.error) || 'Không tải được file'));
    } else if (window.api.restartApp) {
      try {
        const restart = await window.api.restartApp();
        if (!restart || !restart.ok) {
          btn.disabled = false;
          btn.textContent = '⚡ Cập nhật ngay (2s)';
          toast('❌ Đã tải bản mới nhưng không khởi động lại được: ' + ((restart && restart.error) || 'lỗi không rõ'));
          return;
        }
        btn.textContent = '🔄 Đang khởi động lại...';
        toast('✅ Đã cập nhật. Ứng dụng sẽ mở lại tại màn hình đăng nhập; các cửa sổ Chrome shop vẫn giữ nguyên.');
      } catch (error) {
        btn.disabled = false;
        btn.textContent = '⚡ Cập nhật ngay (2s)';
        toast('❌ Đã tải bản mới nhưng không khởi động lại được: ' + (error.message || 'lỗi không rõ'));
      }
    } else {
      btn.disabled = false;
      btn.textContent = '⚡ Cập nhật ngay (2s)';
      toast('✅ Đã tải cập nhật. Vui lòng cài bản nền tảng OTA mới để áp dụng thay đổi tiến trình nền.');
    }
  };
}

function formatProxyBadge(proxy) {
  if (!proxy || !String(proxy).trim()) return '';
  const raw = String(proxy).trim();
  try {
    if (raw.includes('://')) {
      const u = new URL(raw);
      return `${u.hostname}:${u.port}`;
    }
  } catch {}
  const parts = raw.split(':');
  if (parts.length >= 2) return `${parts[0]}:${parts[1]}`;
  return raw;
}

async function checkShopProxy(s, silent = false, force = false) {
  if (!s || !s.proxy || !String(s.proxy).trim()) return { ok: true };
  const previousStatus = proxyStatusMap.get(s.id);
  if (
    previousStatus &&
    !force &&
    previousStatus.proxy === s.proxy &&
    previousStatus.state === 'live' &&
    Date.now() - previousStatus.checkedAt < 30000
  ) {
    return { ok: true, ip: previousStatus.ip, country: previousStatus.country, ms: previousStatus.ms };
  }

  proxyStatusMap.set(s.id, { state: 'checking', proxy: s.proxy });
  updateShopProxyBadge(s);
  let res;
  try {
    res = await window.api.checkProxy(s.proxy);
  } catch (error) {
    res = { ok: false, error: error && error.message ? error.message : 'Không kiểm tra được Proxy' };
  }
  if (res && res.ok) {
    proxyStatusMap.set(s.id, {
      state: 'live',
      proxy: s.proxy,
      ip: res.ip,
      country: res.country,
      ms: res.ms,
      checkedAt: Date.now()
    });
    if (!silent) {
      toast(`🟢 Proxy ${s.name} LIVE! IP: ${res.ip} (${res.ms}ms${res.country ? ' • ' + res.country : ''})`);
    }
  } else {
    proxyStatusMap.set(s.id, {
      state: 'die',
      proxy: s.proxy,
      error: (res && res.error) || 'Proxy Die'
    });
    if (!silent) {
      toast(`🔴 Proxy ${s.name} DIE: ${(res && res.error) || 'Không kết nối được'}`);
    }
  }
  updateShopProxyBadge(s);
  return res;
}

function updateShopProxyBadge(shop) {
  const card = Array.from(document.querySelectorAll('.card[data-shop-id]'))
    .find((item) => item.dataset.shopId === shop.id);
  const badge = card && card.querySelector('.proxy-badge');
  if (!badge) return;

  const proxyShort = formatProxyBadge(shop.proxy);
  const savedStatus = proxyStatusMap.get(shop.id);
  const status = savedStatus && savedStatus.proxy === shop.proxy ? savedStatus : null;
  badge.className = 'badge proxy-badge';
  if (status && status.state === 'checking') {
    badge.textContent = '⏳ Đang check Proxy...';
    badge.title = 'Đang kiểm tra kết nối Proxy';
  } else if (status && status.state === 'live' && status.proxy === shop.proxy) {
    badge.classList.add('live');
    badge.textContent = `🟢 Live: ${status.ip || proxyShort} (${status.ms}ms${status.country ? '•' + status.country : ''})`;
    badge.title = 'Proxy hoạt động tốt. Bấm để kiểm tra lại.';
  } else if (status && status.state === 'die' && status.proxy === shop.proxy) {
    badge.classList.add('die');
    badge.textContent = `🔴 Proxy DIE (${proxyShort})`;
    badge.title = (status.error || 'Proxy lỗi') + ' - Bấm để kiểm tra lại';
  } else {
    badge.textContent = `🌐 ${proxyShort} (Bấm check)`;
    badge.title = 'Bấm vào đây để kiểm tra Proxy Live hay Die';
  }
}

function getFilteredShops() {
  const q = searchQuery.trim().toLowerCase();
  const baseShops = getVisibleShopsForRole();

  return baseShops.filter((s) => {
    if (activePlatform !== 'ALL' && (s.platform || 'tiktok') !== activePlatform) return false;
    if (activeGroup === '__RUNNING__' && !isShopActive(s.id)) return false;
    if (activeGroup !== '__ALL__' && activeGroup !== '__RUNNING__') {
      if ((s.group || '').trim() !== activeGroup) return false;
    }
    const shopMembers = getShopMembers(s);
    if (!isMemberMode()) {
      if (activeMember === '__UNASSIGNED__' && shopMembers.length > 0) return false;
      if (activeMember !== 'ALL' && activeMember !== '__UNASSIGNED__' && !shopMembers.some((m) => m.id === activeMember)) return false;
    }
    if (!q) return true;
    const memberNames = shopMembers.map((m) => `${m.name} ${m.role || ''}`).join(' ');
    const hay = [s.name, s.group, s.note, s.proxy, memberNames].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });
}

function renderMemberFilter() {
  const sel = $('memberFilterSelect');
  if (!sel) return;

  const validMemberIds = new Set(members.map((m) => m.id));
  if (!isMemberMode() && activeMember !== 'ALL' && activeMember !== '__UNASSIGNED__' && !validMemberIds.has(activeMember)) {
    activeMember = 'ALL';
  }

  const memberShopCounts = new Map(members.map((member) => [member.id, 0]));
  let unassignedCount = 0;
  for (const shop of shops) {
    const ids = Array.isArray(shop.memberIds) ? shop.memberIds : [];
    if (!ids.some((id) => memberShopCounts.has(id))) unassignedCount++;
    for (const id of new Set(ids)) {
      if (memberShopCounts.has(id)) memberShopCounts.set(id, memberShopCounts.get(id) + 1);
    }
  }
  sel.innerHTML = '';

  const optAll = document.createElement('option');
  optAll.value = 'ALL';
  optAll.textContent = `👥 Tất cả thành viên (${members.length})`;
  sel.appendChild(optAll);

  const optUnassigned = document.createElement('option');
  optUnassigned.value = '__UNASSIGNED__';
  optUnassigned.textContent = `⚠️ Chưa giao ai (${unassignedCount} gian)`;
  sel.appendChild(optUnassigned);

  for (const m of members) {
    const count = memberShopCounts.get(m.id) || 0;
    const pMode = getPermModeLabel(m.permMode || 'cskh');
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = `👤 ${m.name} [${pMode}] (${count} gian)`;
    sel.appendChild(opt);
  }

  sel.value = activeMember;

  const membersBtn = $('membersBtn');
  if (membersBtn) {
    membersBtn.textContent = `👥 Thành viên (${members.length})`;
  }
}

$('memberFilterSelect').onchange = (e) => {
  activeMember = e.target.value || 'ALL';
  render();
};

$('platformFilterSelect').onchange = (e) => {
  activePlatform = e.target.value || 'ALL';
  render();
};

function renderGroupTabs() {
  const wrap = $('groupTabs');
  wrap.innerHTML = '';

  const visibleRoleShops = getVisibleShopsForRole();
  const roleShops = visibleRoleShops.filter(
    (shop) => activePlatform === 'ALL' || (shop.platform || 'tiktok') === activePlatform
  );
  const shopeeCount = visibleRoleShops.filter((shop) => shop.platform === 'shopee').length;
  const groups = Array.from(
    new Set(roleShops.map((s) => (s.group || '').trim()).filter(Boolean))
  );

  const groupCounts = new Map();
  let runningInRole = 0;
  for (const shop of roleShops) {
    const group = (shop.group || '').trim();
    if (group) groupCounts.set(group, (groupCounts.get(group) || 0) + 1);
    if (isShopActive(shop.id)) runningInRole++;
  }

  const items = [
    { key: '__ALL__', label: `Tất cả (${roleShops.length})` },
    { key: '__RUNNING__', label: `🟢 Đang mở (${runningInRole})` },
    {
      key: '__PLATFORM_SHOPEE__',
      label: `🛒 Shopee (${shopeeCount})`,
      platform: 'shopee'
    },
    ...groups.map((g) => ({
      key: g,
      label: `📁 ${g} (${groupCounts.get(g) || 0})`
    }))
  ];

  if (
    activeGroup !== '__ALL__' &&
    activeGroup !== '__RUNNING__' &&
    !groups.includes(activeGroup)
  ) {
    activeGroup = '__ALL__';
  }

  for (const item of items) {
    const btn = document.createElement('button');
    btn.className = 'tab-pill' + (
      (item.platform ? activePlatform === item.platform : activeGroup === item.key) ? ' active' : ''
    );
    btn.textContent = item.label;
    btn.onclick = () => {
      if (item.platform) {
        activePlatform = item.platform;
        activeGroup = '__ALL__';
        $('platformFilterSelect').value = item.platform;
        render();
        return;
      }
      activeGroup = item.key;
      render();
    };
    wrap.appendChild(btn);
  }

  const dl = $('groupSuggestions');
  if (dl) {
    dl.innerHTML = '';
    for (const g of groups) {
      const opt = document.createElement('option');
      opt.value = g;
      dl.appendChild(opt);
    }
  }
}

function updateStatsAndBatchBar(filtered) {
  const roleShops = getVisibleShopsForRole();
  let runningInRole = 0;
  let localRunningInRole = 0;
  for (const shop of roleShops) {
    if (isShopActive(shop.id)) runningInRole++;
    if (runningIds.has(shop.id)) localRunningInRole++;
  }

  $('statsBadge').innerHTML =
    `${isMemberMode() ? 'Được giao' : 'Tổng'}: <b>${roleShops.length}</b> gian • <span class="open-count">🟢 ${runningInRole} đang mở</span>`;

  const validIds = new Set(roleShops.map((s) => s.id));
  for (const id of Array.from(selectedIds)) {
    if (!validIds.has(id)) selectedIds.delete(id);
  }

  const openSelectedBtn = $('openSelectedBtn');
  openSelectedBtn.textContent = `🚀 Mở đã chọn (${selectedIds.size})`;
  openSelectedBtn.disabled = selectedIds.size === 0;

  const closeAllBtn = $('closeAllBtn');
  closeAllBtn.textContent = `⏹ Đóng Chrome (${localRunningInRole})`;
  closeAllBtn.disabled = localRunningInRole === 0;

  const selectAllChk = $('selectAllChk');
  if (filtered.length === 0) {
    selectAllChk.checked = false;
    selectAllChk.indeterminate = false;
  } else {
    const selectedInFiltered = filtered.filter((s) => selectedIds.has(s.id)).length;
    selectAllChk.checked = selectedInFiltered === filtered.length;
    selectAllChk.indeterminate =
      selectedInFiltered > 0 && selectedInFiltered < filtered.length;
  }
}

function render() {
  if (!currentUser) {
    document.body.classList.add('locked');
    if ($('grid')) $('grid').innerHTML = '';
    return;
  }
  applyRoleUI();
  renderMemberFilter();
  renderGroupTabs();
  const filtered = getFilteredShops();
  updateStatsAndBatchBar(filtered);

  const showingAllPlatforms = activePlatform === 'ALL';
  const hasVisibleShops = getVisibleShopsForRole().length > 0;
  const mainShops = showingAllPlatforms
    ? filtered.filter((shop) => (shop.platform || 'tiktok') !== 'shopee')
    : filtered;
  const shopeeShops = showingAllPlatforms
    ? filtered.filter((shop) => shop.platform === 'shopee')
    : [];

  const shopListTitle = $('shopListTitle');
  if (shopListTitle) {
    shopListTitle.textContent = activePlatform === 'shopee'
      ? '🛍️ Danh sách gian hàng Shopee'
      : '🛍️ Danh sách gian hàng TikTok';
  }
  const shopListCount = $('shopListCount');
  if (shopListCount) {
    shopListCount.textContent = `${mainShops.length} gian hàng`;
  }
  const shopListBody = $('shopListBody');
  if (shopListBody) {
    shopListBody.classList.toggle('collapsed', isShopListCollapsed);
  }
  const shopListToggle = $('shopListToggle');
  if (shopListToggle) {
    shopListToggle.textContent = isShopListCollapsed ? '▾ Mở rộng danh sách' : '▴ Thu gọn';
    shopListToggle.onclick = () => {
      isShopListCollapsed = !isShopListCollapsed;
      try { localStorage.setItem('shopListCollapsed', isShopListCollapsed ? '1' : '0'); } catch {}
      render();
    };
  }

  const shopeeSection = $('shopListShopeeSection');
  if (shopeeSection) shopeeSection.classList.toggle('hidden', !showingAllPlatforms);
  const shopeeCount = $('shopListShopeeCount');
  if (shopeeCount) shopeeCount.textContent = `${shopeeShops.length} gian hàng`;
  const shopeeBody = $('shopListShopeeBody');
  if (shopeeBody) shopeeBody.classList.toggle('collapsed', isShopeeListCollapsed);
  const shopeeToggle = $('shopListShopeeToggle');
  if (shopeeToggle) {
    shopeeToggle.textContent = isShopeeListCollapsed ? '▾ Mở rộng danh sách' : '▴ Thu gọn';
    shopeeToggle.onclick = () => {
      isShopeeListCollapsed = !isShopeeListCollapsed;
      try { localStorage.setItem('shopeeListCollapsed', isShopeeListCollapsed ? '1' : '0'); } catch {}
      render();
    };
  }

  const grid = $('grid');
  grid.innerHTML = '';
  const shopeeGrid = $('gridShopee');
  if (shopeeGrid) shopeeGrid.innerHTML = '';
  const emptyEl = $('empty');
  if (mainShops.length === 0) {
    emptyEl.classList.remove('hidden');
    emptyEl.innerHTML = isMemberMode() && !hasVisibleShops
      ? `Tài khoản <b>${currentUser.member.name}</b> hiện chưa được Quản trị viên phân công gian hàng nào.<br>Hãy nhờ Admin tích chọn giao shop trong mục <b>👥 Thành viên</b>.`
      : `Chưa có gian hàng ${activePlatform === 'shopee' ? 'Shopee' : 'TikTok'} nào phù hợp.${isMemberMode() ? '' : '<br>Bấm “+ Thêm gian hàng” để bắt đầu.'}`;
  } else {
    emptyEl.classList.add('hidden');
  }
  const emptyShopee = $('emptyShopee');
  if (emptyShopee) {
    emptyShopee.classList.toggle('hidden', shopeeShops.length > 0);
    emptyShopee.textContent = 'Chưa có gian hàng Shopee nào phù hợp.';
  }

  filtered.forEach((s) => {
    const isLocalRunning = runningIds.has(s.id);
    const isRunning = isLocalRunning;
    const shopMode = getShopPermMode(s); // 'cskh' | 'vanhanh' | 'ads'

    const card = document.createElement('div');
    card.dataset.shopId = s.id;
    card.className = 'card' + (isRunning ? ' is-running' : '');

    if (!isMemberMode()) {
      card.classList.add('is-draggable');
      card.setAttribute('draggable', 'true');
      card.title = '💡 Giữ chuột kéo thả để đổi thứ tự gian hàng';

      card.addEventListener('dragstart', (e) => {
        if (e.target.closest('button, input, select, .badge, .status-pill, .actions, .tools, .name')) {
          e.preventDefault();
          return;
        }
        draggedShopId = s.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', s.id);
        setTimeout(() => card.classList.add('dragging'), 0);
      });

      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        document.querySelectorAll('.card.drag-over').forEach((el) => el.classList.remove('drag-over'));
        draggedShopId = null;
      });

      card.addEventListener('dragover', (e) => {
        if (!draggedShopId || draggedShopId === s.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        card.classList.add('drag-over');
      });

      card.addEventListener('dragleave', (e) => {
        if (!card.contains(e.relatedTarget)) {
          card.classList.remove('drag-over');
        }
      });

      card.addEventListener('drop', async (e) => {
        e.preventDefault();
        card.classList.remove('drag-over');
        const sourceId = e.dataTransfer.getData('text/plain') || draggedShopId;
        if (!sourceId || sourceId === s.id) return;
        const fromIndex = shops.findIndex((x) => x.id === sourceId);
        const toIndex = shops.findIndex((x) => x.id === s.id);
        if (fromIndex !== -1 && toIndex !== -1) {
          const [moved] = shops.splice(fromIndex, 1);
          shops.splice(toIndex, 0, moved);
          await persist();
          render();
          toast(`Đã đổi vị trí gian "${moved.name}"`);
        }
      });
    }

    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.background = s.color || '#0f9d94';

    const head = document.createElement('div');
    head.className = 'head';

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'card-check';
    chk.title = 'Chọn gian này để mở hàng loạt';
    chk.checked = selectedIds.has(s.id);
    chk.onchange = () => {
      if (chk.checked) selectedIds.add(s.id);
      else selectedIds.delete(s.id);
      updateStatsAndBatchBar(getFilteredShops());
    };

    const av = document.createElement('div');
    av.className = 'avatar';
    av.style.background = s.color || '#0f9d94';
    av.textContent = initials(s.name);

    const headInfo = document.createElement('div');
    headInfo.className = 'head-info';
    const nm = document.createElement('div');
    nm.className = 'name';
    nm.textContent = s.name;
    nm.title = s.name;
    nm.setAttribute('aria-label', s.name);
    nm.addEventListener('mouseenter', () => showShopNameTooltip(nm, s.name));
    nm.addEventListener('mouseleave', hideShopNameTooltip);
    nm.addEventListener('dragstart', (e) => e.preventDefault());
    headInfo.appendChild(nm);

    const statusPill = document.createElement('div');
    statusPill.className = 'status-pill ' + (isRunning ? 'running' : 'stopped');
    let statusText = 'Đang đóng';
    let statusTitle = 'Chưa mở cửa sổ Chrome';
    if (isLocalRunning) {
      statusText = 'Đang mở';
      statusTitle = 'Đang mở Chrome trên máy này';
    }

    const assignedMembers = getShopMembers(s);
    statusPill.innerHTML = `<span class="dot"></span><span class="status-txt">${statusText}</span>`;
    statusPill.title = statusTitle;

    head.append(chk, av, headInfo, statusPill);

    // Hang hien thi Thanh vien + Group + Proxy
    const metaRow = document.createElement('div');
    metaRow.className = 'meta-row';

    const displayMembers = isMemberMode()
      ? [currentUser.member]
      : (activeMember !== 'ALL' && activeMember !== '__UNASSIGNED__'
          ? assignedMembers.filter((m) => m.id === activeMember)
          : assignedMembers);

    if (displayMembers.length > 0) {
      if (displayMembers.length === 1 || isMemberMode()) {
        const m = displayMembers[0];
        const mb = document.createElement('span');
        mb.className = 'badge member-badge';
        const pTag = m.permMode === 'vanhanh' ? '📦 Vận hành' : (m.permMode === 'ads' ? '📈 Ads' : '🎧 CSKH');
        mb.title = `Bộ phận ${pTag} — Phụ trách: ${m.name}`;
        const dot = document.createElement('span');
        dot.className = 'member-dot';
        dot.style.background = m.color || '#388bfd';
        const txt = document.createElement('span');
        txt.textContent = `${pTag}: ${m.name}`;
        mb.append(dot, txt);
        if (!isMemberMode()) {
          mb.onclick = () => {
            activeMember = activeMember === m.id ? 'ALL' : m.id;
            render();
          };
        }
        metaRow.appendChild(mb);
      } else {
        // KHI 2 NHAN VIEN TRO LEN: DROPDOWN GIONG O CHON TAT CA THANH VIEN!
        const sel = document.createElement('select');
        sel.className = 'badge member-select-dropdown';
        sel.title = `Gian hàng có ${displayMembers.length} thành viên phụ trách (Bấm chọn thành viên)`;

        const optDefault = document.createElement('option');
        optDefault.value = 'ALL';
        optDefault.textContent = `👥 ${displayMembers.length} nhân viên phụ trách ▾`;
        sel.appendChild(optDefault);

        displayMembers.forEach((m) => {
          const pTag = m.permMode === 'vanhanh' ? '📦 Vận hành' : (m.permMode === 'ads' ? '📈 Ads' : '🎧 CSKH');
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = `${pTag}: ${m.name}`;
          sel.appendChild(opt);
        });

        sel.onchange = (e) => {
          if (e.target.value && e.target.value !== 'ALL') {
            activeMember = e.target.value;
            render();
          }
        };
        sel.onclick = (e) => e.stopPropagation();

        metaRow.appendChild(sel);
      }
    }

    if (s.group && s.group.trim()) {
      const gb = document.createElement('span');
      gb.className = 'badge group-badge';
      gb.textContent = '📁 ' + s.group.trim();
      metaRow.appendChild(gb);
    }

    const platformBadge = document.createElement('span');
    platformBadge.className = 'badge group-badge';
    platformBadge.textContent = s.platform === 'shopee' ? '🛒 Shopee' : '🎵 TikTok';
    metaRow.appendChild(platformBadge);

    const proxyShort = formatProxyBadge(s.proxy);
    if (proxyShort) {
      const savedProxyState = proxyStatusMap.get(s.id);
      const pState = savedProxyState && savedProxyState.proxy === s.proxy ? savedProxyState : null;
      const pb = document.createElement('span');
      pb.className = 'badge proxy-badge';

      if (pState && pState.state === 'checking') {
        pb.textContent = '⏳ Đang check Proxy...';
      } else if (pState && pState.state === 'live') {
        pb.classList.add('live');
        pb.textContent = `🟢 Live: ${pState.ip || proxyShort} (${pState.ms}ms${pState.country ? '•' + pState.country : ''})`;
        pb.title = 'Proxy hoạt động tốt. Bấm để kiểm tra lại.';
      } else if (pState && pState.state === 'die') {
        pb.classList.add('die');
        pb.textContent = `🔴 Proxy DIE (${proxyShort})`;
        pb.title = (pState.error || 'Proxy lỗi') + ' - Bấm để kiểm tra lại';
      } else {
        pb.textContent = `🌐 ${proxyShort} (Bấm check)`;
        pb.title = 'Bấm vào đây để kiểm tra Proxy Live hay Die';
      }

      pb.onclick = () => checkShopProxy(s, false, true);
      metaRow.appendChild(pb);

      if (!isMemberMode()) {
        const changeProxyBtn = document.createElement('span');
        changeProxyBtn.className = 'badge proxy-change-btn';
        changeProxyBtn.textContent = '✏️ Đổi Proxy';
        changeProxyBtn.title = 'Đổi nhanh Proxy cho gian này';
        changeProxyBtn.onclick = () => openDialog(s, true);
        metaRow.appendChild(changeProxyBtn);
      }
    }

    const actions = document.createElement('div');
    actions.className = 'actions';

    if (s.platform === 'shopee') {
      const openBtn = mkBtn(
        isRunning ? '⚡ Đưa Shopee lên trước' : '🛒 Mở Shopee',
        'primary both',
        () => openShop(s, 'seller'),
        'Mở trang quản lý tài khoản Shopee trên Chrome riêng của shop'
      );
      actions.append(openBtn);
    } else if (!isMemberMode()) {
      // Giao diện Quản trị viên (Admin): 1 nút duy nhất để vào thẳng trang quản lý TikTok Shop!
      const openBtn = mkBtn(
        isRunning ? '⚡ Đưa cửa sổ lên trước' : '🚀 Mở TikTok Shop',
        'primary both',
        () => openShop(s, 'tiktok'),
        'Mở trực tiếp trang quản lý TikTok Seller Center'
      );
      actions.append(openBtn);
    } else if (shopMode === 'vanhanh') {
      // Quyền Vận hành: ẨN GMV Max Ads, ẨN Check đơn cũ, ẨN CSKH -> CHỈ HIỆN 1 nút Đơn hàng (To Ship)
      const vhBtn = mkBtn(
        isRunning ? '⚡ Đưa cửa sổ lên trước (📦 Đơn hàng)' : '📦 Đơn hàng (To Ship)',
        'primary both',
        () => openShop(s, 'cskh_orders'),
        'Mở trang Đơn hàng chờ vận chuyển (To Ship)'
      );
      actions.append(vhBtn);
    } else if (shopMode === 'cskh') {
      // Quyền CSKH: Chỉ để 1 link check đơn hàng nhưng đặt tên là 💬 CSKH, xóa đường link chat CSKH
      const cskhBtn = mkBtn(
        isRunning ? '⚡ Đưa cửa sổ lên trước (💬 CSKH)' : '💬 CSKH',
        'primary both',
        () => openShop(s, 'cskh_orders'),
        'Mở trang Đơn hàng CSKH (To Ship)'
      );
      actions.append(cskhBtn);
    } else {
      // Quyền Ads: 1 nút duy nhất mở GMV Max Ads
      const adsBtn = mkBtn(
        isRunning ? '⚡ Đưa cửa sổ lên trước (GMV Max Ads)' : '📈 GMV Max Ads',
        'primary both',
        () => openShop(s, 'ads'),
        'Mở trang GMV Max Ads TikTok Seller'
      );
      actions.append(adsBtn);
    }

    if (isRunning) {
      const closeBtn = mkBtn(
        '⏹ Đóng Chrome gian này',
        'danger-outline small close-chrome-btn',
        () => closeSingleShop(s)
      );
      actions.append(closeBtn);
    }

    card.append(bar, head);
    if (metaRow.childNodes.length > 0) card.appendChild(metaRow);
    if (s.note && s.note.trim()) {
      const noteDiv = document.createElement('div');
      noteDiv.className = 'note-box';
      noteDiv.textContent = '📝 ' + s.note.trim();
      noteDiv.title = s.note.trim();
      card.appendChild(noteDiv);
    }
    card.append(actions);

    if (!isMemberMode()) {
      const tools = document.createElement('div');
      tools.className = 'tools';
      tools.append(
        mkBtn('Sửa', 'small', () => openDialog(s, false)),
        mkBtn('Xóa đăng nhập', 'small danger', () => resetLogin(s), 'Xóa phiên đăng nhập đã lưu của gian này'),
        mkBtn('Xóa gian', 'small danger', () => deleteShop(s))
      );
      card.appendChild(tools);
    }

    if (showingAllPlatforms && s.platform === 'shopee') {
      shopeeGrid.appendChild(card);
    } else {
      grid.appendChild(card);
    }
  });
  renderDeptMonitor();
  renderAdminDashboard();
}

async function openShop(s, which) {
  // Neu gian chua mo va co cau hinh Proxy, tu dong kiem tra Proxy truoc khi mo
  if (!runningIds.has(s.id) && s.proxy && String(s.proxy).trim()) {
    const proxyStatus = proxyStatusMap.get(s.id);
    const hasFreshLiveProxy =
      proxyStatus &&
      proxyStatus.proxy === s.proxy &&
      proxyStatus.state === 'live' &&
      Date.now() - proxyStatus.checkedAt < 30000;
    if (!hasFreshLiveProxy) toast(`Đang kiểm tra Proxy của ${s.name}...`);
    const check = await checkShopProxy(s, true);
    if (!check || !check.ok) {
      if (isMemberMode()) {
        const forceOpen = confirm(
          `⚠️ Proxy của gian "${s.name}" hiện không kết nối được!\n\n` +
          `• Bấm Cancel để báo Quản trị viên (Admin) kiểm tra lại Proxy.\n` +
          `• Bấm OK nếu bạn vẫn muốn tiếp tục mở Chrome.`
        );
        if (!forceOpen) return;
      } else {
        const wantChange = confirm(
          `⚠️ Proxy của gian "${s.name}" hiện đang DIE (${(check && check.error) || 'Không kết nối được'})!\n\n` +
          `• Bấm OK để đổi Proxy mới ngay (khuyên dùng để tránh lỗi mạng / lộ IP).\n` +
          `• Bấm Cancel nếu bạn vẫn muốn mở Chrome.`
        );
        if (wantChange) {
          openDialog(s, true);
          return;
        }
      }
    }
  }

  let overrideUrl = '';
  if (s.platform !== 'shopee' && isMemberMode() && currentUser && currentUser.member) {
    if (which === 'ads') overrideUrl = currentUser.member.adsUrl || s.adsUrl || DEFAULT_ADS;
    if (which === 'cskh_orders') overrideUrl = currentUser.member.cskhOrdersUrl || s.cskhOrdersUrl || DEFAULT_CSKH_ORDERS;
  }

  const allowGmvExtension = s.platform !== 'shopee' && canCurrentUserUseGmvExtension();
  let r = await window.api.openShop(s.id, which, overrideUrl, allowGmvExtension);
  if (r && !r.ok && r.error === 'Thieu link de mo') {
    r = await window.api.openShop(s.id, 'ads', overrideUrl, allowGmvExtension);
  }
  if (r && r.ok) {
    runningIds.add(s.id);
    if (!r.alreadyOpen) recordShopActivity('open', s);
    render();
    if (r.extensionAccessNeedsRestart) {
      toast('GMV Max đã bị tắt cho tài khoản này. Nếu extension còn hiện, hãy đóng Chrome shop rồi mở lại.');
    }
    const reportPromise = reportMyActiveShops();
    reportPromise.then((reportResult) => {
      if (reportResult && !reportResult.ok && !reportResult.queued) {
        toast('⚠️ Đã mở shop nhưng chưa đồng bộ được lên máy Admin. ' + (reportResult.error || 'Vui lòng kiểm tra kết nối mạng.'));
      }
    });
    return;
  }
  if (r && r.error === 'NO_BROWSER') {
    showNoBrowser();
    return;
  }
  toast('Không mở được: ' + ((r && r.error) || 'lỗi không rõ'));
}

async function closeSingleShop(s) {
  if (closingShopIds.has(s.id)) return;
  closingShopIds.add(s.id);
  const card = Array.from(document.querySelectorAll('.card[data-shop-id]'))
    .find((item) => item.dataset.shopId === s.id);
  const closeBtn = card && card.querySelector('.close-chrome-btn');
  if (closeBtn) {
    closeBtn.disabled = true;
    closeBtn.textContent = '⏳ Đang đóng...';
  }
  try {
    const r = await window.api.closeShop(s.id);
    if (r && r.ok) {
      runningIds.delete(s.id);
      recordShopActivity('close', s);
      render();
      reportMyActiveShops();
      toast('Đã đóng Chrome của gian ' + s.name);
    } else {
      if (closeBtn) {
        closeBtn.disabled = false;
        closeBtn.textContent = '⏹ Đóng Chrome gian này';
      }
      toast('Không đóng được Chrome: ' + ((r && r.error) || 'lỗi không rõ'));
    }
  } catch (err) {
    if (closeBtn) {
      closeBtn.disabled = false;
      closeBtn.textContent = '⏹ Đóng Chrome gian này';
    }
    toast('Lỗi khi đóng Chrome: ' + err.message);
  } finally {
    closingShopIds.delete(s.id);
  }
}

// ---- Check tat ca Proxy ----
$('checkAllProxyBtn').onclick = async () => {
  const roleShops = getVisibleShopsForRole();
  const withProxy = roleShops.filter((s) => s.proxy && String(s.proxy).trim());
  if (!withProxy.length) {
    toast('Chưa có gian hàng nào gắn Proxy riêng để kiểm tra.');
    return;
  }
  const btn = $('checkAllProxyBtn');
  btn.disabled = true;
  btn.textContent = `⏳ Đang check (${withProxy.length})...`;
  toast(`Đang kiểm tra đồng loạt ${withProxy.length} Proxy...`);

  const results = await Promise.all(withProxy.map((s) => checkShopProxy(s, true, true)));
  const liveCount = results.filter((r) => r && r.ok).length;
  const dieCount = withProxy.length - liveCount;

  btn.disabled = false;
  btn.textContent = '🌐 Check tất cả Proxy';
  toast(`Kết quả Check ${withProxy.length} Proxy: 🟢 ${liveCount} Live • 🔴 ${dieCount} Die`);
};

// ---- Test Proxy trong popup Them/Sua ----
$('testProxyBtn').onclick = async () => {
  const raw = $('fProxy').value.trim();
  const st = $('proxyTestStatus');
  if (!raw) {
    st.className = 'proxy-test-status wait';
    st.textContent = 'ℹ️ Đang để trống (sử dụng mạng Internet gốc của máy).';
    return;
  }
  st.className = 'proxy-test-status wait';
  st.textContent = '⏳ Đang kiểm tra kết nối Proxy...';
  $('testProxyBtn').disabled = true;

  const res = await window.api.checkProxy(raw);
  $('testProxyBtn').disabled = false;

  if (res && res.ok) {
    st.className = 'proxy-test-status ok';
    st.textContent = `🟢 Proxy LIVE! IP: ${res.ip}${res.country ? ' • Quốc gia: ' + res.country : ''} • Tốc độ: ${res.ms}ms`;
  } else {
    st.className = 'proxy-test-status err';
    st.textContent = `🔴 Proxy DIE: ${(res && res.error) || 'Không kết nối được'}`;
  }
};

// ---- Tim kiem & Chon hang loat ----
$('searchInput').oninput = (e) => {
  searchQuery = e.target.value || '';
  clearTimeout(searchRenderTimer);
  searchRenderTimer = setTimeout(render, 120);
};

$('selectAllChk').onchange = (e) => {
  const filtered = getFilteredShops();
  if (e.target.checked) {
    filtered.forEach((s) => selectedIds.add(s.id));
  } else {
    filtered.forEach((s) => selectedIds.delete(s.id));
  }
  render();
};

$('openSelectedBtn').onclick = async () => {
  const list = getVisibleShopsForRole().filter((s) => selectedIds.has(s.id));
  if (!list.length) return;
  toast(`Đang mở lần lượt ${list.length} gian hàng...`);
  let openedCount = 0;
  for (let i = 0; i < list.length; i++) {
    const mode = getOpenActionForMode(getShopPermMode(list[i]));
    const result = await window.api.openShop(list[i].id, mode, '', canCurrentUserUseGmvExtension());
    if (result && result.ok) {
      runningIds.add(list[i].id);
      if (!result.alreadyOpen) recordShopActivity('open', list[i]);
      openedCount++;
      updateCardsRunningStatus();
    }
  }
  const reportResult = await reportMyActiveShops();
  if (reportResult && !reportResult.ok && !reportResult.queued) {
    toast(`Đã mở ${openedCount}/${list.length} shop. ⚠️ Chưa đồng bộ được lên máy Admin: ${reportResult.error || 'Vui lòng kiểm tra kết nối mạng.'}`);
  } else if (openedCount < list.length) {
    toast(`Đã mở ${openedCount}/${list.length} shop; một số shop mở không thành công.`);
  } else {
    toast(`Đã mở xong ${openedCount} gian hàng!`);
  }
};

$('closeAllBtn').onclick = async () => {
  const roleRunning = getVisibleShopsForRole().filter((s) => runningIds.has(s.id));
  if (!roleRunning.length) return;
  if (!confirm(`Đóng tất cả ${roleRunning.length} cửa sổ Chrome đang mở của tài khoản này?`)) return;
  if (isMemberMode()) {
    roleRunning.forEach((shop) => closingShopIds.add(shop.id));
    let results;
    try {
      results = await Promise.all(roleRunning.map((s) => window.api.closeShop(s.id)));
    } finally {
      roleRunning.forEach((shop) => closingShopIds.delete(shop.id));
    }
    const closedIds = roleRunning
      .filter((_shop, index) => results[index] && results[index].ok)
      .map((shop) => shop.id);
    roleRunning.forEach((shop, index) => {
      if (results[index] && results[index].ok) recordShopActivity('close', shop);
    });
    closedIds.forEach((id) => runningIds.delete(id));
    render();
    reportMyActiveShops();
    const failedCount = roleRunning.length - closedIds.length;
    toast(failedCount
      ? `Đã đóng ${closedIds.length}/${roleRunning.length} Chrome. Một số cửa sổ chưa đóng được.`
      : `Đã đóng ${closedIds.length} cửa sổ Chrome của bạn!`);
  } else {
    const r = await window.api.closeAllShops();
    if (r) {
      const closedIds = Array.isArray(r.closedIds)
        ? r.closedIds
        : roleRunning.slice(0, r.closedCount || 0).map((shop) => shop.id);
      roleRunning.forEach((shop) => {
        if (closedIds.includes(shop.id)) recordShopActivity('close', shop);
      });
      closedIds.forEach((id) => runningIds.delete(id));
      render();
      reportMyActiveShops();
      toast(r.ok
        ? `Đã đóng toàn bộ ${r.closedCount} cửa sổ Chrome!`
        : `Đã đóng ${r.closedCount}/${roleRunning.length} Chrome. ${r.error || 'Một số cửa sổ chưa đóng được.'}`);
    }
  }
};

// ---- Xuat / Nhap Backup (.json) ----
$('exportBtn').onclick = async () => {
  const r = await window.api.exportShops();
  if (r && r.ok) {
    toast(`Đã xuất ${r.count} gian hàng + danh sách thành viên ra file Backup!`);
  } else if (r && !r.canceled) {
    toast('Lỗi xuất file: ' + (r.error || 'không rõ'));
  }
};

$('importBtn').onclick = async () => {
  const r = await window.api.importShops();
  if (r && r.ok) {
    shops = r.shops || (await window.api.getShops());
    members = r.members || (await window.api.getMembers()) || [];
    if (r.importedMember && r.importedMember.id) {
      currentUser = { roleType: 'member', member: r.importedMember, isAdminPreview: false };
      activeMember = r.importedMember.id;
      document.body.classList.remove('locked');
      $('loginOverlay').classList.add('hidden');
      render();
      toast(`Đã nạp gói phân quyền của nhân viên ${r.importedMember.name}!`);
      return;
    }
    render();
    toast(`Đã nhập thành công (Thêm mới: ${r.added}, Cập nhật: ${r.updated})!`);
  } else if (r && !r.canceled) {
    toast('Lỗi nhập file: ' + (r.error || 'không rõ'));
  }
};

async function moveShop(index, delta) {
  const to = index + delta;
  if (to < 0 || to >= shops.length) return;
  const [m] = shops.splice(index, 1);
  shops.splice(to, 0, m);
  await persist();
  render();
}

// ---- Them / sua gian hang ----
function randomColor() {
  const palette = ['#0f9d94', '#e5484d', '#f5a524', '#3e63dd', '#8e4ec6', '#30a46c', '#d6409f', '#12a594'];
  return palette[shops.length % palette.length];
}

function openDialog(shop, focusProxy = false, initialPlatform = 'tiktok') {
  editingId = shop ? shop.id : null;
  const platform = shop
    ? (shop.platform === 'shopee' ? 'shopee' : 'tiktok')
    : (initialPlatform === 'shopee' ? 'shopee' : 'tiktok');
  $('dlgTitle').textContent = shop ? 'Sửa gian hàng' : 'Thêm Shop';
  $('fName').value = shop ? shop.name : '';
  $('fPlatform').value = platform;
  $('fSellerUrl').value = (shop && shop.sellerUrl) || (platform === 'shopee' ? DEFAULT_SHOPEE_URL : DEFAULT_TIKTOK_URL);
  $('fSellerUrl').dataset.platformDefault = platform === 'shopee' ? DEFAULT_SHOPEE_URL : DEFAULT_TIKTOK_URL;
  $('fGroup').value = shop && shop.group ? shop.group : '';
  $('fColor').value = shop ? shop.color : randomColor();
  $('fProxy').value = shop && shop.proxy ? shop.proxy : '';
  $('proxyTestStatus').className = 'proxy-test-status';
  $('proxyTestStatus').textContent = '';

  $('dlg').showModal();
  if (focusProxy) {
    setTimeout(() => {
      $('fProxy').focus();
      $('fProxy').select();
    }, 50);
  }
}

$('fPlatform').onchange = () => {
  const sellerUrl = $('fSellerUrl');
  const previousDefault = sellerUrl.dataset.platformDefault || '';
  const platform = $('fPlatform').value === 'shopee' ? 'shopee' : 'tiktok';
  const nextDefault = platform === 'shopee' ? DEFAULT_SHOPEE_URL : DEFAULT_TIKTOK_URL;
  if (!sellerUrl.value.trim() || sellerUrl.value.trim() === previousDefault) {
    sellerUrl.value = nextDefault;
  }
  sellerUrl.dataset.platformDefault = nextDefault;
};

$('addBtn').onclick = () => openDialog(null, false);
$('cancelBtn').onclick = () => $('dlg').close();

$('saveBtn').onclick = async () => {
  const name = $('fName').value.trim();
  if (!name) return $('fName').focus();
  const platform = $('fPlatform').value === 'shopee' ? 'shopee' : 'tiktok';
  const sellerUrl = $('fSellerUrl').value.trim();
  try {
    const parsedSellerUrl = new URL(sellerUrl);
    if (!['http:', 'https:'].includes(parsedSellerUrl.protocol)) throw new Error('invalid protocol');
  } catch {
    toast('Vui lòng nhập link quản lý hợp lệ bắt đầu bằng http:// hoặc https://');
    $('fSellerUrl').focus();
    return;
  }
  const newProxy = $('fProxy').value.trim();

  let proxyChangedWhileRunning = false;
  let targetShop = null;

  if (editingId) {
    targetShop = shops.find((x) => x.id === editingId);
    if (!targetShop) return;
    const oldProxy = targetShop.proxy || '';
    if (oldProxy !== newProxy) {
      proxyStatusMap.delete(editingId);
      if (runningIds.has(editingId)) {
        proxyChangedWhileRunning = true;
      }
    }
    targetShop.name = name;
    targetShop.platform = platform;
    targetShop.sellerUrl = sellerUrl;
    targetShop.group = $('fGroup').value.trim();
    targetShop.color = $('fColor').value;
    targetShop.proxy = newProxy;
  } else {
    targetShop = {
      id: Date.now().toString(36),
      name,
      platform,
      sellerUrl,
      group: $('fGroup').value.trim(),
      color: $('fColor').value,
      proxy: newProxy,
      memberIds: []
    };
    shops.push(targetShop);
  }

  activePlatform = platform;
  await persist();
  $('dlg').close();
  render();

  if (proxyChangedWhileRunning && targetShop) {
    toast('Đang khởi động lại Chrome của ' + targetShop.name + ' để áp dụng Proxy mới...');
    await window.api.closeShop(targetShop.id);
    runningIds.delete(targetShop.id);
    const mode = isMemberMode() ? getOpenActionForMode(getShopPermMode(targetShop)) : 'tiktok';
    setTimeout(() => openShop(targetShop, mode), 400);
  } else {
    toast(editingId ? 'Đã lưu thay đổi!' : 'Đã thêm gian hàng mới!');
  }
};

// ---- QUAN LY THANH VIEN & PHAN QUYEN CSKH / VAN HANH / ADS ----
function randomMemberColor() {
  const palette = ['#388bfd', '#2ea043', '#d29922', '#a371f7', '#db61a2', '#0f9d94', '#f85149'];
  return palette[members.length % palette.length];
}

function updateSelectedShopCountInMemberModal() {
  const checked = $('mShopsChecklist').querySelectorAll('input[type="checkbox"]:checked').length;
  $('mSelectedShopCount').textContent = String(checked);
}

function renderMemberShopsChecklist(assignedShopIds = []) {
  const box = $('mShopsChecklist');
  box.innerHTML = '';
  if (!shops.length) {
    box.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:6px;">Chưa có gian hàng nào.</div>';
    $('mSelectedShopCount').textContent = '0';
    return;
  }
  const set = new Set(assignedShopIds);
  shops.forEach((s) => {
    const lbl = document.createElement('label');
    lbl.className = 'shop-assign-item';

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.value = s.id;
    chk.checked = set.has(s.id);
    chk.onchange = updateSelectedShopCountInMemberModal;

    const dot = document.createElement('span');
    dot.className = 'member-dot';
    dot.style.background = s.color || '#0f9d94';

    const txt = document.createElement('span');
    txt.style.flex = '1';
    const platformLabel = s.platform === 'shopee' ? '🛒 Shopee' : '🎵 TikTok';
    txt.textContent = `${platformLabel} • ${s.name}${s.group ? ` [${s.group}]` : ''}`;

    lbl.append(chk, dot, txt);
    box.appendChild(lbl);
  });
  updateSelectedShopCountInMemberModal();
}

let usernameManuallyEdited = false;
$('mUsername').oninput = () => {
  usernameManuallyEdited = Boolean($('mUsername').value.trim());
};
$('mName').oninput = () => {
  if (!editingMemberId && !usernameManuallyEdited) {
    $('mUsername').value = slugUsername($('mName').value);
  }
};

function updateMemberPermLinksUI() {
  const mode = $('mPermMode').value || 'cskh';
  const isAds = mode === 'ads';
  const isVanhanh = mode === 'vanhanh';

  if ($('mAdsLinkRow')) {
    $('mAdsLinkRow').classList.toggle('hidden', !isAds);
  }
  if ($('mCskhOrdersRow')) {
    $('mCskhOrdersRow').classList.toggle('hidden', isAds);
  }

  if ($('mPermLinksTitle')) {
    $('mPermLinksTitle').textContent = isAds
      ? '🔗 Link mở trang cho nhân viên Ads:'
      : (isVanhanh
        ? '🔗 Link mở trang cho nhân viên Vận hành:'
        : '🔗 Link mở trang cho nhân viên CSKH:');
  }

  if ($('mCskhOrdersLabel')) {
    $('mCskhOrdersLabel').textContent = isVanhanh
      ? 'Link mở Đơn hàng'
      : 'Link mở CSKH';
  }
}

$('mPermMode').onchange = updateMemberPermLinksUI;

function resetMemberForm() {
  editingMemberId = null;
  usernameManuallyEdited = false;
  $('memberFormTitle').textContent = '+ Tạo tài khoản thành viên';
  $('mName').value = '';
  $('mUsername').value = '';
  $('mPassword').value = '123456';
  $('mPermMode').value = 'cskh';
  $('mGmvExtensionEnabled').checked = false;
  if ($('mCskhChat')) $('mCskhChat').value = '';
  $('mCskhOrders').value = DEFAULT_CSKH_ORDERS;
  if ($('mAdsUrl')) $('mAdsUrl').value = DEFAULT_ADS;
  updateMemberPermLinksUI();
  $('mPhone').value = '';
  $('mColor').value = randomMemberColor();
  $('mSaveBtn').textContent = '💾 Lưu thành viên & Phân quyền';
  $('mCancelEditBtn').classList.add('hidden');
  renderMemberShopsChecklist([]);
}

function startEditMember(m) {
  editingMemberId = m.id;
  usernameManuallyEdited = true;
  $('memberFormTitle').textContent = '✏️ Sửa & Phân quyền: ' + m.name;
  $('mName').value = m.name || '';
  $('mUsername').value = m.username || slugUsername(m.name) || '';
  $('mPassword').value = m.password || '123456';
  $('mPermMode').value = m.permMode || 'cskh';
  $('mGmvExtensionEnabled').checked = m.gmvExtensionEnabled === true;
  if ($('mCskhChat')) $('mCskhChat').value = '';
  $('mCskhOrders').value = m.cskhOrdersUrl || DEFAULT_CSKH_ORDERS;
  if ($('mAdsUrl')) $('mAdsUrl').value = m.adsUrl || DEFAULT_ADS;
  updateMemberPermLinksUI();
  $('mPhone').value = m.phone || '';
  $('mColor').value = m.color || '#388bfd';
  $('mSaveBtn').textContent = '💾 Cập nhật thành viên';
  $('mCancelEditBtn').classList.remove('hidden');
  const assignedIds = getMemberShops(m.id).map((s) => s.id);
  renderMemberShopsChecklist(assignedIds);
  $('mName').focus();
}

function renderMembersListModal() {
  $('membersTotalCount').textContent = String(members.length);
  const box = $('membersListBox');
  box.innerHTML = '';

  if (!members.length) {
    box.innerHTML =
      '<div style="text-align:center;color:var(--muted);padding:40px 16px;font-size:13px;border:1px dashed var(--line);border-radius:10px;">' +
      'Chưa có thành viên nào.<br>Hãy nhập Họ tên, Tài khoản, Mật khẩu ở khung bên trái, chọn <b>🎧 Quyền CSKH</b> hoặc <b>📦 Quyền Vận hành</b> và tích chọn các gian hàng để tạo tài khoản cho nhân viên.' +
      '</div>';
    return;
  }

  members.forEach((m) => {
    const mShops = getMemberShops(m.id);
    const uname = m.username || slugUsername(m.name) || m.name;
    const upass = m.password || '123456';
    const pMode = m.permMode || 'cskh';

    const card = document.createElement('div');
    card.className = 'member-card';

    const head = document.createElement('div');
    head.className = 'member-card-head';

    const av = document.createElement('div');
    av.className = 'member-avatar';
    av.style.background = m.color || '#388bfd';
    av.textContent = initials(m.name);

    const info = document.createElement('div');
    info.className = 'member-info';

    const nameRow = document.createElement('div');
    nameRow.className = 'member-name';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = m.name;
    nameRow.appendChild(nameSpan);

    const roleSpan = document.createElement('span');
    roleSpan.className = 'member-role';
    if (pMode === 'vanhanh') {
      roleSpan.style.color = '#f5a524';
      roleSpan.style.borderColor = 'rgba(245,165,36,.45)';
      roleSpan.textContent = '📦 Quyền Vận hành (Chỉ mở Đơn hàng To Ship)';
    } else if (pMode === 'cskh') {
      roleSpan.style.color = '#56e3d8';
      roleSpan.style.borderColor = 'rgba(15,157,148,.45)';
      roleSpan.textContent = '💬 Quyền CSKH (Mở Đơn hàng CSKH)';
    } else {
      roleSpan.style.color = '#79c0ff';
      roleSpan.style.borderColor = 'rgba(56,139,253,.45)';
      roleSpan.textContent = '📈 Quyền Ads & Check đơn';
    }
    nameRow.appendChild(roleSpan);

    const credSpan = document.createElement('span');
    credSpan.className = 'cred-badge';
    credSpan.textContent = `🔑 TK: ${uname} | MK: ${upass}`;
    nameRow.appendChild(credSpan);

    const sub = document.createElement('div');
    sub.className = 'member-sub';
    const shopeeCount = mShops.filter((shop) => shop.platform === 'shopee').length;
    const tiktokCount = mShops.length - shopeeCount;
    sub.textContent = `Đang được phân công: ${mShops.length} shop (🎵 TikTok ${tiktokCount} • 🛒 Shopee ${shopeeCount})` +
      (m.phone ? ` • 📞 ${m.phone}` : '') +
      (m.gmvExtensionEnabled === true ? ' • 🧩 GMV Max: Đã bật' : ' • 🧩 GMV Max: Đã tắt');

    info.append(nameRow, sub);
    head.append(av, info);
    card.appendChild(head);

    if (mShops.length > 0) {
      const tagsWrap = document.createElement('div');
      tagsWrap.className = 'member-shops-tags';
      mShops.forEach((s) => {
        const tag = document.createElement('span');
        tag.className = 'member-shop-tag';
        tag.textContent = `${s.platform === 'shopee' ? '🛒 Shopee' : '🎵 TikTok'} • ${s.name}`;
        tagsWrap.appendChild(tag);
      });
      card.appendChild(tagsWrap);
    } else {
      const noShop = document.createElement('div');
      noShop.style.cssText = 'font-size:12px;color:var(--muted);font-style:italic;';
      noShop.textContent = 'Chưa được giao gian hàng nào';
      card.appendChild(noShop);
    }

    const actions = document.createElement('div');
    actions.className = 'member-actions';

    const viewAsMemberBtn = mkBtn(
      `👁️ Vào giao diện NV (${mShops.length})`,
      'small primary',
      () => {
        currentUser = { roleType: 'member', member: m, isAdminPreview: true };
        activeMember = m.id;
        activeGroup = '__ALL__';
        $('membersDlg').close();
        render();
        const modeDesc =
          pMode === 'vanhanh'
            ? 'Chế độ Vận hành: chỉ hiện nút 📦 Đơn hàng To Ship'
            : pMode === 'cskh'
            ? 'Chế độ CSKH: chỉ hiện nút 💬 CSKH (Check đơn hàng)'
            : 'Chế độ Ads';
        toast(`👤 Đang xem giao diện của nhân viên ${m.name} (${modeDesc}).`);
      },
      'Chuyển sang đúng màn hình làm việc của nhân viên này'
    );

    const openAllMemberBtn = mkBtn(
      `🚀 Mở cả nhóm (${mShops.length})`,
      'small success',
      async () => {
        if (!mShops.length) return toast(`Thành viên ${m.name} chưa được giao gian nào!`);
        $('membersDlg').close();
        const openMode = getOpenActionForMode(pMode);
        toast(`Đang mở ${mShops.length} gian của ${m.name} (${getPermModeLabel(pMode)})...`);
        let openedCount = 0;
        for (let i = 0; i < mShops.length; i++) {
          const result = await window.api.openShop(mShops[i].id, openMode, '', m.gmvExtensionEnabled === true);
          if (result && result.ok) {
            runningIds.add(mShops[i].id);
            openedCount++;
            render();
          }
        }
        toast(`Đã mở xong ${openedCount}/${mShops.length} gian của ${m.name}!`);
      },
      'Mở đồng loạt tất cả các gian của thành viên này'
    );
    openAllMemberBtn.disabled = mShops.length === 0;

    const toggleGmvExtensionBtn = mkBtn(
      m.gmvExtensionEnabled === true ? '🧩 Tắt GMV Max' : '🧩 Bật GMV Max',
      'small',
      async () => {
        m.gmvExtensionEnabled = m.gmvExtensionEnabled !== true;
        await persistMembers();
        renderMembersListModal();
        render();
        toast(`Đã ${m.gmvExtensionEnabled ? 'bật' : 'tắt'} extension GMV Max cho ${m.name}.`);
      },
      'Cấp hoặc thu hồi quyền dùng extension GMV Max cho tài khoản này'
    );

    const copyCredBtn = mkBtn(
      '📋 Copy TK/MK gửi NV',
      'small',
      async () => {
        const text = `Tài khoản đăng nhập App TikTok MultiShop (${getPermModeLabel(pMode)}):\n- Tài khoản: ${uname}\n- Mật khẩu: ${upass}\n- Số gian hàng được giao: ${mShops.length} gian`;
        try {
          await navigator.clipboard.writeText(text);
          toast(`📋 Đã copy Tài khoản & Mật khẩu của ${m.name}! Gửi cho nhân viên đăng nhập trên máy họ là tự động đồng bộ.`);
        } catch {
          toast(`TK: ${uname} | MK: ${upass}`);
        }
      },
      'Copy nhanh Tài khoản & Mật khẩu để gửi qua Zalo cho nhân viên đăng nhập trên máy riêng'
    );

    const editBtn = mkBtn('✏️ Sửa / Chia shop', 'small', () => startEditMember(m));

    const delBtn = mkBtn('🗑 Xóa', 'small danger', async () => {
      if (!confirm(`Xóa thành viên "${m.name}"?\n(Các gian hàng của họ vẫn được giữ nguyên, chỉ gỡ phân công của thành viên này.)`)) return;
      members = members.filter((x) => x.id !== m.id);
      shops.forEach((s) => {
        if (Array.isArray(s.memberIds)) {
          s.memberIds = s.memberIds.filter((id) => id !== m.id);
        }
      });
      if (editingMemberId === m.id) resetMemberForm();
      await persistMembers();
      await persist();
      renderMembersListModal();
      render();
      toast(`Đã xóa thành viên ${m.name} (Đã đồng bộ Online)`);
    });

    actions.append(viewAsMemberBtn, openAllMemberBtn, toggleGmvExtensionBtn, copyCredBtn, editBtn, delBtn);
    card.appendChild(actions);
    box.appendChild(card);
  });
}

function openMembersDialog() {
  resetMemberForm();
  renderMembersListModal();
  $('membersDlg').showModal();
}

$('membersBtn').onclick = () => openMembersDialog();
$('closeMembersDlgBtn').onclick = () => $('membersDlg').close();
$('mCancelEditBtn').onclick = () => resetMemberForm();
$('openLoginFromModalBtn').onclick = () => showLoginScreen();

function openAdminPassDialog() {
  if (!authConfig) authConfig = { adminUser: 'admin', adminPass: '123456', requireLogin: true };
  $('adminUserField').value = authConfig.adminUser || 'admin';
  $('adminNewPassField').value = '';
  $('adminConfirmPassField').value = '';
  $('adminNewPassField').type = 'password';
  $('toggleAdminPassVisibilityBtn').textContent = '👁';
  $('adminPassError').classList.add('hidden');
  $('adminPassError').textContent = '';
  $('adminPassDlg').showModal();
  setTimeout(() => $('adminNewPassField').focus(), 50);
}

$('changeAdminPassBtn').onclick = () => openAdminPassDialog();
if ($('openAdminPassFromSettingsBtn')) {
  $('openAdminPassFromSettingsBtn').onclick = () => {
    $('settingsDlg').close();
    openAdminPassDialog();
  };
}
if ($('openAdminPassFromMembersBtn')) {
  $('openAdminPassFromMembersBtn').onclick = () => {
    openAdminPassDialog();
  };
}
$('closeAdminPassDlgBtn').onclick = () => $('adminPassDlg').close();
$('cancelAdminPassBtn').onclick = () => $('adminPassDlg').close();

$('toggleAdminPassVisibilityBtn').onclick = () => {
  const f = $('adminNewPassField');
  if (f.type === 'password') {
    f.type = 'text';
    $('toggleAdminPassVisibilityBtn').textContent = '🙈';
  } else {
    f.type = 'password';
    $('toggleAdminPassVisibilityBtn').textContent = '👁';
  }
};

$('saveAdminPassBtn').onclick = async () => {
  const user = $('adminUserField').value.trim();
  const pass = $('adminNewPassField').value.trim();
  const confirm = $('adminConfirmPassField').value.trim();
  const errEl = $('adminPassError');

  if (!user) {
    errEl.textContent = '⚠️ Tên tài khoản Admin không được để trống!';
    errEl.classList.remove('hidden');
    $('adminUserField').focus();
    return;
  }
  if (!pass) {
    errEl.textContent = '⚠️ Mật khẩu mới không được để trống!';
    errEl.classList.remove('hidden');
    $('adminNewPassField').focus();
    return;
  }
  if (pass !== confirm) {
    errEl.textContent = '❌ Mật khẩu xác nhận không trùng khớp! Vui lòng nhập lại.';
    errEl.classList.remove('hidden');
    $('adminConfirmPassField').focus();
    return;
  }

  errEl.classList.add('hidden');
  $('saveAdminPassBtn').disabled = true;
  $('saveAdminPassBtn').textContent = '⏳ Đang lưu mật khẩu...';

  authConfig.adminUser = user;
  authConfig.adminPass = pass;

  // Luu xuong file tren may va dong bo len Cloud ngay
  await window.api.saveAuthConfig(authConfig);
  try {
    await window.api.cloudPush();
  } catch {}

  $('saveAdminPassBtn').disabled = false;
  $('saveAdminPassBtn').textContent = '💾 Lưu mật khẩu';
  $('adminPassDlg').close();

  // Cap nhat badge va thong bao
  applyRoleUI();
  renderAdminDashboard();
  renderLoginQuickAccounts();
  toast(`🔑 Đổi mật khẩu Admin thành công! Tài khoản: ${user}`);
};

$('mSelectAllShopsBtn').onclick = () => {
  $('mShopsChecklist').querySelectorAll('input[type="checkbox"]').forEach((c) => {
    c.checked = true;
  });
  updateSelectedShopCountInMemberModal();
};

$('mClearAllShopsBtn').onclick = () => {
  $('mShopsChecklist').querySelectorAll('input[type="checkbox"]').forEach((c) => {
    c.checked = false;
  });
  updateSelectedShopCountInMemberModal();
};

$('mSaveBtn').onclick = async () => {
  const name = $('mName').value.trim();
  if (!name) return $('mName').focus();

  const username = ($('mUsername').value.trim() || slugUsername(name) || 'nv' + (members.length + 1)).toLowerCase();
  const password = $('mPassword').value.trim() || '123456';
  const permMode = $('mPermMode').value || 'cskh';
  const role = permMode === 'vanhanh' ? 'Vận hành' : (permMode === 'cskh' ? 'CSKH' : 'Ads');
  const adsUrl = ($('mAdsUrl') && $('mAdsUrl').value.trim()) || DEFAULT_ADS;
  const cskhOrdersUrl = $('mCskhOrders').value.trim() || DEFAULT_CSKH_ORDERS;
  const cskhChatUrl = ($('mCskhChat') && $('mCskhChat').value.trim()) || cskhOrdersUrl;
  const phone = $('mPhone').value.trim();
  const color = $('mColor').value || '#388bfd';
  const gmvExtensionEnabled = $('mGmvExtensionEnabled').checked;
  const checkedShopIds = new Set(
    Array.from($('mShopsChecklist').querySelectorAll('input[type="checkbox"]:checked')).map((c) => c.value)
  );

  let memberId = editingMemberId;
  if (memberId) {
    const target = members.find((x) => x.id === memberId);
    if (target) {
      Object.assign(target, { name, username, password, permMode, role, adsUrl, cskhChatUrl, cskhOrdersUrl, phone, color, gmvExtensionEnabled });
    }
  } else {
    memberId = 'mem_' + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
    members.push({ id: memberId, name, username, password, permMode, role, adsUrl, cskhChatUrl, cskhOrdersUrl, phone, color, gmvExtensionEnabled });
  }

  // Cap nhat danh sach shop duoc giao cho thanh vien nay va gan luon duong link CSKH / Van hanh / Ads
  shops.forEach((s) => {
    const cur = new Set(Array.isArray(s.memberIds) ? s.memberIds : []);
    if (checkedShopIds.has(s.id)) {
      cur.add(memberId);
      if (permMode === 'cskh') {
        s.cskhChatUrl = cskhChatUrl;
        s.cskhOrdersUrl = cskhOrdersUrl;
        s.linkMode = 'cskh';
      } else if (permMode === 'vanhanh') {
        s.cskhOrdersUrl = cskhOrdersUrl;
        s.linkMode = 'vanhanh';
      } else if (permMode === 'ads') {
        s.adsUrl = adsUrl;
        s.linkMode = 'ads';
      }
    } else {
      cur.delete(memberId);
    }
    s.memberIds = Array.from(cur);
  });

  await persistMembers();
  await persist();
  const wasEdit = !!editingMemberId;
  resetMemberForm();
  renderMembersListModal();
  render();
  toast(
    wasEdit
      ? `Đã cập nhật TK "${username}" (${role}) và giao ${checkedShopIds.size} gian!`
      : `Đã tạo TK "${username}" (${role}) và giao ${checkedShopIds.size} gian!`
  );
};

// ---- Xoa dang nhap / xoa gian ----
async function resetLogin(s) {
  if (!confirm('Xóa đăng nhập đã lưu của gian "' + s.name + '"?\nHãy đóng cửa sổ Chrome của gian này trước. Lần sau phải đăng nhập lại.')) return;
  const r = await window.api.resetProfile(s.id);
  toast(r.ok ? 'Đã xóa đăng nhập của ' + s.name : r.error);
}

async function deleteShop(s) {
  if (!confirm('Xóa gian "' + s.name + '" khỏi danh sách?\n(Cũng xóa đăng nhập đã lưu của gian này. Hãy đóng cửa sổ Chrome của gian trước.)')) return;
  const r = await window.api.resetProfile(s.id);
  if (!r.ok) {
    toast(r.error);
    return;
  }
  selectedIds.delete(s.id);
  runningIds.delete(s.id);
  proxyStatusMap.delete(s.id);
  shops = shops.filter((x) => x.id !== s.id);
  await persist();
  render();
}

// ---- Trinh duyet ----
function showNoBrowser() {
  const n = $('notice');
  n.classList.remove('hidden');
  n.textContent = 'Không tìm thấy Google Chrome hoặc Microsoft Edge trên máy. Hãy cài Chrome, hoặc bấm “⚙ Trình duyệt” để chọn file chrome.exe thủ công.';
}

async function refreshBrowser() {
  const p = await window.api.getBrowser();
  $('browserPath').textContent = p || '(Chưa tìm thấy trình duyệt)';
  $('notice').classList.toggle('hidden', !!p);
  if (!p) showNoBrowser();
}

$('settingsBtn').onclick = async () => {
  await refreshBrowser();
  $('settingsDlg').showModal();
};
$('closeSettingsBtn').onclick = () => $('settingsDlg').close();
$('pickBrowserBtn').onclick = async () => {
  const p = await window.api.pickBrowser();
  if (p) await refreshBrowser();
};

(async function init() {
  shops = await window.api.getShops();
  members = (await window.api.getMembers()) || [];
  authConfig = (await window.api.getAuthConfig()) || { adminUser: 'admin', adminPass: '123456', requireLogin: true };
  const active = await window.api.getRunningShops();
  runningIds = new Set(active || []);
  window.api.onRunningChanged(async (ids) => {
    const nextRunningIds = new Set(ids || []);
    if (isMemberMode()) {
      runningIds.forEach((shopId) => {
        if (nextRunningIds.has(shopId) || closingShopIds.has(shopId)) return;
        const shop = shops.find((item) => item.id === shopId);
        recordShopActivity('close', shop || { id: shopId, name: shopId });
      });
    }
    runningIds = nextRunningIds;
    if (currentUser) {
      render();
      await reportMyActiveShops();
    }
  });
  refreshBrowser();
  // Kiem tra neu co tai khoan da duoc ghi nho tren may nay -> tu dong dang nhap
  let autoLoggedIn = false;
  const wasOtaRestart = window.api.wasOtaRestart
    ? await window.api.wasOtaRestart()
    : false;
  try {
    const saved = await window.api.getSavedLogin();
    if (saved && saved.user && saved.pass) {
      if ($('loginUser')) $('loginUser').value = saved.user;
      if ($('loginPass')) $('loginPass').value = saved.pass;
      if ($('rememberLoginChk')) $('rememberLoginChk').checked = true;
      if (!wasOtaRestart) autoLoggedIn = await doLogin(true);
    }
  } catch (err) {
    console.warn('Auto login error:', err);
  }

  if (!autoLoggedIn) {
    showLoginScreen();
  }
  // Kiem tra ban cap nhat moi (Live OTA) ngay khi mo app va moi 60 giay
  setTimeout(() => checkAndUpdateOta(true), 1500);
  setInterval(() => checkAndUpdateOta(true), 60000);
  // Tu dong dong bo du lieu Online ngam moi 15 giay giua may Admin va may Nhan vien
  setInterval(() => {
    syncFromCloud(false, true);
  }, 15000);
  // Dong bo trang thai mo/dong gian hang Online moi 4 giay (muot ma, tuc thi)
  setInterval(() => {
    if (currentUser && !isMemberMode()) refreshOnlineActiveShops();
  }, 4000);
  // Heartbeat dinh ky moi 7 giay de lien tuc lam moi trang thai Online & dong bo gian hang dang mo len Cloud
  setInterval(async () => {
    if (!currentUser) return;
    try {
      const active = await window.api.getRunningShops();
      if (Array.isArray(active)) {
        const nextRunningIds = new Set(active);
        const changed = nextRunningIds.size !== runningIds.size ||
          Array.from(nextRunningIds).some((id) => !runningIds.has(id));
        if (changed) {
          runningIds = nextRunningIds;
          render();
        }
      }
      await reportMyActiveShops();
      await flushPendingActivity();
    } catch (err) {
      console.warn('Không gửi được heartbeat nhân viên lên Cloud:', err);
    }
  }, 7000);
  setInterval(() => {
    if (currentUser && !isMemberMode()) refreshActivityHistory();
  }, 60000);
})();

window.addEventListener('beforeunload', () => {
  if (currentUser) {
    const userKey = currentUser.isAdminPreview ? 'admin' : getMyUserKey();
    const userName = currentUser.isAdminPreview ? 'Admin' : getMyUserName();
    try {
      if (runningIds.size === 0) {
        window.api.cloudReportActive({ userKey, userName, shopIds: [] });
      }
    } catch {}
  }
});
