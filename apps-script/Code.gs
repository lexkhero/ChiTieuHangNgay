/**
 * ChiTieuHangNgay – backend Google Apps Script (phiên bản 2)
 * Gắn vào file Google Sheet "Tính tiền hàng tháng". Tạo các sheet mới, không đụng sheet tháng cũ:
 *   - ChiTieuApp  : mỗi dòng là một khoản chi
 *   - PhanLoaiApp : tên khoản chi -> hạng mục (học dần khi bạn sửa)
 *   - CaiDatApp   : cấu hình dạng JSON (khoản vay, ngân sách…)
 *
 * Script properties (Cài đặt dự án > Thuộc tính tập lệnh):
 *   SECRET            : mã bí mật, bắt buộc
 *   TELEGRAM_TOKEN    : token bot Telegram (không bắt buộc, để nhận nhắc nợ)
 *   TELEGRAM_CHAT_ID  : chat id nhận tin nhắn
 *
 * Cần thêm các file LoanEngine.gs (cùng nội dung loan-engine.js), SoThang.gs (ghi vào sổ tháng)
 * và LichVay.gs (vẽ lịch trả nợ ra sheet "Lịch vay (app)") vào dự án.
 */

const SHEET_DATA = 'ChiTieuApp';
const SHEET_MAP = 'PhanLoaiApp';
const SHEET_CFG = 'CaiDatApp';
const COLS = ['id', 'ngay', 'thang', 'nguoi', 'loai', 'ten', 'tien', 'hangmuc', 'ghichu', 'nguon', 'capnhat', 'vitri'];
const MAP_COLS = ['ten', 'hangmuc', 'capnhat'];
const CFG_COLS = ['key', 'value', 'capnhat'];
const TZ = 'Asia/Ho_Chi_Minh';

function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }

function sheet_(name, cols) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // để dạng chữ, tránh Sheets tự đổi ngày/tháng/tên
    sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');
    const iTien = cols.indexOf('tien');
    if (iTien >= 0) sh.getRange(1, iTien + 1, sh.getMaxRows(), 1).setNumberFormat('#,##0');
  } else if (sh.getRange(1, cols.length).getValue() !== cols[cols.length - 1]) {
    // bản cũ thiếu cột mới (vitri): bổ sung tiêu đề, dữ liệu cũ để trống
    if (sh.getMaxColumns() < cols.length) sh.insertColumnsAfter(sh.getMaxColumns(), cols.length - sh.getMaxColumns());
    sh.getRange(1, cols.length).setValue(cols[cols.length - 1]).setFontWeight('bold');
    sh.getRange(1, cols.length, sh.getMaxRows(), 1).setNumberFormat('@');
  }
  return sh;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function readAll_(name, cols) {
  const sh = sheet_(name, cols);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, cols.length).getValues()
    .filter(r => r[0] !== '')
    .map(r => {
      const o = {};
      cols.forEach((c, i) => {
        let v = r[i];
        // phòng trường hợp Sheets tự đổi chuỗi ngày thành kiểu Date
        if (v instanceof Date) v = Utilities.formatDate(v, TZ, c === 'thang' ? 'yyyy-MM' : 'yyyy-MM-dd');
        o[c] = v;
      });
      return o;
    });
}

