const DEFAULT_ADS =
  'https://seller-vn.tiktok.com/ads-creation/dashboard?origin=SC_ads_tab_button_PC&btm_pre_unit_params=%7B%22btm_origin%22%3A%22sidebar_menu_Qu%E1%BA%A3ng+c%C3%A1o+c%E1%BB%ADa+h%C3%A0ng%22%7D';
const DEFAULT_ORDERS = 'https://seller-vn.tiktok.com/order?selected_sort=6&tab=all';
const DEFAULT_CSKH_CHAT =
  'https://seller-vn.tiktok.com/chat/inbox/current?oec_seller_id=7494826072462165266&shop_region=VN&lang=en&from=seller_center_navigation_im';
const DEFAULT_CSKH_ORDERS =
  'https://seller-vn.tiktok.com/order?order_status[]=1&selected_sort=11&tab=to_ship';

let shops = [];
let members = [];
let authConfig = { adminUser: 'admin', adminPass: '123456', requireLogin: true };
let currentUser = null;
let runningIds = new Set();
let selectedIds = new Set();
let proxyStatusMap = new Map();
let editingId = null;
let editingMemberId = null;
let currentDlgLinkMode = 'ads'; // 'ads' | 'cskh'
let searchQuery = '';
let activeGroup = '__ALL__';
let activeMember = 'ALL';

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

function getShopMembers(shop) {
  const ids = Array.isArray(shop && shop.memberIds) ? shop.memberIds : [];
  if (!ids.length) return [];
  return members.filter((m) => ids.includes(m.id));
}

function getMemberShops(memberId) {
  return shops.filter((s) => Array.isArray(s.memberIds) && s.memberIds.includes(memberId));
}

function isShopInCskhMode(shop) {
  // Neu dang dang nhap bang tai khoan nhan vien: dua theo quyen cua nhan vien do
  if (isMemberMode()) {
    return (currentUser.member.permMode || 'cskh') === 'cskh';
  }
  // Neu Admin dang loc xem theo 1 thanh vien cu the
  if (activeMember !== 'ALL' && activeMember !== '__UNASSIGNED__') {
    const m = members.find((x) => x.id === activeMember);
    if (m) return (m.permMode || 'cskh') === 'cskh';
  }
  // Neu gian hang duoc set che do CSKH hoac giao cho thanh vien CSKH
  if (shop && shop.linkMode === 'cskh') return true;
  const assigned = getShopMembers(shop);
  if (assigned.length > 0 && assigned.every((m) => (m.permMode || 'cskh') === 'cskh')) {
    return true;
  }
  return false;
}

function getVisibleShopsForRole() {
  if (!currentUser) return [];
  if (isMemberMode()) {
    return getMemberShops(currentUser.member.id);
  }
  return shops;
}

function applyRoleUI() {
  if (!currentUser) {
    document.body.classList.add('locked');
    return;
  }
  document.body.classList.remove('locked');
  const badge = $('currentUserBadge');
  const isMem = isMemberMode();

  if (isMem) {
    const m = currentUser.member;
    const permLabel = (m.permMode || 'cskh') === 'cskh' ? '🎧 CSKH' : '📈 Ads/Vận hành';
    badge.className = 'user-role-badge member';
    badge.textContent = `👤 Nhân viên: ${m.name} [${permLabel}]`;
    activeMember = m.id;
  } else {
    badge.className = 'user-role-badge admin';
    badge.textContent = `👑 Quản trị viên (${authConfig.adminUser || 'admin'})`;
  }

  $('membersBtn').classList.toggle('hidden', isMem);
  $('exportBtn').classList.toggle('hidden', isMem);
  $('addBtn').classList.toggle('hidden', isMem);
  $('memberFilterSelect').classList.toggle('hidden', isMem);
  $('backToAdminBtn').classList.toggle('hidden', !(isMem && currentUser.isAdminPreview));
  $('importBtn').textContent = isMem ? '📥 Nạp shop từ Admin' : '⬆ Nhập Backup';
}

