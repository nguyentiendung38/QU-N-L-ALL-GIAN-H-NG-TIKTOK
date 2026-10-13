const DEFAULT_ADS =
  'https://seller-vn.tiktok.com/ads-creation/dashboard?origin=SC_ads_tab_button_PC&btm_pre_unit_params=%7B%22btm_origin%22%3A%22sidebar_menu_Qu%E1%BA%A3ng+c%C3%A1o+c%E1%BB%ADa+h%C3%A0ng%22%7D';
const DEFAULT_ORDERS = 'https://seller-vn.tiktok.com/order?selected_sort=6&tab=all';

let shops = [];
let editingId = null;

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
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.trim().slice(0, 2).toUpperCase();
}

function mkBtn(text, cls, onclick, title) {
  const b = document.createElement('button');
  b.className = 'btn ' + cls;
  b.textContent = text;
  if (title) b.title = title;
  b.onclick = onclick;
  return b;
}

function render() {
  const grid = $('grid');
  grid.innerHTML = '';
  $('empty').classList.toggle('hidden', shops.length > 0);

  shops.forEach((s, index) => {
    const card = document.createElement('div');
    card.className = 'card';

    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.background = s.color;

    const head = document.createElement('div');
    head.className = 'head';
    const av = document.createElement('div');
    av.className = 'avatar';
    av.style.background = s.color;
    av.textContent = initials(s.name);
    const nm = document.createElement('div');
    nm.className = 'name';
    nm.textContent = s.name;
    nm.title = s.name;
    head.append(av, nm);

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(
      mkBtn('📊 GMV Max / Ads', '', () => openShop(s, 'ads')),
      mkBtn('📦 Check đơn', '', () => openShop(s, 'orders'))
    );
    const both = mkBtn('Mở cả 2', 'primary both', () => openShop(s, 'both'));
    actions.append(both);

    const tools = document.createElement('div');
    tools.className = 'tools';
    const up = mkBtn('◀', 'small', () => moveShop(index, -1), 'Dời lên trước');
    const down = mkBtn('▶', 'small', () => moveShop(index, 1), 'Dời ra sau');
    up.disabled = index === 0;
    down.disabled = index === shops.length - 1;
    tools.append(
      up,
      down,
      mkBtn('Sửa', 'small', () => openDialog(s)),
      mkBtn('Xóa đăng nhập', 'small danger', () => resetLogin(s), 'Xóa phiên đăng nhập đã lưu của gian này'),
      mkBtn('Xóa gian', 'small danger', () => deleteShop(s))
    );

    card.append(bar, head, actions, tools);
    grid.appendChild(card);
  });
}

async function openShop(s, which) {
  const r = await window.api.openShop(s.id, which);
  if (r && r.ok) {
    if (r.alreadyOpen) {
      toast('Cửa sổ ' + s.name + ' đã được mở (đã đưa lên trước)');
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

function openDialog(shop) {
  editingId = shop ? shop.id : null;
  $('dlgTitle').textContent = shop ? 'Sửa gian hàng' : 'Thêm gian hàng';
  $('fName').value = shop ? shop.name : '';
  $('fAds').value = shop ? shop.adsUrl || shop.sellerUrl || DEFAULT_ADS : DEFAULT_ADS;
  $('fOrders').value = shop ? shop.ordersUrl || DEFAULT_ORDERS : DEFAULT_ORDERS;
  $('fColor').value = shop ? shop.color : randomColor();
  $('dlg').showModal();
}

$('addBtn').onclick = () => openDialog(null);
$('cancelBtn').onclick = () => $('dlg').close();

$('saveBtn').onclick = async () => {
  const name = $('fName').value.trim();
  if (!name) return $('fName').focus();
  const data = {
    name,
    adsUrl: $('fAds').value.trim() || DEFAULT_ADS,
    ordersUrl: $('fOrders').value.trim() || DEFAULT_ORDERS,
    color: $('fColor').value
  };
  if (editingId) {
    Object.assign(shops.find((x) => x.id === editingId), data);
  } else {
    shops.push({ id: Date.now().toString(36), ...data });
  }
  await persist();
  $('dlg').close();
  render();
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
  render();
  refreshBrowser();
})();
