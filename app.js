'use strict';
/* ChiTieuHangNgay – PWA nhập & tổng hợp chi tiêu, đồng bộ với Google Sheet qua Apps Script */

const APP_VERSION = '3.19';
const DEFAULT_PEOPLE = ['Chồng', 'Vợ', 'Jun', 'Putin', 'Út', 'Chung'];
const KINDS = ['Sinh hoạt', 'Phát sinh', 'Chung'];
const QUICK_AMT = [10000, 20000, 25000, 30000, 40000, 50000, 100000, 200000, 500000];
const LS = { cfg: 'cthn.cfg', recs: 'cthn.records', map: 'cthn.map', pend: 'cthn.pending', last: 'cthn.last', conf: 'cthn.config' };

const $ = s => document.querySelector(s);
const fmt = n => (Math.round(n) || 0).toLocaleString('vi-VN');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn(e); } };
const todayStr = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const newId = () => 'a-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);

const state = {
  cfg: load(LS.cfg, { url: '', key: '' }),
  server: load(LS.recs, []),      // bản sao dữ liệu trên Sheet
  userMap: load(LS.map, {}),       // tên chuẩn hóa -> hạng mục (PhanLoaiApp)
  pending: load(LS.pend, []),      // thao tác chưa gửi: upsert | delete | map | config
  config: load(LS.conf, { loans: [], budgets: {} }), // khoản vay, ngân sách (sheet CaiDatApp)
  last: load(LS.last, { nguoi: 'Chồng', loai: 'Sinh hoạt' }),
  form: { nguois: [], loai: null, catTouched: false, catUser: false, autoCat: '', from: '', fromY: 0 },
};

/* ---------- dữ liệu gộp (server + thao tác chờ gửi) ---------- */
function records() {
  const byId = new Map(state.server.map(r => [String(r.id), r]));
  for (const p of state.pending) {
    if (p.op === 'upsert') byId.set(p.rec.id, p.rec);
    else if (p.op === 'delete') byId.delete(p.id);
  }
  return [...byId.values()];
}
/** cấu hình đã gộp thao tác chưa gửi */
function conf() {
  const c = { loans: [], budgets: {}, ...state.config };
  for (const p of state.pending) if (p.op === 'config') c[p.name] = p.value;
  return c;
}
function setConf(name, value) { queue({ op: 'config', name, value }); }
/** thành viên gia đình (sửa được trong Cài đặt); "Chung" luôn đứng cuối */
function people() {
  const p = (conf().people || []).map(x => String(x).trim()).filter(Boolean);
  return [...(p.length ? p : DEFAULT_PEOPLE).filter(x => x !== 'Chung'), 'Chung'];
}
/** hạng mục: có sẵn + hạng mục thêm trong Cài đặt, xếp abc; "Khác", "Chưa rõ" ở cuối */
function catsAll() {
  const extra = (conf().cats_extra || []).map(x => String(x).trim()).filter(c => c && !CATS.includes(c));
  return CATS.filter(c => c !== 'Khác' && c !== 'Chưa rõ').concat(extra).sort((a, b) => a.localeCompare(b, 'vi')).concat(['Khác', 'Chưa rõ']);
}
const pendingIds = () => new Set(state.pending.filter(p => p.op === 'upsert').map(p => p.rec.id));

/* ---------- gọi Apps Script ---------- */
async function apiGet(params) {
  const q = new URLSearchParams({ ...params, key: state.cfg.key });
  const res = await fetch(state.cfg.url + '?' + q.toString());
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || 'Lỗi máy chủ');
  return j;
}
async function apiPost(body) {
  // text/plain để tránh preflight CORS của Apps Script
  const res = await fetch(state.cfg.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...body, key: state.cfg.key }) });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || 'Lỗi máy chủ');
  return j;
}

let syncing = false, lastPull = 0, retryN = 0, retryTimer = null;
const PULL_EVERY = 120000; // tải lại toàn bộ từ Sheet tối đa 2 phút/lần khi tự đồng bộ
/** silent: tự chạy nền; forcePull: luôn tải lại toàn bộ dữ liệu từ Sheet */
async function sync(silent, forcePull) {
  if (!state.cfg.url || !state.cfg.key) { if (!silent) toast('Chưa cấu hình Google Sheet (tab Cài đặt)', 'err'); return; }
  if (syncing) return;
  syncing = true; $('#syncBtn').classList.add('spin');
  let ok = true;
  try {
    await flushPending();
    if (!forcePull && silent && Date.now() - lastPull < PULL_EVERY) return;   // vừa tải gần đây: chỉ gửi thay đổi lên
    const j = await apiGet({ action: 'list' });
    state.server = j.records.map(r => ({ ...r, id: String(r.id), tien: Number(r.tien) || 0 }));
    state.userMap = {};
    (j.phanloai || []).forEach(m => { if (m.ten) state.userMap[normName(m.ten)] = m.hangmuc; });
    state.config = { loans: [], budgets: {}, ...(j.config || {}) };
    save(LS.recs, state.server); save(LS.map, state.userMap); save(LS.conf, state.config);
    lastPull = Date.now();
    if (!silent) toast('Đã đồng bộ ' + fmt(state.server.length) + ' khoản', 'ok');
  } catch (e) {
    ok = false;
    if (!silent) toast('Chưa đồng bộ được: ' + e.message + '. Dữ liệu vẫn lưu trên máy, app sẽ tự gửi lại.', 'err');
  } finally {
    syncing = false; $('#syncBtn').classList.remove('spin'); renderAll();
    clearTimeout(retryTimer);
    if (state.pending.length && navigator.onLine) {
      // lỗi thì thử lại giãn dần 5 giây → 15 giây → 1 phút → 5 phút; có thao tác mới trong lúc gửi thì gửi tiếp ngay
      const wait = ok ? 800 : [5, 15, 60, 300][Math.min(retryN++, 3)] * 1000;
      retryTimer = setTimeout(() => sync(true), wait);
    }
    if (ok) retryN = 0;
  }
}
async function flushPending() {
  if (!state.pending.length) return;
  const snap = state.pending.slice();
  const ups = [], dels = [], maps = [], confs = {};
  for (const p of snap) {
    if (p.op === 'upsert') ups.push(p.rec);
    else if (p.op === 'delete') dels.push(p.id);
    else if (p.op === 'map') maps.push(p.item);
    else if (p.op === 'config') confs[p.name] = p.value;
  }
  for (const [name, value] of Object.entries(confs)) {
    const j = await apiPost({ action: 'setConfig', name, value }); state.config[name] = value;
    if (j.lichVayLoi) setTimeout(() => toast('Chưa vẽ được sheet Lịch vay (app): ' + j.lichVayLoi, 'err'), 1600);
  }
  save(LS.conf, state.config);
  const lastUp = new Map(ups.map(r => [r.id, r]));
  const loiSo = [];
  if (lastUp.size) { const j = await apiPost({ action: 'upsert', records: [...lastUp.values()] }); if (j.soThang) loiSo.push(...j.soThang.loi); }
  if (dels.length) { const j = await apiPost({ action: 'delete', ids: dels }); if (j.soThang) loiSo.push(...j.soThang.loi); }
  if (loiSo.length) setTimeout(() => toast('Sổ tháng: ' + loiSo.join('; '), 'err'), 1600);
  if (maps.length) await apiPost({ action: 'setMap', items: maps });
  // ghi nhận vào bản sao server rồi xóa hàng đợi
  const byId = new Map(state.server.map(r => [r.id, r]));
  lastUp.forEach((r, id) => byId.set(id, r));
  dels.forEach(id => byId.delete(id));
  state.server = [...byId.values()];
  state.pending = state.pending.slice(snap.length); save(LS.pend, state.pending); save(LS.recs, state.server);
}
function queue(op) {
  state.pending.push(op); save(LS.pend, state.pending);
  renderAll();
  sync(true);
}

/** ghi bù các khoản đã nhập từ app nhưng chưa có trên sổ tháng */
async function ghiBu() {
  const info = $('#ghiBuInfo'), b = $('#ghiBuBtn');
  if (!state.cfg.url) { toast('Cấu hình Google Sheet trước', 'err'); return; }
  b.disabled = true; info.className = 'muted'; info.textContent = 'Đang kiểm tra…';
  try {
    await sync(true, true);
    const d = (await apiPost({ action: 'ghiBu', chiDem: true })).soThang;
    if (!d.can) { info.textContent = '✓ Mọi khoản nhập từ app đều đã có trên sổ.'; return; }
    const th = d.thang.map(t => t.slice(5) + '/' + t.slice(0, 4)).join(', ');
    if (!confirm(`Có ${d.can} khoản nhập từ app chưa có trên sổ (tháng ${th}).\nNếu bạn đã tự gõ các khoản này vào sổ thì bấm Hủy để tránh bị trùng.\n\nGhi vào sổ?`)) { info.textContent = ''; return; }
    info.textContent = 'Đang ghi ' + d.can + ' khoản…';
    const k = (await apiPost({ action: 'ghiBu' })).soThang;
    info.className = k.loi.length ? 'muted err-text' : 'muted ok-text';
    info.textContent = `✓ Đã ghi ${k.ghi} khoản vào sổ.` + (k.loi.length ? ' Lỗi: ' + k.loi.join('; ') : '');
    sync(true, true);
  } catch (e) {
    info.className = 'muted err-text';
    info.textContent = /Action không hợp lệ/.test(e.message) ? 'Apps Script chưa cập nhật: thêm file SoThang.gs, sửa Code.gs rồi triển khai lại (xem hướng dẫn).' : 'Lỗi: ' + e.message;
  } finally { b.disabled = false; }
}

