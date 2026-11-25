'use strict';
/* ChiTieuHangNgay – PWA nhập & tổng hợp chi tiêu, đồng bộ với Google Sheet qua Apps Script */

const PEOPLE = ['Chồng', 'Vợ', 'Jun', 'Putin', 'Út', 'Chung'];
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
/** cấu hình đã gộp thao tác chưa gửi */
function conf() {
  const c = { loans: [], budgets: {}, ...state.config };
  for (const p of state.pending) if (p.op === 'config') c[p.name] = p.value;
  return c;
}
function setConf(name, value) { queue({ op: 'config', name, value }); }
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
    state.config = { loans: [], budgets: {}, ...(j.config || {}) };
    save(LS.recs, state.server); save(LS.map, state.userMap); save(LS.conf, state.config);
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
  const ups = [], dels = [], maps = [], confs = {};
  for (const p of snap) {
    if (p.op === 'upsert') ups.push(p.rec);
    else if (p.op === 'delete') dels.push(p.id);
    else if (p.op === 'map') maps.push(p.item);
    else if (p.op === 'config') confs[p.name] = p.value;
  }
  for (const [name, value] of Object.entries(confs)) { await apiPost({ action: 'setConfig', name, value }); state.config[name] = value; }
  save(LS.conf, state.config);
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
  el.innerHTML = rows.length ? rows.map(([k, v, extra, _k, ratio]) => `<div class="bar" data-k="${esc(k)}"><div class="h"><span>${esc(k)}</span>
    <span><b>${fmt(v)}</b> <small>${total ? (v / total * 100).toFixed(1) + '%' : ''}${extra ? ' · ' + extra : ''}</small></span></div>
    <div class="track"><div class="fill${ratio > 1 ? ' over' : ratio >= 0.9 ? ' warn' : ''}" style="width:${(ratio ? Math.min(100, ratio * 100) : v / max * 100).toFixed(1)}%"></div></div></div>`).join('')
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
  const bud = m && !p ? conf().budgets || {} : {};
  const catRows = [...groupSum(rs, 'hangmuc')].map(([k, g]) => [k, g[0], g[1] + ' khoản' + (bud[k] ? ' · ngân sách ' + fmt(bud[k]) : ''), null, bud[k] ? g[0] / bud[k] : 0]);
  Object.keys(bud).forEach(k => { if (bud[k] && !catRows.some(r => r[0] === k)) catRows.push([k, 0, 'ngân sách ' + fmt(bud[k]), null, 0]); });
  bars($('#th-hangmuc'), catRows.sort((a, b) => b[1] - a[1]), total, k => goList('hangmuc', k));
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
  renderDebtCards(y, m, p, total);
  renderCompare();
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
    for (const [name, value] of Object.entries(data.config || {})) await apiPost({ action: 'setConfig', name, value });
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

/* ---------- cảnh báo trên trang Nhập ---------- */
function renderAlerts() {
  const today = todayStr(), c = conf(), out = [];
  for (const l of c.loans || []) {
    let s; try { s = LoanEngine.schedule(l, today); } catch (e) { continue; }
    const k = s.ky_toi; if (!k) continue;
    const truoc = l.nhac_truoc === '' || l.nhac_truoc == null ? 5 : +l.nhac_truoc;
    if (s.con_ngay <= truoc) {
      const when = s.con_ngay === 0 ? '<b>hôm nay</b>' : `còn <b>${s.con_ngay} ngày</b>`;
      out.push(`<div class="alert${s.con_ngay <= 1 ? ' red' : ''}">🏦 <b>${esc(l.ten)}</b> đến hạn ${fmtD(k.ngay)} (${when}): gốc ${fmt(k.goc)} + lãi ${fmt(k.lai)} = <b>${fmt(k.tong)} đ</b></div>`);
    }
  }
  const bud = c.budgets || {}, month = today.slice(0, 7), spent = {};
  for (const r of records()) if (r.thang === month) spent[r.hangmuc] = (spent[r.hangmuc] || 0) + r.tien;
  for (const [cat, b] of Object.entries(bud)) {
    if (!b) continue; const v = spent[cat] || 0;
    if (v >= b * 0.9) out.push(`<div class="alert${v > b ? ' red' : ''}">${v > b ? '🔴 Vượt' : '🟠 Sắp hết'} ngân sách <b>${esc(cat)}</b>: ${fmt(v)} / ${fmt(b)} đ (${Math.round(v / b * 100)}%)</div>`);
  }
  $('#alerts').innerHTML = out.join('');
}
const fmtD = s => s ? s.slice(8, 10) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4) : '';

