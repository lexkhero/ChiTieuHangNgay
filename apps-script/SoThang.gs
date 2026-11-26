/**
 * Ghi khoản chi nhập từ app vào sổ tháng ("Tháng 12/2026"…) theo đúng bố cục sổ cũ.
 *
 * Bố cục sổ (tự dò, không cố định số dòng/cột):
 *   - Khối "Chung": dưới dòng có ô "Tiêu đề" ở cột A (cột A tên, cột B tiền), kéo đến ngay trên dòng tên người.
 *   - Dòng tên người (Chồng, Vợ, Jun, Putin, Út); dòng kế tiếp ghi "Sinh hoạt" / "Phát sinh".
 *     Mỗi cột "Sinh hoạt"/"Phát sinh" là cột tên, cột bên phải là cột tiền. Dữ liệu từ dòng sau đó trở xuống.
 *   - Ô tổng "Chồng tiêu sinh hoạt" … có công thức =SUM(B18:B56): ghi quá dòng cuối thì tự nới công thức.
 *
 * Vị trí đã ghi lưu ở cột "vitri" của ChiTieuApp dạng "Tháng 12/2026!B18" (ô tiền; ô tên ở bên trái),
 * giống cột ghi chú của dữ liệu nạp từ sổ cũ. Sửa/xóa trên app sẽ sửa/xóa đúng ô đó,
 * nhưng chỉ khi ô vẫn còn đúng tên và số tiền cũ (để không ghi đè thứ bạn đã tự sửa trên sổ).
 *
 * Cấu hình (CaiDatApp): ghi_so = false để tắt; so_mau = tên sheet làm mẫu khi tạo sổ tháng mới.
 */

const SO_MAU_MAC_DINH = 'Tháng 11/2026';
const SO_TU_THANG = '2026-11';            // chỉ tự tạo sổ mới cho tháng từ đây trở đi
const CHUNG_TIEU_DE = ['Tiền điện', 'Tiền nước', 'Tiền điện thoại', 'Tiền mạng', 'Tiền spotify', 'Đi chợ'];
const SUM_DEN_DONG_TOI_THIEU = 300;        // sổ mới: công thức tổng cộng đến ít nhất dòng này

function fold_(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/\s+/g, ' ').trim();
}
function tenSo_(thang) { const p = String(thang).split('-'); return 'Tháng ' + (+p[1]) + '/' + p[0]; }
function laVitri_(s) { return /^.+![A-Z]{1,3}\d+$/.test(String(s || '')); }
function tachVitri_(s) {
  const m = /^(.+)!([A-Z]{1,3})(\d+)$/.exec(String(s));
  return m ? { ten: m[1], cot: colNum_(m[2]), dong: +m[3] } : null;
}
function colNum_(a) { let n = 0; for (const ch of a) n = n * 26 + ch.charCodeAt(0) - 64; return n; }
function colChu_(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; } return s; }
function laChung_(r) { return r.nguoi === 'Chung' || r.loai === 'Chung'; }

/** Dò bố cục một sổ tháng. Dòng/cột trả về đánh số từ 1. */
function bocSo_(sh) {
  const nR = Math.min(Math.max(sh.getLastRow(), 20), 80), nC = Math.min(sh.getMaxColumns(), 40);
  const v = sh.getRange(1, 1, nR, nC).getDisplayValues();
  let hdr = -1;
  for (let r = 0; r < nR - 1 && hdr < 0; r++) {
    const sub = v[r + 1].map(fold_);
    if (sub.indexOf('sinh hoat') >= 0 && sub.indexOf('phat sinh') >= 0 && v[r].some(x => String(x).trim())) hdr = r;
  }
  if (hdr < 0) throw new Error('Sổ "' + sh.getName() + '" không đúng mẫu (không thấy dòng Sinh hoạt / Phát sinh)');
  const nguoi = {};
  for (let c = 0; c < nC; c++) {
    const ten = String(v[hdr][c]).trim(); if (!ten) continue;
    const o = {};
    for (let k = c; k < Math.min(c + 5, nC); k++) {
      const t = fold_(v[hdr + 1][k]);
      if (t === 'sinh hoat' && !o.sh) o.sh = k + 1;
      if (t === 'phat sinh' && !o.ps) o.ps = k + 1;
    }
    if (o.sh || o.ps) nguoi[fold_(ten)] = o;
  }
  let td = -1;
  for (let r = 0; r < hdr; r++) if (fold_(v[r][0]) === 'tieu de') { td = r; break; }
  const tong = {};   // "chong tieu sinh hoat" -> {dong, cot}
  for (let r = 0; r < hdr; r++) for (let c = 0; c < nC - 1; c++) {
    const t = fold_(v[r][c]); if (/ tieu (sinh hoat|phat sinh)$/.test(t)) tong[t] = { dong: r + 1, cot: c + 2 };
  }
  return { hdr: hdr + 1, dataTu: hdr + 3, chungTu: td >= 0 ? td + 2 : 0, chungDen: hdr + 1, nguoi: nguoi, tong: tong };
}

