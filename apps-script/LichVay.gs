/**
 * Vẽ lịch trả nợ do app tính ra sheet riêng "Lịch vay (app)" (chiều app → sheet).
 * Không đụng tới các sheet tự lập "Trả nợ ô tô", "Trả nợ nhà".
 * Tự vẽ lại khi: lưu khoản vay trên app (setConfig loans), mỗi sáng lúc chạy nhacHangNgay, hoặc chạy tay hàm veLichVay.
 * Cần LoanEngine.gs cùng dự án.
 */

const SHEET_LICH = 'Lịch vay (app)';
const LICH_COT = ['Kỳ', 'Ngày trả', 'Từ ngày', 'Số ngày', 'Dư nợ đầu kỳ', 'Lãi suất (%/năm)', 'Gốc', 'Lãi', 'Tổng trả', 'Trả trước gốc', 'Trạng thái', 'Cách tính lãi'];

/** 'YYYY-MM-DD' -> Date lúc 12 giờ trưa theo múi giờ của file Sheet.
 *  (new Date(y, m, d) theo múi giờ của dự án Apps Script làm ô ngày trên Sheet bị lùi 1 ngày khi hai múi giờ khác nhau) */
function ngay_(s) { return Utilities.parseDate(String(s) + ' 12:00', SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm'); }
function dmy2_(s) { return String(s).slice(8, 10) + '/' + String(s).slice(5, 7) + '/' + String(s).slice(0, 4); }
function dm_(s) { return s.slice(8, 10) + '/' + s.slice(5, 7); }
function ls_(x) { return String(x).replace('.', ',') + '%'; }
function tenGoc_(t) { return String(t || '').replace(/\s*\(.*\)\s*$/, ''); }

/** Vẽ lại toàn bộ sheet lịch vay. Trả về số khoản vay đã vẽ. */
function veLichVay_(cfg) {
  cfg = cfg || readConfig_();
  const loans = cfg.loans || [], today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_LICH);
  if (!sh) sh = ss.insertSheet(SHEET_LICH);
  sh.clear();
  const N = LICH_COT.length, rows = [], fm = [];   // fm: định dạng cần áp {r, kieu}
  const push = (arr, kieu) => { const a = arr.slice(0, N); while (a.length < N) a.push(''); rows.push(a); if (kieu) fm.push({ r: rows.length, kieu: kieu }); };

  push(['Lịch trả nợ do app ChiTieuHangNgay tính, cập nhật ' + Utilities.formatDate(new Date(), TZ, 'dd/MM/yyyy HH:mm') +
    '. Không sửa tay ở đây: sửa khoản vay trên app, sheet này tự vẽ lại.'], 'ghichu');
  push([]);

  // gom theo nhóm (các khoản đảo nợ nối tiếp dùng chung nhóm)
  const nhom = [], idx = {};
  loans.forEach(l => {
    let s; try { s = LoanEngine.schedule(l, today); } catch (e) { s = null; }
    const k = l.nhom || l.id;
    if (idx[k] === undefined) { idx[k] = nhom.length; nhom.push({ ten: tenGoc_(l.ten), ds: [] }); }
    nhom[idx[k]].ds.push({ l: l, s: s });
  });

  nhom.forEach(g => {
    const ok = g.ds.filter(x => x.s), all = [];
    ok.forEach(x => x.s.rows.forEach(r => all.push(r)));
    const daTra = all.filter(r => r.da_qua), conLai = all.filter(r => !r.da_qua);
    const tiep = ok.map(x => x.s.ky_toi).filter(Boolean).sort((a, b) => a.ngay < b.ngay ? -1 : 1)[0];
    push([g.ten.toUpperCase()], 'nhom');
    push(['Số tiền vay', '', 'Dư nợ hiện tại', '', 'Gốc đã trả', '', 'Lãi đã trả', '', 'Lãi còn phải trả', '', 'Kỳ tới'], 'nhan');
    push([g.ds[0].l.so_tien_vay, '',
      ok.filter(x => x.s.ky_toi).reduce((a, x) => a + x.s.du_no_hien_tai, 0), '',
      daTra.reduce((a, r) => a + (r.dao_no ? 0 : r.goc) + r.tra_truoc, 0), '',
      daTra.reduce((a, r) => a + r.lai, 0), '',
      conLai.reduce((a, r) => a + r.lai, 0), '',
      tiep ? dmy2_(tiep.ngay) + ': ' + vnd_(tiep.tong) : 'Đã tất toán'], 'tomtat');
    push([]);

    g.ds.forEach(x => {
      const l = x.l, s = x.s;
      const mucLai = (l.lai_suat || []).slice().sort((a, b) => a.tu_ngay < b.tu_ngay ? -1 : 1)
        .map(r => ls_(r.nam) + ' từ ' + dmy2_(r.tu_ngay)).join(', ');
      push([l.ten + ' · giải ngân ' + dmy2_(l.ngay_giai_ngan) + ' · ' + vnd_(l.so_tien_vay) +
        ' · ' + (l.kieu === 'tra_lai' ? 'trả lãi hằng tháng, gốc cuối kỳ' : 'trả góp gốc ' + vnd_(l.goc_moi_ky) + '/tháng') + ' · lãi suất: ' + mucLai], 'khoan');
      if (!s) { push(['Cấu hình khoản vay lỗi, kiểm tra lại trên app']); push([]); return; }
      if (!s.dao_han) push(['Chưa có ngày đáo hạn: lịch dưới đây là ' + s.rows.length + ' kỳ dự kiến, nhập ngày đáo hạn hoặc đảo nợ trên app khi có.'], 'ghichu');
      push(LICH_COT, 'tieude');
      const r0 = rows.length + 1;
      s.rows.forEach(r => {
        const rates = r.chi_tiet_lai.map(p => p.lai_suat).filter((v, i, a) => a.indexOf(v) === i).map(ls_).join(' → ');
        const cach = r.chi_tiet_lai.map(p => dm_(p.tu) + '→' + dm_(p.den) + ': ' + p.so_ngay + ' ngày × ' + vnd_(p.du_no).replace(' đ', '') +
          ' × ' + ls_(p.lai_suat) + '/365 = ' + vnd_(p.lai).replace(' đ', '')).join('; ');
        const tt = r.dao_no ? 'Gốc trả bằng khoản vay mới' : r.da_qua ? 'Đã trả' : s.ky_toi && r.ky === s.ky_toi.ky ? 'Kỳ tới' : '';
        push([r.ky, ngay_(r.ngay), ngay_(r.tu_ngay), r.so_ngay, r.du_no_dau, rates, r.goc, r.lai, r.tong, r.tra_truoc || '', tt, cach],
          r.da_qua ? 'qua' : tt === 'Kỳ tới' ? 'toi' : 'dong');
      });
      const r1 = rows.length;
      push(['Cộng', '', '', '', '', '',
        s.rows.reduce((a, r) => a + r.goc, 0), s.rows.reduce((a, r) => a + r.lai, 0),
        s.rows.reduce((a, r) => a + r.tong, 0), s.rows.reduce((a, r) => a + r.tra_truoc, 0) || ''], 'cong');
      fm.push({ r: r0, den: r1, kieu: 'so' });
      push([]);
    });
    push([]);
  });

  sh.getRange(1, 1, rows.length, N).setValues(rows);
  // định dạng
  fm.forEach(f => {
    const rg = sh.getRange(f.r, 1, 1, N);
    if (f.kieu === 'ghichu') rg.setFontStyle('italic').setFontColor('#666666');
    if (f.kieu === 'nhom') rg.setFontWeight('bold').setFontSize(13).setBackground('#dbe4ff');
    if (f.kieu === 'nhan') rg.setFontColor('#555555');
    if (f.kieu === 'tomtat') rg.setFontWeight('bold').setNumberFormat('#,##0');
    if (f.kieu === 'khoan') rg.setFontWeight('bold');
    if (f.kieu === 'tieude') rg.setFontWeight('bold').setBackground('#eef0f6');
    if (f.kieu === 'qua') rg.setFontColor('#8a8a8a');
    if (f.kieu === 'toi') rg.setFontWeight('bold').setBackground('#fff3c4');
    if (f.kieu === 'cong') rg.setFontWeight('bold').setBackground('#eef0f6').setNumberFormat('#,##0');
    if (f.kieu === 'so') {
      const n = f.den - f.r + 1;
      sh.getRange(f.r, 2, n, 2).setNumberFormat('dd/MM/yyyy');
      sh.getRange(f.r, 5, n, 1).setNumberFormat('#,##0');
      sh.getRange(f.r, 7, n, 4).setNumberFormat('#,##0');
    }
  });
  sh.setFrozenRows(1);
  [44, 90, 90, 60, 120, 120, 110, 100, 110, 100, 120, 520].forEach((w, i) => sh.setColumnWidth(i + 1, w));
  return loans.length;
}

/** Chạy tay trong trình soạn Apps Script để vẽ lại lịch vay. */
function veLichVay() { Logger.log('Đã vẽ ' + veLichVay_() + ' khoản vay vào sheet ' + SHEET_LICH); }