/* ---------- khoản vay ---------- */
const openSched = new Set();
function renderLoans() {
  const today = todayStr(), loans = conf().loans || [];
  if (!loans.length) { $('#loanCards').innerHTML = '<p class="muted">Chưa có khoản vay. Nạp file dữ liệu ban đầu hoặc bấm "Thêm khoản vay".</p>'; return; }
  $('#loanCards').innerHTML = loans.map((l, i) => {
    let s; try { s = LoanEngine.schedule(l, today); } catch (e) { return `<div class="loan"><h3>${esc(l.ten)}</h3><p class="muted">Cấu hình lỗi: ${esc(e.message)}</p></div>`; }
    const k = s.ky_toi;
    const rate = (l.lai_suat || []).filter(r => r.tu_ngay <= today).sort((a, b) => a.tu_ngay.localeCompare(b.tu_ngay)).pop();
    const truoc = l.nhac_truoc === '' || l.nhac_truoc == null ? 5 : +l.nhac_truoc;
    const badge = k ? `<span class="badge${s.con_ngay <= 1 ? ' red' : s.con_ngay <= truoc ? ' warn' : ''}">${s.con_ngay === 0 ? 'Hôm nay' : 'Còn ' + s.con_ngay + ' ngày'}</span>` : '<span class="badge">Đã tất toán</span>';
    const paid = s.rows.filter(r => r.da_qua), gocDaTra = paid.reduce((a, r) => a + r.goc + r.tra_truoc, 0), laiDaTra = paid.reduce((a, r) => a + r.lai, 0);
    const seg = k ? k.chi_tiet_lai.map(p => `${fmtD(p.tu)} → ${fmtD(p.den)}: ${p.so_ngay} ngày × ${fmt(p.du_no)} × ${p.lai_suat}% / 365 = ${fmt(p.lai)}`).join('<br>') : '';
    const sched = openSched.has(l.id) ? `<div class="sched tablewrap"><table class="tbl"><tr><th>Kỳ</th><th>Ngày</th><th>Dư nợ</th><th>Gốc</th><th>Lãi</th><th>Tổng</th></tr>${
      s.rows.map(r => `<tr class="${r.da_qua ? 'past' : k && r.ky === k.ky ? 'next' : ''}"><td>${r.ky}</td><td>${fmtD(r.ngay)}</td><td>${fmt(r.du_no_dau)}</td><td>${fmt(r.goc)}${r.tra_truoc ? ' <small>(+' + fmt(r.tra_truoc) + ' trả trước)</small>' : ''}</td><td>${fmt(r.lai)}</td><td>${fmt(r.tong)}</td></tr>`).join('')
    }</table></div>` : '';
    return `<div class="loan"><h3>${esc(l.ten)} ${badge}</h3>
      ${k ? `<div class="kv">
        <div class="big"><span>Kỳ tới ${fmtD(k.ngay)}</span><b>${fmt(k.tong)} đ</b></div>
        <div><span>Gốc + lãi kỳ tới</span><b>${fmt(k.goc)} + ${fmt(k.lai)}</b></div>
        <div><span>Dư nợ hiện tại</span><b>${fmt(s.du_no_hien_tai)}</b></div>
        <div><span>Lãi suất hiện tại</span><b>${rate ? rate.nam + '%/năm' : '?'}</b></div>
        <div><span>Lãi tạm tính đến hôm nay</span><b>${fmt(s.lai_tam_tinh)}</b></div>
        <div><span>Đáo hạn</span><b>${s.dao_han ? fmtD(s.dao_han) : 'chưa nhập'}</b></div>
        <div><span>Đã trả gốc / lãi</span><b>${fmt(gocDaTra)} / ${fmt(laiDaTra)}</b></div>
        <div><span>Lãi còn phải trả ${s.dao_han ? '' : '(24 tháng tới)'}</span><b>${fmt(s.lai_con_lai)}</b></div>
      </div><div class="seg">Cách tính lãi kỳ tới:<br>${seg}</div>` : ''}
      <div class="actions"><button data-sched="${esc(l.id)}">${openSched.has(l.id) ? 'Ẩn lịch trả nợ' : 'Xem lịch trả nợ'}</button><button data-edit="${i}">Sửa</button></div>
      ${sched}</div>`;
  }).join('');
  $('#loanCards').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.sched) { openSched.has(b.dataset.sched) ? openSched.delete(b.dataset.sched) : openSched.add(b.dataset.sched); renderLoans(); }
    if (b.dataset.edit) openLoanEditor(+b.dataset.edit);
  };
}