// ---- MAN HINH DANG NHAP BAT BUOC KHI MO APP (ADMIN & NHAN VIEN) ----
function renderLoginQuickAccounts() {
  const wrap = $('loginQuickWrap');
  const pills = $('loginQuickPills');
  if (!wrap || !pills) return;
  pills.innerHTML = '';

  const adminPill = document.createElement('span');
  adminPill.className = 'login-quick-pill';
  adminPill.innerHTML = `👑 Admin (<b>${authConfig.adminUser || 'admin'}</b>)`;
  adminPill.onclick = () => {
    $('loginUser').value = authConfig.adminUser || 'admin';
    $('loginPass').value = '';
    $('loginPass').focus();
  };
  pills.appendChild(adminPill);

  members.forEach((m) => {
    const uname = m.username || slugUsername(m.name) || m.name;
    const p = document.createElement('span');
    p.className = 'login-quick-pill';
    const dot = document.createElement('span');
    dot.className = 'member-dot';
    dot.style.background = m.color || '#388bfd';
    const txt = document.createElement('span');
    txt.innerHTML = `${m.name} (<b>${uname}</b>)`;
    p.append(dot, txt);
    p.onclick = () => {
      $('loginUser').value = uname;
      $('loginPass').value = '';
      $('loginPass').focus();
    };
    pills.appendChild(p);
  });

  $('loginDefaultHint').textContent =
    (authConfig.adminPass || '123456') === '123456'
      ? `TK Admin mặc định: ${authConfig.adminUser || 'admin'} / 123456`
      : `TK Admin: ${authConfig.adminUser || 'admin'}`;
}

function showLoginScreen() {
  currentUser = null;
  document.body.classList.add('locked');
  if ($('grid')) $('grid').innerHTML = '';
  if ($('membersDlg') && $('membersDlg').open) $('membersDlg').close();
  if ($('dlg') && $('dlg').open) $('dlg').close();
  if ($('settingsDlg') && $('settingsDlg').open) $('settingsDlg').close();

  $('loginError').classList.add('hidden');
  $('loginPass').value = '';
  renderLoginQuickAccounts();
  $('loginOverlay').classList.remove('hidden');
  setTimeout(() => $('loginUser').focus(), 50);
}

function doLogin() {
  const u = $('loginUser').value.trim();
  const p = $('loginPass').value.trim();
  const errBox = $('loginError');

  if (!u || !p) {
    errBox.textContent = '⚠️ Vui lòng nhập đầy đủ Tài khoản và Mật khẩu!';
    errBox.classList.remove('hidden');
    return;
  }

  // Kiem tra tai khoan Admin
  const adminU = (authConfig.adminUser || 'admin').toLowerCase();
  const adminP = authConfig.adminPass || '123456';
  if (u.toLowerCase() === adminU && p === adminP) {
    currentUser = { roleType: 'admin', member: null, isAdminPreview: false };
    activeMember = 'ALL';
    document.body.classList.remove('locked');
    $('loginOverlay').classList.add('hidden');
    render();
    toast('👑 Đã đăng nhập quyền Quản trị viên (Admin)!');
    return;
  }

  // Kiem tra tai khoan Thanh vien (Nhan vien)
  const foundMember = members.find((m) => {
    const mUser = (m.username || slugUsername(m.name) || '').toLowerCase();
    const mName = (m.name || '').trim().toLowerCase();
    const mPass = m.password || '123456';
    return (u.toLowerCase() === mUser || u.toLowerCase() === mName) && p === mPass;
  });

  if (foundMember) {
    currentUser = { roleType: 'member', member: foundMember, isAdminPreview: false };
    activeMember = foundMember.id;
    activeGroup = '__ALL__';
    document.body.classList.remove('locked');
    $('loginOverlay').classList.add('hidden');
    render();
    const assignedCount = getMemberShops(foundMember.id).length;
    toast(`👤 Xin chào ${foundMember.name}! Bạn đang quản lý ${assignedCount} gian hàng.`);
    return;
  }

  errBox.textContent = '❌ Sai tài khoản hoặc mật khẩu! Vui lòng kiểm tra lại.';
  errBox.classList.remove('hidden');
}

$('loginSubmitBtn').onclick = doLogin;
$('loginUser').onkeydown = (e) => {
  if (e.key === 'Enter') $('loginPass').focus();
};
$('loginPass').onkeydown = (e) => {
  if (e.key === 'Enter') doLogin();
};

$('switchAccountBtn').onclick = () => showLoginScreen();
$('backToAdminBtn').onclick = () => {
  currentUser = { roleType: 'admin', member: null, isAdminPreview: false };
  activeMember = 'ALL';
  render();
  toast('👑 Đã quay lại giao diện Quản trị viên (Admin)');
};

