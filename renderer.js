const DEFAULT_ADS =
  'https://seller-vn.tiktok.com/ads-creation/dashboard?origin=SC_ads_tab_button_PC&btm_pre_unit_params=%7B%22btm_origin%22%3A%22sidebar_menu_Qu%E1%BA%A3ng+c%C3%A1o+c%E1%BB%ADa+h%C3%A0ng%22%7D';
const DEFAULT_ORDERS = 'https://seller-vn.tiktok.com/order?selected_sort=6&tab=all';

let shops = [];
let runningIds = new Set();
let selectedIds = new Set();
let proxyStatusMap = new Map();
let editingId = null;
let searchQuery = '';
let activeGroup = '__ALL__';

const $ = (id) => document.getElementById(id);

async function persist() {
  await window.api.saveShops(shops);
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

function mkBtn(text, cls, onclick, title) {
  const b = document.createElement('button');
  b.className = 'btn ' + cls;
  b.textContent = text;
  if (title) b.title = title;
  b.onclick = onclick;
  return b;
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
  return shops.filter((s) => {
    if (activeGroup === '__RUNNING__' && !runningIds.has(s.id)) return false;
    if (activeGroup !== '__ALL__' && activeGroup !== '__RUNNING__') {
      if ((s.group || '').trim() !== activeGroup) return false;
    }
    if (!q) return true;
    const hay = [s.name, s.group, s.note, s.proxy].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });
}

function renderGroupTabs() {
  const wrap = $('groupTabs');
  wrap.innerHTML = '';

  const groups = Array.from(
    new Set(shops.map((s) => (s.group || '').trim()).filter(Boolean))
  );

  const items = [
    { key: '__ALL__', label: `Tất cả (${shops.length})` },
    { key: '__RUNNING__', label: `🟢 Đang mở (${runningIds.size})` },
    ...groups.map((g) => ({
      key: g,
      label: `📁 ${g} (${shops.filter((s) => (s.group || '').trim() === g).length})`
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
  $('statsBadge').innerHTML =
    `Tổng: <b>${shops.length}</b> gian • <span class="open-count">🟢 ${runningIds.size} đang mở</span>`;

  const validIds = new Set(shops.map((s) => s.id));
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
  renderGroupTabs();
  const filtered = getFilteredShops();
  updateStatsAndBatchBar(filtered);

  const grid = $('grid');
  grid.innerHTML = '';
  $('empty').classList.toggle('hidden', filtered.length > 0);

  filtered.forEach((s) => {
    const realIndex = shops.findIndex((x) => x.id === s.id);
    const isRunning = runningIds.has(s.id);

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

    // Hang hien thi Group + Proxy
    const metaRow = document.createElement('div');
    metaRow.className = 'meta-row';
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
    actions.append(
      mkBtn('📊 GMV Max / Ads', '', () => openShop(s, 'ads')),
      mkBtn('📦 Check đơn', '', () => openShop(s, 'orders'))
    );
    const both = mkBtn(
      isRunning ? '⚡ Đưa cửa sổ lên trước' : 'Mở cả 2',
      'primary both',
      () => openShop(s, 'both')
    );
    actions.append(both);

    if (isRunning) {
      const closeBtn = mkBtn(
        '⏹ Đóng Chrome gian này',
        'danger-outline small close-chrome-btn',
        () => closeSingleShop(s)
      );
      actions.append(closeBtn);
    }

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

    card.append(bar, head);
    if (metaRow.childNodes.length > 0) card.appendChild(metaRow);
    if (s.note && s.note.trim()) {
      const noteDiv = document.createElement('div');
      noteDiv.className = 'note-box';
      noteDiv.textContent = '📝 ' + s.note.trim();
      noteDiv.title = s.note.trim();
      card.appendChild(noteDiv);
    }
    card.append(actions, tools);
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
  const withProxy = shops.filter((s) => s.proxy && String(s.proxy).trim());
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
  const list = shops.filter((s) => selectedIds.has(s.id));
  if (!list.length) return;
  toast(`Đang mở lần lượt ${list.length} gian hàng...`);
  for (let i = 0; i < list.length; i++) {
    await window.api.openShop(list[i].id, 'both');
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
    toast(`Đã xuất ${r.count} gian hàng ra file Backup!`);
  } else if (r && !r.canceled) {
    toast('Lỗi xuất file: ' + (r.error || 'không rõ'));
  }
};

$('importBtn').onclick = async () => {
  const r = await window.api.importShops();
  if (r && r.ok) {
    shops = r.shops || (await window.api.getShops());
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

// ---- Them / sua ----
function randomColor() {
  const palette = ['#0f9d94', '#e5484d', '#f5a524', '#3e63dd', '#8e4ec6', '#30a46c', '#d6409f', '#12a594'];
  return palette[shops.length % palette.length];
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
  $('fColor').value = shop ? shop.color : randomColor();
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

$('addBtn').onclick = () => openDialog(null, false);
$('cancelBtn').onclick = () => $('dlg').close();

$('saveBtn').onclick = async () => {
  const name = $('fName').value.trim();
  if (!name) return $('fName').focus();
  const newProxy = $('fProxy').value.trim();
  const data = {
    name,
    group: $('fGroup').value.trim(),
    note: $('fNote').value.trim(),
    proxy: newProxy,
    adsUrl: $('fAds').value.trim() || DEFAULT_ADS,
    ordersUrl: $('fOrders').value.trim() || DEFAULT_ORDERS,
    color: $('fColor').value
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
    setTimeout(() => openShop(targetShop, 'both'), 400);
  } else {
    toast(editingId ? 'Đã lưu thay đổi!' : 'Đã thêm gian hàng mới!');
  }
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
  const active = await window.api.getRunningShops();
  runningIds = new Set(active || []);
  window.api.onRunningChanged((ids) => {
    runningIds = new Set(ids || []);
    render();
  });
  render();
  refreshBrowser();
})();