const LIST_DEFS = {
  lai_suat: { title: 'Lãi suất (ghi mỗi lần ngân hàng đổi lãi)', fields: [['tu_ngay', 'date', 'Từ ngày'], ['nam', 'number', '%/năm']] },
  tra_truoc: { title: 'Trả trước gốc', fields: [['ngay', 'date', 'Ngày'], ['so_tien', 'text', 'Số tiền'], ['ghi_chu', 'text', 'Ghi chú']] },
  tam_dung_goc: { title: 'Tạm dừng trả gốc (các tháng chỉ trả lãi)', fields: [['tu_ky', 'month', 'Từ tháng'], ['den_ky', 'month', 'Đến tháng']] },
  doi_ngay: { title: 'Đổi ngày trả của một tháng (lễ, Tết…)', fields: [['thang', 'month', 'Tháng'], ['ngay', 'date', 'Ngày trả thật']] },
};
function openLoanEditor(idx) {
  const loans = conf().loans || [];
  const l = idx == null ? { id: 'vay-' + Date.now().toString(36), ten: '', kieu: 'tra_gop', so_tien_vay: '', ngay_giai_ngan: todayStr(), so_thang: '', ngay_tra: 15, goc_moi_ky: '', ky_dau: '', lui_ngay_nghi: true, nhac_truoc: 5, lai_suat: [{ tu_ngay: todayStr(), nam: '' }], tra_truoc: [], tam_dung_goc: [], doi_ngay: {} } : JSON.parse(JSON.stringify(loans[idx]));
  const lists = { ...l, doi_ngay: Object.entries(l.doi_ngay || {}).map(([thang, ngay]) => ({ thang, ngay })) };
  const f = (id, label, type, val, extra = '') => `<label>${label}<input id="le-${id}" type="${type}" value="${esc(val ?? '')}" ${extra}></label>`;
  const listHtml = key => {
    const def = LIST_DEFS[key], rows = lists[key] || [];
    return `<fieldset data-list="${key}"><legend>${def.title}</legend>${rows.map(r => rowHtml(def, r)).join('')}
      <div class="actions"><button type="button" data-addrow="${key}">＋ Thêm dòng</button></div></fieldset>`;
  };
  const rowHtml = (def, r) => `<div class="lrow${def.fields.length === 3 ? ' three' : ''}">${def.fields.map(([k, t, ph]) =>
    `<input data-k="${k}" type="${t}" placeholder="${ph}" title="${ph}" value="${esc(k === 'so_tien' && r[k] ? fmt(r[k]) : r[k] ?? '')}" ${t === 'number' ? 'step="0.01"' : ''} ${k === 'so_tien' ? 'inputmode="numeric"' : ''}>`).join('')}<button type="button" data-delrow>✕</button></div>`;
  const ed = $('#loanEditor');
  ed.innerHTML = `<h3>${idx == null ? 'Thêm khoản vay' : 'Sửa: ' + esc(l.ten)}</h3>
    ${f('ten', 'Tên khoản vay', 'text', l.ten, 'placeholder="VD: Vay mua ô tô"')}
    <div class="grid2">
      <label>Cách trả<select id="le-kieu"><option value="tra_gop">Trả góp gốc đều hằng tháng</option><option value="tra_lai">Hằng tháng trả lãi, gốc trả cuối kỳ</option></select></label>
      ${f('so_tien_vay', 'Số tiền vay (đ)', 'text', l.so_tien_vay ? fmt(l.so_tien_vay) : '', 'inputmode="numeric"')}
      ${f('ngay_giai_ngan', 'Ngày giải ngân', 'date', l.ngay_giai_ngan)}
      ${f('so_thang', 'Thời hạn (tháng)', 'number', l.so_thang, 'placeholder="để trống nếu chưa biết"')}
      ${f('ngay_tra', 'Ngày trả hằng tháng', 'number', l.ngay_tra, 'min="1" max="31"')}
      ${f('goc_moi_ky', 'Gốc mỗi kỳ (đ)', 'text', l.goc_moi_ky ? fmt(l.goc_moi_ky) : '', 'inputmode="numeric"')}
      ${f('ky_dau', 'Tháng trả kỳ đầu', 'month', l.ky_dau)}
      ${f('nhac_truoc', 'Nhắc trước (ngày)', 'number', l.nhac_truoc)}
    </div>
    <label class="chk"><input id="le-lui" type="checkbox" ${l.lui_ngay_nghi !== false ? 'checked' : ''}> Rơi vào thứ 7, chủ nhật thì dời sang thứ 2</label>
    ${Object.keys(LIST_DEFS).map(listHtml).join('')}
    <div class="actions"><button class="primary" id="le-save">Lưu khoản vay</button><button id="le-cancel">Đóng</button>${idx == null ? '' : '<button class="danger" id="le-del">Xóa khoản vay</button>'}</div>`;
  $('#le-kieu').value = l.kieu || 'tra_gop';
  ed.hidden = false; ed.scrollIntoView({ behavior: 'smooth' });
  ed.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.addrow) { const key = b.dataset.addrow; b.closest('.actions').insertAdjacentHTML('beforebegin', rowHtml(LIST_DEFS[key], {})); }
    if (b.hasAttribute('data-delrow')) b.closest('.lrow').remove();
  };
  $('#le-cancel').onclick = () => { ed.hidden = true; };
  if ($('#le-del')) $('#le-del').onclick = () => {
    if (!confirm('Xóa khoản vay "' + l.ten + '"? Không ảnh hưởng dữ liệu chi tiêu.')) return;
    const next = loans.slice(); next.splice(idx, 1); setConf('loans', next); ed.hidden = true;
  };
  $('#le-save').onclick = () => {
    const num = id => parseInt(String($('#le-' + id).value).replace(/[^\d]/g, ''), 10) || 0;
    const out = { ...l, ten: $('#le-ten').value.trim(), kieu: $('#le-kieu').value, so_tien_vay: num('so_tien_vay'),
      ngay_giai_ngan: $('#le-ngay_giai_ngan').value, so_thang: $('#le-so_thang').value ? +$('#le-so_thang').value : null,
      ngay_tra: +$('#le-ngay_tra').value || 15, goc_moi_ky: num('goc_moi_ky'), ky_dau: $('#le-ky_dau').value,
      nhac_truoc: $('#le-nhac_truoc').value === '' ? 5 : +$('#le-nhac_truoc').value, lui_ngay_nghi: $('#le-lui').checked };
    for (const key of Object.keys(LIST_DEFS)) {
      const rows = [...ed.querySelectorAll(`fieldset[data-list="${key}"] .lrow`)].map(row => {
        const o = {}; row.querySelectorAll('input').forEach(inp => { o[inp.dataset.k] = inp.value.trim(); }); return o;
      }).filter(o => Object.values(o).some(Boolean));
      if (key === 'lai_suat') out.lai_suat = rows.map(r => ({ tu_ngay: r.tu_ngay, nam: parseFloat(String(r.nam).replace(',', '.')) })).filter(r => r.tu_ngay && !isNaN(r.nam));
      if (key === 'tra_truoc') out.tra_truoc = rows.map(r => ({ ngay: r.ngay, so_tien: parseInt(String(r.so_tien).replace(/[^\d]/g, ''), 10) || 0, ghi_chu: r.ghi_chu || '' })).filter(r => r.ngay && r.so_tien);
      if (key === 'tam_dung_goc') out.tam_dung_goc = rows.filter(r => r.tu_ky && r.den_ky);
      if (key === 'doi_ngay') out.doi_ngay = Object.fromEntries(rows.filter(r => r.thang && r.ngay).map(r => [r.thang, r.ngay]));
    }
    if (!out.ten || !out.so_tien_vay || !out.ngay_giai_ngan || !out.lai_suat.length) { toast('Cần tên, số tiền vay, ngày giải ngân và ít nhất một mức lãi suất', 'err'); return; }
    if (out.kieu === 'tra_gop' && !out.goc_moi_ky) { toast('Trả góp cần nhập gốc mỗi kỳ', 'err'); return; }
    try { LoanEngine.schedule(out, todayStr()); } catch (e) { toast('Cấu hình chưa hợp lệ: ' + e.message, 'err'); return; }
    const next = loans.slice(); if (idx == null) next.push(out); else next[idx] = out;
    setConf('loans', next); ed.hidden = true; toast('Đã lưu khoản vay', 'ok');
  };
}

