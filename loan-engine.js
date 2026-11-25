/*
 * Bộ tính lịch trả nợ – dùng chung cho trang web (loan-engine.js) và Apps Script (LoanEngine.gs).
 * Lãi tính theo ngày: Dư nợ × lãi suất năm / 365 × số ngày, tách đoạn khi đổi lãi suất hoặc trả trước gốc.
 *
 * Cấu hình một khoản vay:
 * {
 *   id, ten,
 *   kieu: 'tra_gop' (gốc đều mỗi kỳ) | 'tra_lai' (hằng tháng chỉ trả lãi, gốc trả cuối kỳ),
 *   so_tien_vay, ngay_giai_ngan: 'YYYY-MM-DD', so_thang (bỏ trống nếu chưa biết đáo hạn),
 *   ngay_tra: 15, goc_moi_ky, ky_dau: 'YYYY-MM' (tháng trả kỳ đầu),
 *   lui_ngay_nghi: true  -> rơi vào thứ 7/CN thì dời sang thứ 2,
 *   lai_suat:   [{ tu_ngay: 'YYYY-MM-DD', nam: 6.2 }],
 *   tra_truoc:  [{ ngay: 'YYYY-MM-DD', so_tien, ghi_chu }],
 *   tam_dung_goc: [{ tu_ky: 'YYYY-MM', den_ky: 'YYYY-MM' }],
 *   doi_ngay:   { 'YYYY-MM': 'YYYY-MM-DD' }  -> ngày trả thực tế khác lịch (lễ, Tết…),
 *   nhac_truoc: 5,
 *   ngay_ket_thuc: 'YYYY-MM-DD'  -> ngày đáo hạn cụ thể (thay cho so_thang); trước ngày này vẫn trả theo lịch thường,
 *   dao_no: true  -> gốc cuối kỳ được trả bằng khoản vay mới (đảo nợ), không tính là tiền gốc bỏ ra,
 *   nhom: 'nha'   -> các khoản vay nối tiếp nhau (đảo nợ) cùng một nhóm
 * }
 */