$('loginImportPkgBtn').onclick = async () => {
  const r = await window.api.importShops();
  if (r && r.ok) {
    shops = r.shops || (await window.api.getShops());
    members = r.members || (await window.api.getMembers()) || [];
    renderLoginQuickAccounts();
    if (r.importedMember && r.importedMember.id) {
      const m = r.importedMember;
      $('loginUser').value = m.username || slugUsername(m.name) || m.name;
      $('loginPass').focus();
      toast(`Đã nạp gói phân quyền của nhân viên ${m.name} (${r.added + r.updated} gian)! Hãy nhập mật khẩu để đăng nhập.`);
    } else {
      toast(`Đã nạp dữ liệu thành công (${shops.length} gian, ${members.length} thành viên)!`);
    }
  } else if (r && !r.canceled) {
    toast('Lỗi nạp file: ' + (r.error || 'không rõ'));
  }
};

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

async function checkShopProxy(s, silent = false) {
  if (!s || !s.proxy || !String(s.proxy).trim()) return { ok: true };
  proxyStatusMap.set(s.id, { state: 'checking' });
  render();
  const res = await window.api.checkProxy(s.proxy);
  if (res && res.ok) {
    proxyStatusMap.set(s.id, {
      state: 'live',
      ip: res.ip,
      country: res.country,
      ms: res.ms
    });
    if (!silent) {
      toast(`🟢 Proxy ${s.name} LIVE! IP: ${res.ip} (${res.ms}ms${res.country ? ' • ' + res.country : ''})`);
    }
  } else {
    proxyStatusMap.set(s.id, {
      state: 'die',
      error: (res && res.error) || 'Proxy Die'
    });
    if (!silent) {
      toast(`🔴 Proxy ${s.name} DIE: ${(res && res.error) || 'Không kết nối được'}`);
    }
  }
  render();
  return res;
}

