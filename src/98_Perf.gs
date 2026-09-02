/**
 * 98_Perf.gs — pengukur performa. Bukan bagian sistem, alat diagnosa.
 * Jalankan dari editor GAS saat ada keluhan lambat.
 *
 * Target CLAUDE.md §3.7: setiap endpoint < 8 detik. Tapi 2 detik untuk
 * membuka daftar pun terasa berat kalau dilakukan puluhan kali sehari.
 */
function perfReport() {
  const t = {};
  function timeIt(label, fn) {
    const a = Date.now();
    let note = '';
    try { note = fn() || ''; } catch (e) { note = 'ERROR: ' + e; }
    t[label] = (Date.now() - a) + ' ms  ' + note;
  }

  timeIt('1. Buka spreadsheet', function () {
    return TC.readAll(TC.S.CONFIG).length + ' baris CONFIG';
  });
  timeIt('2. Baca CASES_MASTER', function () {
    return TC.readAll(TC.S.CASES).length + ' baris';
  });
  timeIt('3. Baca USERS', function () {
    return TC.readAll(TC.S.USERS).length + ' baris';
  });
  timeIt('4. Baca SESSIONS', function () {
    return TC.readAll(TC.S.SESSIONS).length + ' baris';
  });
  timeIt('5. Baca CASE_EVENTS', function () {
    return TC.readAll(TC.S.EVENTS).length + ' baris';
  });
  timeIt('6. Baca CASE_THREAD', function () {
    return TC.readAll(TC.S.THREAD).length + ' baris';
  });
  timeIt('7. Baca AI_ADVISORY_LOG', function () {
    return TC.readAll(TC.S.AI_LOG).length + ' baris';
  });
  timeIt('8. hashPin_ (10.000 iterasi)', function () {
    const salt = Utilities.base64Encode(Utilities.getUuid()).slice(0, 24);
    hashPin_('123456', salt);
    return 'satu kali hash';
  });
  timeIt('9. Sla_.statusOf x 50', function () {
    const rows = TC.readAll(TC.S.CASES).slice(0, 50);
    const now = TC.nowIso();
    rows.forEach(function (r) { Sla_.statusOf(r, now); });
    return rows.length + ' case';
  });

  console.log('=== PERF REPORT ===');
  Object.keys(t).forEach(function (k) { console.log(k + ' : ' + t[k]); });
}

function perfPreload() {
  const sheets = [TC.S.CASES, TC.S.DIAG, TC.S.ATTACH, TC.S.THREAD,
                  TC.S.REQUESTS, TC.S.AI_LOG, TC.S.EVENTS];
  let a = Date.now();
  sheets.forEach(function (s) { TC.readAll(s); });
  const lama = Date.now() - a;

  TC.invalidate(TC.S.CASES); sheets.forEach(function (s) { TC.invalidate(s); });

  a = Date.now();
  TC.preload(sheets);
  const baru = Date.now() - a;

  console.log('7 sheet, satu per satu : ' + lama + ' ms');
  console.log('7 sheet, batchGet      : ' + baru + ' ms');
  console.log('Sheets aktif           : ' + (typeof Sheets !== 'undefined'));
}

/** Deteksi sheet yang rentang terpakainya jauh lebih besar dari datanya. */
function perfRange() {
  const ss = SpreadsheetApp.openById(
    PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
  console.log('sheet | data(RxC) | maks(RxC) | sel terbaca | pemborosan');
  ss.getSheets().forEach(function (sh) {
    const dr = sh.getLastRow(), dc = sh.getLastColumn();
    const mr = sh.getMaxRows(),  mc = sh.getMaxColumns();
    const cells = dr * dc;
    const flag = (cells > 5000) ? '  <-- BESAR' : '';
    console.log(sh.getName() + ' | ' + dr + 'x' + dc + ' | ' + mr + 'x' + mc +
                ' | ' + cells + flag);
  });
}