/* ---------- thông báo ---------- */
let toastTimer;
function toast(msg, type) {
  const el = $('#status'); el.textContent = msg; el.className = 'status ' + (type || ''); el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

/* ---------- form nhập ---------- */
function chips(container, items, current, onPick) {
  container.innerHTML = items.map(v => `<button type="button" class="chip${v === current ? ' on' : ''}" data-v="${esc(v)}">${esc(v)}</button>`).join('');
  container.onclick = e => { const b = e.target.closest('.chip'); if (b) onPick(b.dataset.v); };
}
function chipsMulti(container, items, selected, onPick) {
  container.innerHTML = items.map(v => { const on = selected.includes(v); return `<button type="button" class="chip${on ? ' on' : ''}" data-v="${esc(v)}" aria-pressed="${on}">${esc(v)}</button>`; }).join('');
  container.onclick = e => { const b = e.target.closest('.chip'); if (b) onPick(b.dataset.v); };
}
/** người đứng đầu trong danh sách đang chọn (dùng cho gợi ý hạng mục, tên thường dùng, số tiền cũ) */
const formNguoi = () => state.form.nguois[0] || null;
const isEditing = () => !!$('#f-id').value;
/** chia tổng tiền cho n người, phần dư (đồng) cộng cho những người đầu để tổng khớp đúng */
function phanTien(tong, n) {
  const base = Math.floor(tong / n), du = tong - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < du ? 1 : 0));
}
function setPerson(p) {
  let list;
  if (p === 'Chung' || isEditing()) list = [p];                         // Chung đứng riêng; khi sửa chỉ có một người
  else {
    list = state.form.nguois.filter(x => x !== 'Chung');
    list = list.includes(p) ? list.filter(x => x !== p) : [...list, p];  // bấm lại để bỏ chọn
  }
  state.form.nguois = list;
  if (p === 'Chung') state.form.loai = 'Chung';
  else if (state.form.loai === 'Chung') state.form.loai = 'Phát sinh';
  renderFormChips(); autoCategory(); renderQuickNames();
}
function setKind(k) {
  const was = state.form.loai; state.form.loai = k;
  if (k === 'Chung') state.form.nguois = ['Chung'];
  else if (state.form.nguois.includes('Chung')) state.form.nguois = [people().includes(state.last.nguoi) && state.last.nguoi !== 'Chung' ? state.last.nguoi : people()[0]];
  renderFormChips(); autoCategory(); if (was !== k) renderQuickNames();
}
function renderFormChips() {
  chipsMulti($('#f-nguoi'), people(), state.form.nguois, setPerson);
  chips($('#f-loai'), KINDS, state.form.loai, setKind);
  updateShare();
}
/** hiện tùy chọn chia tiền và dòng "mỗi người ... đ" khi chọn từ hai người trở lên (chỉ khi nhập mới) */
function updateShare() {
  const n = state.form.nguois.length, tien = parseAmount($('#f-tien').value);
  const show = n > 1 && !isEditing();
  $('#splitRow').hidden = !show;
  let msg = '';
  if (show && tien >= n) {
    if ($('#f-chia').checked) { const s = phanTien(tien, n); msg = s[0] === s[n - 1] ? `Mỗi người ${fmt(s[0])} đ` : `Mỗi người ${fmt(s[n - 1])} đ hoặc ${fmt(s[0])} đ`; }
    else msg = `Mỗi người ${fmt(tien)} đ, tổng ${fmt(tien * n)} đ`;
  }
  $('#shareHint').textContent = msg;
}
function parseAmount(s) {
  let n = parseInt(String(s).replace(/[^\d]/g, ''), 10) || 0;
  if (n > 0 && n < 1000) n *= 1000; // gõ "30" = 30.000 đ
  return n;
}
function autoCategory() {
  const name = $('#f-ten').value;
  const c = classify(name, formNguoi(), state.userMap);
  state.form.autoCat = c;
  if (!state.form.catTouched) $('#f-hangmuc').value = c;
  $('#catHint').textContent = name ? (state.form.catTouched && $('#f-hangmuc').value !== c ? '(đã chọn tay, gợi ý: ' + c + ')' : '(tự động)') : '';
}
/** gợi ý sẵn cho khoản Chung (giống các dòng có sẵn trên sổ tháng) */
const CHUNG_GOI_Y = ['Tiền điện', 'Tiền nước', 'Đi chợ', 'Tiền điện thoại', 'Tiền mạng', 'Tiền spotify', 'Tiền gas', 'Tiền rác', 'Gửi xe', 'Siêu thị'];
function renderQuickNames() {
  const p = formNguoi(), chung = p === 'Chung' || state.form.loai === 'Chung';
  const cnt = new Map();
  for (const r of records()) if (chung ? r.nguoi === 'Chung' || r.loai === 'Chung' : r.nguoi === p) cnt.set(r.ten, (cnt.get(r.ten) || 0) + 1);
  let top = [...cnt.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]);
  if (chung) { const f = new Set(CHUNG_GOI_Y.map(fold)); top = CHUNG_GOI_Y.concat(top.filter(n => n && !f.has(fold(n)))).slice(0, 12); }
  else top = top.slice(0, 8);
  $('#quickNames').innerHTML = top.map(n => `<button type="button" data-n="${esc(n)}">${esc(n)}</button>`).join('');
}
function lastAmountFor(name, person) {
  const rs = records().filter(r => r.ten === name && r.nguoi === person && r.ngay).sort((a, b) => (b.ngay > a.ngay ? 1 : -1));
  return rs[0] ? rs[0].tien : 0;
}
function resetForm(keepDate) {
  $('#f-id').value = ''; $('#f-ten').value = ''; $('#f-tien').value = ''; $('#f-ghichu').value = '';
  if (!keepDate) $('#f-ngay').value = todayStr();
  $('#f-ngay').min = '2020-01-01'; $('#f-ngay').max = addDays(todayStr(), 31);
  state.form.nguois = [people().includes(state.last.nguoi) ? state.last.nguoi : people()[0]]; state.form.loai = state.last.loai;
  state.form.catTouched = false; state.form.catUser = false;
  $('#f-chia').checked = true;
  $('#saveBtn').textContent = 'Lưu khoản chi'; $('#cancelEdit').hidden = true; $('#deleteBtn').hidden = true;
  $('#form').classList.remove('editing'); vClear($('#form'));
  renderFormChips(); autoCategory(); renderQuickNames();
}
function editRecord(id) {
  const r = records().find(x => x.id === id); if (!r) return;
  const from = document.querySelector('.tab.active').id;   // nhớ màn đang xem để quay lại sau khi sửa
  state.form.from = from === 'tab-nhap' ? '' : from; state.form.fromY = window.scrollY;
  showTab('tab-nhap'); vClear($('#form'));
  $('#f-id').value = r.id; $('#f-ngay').value = r.ngay || (r.thang + '-01'); $('#f-tien').value = fmt(r.tien);
  $('#f-ten').value = r.ten; $('#f-ghichu').value = isSheetRef(r.ghichu) ? '' : r.ghichu || '';
  state.form.nguois = [r.nguoi]; state.form.loai = r.loai; state.form.catTouched = true; state.form.catUser = false;
  renderFormChips(); $('#f-hangmuc').value = r.hangmuc; autoCategory();
  $('#saveBtn').textContent = 'Cập nhật'; $('#cancelEdit').hidden = false; $('#deleteBtn').hidden = false;
  $('#form').classList.add('editing');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
/** sau khi sửa / hủy sửa / xóa: quay lại màn đang xem trước đó */
function backFromEdit() {
  const t = state.form.from, y = state.form.fromY; state.form.from = '';
  if (t) { showTab(t); requestAnimationFrame(() => window.scrollTo(0, y)); }
}
function onSubmit(e) {
  e.preventDefault();
  const id = $('#f-id').value || newId();
  const old = records().find(x => x.id === id);
  const ngay = $('#f-ngay').value;
  const tien = parseAmount($('#f-tien').value);
  const ten = $('#f-ten').value.trim().replace(/\s+/g, ' ');
  const E = [], maxDay = addDays(todayStr(), 31);
  E.push([$('#f-ngay'), V.dateErr(ngay, true, '2020-01-01', maxDay, 'Ngày chi')]);
  if (!tien) E.push([$('#f-tien'), 'Nhập số tiền, ví dụ 30 = 30.000 đ']);
  else if (tien > 2e9) E.push([$('#f-tien'), 'Số tiền quá lớn (tối đa 2 tỷ), kiểm tra lại số 0']);
  if (!ten) E.push([$('#f-ten'), 'Nhập tên khoản chi, ví dụ Cháo canh']);
  else if (!/[\p{L}\d]/u.test(ten)) E.push([$('#f-ten'), 'Tên phải có chữ hoặc số']);
  if (!$('#f-hangmuc').value || !catsAll().includes($('#f-hangmuc').value)) E.push([$('#f-hangmuc'), 'Chọn hạng mục']);
  const nguois = state.form.nguois.slice();
  if (!nguois.length) E.push([$('#f-nguoi button'), 'Chọn người chi']);
  const n = old ? 1 : nguois.length, chia = n > 1 && $('#f-chia').checked;
  if (n > 1 && tien && tien < n) E.push([$('#f-tien'), 'Số tiền quá nhỏ để chia cho ' + n + ' người']);
  if (!vShow($('#form'), E)) return;
  if (tien >= 50e6 && !confirm('Số tiền ' + fmt(tien) + ' đ khá lớn. Lưu đúng số này?')) return;
  const hangmuc = $('#f-hangmuc').value;
  const shares = chia ? phanTien(tien, n) : Array(n).fill(tien);
  const ghichu = $('#f-ghichu').value.trim() || (old && isSheetRef(old.ghichu) ? old.ghichu : '');
  // mỗi người được chọn thành một khoản riêng; sổ tháng sẽ ghi vào đúng cột của từng người
  const recs = Array.from({ length: n }, (_, i) => ({ id: i === 0 ? id : newId(),
    ngay: old && !old.ngay && ngay === old.thang + '-01' ? '' : ngay,
    thang: ngay.slice(0, 7), nguoi: nguois[i], loai: state.form.loai, ten, tien: shares[i], hangmuc,
    ghichu, nguon: old ? old.nguon : 'app' }));
  // Chọn tay hạng mục khác gợi ý -> ghi nhớ cho tên này (trừ quy tắc cháo của Putin/Út)
  const nguoi0 = recs[0].nguoi;
  const auto = classify(ten, nguoi0, state.userMap);
  if (state.form.catUser && hangmuc !== auto && !(['Putin', 'Út'].includes(nguoi0) && normName(ten).startsWith('cháo'))) {
    state.userMap[normName(ten)] = hangmuc; save(LS.map, state.userMap);
    state.pending.push({ op: 'map', item: { ten: normName(ten), hangmuc } });
  }
  state.last = { nguoi: nguoi0, loai: recs[0].loai }; save(LS.last, state.last);
  recs.forEach(rec => state.pending.push({ op: 'upsert', rec }));
  save(LS.pend, state.pending); renderAll(); sync(true);
  if (old) toast('Đã cập nhật: ' + ten + ' ' + fmt(tien) + ' đ', 'ok');
  else if (n === 1) toast('Đã lưu: ' + ten + ' ' + fmt(tien) + ' đ', 'ok');
  else if (chia) toast(`Đã lưu ${ten} ${fmt(tien)} đ, chia cho ${n} người`, 'ok');
  else toast(`Đã lưu ${ten}, ${fmt(tien)} đ cho mỗi người (${n} người)`, 'ok');
  resetForm(true);
  if (old) backFromEdit();
}
function onDelete() {
  const id = $('#f-id').value; if (!id) return;
  const r = records().find(x => x.id === id);
  if (!confirm('Xóa khoản "' + r.ten + '" ' + fmt(r.tien) + ' đ?')) return;
  queue({ op: 'delete', id });
  toast('Đã xóa: ' + r.ten, 'ok');
  resetForm(true); backFromEdit();
}

/* ---------- màu & tiện ích hiển thị ---------- */
const PCOL = { 'Chồng': '#60a5fa', 'Vợ': '#f472b6', 'Jun': '#fbbf24', 'Putin': '#34d399', 'Út': '#a78bfa', 'Chung': '#94a3b8' };
const PAL = ['#6d8dff', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#fb923c', '#22d3ee', '#f87171', '#84cc16', '#e879f9'];
const pcol = p => PCOL[p] || PAL[(people().indexOf(p) + 5) % PAL.length];
/** màu cố định cho từng hạng mục (giống nhau ở mọi màn): góc màu cách nhau theo tỉ lệ vàng để dễ phân biệt */
const hashStr = t => [...String(t)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const CAT_COL = {   // chọn tay để các hạng mục chi nhiều có màu dễ phân biệt nhất
  'Đi chợ – siêu thị – thực phẩm': '#3a86ff', 'Đồ gia dụng – nhà bếp – sửa nhà': '#f28e2b', 'Giáo dục – học tập': '#59a14f',
  'Ăn vặt – quán ăn – nhà hàng': '#e15759', 'Nhậu – bia rượu – karaoke': '#8338ec', 'Hiếu hỉ – biếu tặng – cúng lễ – đóng góp': '#edc948',
  'Y tế – sức khỏe': '#00b4d8', 'Điện – nước – điện thoại – mạng': '#9c755f', 'Ăn sáng': '#ff9da7', 'Quần áo – chăm sóc cá nhân': '#ff006e',
  'Sữa – bỉm – đồ dùng em bé': '#a7c957', 'Gia đình – bạn bè': '#b07aa1', 'Phí – dịch vụ – công nghệ': '#76b7b2', 'Xe cộ – đi lại': '#4e79a7',
  'Thuốc lá': '#6a4c93', 'Giải trí – vui chơi – du lịch': '#2ec4b6', 'Ăn uống – Putin & Út': '#d4a373', 'Khác': '#8b93a7', 'Chưa rõ': '#64748b',
};
/** hạng mục có sẵn dùng màu cố định; hạng mục thêm sinh màu theo tên (luôn giống nhau) */
const catCol = c => CAT_COL[c] || `hsl(${hashStr(c) % 360} 65% 58%)`;
const dmy = s => (s ? s.slice(8, 10) + '/' + s.slice(5, 7) : '');
const pc = x => String(x).replace('.', ',') + '%';            // lãi suất 9.8 -> "9,8%"
const pct1 = x => x.toFixed(1).replace('.', ',') + '%';   // 15,3%
const compact = n => (n >= 1e9 ? (n / 1e9).toFixed(2).replace('.', ',') + ' tỷ' : n >= 1e6 ? (n / 1e6).toFixed(1).replace('.', ',') + ' tr' : fmt(n));

/* ---------- danh sách ---------- */
const WD = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const isSheetRef = g => /![A-Z]+\d+$/.test(String(g || '')); // ghi chú tự sinh "Tháng 11/2026!D44" (vị trí ô sổ cũ)
/** mode: 'nguoi' (ô trái = ngày) | 'ngay' (ô trái = người) | 'top' (ô trái = người, kèm ngày) */
function recHtml(r, pend, mode) {
  let lead;
  if (mode === 'nguoi') {
    lead = r.ngay ? `<span class="lead day"><b>${+r.ngay.slice(8)}</b><small>${WD[new Date(r.ngay + 'T00:00').getDay()]}</small></span>`
      : `<span class="lead day old"><b>T${+r.thang.slice(5)}</b><small>sổ cũ</small></span>`;
  } else lead = `<span class="lead who" style="--pc:${pcol(r.nguoi)}">${esc(r.nguoi === 'Chung' ? 'Ch' : r.nguoi.slice(0, 1))}</span>`;
  const chips = [`<span class="cat" style="--cc:${catCol(r.hangmuc)}"><i></i>${esc(r.hangmuc)}</span>`];
  if (mode !== 'nguoi') chips.unshift(`<span class="who-t">${esc(r.nguoi)}${mode === 'top' && r.ngay ? ' · ' + dmy(r.ngay) : ''}</span>`);
  if (r.loai && r.loai !== 'Chung') chips.push(`<span class="kind">${esc(r.loai)}</span>`);
  const note = r.ghichu && !isSheetRef(r.ghichu) ? `<span class="note">${esc(r.ghichu)}</span>` : '';
  return `<li class="rec" data-id="${esc(r.id)}">${lead}<div class="body"><span class="t">${esc(r.ten)}</span><span class="m">${chips.join('')}</span>${note}</div>
    <div class="amt"><b>${fmt(r.tien)}</b>${pend.has(r.id) ? '<small class="pend">chờ gửi</small>' : ''}</div></li>`;
}
function renderToday() {
  const t = $('#f-ngay').value || todayStr();
  const rs = records().filter(r => r.ngay === t);
  const pend = pendingIds();
  $('#todayTotal').textContent = fmt(rs.reduce((s, r) => s + r.tien, 0)) + ' đ';
  $('#todayList').innerHTML = rs.length ? rs.map(r => recHtml(r, pend, 'ngay')).join('') : '<li class="empty">Chưa có khoản chi nào trong ngày này</li>';
}
function monthsAvailable() {
  const s = new Set(records().map(r => r.thang).filter(Boolean)); s.add(todayStr().slice(0, 7));
  return [...s].sort().reverse();
}
function fillSelect(sel, opts, keepFirst) {
  const cur = sel.value;
  const first = keepFirst ? sel.options[0].outerHTML : '';
  sel.innerHTML = first + opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
}
const monthLabel = m => 'Tháng ' + parseInt(m.slice(5), 10) + '/' + m.slice(0, 4);
let dsPerson = '', dsView = load('cthn.dsview', 'nguoi');
const dsLimit = {};
function renderList() {
  fillSelect($('#ds-thang'), [['', 'Tất cả tháng'], ...monthsAvailable().map(m => [m, monthLabel(m)])]);
  if (!$('#ds-thang').dataset.init) { $('#ds-thang').value = todayStr().slice(0, 7); $('#ds-thang').dataset.init = 1; }
  const th = $('#ds-thang').value, hm = $('#ds-hangmuc').value, q = normName($('#ds-tim').value);
  const base = records().filter(r => (!th || r.thang === th) && (!hm || r.hangmuc === hm) && (!q || normName(r.ten).includes(q)));
  const per = groupSum(base, 'nguoi');
  $('#ds-people').innerHTML = people().map(p => { const g = per.get(p) || [0, 0];
    return `<button type="button" class="pcard${dsPerson === p ? ' on' : ''}" data-p="${esc(p)}" style="--pc:${pcol(p)}"><span>${esc(p)}</span><b>${fmt(g[0])}</b><small>${g[1]} khoản</small></button>`; }).join('');
  const rs = base.filter(r => !dsPerson || r.nguoi === dsPerson);
  $('#ds-tong').textContent = fmt(rs.reduce((s, r) => s + r.tien, 0)) + ' đ';
  $('#ds-dem').textContent = fmt(rs.length);
  $('#ds-clear').hidden = !dsPerson;
  document.querySelectorAll('#ds-view button').forEach(b => b.classList.toggle('on', b.dataset.view === dsView));
  const pend = pendingIds();
  const sortFn = (a, b) => (b.ngay || b.thang).localeCompare(a.ngay || a.thang) || (a.id < b.id ? 1 : -1);
  let html = '';
  if (!rs.length) html = '<div class="card empty">Không có khoản chi phù hợp</div>';
  else if (dsView === 'nguoi') {
    const secs = people().filter(p => rs.some(r => r.nguoi === p)).map(p => {
      const list = rs.filter(r => r.nguoi === p).sort(sortFn);
      const tot = list.reduce((s, r) => s + r.tien, 0), lim = dsLimit[p] || 80;
      const kinds = [...groupSum(list, 'loai')].map(([k, g]) => `<span>${esc(k)}: <b>${fmt(g[0])}</b></span>`).join('');
      return `<section class="psec" style="--pc:${pcol(p)}"><div class="psec-h"><i class="dot"></i><h3>${esc(p)}</h3><span class="tot">${fmt(tot)}</span></div>
        <div class="psec-sub">${kinds}<span>${list.length} khoản</span></div>
        <ul class="rec-list">${list.slice(0, lim).map(r => recHtml(r, pend, 'nguoi')).join('')}</ul>
        ${list.length > lim ? `<button type="button" class="more" data-more="${esc(p)}">Hiện thêm (${list.length - lim} khoản)</button>` : ''}</section>`;
    });
    html = `<div class="people-grid">${secs.join('')}</div>`;
  } else {
    const groups = new Map();
    for (const r of rs) { const k = r.ngay || r.thang; groups.set(k, (groups.get(k) || 0) + r.tien); }
    const lim = dsLimit.ngay || 300;
    let cur = null, items = '';
    for (const r of [...rs].sort(sortFn).slice(0, lim)) {
      const k = r.ngay || r.thang;
      if (k !== cur) {
        cur = k;
        const lbl = r.ngay ? new Date(r.ngay + 'T00:00').toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }) : monthLabel(r.thang) + ' (sổ cũ, không có ngày)';
        items += `<li class="dayrow"><span>${esc(lbl)}</span><b>${fmt(groups.get(k))}</b></li>`;
      }
      items += recHtml(r, pend, 'ngay');
    }
    html = `<section class="psec" style="--pc:var(--ac)"><ul class="rec-list">${items}</ul>${rs.length > lim ? `<button type="button" class="more" data-more="ngay">Hiện thêm (${rs.length - lim} khoản)</button>` : ''}</section>`;
  }
  $('#dsList').innerHTML = html;
}

/* ---------- tổng hợp ---------- */
/** rows: [{key, label, v, extra, ratio, color}] */
/* ---------- hiệu ứng biểu đồ ----------
 * Chỉ chạy khi số liệu đổi hoặc khi vừa mở tab; đồng bộ nền mà số không đổi thì không chạy lại cho đỡ rối mắt. */
const animSig = new Map();
const reduceMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
function anim(el, sig) {
  const k = el.id || el, ch = animSig.get(k) !== sig; animSig.set(k, sig);
  el.classList.remove('anim'); if (ch && !reduceMotion()) { void el.offsetWidth; el.classList.add('anim'); }
  [...el.children].forEach((c, i) => c.style.setProperty('--i', i));
  return ch;
}
/** số chạy từ giá trị cũ (hoặc 0) lên giá trị mới: các phần tử có data-n */
function countUp(root) {
  if (reduceMotion()) return;
  root.querySelectorAll('[data-n]').forEach(el => {
    const to = +el.dataset.n, suf = el.dataset.suf || '', from = +(el.dataset.from || 0), t0 = performance.now(), D = 850;
    if (from === to) return;
    const step = t => { const p = Math.min(1, (t - t0) / D), e = 1 - Math.pow(1 - p, 3); el.textContent = fmt(from + (to - from) * e) + suf; if (p < 1) requestAnimationFrame(step); };
    el.textContent = fmt(from) + suf; requestAnimationFrame(step);
  });
}
function bars(el, rows, total, onClick) {
  const max = Math.max(1, ...rows.map(r => r.v));
  el.innerHTML = rows.length ? rows.map(r => `<div class="bar" data-k="${esc(r.key)}" style="--bc:${r.color || 'var(--ac)'}"><div class="h"><span class="nm"><i class="sw"></i><span>${esc(r.label)}<small>${total ? pct1(r.v / total * 100) : ''}${r.extra ? ' · ' + esc(r.extra) : ''}</small></span></span>
    <b class="v">${fmt(r.v)}</b></div>
    <div class="track"><div class="fill${r.ratio > 1 ? ' over' : r.ratio >= 0.9 ? ' warn' : ''}" style="width:${(r.ratio ? Math.min(100, r.ratio * 100) : r.v / max * 100).toFixed(1)}%"></div></div></div>`).join('')
    : '<p class="muted">Chưa có dữ liệu</p>';
  el.onclick = e => { const b = e.target.closest('.bar'); if (b && onClick) onClick(b.dataset.k); };
  anim(el, rows.map(r => r.key + ':' + r.v).join('|'));
}
/** biểu đồ cột dọc. rows: [{key, label, short, v, cur}] ; showVal: ghi số (triệu) trên đầu cột */
function vbars(el, rows, onClick, showVal) {
  const max = Math.max(1, ...rows.map(r => r.v));
  const tr = v => (v >= 1e6 ? (v / 1e6).toFixed(v >= 1e8 ? 0 : 1).replace('.', ',') : v ? '<1' : '');
  el.innerHTML = `<div class="vb-wrap${rows.length > 12 ? ' many' : ''}">${rows.map(r => `<div class="vb${r.cur ? ' cur' : ''}" data-k="${esc(r.key || '')}" data-i="${esc(r.label)}: ${fmt(r.v)} đ" title="${esc(r.label)}: ${fmt(r.v)} đ">
      ${showVal ? `<em>${tr(r.v)}</em>` : ''}<i style="--h:${(r.v / max).toFixed(3)}"></i><small>${esc(r.short)}</small></div>`).join('')}</div>
    <p class="vb-cap muted">${showVal ? 'Số trên cột: triệu đồng. ' : ''}${onClick ? 'Bấm vào cột để xem tháng đó.' : 'Chạm vào cột để xem số tiền.'}</p>`;
  const cap = el.querySelector('.vb-cap'), base = cap.textContent;
  const show = b => { el.querySelectorAll('.vb.sel').forEach(x => x.classList.remove('sel')); if (b) { b.classList.add('sel'); cap.textContent = b.dataset.i; } else cap.textContent = base; };
  el.onclick = e => { const b = e.target.closest('.vb'); if (!b) return; if (b.dataset.k && onClick) onClick(b.dataset.k); else show(b); };
  el.onmouseover = e => { const b = e.target.closest('.vb'); if (b) show(b); };
  el.onmouseleave = () => show(null);
  const w = el.querySelector('.vb-wrap'); if (w) { w.id = el.id + '-w'; anim(w, rows.map(r => r.v).join('|')); }
}
/** biểu đồ tròn: 8 hạng mục lớn nhất + gộp phần còn lại, không để hở */
function donut(rows, total) {
  const R = 70, C = 2 * Math.PI * R; let off = 0;
  const top = rows.filter(r => r.v > 0).slice(0, 8), rest = rows.filter(r => r.v > 0).slice(8).reduce((a, r) => a + r.v, 0);
  if (rest > 0) top.push({ label: 'Các hạng mục khác', v: rest, color: '#64748b' });
  const segs = top.map(r => { const len = r.v / total * C; const sg = `<circle cx="100" cy="100" r="${R}" fill="none" stroke="${r.color}" stroke-width="26" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 100 100)"><title>${esc(r.label)}: ${fmt(r.v)} đ (${pct1(r.v / total * 100)})</title></circle>`; off += len; return sg; }).join('');
  return `<svg viewBox="0 0 200 200" role="img" aria-label="Tỉ lệ chi tiêu theo hạng mục"><defs><mask id="dmask"><circle class="dsweep" cx="100" cy="100" r="${R}" fill="none" stroke="#fff" stroke-width="40"
      stroke-dasharray="${C.toFixed(2)}" style="--c:${C.toFixed(2)}" transform="rotate(-90 100 100)"/></mask></defs>
    <circle cx="100" cy="100" r="${R}" fill="none" stroke="var(--bg2)" stroke-width="26"/><g class="dsegs" mask="url(#dmask)">${segs}</g>
    <text x="100" y="98" class="donut-c">${compact(total)}</text><text x="100" y="114" class="donut-s">TỔNG CHI</text></svg>`;
}
function groupSum(rs, key) {
  const m = new Map();
  for (const r of rs) { const k = typeof key === 'function' ? key(r) : r[key]; const g = m.get(k) || [0, 0]; g[0] += r.tien; g[1]++; m.set(k, g); }
  return m;
}
const kpi = (label, val, color, sub, n) => `<div class="kpi" style="--kc:${color}"><span>${label}</span><b${n != null ? ` data-n="${Math.round(n)}" data-suf=" đ"` : ''}>${val}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
/** % thay đổi, kèm mũi tên; tăng chi = đỏ, giảm chi = xanh */
function delta(now, before, label) {
  if (!before) return '';
  const d = (now - before) / before * 100, up = d >= 0;
  return `<span class="dl ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(d).toFixed(Math.abs(d) < 10 ? 1 : 0).replace('.', ',')}%</span> ${label}`;
}
function renderSummary() {
  const all = records(), today = todayStr(), thisY = today.slice(0, 4), thisM = today.slice(0, 7);
  const years = [...new Set(all.map(r => (r.thang || '').slice(0, 4)).filter(Boolean)), thisY];
  fillSelect($('#th-nam'), [...new Set(years)].sort().reverse().map(y => [y, 'Năm ' + y]));
  if (!$('#th-nam').dataset.init) { $('#th-nam').value = thisY; $('#th-nam').dataset.init = 1; }
  const y = $('#th-nam').value;
  fillSelect($('#th-thang'), [['', 'Cả năm'], ...Array.from({ length: 12 }, (_, i) => [y + '-' + String(i + 1).padStart(2, '0'), 'Tháng ' + (i + 1)])]);
  fillSelect($('#th-nguoi'), [['', 'Cả nhà'], ...people().map(x => [x, x])]);
  const m = $('#th-thang').value, p = $('#th-nguoi').value;
  const byP = r => !p || r.nguoi === p;
  const rs = all.filter(r => (r.thang || '').startsWith(y) && (!m || r.thang === m) && byP(r));
  const total = rs.reduce((a, r) => a + r.tien, 0);
  const sumIf = f => all.reduce((a, r) => a + (byP(r) && f(r) ? r.tien : 0), 0);

  // bình quân + so sánh cùng kỳ
  let avgLbl, avg, avgSub, cmp = '';
  if (m) {
    const dim = new Date(+m.slice(0, 4), +m.slice(5), 0).getDate(), days = m === thisM ? +today.slice(8) : dim;
    avgLbl = 'Bình quân / ngày'; avg = total / days; avgSub = `trên ${days} ngày${m === thisM ? ' (đến hôm nay)' : ''}`;
    const pm = addMonth(m, -1);
    cmp = delta(total, sumIf(r => r.thang === pm), 'so với tháng ' + +pm.slice(5) + (m === thisM ? ' (tháng này chưa hết)' : ''));
  } else {
    const nM = new Set(rs.map(r => r.thang)).size || 1;
    avgLbl = 'Bình quân / tháng'; avg = total / nM; avgSub = `trên ${nM} tháng có dữ liệu`;
    const lastM = y === thisY ? thisM.slice(5) : '12', py = String(+y - 1);
    cmp = delta(total, sumIf(r => r.thang >= py + '-01' && r.thang <= py + '-' + lastM),
      y === thisY ? `so với ${+lastM} tháng đầu ${py}` : 'so với năm ' + py);
  }
  let k = kpi('Tổng chi tiêu', fmt(total) + ' đ', 'var(--ac)', fmt(rs.length) + ' khoản' + (cmp ? '<br>' + cmp : ''), total)
    + kpi(avgLbl, fmt(avg) + ' đ', 'var(--ok)', avgSub, avg);
  const loans = conf().loans || [];
  if (loans.length && !p) {
    const gs = debtByGroup(loans, y, m), cols = ['#fb923c', '#22d3ee', '#f472b6', '#84cc16'];
    let tg = 0, tl = 0, tdn = 0;
    gs.forEach((g, j) => {
      tg += g.goc; tl += g.lai; tdn += g.duNo;
      k += kpi('Trả nợ ' + g.short, fmt(g.goc + g.lai) + ' đ', cols[j % cols.length], `gốc ${fmt(g.goc)} · lãi ${fmt(g.lai)}`, g.goc + g.lai);
    });
    k += kpi('Chi tiêu + trả nợ', fmt(total + tg + tl) + ' đ', 'var(--ac2)', `trả nợ ${fmt(tg + tl)} · dư nợ ${compact(tdn)}<br><button type="button" class="link" data-th-no>Xem chi tiết nợ vay →</button>`, total + tg + tl);
  }
  const kEl = $('#th-kpis'); kEl.innerHTML = k;
  if (anim(kEl, [...kEl.querySelectorAll('[data-n]')].map(b => b.dataset.n).join('|'))) countUp(kEl);

  const goList = (field, val) => {
    dsPerson = field === 'nguoi' ? val : p; $('#ds-thang').value = m || ''; $('#ds-thang').dataset.init = 1; $('#ds-hangmuc').value = field === 'hangmuc' ? val : '';
    $('#ds-tim').value = ''; showTab('tab-ds');
  };
  const bud = m && !p ? conf().budgets || {} : {};
  const cats = [...groupSum(rs, 'hangmuc')].sort((a, b) => b[1][0] - a[1][0]);
  const catRows = cats.map(([c, g]) => ({ key: c, label: c, v: g[0], extra: g[1] + ' khoản' + (bud[c] ? ' · ngân sách ' + fmt(bud[c]) : ''), ratio: bud[c] ? g[0] / bud[c] : 0, color: catCol(c) }));
  Object.keys(bud).forEach(c => { if (bud[c] && !catRows.some(r => r.key === c)) catRows.push({ key: c, label: c, v: 0, extra: 'ngân sách ' + fmt(bud[c]), ratio: 0, color: catCol(c) }); });
  $('#th-donut').innerHTML = total ? donut(catRows, total) : '';
  anim($('#th-donut'), total + '|' + catRows.slice(0, 8).map(r => r.v).join('|'));
  bars($('#th-hangmuc'), catRows, total, c => goList('hangmuc', c));
  const ppl = people();
  bars($('#th-nguoi-bars'), [...groupSum(rs, 'nguoi')].sort((a, b) => ppl.indexOf(a[0]) - ppl.indexOf(b[0])).map(([n, g]) => ({ key: n, label: n, v: g[0], extra: g[1] + ' khoản', color: pcol(n) })), total, n => goList('nguoi', n));
  if (m) {
    $('#th-thang-title').textContent = 'Theo ngày · ' + monthLabel(m);
    const g = groupSum(rs.filter(r => r.ngay), 'ngay'), dim = new Date(+m.slice(0, 4), +m.slice(5), 0).getDate();
    const noDay = rs.filter(r => !r.ngay).reduce((a, r) => a + r.tien, 0);
    vbars($('#th-thang-bars'), Array.from({ length: dim }, (_, i) => { const d = m + '-' + String(i + 1).padStart(2, '0'); return { label: fmtD(d), short: String(i + 1), v: (g.get(d) || [0])[0], cur: d === today }; }));
    if (noDay) $('#th-thang-bars').insertAdjacentHTML('beforeend', `<p class="muted">Có ${fmt(noDay)} đ chi tiêu từ sổ cũ không ghi ngày, không hiện trên biểu đồ ngày.</p>`);
  } else {
    $('#th-thang-title').textContent = 'Theo tháng · năm ' + y;
    const g = groupSum(rs, 'thang');
    vbars($('#th-thang-bars'), Array.from({ length: 12 }, (_, i) => { const mm = y + '-' + String(i + 1).padStart(2, '0'); return { key: mm, label: 'Tháng ' + (i + 1) + '/' + y, short: 'T' + (i + 1), v: (g.get(mm) || [0])[0], cur: mm === thisM }; }),
      mm => { $('#th-thang').value = mm; renderSummary(); }, true);
  }
  renderCompare();
  const pend = pendingIds();
  $('#th-top').innerHTML = [...rs].sort((a, b) => b.tien - a.tien).slice(0, 10).map(r => recHtml(r, pend, 'top')).join('') || '<li class="empty">Chưa có dữ liệu</li>';
}