/* ---------- trả nợ trong Tổng hợp ---------- */
function renderDebtCards(y, m, p, total) {
  const el = $('#th-no');
  const loans = conf().loans || [];
  if (p || !loans.length) { el.innerHTML = ''; return; }
  const bm = LoanEngine.byMonth(loans, todayStr());
  let goc = 0, lai = 0, pre = 0;
  for (const [k, v] of Object.entries(bm)) if (k.startsWith(y) && (!m || k === m)) { goc += v.goc; lai += v.lai; pre += v.tra_truoc; }
  el.innerHTML = `<div class="card"><span>Trả nợ gốc</span><b>${fmt(goc + pre)}</b></div>
    <div class="card"><span>Trả nợ lãi</span><b>${fmt(lai)}</b></div>
    <div class="card"><span>Chi tiêu + trả nợ</span><b>${fmt(total + goc + pre + lai)}</b></div>`;
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
    html += `<tr><td>Tháng ${i}</td>` + years.map((y, j) => {
      const v = cell(y, mm), prev = j ? cell(years[j - 1], mm) : 0;
      const cls = j && v && prev ? (v > prev ? 'up' : 'down') : '';
      const pct = j && v && prev ? ` <small>${v > prev ? '+' : ''}${Math.round((v - prev) / prev * 100)}%</small>` : '';
      return `<td class="${cls}">${v ? fmt(v) : '–'}${pct}</td>`;
    }).join('') + '</tr>';
  }
  const ytot = y => rs.filter(r => r.thang.startsWith(y)).reduce((a, r) => a + r.tien, 0);
  const ymon = y => new Set(rs.filter(r => r.thang.startsWith(y)).map(r => r.thang)).size || 1;
  html += '<tr class="total"><td>Cả năm</td>' + years.map(y => `<td>${fmt(ytot(y))}</td>`).join('') + '</tr>';
  html += '<tr class="total"><td>Bình quân/tháng</td>' + years.map(y => `<td>${fmt(ytot(y) / ymon(y))}</td>`).join('') + '</tr>';
  html += '<tr><td>Số tháng có dữ liệu</td>' + years.map(y => `<td>${ymon(y)}</td>`).join('') + '</tr>';
  $('#cmp-table').innerHTML = html;
}