/** Lấy sổ tháng; chưa có thì tạo từ sổ mẫu (nếu được phép). */
function laySo_(thang, cfg, taoMoi) {
  const ss = SpreadsheetApp.getActiveSpreadsheet(), ten = tenSo_(thang);
  let sh = ss.getSheetByName(ten);
  if (sh || !taoMoi || String(thang) < SO_TU_THANG) return sh;
  const tenMau = cfg.so_mau || SO_MAU_MAC_DINH, mau = ss.getSheetByName(tenMau);
  if (!mau) throw new Error('Không thấy sổ mẫu "' + tenMau + '" để tạo ' + ten);
  sh = mau.copyTo(ss).setName(ten);
  ss.setActiveSheet(sh); ss.moveActiveSheet(mau.getIndex() + 1);
  const L = bocSo_(sh), last = sh.getLastRow();
  // khối Chung: xóa số tiền (giữ công thức), giữ tiêu đề cố định
  if (L.chungTu) {
    const n = L.chungDen - L.chungTu, rg = sh.getRange(L.chungTu, 1, n, 2);
    const vals = rg.getValues(), fo = rg.getFormulas(), tieuDe = CHUNG_TIEU_DE.map(fold_);
    for (let i = 0; i < n; i++) {
      if (!fo[i][0] && vals[i][0] !== '' && tieuDe.indexOf(fold_(vals[i][0])) < 0) sh.getRange(L.chungTu + i, 1).clearContent();
      if (!fo[i][1] && vals[i][1] !== '') sh.getRange(L.chungTu + i, 2).clearContent();
    }
  }
  // khối người: xóa toàn bộ dòng dữ liệu
  const maxCot = Math.max.apply(null, Object.keys(L.nguoi).map(k => Math.max(L.nguoi[k].sh || 0, L.nguoi[k].ps || 0) + 1));
  if (last >= L.dataTu) sh.getRange(L.dataTu, 1, last - L.dataTu + 1, maxCot).clearContent();
  // nới công thức tổng để không bỏ sót dòng
  Object.keys(L.tong).forEach(k => noiTong_(sh, L.tong[k], SUM_DEN_DONG_TOI_THIEU));
  return sh;
}

/** Công thức =SUM(B18:B56): nếu dòng cuối < den thì đổi thành den. */
function noiTong_(sh, o, den) {
  const cell = sh.getRange(o.dong, o.cot), f = cell.getFormula();
  const m = /^=SUM\(\s*([A-Z]{1,3})(\d+)\s*:\s*([A-Z]{1,3})(\d+)\s*\)$/i.exec(f);
  if (m && +m[4] < den) cell.setFormula('=SUM(' + m[1] + m[2] + ':' + m[3] + den + ')');
}