/* ---------- cài đặt, nạp dữ liệu, xuất CSV ---------- */
async function saveConfig() {
  const ui = $('#cfg-url'), ki = $('#cfg-key'), url = ui.value.trim(), key = ki.value, E = [];
  if (!url) E.push([ui, 'Dán địa chỉ Web App vào đây']);
  else if (!/^https:\/\/script\.google\.com\/(a\/[^/]+\/)?macros\/s\/[\w-]{20,}\/exec$/.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1):\d+\/exec$/.test(url))
    E.push([ui, /\/dev$/.test(url) ? 'Đây là link thử (/dev). Lấy link kết thúc bằng /exec ở Triển khai → Quản lý triển khai' : 'Sai địa chỉ: phải dạng https://script.google.com/macros/s/…/exec']);
  if (!key) E.push([ki, 'Nhập mã bí mật SECRET']);
  else if (key !== key.trim()) E.push([ki, 'Có khoảng trắng ở đầu hoặc cuối, xóa đi']);
  if (!vShow(ui.closest('.card'), E)) return;
  state.cfg = { url, key };
  save(LS.cfg, state.cfg);
  try { await apiGet({ action: 'ping' }); $('#cfg-info').textContent = 'Kết nối thành công.'; await sync(); }
  catch (e) { $('#cfg-info').textContent = 'Không kết nối được: ' + e.message; }
}
async function importSeed(file) {
  const info = $('#seedInfo');
  if (!state.cfg.url) { toast('Cấu hình Google Sheet trước', 'err'); return; }
  if (file.size > 30e6) { info.className = 'muted err-text'; info.textContent = 'File quá lớn (trên 30 MB), kiểm tra lại có đúng file dữ liệu không.'; return; }
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { info.textContent = 'File không đúng định dạng JSON.'; info.className = 'muted err-text'; return; }
  if (!data || !Array.isArray(data.records)) { info.textContent = 'File không có danh sách khoản chi (records).'; info.className = 'muted err-text'; return; }
  const bad = data.records.map((r, i) => [r, i]).filter(([r]) => !r || !r.id || !r.ten || !r.nguoi || !(Number.isFinite(+r.tien) && +r.tien > 0)
    || !((r.ngay && V.isDate(r.ngay)) || (!r.ngay && V.isMonth(r.thang))));
  if (bad.length) { info.className = 'muted err-text'; info.textContent = `File có ${fmt(bad.length)} khoản sai dữ liệu (thiếu id/tên/người, số tiền ≤ 0 hoặc ngày sai), ví dụ dòng ${bad.slice(0, 3).map(x => x[1] + 1).join(', ')}. Chưa nạp gì.`; return; }
  if (data.phanloai && !Array.isArray(data.phanloai)) { info.className = 'muted err-text'; info.textContent = 'Mục phanloai trong file phải là danh sách.'; return; }
  info.className = 'muted'; info.textContent = 'Đang nạp ' + fmt(data.records.length) + ' khoản…';
  const recs = data.records || [], maps = data.phanloai || [];
  const prog = $('#seedProg'); prog.hidden = false; const bar = prog.firstElementChild;
  const B = 250, steps = Math.ceil(recs.length / B) + Math.ceil(maps.length / B);
  let done = 0;
  try {
    for (const [name, value] of Object.entries(data.config || {})) await apiPost({ action: 'setConfig', name, value });
    for (let i = 0; i < maps.length; i += B) { await apiPost({ action: 'setMap', items: maps.slice(i, i + B) }); bar.style.width = (++done / steps * 100) + '%'; }
    for (let i = 0; i < recs.length; i += B) { await apiPost({ action: 'upsert', records: recs.slice(i, i + B), noBook: true }); bar.style.width = (++done / steps * 100) + '%'; }
    const msg = 'Đã nạp ' + fmt(recs.length) + ' khoản và ' + fmt(maps.length) + ' tên phân loại lúc ' + new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) + '.';
    toast(msg, 'ok'); info.className = 'muted ok-text'; info.textContent = '✓ ' + msg;
    await sync(true, true);
  } catch (e) { toast('Nạp dữ liệu lỗi: ' + e.message, 'err'); info.className = 'muted err-text'; info.textContent = 'Lỗi: ' + e.message + '. Có thể nạp lại, không bị trùng.'; }
}
function exportCsv() {
  const cols = ['ngay', 'thang', 'nguoi', 'loai', 'ten', 'tien', 'hangmuc', 'ghichu'];
  const lines = [cols.join(',')].concat(records().sort((a, b) => (a.ngay || a.thang).localeCompare(b.ngay || b.thang))
    .map(r => cols.map(c => '"' + String(r[c] ?? '').replace(/"/g, '""') + '"').join(',')));
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'chi-tieu-' + todayStr() + '.csv'; a.click();
}

/* ---------- cảnh báo trên trang Nhập ---------- */
function renderAlerts() {
  const today = todayStr(), c = conf(), out = [];
  for (const l of c.loans || []) {
    let s; try { s = LoanEngine.schedule(l, today); } catch (e) { continue; }
    const k = s.ky_toi; if (!k) continue;
    const truoc = l.nhac_truoc === '' || l.nhac_truoc == null ? 5 : +l.nhac_truoc;
    if (s.con_ngay <= truoc) {
      const when = s.con_ngay === 0 ? '<b>hôm nay</b>' : `còn <b>${s.con_ngay} ngày</b>`;
      out.push(`<div class="alert${s.con_ngay <= 1 ? ' red' : ''}"><svg class="ic"><use href="#i-bank"/></svg><div><b>${esc(l.ten)}</b> đến hạn ${fmtD(k.ngay)} (${when}): gốc ${fmt(k.goc)} + lãi ${fmt(k.lai)} = <b>${fmt(k.tong)} đ</b></div></div>`);
    }
  }
  const bud = c.budgets || {}, month = today.slice(0, 7), spent = {};
  for (const r of records()) if (r.thang === month) spent[r.hangmuc] = (spent[r.hangmuc] || 0) + r.tien;
  for (const [cat, b] of Object.entries(bud)) {
    if (!b) continue; const v = spent[cat] || 0;
    if (v >= b * 0.9) out.push(`<div class="alert${v > b ? ' red' : ''}"><svg class="ic"><use href="#i-bell"/></svg><div>${v > b ? 'Vượt' : 'Sắp hết'} ngân sách <b>${esc(cat)}</b>: ${fmt(v)} / ${fmt(b)} đ (${Math.round(v / b * 100)}%)</div></div>`);
  }
  $('#alerts').innerHTML = out.join('');
}
const fmtD = s => s ? s.slice(8, 10) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4) : '';

/* ---------- popup dùng chung ---------- */
function openModal(title, html) {
  $('#modalTitle').textContent = title; $('#modalBody').innerHTML = html;
  $('#modal').hidden = false; document.body.classList.add('combo-lock');
  const f = $('#modalBody').querySelector('input:not([type=checkbox]), select');
  if (f && !matchMedia('(pointer: coarse)').matches) f.focus({ preventScroll: true });
  return $('#modalBody');
}
function closeModal() { $('#modal').hidden = true; $('#modalBody').innerHTML = ''; $('#modalBody').onclick = null; document.body.classList.remove('combo-lock'); }

/* ---------- khoản vay ---------- */

function loanCtx(l, i, today) { try { return { l, i, s: LoanEngine.schedule(l, today) }; } catch (e) { return { l, i, err: e.message }; } }
/** Gom theo nhóm khoản vay (các khoản đảo nợ cùng nhóm tính chung): trả gốc, trả lãi trong kỳ đang xem, dư nợ hiện tại */
function debtByGroup(loans, y, m) {
  const map = new Map();
  loans.forEach((l, i) => {
    const c = loanCtx(l, i, todayStr()); if (!c.s) return;
    const key = l.nhom || l.id, name = baseName(l.ten);
    if (!map.has(key)) map.set(key, { key, name, short: /ô tô|oto|\bxe\b/i.test(name) ? 'xe' : /nhà/i.test(name) ? 'nhà' : name, goc: 0, lai: 0, duNo: 0 });
    const g = map.get(key);
    g.duNo += c.s.du_no_hien_tai;
    c.s.rows.forEach(r => { if (r.thang.startsWith(y) && (!m || r.thang === m)) { g.goc += cg(r) + r.tra_truoc; g.lai += r.lai; } });
  });
  return [...map.values()];
}
const cg = r => (r.dao_no ? 0 : r.goc); // gốc trả bằng tiền thật (đảo nợ thì gốc do khoản vay mới trả)
const rowRates = r => [...new Set(r.chi_tiet_lai.map(p => p.lai_suat))].map(pc).join(' → ');
const currentRate = (l, today) => (l.lai_suat || []).filter(r => r.tu_ngay <= today).sort((a, b) => a.tu_ngay.localeCompare(b.tu_ngay)).pop();

function loanBadge(c) {
  const { l, s } = c, k = s.ky_toi;
  const truoc = l.nhac_truoc === '' || l.nhac_truoc == null ? 5 : +l.nhac_truoc;
  return k ? `<span class="badge${s.con_ngay <= 1 ? ' red' : s.con_ngay <= truoc ? ' warn' : ''}">${s.con_ngay === 0 ? 'Đến hạn hôm nay' : 'Còn ' + s.con_ngay + ' ngày đến hạn'}</span>` : '<span class="badge">Đã tất toán</span>';
}
function loanKv(c, today) {
  const { l, s } = c, k = s.ky_toi; if (!k) return '';
  const rate = currentRate(l, today), paid = s.rows.filter(r => r.da_qua);
  const gocDaTra = paid.reduce((a, r) => a + cg(r) + r.tra_truoc, 0), laiDaTra = paid.reduce((a, r) => a + r.lai, 0);
  return `<div class="kv">
    <div class="big"><span>Kỳ tới ${fmtD(k.ngay)}: gốc ${fmt(k.goc)} + lãi ${fmt(k.lai)}</span><b>${fmt(k.tong)} đ</b>${k.chi_tiet_lai.length > 1 ? `<small class="split">Lãi gồm: ${k.chi_tiet_lai.map(p => `${fmt(p.lai)} (${pc(p.lai_suat)}, ${dmy(p.tu)}→${dmy(p.den)}, ${p.so_ngay} ngày)`).join(' + ')}</small>` : ''}</div>
    <div><span>Dư nợ hiện tại</span><b>${fmt(s.du_no_hien_tai)}</b></div>
    <div><span>Lãi suất hiện tại</span><b class="rate">${rate ? pc(rate.nam) + '/năm' : '?'}</b></div>
    <div><span>Lãi tạm tính đến hôm nay</span><b>${fmt(s.lai_tam_tinh)}</b></div>
    <div><span>Đáo hạn</span><b>${s.dao_han ? fmtD(s.dao_han) : 'chưa nhập'}</b></div>
    <div><span>Đã trả gốc</span><b>${fmt(gocDaTra)}</b></div>
    <div><span>Đã trả lãi</span><b>${fmt(laiDaTra)}</b></div>
    <div><span>Lãi còn phải trả ${s.dao_han ? '' : '(24 tháng tới)'}</span><b>${fmt(s.lai_con_lai)}</b></div>
  </div>`;
}

/** Chia lịch trả nợ theo từng mốc lãi suất: số ngày, tiền lãi đã trả, tiền lãi dự kiến */
function ratePeriods(l, s) {
  const today = todayStr();
  const rates = (l.lai_suat || []).map((r, idx) => ({ tu_ngay: r.tu_ngay, nam: r.nam, idx })).sort((a, b) => a.tu_ngay.localeCompare(b.tu_ngay));
  return rates.map((r, j) => {
    const den = rates[j + 1] ? rates[j + 1].tu_ngay : null;
    let lai = 0, laiTra = 0, ngay = 0;
    for (const row of s.rows) for (const p of row.chi_tiet_lai) {
      if (p.tu >= r.tu_ngay && (!den || p.tu < den)) { lai += p.lai; ngay += p.so_ngay; if (row.da_qua) laiTra += p.lai; }
    }
    return { ...r, den, lai, laiTra, ngay, status: r.tu_ngay > today ? 'next' : (!den || den > today ? 'now' : 'old') };
  });
}
function rateTableHtml(c) {
  const { l, i, s } = c, today = todayStr(), per = ratePeriods(l, s);
  const stTxt = { now: 'Đang áp dụng', next: 'Sắp tới', old: 'Đã qua' };
  let rows = per.map(r => {
    const sub = r.laiTra && r.lai - r.laiTra > 0 ? `<br><small>đã trả ${fmt(r.laiTra)} · dự kiến ${fmt(r.lai - r.laiTra)}</small>` : (r.lai && !r.laiTra ? '<br><small>dự kiến</small>' : '');
    return `<tr><td>${fmtD(r.tu_ngay)}</td><td>${r.den ? fmtD(r.den) : (l.so_thang ? 'đáo hạn' : 'chưa xác định')}</td><td class="rate">${pc(r.nam)}/năm</td><td>${r.ngay ? fmt(r.ngay) : '–'}</td><td><b>${fmt(r.lai)}</b>${sub}</td>
      <td><span class="st ${r.status}">${stTxt[r.status]}</span></td>
      <td class="act"><button type="button" class="btn sm" data-rt="edit" data-loan="${i}" data-idx="${r.idx}"><svg class="ic"><use href="#i-edit"/></svg>Sửa</button><button type="button" class="btn sm danger" data-rt="del" data-loan="${i}" data-idx="${r.idx}" title="Xóa mốc này"><svg class="ic"><use href="#i-trash"/></svg></button></td></tr>`;
  }).join('');
  const paidLai = s.rows.filter(r => r.da_qua).reduce((a, r) => a + r.lai, 0);
  const curR = currentRate(l, today), nextR = per.find(r => r.status === 'next');
  return coll('rate-' + l.id, '<svg class="ic"><use href="#i-pct"/></svg>Lãi suất &amp; tiền lãi', `<div class="actions" style="margin:0 0 10px"><button type="button" class="btn sm" data-rt="add" data-loan="${i}"><svg class="ic"><use href="#i-plus"/></svg>Thêm mốc đổi lãi suất</button></div>
    <div class="tablewrap"><table class="tbl rsp"><tr><th>Từ ngày</th><th>Đến ngày</th><th>Lãi suất</th><th>Số ngày</th><th>Tiền lãi</th><th>Trạng thái</th><th></th></tr>${rows}
      <tr class="total"><td colspan="4">Cộng toàn lịch${l.so_thang ? '' : ' (24 tháng dự kiến)'}</td><td>${fmt(s.tong_lai)}<br><small>đã trả ${fmt(paidLai)}</small></td><td colspan="2"></td></tr></table></div>
    <p class="muted">Ngân hàng báo đổi lãi từ ngày nào thì bấm “Thêm mốc đổi lãi suất”, nhập ngày áp dụng và mức lãi mới (kể cả ngày trong tương lai). Bấm “Sửa” ở dòng bất kỳ để đổi ngày hoặc mức lãi: tiền lãi các kỳ sau, lịch trả nợ và số liệu tổng hợp tự tính lại.</p>`,
    { cls: 'sub', sub: `${per.length} mức · đang áp dụng ${curR ? pc(curR.nam) + '/năm' : '?'}${nextR ? ' · từ ' + fmtD(nextR.tu_ngay) + ': ' + pc(nextR.nam) : ''} · tổng lãi ${fmt(s.tong_lai)}` });
}

/* ---------- khối thu gọn dùng chung (collapse) ---------- */
const collOpen = new Set(load('cthn.coll', []));
/** key: ghi nhớ trạng thái mở; opts: { sub, extra, cls, open (mặc định), acc (thu gọn kiểu chỉ mở 1 khoản vay) } */
function coll(key, title, body, opts = {}) {
  const open = opts.acc ? opts.open : collOpen.has(key);
  return `<div class="coll ${opts.cls || ''}${open ? ' open' : ''}" data-coll="${esc(key)}"><button type="button" class="coll-h"${opts.acc ? ` data-acc="${esc(opts.acc)}"` : ''} aria-expanded="${open}">
    <span class="coll-t"><b>${title}</b>${opts.sub ? `<small>${opts.sub}</small>` : ''}</span>${opts.extra || ''}<svg class="ic chev"><use href="#i-down"/></svg></button>
    <div class="coll-b">${body}</div></div>`;
}
function onCollClick(e) {
  const h = e.target.closest('.coll-h'); if (!h || h.dataset.acc) return;
  const c = h.parentElement, k = c.dataset.coll, open = !c.classList.contains('open');
  c.classList.toggle('open', open); h.setAttribute('aria-expanded', open);
  if (k) { open ? collOpen.add(k) : collOpen.delete(k); save('cthn.coll', [...collOpen]); }
}

/* ---------- kiểm tra dữ liệu nhập trong popup ---------- */
/** 'YYYY-MM-DD' chuẩn hóa lại để loại ngày không tồn tại như 31/02 */
const iso0 = v => { const t = new Date(v + 'T00:00'); return isNaN(t) ? '' : t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0'); };
const addDays = (v, n) => { const t = new Date(v + 'T00:00'); t.setDate(t.getDate() + n); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0'); };
const V = {
  money: v => parseInt(String(v || '').replace(/[^\d]/g, ''), 10) || 0,
  num: v => { const t = String(v ?? '').trim().replace(',', '.'); return t === '' || !/^-?\d+(\.\d+)?$/.test(t) ? NaN : +t; },
  isDate: v => /^(20\d{2}|2100)-\d{2}-\d{2}$/.test(v || '') && !isNaN(new Date(v + 'T00:00')) && iso0(v) === v,
  /** kiểm tra ngày: trống / sai / ngoài khoảng [min, max] */
  dateErr(v, req, min, max, what = 'Ngày') {
    if (!v) return req ? 'Chọn ' + what.toLowerCase() : '';
    if (!V.isDate(v)) return what + ' không hợp lệ (năm từ 2000 đến 2100)';
    if (min && v < min) return 'Không được trước ' + fmtD(min);
    if (max && v > max) return 'Không được sau ' + fmtD(max);
    return '';
  },
  isMonth: v => /^\d{4}-(0[1-9]|1[0-2])$/.test(v || ''),
  /** 'MM/YYYY' -> 'YYYY-MM'; '' nếu trống; '!' nếu sai */
  mon(v) { const t = String(v || '').trim(); if (!t) return ''; const m = /^(\d{1,2})\/(\d{4})$/.exec(t); if (!m) return '!'; const mm = +m[1], yy = +m[2];
    return mm >= 1 && mm <= 12 && yy >= 2000 && yy <= 2100 ? yy + '-' + String(mm).padStart(2, '0') : '!'; },
  monErr(v, req) { const r = V.mon(v); if (r === '' ) return req ? 'Nhập tháng theo dạng MM/YYYY, ví dụ 02/2027' : ''; return r === '!' ? 'Sai định dạng: nhập tháng/năm dạng MM/YYYY, ví dụ 02/2027 (tháng 01–12)' : ''; },
  rate(v) { if (String(v ?? '').trim() === '') return 'Nhập lãi suất'; const n = V.num(v); if (isNaN(n)) return 'Chỉ nhập số, ví dụ 9,8 (không gõ dấu %)'; if (n <= 0 || n > 30) return 'Lãi suất năm phải từ 0,01 đến 30'; return ''; },
  day(v) { const n = V.num(v); if (String(v ?? '').trim() === '') return 'Nhập ngày trả'; if (!Number.isInteger(n) || n < 1 || n > 31) return 'Nhập số nguyên từ 1 đến 31'; return ''; },
};
/** một ô nhập kèm nhãn, hướng dẫn và chỗ báo lỗi */
const fld = (label, input, hint, cls = '') => `<label class="fld ${cls}"><span class="fl">${label}</span>${input}${hint ? `<small class="hint">${hint}</small>` : ''}<small class="err"></small></label>`;
const monTxt = ym => (ym && /^\d{4}-\d{2}$/.test(ym) ? ym.slice(5) + '/' + ym.slice(0, 4) : '');
const monIn = (attrs, val, ph = 'MM/YYYY') => `<input type="text" inputmode="numeric" autocomplete="off" maxlength="7" data-month ${attrs} value="${monTxt(val)}" placeholder="${ph}">`;
/** ô số nguyên: chỉ gõ được chữ số, báo lỗi ngay khi rời ô nếu ngoài khoảng min–max */
const intIn = (attrs, val, min, max, ph = '') => `<input type="text" inputmode="numeric" autocomplete="off" maxlength="${String(max).length}" data-int="${min},${max}" ${attrs} value="${esc(val ?? '')}" placeholder="${ph}">`;
function intErr(t) {
  const [min, max] = t.dataset.int.split(',').map(Number), v = t.value.trim();
  if (v === '') return t.hasAttribute('data-req') ? 'Không được để trống' : '';
  const n = +v; return n < min || n > max ? `Chỉ nhập số từ ${min} đến ${max}` : '';
}
/** ngày trả thật phải nằm trong tháng đã chọn */
function doiNgayErr(thang, ngay, ngayTra) {
  const m = ngay.slice(0, 7), dd = +ngay.slice(8);
  if (m === thang && dd >= 1) return '';
  return 'Ngày trả thật phải nằm trong tháng ' + monTxt(thang);
}
/** ô chọn ngày trong đúng tháng đã chọn: chỉ liệt kê các ngày của tháng đó nên không thể chọn sang tháng khác */
const WDL = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
function dayOptsHtml(thang, sel, ngayTra) {
  if (!V.isMonth(thang)) return '<option value="">← tháng</option>';
  const [y, mo] = thang.split('-').map(Number), last = new Date(y, mo, 0).getDate(), due = dueOf(thang, ngayTra);
  if (!sel || sel.slice(0, 7) !== thang) sel = due;
  let h = '';
  for (let d = 1; d <= last; d++) {
    const v = thang + '-' + String(d).padStart(2, '0'), wd = new Date(y, mo - 1, d).getDay();
    h += `<option value="${v}"${v === sel ? ' selected' : ''}>${String(d).padStart(2, '0')}/${String(mo).padStart(2, '0')} ${WDL[wd]}${v === due ? ' ★' : ''}</option>`;
  }
  return h;
}
const curNgayTra = () => { const e = $('#le-ngay_tra'); return e && +e.value >= 1 && +e.value <= 31 ? +e.value : 15; };
/** ngày trả theo lịch của một tháng (chưa tính dời thứ 7, CN) */
function dueOf(thang, ngayTra) {
  const [y, mo] = thang.split('-').map(Number), last = new Date(y, mo, 0).getDate();
  return thang + '-' + String(Math.min(ngayTra || 15, last)).padStart(2, '0');
}
const moneyIn = (attrs, val) => `<input type="text" inputmode="numeric" autocomplete="off" data-money ${attrs} value="${val ? fmt(val) : ''}" placeholder="0">`;
const rateIn = (attrs, val) => `<input type="text" inputmode="decimal" autocomplete="off" maxlength="5" data-rate ${attrs} value="${esc(String(val ?? '').replace('.', ','))}" placeholder="VD: 9,8">`;
function vClear(box) { box.querySelectorAll('.invalid').forEach(x => { x.classList.remove('invalid'); const e = x.querySelector(':scope > .err'); if (e) e.textContent = ''; }); }
/** errs: [[ô input, thông báo]] – đánh dấu ô lỗi, cuộn tới ô đầu tiên; trả về true nếu không có lỗi */
function vShow(box, errs) {
  vClear(box);
  errs = errs.filter(x => x[0] && x[1]);
  errs.forEach(([inp, msg]) => { const w = inp.closest('.fld, .lrow'); if (!w) return; w.classList.add('invalid'); const e = w.querySelector(':scope > .err'); if (e && !e.textContent) e.textContent = msg; });
  if (errs.length) { const f = errs[0][0]; f.scrollIntoView({ block: 'center', behavior: 'smooth' }); f.focus({ preventScroll: true }); toast('Còn ' + errs.length + ' ô chưa hợp lệ, xem chữ đỏ dưới ô', 'err'); }
  return !errs.length;
}
/** định dạng tiền khi gõ, xóa báo lỗi khi sửa */
function onModalInput(e) {
  const t = e.target;
  if (t.matches('[data-money]')) { const n = V.money(t.value); t.value = n ? fmt(n) : ''; }
  if (t.matches('[data-month]')) { // chỉ nhận số, tự chèn dấu "/" sau tháng: 022027 -> 02/2027
    let d = t.value.replace(/\D/g, '').slice(0, 6);
    if (d.length === 1 && +d > 1) d = '0' + d;
    t.value = d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d;
  }
  if (t.matches('[data-rate]')) { let v = t.value.replace('.', ',').replace(/[^\d,]/g, ''); const k = v.indexOf(','); if (k >= 0) v = v.slice(0, k + 1) + v.slice(k + 1).replace(/,/g, '').slice(0, 2); t.value = v; }
  if (t.matches('[data-money]')) { const d = t.value.replace(/\D/g, '').slice(0, 11); t.value = d ? fmt(+d) : ''; }
  if (t.matches('[data-int]')) t.value = t.value.replace(/\D/g, '').slice(0, t.maxLength > 0 ? t.maxLength : 3);
  // Đổi ngày trả: gõ xong tháng thì điền sẵn ngày trả theo lịch để chỉ cần sửa
  if (t.matches('fieldset[data-list="doi_ngay"] [data-k="thang"]')) {
    const sel = t.closest('.lrow').querySelector('select[data-dayof]'), th = /^\d{2}\/\d{4}$/.test(t.value) ? V.mon(t.value) : '';
    if (sel) { const ok = V.isMonth(th); sel.innerHTML = dayOptsHtml(ok ? th : '', sel.value, curNgayTra()); sel.disabled = !ok; }
  }
  // đổi ngày trả hằng tháng: cập nhật nhãn "(theo lịch)" của các ô đổi ngày chưa chọn khác
  if (t.id === 'le-ngay_tra') document.querySelectorAll('select[data-dayof]:not(:disabled)').forEach(sel => { sel.innerHTML = dayOptsHtml(sel.value.slice(0, 7), sel.value, curNgayTra()); });
  const w = t.closest('.invalid'); if (w) { w.classList.remove('invalid'); const er = w.querySelector(':scope > .err'); if (er) er.textContent = ''; }
}
/** rời ô số nguyên thì kiểm tra ngay, không đợi bấm Lưu */
function onModalBlur(e) {
  const t = e.target; if (!t.matches || !t.matches('input')) return;
  let msg;
  if (t.matches('[data-int]')) msg = intErr(t);
  else if (t.type === 'date') msg = V.dateErr(t.value, t.hasAttribute('data-req'), t.min, t.max);
  else if (t.matches('[data-month]')) msg = V.monErr(t.value, t.hasAttribute('data-req'));
  else if (t.matches('[data-rate]')) msg = t.value || t.hasAttribute('data-req') ? V.rate(t.value) : '';
  else if (t.matches('[data-money]')) { const n = V.money(t.value), mn = +t.dataset.min || 0, mx = +t.dataset.max || 0;
    msg = !n ? (t.hasAttribute('data-req') ? 'Nhập số tiền' : '') : mn && n < mn ? 'Tối thiểu ' + fmt(mn) + ' đ' : mx && n > mx ? 'Quá lớn, tối đa ' + fmt(mx) + ' đ' : ''; }
  else return;
  const w = t.closest('.fld, .lrow'); if (!w) return;
  if (!msg && w.querySelectorAll('input').length > 1 && w.classList.contains('lrow')) return; // dòng nhiều ô: để nút Lưu kiểm tra
  w.classList.toggle('invalid', !!msg); const er = w.querySelector(':scope > .err'); if (er) er.textContent = msg;
}
const monthOf = d => (d || '').slice(0, 7);
const addMonth = (m, n) => { const t = new Date(m + '-01T00:00'); t.setMonth(t.getMonth() + n); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0'); };

/* ---------- lịch trả nợ ---------- */
function scheduleHtml(c) {
  const { s } = c, k = s.ky_toi;
  const row = r => `<tr class="${r.da_qua ? 'past' : k && r.ky === k.ky ? 'next' : ''}"><td>${r.ky}</td><td>${fmtD(r.ngay)}</td><td class="rate">${rowRates(r)}</td><td>${fmt(r.du_no_dau)}</td><td>${fmt(r.goc)}${r.tra_truoc ? '<br><small>+' + fmt(r.tra_truoc) + ' trả trước</small>' : ''}${r.dao_no ? '<br><small>đảo nợ: khoản vay mới trả gốc</small>' : ''}</td><td>${fmt(r.lai)}</td><td>${fmt(r.tong)}</td>
      <td class="act">${r.da_qua ? '' : `<button type="button" class="btn sm" data-rt="from" data-loan="${c.i}" data-date="${r.tu_ngay}" title="Đổi lãi suất áp dụng từ đầu kỳ này">Đổi lãi</button>`}</td></tr>`;
  const sap = s.rows.filter(r => !r.da_qua), da = s.rows.filter(r => r.da_qua).reverse(); // sắp tới: gần nhất trước; đã trả: mới nhất trước
  const grp = (t, n) => `<tr class="grp"><td colspan="8">${t} (${n} kỳ)</td></tr>`;
  const body = `<div class="tablewrap"><table class="tbl rsp"><tr><th>Kỳ</th><th>Ngày</th><th>Lãi suất</th><th>Dư nợ đầu kỳ</th><th>Gốc</th><th>Lãi</th><th>Tổng</th><th></th></tr>${
    (sap.length ? grp('Sắp tới', sap.length) + sap.map(row).join('') : '') + (da.length ? grp('Đã trả', da.length) + da.map(row).join('') : '')}</table></div>`;
  return coll('sched-' + c.l.id, '<svg class="ic"><use href="#i-cal"/></svg>Lịch trả nợ', body, { cls: 'sub', sub: `${s.rows.length} kỳ · ${sap.length} kỳ sắp tới${k ? ' · kỳ tới ' + fmtD(k.ngay) : ''}` });
}

let openLoan = null;
const loanDone = c => c.s && !c.s.ky_toi && c.s.rows.length > 0;
const baseName = t => String(t || '').replace(/\s*\(.*\)\s*$/, '');
/** dòng mô tả chuỗi khoản vay nối tiếp (đảo nợ) */
function chainInfo(c, loans, today) {
  const g = c.l.nhom; if (!g) return '';
  const others = loans.map((l, i) => loanCtx(l, i, today)).filter(x => x.l.nhom === g && x.i !== c.i && x.s);
  if (!others.length) return '';
  const lai = [c, ...others].reduce((a, x) => a + x.s.rows.filter(r => r.da_qua).reduce((b, r) => b + r.lai, 0), 0);
  return `<p class="muted chain">Nối tiếp ${others.length} khoản vay trước (đảo nợ). Tổng lãi đã trả cả chuỗi: <b>${fmt(lai)} đ</b></p>`;
}

/* ---------- popup đảo nợ ---------- */
function rollFormHtml(c) {
  const { l, i, s } = c, cur = currentRate(l, todayStr());
  return `<div class="roll" id="roll-${i}"><p class="muted">Ngân hàng giải ngân khoản mới để trả gốc khoản cũ. Nếu khoản mới giải ngân trước ngày khoản cũ đáo hạn, những ngày chồng nhau sẽ tính lãi cả hai khoản (giống sheet).</p>
    <div class="grid2 f">
      ${fld('Ngày đáo hạn khoản cũ *', `<input type="date" data-rl="end" data-req min="${addDays(l.ngay_giai_ngan, 1)}" max="${addDays(todayStr(), 366)}" value="${esc(l.ngay_ket_thuc || '')}">`, `Ngày ngân hàng thu nốt lãi và tất toán khoản cũ. Phải sau ${fmtD(l.ngay_giai_ngan)}.`)}
      ${fld('Ngày giải ngân khoản mới *', `<input type="date" data-rl="start" data-req min="${addDays(l.ngay_giai_ngan, 1)}" max="${addDays(todayStr(), 366)}">`, 'Bằng hoặc trước ngày đáo hạn khoản cũ, sớm hơn tối đa 31 ngày.')}
      ${fld('Số tiền vay mới (đ) *', moneyIn('data-rl="amt" data-req data-min="1000000" data-max="10000000000"', s.du_no_hien_tai || l.so_tien_vay), `Thường bằng dư nợ khoản cũ: ${fmt(s.du_no_hien_tai || l.so_tien_vay)} đ.`)}
      ${fld('Lãi suất khoản mới (%/năm) *', rateIn('data-rl="rate" data-req', cur ? cur.nam : ''), 'Lãi suất năm, ví dụ 8,8.')}
      ${fld('Ngày trả hằng tháng *', intIn('data-rl="day" data-req', l.ngay_tra || 15, 1, 31), 'Từ 1 đến 31.')}
      ${fld('Tháng trả kỳ đầu', monIn('data-rl="ky"', ''), 'Dạng MM/YYYY, ví dụ 12/2026. Để trống: tháng liền sau tháng giải ngân.')}
    </div>
    <div class="actions modal-act"><button type="button" class="btn primary" data-rl-save="${i}"><svg class="ic"><use href="#i-check"/></svg>Lưu</button><button type="button" class="btn" data-rl-cancel>Hủy</button></div></div>`;
}
function applyRoll(i, box) {
  const q = k => box.querySelector(`[data-rl=${k}]`), v = k => q(k).value.trim();
  const loans = JSON.parse(JSON.stringify(conf().loans || [])), old = loans[i];
  const end = v('end'), start = v('start'), amt = V.money(v('amt')), rate = V.num(v('rate')), day = V.num(v('day'));
  const E = [];
  const maxD = addDays(todayStr(), 366), endE = V.dateErr(end, true, addDays(old.ngay_giai_ngan, 1), maxD, 'Ngày đáo hạn');
  E.push([q('end'), endE]);
  const stE = V.dateErr(start, true, addDays(old.ngay_giai_ngan, 1), maxD, 'Ngày giải ngân khoản mới');
  if (stE) E.push([q('start'), stE]);
  else if (!endE && start > end) E.push([q('start'), 'Không được sau ngày đáo hạn khoản cũ (' + fmtD(end) + ')']);
  else if (!endE && start < addDays(end, -31)) E.push([q('start'), 'Sớm hơn ngày đáo hạn quá 31 ngày, kiểm tra lại']);
  if (!amt) E.push([q('amt'), 'Nhập số tiền vay mới']); else if (amt < 1e6) E.push([q('amt'), 'Tối thiểu 1.000.000 đ']); else if (amt > 10e9) E.push([q('amt'), 'Số tiền quá lớn, kiểm tra lại số 0']);
  E.push([q('rate'), V.rate(v('rate'))]);
  E.push([q('day'), V.day(v('day'))]);
  let ky = V.mon(v('ky'));
  if (ky === '!') E.push([q('ky'), V.monErr(v('ky'))]);
  else if (ky && !stE && ky < monthOf(start)) E.push([q('ky'), 'Không được trước tháng giải ngân (' + monTxt(monthOf(start)) + ')']);
  else if (ky && !stE && ky > addMonth(monthOf(start), 12)) E.push([q('ky'), 'Không được quá 12 tháng sau tháng giải ngân']);
  if (!vShow(box, E)) return;
  const nhom = old.nhom || old.id, base = baseName(old.ten);
  if (!ky) ky = addMonth(monthOf(start), 1);
  Object.assign(old, { nhom, ngay_ket_thuc: end, dao_no: true, ten: `${base} (${fmtD(old.ngay_giai_ngan)} – ${fmtD(end)})` });
  loans.push({ id: nhom + '-' + start, nhom, ten: `${base} (từ ${fmtD(start)})`, kieu: old.kieu, so_tien_vay: amt, ngay_giai_ngan: start, so_thang: null,
    ngay_tra: day, goc_moi_ky: old.kieu === 'tra_gop' ? old.goc_moi_ky : 0, ky_dau: ky, lui_ngay_nghi: old.lui_ngay_nghi, nhac_truoc: old.nhac_truoc,
    lai_suat: [{ tu_ngay: start, nam: rate }], tra_truoc: [], tam_dung_goc: [], doi_ngay: {} });
  try { loans.forEach(l => LoanEngine.schedule(l, todayStr())); } catch (e) { toast('Cấu hình chưa hợp lệ: ' + e.message, 'err'); return; }
  closeModal(); openLoan = nhom + '-' + start; setConf('loans', loans);
  toast('Đã ghi đáo hạn khoản cũ ngày ' + fmtD(end) + ' và khoản vay mới từ ' + fmtD(start), 'ok');
}

/* ---------- thẻ khoản vay ---------- */
function loanCardHtml(c, loans, today) {
  const { l, i, s } = c, k = s.ky_toi;
  const seg = k ? `<div class="seg">Cách tính lãi kỳ tới:<br>${k.chi_tiet_lai.map(p => `${fmtD(p.tu)} → ${fmtD(p.den)}: ${p.so_ngay} ngày × ${fmt(p.du_no)} × ${pc(p.lai_suat)} / 365 = <b>${fmt(p.lai)}</b>`).join('<br>')}</div>` : '';
  const body = `${chainInfo(c, loans, today)}${loanKv(c, today)}${rateTableHtml(c)}${seg}${scheduleHtml(c)}
    <div class="actions" style="margin-top:14px">
      <button type="button" class="btn sm" data-roll="${i}" title="Đáo hạn khoản cũ &amp; vay khoản mới"><svg class="ic"><use href="#i-sync"/></svg>Đảo nợ</button>
      <button type="button" class="btn sm" data-edit="${i}"><svg class="ic"><use href="#i-edit"/></svg>Sửa khoản vay</button></div>`;
  return coll('loan-' + l.id, esc(l.ten), body, { acc: l.id, open: openLoan === l.id, cls: 'loan',
    sub: k ? `Kỳ tới ${fmtD(k.ngay)}: <b>${fmt(k.tong)} đ</b> · dư nợ ${compact(s.du_no_hien_tai)}` : 'Đã tất toán', extra: loanBadge(c) });
}
function doneCardHtml(c) {
  const { l, i, s } = c, last = s.rows[s.rows.length - 1];
  const lai = s.rows.reduce((a, r) => a + r.lai, 0);
  return `<div class="loan done"><div class="loan-h"><h3>${esc(l.ten)}</h3><span class="badge">${l.dao_no ? 'Đã đáo hạn, đảo nợ' : 'Đã tất toán'}</span></div>
    <div class="kv"><div><span>Giải ngân</span><b>${fmtD(l.ngay_giai_ngan)}</b></div><div><span>Đáo hạn</span><b>${fmtD(last.ngay)}</b></div>
      <div><span>Số tiền vay</span><b>${fmt(l.so_tien_vay)}</b></div><div><span>Lãi suất</span><b class="rate">${(l.lai_suat || []).map(r => pc(r.nam)).join(' → ')}</b></div>
      <div><span>Tổng lãi đã trả</span><b>${fmt(lai)}</b></div><div><span>Số kỳ</span><b>${s.rows.length}</b></div></div>
    ${scheduleHtml(c)}
    <p class="muted locked"><svg class="ic"><use href="#i-check"/></svg>Khoản vay đã kết thúc nên chỉ xem, không sửa được.</p></div>`;
}
function renderLoans() {
  const today = todayStr(), loans = conf().loans || [];
  if (!loans.length) { $('#loanCards').innerHTML = '<div class="card empty">Chưa có khoản vay. Nạp file dữ liệu ban đầu hoặc bấm “Thêm khoản vay”.</div>'; return; }
  const ctx = loans.map((l, i) => loanCtx(l, i, today));
  const active = ctx.filter(c => !loanDone(c)), done = ctx.filter(loanDone);
  if (openLoan === null) { // lần đầu: mở khoản sắp đến hạn nhất
    const nx = active.filter(c => c.s && c.s.ky_toi).sort((a, b) => a.s.ky_toi.ngay.localeCompare(b.s.ky_toi.ngay))[0];
    openLoan = nx ? nx.l.id : '';
  }
  let html = active.map(c => c.s ? loanCardHtml(c, loans, today)
    : `<div class="loan"><div class="loan-h"><h3>${esc(c.l.ten)}</h3><button class="btn sm" data-edit="${c.i}">Sửa</button></div><p class="muted">Cấu hình lỗi: ${esc(c.err)}</p></div>`).join('');
  if (done.length) html += coll('done-loans', 'Khoản vay đã tất toán / đã đảo nợ', done.map(doneCardHtml).join(''), { cls: 'loan', sub: `${done.length} khoản · tổng lãi đã trả ${fmt(done.reduce((a, c) => a + c.s.rows.reduce((b, r) => b + r.lai, 0), 0))} đ` });
  $('#loanCards').innerHTML = html;
  $('#loanCards').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.edit) openLoanEditor(+b.dataset.edit);
    if (b.dataset.roll) { const i = +b.dataset.roll, c = loanCtx(loans[i], i, today); openModal('Đáo hạn & vay khoản mới (đảo nợ)', rollFormHtml(c)); }
    if (b.dataset.acc) { openLoan = openLoan === b.dataset.acc ? '' : b.dataset.acc; renderLoans(); }
  };
}

/* ---- sửa mốc lãi suất ---- */
function applyLoanEdit(i, mutate, okMsg) {
  const loans = JSON.parse(JSON.stringify(conf().loans || [])), today = todayStr();
  const before = loanCtx(loans[i], i, today).s;
  mutate(loans[i]);
  let after;
  try { after = LoanEngine.schedule(loans[i], today); } catch (err) { toast('Cấu hình chưa hợp lệ: ' + err.message, 'err'); return false; }
  closeModal(); setConf('loans', loans);
  const nk = after.ky_toi;
  const dl = before ? after.lai_con_lai - before.lai_con_lai : 0;
  toast(okMsg + ' Lãi còn lại ' + (dl >= 0 ? '+' : '') + fmt(dl) + ' đ' + (nk ? '. Kỳ tới ' + fmtD(nk.ngay) + ': ' + fmt(nk.tong) + ' đ' : ''), 'ok');
  return true;
}
const loanEnd = l => { try { return LoanEngine.schedule(l, todayStr()).dao_han; } catch (e) { return null; } };
function openRateModal(i, idx, date) {
  const l = (conf().loans || [])[i], today = todayStr(), r = idx === 'new' ? null : l.lai_suat[idx], cur = currentRate(l, today), end = loanEnd(l);
  const list = (l.lai_suat || []).slice().sort((a, b) => a.tu_ngay.localeCompare(b.tu_ngay)).map(x => `${fmtD(x.tu_ngay)}: ${pc(x.nam)}`).join(' · ');
  openModal(idx === 'new' ? 'Thêm mốc đổi lãi suất' : 'Sửa mốc lãi suất', `<p class="muted">${esc(l.ten)}<br>Các mốc hiện có: ${list || 'chưa có'}</p>
    <div class="row">
      ${fld('Áp dụng từ ngày *', `<input type="date" data-rf="date" data-req min="${l.ngay_giai_ngan}"${end ? ` max="${end}"` : ''} value="${esc(r ? r.tu_ngay : date || today)}">`, `Ngày ngân hàng bắt đầu tính lãi mới (xem tin nhắn hoặc app ngân hàng). Từ ${fmtD(l.ngay_giai_ngan)}${end ? ' đến ' + fmtD(end) : ''}.`)}
      ${fld('Lãi suất (%/năm) *', rateIn('data-rf="rate" data-req', r ? r.nam : cur ? cur.nam : ''), 'Lãi suất năm, ví dụ 9,8. Không gõ dấu %.')}
    </div>
    <p class="muted">Tiền lãi các kỳ sau ngày này, lịch trả nợ và số liệu tổng hợp sẽ tự tính lại.</p>
    <div class="actions modal-act"><button type="button" class="btn primary" data-rt="save" data-loan="${i}" data-idx="${idx}"><svg class="ic"><use href="#i-check"/></svg>Lưu</button><button type="button" class="btn" data-rt="cancel">Hủy</button></div>`);
}
function onRateClick(e) {
  const b = e.target.closest('[data-rt]'); if (!b) return;
  const op = b.dataset.rt, i = +b.dataset.loan, idx = b.dataset.idx === 'new' ? 'new' : +b.dataset.idx;
  if (op !== 'cancel' && op !== 'save' && loanDone(loanCtx((conf().loans || [])[i], i, todayStr()))) { toast('Khoản vay đã tất toán / đảo nợ, chỉ xem, không sửa được', 'err'); return; }
  if (op === 'add' || op === 'from' || op === 'edit') { openRateModal(i, op === 'edit' ? idx : 'new', op === 'from' ? b.dataset.date : null); return; }
  if (op === 'cancel') { closeModal(); return; }
  if (op === 'del') {
    const l = (conf().loans || [])[i];
    if ((l.lai_suat || []).length <= 1) { toast('Phải còn ít nhất một mức lãi suất', 'err'); return; }
    const r = l.lai_suat[idx];
    if (confirm('Xóa mốc lãi suất ' + pc(r.nam) + '/năm từ ngày ' + fmtD(r.tu_ngay) + '?\nCác kỳ sau sẽ tính theo mức lãi của mốc trước đó.')) applyLoanEdit(i, x => x.lai_suat.splice(idx, 1), 'Đã xóa mốc lãi suất.');
  } else if (op === 'save') {
    const box = b.closest('.modal-b'), di = box.querySelector('[data-rf=date]'), ri = box.querySelector('[data-rf=rate]'), date = di.value, nam = V.num(ri.value);
    const l = (conf().loans || [])[i], end = loanEnd(l), E = [];
    if (!V.isDate(date)) E.push([di, date ? 'Ngày không hợp lệ' : 'Chọn ngày áp dụng']);
    else if (date < l.ngay_giai_ngan) E.push([di, 'Không được trước ngày giải ngân (' + fmtD(l.ngay_giai_ngan) + ')']);
    else if (end && date > end) E.push([di, 'Không được sau ngày đáo hạn (' + fmtD(end) + ')']);
    else if ((l.lai_suat || []).some((r, k) => r.tu_ngay === date && k !== idx)) E.push([di, 'Đã có mốc ngày ' + fmtD(date) + ', hãy bấm Sửa ở dòng đó']);
    E.push([ri, V.rate(ri.value)]);
    if (idx !== 'new' && date !== l.lai_suat[idx].tu_ngay && l.lai_suat[idx].tu_ngay <= l.ngay_giai_ngan && !(l.lai_suat || []).some((r, k) => k !== idx && r.tu_ngay <= l.ngay_giai_ngan))
      E.push([di, 'Đây là mức lãi đầu tiên, phải giữ từ ngày giải ngân ' + fmtD(l.ngay_giai_ngan)]);
    if (!vShow(box, E)) return;
    applyLoanEdit(i, x => { if (idx === 'new') x.lai_suat.push({ tu_ngay: date, nam }); else x.lai_suat[idx] = { ...x.lai_suat[idx], tu_ngay: date, nam }; x.lai_suat.sort((a, c2) => a.tu_ngay.localeCompare(c2.tu_ngay)); },
      idx === 'new' ? 'Đã thêm mốc lãi suất ' + pc(nam) + ' từ ' + fmtD(date) + '.' : 'Đã cập nhật lãi suất.');
  }
}

/* ---------- popup thêm / sửa khoản vay ---------- */
const LIST_DEFS = {
  lai_suat: { title: 'Lãi suất *', hint: 'Mỗi lần ngân hàng đổi lãi thì thêm một dòng. Dòng đầu tiên phải từ ngày giải ngân.',
    fields: [['tu_ngay', 'date', 'Từ ngày'], ['nam', 'rate', '%/năm, VD 9,8']] },
  tra_truoc: { title: 'Trả trước gốc', hint: 'Những lần trả bớt gốc ngoài lịch (ngày, số tiền, ghi chú).',
    fields: [['ngay', 'date', 'Ngày trả'], ['so_tien', 'money', 'Số tiền'], ['ghi_chu', 'text', 'Ghi chú']] },
  tam_dung_goc: { title: 'Tạm dừng trả gốc', hint: 'Các tháng chỉ trả lãi, không trả gốc (từ tháng … đến tháng …).',
    fields: [['tu_ky', 'month', 'Từ tháng'], ['den_ky', 'month', 'Đến tháng']] },
  doi_ngay: { title: 'Đổi ngày trả một tháng', hint: 'Khi ngân hàng thu khác ngày thường (lễ, Tết, hệ thống trễ…): gõ tháng trước, ô bên cạnh chỉ cho chọn các ngày trong đúng tháng đó (★ là ngày theo lịch). Lãi kỳ này và kỳ sau tự tính lại theo số ngày thực tế.',
    fields: [['thang', 'month', 'Tháng'], ['ngay', 'dayof', 'Ngày trả thật']] },
};
function openLoanEditor(idx) {
  const loans = conf().loans || [];
  if (idx != null && loanDone(loanCtx(loans[idx], idx, todayStr()))) { toast('Khoản vay đã tất toán / đảo nợ, chỉ xem, không sửa được', 'err'); return; }
  const l = idx == null ? { id: 'vay-' + Date.now().toString(36), ten: '', kieu: 'tra_gop', so_tien_vay: '', ngay_giai_ngan: todayStr(), so_thang: '', ngay_tra: 15, goc_moi_ky: '', ky_dau: '', lui_ngay_nghi: true, nhac_truoc: 5, lai_suat: [{ tu_ngay: todayStr(), nam: '' }], tra_truoc: [], tam_dung_goc: [], doi_ngay: {} } : JSON.parse(JSON.stringify(loans[idx]));
  const lists = { ...l, doi_ngay: Object.entries(l.doi_ngay || {}).map(([thang, ngay]) => ({ thang, ngay })) };
  const inp = (k, type, ph, val, row = {}) => type === 'dayof' ? `<select data-k="${k}" data-dayof title="${ph}"${V.isMonth(row.thang) ? '' : ' disabled'}>${dayOptsHtml(row.thang, val, l.ngay_tra)}</select>`
    : type === 'month' ? monIn(`data-k="${k}" title="${ph}"`, val, 'MM/YYYY') : type === 'money' ? moneyIn(`data-k="${k}" title="${ph}"`, val) : type === 'rate' ? rateIn(`data-k="${k}" title="${ph}"`, val)
    : `<input data-k="${k}" type="${type}" placeholder="${ph}" title="${ph}"${type === 'text' ? ' maxlength="100"' : ''} value="${esc(val ?? '')}">`;
  const rowHtml = (def, r) => `<div class="lrow${def.fields.length === 3 ? ' three' : ''}">${def.fields.map(([k, t, ph]) => inp(k, t, ph, r[k], r)).join('')}<button type="button" data-delrow aria-label="Xóa dòng">✕</button><small class="err"></small></div>`;
  const listHtml = key => {
    const def = LIST_DEFS[key], rows = lists[key] || [];
    return `<fieldset data-list="${key}"><legend>${def.title}</legend><small class="hint">${def.hint}</small>
      <div class="lhead${def.fields.length === 3 ? ' three' : ''}">${def.fields.map(f => `<span>${f[2]}</span>`).join('')}<span></span></div>
      ${rows.map(r => rowHtml(def, r)).join('')}
      <div class="actions"><button type="button" class="btn sm" data-addrow="${key}">＋ Thêm dòng</button></div></fieldset>`;
  };
  const ti = (id, type, val, extra = '') => `<input id="le-${id}" type="${type}" value="${esc(val ?? '')}" ${extra}>`;
  const ed = openModal(idx == null ? 'Thêm khoản vay' : 'Sửa: ' + l.ten, `
    ${fld('Tên khoản vay *', ti('ten', 'text', l.ten, 'maxlength="60" placeholder="VD: Vay mua ô tô"'), 'Tên ngắn để nhận ra khoản vay, tối đa 60 ký tự.')}
    <div class="grid2 f">
      ${fld('Cách trả *', `<select id="le-kieu"><option value="tra_gop">Trả góp: gốc đều hằng tháng + lãi</option><option value="tra_lai">Hằng tháng trả lãi, gốc trả cuối kỳ</option></select>`, 'Vay mua xe thường là trả góp; vay thế chấp ngắn hạn thường chỉ trả lãi.')}
      ${fld('Số tiền vay (đ) *', moneyIn('id="le-so_tien_vay" data-req data-min="1000000" data-max="10000000000"', l.so_tien_vay), 'Số tiền ngân hàng giải ngân, ví dụ 450.000.000.')}
      ${fld('Ngày giải ngân *', ti('ngay_giai_ngan', 'date', l.ngay_giai_ngan, `data-req min="2000-01-01" max="${addDays(todayStr(), 366)}"`), 'Ngày bắt đầu tính lãi, không quá 1 năm sau hôm nay.')}
      ${fld('Thời hạn (tháng)', intIn('id="le-so_thang"', l.so_thang, 1, 480, 'VD: 84'), 'Ví dụ 84 tháng = 7 năm (tối đa 480). Để trống nếu dùng "Ngày đáo hạn cụ thể" hoặc chưa biết.')}
      ${fld('Ngày trả hằng tháng *', intIn('id="le-ngay_tra" data-req', l.ngay_tra, 1, 31, 'VD: 15'), 'Từ 1 đến 31. Tháng không có ngày đó thì trả ngày cuối tháng.')}
      ${fld('Gốc mỗi kỳ (đ)', moneyIn('id="le-goc_moi_ky" data-min="10000"', l.goc_moi_ky), 'Bắt buộc với trả góp, ví dụ 5.350.000. Bỏ trống nếu chỉ trả lãi.')}
      ${fld('Tháng trả kỳ đầu', monIn('id="le-ky_dau"', l.ky_dau), 'Dạng MM/YYYY, ví dụ 06/2024. Từ tháng giải ngân đến 12 tháng sau. Để trống: tháng liền sau tháng giải ngân.')}
      ${fld('Nhắc trước (ngày)', intIn('id="le-nhac_truoc"', l.nhac_truoc, 0, 30, '5'), 'Cảnh báo trên trang và Telegram trước hạn bao nhiêu ngày (0–30).')}
      ${fld('Ngày đáo hạn cụ thể', ti('ngay_ket_thuc', 'date', l.ngay_ket_thuc), 'Nếu ngân hàng ghi rõ ngày đáo hạn. Nhập ngày này thì để trống "Thời hạn" (hoặc nhập thời hạn khớp với ngày này).')}
      ${fld('Nhóm', ti('nhom', 'text', l.nhom, 'maxlength="30" placeholder="VD: nha"'), 'Các khoản đảo nợ nối tiếp nhau dùng chung một nhóm (chữ không dấu, không khoảng trắng).')}
    </div>
    <label class="chk"><input id="le-dao" type="checkbox" ${l.dao_no ? 'checked' : ''}> Gốc cuối kỳ trả bằng khoản vay mới (đảo nợ)</label>
    <label class="chk"><input id="le-lui" type="checkbox" ${l.lui_ngay_nghi !== false ? 'checked' : ''}> Rơi vào thứ 7, chủ nhật thì dời sang thứ 2</label>
    ${Object.keys(LIST_DEFS).map(listHtml).join('')}
    <div class="actions modal-act"><button type="button" class="btn primary" id="le-save">Lưu khoản vay</button><button type="button" class="btn" id="le-cancel">Đóng</button>${idx == null ? '' : '<button type="button" class="btn danger" id="le-del">Xóa</button>'}</div>`);
  $('#le-kieu').value = l.kieu || 'tra_gop';
  ed.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.addrow) { const key = b.dataset.addrow; b.closest('.actions').insertAdjacentHTML('beforebegin', rowHtml(LIST_DEFS[key], {})); const n = b.closest('fieldset').querySelector('.lrow:last-of-type input'); if (n) n.focus(); }
    if (b.hasAttribute('data-delrow')) b.closest('.lrow').remove();
  };
  $('#le-cancel').onclick = closeModal;
  if ($('#le-del')) $('#le-del').onclick = () => {
    if (!confirm('Xóa khoản vay "' + l.ten + '"? Không ảnh hưởng dữ liệu chi tiêu.')) return;
    const next = loans.slice(); next.splice(idx, 1); closeModal(); setConf('loans', next);
  };
  $('#le-save').onclick = () => {
    const g = id => $('#le-' + id), val = id => g(id).value.trim(), E = [];
    const out = { ...l, ten: val('ten'), kieu: val('kieu'), so_tien_vay: V.money(val('so_tien_vay')), ngay_giai_ngan: val('ngay_giai_ngan'),
      so_thang: val('so_thang') ? V.num(val('so_thang')) : null, ngay_tra: V.num(val('ngay_tra')), goc_moi_ky: V.money(val('goc_moi_ky')), ky_dau: V.mon(val('ky_dau')),
      nhac_truoc: val('nhac_truoc') === '' ? 5 : V.num(val('nhac_truoc')), lui_ngay_nghi: g('lui').checked,
      ngay_ket_thuc: val('ngay_ket_thuc') || undefined, nhom: val('nhom') || undefined, dao_no: g('dao').checked || undefined };
    const gd = out.ngay_giai_ngan, okGd = V.isDate(gd) && !V.dateErr(gd, true, '2000-01-01', addDays(todayStr(), 366));
    if (!out.ten) E.push([g('ten'), 'Nhập tên khoản vay']);
    else if (out.ten.length > 60) E.push([g('ten'), 'Tối đa 60 ký tự']);
    if (!out.so_tien_vay) E.push([g('so_tien_vay'), 'Nhập số tiền vay']); else if (out.so_tien_vay < 1e6) E.push([g('so_tien_vay'), 'Tối thiểu 1.000.000 đ']); else if (out.so_tien_vay > 10e9) E.push([g('so_tien_vay'), 'Số tiền quá lớn, kiểm tra lại số 0']);
    E.push([g('ngay_giai_ngan'), V.dateErr(gd, true, '2000-01-01', addDays(todayStr(), 366), 'Ngày giải ngân')]);
    if (out.so_thang != null && (!Number.isInteger(out.so_thang) || out.so_thang < 1 || out.so_thang > 480)) E.push([g('so_thang'), 'Nhập số tháng nguyên từ 1 đến 480']);
    E.push([g('ngay_tra'), V.day(val('ngay_tra'))]);
    if (out.kieu === 'tra_gop') {
      if (!out.goc_moi_ky) E.push([g('goc_moi_ky'), 'Trả góp cần nhập gốc mỗi kỳ']);
      else if (out.goc_moi_ky < 10000) E.push([g('goc_moi_ky'), 'Tối thiểu 10.000 đ']);
      else if (out.goc_moi_ky > out.so_tien_vay) E.push([g('goc_moi_ky'), 'Gốc mỗi kỳ không được lớn hơn số tiền vay']);
    }
    if (out.ky_dau === '!') E.push([g('ky_dau'), V.monErr(val('ky_dau'))]);
    else if (out.ky_dau && okGd && out.ky_dau < monthOf(gd)) E.push([g('ky_dau'), 'Không được trước tháng giải ngân']);
    else if (out.ky_dau && okGd && out.ky_dau > addMonth(monthOf(gd), 12)) E.push([g('ky_dau'), 'Không được quá 12 tháng sau tháng giải ngân']);
    if (!Number.isInteger(out.nhac_truoc) || out.nhac_truoc < 0 || out.nhac_truoc > 30) E.push([g('nhac_truoc'), 'Nhập số ngày nguyên từ 0 đến 30']);
    if (out.ngay_ket_thuc) {
      const m = V.dateErr(out.ngay_ket_thuc, false, okGd ? addDays(gd, 1) : '', okGd ? addDays(gd, 365 * 40) : '', 'Ngày đáo hạn');
      if (m) E.push([g('ngay_ket_thuc'), m]);
      else if (okGd && out.so_thang && addMonth(monthOf(gd), out.so_thang) !== monthOf(out.ngay_ket_thuc))
        E.push([g('so_thang'), `Không khớp ngày đáo hạn ${fmtD(out.ngay_ket_thuc)}. Để trống ô này hoặc sửa cho khớp`]);
    }
    // ngày cuối cùng còn tính lãi (để giới hạn các dòng bên dưới)
    const endD = out.ngay_ket_thuc && V.isDate(out.ngay_ket_thuc) ? out.ngay_ket_thuc : okGd && out.so_thang > 0 ? dueOf(addMonth(monthOf(gd), out.so_thang), +gd.slice(8)) : '';
    const endM = endD ? monthOf(endD) : '', firstM = out.ky_dau && out.ky_dau !== '!' ? out.ky_dau : okGd ? addMonth(monthOf(gd), 1) : '';
    if (out.nhom && !/^[a-z0-9_-]+$/i.test(out.nhom)) E.push([g('nhom'), 'Chỉ dùng chữ không dấu, số, gạch ngang (VD: nha)']);
    // các danh sách
    const rowsOf = key => [...ed.querySelectorAll(`fieldset[data-list="${key}"] .lrow`)].map(row => {
      const o = { _row: row }; row.querySelectorAll('input, select').forEach(i => { const raw = i.value.trim(); o[i.dataset.k] = i.matches('[data-month]') ? V.mon(raw) : raw; o['_' + i.dataset.k] = i; }); return o;
    }).filter(o => LIST_DEFS[key].fields.some(([k]) => o[k]));
    const inRange = d => (!okGd || d >= gd) && (!endD || d <= endD);
    const rangeTxt = (okGd ? ' (từ ' + fmtD(gd) : ' (') + (endD ? ' đến ' + fmtD(endD) : '') + ')';
    const ls = rowsOf('lai_suat');
    if (!ls.length) E.push([ed.querySelector('[data-addrow=lai_suat]'), 'Cần ít nhất một mức lãi suất']);
    ls.forEach(r => {
      if (!V.isDate(r.tu_ngay)) E.push([r._tu_ngay, 'Dòng lãi suất: chọn ngày']); else if (!inRange(r.tu_ngay)) E.push([r._tu_ngay, 'Ngày đổi lãi phải trong thời gian vay' + rangeTxt]);
      const m = V.rate(r.nam); if (m) E.push([r._nam, 'Dòng lãi suất: ' + m.toLowerCase()]);
    });
    const dates = ls.map(r => r.tu_ngay).filter(Boolean);
    ls.forEach(r => { if (r.tu_ngay && dates.filter(d => d === r.tu_ngay).length > 1) E.push([r._tu_ngay, 'Trùng ngày với một dòng lãi suất khác']); });
    if (okGd && dates.length && !dates.some(d => d <= gd)) E.push([ls[0]._tu_ngay, 'Phải có một mức lãi từ ngày giải ngân ' + fmtD(gd)]);
    const tt = rowsOf('tra_truoc');
    tt.forEach(r => {
      if (!V.isDate(r.ngay)) E.push([r._ngay, 'Chọn ngày trả trước']); else if (!inRange(r.ngay)) E.push([r._ngay, 'Ngày trả trước phải trong thời gian vay' + rangeTxt]);
      const n = V.money(r.so_tien); if (!n) E.push([r._so_tien, 'Nhập số tiền trả trước']); else if (n > out.so_tien_vay) E.push([r._so_tien, 'Lớn hơn số tiền vay']);
    });
    const sumTT = tt.reduce((a, r) => a + V.money(r.so_tien), 0);
    if (tt.length && out.so_tien_vay && sumTT >= out.so_tien_vay) E.push([tt[tt.length - 1]._so_tien, 'Tổng trả trước (' + fmt(sumTT) + ' đ) phải nhỏ hơn số tiền vay']);
    const td = rowsOf('tam_dung_goc');
    td.forEach(r => {
      if (!V.isMonth(r.tu_ky)) E.push([r._tu_ky, V.monErr(r._tu_ky.value, true).replace('Nhập tháng', 'Nhập tháng bắt đầu')]);
      if (!V.isMonth(r.den_ky)) E.push([r._den_ky, V.monErr(r._den_ky.value, true).replace('Nhập tháng', 'Nhập tháng kết thúc')]);
      else if (V.isMonth(r.tu_ky) && r.den_ky < r.tu_ky) E.push([r._den_ky, '"Đến tháng" phải sau hoặc bằng "Từ tháng"']);
      if (V.isMonth(r.tu_ky) && firstM && r.tu_ky < firstM) E.push([r._tu_ky, 'Không được trước kỳ trả đầu tiên ' + monTxt(firstM)]);
      if (V.isMonth(r.den_ky) && endM && r.den_ky > endM) E.push([r._den_ky, 'Không được sau tháng đáo hạn ' + monTxt(endM)]);
    });
    td.forEach((r, i) => { if (td.some((x, j) => j < i && V.isMonth(x.tu_ky) && V.isMonth(x.den_ky) && r.tu_ky <= x.den_ky && r.den_ky >= x.tu_ky)) E.push([r._tu_ky, 'Chồng lên một khoảng tạm dừng khác']); });
    const dn = rowsOf('doi_ngay');
    dn.forEach(r => {
      if (!V.isMonth(r.thang)) E.push([r._thang, V.monErr(r._thang.value, true)]);
      else if (firstM && r.thang < firstM) E.push([r._thang, 'Không được trước kỳ trả đầu tiên ' + monTxt(firstM)]);
      else if (endM && r.thang > endM) E.push([r._thang, 'Không được sau tháng đáo hạn ' + monTxt(endM)]);
      if (!V.isDate(r.ngay)) E.push([r._ngay, r.ngay ? 'Ngày không hợp lệ' : 'Chọn ngày trả thật']);
      else if (V.isMonth(r.thang)) { const m = doiNgayErr(r.thang, r.ngay, out.ngay_tra); if (m) E.push([r._ngay, m]); }
    });
    if (new Set(dn.map(r => r.thang)).size < dn.length) E.push([dn[dn.length - 1]._thang, 'Trùng tháng với dòng khác']);
    if (!vShow(ed, E)) return;
    out.lai_suat = ls.map(r => ({ tu_ngay: r.tu_ngay, nam: V.num(r.nam) })).sort((a, b) => a.tu_ngay.localeCompare(b.tu_ngay));
    out.tra_truoc = tt.map(r => ({ ngay: r.ngay, so_tien: V.money(r.so_tien), ghi_chu: r.ghi_chu || '' }));
    out.tam_dung_goc = td.map(r => ({ tu_ky: r.tu_ky, den_ky: r.den_ky }));
    out.doi_ngay = Object.fromEntries(dn.map(r => [r.thang, r.ngay]));
    if (out.kieu === 'tra_lai') out.goc_moi_ky = 0;
    let sc; try { sc = LoanEngine.schedule(out, todayStr()); } catch (e) { toast('Cấu hình chưa hợp lệ: ' + e.message, 'err'); return; }
    // ngày trả đã đổi không được trùng hoặc vượt qua kỳ liền trước / liền sau
    const E2 = [];
    sc.rows.forEach((r, i) => {
      if (r.so_ngay > 0) return;
      const prevTh = i ? sc.rows[i - 1].thang : null, row = dn.find(x => x.thang === r.thang) || dn.find(x => x.thang === prevTh);
      if (row) E2.push([row._ngay, i ? `Phải sau ngày trả kỳ trước (${fmtD(r.tu_ngay)}) và trước kỳ sau` : `Phải sau ngày giải ngân (${fmtD(r.tu_ngay)})`]);
    });
    if (!vShow(ed, E2)) return;
    const next = loans.slice(); if (idx == null) next.push(out); else next[idx] = out;
    closeModal(); if (idx == null) openLoan = out.id; setConf('loans', next); toast('Đã lưu khoản vay', 'ok');
  };
}

/* ---------- Tổng hợp › Nợ vay ---------- */
let thView = load('cthn.thview', 'ct'), debtYear = null;
const GCOL = ['#fb923c', '#22d3ee', '#f472b6', '#84cc16'];
/** Gom các khoản vay theo nhóm (khoản đảo nợ nối tiếp tính chung) và tính số liệu tổng/đã trả/còn lại */
function debtModel() {
  const today = todayStr(), loans = conf().loans || [], map = new Map();
  loans.forEach((l, i) => {
    const c = loanCtx(l, i, today); if (!c.s) return;
    const key = l.nhom || l.id, name = baseName(l.ten);
    if (!map.has(key)) map.set(key, { key, name, short: /ô tô|oto|\bxe\b/i.test(name) ? 'Ô tô' : /nhà/i.test(name) ? 'Nhà' : name, ctx: [], rows: [] });
    const g = map.get(key); g.ctx.push(c);
    c.s.rows.forEach(r => g.rows.push({ ...r, loan: l, cash: cg(r) + r.tra_truoc }));
  });
  const gs = [...map.values()];
  gs.forEach((g, j) => {
    g.color = GCOL[j % GCOL.length];
    g.rows.sort((a, b) => a.ngay.localeCompare(b.ngay));
    const paid = g.rows.filter(r => r.da_qua), fut = g.rows.filter(r => !r.da_qua);
    const act = g.ctx.filter(c => c.s.ky_toi);
    g.paidG = paid.reduce((a, r) => a + r.cash, 0); g.paidL = paid.reduce((a, r) => a + r.lai, 0);
    g.duNo = act.reduce((a, c) => a + c.s.du_no_hien_tai, 0);
    g.remG = g.duNo; g.remL = fut.reduce((a, r) => a + r.lai, 0);
    g.totG = g.paidG + g.remG; g.totL = g.paidL + g.remL;
    g.accrued = act.reduce((a, c) => a + c.s.lai_tam_tinh, 0);
    g.next = act.map(c => ({ ...c.s.ky_toi, loan: c.l, con_ngay: c.s.con_ngay })).sort((a, b) => a.ngay.localeCompare(b.ngay))[0] || null;
    g.openEnded = act.some(c => !c.s.dao_han);
    g.lastDate = g.rows.length ? g.rows[g.rows.length - 1].ngay : null;
    g.daoHan = act.map(c => c.s.dao_han).filter(Boolean).sort().pop() || null;
    g.loanOrig = g.ctx[0] ? g.ctx[0].l.so_tien_vay : 0;
  });
  return gs;
}
/** Các mốc sắp tới: đổi lãi suất, hết tạm dừng trả gốc, đáo hạn */
function debtMilestones(gs) {
  const today = todayStr(), out = [];
  gs.forEach(g => g.ctx.filter(c => c.s.ky_toi).forEach(c => {
    const l = c.l;
    (l.lai_suat || []).filter(r => r.tu_ngay > today).forEach(r => out.push({ d: r.tu_ngay, g, t: `Đổi lãi suất sang <b>${pc(r.nam)}/năm</b>` }));
    (l.tam_dung_goc || []).forEach(t => {
      const r = c.s.rows.find(x => x.thang > t.den_ky && x.goc > 0);
      if (r && !r.da_qua) out.push({ d: r.ngay, g, t: `Hết tạm dừng, trả gốc trở lại <b>${fmt(r.goc)} đ</b>/kỳ (kỳ này tổng <b>${fmt(r.tong)} đ</b>)` });
    });
    if (c.s.dao_han && c.s.dao_han > today) {
      const last = c.s.rows[c.s.rows.length - 1];
      out.push({ d: c.s.dao_han, g, t: l.dao_no ? `Đáo hạn, đảo nợ ${fmt(last.goc)} đ sang khoản vay mới` : `Đáo hạn, tất toán. Kỳ cuối trả <b>${fmt(last.tong)} đ</b>` });
    }
  }));
  return out.sort((a, b) => a.d.localeCompare(b.d));
}
const daysTo = d => Math.round((new Date(d + 'T00:00') - new Date(todayStr() + 'T00:00')) / 864e5);
/** 25 -> "còn 25 ngày"; 82 -> "còn ~3 tháng"; 1638 -> "còn ~4 năm 6 tháng" */
function fmtLeft(d) {
  const n = daysTo(d); if (n < 0) return 'đã qua'; if (n === 0) return 'hôm nay'; if (n <= 60) return 'còn ' + n + ' ngày';
  const mo = Math.round(n / 30.44); if (mo < 12) return 'còn ~' + mo + ' tháng';
  const y = Math.floor(mo / 12), r = mo % 12; return 'còn ~' + y + ' năm' + (r ? ' ' + r + ' tháng' : '');
}
function renderDebtView() {
  const el = $('#th-no'), gs = debtModel();
  if (!gs.length) { el.innerHTML = '<div class="card empty">Chưa có khoản vay. Vào tab Khoản vay để thêm.</div>'; return; }
  const today = todayStr(), sum = k => gs.reduce((a, g) => a + g[k], 0);
  const T = { paidG: sum('paidG'), paidL: sum('paidL'), remG: sum('remG'), remL: sum('remL'), totG: sum('totG'), totL: sum('totL'), duNo: sum('duNo') };
  const open = gs.some(g => g.openEnded);
  const cell = (g, l, cls = '') => `<div class="dv ${cls}"><span>Gốc</span><b>${fmt(g)}</b><span>Lãi</span><b>${fmt(l)}</b><span class="tt">Cộng</span><b class="tt">${fmt(g + l)}</b></div>`;
  const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);

  // 1) Kỳ trả sắp tới
  let html = `<h2 class="sec-title">Kỳ trả sắp tới</h2><div class="next-grid">${gs.filter(g => g.next).map(g => {
    const n = g.next, cls = n.con_ngay <= 1 ? 'red' : n.con_ngay <= 5 ? 'warn' : '';
    return `<div class="next-card" style="--gc:${g.color}"><div class="nc-h"><b>${esc(g.short)}</b><span class="badge ${cls}">${n.con_ngay === 0 ? 'Hôm nay' : 'Còn ' + n.con_ngay + ' ngày'}</span></div>
      <div class="nc-d">${fmtD(n.ngay)}</div><div class="nc-v" data-n="${n.tong}" data-suf=" đ">${fmt(n.tong)} đ</div>
      <div class="nc-s">gốc ${fmt(n.goc)} · lãi ${fmt(n.lai)}${n.chi_tiet_lai.length > 1 ? `<br>${n.chi_tiet_lai.map(p => `${pc(p.lai_suat)}: ${fmt(p.lai)}`).join(' + ')}` : ''}</div></div>`;
  }).join('')}<div class="next-card total"><div class="nc-h"><b>Tổng kỳ tới</b></div><div class="nc-d">&nbsp;</div><div class="nc-v">${fmt(gs.reduce((a, g) => a + (g.next ? g.next.tong : 0), 0))} đ</div><div class="nc-s">Lãi đang tính đến hôm nay: ${fmt(sum('accrued'))} đ</div></div></div>`;

  // 2) Tổng quan nợ: tổng / đã trả / còn lại, tách ô tô - nhà, gốc - lãi
  const card = (title, color, d, extra) => `<div class="debt-card" style="--gc:${color}">
      <div class="dc-h"><h3>${esc(title)}</h3><span class="dc-du">Dư nợ hiện tại <b>${fmt(d.duNo)} đ</b></span></div>
      <div class="dc-bar"><i style="width:${pct(d.paidG, d.totG)}%"></i></div><div class="muted dc-p">Đã trả ${pct(d.paidG, d.totG)}% gốc (${fmt(d.paidG)} / ${fmt(d.totG)})</div>
      <div class="dc-grid"><div class="dc-col"><h4>Tổng phải trả</h4>${cell(d.totG, d.totL)}</div>
        <div class="dc-col ok"><h4>Đã trả đến ${fmtD(today)}</h4>${cell(d.paidG, d.paidL)}</div>
        <div class="dc-col rem"><h4>Còn phải trả</h4>${cell(d.remG, d.remL)}</div></div>${extra || ''}</div>`;
  html += `<h2 class="sec-title">Tổng quan nợ</h2>` + gs.map(g => card(g.name, g.color, g,
    `<p class="muted dc-note">${g.daoHan && !g.openEnded ? 'Đáo hạn ' + fmtD(g.daoHan) + '. ' : ''}${g.openEnded ? `Khoản vay đang dùng chưa có ngày đáo hạn: lãi còn phải trả tạm tính đến ${fmtD(g.lastDate)} (24 tháng tới), gốc ${fmt(g.remG)} trả khi đáo hạn hoặc đảo nợ. ` : ''}${g.ctx.length > 1 ? `Gồm ${g.ctx.length} khoản vay nối tiếp (đảo nợ), gốc đảo nợ không tính là tiền bỏ ra.` : ''}</p>`)).join('')
    + card('Tổng ô tô + nhà', 'var(--ac)', T, open ? '<p class="muted dc-note">Lãi còn phải trả của khoản vay chưa có ngày đáo hạn là số tạm tính.</p>' : '');

  // 3) Mốc quan trọng
  const ms = debtMilestones(gs);
  if (ms.length) html += `<h2 class="sec-title">Mốc sắp tới</h2><div class="card ms"><ul>${ms.map(m => `<li style="--gc:${m.g.color}"><span class="ms-d"><b>${fmtD(m.d)}</b><small>${fmtLeft(m.d)}</small></span><span class="ms-t"><span class="ms-g">${esc(m.g.short)}</span>${m.t}</span></li>`).join('')}</ul></div>`;

  // 4) Theo năm
  const years = [...new Set(gs.flatMap(g => g.rows.map(r => r.thang.slice(0, 4))))].sort();
  const thisY = today.slice(0, 4);
  if (!debtYear || !years.includes(debtYear)) debtYear = years.includes(thisY) ? thisY : years[years.length - 1];
  const noPlan = (g, y) => g.openEnded && g.lastDate && y > g.lastDate.slice(0, 4);   // khoản chưa có ngày đáo hạn: chỉ có lịch 24 tháng tới
  const yData = years.map(y => ({ y, v: gs.map(g => g.rows.filter(r => r.thang.startsWith(y)).reduce((a, r) => ({ g: a.g + r.cash, l: a.l + r.lai }), { g: 0, l: 0 })) }));
  const yList = `<div class="ylist">${yData.map(({ y, v }) => {
    const tot = v.reduce((a, x) => a + x.g + x.l, 0), st = y < thisY ? 'Đã trả' : y > thisY ? 'Dự kiến' : 'Đang trả';
    return `<button type="button" class="yi${y === debtYear ? ' on' : ''}${y < thisY ? ' past' : ''}" data-y="${y}"><span class="yi-h"><b>${y}</b><small>${st}</small><b class="yi-t">${fmt(tot)}</b></span>
      ${gs.map((g, j) => noPlan(g, y) ? `<span class="yi-r" style="--gc:${g.color}"><i></i>${esc(g.short)}<span class="np">chưa có lịch (chưa biết ngày đáo hạn)</span></span>`
        : `<span class="yi-r" style="--gc:${g.color}"><i></i>${esc(g.short)}<span>gốc <b>${fmt(v[j].g)}</b></span><span>lãi <b>${fmt(v[j].l)}</b></span></span>`).join('')}</button>`;
  }).join('')}</div>`;
  const yRows = years.map(y => {
    const v = gs.map(g => g.rows.filter(r => r.thang.startsWith(y)).reduce((a, r) => ({ g: a.g + r.cash, l: a.l + r.lai }), { g: 0, l: 0 }));
    const tot = v.reduce((a, x) => a + x.g + x.l, 0), st = y < thisY ? 'Đã trả' : y > thisY ? 'Dự kiến' : 'Đang trả';
    return `<tr class="${y === debtYear ? 'next' : y < thisY ? 'past' : ''}" data-y="${y}"><td><b>${y}</b></td>${v.map((x, j) => noPlan(gs[j], y) ? '<td colspan="2"><small>chưa có lịch</small></td>' : `<td>${fmt(x.g)}</td><td>${fmt(x.l)}</td>`).join('')}<td><b>${fmt(tot)}</b></td><td>${st}</td></tr>`;
  }).join('');
  html += `<h2 class="sec-title">Phải trả theo năm</h2><p class="muted">Bấm vào một năm để xem chi tiết từng kỳ bên dưới. Gốc là tiền thật bỏ ra (không gồm gốc đảo nợ).</p>
    ${yList}<div class="tablewrap ydesk"><table class="tbl clickable" id="debt-years"><tr><th>Năm</th>${gs.map(g => `<th>${esc(g.short)} gốc</th><th>${esc(g.short)} lãi</th>`).join('')}<th>Tổng</th><th>Trạng thái</th></tr>${yRows}
    <tr class="total"><td>Cộng</td>${gs.map(g => `<td>${fmt(g.rows.reduce((a, r) => a + r.cash, 0))}</td><td>${fmt(g.rows.reduce((a, r) => a + r.lai, 0))}</td>`).join('')}<td>${fmt(gs.reduce((a, g) => a + g.rows.reduce((b, r) => b + r.cash + r.lai, 0), 0))}</td><td></td></tr></table></div>`;

  // 5) Từng kỳ trong năm
  const months = Array.from({ length: 12 }, (_, i) => debtYear + '-' + String(i + 1).padStart(2, '0'));
  let cum = 0;
  const mRows = months.map(mm => {
    const parts = gs.map(g => g.rows.filter(r => r.thang === mm));
    if (!parts.some(p => p.length)) return '';
    const tot = parts.flat().reduce((a, r) => a + r.cash + r.lai, 0); cum += tot;
    const done = parts.flat().every(r => r.da_qua), soon = parts.flat().some(r => !r.da_qua && daysTo(r.ngay) <= 31);
    return `<tr class="${done ? 'past' : soon ? 'next' : ''}"><td><b>T${+mm.slice(5)}/${mm.slice(0, 4)}</b></td>${parts.map(p => `<td>${p.length ? p.map(r => `<b>${fmt(r.cash + r.lai)}</b><small>${dmy(r.ngay)} · gốc ${fmt(r.cash)} · lãi ${fmt(r.lai)} (${rowRates(r)})${r.dao_no ? ' · đảo nợ ' + fmt(r.goc) : ''}</small>`).join('') : '–'}</td>`).join('')}
      <td><b>${fmt(tot)}</b></td><td>${fmt(cum)}</td><td>${done ? 'Đã trả' : 'Dự kiến'}</td></tr>`;
  }).join('');
  html += `<div class="sect-h"><h2 class="sec-title" style="margin:0">Từng kỳ năm ${debtYear}</h2><div class="chips yr">${years.map(y => `<button type="button" class="chip${y === debtYear ? ' on' : ''}" data-dy="${y}">${y}</button>`).join('')}</div></div>
    <div class="tablewrap"><table class="tbl rsp debt-months"><tr><th>Tháng</th>${gs.map(g => `<th>${esc(g.short)}</th>`).join('')}<th>Tổng tháng</th><th>Lũy kế năm</th><th>Trạng thái</th></tr>${mRows}</table></div>`;
  el.innerHTML = html;
  if (anim(el, gs.map(g => [g.duNo, g.paidG, g.totG, g.next ? g.next.tong : 0].join(',')).join('|') + today)) countUp(el);
  el.querySelectorAll('.next-card, .debt-card').forEach((c, i) => c.style.setProperty('--i', i));
}

/* ---------- so sánh các năm ---------- */
function renderCompare() {
  const p = $('#th-nguoi').value, hm = $('#cmp-hm').value;
  const rs = records().filter(r => (!p || r.nguoi === p) && (!hm || r.hangmuc === hm));
  const years = [...new Set(rs.map(r => r.thang.slice(0, 4)))].sort();
  if (!years.length) { $('#cmp-table').innerHTML = '<tr><td>Chưa có dữ liệu</td></tr>'; return; }
  const sum = {};
  for (const r of rs) sum[r.thang] = (sum[r.thang] || 0) + r.tien;
  const cell = (y, mm) => sum[y + '-' + mm] || 0;
  let html = '<tr><th>Tháng</th>' + years.map(y => `<th>${y}</th>`).join('') + '</tr>';
  for (let i = 1; i <= 12; i++) {
    const mm = String(i).padStart(2, '0');
    html += `<tr><td><span class="lg">Tháng&nbsp;</span><span class="sm">T</span>${i}</td>` + years.map((y, j) => {
      const v = cell(y, mm), prev = j ? cell(years[j - 1], mm) : 0;
      const cls = j && v && prev ? (v > prev ? 'up' : 'down') : '';
      const pct = j && v && prev ? ` <small>${v > prev ? '+' : ''}${Math.round((v - prev) / prev * 100)}%</small>` : '';
      return `<td class="${cls}">${v ? fmt(v) : '–'}${pct}</td>`;
    }).join('') + '</tr>';
  }
  const ytot = y => rs.filter(r => r.thang.startsWith(y)).reduce((a, r) => a + r.tien, 0);
  const ymon = y => new Set(rs.filter(r => r.thang.startsWith(y)).map(r => r.thang)).size || 1;
  html += '<tr class="total"><td>Cả năm</td>' + years.map(y => `<td>${fmt(ytot(y))}</td>`).join('') + '</tr>';
  html += '<tr class="total"><td>Bình quân /tháng</td>' + years.map(y => `<td>${fmt(ytot(y) / ymon(y))}</td>`).join('') + '</tr>';
  html += '<tr><td>Số tháng có dữ liệu</td>' + years.map(y => `<td>${ymon(y)}</td>`).join('') + '</tr>';
  $('#cmp-table').innerHTML = html;
}

/* ---------- ngân sách ---------- */
function renderBudgetForm() {
  if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#budgetForm')) return;
  const b = conf().budgets || {};
  $('#budgetForm').innerHTML = catsAll().filter(c => c !== 'Chưa rõ').map(c =>
    `<label class="fld bud"><span><i style="background:${catCol(c)}"></i>${esc(c)}</span><input data-cat="${esc(c)}" data-money inputmode="numeric" placeholder="—" value="${b[c] ? fmt(b[c]) : ''}" aria-label="Ngân sách ${esc(c)}"><small class="err"></small></label>`).join('');
  const n = Object.values(b).filter(Boolean).length;
  $('#budgetSub').textContent = n ? `Đã đặt ${n} hạng mục · tổng ${fmt(Object.values(b).reduce((a, x) => a + (+x || 0), 0))} đ/tháng` : 'Chưa đặt hạng mục nào';
  const bc = $('#budgetColl'); if (bc) bc.classList.toggle('open', collOpen.has('budget'));
}
function saveBudgets() {
  const out = {}, E = [];
  document.querySelectorAll('#budgetForm input').forEach(i => {
    const n = V.money(i.value); if (!n) return;
    if (n < 1000) E.push([i, 'Tối thiểu 1.000 đ']); else if (n > 1e9) E.push([i, 'Quá lớn, kiểm tra lại số 0']); else out[i.dataset.cat] = n;
  });
  if (!vShow($('#budgetForm'), E)) return;
  setConf('budgets', out); toast('Đã lưu ngân sách ' + Object.keys(out).length + ' hạng mục', 'ok');
}

/* ---------- thành viên & hạng mục thêm ---------- */
function renderCatalog() {
  if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#catalogColl')) return;
  const c = conf(), ppl = people().filter(x => x !== 'Chung'), extra = c.cats_extra || [];
  $('#cfg-people').value = ppl.join(', ');
  $('#cfg-cats').value = extra.join(', ');
  $('#catalogSub').textContent = `${ppl.length} thành viên + Chung · ${extra.length ? extra.length + ' hạng mục thêm' : 'chưa thêm hạng mục'}`;
  $('#catalogColl').classList.toggle('open', collOpen.has('catalog'));
}
function saveCatalog() {
  const split = v => [...new Set(v.split(/[,;\n]/).map(x => x.trim().replace(/\s+/g, ' ')).filter(Boolean))];
  const pi = $('#cfg-people'), ci = $('#cfg-cats'), ppl = split(pi.value).filter(x => x.toLowerCase() !== 'chung'), cats = split(ci.value), E = [];
  const used = f => records().filter(f).length;
  const dupOf = arr => arr.filter((x, i) => arr.findIndex(y => fold(y) === fold(x)) !== i);
  if (!ppl.length) E.push([pi, 'Cần ít nhất 1 thành viên']);
  else if (dupOf(ppl).length) E.push([pi, 'Trùng tên: ' + dupOf(ppl).join(', ')]);
  else if (ppl.some(x => !/^[\p{L}\d][\p{L}\d .'-]*$/u.test(x))) E.push([pi, 'Tên chỉ gồm chữ, số, khoảng trắng']);
  else if (ppl.some(x => x.length > 20)) E.push([pi, 'Mỗi tên tối đa 20 ký tự']);
  else if (ppl.length > 12) E.push([pi, 'Tối đa 12 thành viên']);
  else { const lost = people().filter(x => x !== 'Chung' && !ppl.includes(x) && used(r => r.nguoi === x)); if (lost.length) E.push([pi, `Không bỏ được ${lost.join(', ')} vì đã có khoản chi (${lost.map(x => fmt(used(r => r.nguoi === x))).join(', ')} khoản)`]); }
  const dup = cats.filter(x => CATS.some(c => fold(c) === fold(x)));
  if (dup.length) E.push([ci, 'Trùng hạng mục có sẵn: ' + dup.join(', ')]);
  else if (dupOf(cats).length) E.push([ci, 'Trùng tên: ' + dupOf(cats).join(', ')]);
  else if (cats.length > 20) E.push([ci, 'Tối đa 20 hạng mục thêm']);
  else if (cats.some(x => x.length > 50)) E.push([ci, 'Mỗi hạng mục tối đa 50 ký tự']);
  else { const lost = (conf().cats_extra || []).filter(x => !cats.includes(x) && used(r => r.hangmuc === x)); if (lost.length) E.push([ci, 'Không bỏ được ' + lost.join(', ') + ' vì đang có khoản chi thuộc hạng mục này']); }
  if (!vShow($('#catalogColl'), E)) return;
  setConf('people', ppl); setConf('cats_extra', cats); rebuildCatOptions();
  toast('Đã lưu ' + ppl.length + ' thành viên và ' + cats.length + ' hạng mục thêm', 'ok');
}
/** dựng lại danh sách hạng mục trong các ô chọn khi cấu hình thay đổi */
let catSig = '';
function rebuildCatOptions() {
  const cats = catsAll(), sig = cats.join('|'); if (sig === catSig) return; catSig = sig;
  const opts = cats.map(c => `<option>${esc(c)}</option>`).join('');
  const keep = (q, first) => { const el = $(q), v = el.value; el.innerHTML = (first || '') + opts; el.value = [...el.options].some(o => o.value === v) ? v : (first ? '' : 'Chưa rõ'); };
  keep('#f-hangmuc'); keep('#ds-hangmuc', '<option value="">Tất cả hạng mục</option>'); keep('#cmp-hm', '<option value="">Tất cả hạng mục</option>');
}

/* ---------- điều hướng ---------- */
const TITLES = { 'tab-nhap': 'Nhập chi tiêu', 'tab-ds': 'Danh sách chi tiêu', 'tab-th': 'Tổng hợp', 'tab-vay': 'Khoản vay', 'tab-cd': 'Cài đặt' };
function showTab(id) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === id));
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
  $('#pageTitle').textContent = TITLES[id] || '';
  animSig.clear(); renderAll(); window.scrollTo({ top: 0 });
}
function labelTables() {
  document.querySelectorAll('table.rsp:not([data-l])').forEach(t => {
    const hs = [...t.querySelectorAll('tr:first-child th')].map(th => th.textContent.trim());
    t.querySelectorAll('tr').forEach(tr => { let i = 0; tr.querySelectorAll('td').forEach(td => { td.dataset.l = hs[i] || ''; i += td.colSpan || 1; }); });
    t.dataset.l = 1;
  });
}
function renderAll() {
  const active = document.querySelector('.tab.active').id;
  if (document.activeElement && document.activeElement.matches && document.activeElement.matches('.modal input, .modal select')) { $('#pendingCount').textContent = state.pending.length; return; }
  if (active === 'tab-nhap') {
    state.form.nguois = state.form.nguois.filter(p => people().includes(p));
    renderFormChips(); renderToday(); renderAlerts();
  }
  if (active === 'tab-vay') renderLoans();
  rebuildCatOptions();
  if (active === 'tab-cd') { renderBudgetForm(); renderCatalog(); $('#cfg-ghiso').checked = conf().ghi_so !== false; }
  if (active === 'tab-ds') renderList();
  if (active === 'tab-th') {
    document.querySelectorAll('#th-view button').forEach(x => x.classList.toggle('on', x.dataset.v === thView));
    $('#th-ct').hidden = thView !== 'ct'; $('#th-no').hidden = thView !== 'no';
    if (thView === 'no') renderDebtView(); else renderSummary();
  }
  $('#pendingCount').textContent = state.pending.length;
  const sb = $('#syncBtn'), np = state.pending.length;
  sb.dataset.n = np ? (np > 99 ? '99+' : np) : ''; sb.title = np ? `Còn ${np} thay đổi chưa gửi lên Google Sheet. Bấm để gửi` : 'Đồng bộ với Google Sheet';
  labelTables();
  const names = [...new Set(records().map(r => r.ten))].sort((a, b) => a.localeCompare(b, 'vi'));
  if ($('#names').childElementCount !== names.length) $('#names').innerHTML = names.map(n => `<option value="${esc(n)}">`).join('');
}

/** Biến <select> thành ô chọn đồng nhất trên mọi thiết bị (giữ select gốc để code dùng .value / change).
 *  opts.title: tiêu đề khung chọn; opts.clear: giá trị khi bấm × (bỏ chọn); opts.onClear: hàm riêng khi bấm × */
const fold = t => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
function comboSelect(sel, opts = {}) {
  const wrap = document.createElement('div'); wrap.className = 'combo';
  sel.parentNode.insertBefore(wrap, sel); wrap.appendChild(sel); sel.classList.add('combo-src'); sel.tabIndex = -1;
  const canClear = opts.clear !== undefined || !!opts.onClear;
  wrap.insertAdjacentHTML('beforeend', `<button type="button" class="combo-btn" aria-haspopup="listbox" aria-expanded="false"><span></span><svg class="ic"><use href="#i-down"/></svg></button>
    ${canClear ? '<button type="button" class="combo-clr" aria-label="Bỏ chọn" title="Bỏ chọn" hidden><svg class="ic"><use href="#i-x"/></svg></button>' : ''}
    <div class="combo-bg" hidden></div><div class="combo-pop" hidden role="listbox"><div class="combo-head">${esc(opts.title || 'Chọn')}<button type="button" class="combo-x" aria-label="Đóng"><svg class="ic"><use href="#i-x"/></svg></button></div>
    <label class="search"><svg class="ic"><use href="#i-search"/></svg><input type="search" placeholder="Tìm…" autocomplete="off"></label><ul></ul></div>`);
  const bg = wrap.querySelector('.combo-bg'), clr = wrap.querySelector('.combo-clr');
  bg.onclick = () => close(); wrap.querySelector('.combo-x').onclick = () => close();
  const sheet = () => matchMedia('(max-width: 640px)').matches;          // điện thoại: khung trượt từ dưới lên
  const touch = matchMedia('(pointer: coarse)').matches;                  // màn cảm ứng: không tự bật bàn phím
  const btn = wrap.querySelector('.combo-btn'), pop = wrap.querySelector('.combo-pop'), q = pop.querySelector('input'), ul = pop.querySelector('ul');
  const isDefault = () => (opts.onClear ? !!opts.isDefault?.() : sel.value === opts.clear);
  const refresh = () => {
    const o = sel.options[sel.selectedIndex]; btn.firstElementChild.textContent = o ? o.text : '';
    if (clr) { clr.hidden = isDefault(); wrap.classList.toggle('has-clr', !clr.hidden); }
  };
  const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(sel, 'value', { get() { return d.get.call(this); }, set(v) { d.set.call(this, v); refresh(); } });
  new MutationObserver(refresh).observe(sel, { childList: true });
  let hi = 0;
  const list = () => {
    const f = fold(q.value.trim()), all = [...sel.options], opt = all.filter(o => !f || fold(o.text).includes(f));
    pop.querySelector('.search').hidden = all.length <= 15;   // danh sách ngắn (≤ 15) thì không cần ô tìm
    hi = Math.min(hi, Math.max(0, opt.length - 1));
    ul.innerHTML = opt.map((o, i) => `<li role="option" data-v="${esc(o.value)}" aria-selected="${o.value === sel.value}" class="${o.value === sel.value ? 'sel' : ''}${i === hi ? ' hi' : ''}">${o.value && (CATS.includes(o.value) || (conf().cats_extra || []).includes(o.value)) ? `<i style="--cc:${catCol(o.value)}"></i>` : ''}${esc(o.text)}${o.value === sel.value ? '<svg class="ic"><use href="#i-check"/></svg>' : ''}</li>`).join('') || '<li class="none">Không có lựa chọn phù hợp</li>';
  };
  const close = () => { if (pop.hidden) return; pop.hidden = true; bg.hidden = true; wrap.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); document.body.classList.remove('combo-lock'); };
  const pick = v => { if (v == null) return; sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })); close(); btn.focus({ preventScroll: true }); };
  if (clr) clr.onclick = e => { e.preventDefault(); e.stopPropagation(); close(); if (opts.onClear) { opts.onClear(); refresh(); } else pick(opts.clear); };
  btn.onclick = () => { if (!pop.hidden) return close(); document.querySelectorAll('.combo.open').forEach(w => w !== wrap && w.querySelector('.combo-btn').click());
    pop.hidden = false; wrap.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); q.value = ''; hi = Math.max(0, sel.selectedIndex); list();
    pop.classList.remove('right');
    if (sheet()) { bg.hidden = false; document.body.classList.add('combo-lock'); }
    else if (pop.getBoundingClientRect().right > document.documentElement.clientWidth - 8) pop.classList.add('right');   // không tràn mép phải
    if (!touch && !pop.querySelector('.search').hidden) q.focus({ preventScroll: true });
    const s2 = ul.querySelector('.sel'); if (s2) ul.scrollTop = s2.offsetTop - ul.clientHeight / 2;   // cuộn trong danh sách, không kéo cả trang
  };
  btn.onkeydown = e => { if (e.key === 'ArrowDown' && pop.hidden) { e.preventDefault(); btn.click(); } };
  q.oninput = () => { hi = 0; list(); };
  const keys = e => {
    const n = ul.querySelectorAll('li[data-v]').length;
    if (e.key === 'ArrowDown') { hi = Math.min(n - 1, hi + 1); list(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { hi = Math.max(0, hi - 1); list(); e.preventDefault(); }
    else if (e.key === 'Enter') { const li = ul.querySelectorAll('li[data-v]')[hi]; if (li) pick(li.dataset.v); e.preventDefault(); }
    else if (e.key === 'Escape') { close(); btn.focus(); }
  };
  q.onkeydown = keys; pop.addEventListener('keydown', e => { if (e.target !== q) keys(e); });
  ul.onclick = e => { const li = e.target.closest('li[data-v]'); if (li) pick(li.dataset.v); };
  document.addEventListener('click', e => { if (!wrap.contains(e.target)) close(); });
  sel.addEventListener('change', refresh);
  refresh();
  return { refresh };
}
function toggleTheme() {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('cthn.theme', next); } catch (e) {}
  const mt = document.querySelector('meta[name=theme-color]'); if (mt) mt.content = next === 'light' ? '#f3f5fb' : '#0b1020';
  themeIcon();
}
function themeIcon() {
  const dark = (document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')) === 'dark';
  $('#themeBtn use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
  $('#themeBtn').title = dark ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối';
}
function init() {
  rebuildCatOptions();
  $('#appVer').textContent = APP_VERSION;
  $('#quickAmt').innerHTML = QUICK_AMT.map(v => `<button type="button" data-v="${v}">${v >= 1e6 ? v / 1e6 + 'tr' : v / 1000 + 'k'}</button>`).join('');
  $('#quickAmt').onclick = e => { const b = e.target.closest('button'); if (b) $('#f-tien').value = fmt(+b.dataset.v); };
  $('#quickNames').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    $('#f-ten').value = b.dataset.n; state.form.catTouched = false; autoCategory();
    const a = lastAmountFor(b.dataset.n, formNguoi()); if (a && !$('#f-tien').value) $('#f-tien').value = fmt(a);
  };
  $('#f-tien').addEventListener('input', e => { const n = parseInt(e.target.value.replace(/[^\d]/g, '').slice(0, 10), 10); e.target.value = n ? fmt(n) : ''; updateShare(); });
  $('#f-chia').addEventListener('change', updateShare);
  $('#f-tien').addEventListener('blur', e => { const n = parseAmount(e.target.value); e.target.value = n ? fmt(n) : ''; });
  $('#f-ten').addEventListener('input', autoCategory);
  $('#f-hangmuc').addEventListener('change', () => { state.form.catTouched = true; state.form.catUser = true; autoCategory(); });
  $('#f-ngay').addEventListener('change', renderToday);
  $('#form').addEventListener('submit', onSubmit);
  $('#cancelEdit').onclick = () => { resetForm(true); backFromEdit(); };
  $('#deleteBtn').onclick = onDelete;
  ['#todayList', '#dsList', '#th-top'].forEach(s => $(s).addEventListener('click', e => { const li = e.target.closest('li[data-id]'); if (li) editRecord(li.dataset.id); }));
  ['#ds-thang', '#ds-hangmuc'].forEach(s => $(s).addEventListener('change', renderList));
  $('#ds-people').addEventListener('click', e => { const b = e.target.closest('.pcard'); if (b) { dsPerson = dsPerson === b.dataset.p ? '' : b.dataset.p; renderList(); } });
  $('#ds-clear').onclick = () => { dsPerson = ''; renderList(); };
  $('#ds-view').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { dsView = b.dataset.view; save('cthn.dsview', dsView); renderList(); } });
  $('#dsList').addEventListener('click', e => { const b = e.target.closest('.more'); if (b) { const k = b.dataset.more; dsLimit[k] = (dsLimit[k] || (k === 'ngay' ? 300 : 80)) + 200; renderList(); } });
  document.addEventListener('click', onRateClick);
  document.addEventListener('click', onCollClick);
  document.addEventListener('input', onModalInput);
  document.addEventListener('focusout', onModalBlur);
  $('#th-view').addEventListener('click', e => { const x = e.target.closest('button'); if (x) { thView = x.dataset.v; save('cthn.thview', thView); renderAll(); } });
  $('#th-no').addEventListener('click', e => {
    const y = e.target.closest('[data-dy]') || e.target.closest('#debt-years tr[data-y]') || e.target.closest('.yi[data-y]');
    if (y) { debtYear = y.dataset.dy || y.dataset.y; renderDebtView(); }
  });
  $('#modalX').onclick = closeModal;
  $('#modal').addEventListener('click', e => {
    if (e.target === $('#modal')) return closeModal();
    const b = e.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-rl-cancel')) closeModal();
    if (b.dataset.rlSave) applyRoll(+b.dataset.rlSave, $('#modalBody'));
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
  // gắn nhãn cột cho bảng mỗi khi nội dung thay đổi (bảng xếp dọc trên điện thoại)
  new MutationObserver(() => labelTables()).observe(document.querySelector('main'), { childList: true, subtree: true });
  $('#themeBtn').onclick = toggleTheme;
  $('#ds-tim').addEventListener('input', renderList);
  ['#th-nam', '#th-thang', '#th-nguoi'].forEach(s => $(s).addEventListener('change', renderSummary));
  document.querySelectorAll('.nav button').forEach(b => (b.onclick = () => showTab(b.dataset.tab)));
  $('#syncBtn').onclick = () => sync();
  $('#cfg-url').value = state.cfg.url; $('#cfg-key').value = state.cfg.key;
  $('#cfg-save').onclick = saveConfig;
  $('#seedFile').onchange = e => { if (e.target.files[0]) importSeed(e.target.files[0]); e.target.value = ''; };
  $('#exportBtn').onclick = exportCsv;
  $('#reloadBtn').onclick = () => sync();
  $('#budgetSave').onclick = saveBudgets;
  $('#cfg-ghiso').onchange = e => { setConf('ghi_so', e.target.checked); toast(e.target.checked ? 'Đã bật tự ghi vào sổ tháng' : 'Đã tắt tự ghi vào sổ tháng', 'ok'); };
  $('#ghiBuBtn').onclick = ghiBu;
  $('#tgTest').onclick = async () => { try { await apiPost({ action: 'testTelegram' }); toast('Đã gửi tin nhắn thử qua Telegram', 'ok'); } catch (e) { toast(e.message, 'err'); } };
  $('#loanAdd').onclick = () => openLoanEditor(null);
  // ô chọn đồng nhất; × để bỏ chọn
  comboSelect($('#f-hangmuc'), { title: 'Chọn hạng mục', isDefault: () => !state.form.catTouched,
    onClear: () => { state.form.catTouched = false; state.form.catUser = false; autoCategory(); } });
  comboSelect($('#ds-thang'), { title: 'Chọn tháng', clear: '' });
  comboSelect($('#ds-hangmuc'), { title: 'Chọn hạng mục', clear: '' });
  comboSelect($('#th-nam'), { title: 'Chọn năm' });
  comboSelect($('#th-thang'), { title: 'Chọn tháng', clear: '' });
  comboSelect($('#th-nguoi'), { title: 'Chọn người', clear: '' });
  comboSelect($('#cmp-hm'), { title: 'Chọn hạng mục', clear: '' });
  $('#cmp-hm').addEventListener('change', renderCompare);
  $('#th-kpis').addEventListener('click', e => { if (e.target.closest('[data-th-no]')) { thView = 'no'; save('cthn.thview', thView); renderAll(); window.scrollTo({ top: 0 }); } });
  $('#catalogSave').onclick = saveCatalog;
  themeIcon();
  window.addEventListener('online', () => sync(true, true));
  // mở lại app (đang chạy nền) thì lấy dữ liệu mới từ máy khác
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.cfg.url && Date.now() - lastPull > 60000) sync(true, true); });
  resetForm();
  renderAll();
  if (!state.cfg.url) showTab('tab-cd'); else sync(true);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
document.addEventListener('DOMContentLoaded', init);
