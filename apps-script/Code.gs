/**
 * ChiTieuHangNgay – backend Google Apps Script
 * Gắn vào file Google Sheet "Tính tiền hàng tháng".
 * Tạo 2 sheet mới (không đụng các sheet tháng cũ):
 *   - ChiTieuApp  : mỗi dòng là một khoản chi
 *   - PhanLoaiApp : bảng tên khoản chi -> hạng mục (học dần khi bạn sửa)
 *
 * Mã bí mật: vào Project Settings > Script properties, thêm khóa SECRET.
 */

const SHEET_DATA = 'ChiTieuApp';
const SHEET_MAP = 'PhanLoaiApp';
const COLS = ['id', 'ngay', 'thang', 'nguoi', 'loai', 'ten', 'tien', 'hangmuc', 'ghichu', 'nguon', 'capnhat'];
const MAP_COLS = ['ten', 'hangmuc', 'capnhat'];

function getSecret_() {
  return PropertiesService.getScriptProperties().getProperty('SECRET') || '';
}

function sheet_(name, cols) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // Cột ngày/tháng/tên để dạng chữ để Sheets không tự đổi định dạng
    sh.getRange('A:F').setNumberFormat('@');
    sh.getRange('H:K').setNumberFormat('@');
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
  const values = sh.getRange(2, 1, last - 1, cols.length).getValues();
  return values
    .filter(r => r[0] !== '')
    .map(r => {
      const o = {};
      cols.forEach((c, i) => (o[c] = r[i]));
      return o;
    });
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.key !== getSecret_()) return json_({ ok: false, error: 'Sai mã bí mật' });
  const action = p.action || 'list';
  if (action === 'ping') return json_({ ok: true, time: new Date().toISOString() });
  if (action === 'list') {
    const records = readAll_(SHEET_DATA, COLS).map(r => {
      r.tien = Number(r.tien) || 0;
      return r;
    });
    const phanloai = readAll_(SHEET_MAP, MAP_COLS);
    return json_({ ok: true, records: records, phanloai: phanloai });
  }
  return json_({ ok: false, error: 'Action không hợp lệ' });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Dữ liệu gửi lên không phải JSON' });
  }
  if (body.key !== getSecret_()) return json_({ ok: false, error: 'Sai mã bí mật' });

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    let res = {};
    if (body.action === 'upsert') res.upserted = upsert_(SHEET_DATA, COLS, body.records || []);
    else if (body.action === 'delete') res.deleted = remove_(SHEET_DATA, COLS, body.ids || []);
    else if (body.action === 'setMap') res.mapped = upsert_(SHEET_MAP, MAP_COLS, body.items || [], 'ten');
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
  const append = [];
  items.forEach(it => {
    it.capnhat = now;
    const row = cols.map(c => (it[c] === undefined || it[c] === null ? '' : it[c]));
    const k = String(it[keyCol]);
    if (pos[k]) sh.getRange(pos[k], 1, 1, cols.length).setValues([row]);
    else {
      append.push(row);
      pos[k] = -1;
    }
  });
  if (append.length) sh.getRange(sh.getLastRow() + 1, 1, append.length, cols.length).setValues(append);
  return items.length;
}

function remove_(name, cols, ids) {
  if (!ids.length) return 0;
  const sh = sheet_(name, cols);
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const want = new Set(ids.map(String));
  const keys = sh.getRange(2, 1, last - 1, 1).getValues().map(r => String(r[0]));
  let n = 0;
  for (let i = keys.length - 1; i >= 0; i--) {
    if (want.has(keys[i])) {
      sh.deleteRow(i + 2);
      n++;
    }
  }
  return n;
}

/** Chạy tay một lần trong trình soạn Apps Script để tạo sẵn 2 sheet. */
function setup() {
  sheet_(SHEET_DATA, COLS);
  sheet_(SHEET_MAP, MAP_COLS);
}