function readConfig_() {
  const cfg = {};
  readAll_(SHEET_CFG, CFG_COLS).forEach(r => {
    try { cfg[r.key] = JSON.parse(r.value); } catch (e) { cfg[r.key] = r.value; }
  });
  return cfg;
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!prop_('SECRET') || p.key !== prop_('SECRET')) return json_({ ok: false, error: 'Sai mã bí mật' });
  const action = p.action || 'list';
  if (action === 'ping') return json_({ ok: true, time: new Date().toISOString(), telegram: !!prop_('TELEGRAM_TOKEN') });
  if (action === 'list') {
    const records = readAll_(SHEET_DATA, COLS).map(r => { r.id = String(r.id); r.tien = Number(r.tien) || 0; return r; });
    return json_({ ok: true, records: records, phanloai: readAll_(SHEET_MAP, MAP_COLS), config: readConfig_() });
  }
  return json_({ ok: false, error: 'Action không hợp lệ' });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return json_({ ok: false, error: 'Dữ liệu gửi lên không phải JSON' }); }
  if (!prop_('SECRET') || body.key !== prop_('SECRET')) return json_({ ok: false, error: 'Sai mã bí mật' });

  if (body.action === 'testTelegram') {
    const ok = sendTelegram_('✅ ChiTieuHangNgay đã kết nối Telegram.');
    return json_({ ok: ok, error: ok ? '' : 'Chưa gửi được. Kiểm tra TELEGRAM_TOKEN và TELEGRAM_CHAT_ID' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const res = {};
    if (body.action === 'upsert') {
      const recs = body.records || [], ids = new Set(recs.map(r => String(r.id))), oldMap = {};
      readAll_(SHEET_DATA, COLS).forEach(r => { if (ids.has(String(r.id))) oldMap[String(r.id)] = r; });
      if (body.noBook) recs.forEach(r => { const o = oldMap[String(r.id)]; r.vitri = o ? o.vitri || '' : ''; });
      else res.soThang = dongBoSo_(recs, oldMap, readConfig_());
      res.upserted = upsert_(SHEET_DATA, COLS, recs);
    } else if (body.action === 'delete') {
      const ids = new Set((body.ids || []).map(String));
      const olds = readAll_(SHEET_DATA, COLS).filter(r => ids.has(String(r.id)));
      res.soThang = xoaSo_(olds, readConfig_());
      res.deleted = remove_(SHEET_DATA, body.ids || []);
    }
    else if (body.action === 'ghiBu') res.soThang = ghiBu_(body.thang || '', !!body.chiDem);
    else if (body.action === 'setMap') res.mapped = upsert_(SHEET_MAP, MAP_COLS, body.items || [], 'ten');
    else if (body.action === 'setConfig') {
      res.saved = upsert_(SHEET_CFG, CFG_COLS, [{ key: body.name, value: JSON.stringify(body.value) }], 'key');
      if (body.name === 'loans') { try { veLichVay_(); } catch (err) { res.lichVayLoi = err.message; } }
    }
    else return json_({ ok: false, error: 'Action không hợp lệ' });
    return json_(Object.assign({ ok: true }, res));
  } finally {
    lock.releaseLock();
  }
}

/** Thêm mới hoặc cập nhật theo khóa (mặc định id). */
function upsert_(name, cols, items, keyCol) {
  keyCol = keyCol || 'id';
  if (!items.length) return 0;
  const sh = sheet_(name, cols);
  const kIdx = cols.indexOf(keyCol);
  const last = sh.getLastRow();
  const keys = last >= 2 ? sh.getRange(2, kIdx + 1, last - 1, 1).getValues().map(r => String(r[0])) : [];
  const pos = {};
  keys.forEach((k, i) => (pos[k] = i + 2));
  const now = new Date().toISOString();
  const append = [], appendPos = {};
  items.forEach(it => {
    it.capnhat = now;
    const row = cols.map(c => (it[c] === undefined || it[c] === null ? '' : it[c]));
    const k = String(it[keyCol]);
    if (pos[k]) sh.getRange(pos[k], 1, 1, cols.length).setValues([row]);
    else if (appendPos[k] !== undefined) append[appendPos[k]] = row;
    else { appendPos[k] = append.length; append.push(row); }
  });
  if (append.length) {
    const r0 = sh.getLastRow() + 1;
    if (r0 + append.length - 1 > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), r0 + append.length - 1 - sh.getMaxRows() + 200);
    const rg = sh.getRange(r0, 1, append.length, cols.length);
    rg.setNumberFormat('@');
    const iTien = cols.indexOf('tien');
    if (iTien >= 0) sh.getRange(r0, iTien + 1, append.length, 1).setNumberFormat('#,##0');
    rg.setValues(append);
  }
  return items.length;
}

function remove_(name, ids) {
  if (!ids.length) return 0;
  const sh = sheet_(name, COLS);
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const want = new Set(ids.map(String));
  const keys = sh.getRange(2, 1, last - 1, 1).getValues().map(r => String(r[0]));
  let n = 0;
  for (let i = keys.length - 1; i >= 0; i--) if (want.has(keys[i])) { sh.deleteRow(i + 2); n++; }
  return n;
}

/* ------------------------------------------------------------------ */
/* Telegram: nhắc đến hạn trả nợ, cảnh báo ngân sách, tổng kết tháng   */
/* ------------------------------------------------------------------ */

function sendTelegram_(text) {
  const token = prop_('TELEGRAM_TOKEN'), chat = prop_('TELEGRAM_CHAT_ID');
  if (!token || !chat) return false;
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ chat_id: chat, text: text, parse_mode: 'HTML', disable_web_page_preview: true })
  });
  return res.getResponseCode() === 200;
}

function vnd_(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' đ'; }
function dmy_(s) { return s.slice(8, 10) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4); }

