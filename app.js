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

/* ---------- màu & tiện ích hiển thị ---------- */
const PCOL = { 'Chồng': '#60a5fa', 'Vợ': '#f472b6', 'Jun': '#fbbf24', 'Putin': '#34d399', 'Út': '#a78bfa', 'Chung': '#94a3b8' };
const PAL = ['#6d8dff', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#fb923c', '#22d3ee', '#f87171', '#84cc16', '#e879f9'];
const pcol = p => PCOL[p] || '#94a3b8';
const dmy = s => (s ? s.slice(8, 10) + '/' + s.slice(5, 7) : '');
const compact = n => (n >= 1e9 ? (n / 1e9).toFixed(2) + ' tỷ' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' tr' : fmt(n));

/* ---------- danh sách ---------- */
const CATS_ABC = CATS.filter(c => c !== 'Khác' && c !== 'Chưa rõ').sort((a, b) => a.localeCompare(b, 'vi')).concat(CATS.filter(c => c === 'Khác' || c === 'Chưa rõ'));
const WD = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const catCol = c => { const i = CATS_ABC.indexOf(c); return i < 0 ? '#64748b' : PAL[i % PAL.length]; };
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
  $('#ds-people').innerHTML = PEOPLE.map(p => { const g = per.get(p) || [0, 0];
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
    const secs = PEOPLE.filter(p => rs.some(r => r.nguoi === p)).map(p => {
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
function bars(el, rows, total, onClick) {
  const max = Math.max(1, ...rows.map(r => r.v));
  el.innerHTML = rows.length ? rows.map(r => `<div class="bar" data-k="${esc(r.key)}" style="--bc:${r.color || 'var(--ac)'}"><div class="h"><span class="nm"><i class="sw"></i><span>${esc(r.label)}<small>${total ? (r.v / total * 100).toFixed(1) + '%' : ''}${r.extra ? ' · ' + esc(r.extra) : ''}</small></span></span>
    <b class="v">${fmt(r.v)}</b></div>
    <div class="track"><div class="fill${r.ratio > 1 ? ' over' : r.ratio >= 0.9 ? ' warn' : ''}" style="width:${(r.ratio ? Math.min(100, r.ratio * 100) : r.v / max * 100).toFixed(1)}%"></div></div></div>`).join('')
    : '<p class="muted">Chưa có dữ liệu</p>';
  el.onclick = e => { const b = e.target.closest('.bar'); if (b && onClick) onClick(b.dataset.k); };
}
function vbars(el, rows, onClick) {
  const max = Math.max(1, ...rows.map(r => r.v));
  el.innerHTML = rows.map(r => `<div class="vb" data-k="${esc(r.key || '')}" title="${esc(r.label)}: ${fmt(r.v)} đ" ${onClick && r.key ? 'style="cursor:pointer"' : ''}><i style="height:${(r.v / max * 100).toFixed(1)}%"></i><small>${esc(r.short)}</small></div>`).join('');
  el.onclick = e => { const b = e.target.closest('.vb'); if (b && b.dataset.k && onClick) onClick(b.dataset.k); };
}
function donut(rows, total) {
  const R = 70, C = 2 * Math.PI * R; let off = 0;
  const segs = rows.filter(r => r.v > 0).map(r => { const len = r.v / total * C; const s = `<circle cx="100" cy="100" r="${R}" fill="none" stroke="${r.color}" stroke-width="26" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 100 100)"><title>${esc(r.label)}: ${fmt(r.v)}</title></circle>`; off += len; return s; }).join('');
  return `<svg viewBox="0 0 200 200" role="img" aria-label="Biểu đồ theo hạng mục"><circle cx="100" cy="100" r="${R}" fill="none" stroke="var(--bg2)" stroke-width="26"/>${segs}
    <text x="100" y="98" class="donut-c">${compact(total)}</text><text x="100" y="114" class="donut-s">TỔNG CHI</text></svg>`;
}
function groupSum(rs, key) {
  const m = new Map();
  for (const r of rs) { const k = typeof key === 'function' ? key(r) : r[key]; const g = m.get(k) || [0, 0]; g[0] += r.tien; g[1]++; m.set(k, g); }
  return m;
}
const kpi = (label, val, color, sub) => `<div class="kpi" style="--kc:${color}"><span>${label}</span><b>${val}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
function renderSummary() {
  const all = records();
  const years = [...new Set(all.map(r => (r.thang || '').slice(0, 4)).filter(Boolean))]; years.push(todayStr().slice(0, 4));
  fillSelect($('#th-nam'), [...new Set(years)].sort().reverse().map(y => [y, 'Năm ' + y]));
  if (!$('#th-nam').dataset.init) { $('#th-nam').value = todayStr().slice(0, 4); $('#th-nam').dataset.init = 1; }
  const y = $('#th-nam').value;
  fillSelect($('#th-thang'), [['', 'Cả năm'], ...Array.from({ length: 12 }, (_, i) => [y + '-' + String(i + 1).padStart(2, '0'), 'Tháng ' + (i + 1)])]);
  const m = $('#th-thang').value, p = $('#th-nguoi').value;
  const rs = all.filter(r => (r.thang || '').startsWith(y) && (!m || r.thang === m) && (!p || r.nguoi === p));
  const total = rs.reduce((s, r) => s + r.tien, 0);
  let avgLbl, avg;
  if (m) { const now = todayStr(), dim = new Date(+m.slice(0, 4), +m.slice(5), 0).getDate(), days = now.startsWith(m) ? +now.slice(8) : dim; avgLbl = 'Bình quân / ngày'; avg = total / days; }
  else { avgLbl = 'Bình quân / tháng'; avg = total / (new Set(rs.map(r => r.thang)).size || 1); }
  let k = kpi('Tổng chi tiêu', fmt(total) + ' đ', 'var(--ac)', fmt(rs.length) + ' khoản') + kpi(avgLbl, fmt(avg) + ' đ', 'var(--ok)', '');
  const loans = conf().loans || [];
  if (loans.length && !p) {
    const d = debtTotals(loans, y, m);
    k += kpi('Trả nợ gốc', fmt(d.goc) + ' đ', '#fb923c', 'chi tiết ở tab Khoản vay') + kpi('Trả nợ lãi', fmt(d.lai) + ' đ', 'var(--bad)', 'xe + nhà') + kpi('Chi tiêu + trả nợ', fmt(total + d.goc + d.lai) + ' đ', '#a78bfa', '');
  }
  $('#th-kpis').innerHTML = k;

  const goList = (field, val) => {
    dsPerson = field === 'nguoi' ? val : p; $('#ds-thang').value = m || ''; $('#ds-thang').dataset.init = 1; $('#ds-hangmuc').value = field === 'hangmuc' ? val : '';
    $('#ds-tim').value = ''; showTab('tab-ds');
  };
  const bud = m && !p ? conf().budgets || {} : {};
  const cats = [...groupSum(rs, 'hangmuc')].sort((a, b) => b[1][0] - a[1][0]);
  const catRows = cats.map(([c, g], i) => ({ key: c, label: c, v: g[0], extra: g[1] + ' khoản' + (bud[c] ? ' · ngân sách ' + fmt(bud[c]) : ''), ratio: bud[c] ? g[0] / bud[c] : 0, color: PAL[i % PAL.length] }));
  Object.keys(bud).forEach(c => { if (bud[c] && !catRows.some(r => r.key === c)) catRows.push({ key: c, label: c, v: 0, extra: 'ngân sách ' + fmt(bud[c]), ratio: 0, color: '#64748b' }); });
  $('#th-donut').innerHTML = total ? donut(catRows.slice(0, 10), total) : '';
  bars($('#th-hangmuc'), catRows, total, c => goList('hangmuc', c));
  bars($('#th-nguoi-bars'), [...groupSum(rs, 'nguoi')].sort((a, b) => PEOPLE.indexOf(a[0]) - PEOPLE.indexOf(b[0])).map(([n, g]) => ({ key: n, label: n, v: g[0], extra: g[1] + ' khoản', color: pcol(n) })), total, n => goList('nguoi', n));
  if (m) {
    $('#th-thang-title').textContent = 'Theo ngày';
    const g = groupSum(rs.filter(r => r.ngay), 'ngay'), dim = new Date(+m.slice(0, 4), +m.slice(5), 0).getDate();
    vbars($('#th-thang-bars'), Array.from({ length: dim }, (_, i) => { const d = m + '-' + String(i + 1).padStart(2, '0'); return { label: dmy(d), short: String(i + 1), v: (g.get(d) || [0])[0] }; }));
  } else {
    $('#th-thang-title').textContent = 'Theo tháng';
    const g = groupSum(rs, 'thang');
    vbars($('#th-thang-bars'), Array.from({ length: 12 }, (_, i) => { const mm = y + '-' + String(i + 1).padStart(2, '0'); return { key: mm, label: 'Tháng ' + (i + 1), short: 'T' + (i + 1), v: (g.get(mm) || [0])[0] }; }),
      mm => { $('#th-thang').value = mm; renderSummary(); });
  }
  renderCompare();
  const pend = pendingIds();
  $('#th-top').innerHTML = [...rs].sort((a, b) => b.tien - a.tien).slice(0, 10).map(r => recHtml(r, pend, 'top')).join('') || '<li class="empty">Chưa có dữ liệu</li>';
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

/* ---------- khoản vay ---------- */
const openSched = new Set();
/** đang sửa mốc lãi suất: { loan: chỉ số khoản vay, idx: số thứ tự mốc | 'new', date?: 'YYYY-MM-DD' } */
let rateEdit = null;

function loanCtx(l, i, today) { try { return { l, i, s: LoanEngine.schedule(l, today) }; } catch (e) { return { l, i, err: e.message }; } }
function debtTotals(loans, y, m) {
  let goc = 0, lai = 0, duNo = 0;
  loans.forEach((l, i) => {
    const c = loanCtx(l, i, todayStr()); if (!c.s) return;
    duNo += c.s.du_no_hien_tai;
    c.s.rows.forEach(r => { if (r.thang.startsWith(y) && (!m || r.thang === m)) { goc += cg(r) + r.tra_truoc; lai += r.lai; } });
  });
  return { goc, lai, duNo };
}
const cg = r => (r.dao_no ? 0 : r.goc); // gốc trả bằng tiền thật (đảo nợ thì gốc do khoản vay mới trả)
const rowRates = r => [...new Set(r.chi_tiet_lai.map(p => p.lai_suat))].map(x => x + '%').join(' → ');
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
    <div class="big"><span>Kỳ tới ${fmtD(k.ngay)}: gốc ${fmt(k.goc)} + lãi ${fmt(k.lai)}</span><b>${fmt(k.tong)} đ</b>${k.chi_tiet_lai.length > 1 ? `<small class="split">Lãi gồm: ${k.chi_tiet_lai.map(p => `${fmt(p.lai)} (${p.lai_suat}%, ${dmy(p.tu)}→${dmy(p.den)}, ${p.so_ngay} ngày)`).join(' + ')}</small>` : ''}</div>
    <div><span>Dư nợ hiện tại</span><b>${fmt(s.du_no_hien_tai)}</b></div>
    <div><span>Lãi suất hiện tại</span><b class="rate">${rate ? rate.nam + '%/năm' : '?'}</b></div>
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
function rateEditRow(i, date, nam, idx) {
  return `<tr class="edit"><td><input type="date" data-rf="date" value="${esc(date)}"></td><td>–</td>
    <td><input type="number" step="0.01" min="0" data-rf="rate" placeholder="% / năm" value="${esc(nam)}"></td><td>–</td><td>–</td><td>–</td>
    <td class="act"><button type="button" class="btn sm primary" data-rt="save" data-loan="${i}" data-idx="${idx}"><svg class="ic"><use href="#i-check"/></svg>Lưu</button><button type="button" class="btn sm" data-rt="cancel">Hủy</button></td></tr>`;
}
function rateTableHtml(c) {
  const { l, i, s } = c, today = todayStr(), per = ratePeriods(l, s);
  const ed = rateEdit && rateEdit.loan === i ? rateEdit : null;
  const stTxt = { now: 'Đang áp dụng', next: 'Sắp tới', old: 'Đã qua' };
  let rows = per.map(r => {
    if (ed && ed.idx === r.idx) return rateEditRow(i, r.tu_ngay, r.nam, r.idx);
    const sub = r.laiTra && r.lai - r.laiTra > 0 ? `<br><small>đã trả ${fmt(r.laiTra)} · dự kiến ${fmt(r.lai - r.laiTra)}</small>` : (r.lai && !r.laiTra ? '<br><small>dự kiến</small>' : '');
    return `<tr><td>${fmtD(r.tu_ngay)}</td><td>${r.den ? fmtD(r.den) : (l.so_thang ? 'đáo hạn' : 'chưa xác định')}</td><td class="rate">${r.nam}%/năm</td><td>${r.ngay ? fmt(r.ngay) : '–'}</td><td><b>${fmt(r.lai)}</b>${sub}</td>
      <td><span class="st ${r.status}">${stTxt[r.status]}</span></td>
      <td class="act"><button type="button" class="btn sm" data-rt="edit" data-loan="${i}" data-idx="${r.idx}"><svg class="ic"><use href="#i-edit"/></svg>Sửa</button><button type="button" class="btn sm danger" data-rt="del" data-loan="${i}" data-idx="${r.idx}" title="Xóa mốc này"><svg class="ic"><use href="#i-trash"/></svg></button></td></tr>`;
  }).join('');
  if (ed && ed.idx === 'new') { const cur = currentRate(l, today); rows += rateEditRow(i, ed.date || today, cur ? cur.nam : '', 'new'); }
  const paidLai = s.rows.filter(r => r.da_qua).reduce((a, r) => a + r.lai, 0);
  return `<div class="sect-h" id="rate-${i}"><h4><svg class="ic"><use href="#i-pct"/></svg>Lãi suất &amp; tiền lãi</h4>
      <button type="button" class="btn sm" data-rt="add" data-loan="${i}"><svg class="ic"><use href="#i-plus"/></svg>Thêm mốc đổi lãi suất</button></div>
    <div class="tablewrap"><table class="tbl rsp"><tr><th>Từ ngày</th><th>Đến ngày</th><th>Lãi suất</th><th>Số ngày</th><th>Tiền lãi</th><th>Trạng thái</th><th></th></tr>${rows}
      <tr class="total"><td colspan="4">Cộng toàn lịch${l.so_thang ? '' : ' (24 tháng dự kiến)'}</td><td>${fmt(s.tong_lai)}<br><small>đã trả ${fmt(paidLai)}</small></td><td colspan="2"></td></tr></table></div>
    <p class="muted">Ngân hàng báo đổi lãi từ ngày nào thì bấm “Thêm mốc đổi lãi suất”, nhập ngày áp dụng và mức lãi mới (kể cả ngày trong tương lai). Bấm “Sửa” ở dòng bất kỳ để đổi ngày hoặc mức lãi: tiền lãi các kỳ sau, lịch trả nợ và số liệu tổng hợp tự tính lại.</p>`;
}

function scheduleHtml(c) {
  const { s } = c, k = s.ky_toi;
  const row = r => `<tr class="${r.da_qua ? 'past' : k && r.ky === k.ky ? 'next' : ''}"><td>${r.ky}</td><td>${fmtD(r.ngay)}</td><td class="rate">${rowRates(r)}</td><td>${fmt(r.du_no_dau)}</td><td>${fmt(r.goc)}${r.tra_truoc ? '<br><small>+' + fmt(r.tra_truoc) + ' trả trước</small>' : ''}${r.dao_no ? '<br><small>đảo nợ: khoản vay mới trả gốc</small>' : ''}</td><td>${fmt(r.lai)}</td><td>${fmt(r.tong)}</td>
      <td class="act">${r.da_qua ? '' : `<button type="button" class="btn sm" data-rt="from" data-loan="${c.i}" data-date="${r.tu_ngay}" title="Đổi lãi suất áp dụng từ đầu kỳ này">Đổi lãi</button>`}</td></tr>`;
  const sap = s.rows.filter(r => !r.da_qua), da = s.rows.filter(r => r.da_qua).reverse(); // sắp tới: gần nhất trước; đã trả: mới nhất trước
  const grp = (t, n) => `<tr class="grp"><td colspan="8">${t} (${n} kỳ)</td></tr>`;
  return `<div class="sect-h"><h4><svg class="ic"><use href="#i-cal"/></svg>Lịch trả nợ</h4></div><div class="tablewrap"><table class="tbl rsp"><tr><th>Kỳ</th><th>Ngày</th><th>Lãi suất</th><th>Dư nợ đầu kỳ</th><th>Gốc</th><th>Lãi</th><th>Tổng</th><th></th></tr>${
    (sap.length ? grp('Sắp tới', sap.length) + sap.map(row).join('') : '') + (da.length ? grp('Đã trả', da.length) + da.map(row).join('') : '')
  }</table></div>`;
}

let rollEdit = null, showDone = false;
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
function rollFormHtml(c) {
  const { l, i, s } = c, cur = currentRate(l, todayStr());
  return `<div class="roll card" id="roll-${i}"><h4>Đáo hạn &amp; vay khoản mới (đảo nợ)</h4>
    <p class="muted">Ngân hàng giải ngân khoản mới để trả gốc khoản cũ. Khoảng ngày chồng nhau (khoản mới giải ngân trước ngày khoản cũ đáo hạn) sẽ tính lãi cả hai khoản, giống trên sheet.</p>
    <div class="grid2 f">
      <label>Ngày đáo hạn khoản cũ<input type="date" data-rl="end" value="${esc(l.ngay_ket_thuc || '')}"></label>
      <label>Ngày giải ngân khoản mới<input type="date" data-rl="start"></label>
      <label>Số tiền vay mới (đ)<input type="text" inputmode="numeric" data-rl="amt" value="${fmt(s.du_no_hien_tai || l.so_tien_vay)}"></label>
      <label>Lãi suất khoản mới (%/năm)<input type="number" step="0.01" data-rl="rate" value="${cur ? cur.nam : ''}"></label>
      <label>Ngày trả hằng tháng<input type="number" min="1" max="31" data-rl="day" value="${esc(l.ngay_tra || 15)}"></label>
      <label>Tháng trả kỳ đầu (để trống = tháng sau ngày giải ngân)<input type="month" data-rl="ky"></label>
    </div>
    <div class="actions"><button type="button" class="btn sm primary" data-rl-save="${i}"><svg class="ic"><use href="#i-check"/></svg>Lưu</button><button type="button" class="btn sm" data-rl-cancel>Hủy</button></div></div>`;
}
function applyRoll(i, box) {
  const v = k => box.querySelector(`[data-rl=${k}]`).value.trim();
  const end = v('end'), start = v('start'), amt = parseInt(v('amt').replace(/[^\d]/g, ''), 10) || 0, rate = parseFloat(v('rate').replace(',', '.')), day = +v('day') || 15;
  if (!end || !start || !amt || isNaN(rate)) { toast('Cần nhập ngày đáo hạn, ngày giải ngân, số tiền và lãi suất', 'err'); return; }
  const loans = JSON.parse(JSON.stringify(conf().loans || [])), old = loans[i];
  if (start > end) { if (!confirm('Ngày giải ngân khoản mới sau ngày đáo hạn khoản cũ. Vẫn lưu?')) return; }
  if (end <= old.ngay_giai_ngan) { toast('Ngày đáo hạn phải sau ngày giải ngân khoản cũ', 'err'); return; }
  const nhom = old.nhom || old.id, base = baseName(old.ten);
  let ky = v('ky');
  if (!ky) { const t = new Date(start + 'T00:00'); t.setDate(1); t.setMonth(t.getMonth() + 1); ky = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0'); }
  Object.assign(old, { nhom, ngay_ket_thuc: end, dao_no: true, ten: `${base} (${fmtD(old.ngay_giai_ngan)} – ${fmtD(end)})` });
  loans.push({ id: nhom + '-' + start, nhom, ten: `${base} (từ ${fmtD(start)})`, kieu: old.kieu, so_tien_vay: amt, ngay_giai_ngan: start, so_thang: null,
    ngay_tra: day, goc_moi_ky: old.kieu === 'tra_gop' ? old.goc_moi_ky : 0, ky_dau: ky, lui_ngay_nghi: old.lui_ngay_nghi, nhac_truoc: old.nhac_truoc,
    lai_suat: [{ tu_ngay: start, nam: rate }], tra_truoc: [], tam_dung_goc: [], doi_ngay: {} });
  try { loans.forEach(l => LoanEngine.schedule(l, todayStr())); } catch (e) { toast('Cấu hình chưa hợp lệ: ' + e.message, 'err'); return; }
  rollEdit = null; setConf('loans', loans);
  toast('Đã ghi đáo hạn khoản cũ ngày ' + fmtD(end) + ' và khoản vay mới từ ' + fmtD(start), 'ok');
}
function loanCardHtml(c, loans, today) {
  const { l, i, s } = c, k = s.ky_toi;
  const seg = k ? `<div class="seg">Cách tính lãi kỳ tới:<br>${k.chi_tiet_lai.map(p => `${fmtD(p.tu)} → ${fmtD(p.den)}: ${p.so_ngay} ngày × ${fmt(p.du_no)} × ${p.lai_suat}% / 365 = <b>${fmt(p.lai)}</b>`).join('<br>')}</div>` : '';
  return `<div class="loan"><div class="loan-h"><h3>${esc(l.ten)}</h3>${loanBadge(c)}</div>${chainInfo(c, loans, today)}
    ${loanKv(c, today)}${rateTableHtml(c)}${seg}
    <div class="actions" style="margin-top:14px"><button type="button" class="btn sm" data-sched="${esc(l.id)}">${openSched.has(l.id) ? 'Ẩn lịch' : 'Lịch trả nợ'}</button>
      <button type="button" class="btn sm" data-roll="${i}" title="Đáo hạn khoản cũ &amp; vay khoản mới"><svg class="ic"><use href="#i-sync"/></svg>Đảo nợ</button>
      <button type="button" class="btn sm" data-edit="${i}"><svg class="ic"><use href="#i-edit"/></svg>Sửa</button></div>
    ${rollEdit === i ? rollFormHtml(c) : ''}${openSched.has(l.id) ? scheduleHtml(c) : ''}</div>`;
}
function doneCardHtml(c) {
  const { l, i, s } = c, last = s.rows[s.rows.length - 1];
  const lai = s.rows.reduce((a, r) => a + r.lai, 0);
  return `<div class="loan done"><div class="loan-h"><h3>${esc(l.ten)}</h3><span class="badge">${l.dao_no ? 'Đã đáo hạn, đảo nợ' : 'Đã tất toán'}</span></div>
    <div class="kv"><div><span>Giải ngân</span><b>${fmtD(l.ngay_giai_ngan)}</b></div><div><span>Đáo hạn</span><b>${fmtD(last.ngay)}</b></div>
      <div><span>Số tiền vay</span><b>${fmt(l.so_tien_vay)}</b></div><div><span>Lãi suất</span><b class="rate">${(l.lai_suat || []).map(r => r.nam + '%').join(' → ')}</b></div>
      <div><span>Tổng lãi đã trả</span><b>${fmt(lai)}</b></div><div><span>Số kỳ</span><b>${s.rows.length}</b></div></div>
    <div class="actions" style="margin-top:12px"><button type="button" class="btn sm" data-sched="${esc(l.id)}">${openSched.has(l.id) ? 'Ẩn lịch' : 'Lịch trả nợ'}</button><button type="button" class="btn sm" data-edit="${i}"><svg class="ic"><use href="#i-edit"/></svg>Sửa</button></div>
    ${openSched.has(l.id) ? scheduleHtml(c) : ''}</div>`;
}
function renderLoans() {
  const today = todayStr(), loans = conf().loans || [];
  if (!loans.length) { $('#loanCards').innerHTML = '<div class="card empty">Chưa có khoản vay. Nạp file dữ liệu ban đầu hoặc bấm “Thêm khoản vay”.</div>'; return; }
  const ctx = loans.map((l, i) => loanCtx(l, i, today));
  const active = ctx.filter(c => !loanDone(c)), done = ctx.filter(loanDone);
  let html = active.map(c => c.s ? loanCardHtml(c, loans, today)
    : `<div class="loan"><div class="loan-h"><h3>${esc(c.l.ten)}</h3><button class="btn sm" data-edit="${c.i}">Sửa</button></div><p class="muted">Cấu hình lỗi: ${esc(c.err)}</p></div>`).join('');
  if (done.length) html += `<button type="button" class="btn done-toggle" data-done>${showDone ? 'Ẩn' : 'Xem'} ${done.length} khoản vay đã tất toán / đã đảo nợ <svg class="ic"><use href="#i-down"/></svg></button>${showDone ? done.map(doneCardHtml).join('') : ''}`;
  $('#loanCards').innerHTML = html;
  $('#loanCards').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.sched) { openSched.has(b.dataset.sched) ? openSched.delete(b.dataset.sched) : openSched.add(b.dataset.sched); renderLoans(); labelTables(); }
    if (b.dataset.edit) openLoanEditor(+b.dataset.edit);
    if (b.hasAttribute('data-done')) { showDone = !showDone; renderLoans(); labelTables(); }
    if (b.dataset.roll) { rollEdit = rollEdit === +b.dataset.roll ? null : +b.dataset.roll; renderLoans(); const f = document.getElementById('roll-' + rollEdit); if (f) f.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    if (b.hasAttribute('data-rl-cancel')) { rollEdit = null; renderLoans(); }
    if (b.dataset.rlSave) applyRoll(+b.dataset.rlSave, b.closest('.roll'));
  };
}

/* ---- sửa mốc lãi suất (dùng chung cho tab Tổng hợp và tab Khoản vay) ---- */
function applyLoanEdit(i, mutate, okMsg) {
  const loans = JSON.parse(JSON.stringify(conf().loans || [])), today = todayStr();
  const before = loanCtx(loans[i], i, today).s;
  mutate(loans[i]);
  let after;
  try { after = LoanEngine.schedule(loans[i], today); } catch (err) { toast('Cấu hình chưa hợp lệ: ' + err.message, 'err'); return false; }
  rateEdit = null; setConf('loans', loans);
  const nk = after.ky_toi;
  const dl = before ? after.lai_con_lai - before.lai_con_lai : 0;
  toast(okMsg + ' Lãi còn lại ' + (dl >= 0 ? '+' : '') + fmt(dl) + ' đ' + (nk ? '. Kỳ tới ' + fmtD(nk.ngay) + ': ' + fmt(nk.tong) + ' đ' : ''), 'ok');
  return true;
}
function onRateClick(e) {
  const b = e.target.closest('[data-rt]'); if (!b) return;
  const op = b.dataset.rt, i = +b.dataset.loan, idx = b.dataset.idx === 'new' ? 'new' : +b.dataset.idx;
  const rerender = () => { renderAll(); const t = document.getElementById('rate-' + i); if (t) t.scrollIntoView({ block: 'center', behavior: 'smooth' }); };
  if (op === 'add') { rateEdit = { loan: i, idx: 'new' }; rerender(); }
  else if (op === 'from') { rateEdit = { loan: i, idx: 'new', date: b.dataset.date }; rerender(); }
  else if (op === 'edit') { rateEdit = { loan: i, idx }; renderAll(); }
  else if (op === 'cancel') { rateEdit = null; renderAll(); }
  else if (op === 'del') {
    const l = (conf().loans || [])[i];
    if ((l.lai_suat || []).length <= 1) { toast('Phải còn ít nhất một mức lãi suất', 'err'); return; }
    const r = l.lai_suat[idx];
    if (confirm('Xóa mốc lãi suất ' + r.nam + '%/năm từ ngày ' + fmtD(r.tu_ngay) + '?\nCác kỳ sau sẽ tính theo mức lãi của mốc trước đó.')) applyLoanEdit(i, x => x.lai_suat.splice(idx, 1), 'Đã xóa mốc lãi suất.');
  } else if (op === 'save') {
    const tr = b.closest('tr'), date = tr.querySelector('[data-rf=date]').value, nam = parseFloat(String(tr.querySelector('[data-rf=rate]').value).replace(',', '.'));
    if (!date || isNaN(nam) || nam < 0 || nam > 100) { toast('Cần nhập ngày áp dụng và lãi suất (%/năm) hợp lệ', 'err'); return; }
    const l = (conf().loans || [])[i];
    if ((l.lai_suat || []).some((r, k) => r.tu_ngay === date && k !== idx)) { toast('Đã có mốc lãi suất vào ngày ' + fmtD(date) + ', hãy sửa dòng đó', 'err'); return; }
    applyLoanEdit(i, x => { if (idx === 'new') x.lai_suat.push({ tu_ngay: date, nam }); else x.lai_suat[idx] = { ...x.lai_suat[idx], tu_ngay: date, nam }; x.lai_suat.sort((a, c2) => a.tu_ngay.localeCompare(c2.tu_ngay)); },
      idx === 'new' ? 'Đã thêm mốc lãi suất ' + nam + '% từ ' + fmtD(date) + '.' : 'Đã cập nhật lãi suất.');
  }
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
      ${f('ngay_ket_thuc', 'Ngày đáo hạn cụ thể (nếu có)', 'date', l.ngay_ket_thuc)}
      ${f('nhom', 'Nhóm (các khoản đảo nợ nối tiếp)', 'text', l.nhom, 'placeholder="VD: nha"')}
    </div>
    <label class="chk"><input id="le-dao" type="checkbox" ${l.dao_no ? 'checked' : ''}> Gốc cuối kỳ trả bằng khoản vay mới (đảo nợ)</label>
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
      nhac_truoc: $('#le-nhac_truoc').value === '' ? 5 : +$('#le-nhac_truoc').value, lui_ngay_nghi: $('#le-lui').checked,
      ngay_ket_thuc: $('#le-ngay_ket_thuc').value || undefined, nhom: $('#le-nhom').value.trim() || undefined, dao_no: $('#le-dao').checked || undefined };
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
  $('#budgetForm').innerHTML = CATS_ABC.filter(c => c !== 'Chưa rõ').map(c =>
    `<span>${esc(c)}</span><input data-cat="${esc(c)}" inputmode="numeric" placeholder="—" value="${b[c] ? fmt(b[c]) : ''}">`).join('');
}
function saveBudgets() {
  const out = {};
  document.querySelectorAll('#budgetForm input').forEach(i => { const n = parseAmount(i.value); if (n) out[i.dataset.cat] = n; });
  setConf('budgets', out); toast('Đã lưu ngân sách', 'ok');
}

/* ---------- điều hướng ---------- */
const TITLES = { 'tab-nhap': 'Nhập chi tiêu', 'tab-ds': 'Danh sách chi tiêu', 'tab-th': 'Tổng hợp', 'tab-vay': 'Khoản vay', 'tab-cd': 'Cài đặt' };
function showTab(id) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === id));
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
  $('#pageTitle').textContent = TITLES[id] || '';
  renderAll(); window.scrollTo({ top: 0 });
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
  if (document.activeElement && document.activeElement.matches && document.activeElement.matches('tr.edit input, .roll input')) { $('#pendingCount').textContent = state.pending.length; return; }
  if (active === 'tab-nhap') { renderToday(); renderAlerts(); }
  if (active === 'tab-vay') renderLoans();
  if (active === 'tab-cd') renderBudgetForm();
  if (active === 'tab-ds') renderList();
  if (active === 'tab-th') renderSummary();
  $('#pendingCount').textContent = state.pending.length;
  labelTables();
  const names = [...new Set(records().map(r => r.ten))].sort((a, b) => a.localeCompare(b, 'vi'));
  if ($('#names').childElementCount !== names.length) $('#names').innerHTML = names.map(n => `<option value="${esc(n)}">`).join('');
}

/** Biến <select> thành ô chọn có tìm kiếm (giữ nguyên select gốc để code cũ dùng .value/change) */
const fold = t => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
function comboSelect(sel) {
  const wrap = document.createElement('div'); wrap.className = 'combo';
  sel.parentNode.insertBefore(wrap, sel); wrap.appendChild(sel); sel.classList.add('combo-src');
  wrap.insertAdjacentHTML('beforeend', `<button type="button" class="combo-btn"><span></span><svg class="ic"><use href="#i-down"/></svg></button>
    <div class="combo-pop" hidden><label class="search"><svg class="ic"><use href="#i-search"/></svg><input type="search" placeholder="Tìm hạng mục…" autocomplete="off"></label><ul></ul></div>`);
  const btn = wrap.querySelector('.combo-btn'), pop = wrap.querySelector('.combo-pop'), q = pop.querySelector('input'), ul = pop.querySelector('ul');
  const refresh = () => { const o = sel.options[sel.selectedIndex]; btn.firstElementChild.textContent = o ? o.text : ''; };
  const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(sel, 'value', { get() { return d.get.call(this); }, set(v) { d.set.call(this, v); refresh(); } });
  let hi = 0;
  const list = () => {
    const f = fold(q.value.trim()), opts = [...sel.options].filter(o => !f || fold(o.text).includes(f));
    hi = Math.min(hi, Math.max(0, opts.length - 1));
    ul.innerHTML = opts.map((o, i) => `<li data-v="${esc(o.value)}" class="${o.value === sel.value ? 'sel' : ''}${i === hi ? ' hi' : ''}">${o.value && CATS.includes(o.value) ? `<i style="--cc:${catCol(o.value)}"></i>` : ''}${esc(o.text)}</li>`).join('') || '<li class="none">Không có hạng mục phù hợp</li>';
  };
  const close = () => { pop.hidden = true; wrap.classList.remove('open'); };
  const pick = v => { if (v == null) return; sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })); close(); };
  btn.onclick = () => { if (!pop.hidden) return close(); document.querySelectorAll('.combo.open').forEach(w => w !== wrap && w.querySelector('.combo-btn').click());
    pop.hidden = false; wrap.classList.add('open'); q.value = ''; hi = Math.max(0, sel.selectedIndex); list(); q.focus({ preventScroll: true }); const s2 = ul.querySelector('.sel'); if (s2) s2.scrollIntoView({ block: 'nearest' }); };
  q.oninput = () => { hi = 0; list(); };
  q.onkeydown = e => {
    const n = ul.querySelectorAll('li[data-v]').length;
    if (e.key === 'ArrowDown') { hi = Math.min(n - 1, hi + 1); list(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { hi = Math.max(0, hi - 1); list(); e.preventDefault(); }
    else if (e.key === 'Enter') { const li = ul.querySelectorAll('li[data-v]')[hi]; if (li) pick(li.dataset.v); e.preventDefault(); }
    else if (e.key === 'Escape') close();
  };
  ul.onclick = e => { const li = e.target.closest('li[data-v]'); if (li) pick(li.dataset.v); };
  document.addEventListener('click', e => { if (!wrap.contains(e.target)) close(); });
  sel.addEventListener('change', refresh);
  refresh();
}
function toggleTheme() {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('cthn.theme', next); } catch (e) {}
  const mt = document.querySelector('meta[name=theme-color]'); if (mt) mt.content = next === 'light' ? '#f3f5fb' : '#0b1020';
}
function init() {
  const catOpts = CATS_ABC.map(c => `<option>${esc(c)}</option>`).join('');
  $('#f-hangmuc').innerHTML = catOpts;
  $('#ds-hangmuc').innerHTML += catOpts;
  const pOpts = PEOPLE.map(p => `<option>${esc(p)}</option>`).join('');
  $('#th-nguoi').innerHTML += pOpts;
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
  ['#ds-thang', '#ds-hangmuc'].forEach(s => $(s).addEventListener('change', renderList));
  $('#ds-people').addEventListener('click', e => { const b = e.target.closest('.pcard'); if (b) { dsPerson = dsPerson === b.dataset.p ? '' : b.dataset.p; renderList(); } });
  $('#ds-clear').onclick = () => { dsPerson = ''; renderList(); };
  $('#ds-view').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { dsView = b.dataset.view; save('cthn.dsview', dsView); renderList(); } });
  $('#dsList').addEventListener('click', e => { const b = e.target.closest('.more'); if (b) { const k = b.dataset.more; dsLimit[k] = (dsLimit[k] || (k === 'ngay' ? 300 : 80)) + 200; renderList(); } });
  document.addEventListener('click', onRateClick);
  $('#themeBtn').onclick = toggleTheme;
  $('#ds-tim').addEventListener('input', renderList);
  ['#th-nam', '#th-thang', '#th-nguoi'].forEach(s => $(s).addEventListener('change', renderSummary));
  document.querySelectorAll('.nav button').forEach(b => (b.onclick = () => showTab(b.dataset.tab)));
  $('#syncBtn').onclick = () => sync();
  $('#cfg-url').value = state.cfg.url; $('#cfg-key').value = state.cfg.key;
  $('#cfg-save').onclick = saveConfig;
  $('#seedFile').onchange = e => e.target.files[0] && importSeed(e.target.files[0]);
  $('#exportBtn').onclick = exportCsv;
  $('#reloadBtn').onclick = () => sync();
  $('#budgetSave').onclick = saveBudgets;
  $('#tgTest').onclick = async () => { try { await apiPost({ action: 'testTelegram' }); toast('Đã gửi tin nhắn thử qua Telegram', 'ok'); } catch (e) { toast(e.message, 'err'); } };
  $('#loanAdd').onclick = () => openLoanEditor(null);
  $('#cmp-hm').innerHTML += catOpts;
  ['#f-hangmuc', '#ds-hangmuc', '#cmp-hm'].forEach(q => comboSelect($(q)));
  $('#cmp-hm').addEventListener('change', renderCompare);
  window.addEventListener('online', () => sync(true));
  resetForm();
  renderAll();
  if (!state.cfg.url) showTab('tab-cd'); else sync(true);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
document.addEventListener('DOMContentLoaded', init);
