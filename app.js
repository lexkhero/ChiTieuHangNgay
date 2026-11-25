'use strict';
/* ChiTieuHangNgay – PWA nhập & tổng hợp chi tiêu, đồng bộ với Google Sheet qua Apps Script */

const PEOPLE = ['Chồng', 'Vợ', 'Jun', 'Putin', 'Út', 'Chung'];
const KINDS = ['Sinh hoạt', 'Phát sinh', 'Chung'];
const QUICK_AMT = [10000, 20000, 25000, 30000, 40000, 50000, 100000, 200000, 500000];
const LS = { cfg: 'cthn.cfg', recs: 'cthn.records', map: 'cthn.map', pend: 'cthn.pending', last: 'cthn.last' };

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
  pending: load(LS.pend, []),      // thao tác chưa gửi: {op:'upsert',rec} | {op:'delete',id} | {op:'map',item}
  last: load(LS.last, { nguoi: 'Chồng', loai: 'Sinh hoạt' }),
  form: { nguoi: null, loai: null, catTouched: false, autoCat: '' },
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

let syncing = false;
async function sync(silent) {
  if (!state.cfg.url || !state.cfg.key) { if (!silent) toast('Chưa cấu hình Google Sheet (tab Cài đặt)', 'err'); return; }
  if (syncing) return;
  syncing = true; $('#syncBtn').classList.add('spin');
  try {
    await flushPending();
    const j = await apiGet({ action: 'list' });
    state.server = j.records.map(r => ({ ...r, id: String(r.id), tien: Number(r.tien) || 0 }));
    state.userMap = {};
    (j.phanloai || []).forEach(m => { if (m.ten) state.userMap[normName(m.ten)] = m.hangmuc; });
    save(LS.recs, state.server); save(LS.map, state.userMap);
    if (!silent) toast('Đã đồng bộ ' + fmt(state.server.length) + ' khoản', 'ok');
  } catch (e) {
    if (!silent) toast('Chưa đồng bộ được: ' + e.message + '. Dữ liệu vẫn lưu trên máy.', 'err');
  } finally {
    syncing = false; $('#syncBtn').classList.remove('spin'); renderAll();
    if (state.pending.length && navigator.onLine) setTimeout(() => sync(true), 1500);
  }
}
async function flushPending() {
  if (!state.pending.length) return;
  const snap = state.pending.slice();
  const ups = [], dels = [], maps = [];
  for (const p of snap) {
    if (p.op === 'upsert') ups.push(p.rec);
    else if (p.op === 'delete') dels.push(p.id);
    else if (p.op === 'map') maps.push(p.item);
  }
  const lastUp = new Map(ups.map(r => [r.id, r]));
  if (lastUp.size) await apiPost({ action: 'upsert', records: [...lastUp.values()] });
  if (dels.length) await apiPost({ action: 'delete', ids: dels });
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
function setPerson(p) {
  state.form.nguoi = p;
  if (p === 'Chung') state.form.loai = 'Chung';
  else if (state.form.loai === 'Chung') state.form.loai = 'Phát sinh';
  renderFormChips(); autoCategory(); renderQuickNames();
}
function setKind(k) { state.form.loai = k; if (k === 'Chung') state.form.nguoi = 'Chung'; renderFormChips(); autoCategory(); }
function renderFormChips() {
  chips($('#f-nguoi'), PEOPLE, state.form.nguoi, setPerson);
  chips($('#f-loai'), KINDS, state.form.loai, setKind);
}
function parseAmount(s) {
  let n = parseInt(String(s).replace(/[^\d]/g, ''), 10) || 0;
  if (n > 0 && n < 1000) n *= 1000; // gõ "30" = 30.000 đ
  return n;
}
function autoCategory() {
  const name = $('#f-ten').value;
  const c = classify(name, state.form.nguoi, state.userMap);
  state.form.autoCat = c;
  if (!state.form.catTouched) $('#f-hangmuc').value = c;
  $('#catHint').textContent = name ? (state.form.catTouched && $('#f-hangmuc').value !== c ? '(đã chọn tay, gợi ý: ' + c + ')' : '(tự động)') : '';
}
function renderQuickNames() {
  const p = state.form.nguoi;
  const cnt = new Map();
  for (const r of records()) if (r.nguoi === p) cnt.set(r.ten, (cnt.get(r.ten) || 0) + 1);
  const top = [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(x => x[0]);
  $('#quickNames').innerHTML = top.map(n => `<button type="button" data-n="${esc(n)}">${esc(n)}</button>`).join('');
}
function lastAmountFor(name, person) {
  const rs = records().filter(r => r.ten === name && r.nguoi === person && r.ngay).sort((a, b) => (b.ngay > a.ngay ? 1 : -1));
  return rs[0] ? rs[0].tien : 0;
}
function resetForm(keepDate) {
  $('#f-id').value = ''; $('#f-ten').value = ''; $('#f-tien').value = ''; $('#f-ghichu').value = '';
  if (!keepDate) $('#f-ngay').value = todayStr();
  state.form.nguoi = state.last.nguoi; state.form.loai = state.last.loai; state.form.catTouched = false;
  $('#saveBtn').textContent = 'Lưu khoản chi'; $('#cancelEdit').hidden = true; $('#deleteBtn').hidden = true;
  renderFormChips(); autoCategory(); renderQuickNames();
}
function editRecord(id) {
  const r = records().find(x => x.id === id); if (!r) return;
  showTab('tab-nhap');
  $('#f-id').value = r.id; $('#f-ngay').value = r.ngay || (r.thang + '-01'); $('#f-tien').value = fmt(r.tien);
  $('#f-ten').value = r.ten; $('#f-ghichu').value = r.ghichu || '';
  state.form.nguoi = r.nguoi; state.form.loai = r.loai; state.form.catTouched = true;
  renderFormChips(); $('#f-hangmuc').value = r.hangmuc; autoCategory();
  $('#saveBtn').textContent = 'Cập nhật'; $('#cancelEdit').hidden = false; $('#deleteBtn').hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function onSubmit(e) {
  e.preventDefault();
  const id = $('#f-id').value || newId();
  const old = records().find(x => x.id === id);
  const ngay = $('#f-ngay').value;
  const tien = parseAmount($('#f-tien').value);
  const ten = $('#f-ten').value.trim().replace(/\s+/g, ' ');
  if (!ten || !tien) { toast('Cần nhập khoản chi và số tiền', 'err'); return; }
  const hangmuc = $('#f-hangmuc').value;
  const rec = { id, ngay: old && !old.ngay && ngay === old.thang + '-01' ? '' : ngay,
    thang: ngay.slice(0, 7), nguoi: state.form.nguoi, loai: state.form.loai, ten, tien, hangmuc,
    ghichu: $('#f-ghichu').value.trim(), nguon: old ? old.nguon : 'app' };
  // Chọn tay hạng mục khác gợi ý -> ghi nhớ cho tên này (trừ quy tắc cháo của Putin/Út)
  const auto = classify(ten, rec.nguoi, state.userMap);
  if (hangmuc !== auto && !(['Putin', 'Út'].includes(rec.nguoi) && normName(ten).startsWith('cháo'))) {
    state.userMap[normName(ten)] = hangmuc; save(LS.map, state.userMap);
    state.pending.push({ op: 'map', item: { ten: normName(ten), hangmuc } });
  }
  state.last = { nguoi: rec.nguoi, loai: rec.loai }; save(LS.last, state.last);
  queue({ op: 'upsert', rec });
  toast((old ? 'Đã cập nhật: ' : 'Đã lưu: ') + ten + ' ' + fmt(tien) + ' đ', 'ok');
  resetForm(true);
}
function onDelete() {
  const id = $('#f-id').value; if (!id) return;
  const r = records().find(x => x.id === id);
  if (!confirm('Xóa khoản "' + r.ten + '" ' + fmt(r.tien) + ' đ?')) return;
  queue({ op: 'delete', id });
  resetForm(true);
}

/* ---------- danh sách ---------- */
function itemHtml(r, pend) {
  const meta = [r.nguoi, r.loai !== 'Chung' ? r.loai : '', r.hangmuc].filter(Boolean).join(' · ');
  return `<li data-id="${esc(r.id)}"><span class="t">${esc(r.ten)}</span><span class="a">${fmt(r.tien)}</span>
    <span class="m">${esc(meta)}${r.ghichu ? ' · ' + esc(r.ghichu) : ''}</span>${pend.has(r.id) ? '<span class="pend">chờ gửi</span>' : '<span></span>'}</li>`;
}
function renderToday() {
  const t = $('#f-ngay').value || todayStr();
  const rs = records().filter(r => r.ngay === t);
  const pend = pendingIds();
  $('#todayTotal').textContent = fmt(rs.reduce((s, r) => s + r.tien, 0)) + ' đ';
  $('#todayList').innerHTML = rs.length ? rs.map(r => itemHtml(r, pend)).join('') : '<li><span class="m">Chưa có khoản chi nào trong ngày này</span></li>';
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
function renderList() {
  fillSelect($('#ds-thang'), [['', 'Tất cả tháng'], ...monthsAvailable().map(m => [m, monthLabel(m)])]);
  if (!$('#ds-thang').dataset.init) { $('#ds-thang').value = todayStr().slice(0, 7); $('#ds-thang').dataset.init = 1; }
  const th = $('#ds-thang').value, ng = $('#ds-nguoi').value, hm = $('#ds-hangmuc').value, q = normName($('#ds-tim').value);
  const rs = records().filter(r => (!th || r.thang === th) && (!ng || r.nguoi === ng) && (!hm || r.hangmuc === hm) && (!q || normName(r.ten).includes(q)))
    .sort((a, b) => (b.ngay || b.thang).localeCompare(a.ngay || a.thang) || (a.id < b.id ? 1 : -1));
  $('#ds-tong').textContent = fmt(rs.reduce((s, r) => s + r.tien, 0)) + ' đ';
  $('#ds-dem').textContent = fmt(rs.length);
  const pend = pendingIds();
  let html = '', curKey = null;
  const groups = new Map();
  for (const r of rs) { const k = r.ngay || r.thang; groups.set(k, (groups.get(k) || 0) + r.tien); }
  for (const r of rs.slice(0, 600)) {
    const k = r.ngay || r.thang;
    if (k !== curKey) {
      curKey = k;
      const lbl = r.ngay ? new Date(r.ngay + 'T00:00').toLocaleDateString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' })
        : monthLabel(r.thang) + ' (dữ liệu sổ cũ, không có ngày)';
      html += `<li class="dayrow">${esc(lbl)}<b>${fmt(groups.get(k))}</b></li>`;
    }
    html += itemHtml(r, pend);
  }
  if (rs.length > 600) html += `<li><span class="m">… còn ${fmt(rs.length - 600)} khoản, hãy lọc thêm</span></li>`;
  $('#dsList').innerHTML = html || '<li><span class="m">Không có khoản chi phù hợp</span></li>';
}

/* ---------- tổng hợp ---------- */
function bars(el, rows, total, onClick) {
  const max = Math.max(1, ...rows.map(r => r[1]));
  el.innerHTML = rows.length ? rows.map(([k, v, extra]) => `<div class="bar" data-k="${esc(k)}"><div class="h"><span>${esc(k)}</span>
    <span><b>${fmt(v)}</b> <small>${total ? (v / total * 100).toFixed(1) + '%' : ''}${extra ? ' · ' + extra : ''}</small></span></div>
    <div class="track"><div class="fill" style="width:${(v / max * 100).toFixed(1)}%"></div></div></div>`).join('')
    : '<p class="muted">Chưa có dữ liệu</p>';
  el.onclick = e => { const b = e.target.closest('.bar'); if (b && onClick) onClick(b.dataset.k); };
}
function groupSum(rs, key) {
  const m = new Map();
  for (const r of rs) { const k = typeof key === 'function' ? key(r) : r[key]; const g = m.get(k) || [0, 0]; g[0] += r.tien; g[1]++; m.set(k, g); }
  return m;
}
function renderSummary() {
  const all = records();
  const years = [...new Set(all.map(r => (r.thang || '').slice(0, 4)).filter(Boolean))]; years.push(todayStr().slice(0, 4));
  fillSelect($('#th-nam'), [...new Set(years)].sort().reverse().map(y => [y, 'Năm ' + y]));
  const y = $('#th-nam').value;
  fillSelect($('#th-thang'), [['', 'Cả năm'], ...Array.from({ length: 12 }, (_, i) => [y + '-' + String(i + 1).padStart(2, '0'), 'Tháng ' + (i + 1)])]);
  const m = $('#th-thang').value, p = $('#th-nguoi').value;
  const rs = all.filter(r => (r.thang || '').startsWith(y) && (!m || r.thang === m) && (!p || r.nguoi === p));
  const total = rs.reduce((s, r) => s + r.tien, 0);
  $('#th-tong').textContent = fmt(total);
  $('#th-dem').textContent = fmt(rs.length);
  if (m) {
    const now = todayStr();
    const dim = new Date(+m.slice(0, 4), +m.slice(5), 0).getDate();
    const days = now.startsWith(m) ? +now.slice(8) : dim;
    $('#th-bq-lbl').textContent = 'Bình quân / ngày'; $('#th-bq').textContent = fmt(total / days);
  } else {
    const months = new Set(rs.map(r => r.thang)).size || 1;
    $('#th-bq-lbl').textContent = 'Bình quân / tháng'; $('#th-bq').textContent = fmt(total / months);
  }
  const goList = (field, val) => {
    $('#ds-thang').value = m || ''; $('#ds-nguoi').value = field === 'nguoi' ? val : p; $('#ds-hangmuc').value = field === 'hangmuc' ? val : '';
    $('#ds-tim').value = ''; showTab('tab-ds');
  };
  bars($('#th-hangmuc'), [...groupSum(rs, 'hangmuc')].map(([k, g]) => [k, g[0], g[1] + ' khoản']).sort((a, b) => b[1] - a[1]), total, k => goList('hangmuc', k));
  bars($('#th-nguoi-bars'), [...groupSum(rs, 'nguoi')].map(([k, g]) => [k, g[0]]).sort((a, b) => PEOPLE.indexOf(a[0]) - PEOPLE.indexOf(b[0])), total, k => goList('nguoi', k));
  if (m) {
    $('#th-thang-title').textContent = 'Theo ngày';
    const g = groupSum(rs.filter(r => r.ngay), 'ngay');
    const noDate = rs.filter(r => !r.ngay).reduce((s, r) => s + r.tien, 0);
    const rows = [...g].map(([k, v]) => [k.slice(8) + '/' + k.slice(5, 7), v[0]]).sort();
    if (noDate) rows.push(['Không có ngày (sổ cũ)', noDate]);
    bars($('#th-thang-bars'), rows, total);
  } else {
    $('#th-thang-title').textContent = 'Theo tháng';
    bars($('#th-thang-bars'), [...groupSum(rs, 'thang')].map(([k, g]) => [monthLabel(k), g[0], g[1] + ' khoản', k]).sort((a, b) => a[3].localeCompare(b[3])), total,
      k => { const mm = [...groupSum(rs, 'thang').keys()].find(x => monthLabel(x) === k); $('#th-thang').value = mm; renderSummary(); });
  }
  const pend = pendingIds();
  $('#th-top').innerHTML = [...rs].sort((a, b) => b.tien - a.tien).slice(0, 10).map(r => itemHtml(r, pend)).join('') || '<li><span class="m">Chưa có dữ liệu</span></li>';
}

/* ---------- cài đặt, nạp dữ liệu, xuất CSV ---------- */
async function saveConfig() {
  state.cfg = { url: $('#cfg-url').value.trim(), key: $('#cfg-key').value };
  save(LS.cfg, state.cfg);
  try { await apiGet({ action: 'ping' }); $('#cfg-info').textContent = 'Kết nối thành công.'; await sync(); }
  catch (e) { $('#cfg-info').textContent = 'Không kết nối được: ' + e.message; }
}
async function importSeed(file) {
  if (!state.cfg.url) { toast('Cấu hình Google Sheet trước', 'err'); return; }
  const data = JSON.parse(await file.text());
  const recs = data.records || [], maps = data.phanloai || [];
  const prog = $('#seedProg'); prog.hidden = false; const bar = prog.firstElementChild;
  const B = 250, steps = Math.ceil(recs.length / B) + Math.ceil(maps.length / B);
  let done = 0;
  try {
    for (let i = 0; i < maps.length; i += B) { await apiPost({ action: 'setMap', items: maps.slice(i, i + B) }); bar.style.width = (++done / steps * 100) + '%'; }
    for (let i = 0; i < recs.length; i += B) { await apiPost({ action: 'upsert', records: recs.slice(i, i + B) }); bar.style.width = (++done / steps * 100) + '%'; }
    toast('Đã nạp ' + fmt(recs.length) + ' khoản và ' + fmt(maps.length) + ' tên phân loại', 'ok');
    await sync(true);
  } catch (e) { toast('Nạp dữ liệu lỗi: ' + e.message + '. Có thể nạp lại, không bị trùng.', 'err'); }
}
function exportCsv() {
  const cols = ['ngay', 'thang', 'nguoi', 'loai', 'ten', 'tien', 'hangmuc', 'ghichu'];
  const lines = [cols.join(',')].concat(records().sort((a, b) => (a.ngay || a.thang).localeCompare(b.ngay || b.thang))
    .map(r => cols.map(c => '"' + String(r[c] ?? '').replace(/"/g, '""') + '"').join(',')));
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'chi-tieu-' + todayStr() + '.csv'; a.click();
}

/* ---------- điều hướng ---------- */
function showTab(id) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === id));
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
  renderAll();
}
function renderAll() {
  const active = document.querySelector('.tab.active').id;
  if (active === 'tab-nhap') renderToday();
  if (active === 'tab-ds') renderList();
  if (active === 'tab-th') renderSummary();
  $('#pendingCount').textContent = state.pending.length;
  const names = [...new Set(records().map(r => r.ten))].sort((a, b) => a.localeCompare(b, 'vi'));
  if ($('#names').childElementCount !== names.length) $('#names').innerHTML = names.map(n => `<option value="${esc(n)}">`).join('');
}

function init() {
  const catOpts = CATS.map(c => `<option>${esc(c)}</option>`).join('');
  $('#f-hangmuc').innerHTML = catOpts;
  $('#ds-hangmuc').innerHTML += catOpts;
  const pOpts = PEOPLE.map(p => `<option>${esc(p)}</option>`).join('');
  $('#ds-nguoi').innerHTML += pOpts; $('#th-nguoi').innerHTML += pOpts;
  $('#quickAmt').innerHTML = QUICK_AMT.map(v => `<button type="button" data-v="${v}">${v >= 1e6 ? v / 1e6 + 'tr' : v / 1000 + 'k'}</button>`).join('');
  $('#quickAmt').onclick = e => { const b = e.target.closest('button'); if (b) $('#f-tien').value = fmt(+b.dataset.v); };
  $('#quickNames').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    $('#f-ten').value = b.dataset.n; state.form.catTouched = false; autoCategory();
    const a = lastAmountFor(b.dataset.n, state.form.nguoi); if (a && !$('#f-tien').value) $('#f-tien').value = fmt(a);
  };
  $('#f-tien').addEventListener('input', e => { const n = parseInt(e.target.value.replace(/[^\d]/g, ''), 10); e.target.value = n ? fmt(n) : ''; });
  $('#f-tien').addEventListener('blur', e => { const n = parseAmount(e.target.value); e.target.value = n ? fmt(n) : ''; });
  $('#f-ten').addEventListener('input', autoCategory);
  $('#f-hangmuc').addEventListener('change', () => { state.form.catTouched = true; autoCategory(); });
  $('#f-ngay').addEventListener('change', renderToday);
  $('#form').addEventListener('submit', onSubmit);
  $('#cancelEdit').onclick = () => resetForm(true);
  $('#deleteBtn').onclick = onDelete;
  ['#todayList', '#dsList', '#th-top'].forEach(s => $(s).addEventListener('click', e => { const li = e.target.closest('li[data-id]'); if (li) editRecord(li.dataset.id); }));
  ['#ds-thang', '#ds-nguoi', '#ds-hangmuc'].forEach(s => $(s).addEventListener('change', renderList));
  $('#ds-tim').addEventListener('input', renderList);
  ['#th-nam', '#th-thang', '#th-nguoi'].forEach(s => $(s).addEventListener('change', renderSummary));
  document.querySelectorAll('.tabbar button').forEach(b => (b.onclick = () => showTab(b.dataset.tab)));
  $('#syncBtn').onclick = () => sync();
  $('#cfg-url').value = state.cfg.url; $('#cfg-key').value = state.cfg.key;
  $('#cfg-save').onclick = saveConfig;
  $('#seedFile').onchange = e => e.target.files[0] && importSeed(e.target.files[0]);
  $('#exportBtn').onclick = exportCsv;
  $('#reloadBtn').onclick = () => sync();
  window.addEventListener('online', () => sync(true));
  resetForm();
  renderAll();
  if (!state.cfg.url) showTab('tab-cd'); else sync(true);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
document.addEventListener('DOMContentLoaded', init);