/** Ghi một khoản vào sổ. Trả về vị trí ô tiền dạng "Tháng 12/2026!B18". */
function ghiVaoSo_(rec, cfg) {
  const sh = laySo_(rec.thang, cfg, true);
  if (!sh) return '';
  const L = bocSo_(sh), tien = Number(rec.tien) || 0, ten = String(rec.ten);
  if (laChung_(rec)) {
    if (!L.chungTu) throw new Error('Sổ ' + sh.getName() + ' không có khối Chung (ô "Tiêu đề")');
    const n = L.chungDen - L.chungTu;
    const v = sh.getRange(L.chungTu, 1, n, 2).getValues();
    // 1) dòng có sẵn đúng tiêu đề mà chưa có tiền (Tiền điện, Tiền nước…)
    const fmtT = sh.getRange(L.chungTu, 2).getNumberFormat();
    for (let i = 0; i < n; i++) if (fold_(v[i][0]) === fold_(ten) && v[i][1] === '') {
      sh.getRange(L.chungTu + i, 2).setValue(tien); return sh.getName() + '!B' + (L.chungTu + i);
    }
    // 2) dòng trống
    for (let i = 0; i < n; i++) if (v[i][0] === '' && v[i][1] === '') {
      sh.getRange(L.chungTu + i, 1, 1, 2).setValues([[ten, tien]]); return sh.getName() + '!B' + (L.chungTu + i);
    }
    // 3) hết chỗ: chèn thêm một dòng trong khối (công thức tổng tự nới theo)
    const r = L.chungDen - 1;
    sh.insertRowBefore(r);
    sh.getRange(r, 1, 1, 2).setValues([[ten, tien]]); sh.getRange(r, 2).setNumberFormat(fmtT);
    return sh.getName() + '!B' + r;
  }
  const p = L.nguoi[fold_(rec.nguoi)];
  if (!p) throw new Error('Sổ ' + sh.getName() + ' không có cột cho "' + rec.nguoi + '"');
  const cot = rec.loai === 'Phát sinh' ? p.ps : p.sh;
  if (!cot) throw new Error('Sổ ' + sh.getName() + ' không có cột ' + rec.loai + ' của ' + rec.nguoi);
  const den = Math.max(sh.getLastRow(), L.dataTu);
  const v = sh.getRange(L.dataTu, cot, den - L.dataTu + 1, 2).getValues();
  let r = den + 1;
  for (let i = 0; i < v.length; i++) if (v[i][0] === '' && v[i][1] === '') { r = L.dataTu + i; break; }
  if (r > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 50);
  const fmtT = sh.getRange(L.dataTu, cot + 1).getNumberFormat();
  sh.getRange(r, cot, 1, 2).setValues([[ten, tien]]); sh.getRange(r, cot + 1).setNumberFormat(fmtT);
  const t = L.tong[fold_(rec.nguoi + ' tieu ' + rec.loai)];
  if (t) noiTong_(sh, t, r);
  return sh.getName() + '!' + colChu_(cot + 1) + r;
}

/** Ô ở vitri còn đúng khoản cũ không (tên trùng hoặc để trống, số tiền trùng). */
function khop_(sh, o, old) {
  const vals = sh.getRange(o.dong, o.cot - 1, 1, 2).getValues()[0];
  const ten = vals[0], tien = Number(vals[1]);
  return Math.round(tien) === Math.round(Number(old.tien) || 0) && (ten === '' || fold_(ten) === fold_(old.ten));
}

/** Xóa khoản cũ khỏi sổ. Trả về true nếu đã xóa. */
function xoaKhoiSo_(vitri, old) {
  const o = tachVitri_(vitri); if (!o) return false;
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(o.ten);
  if (!sh || o.cot < 2 || !khop_(sh, o, old)) return false;
  const tenCu = sh.getRange(o.dong, o.cot - 1).getValue();
  const giuTieuDe = CHUNG_TIEU_DE.map(fold_).indexOf(fold_(tenCu)) >= 0;
  if (giuTieuDe) sh.getRange(o.dong, o.cot).clearContent();
  else sh.getRange(o.dong, o.cot - 1, 1, 2).clearContent();
  return true;
}

/** vị trí đang ghi của một khoản (app ghi vào vitri; dữ liệu nạp từ sổ cũ ghi ở ghichu) */
function vitriCua_(r) { return r && (r.vitri || (r.nguon === 'so-cu' && laVitri_(r.ghichu) ? r.ghichu : '')) || ''; }
const khoiCua_ = r => laChung_(r) ? r.thang + '|Chung' : r.thang + '|' + r.nguoi + '|' + r.loai;