/** Chạy hằng ngày (cài bằng hàm caiNhacHangNgay). */
function nhacHangNgay() {
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const cfg = readConfig_();
  const lines = [];
  try { veLichVay_(cfg); } catch (e) { Logger.log('Vẽ lịch vay lỗi: ' + e.message); }   // cập nhật trạng thái Đã trả / Kỳ tới

  // 1) Khoản vay sắp đến hạn
  (cfg.loans || []).forEach(l => {
    const s = LoanEngine.schedule(l, today);
    const k = s.ky_toi;
    if (!k) return;
    const truoc = l.nhac_truoc === undefined || l.nhac_truoc === '' ? 5 : +l.nhac_truoc;
    if (s.con_ngay <= truoc) {
      const khi = s.con_ngay === 0 ? '<b>HÔM NAY</b>' : 'còn <b>' + s.con_ngay + ' ngày</b>';
      lines.push('🏦 <b>' + l.ten + '</b>: kỳ ' + dmy_(k.ngay) + ' (' + khi + ')\n' +
        '   Gốc ' + vnd_(k.goc) + ' + Lãi ' + vnd_(k.lai) + ' = <b>' + vnd_(k.tong) + '</b>\n' +
        '   Dư nợ ' + vnd_(s.du_no_hien_tai) + ', lãi tạm tính đến nay ' + vnd_(s.lai_tam_tinh));
    }
  });

  // 2) Ngân sách tháng này
  const budgets = cfg.budgets || {};
  const month = today.slice(0, 7);
  if (Object.keys(budgets).length) {
    const spent = {};
    readAll_(SHEET_DATA, COLS).forEach(r => {
      if (String(r.thang) === month) spent[r.hangmuc] = (spent[r.hangmuc] || 0) + (Number(r.tien) || 0);
    });
    Object.keys(budgets).forEach(c => {
      const b = +budgets[c], v = spent[c] || 0;
      if (b > 0 && v >= b * 0.9) lines.push((v > b ? '🔴 ' : '🟠 ') + c + ': ' + vnd_(v) + ' / ' + vnd_(b) + ' (' + Math.round(v / b * 100) + '%)');
    });
  }

  if (lines.length) sendTelegram_('📅 <b>Chi tiêu – ' + dmy_(today) + '</b>\n\n' + lines.join('\n\n'));

  // 3) Ngày 1 hằng tháng: tổng kết tháng trước
  if (today.slice(8, 10) === '01') tongKetThangTruoc_(today);
}

function tongKetThangTruoc_(today) {
  const d = new Date(+today.slice(0, 4), +today.slice(5, 7) - 2, 1);
  const m = Utilities.formatDate(d, TZ, 'yyyy-MM');
  const mPrevYear = (+m.slice(0, 4) - 1) + m.slice(4);
  let total = 0, lastYear = 0;
  const cats = {};
  readAll_(SHEET_DATA, COLS).forEach(r => {
    const t = String(r.thang), v = Number(r.tien) || 0;
    if (t === m) { total += v; cats[r.hangmuc] = (cats[r.hangmuc] || 0) + v; }
    if (t === mPrevYear) lastYear += v;
  });
  const top = Object.keys(cats).sort((a, b) => cats[b] - cats[a]).slice(0, 6)
    .map(c => '• ' + c + ': ' + vnd_(cats[c])).join('\n');
  let cmp = '';
  if (lastYear) cmp = '\nCùng kỳ năm trước: ' + vnd_(lastYear) + ' (' + (total >= lastYear ? '+' : '') + Math.round((total - lastYear) / lastYear * 100) + '%)';
  sendTelegram_('📊 <b>Tổng kết tháng ' + m.slice(5) + '/' + m.slice(0, 4) + '</b>\nTổng chi: <b>' + vnd_(total) + '</b>' + cmp + '\n\n' + top);
}

/* ------------------------------------------------------------------ */
/* Các hàm chạy tay trong trình soạn Apps Script                       */
/* ------------------------------------------------------------------ */

/** Chạy một lần: tạo các sheet. */
function setup() {
  sheet_(SHEET_DATA, COLS);
  sheet_(SHEET_MAP, MAP_COLS);
  sheet_(SHEET_CFG, CFG_COLS);
}

/** Chạy một lần: cài lịch nhắc hằng ngày lúc 7 giờ sáng. */
function caiNhacHangNgay() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'nhacHangNgay') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('nhacHangNgay').timeBased().everyDays(1).atHour(7).inTimezone(TZ).create();
}

/** Thử gửi tin nhắn Telegram. */
function thuTelegram() {
  Logger.log(sendTelegram_('✅ ChiTieuHangNgay đã kết nối Telegram.') ? 'Đã gửi' : 'Chưa gửi được – kiểm tra token/chat id');
}