function getFilteredShops() {
  const q = searchQuery.trim().toLowerCase();
  const baseShops = getVisibleShopsForRole();

  return baseShops.filter((s) => {
    if (activeGroup === '__RUNNING__' && !runningIds.has(s.id)) return false;
    if (activeGroup !== '__ALL__' && activeGroup !== '__RUNNING__') {
      if ((s.group || '').trim() !== activeGroup) return false;
    }
    const shopMembers = getShopMembers(s);
    if (!isMemberMode()) {
      if (activeMember === '__UNASSIGNED__') {
        if (shopMembers.length > 0) return false;
      } else if (activeMember !== 'ALL') {
        if (!shopMembers.some((m) => m.id === activeMember)) return false;
      }
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

  const unassignedCount = shops.filter((s) => getShopMembers(s).length === 0).length;
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
    const count = getMemberShops(m.id).length;
    const pMode = (m.permMode || 'cskh') === 'cskh' ? '🎧 CSKH' : '📈 Ads';
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

function renderGroupTabs() {
  const wrap = $('groupTabs');
  wrap.innerHTML = '';

  const roleShops = getVisibleShopsForRole();
  const groups = Array.from(
    new Set(roleShops.map((s) => (s.group || '').trim()).filter(Boolean))
  );

  const runningInRole = roleShops.filter((s) => runningIds.has(s.id)).length;

  const items = [
    { key: '__ALL__', label: `Tất cả (${roleShops.length})` },
    { key: '__RUNNING__', label: `🟢 Đang mở (${runningInRole})` },
    ...groups.map((g) => ({
      key: g,
      label: `📁 ${g} (${roleShops.filter((s) => (s.group || '').trim() === g).length})`
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
    btn.className = 'tab-pill' + (activeGroup === item.key ? ' active' : '');
    btn.textContent = item.label;
    btn.onclick = () => {
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
  const runningInRole = roleShops.filter((s) => runningIds.has(s.id)).length;

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
  closeAllBtn.textContent = `⏹ Đóng tất cả (${runningIds.size})`;
  closeAllBtn.disabled = runningIds.size === 0;

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

  const grid = $('grid');
  grid.innerHTML = '';
  const emptyEl = $('empty');
  if (filtered.length === 0) {
    emptyEl.classList.remove('hidden');
    emptyEl.innerHTML = isMemberMode()
      ? `Tài khoản <b>${currentUser.member.name}</b> hiện chưa được Quản trị viên phân công gian hàng nào.<br>Hãy nhờ Admin tích chọn giao shop trong mục <b>👥 Thành viên</b>.`
      : 'Chưa có gian nào phù hợp.<br>Bấm “+ Thêm gian hàng” để bắt đầu.';
  } else {
    emptyEl.classList.add('hidden');
  }

  filtered.forEach((s) => {
    const realIndex = shops.findIndex((x) => x.id === s.id);
    const isRunning = runningIds.has(s.id);
    const useCskhButtons = isShopInCskhMode(s);

    const card = document.createElement('div');
    card.className = 'card' + (isRunning ? ' is-running' : '');

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
    headInfo.appendChild(nm);

    const statusPill = document.createElement('div');
    statusPill.className = 'status-pill ' + (isRunning ? 'running' : 'stopped');
    statusPill.innerHTML = `<span class="dot"></span><span>${isRunning ? 'Đang mở' : 'Đang đóng'}</span>`;

    head.append(chk, av, headInfo, statusPill);

    // Hang hien thi Thanh vien + Group + Proxy
    const metaRow = document.createElement('div');
    metaRow.className = 'meta-row';

    const assignedMembers = getShopMembers(s);
    if (assignedMembers.length > 0) {
      assignedMembers.forEach((m) => {
        const mb = document.createElement('span');
        mb.className = 'badge member-badge';
        const pTag = (m.permMode || 'cskh') === 'cskh' ? 'CSKH' : 'Ads';
        mb.title = `Phụ trách: ${m.name} (${pTag})`;
        const dot = document.createElement('span');
        dot.className = 'member-dot';
        dot.style.background = m.color || '#388bfd';
        const txt = document.createElement('span');
        txt.textContent = `${m.name} • ${pTag}`;
        mb.append(dot, txt);
        if (!isMemberMode()) {
          mb.onclick = () => {
            activeMember = activeMember === m.id ? 'ALL' : m.id;
            render();
          };
        }
        metaRow.appendChild(mb);
      });
    } else if (members.length > 0 && !isMemberMode()) {
      const unassignedBadge = document.createElement('span');
      unassignedBadge.className = 'badge member-unassigned';
      unassignedBadge.textContent = '👤 + Giao TV';
      unassignedBadge.title = 'Chưa giao cho thành viên nào. Bấm để gán thành viên quản lý.';
      unassignedBadge.onclick = () => openDialog(s, false);
      metaRow.appendChild(unassignedBadge);
    }

    if (s.group && s.group.trim()) {
      const gb = document.createElement('span');
      gb.className = 'badge group-badge';
      gb.textContent = '📁 ' + s.group.trim();
      metaRow.appendChild(gb);
    }

    const proxyShort = formatProxyBadge(s.proxy);
    if (proxyShort) {
      const pState = proxyStatusMap.get(s.id);
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

      pb.onclick = () => checkShopProxy(s, false);
      metaRow.appendChild(pb);

      const changeProxyBtn = document.createElement('span');
      changeProxyBtn.className = 'badge proxy-change-btn';
      changeProxyBtn.textContent = '✏️ Đổi Proxy';
      changeProxyBtn.title = 'Đổi nhanh Proxy cho gian này';
      changeProxyBtn.onclick = () => openDialog(s, true);
      metaRow.appendChild(changeProxyBtn);
    }

    const actions = document.createElement('div');
    actions.className = 'actions';

    if (useCskhButtons) {
      // Quyen CSKH: AN 2 nut GMV Max Ads & Check don cu, HIEN 2 nut CSKH & Don hang
      actions.append(
        mkBtn('💬 CSKH', '', () => openShop(s, 'cskh_chat'), 'Mở trang Tin nhắn CSKH TikTok Seller'),
        mkBtn('📦 Đơn hàng', '', () => openShop(s, 'cskh_orders'), 'Mở trang Đơn hàng chờ vận chuyển')
      );
      const bothCskh = mkBtn(
        isRunning ? '⚡ Đưa cửa sổ lên trước' : 'Mở cả 2 (CSKH + Đơn hàng)',
        'primary both',
        () => openShop(s, 'cskh_both')
      );
      actions.append(bothCskh);
    } else {
      // Quyen Ads / Quan tri vien mac dinh
      actions.append(
        mkBtn('GMV Max Ads', '', () => openShop(s, 'ads')),
        mkBtn('Check đơn', '', () => openShop(s, 'orders'))
      );
      const bothAds = mkBtn(
        isRunning ? '⚡ Đưa cửa sổ lên trước' : 'Mở cả 2',
        'primary both',
        () => openShop(s, 'both')
      );
      actions.append(bothAds);
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
      const up = mkBtn('◀', 'small', () => moveShop(realIndex, -1), 'Dời lên trước');
      const down = mkBtn('▶', 'small', () => moveShop(realIndex, 1), 'Dời ra sau');
      up.disabled = realIndex === 0;
      down.disabled = realIndex === shops.length - 1;
      tools.append(
        up,
        down,
        mkBtn('Sửa', 'small', () => openDialog(s, false)),
        mkBtn('Xóa đăng nhập', 'small danger', () => resetLogin(s), 'Xóa phiên đăng nhập đã lưu của gian này'),
        mkBtn('Xóa gian', 'small danger', () => deleteShop(s))
      );
      card.appendChild(tools);
    }

    grid.appendChild(card);
  });
}

async function openShop(s, which) {
  // Neu gian chua mo va co cau hinh Proxy, tu dong kiem tra Proxy truoc khi mo
  if (!runningIds.has(s.id) && s.proxy && String(s.proxy).trim()) {
    toast(`Đang kiểm tra Proxy của ${s.name}...`);
    const check = await checkShopProxy(s, true);
    if (!check || !check.ok) {
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

  const r = await window.api.openShop(s.id, which);
  if (r && r.ok) {
    runningIds.add(s.id);
    render();
    if (r.alreadyOpen) {
      toast('Cửa sổ ' + s.name + ' đang mở (đã đưa lên trước)');
    } else {
      toast('Đang mở ' + s.name + '…');
    }
    return;
  }
  if (r && r.error === 'NO_BROWSER') {
    showNoBrowser();
    return;
  }
  toast('Không mở được: ' + ((r && r.error) || 'lỗi không rõ'));
}

async function closeSingleShop(s) {
  const r = await window.api.closeShop(s.id);
  if (r && r.ok) {
    runningIds.delete(s.id);
    render();
    toast('Đã đóng Chrome của gian ' + s.name);
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

  const results = await Promise.all(withProxy.map((s) => checkShopProxy(s, true)));
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
  render();
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
  for (let i = 0; i < list.length; i++) {
    const mode = isShopInCskhMode(list[i]) ? 'cskh_both' : 'both';
    await window.api.openShop(list[i].id, mode);
    runningIds.add(list[i].id);
    render();
    if (i < list.length - 1) {
      await new Promise((r) => setTimeout(r, 650));
    }
  }
  toast(`Đã mở xong ${list.length} gian hàng!`);
};

$('closeAllBtn').onclick = async () => {
  if (!runningIds.size) return;
  if (!confirm(`Đóng tất cả ${runningIds.size} cửa sổ Chrome đang mở?`)) return;
  const r = await window.api.closeAllShops();
  if (r && r.ok) {
    runningIds.clear();
    render();
    toast(`Đã đóng toàn bộ ${r.closedCount || ''} cửa sổ Chrome!`);
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

function setDlgLinkMode(mode) {
  currentDlgLinkMode = mode === 'cskh' ? 'cskh' : 'ads';
  const isCskh = currentDlgLinkMode === 'cskh';
  $('fAdsOrdersGroup').classList.toggle('hidden', isCskh);
  $('fCskhGroup').classList.toggle('hidden', !isCskh);
  $('dlgModeAdsBtn').classList.toggle('primary', !isCskh);
  $('dlgModeCskhBtn').classList.toggle('primary', isCskh);
}

$('dlgModeAdsBtn').onclick = () => setDlgLinkMode('ads');
$('dlgModeCskhBtn').onclick = () => setDlgLinkMode('cskh');

function renderShopDialogMembers(selectedMemberIds = []) {
  const box = $('fMembersList');
  if (!box) return;
  box.innerHTML = '';

  if (!members.length) {
    const emptyMsg = document.createElement('div');
    emptyMsg.style.cssText = 'font-size:12px;color:var(--muted);padding:4px;';
    emptyMsg.innerHTML = 'Chưa có thành viên nào. ';
    const linkBtn = document.createElement('span');
    linkBtn.style.cssText = 'color:#79c0ff;cursor:pointer;text-decoration:underline;';
    linkBtn.textContent = '+ Bấm vào đây để tạo thành viên';
    linkBtn.onclick = () => {
      $('dlg').close();
      openMembersDialog();
    };
    emptyMsg.appendChild(linkBtn);
    box.appendChild(emptyMsg);
    return;
  }

  const selSet = new Set(selectedMemberIds);
  members.forEach((m) => {
    const lbl = document.createElement('label');
    lbl.className = 'member-check-pill' + (selSet.has(m.id) ? ' checked' : '');

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.value = m.id;
    chk.checked = selSet.has(m.id);
    chk.onchange = () => {
      lbl.classList.toggle('checked', chk.checked);
      // Neu tich chon thanh vien co quyen CSKH -> tu dong chuyen sang tab Link CSKH & Don hang (an GMV Max Ads)
      const checkedIds = Array.from(box.querySelectorAll('input[type="checkbox"]:checked')).map((c) => c.value);
      const checkedMembers = members.filter((x) => checkedIds.includes(x.id));
      if (checkedMembers.some((x) => (x.permMode || 'cskh') === 'cskh')) {
        setDlgLinkMode('cskh');
      }
    };

    const dot = document.createElement('span');
    dot.className = 'member-dot';
    dot.style.background = m.color || '#388bfd';

    const pTag = (m.permMode || 'cskh') === 'cskh' ? '🎧 CSKH' : '📈 Ads';
    const txt = document.createElement('span');
    txt.textContent = `${m.name} (${pTag})`;

    lbl.append(chk, dot, txt);
    box.appendChild(lbl);
  });
}

function openDialog(shop, focusProxy = false) {
  editingId = shop ? shop.id : null;
  $('dlgTitle').textContent = shop ? 'Sửa gian hàng' : 'Thêm gian hàng';
  $('fName').value = shop ? shop.name : '';
  $('fGroup').value = shop && shop.group ? shop.group : '';
  $('fNote').value = shop && shop.note ? shop.note : '';
  $('fProxy').value = shop && shop.proxy ? shop.proxy : '';
  $('fAds').value = shop ? shop.adsUrl || shop.sellerUrl || DEFAULT_ADS : DEFAULT_ADS;
  $('fOrders').value = shop ? shop.ordersUrl || DEFAULT_ORDERS : DEFAULT_ORDERS;
  $('fCskhChat').value = shop && shop.cskhChatUrl ? shop.cskhChatUrl : DEFAULT_CSKH_CHAT;
  $('fCskhOrders').value = shop && shop.cskhOrdersUrl ? shop.cskhOrdersUrl : DEFAULT_CSKH_ORDERS;
  $('fColor').value = shop ? shop.color : randomColor();
  $('proxyTestStatus').className = 'proxy-test-status';
  $('proxyTestStatus').textContent = '';

  const preselectedMembers = shop && Array.isArray(shop.memberIds)
    ? shop.memberIds
    : (activeMember !== 'ALL' && activeMember !== '__UNASSIGNED__' ? [activeMember] : []);
  renderShopDialogMembers(preselectedMembers);

  const hasCskhMember = members
    .filter((m) => preselectedMembers.includes(m.id))
    .some((m) => (m.permMode || 'cskh') === 'cskh');
  setDlgLinkMode((shop && shop.linkMode === 'cskh') || hasCskhMember ? 'cskh' : 'ads');

  $('dlg').showModal();
  if (focusProxy) {
    setTimeout(() => {
      $('fProxy').focus();
      $('fProxy').select();
    }, 50);
  }
}

$('addBtn').onclick = () => openDialog(null, false);
$('cancelBtn').onclick = () => $('dlg').close();

$('saveBtn').onclick = async () => {
  const name = $('fName').value.trim();
  if (!name) return $('fName').focus();
  const newProxy = $('fProxy').value.trim();

  const checkedMemberIds = Array.from(
    $('fMembersList').querySelectorAll('input[type="checkbox"]:checked')
  ).map((el) => el.value);

  const data = {
    name,
    group: $('fGroup').value.trim(),
    note: $('fNote').value.trim(),
    proxy: newProxy,
    adsUrl: $('fAds').value.trim() || DEFAULT_ADS,
    ordersUrl: $('fOrders').value.trim() || DEFAULT_ORDERS,
    cskhChatUrl: $('fCskhChat').value.trim() || DEFAULT_CSKH_CHAT,
    cskhOrdersUrl: $('fCskhOrders').value.trim() || DEFAULT_CSKH_ORDERS,
    linkMode: currentDlgLinkMode,
    color: $('fColor').value,
    memberIds: checkedMemberIds
  };

  let proxyChangedWhileRunning = false;
  let targetShop = null;

  if (editingId) {
    targetShop = shops.find((x) => x.id === editingId);
    const oldProxy = (targetShop && targetShop.proxy) || '';
    if (oldProxy !== newProxy) {
      proxyStatusMap.delete(editingId);
      if (runningIds.has(editingId)) {
        proxyChangedWhileRunning = true;
      }
    }
    Object.assign(targetShop, data);
  } else {
    targetShop = { id: Date.now().toString(36), ...data };
    shops.push(targetShop);
  }

  await persist();
  $('dlg').close();
  render();

  if (proxyChangedWhileRunning && targetShop) {
    toast('Đang khởi động lại Chrome của ' + targetShop.name + ' để áp dụng Proxy mới...');
    await window.api.closeShop(targetShop.id);
    runningIds.delete(targetShop.id);
    const mode = isShopInCskhMode(targetShop) ? 'cskh_both' : 'both';
    setTimeout(() => openShop(targetShop, mode), 400);
  } else {
    toast(editingId ? 'Đã lưu thay đổi!' : 'Đã thêm gian hàng mới!');
  }
};

// ---- QUAN LY THANH VIEN & PHAN QUYEN CSKH ----
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
    txt.textContent = s.name + (s.group ? ` [${s.group}]` : '');

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

$('mPermMode').onchange = () => {
  const isCskh = $('mPermMode').value === 'cskh';
  $('mCskhLinksBox').classList.toggle('hidden', !isCskh);
};

function resetMemberForm() {
  editingMemberId = null;
  usernameManuallyEdited = false;
  $('memberFormTitle').textContent = '+ Tạo tài khoản thành viên';
  $('mName').value = '';
  $('mUsername').value = '';
  $('mPassword').value = '123456';
  $('mPermMode').value = 'cskh';
  $('mCskhLinksBox').classList.remove('hidden');
  $('mCskhChat').value = DEFAULT_CSKH_CHAT;
  $('mCskhOrders').value = DEFAULT_CSKH_ORDERS;
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
  $('mCskhLinksBox').classList.toggle('hidden', $('mPermMode').value !== 'cskh');
  $('mCskhChat').value = m.cskhChatUrl || DEFAULT_CSKH_CHAT;
  $('mCskhOrders').value = m.cskhOrdersUrl || DEFAULT_CSKH_ORDERS;
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
      'Chưa có thành viên nào.<br>Hãy nhập Họ tên, Tài khoản, Mật khẩu ở khung bên trái, chọn <b>🎧 Quyền CSKH</b> và tích chọn các gian hàng để tạo tài khoản cho nhân viên.' +
      '</div>';
    return;
  }

  members.forEach((m) => {
    const mShops = getMemberShops(m.id);
    const uname = m.username || slugUsername(m.name) || m.name;
    const upass = m.password || '123456';
    const isCskh = (m.permMode || 'cskh') === 'cskh';

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
    roleSpan.style.color = isCskh ? '#56e3d8' : '#79c0ff';
    roleSpan.style.borderColor = isCskh ? 'rgba(15,157,148,.45)' : 'rgba(56,139,253,.45)';
    roleSpan.textContent = isCskh ? '🎧 Quyền CSKH (Mở CSKH & Đơn hàng)' : '📈 Quyền Ads & Check đơn';
    nameRow.appendChild(roleSpan);

    const credSpan = document.createElement('span');
    credSpan.className = 'cred-badge';
    credSpan.textContent = `🔑 TK: ${uname} | MK: ${upass}`;
    nameRow.appendChild(credSpan);

    const sub = document.createElement('div');
    sub.className = 'member-sub';
    sub.textContent = `Đang được phân công: ${mShops.length} gian hàng` + (m.phone ? ` • 📞 ${m.phone}` : '');

    info.append(nameRow, sub);
    head.append(av, info);
    card.appendChild(head);

    if (mShops.length > 0) {
      const tagsWrap = document.createElement('div');
      tagsWrap.className = 'member-shops-tags';
      mShops.forEach((s) => {
        const tag = document.createElement('span');
        tag.className = 'member-shop-tag';
        tag.textContent = '🏪 ' + s.name;
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
        toast(`👤 Đang xem giao diện của nhân viên ${m.name} (${isCskh ? 'Chế độ CSKH: chỉ hiện nút CSKH & Đơn hàng' : 'Chế độ Ads'}).`);
      },
      'Chuyển sang đúng màn hình làm việc của nhân viên này'
    );

    const openAllMemberBtn = mkBtn(
      `🚀 Mở cả nhóm (${mShops.length})`,
      'small success',
      async () => {
        if (!mShops.length) return toast(`Thành viên ${m.name} chưa được giao gian nào!`);
        $('membersDlg').close();
        const openMode = isCskh ? 'cskh_both' : 'both';
        toast(`Đang mở ${mShops.length} gian của ${m.name} (${isCskh ? 'CSKH + Đơn hàng' : 'Ads + Đơn hàng'})...`);
        for (let i = 0; i < mShops.length; i++) {
          await window.api.openShop(mShops[i].id, openMode);
          runningIds.add(mShops[i].id);
          render();
          if (i < mShops.length - 1) {
            await new Promise((r) => setTimeout(r, 650));
          }
        }
        toast(`Đã mở xong ${mShops.length} gian của ${m.name}!`);
      },
      'Mở đồng loạt tất cả các gian của thành viên này'
    );
    openAllMemberBtn.disabled = mShops.length === 0;

    const exportMemberBtn = mkBtn(
      '📤 Xuất file cho NV',
      'small',
      async () => {
        if (!mShops.length) {
          return toast(`Hãy giao ít nhất 1 gian hàng cho ${m.name} trước khi xuất file!`);
        }
        const r = await window.api.exportMemberShops({
          member: { ...m, username: uname, password: upass, permMode: m.permMode || 'cskh' },
          memberName: m.name,
          shops: mShops
        });
        if (r && r.ok) {
          toast(`Đã xuất gói phân quyền (${r.count} gian + tài khoản ${uname}) cho ${m.name}!`);
        } else if (r && !r.canceled) {
          toast('Lỗi xuất file: ' + (r.error || 'không rõ'));
        }
      },
      'Xuất file .json chứa tài khoản + các gian được giao của nhân viên này để gửi qua máy nhân viên nạp vào'
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
      toast(`Đã xóa thành viên ${m.name}`);
    });

    actions.append(viewAsMemberBtn, openAllMemberBtn, exportMemberBtn, editBtn, delBtn);
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

$('changeAdminPassBtn').onclick = async () => {
  const newU = prompt('Nhập tên tài khoản Quản trị viên (Admin):', authConfig.adminUser || 'admin');
  if (!newU || !newU.trim()) return;
  const newP = prompt('Nhập mật khẩu mới cho Quản trị viên (Admin):', authConfig.adminPass || '123456');
  if (!newP || !newP.trim()) return;
  authConfig.adminUser = newU.trim();
  authConfig.adminPass = newP.trim();
  await window.api.saveAuthConfig(authConfig);
  render();
  toast(`🔑 Đã cập nhật tài khoản Admin: ${authConfig.adminUser}`);
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
  const role = permMode === 'cskh' ? 'CSKH' : 'Ads / Vận hành';
  const cskhChatUrl = $('mCskhChat').value.trim() || DEFAULT_CSKH_CHAT;
  const cskhOrdersUrl = $('mCskhOrders').value.trim() || DEFAULT_CSKH_ORDERS;
  const phone = $('mPhone').value.trim();
  const color = $('mColor').value || '#388bfd';
  const checkedShopIds = new Set(
    Array.from($('mShopsChecklist').querySelectorAll('input[type="checkbox"]:checked')).map((c) => c.value)
  );

  let memberId = editingMemberId;
  if (memberId) {
    const target = members.find((x) => x.id === memberId);
    if (target) {
      Object.assign(target, { name, username, password, permMode, role, cskhChatUrl, cskhOrdersUrl, phone, color });
    }
  } else {
    memberId = 'mem_' + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
    members.push({ id: memberId, name, username, password, permMode, role, cskhChatUrl, cskhOrdersUrl, phone, color });
  }

  // Cap nhat danh sach shop duoc giao cho thanh vien nay va gan luon 2 duong link CSKH + Don hang
  shops.forEach((s) => {
    const cur = new Set(Array.isArray(s.memberIds) ? s.memberIds : []);
    if (checkedShopIds.has(s.id)) {
      cur.add(memberId);
      if (permMode === 'cskh') {
        s.cskhChatUrl = cskhChatUrl;
        s.cskhOrdersUrl = cskhOrdersUrl;
        s.linkMode = 'cskh';
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
  window.api.onRunningChanged((ids) => {
    runningIds = new Set(ids || []);
    if (currentUser) render();
  });
  refreshBrowser();
  // Bat buoc luon vao man hinh Dang nhap khi mo app
  showLoginScreen();
})();