/* ---------- ngân sách ---------- */
function renderBudgetForm() {
  if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#budgetForm')) return;
  const b = conf().budgets || {};
  $('#budgetForm').innerHTML = CATS.filter(c => c !== 'Chưa rõ').map(c =>
    `<span>${esc(c)}</span><input data-cat="${esc(c)}" inputmode="numeric" placeholder="—" value="${b[c] ? fmt(b[c]) : ''}">`).join('');
}
function saveBudgets() {
  const out = {};
  document.querySelectorAll('#budgetForm input').forEach(i => { const n = parseAmount(i.value); if (n) out[i.dataset.cat] = n; });
  setConf('budgets', out); toast('Đã lưu ngân sách', 'ok');
}

/* ---------- điều hướng ---------- */
function showTab(id) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === id));
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
  renderAll();
}
function renderAll() {
  const active = document.querySelector('.tab.active').id;
  if (active === 'tab-nhap') { renderToday(); renderAlerts(); }
  if (active === 'tab-vay') renderLoans();
  if (active === 'tab-cd') renderBudgetForm();
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
  $('#budgetSave').onclick = saveBudgets;
  $('#tgTest').onclick = async () => { try { await apiPost({ action: 'testTelegram' }); toast('Đã gửi tin nhắn thử qua Telegram', 'ok'); } catch (e) { toast(e.message, 'err'); } };
  $('#loanAdd').onclick = () => openLoanEditor(null);
  $('#cmp-hm').innerHTML += CATS.map(c => `<option>${esc(c)}</option>`).join('');
  $('#cmp-hm').addEventListener('change', renderCompare);
  window.addEventListener('online', () => sync(true));
  resetForm();
  renderAll();
  if (!state.cfg.url) showTab('tab-cd'); else sync(true);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
document.addEventListener('DOMContentLoaded', init);