/**
 * Đồng bộ sổ tháng cho các khoản sắp upsert. old: map id -> dòng cũ trong ChiTieuApp.
 * Gán rec.vitri; trả về { ghi, loi: [] }.
 */
function dongBoSo_(recs, oldMap, cfg) {
  const kq = { ghi: 0, loi: [] };
  if (cfg.ghi_so === false) { recs.forEach(r => { const o = oldMap[r.id]; r.vitri = o ? o.vitri || '' : ''; }); return kq; }
  recs.forEach(rec => {
    const old = oldMap[String(rec.id)], vt = vitriCua_(old);
    rec.vitri = old ? old.vitri || '' : '';
    try {
      if (!old) {                                   // khoản mới: chỉ ghi khoản nhập từ app
        if (rec.nguon !== 'app') return;
        rec.vitri = ghiVaoSo_(rec, cfg); if (rec.vitri) kq.ghi++;
        return;
      }
      const doi = ['ten', 'thang', 'nguoi', 'loai'].some(k => String(old[k]) !== String(rec[k])) || Math.round(+old.tien) !== Math.round(+rec.tien);
      if (!doi) return;
      if (vt) {
        const o = tachVitri_(vt), sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(o.ten);
        if (khoiCua_(old) === khoiCua_(rec) && sh && khop_(sh, o, old)) {   // cùng khối: sửa tại chỗ
          const tenCu = sh.getRange(o.dong, o.cot - 1).getValue();
          const giu = CHUNG_TIEU_DE.map(fold_).indexOf(fold_(tenCu)) >= 0 && fold_(tenCu) === fold_(rec.ten);
          if (giu) sh.getRange(o.dong, o.cot).setValue(+rec.tien);
          else sh.getRange(o.dong, o.cot - 1, 1, 2).setValues([[rec.ten, +rec.tien]]);
          rec.vitri = vt; kq.ghi++;
          return;
        }
        if (!xoaKhoiSo_(vt, old)) kq.loi.push('Không xóa được "' + old.ten + '" ở ' + vt + ' (ô trên sổ đã bị sửa tay), hãy xóa tay');
      }
      rec.vitri = ghiVaoSo_(rec, cfg); if (rec.vitri) kq.ghi++;
      if (vt && rec.ghichu === vt) rec.ghichu = '';
    } catch (e) { kq.loi.push(rec.ten + ': ' + e.message); }
  });
  return kq;
}

/** Xóa trên sổ các khoản sắp bị xóa khỏi ChiTieuApp. */
function xoaSo_(olds, cfg) {
  const kq = { xoa: 0, loi: [] };
  if (cfg.ghi_so === false) return kq;
  olds.forEach(old => {
    const vt = vitriCua_(old); if (!vt) return;
    try { if (xoaKhoiSo_(vt, old)) kq.xoa++; else kq.loi.push('Không xóa được "' + old.ten + '" ở ' + vt + ' (ô trên sổ đã bị sửa tay), hãy xóa tay'); }
    catch (e) { kq.loi.push(old.ten + ': ' + e.message); }
  });
  return kq;
}

/** Ghi bù các khoản đã nhập từ app nhưng chưa có trên sổ (thang: 'YYYY-MM' hoặc bỏ trống = tất cả). */
function ghiBu_(thang, chiDem) {
  const cfg = readConfig_(), all = readAll_(SHEET_DATA, COLS);
  const can = all.filter(r => r.nguon === 'app' && !r.vitri && (!thang || String(r.thang) === thang));
  if (chiDem) return { can: can.length, thang: [...new Set(can.map(r => String(r.thang)))].sort() };
  const oldMap = {}; // để dongBoSo_ coi như khoản mới
  const recs = can.map(r => Object.assign({}, r, { id: String(r.id), tien: Number(r.tien) || 0 }));
  const kq = dongBoSo_(recs, oldMap, Object.assign({}, cfg, { ghi_so: true }));
  upsert_(SHEET_DATA, COLS, recs.filter(r => r.vitri));
  return kq;
}

/** Chạy tay trong trình soạn Apps Script: ghi bù tất cả khoản nhập từ app chưa có trên sổ. */
function ghiBuSoThang() { Logger.log(JSON.stringify(ghiBu_(''))); }