var LoanEngine = (function () {
  var DAY = 86400000;
  function d(s) { var p = String(s).slice(0, 10).split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function iso(t) { return new Date(t).toISOString().slice(0, 10); }
  function ym(t) { return iso(t).slice(0, 7); }
  function addMonths(t, n, day) {
    var x = new Date(t), y = x.getUTCFullYear(), m = x.getUTCMonth() + n;
    var dd = day || x.getUTCDate();
    var last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return Date.UTC(y, m, Math.min(dd, last));
  }
  function rollWeekend(t) {
    var w = new Date(t).getUTCDay();
    if (w === 6) return t + 2 * DAY;
    if (w === 0) return t + DAY;
    return t;
  }
  function rateAt(loan, t) {
    var r = 0, list = (loan.lai_suat || []).slice().sort(function (a, b) { return d(a.tu_ngay) - d(b.tu_ngay); });
    for (var i = 0; i < list.length; i++) if (d(list[i].tu_ngay) <= t) r = +list[i].nam;
    return r;
  }
  function inPause(loan, k) {
    return (loan.tam_dung_goc || []).some(function (p) { return k >= p.tu_ky && k <= p.den_ky; });
  }

  /** Lập toàn bộ lịch. homNay: 'YYYY-MM-DD' (mặc định hôm nay). soKyDuPhong: số kỳ dự kiến khi chưa có đáo hạn. */
  function schedule(loan, homNay, soKyDuPhong) {
    var today = d(homNay || new Date().toISOString().slice(0, 10));
    var start = d(loan.ngay_giai_ngan);
    var exactEnd = !!loan.ngay_ket_thuc;
    var maturity = exactEnd ? d(loan.ngay_ket_thuc) : (loan.so_thang ? addMonths(start, +loan.so_thang) : null);
    var day = +loan.ngay_tra || new Date(start).getUTCDate();
    var first = loan.ky_dau ? d(loan.ky_dau + '-01') : addMonths(start, 1, 1);
    var horizon = maturity || addMonths(Math.max(today, first), soKyDuPhong || 24, 1);
    var pre = (loan.tra_truoc || []).map(function (p) { return { t: d(p.ngay), a: +p.so_tien, ghi_chu: p.ghi_chu || '' }; })
      .sort(function (a, b) { return a.t - b.t; });
    var changes = (loan.lai_suat || []).map(function (r) { return d(r.tu_ngay); });

    var rows = [], bal = +loan.so_tien_vay, prev = start, k = 0, goc = +loan.goc_moi_ky || 0;
    for (var m = first; ; m = addMonths(m, 1, 1)) {
      var key = ym(m), due;
      if (loan.doi_ngay && loan.doi_ngay[key]) due = d(loan.doi_ngay[key]);
      else { var yy = new Date(m).getUTCFullYear(), mm = new Date(m).getUTCMonth(), last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
        due = Date.UTC(yy, mm, Math.min(day, last)); }   // tháng không có ngày 29/30/31 thì lấy ngày cuối tháng
      if (loan.lui_ngay_nghi !== false && !(loan.doi_ngay && loan.doi_ngay[key])) due = rollWeekend(due);
      var isLast = false;
      if (maturity && (exactEnd ? due >= maturity : (ym(maturity) === key || due >= maturity))) { due = maturity; isLast = true; key = ym(due); }
      if (!maturity && m > horizon) break;
      if (bal <= 0) break;

      // tiền lãi: tách đoạn theo ngày đổi lãi suất và ngày trả trước gốc
      var cuts = [prev, due];
      changes.concat(pre.map(function (p) { return p.t; })).forEach(function (c) { if (c > prev && c < due) cuts.push(c); });
      cuts = cuts.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; });
      var lai = 0, parts = [], b = bal, prepaid = 0;
      for (var i = 0; i < cuts.length - 1; i++) {
        pre.forEach(function (p) { if (p.t === cuts[i] && !p.used) { p.used = true; b -= p.a; prepaid += p.a; } });
        var n = Math.round((cuts[i + 1] - cuts[i]) / DAY), r = rateAt(loan, cuts[i]);
        var x = b * r / 100 / 365 * n;
        lai += x;
        parts.push({ tu: iso(cuts[i]), den: iso(cuts[i + 1]), so_ngay: n, du_no: b, lai_suat: r, lai: Math.round(x) });
      }
      bal = b;
      var g = 0;
      if (loan.kieu === 'tra_gop') g = isLast ? bal : (inPause(loan, key) ? 0 : Math.min(goc, bal));
      else if (isLast) g = bal;
      k++;
      rows.push({
        ky: k, thang: key, ngay: iso(due), tu_ngay: iso(prev), so_ngay: Math.round((due - prev) / DAY),
        du_no_dau: bal, goc: g, lai: Math.round(lai), tong: Math.round(lai) + (isLast && loan.dao_no ? 0 : g), tra_truoc: prepaid,
        chi_tiet_lai: parts, da_qua: due <= today, cuoi: isLast,
        dao_no: !!(isLast && loan.dao_no && g > 0)   // gốc này trả bằng khoản vay mới
      });
      bal -= g; prev = due;
      if (isLast) break;
    }
    var next = rows.filter(function (r) { return !r.da_qua; })[0] || null;
    var duNo = next ? next.du_no_dau : 0;
    // lãi cộng dồn tạm tính từ kỳ trước đến hôm nay (để đối chiếu app ngân hàng)
    var accrued = 0;
    if (next) next.chi_tiet_lai.forEach(function (p) {
      var a = d(p.tu), b2 = Math.min(d(p.den), today);
      if (b2 > a) accrued += p.du_no * p.lai_suat / 100 / 365 * Math.round((b2 - a) / DAY);
    });
    return {
      rows: rows, ky_toi: next, du_no_hien_tai: duNo, lai_tam_tinh: Math.round(accrued),
      con_ngay: next ? Math.round((d(next.ngay) - today) / DAY) : null,
      dao_han: maturity ? iso(maturity) : null,
      tong_lai: rows.reduce(function (s, r) { return s + r.lai; }, 0),
      lai_con_lai: rows.filter(function (r) { return !r.da_qua; }).reduce(function (s, r) { return s + r.lai; }, 0)
    };
  }

  /** Tổng gốc/lãi theo tháng 'YYYY-MM' cho nhiều khoản vay */
  function byMonth(loans, homNay) {
    var out = {};
    (loans || []).forEach(function (l) {
      schedule(l, homNay).rows.forEach(function (r) {
        var o = out[r.thang] || (out[r.thang] = { goc: 0, lai: 0, tra_truoc: 0 });
        if (!r.dao_no) o.goc += r.goc; o.lai += r.lai; o.tra_truoc += r.tra_truoc;
      });
    });
    return out;
  }
  return { schedule: schedule, byMonth: byMonth };
})();
if (typeof module !== 'undefined') module.exports = LoanEngine;
