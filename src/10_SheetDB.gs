/**
 * 10_SheetDB.gs — akses sheet generik, cache, dan util waktu.
 * Semua modul lain WAJIB lewat sini. Tidak ada SpreadsheetApp di file lain.
 */
var TC = (function () {
  const S = {
    USERS: 'USERS', SESSIONS: 'SESSIONS', DEALERS: 'DEALERS',
    CASES: 'CASES_MASTER', AUDIT: 'AUDIT_LOG', CONFIG: 'CONFIG',
    NOTIF: 'NOTIFICATIONS_QUEUE',
    // ── Fase 2 ── nama sheet tetap mengikuti SHEETS di 00_Config.gs
    DIAG: 'CASE_DIAGNOSTICS', EVENTS: 'CASE_EVENTS', ATTACH: 'CASE_ATTACHMENTS',
    // ── Fase 4 ── registry folder Drive per case (01-schema.md §8)
    FOLDERS: 'CASE_FOLDERS',
    // ── Fase 5 ── diskusi + permintaan data tambahan (01-schema.md §6, §11)
    THREAD: 'CASE_THREAD', REQUESTS: 'DATA_REQUESTS'
  };
  const CACHEABLE = { DEALERS: 21600, CONFIG: 21600, VEHICLE_MODELS: 21600,
                      HOLIDAY_CALENDAR: 21600, EVIDENCE_RULES: 21600 };

  let _ss = null;
  function prop_(k) {
    const v = PropertiesService.getScriptProperties().getProperty(k);
    if (!v) throw new AppError('INTERNAL', 'Script Property belum diisi: ' + k);
    return v;
  }
  function ss_() { return _ss || (_ss = SpreadsheetApp.openById(prop_('SHEET_ID'))); }
  function sheet_(name) {
    const sh = ss_().getSheetByName(name);
    if (!sh) throw new AppError('INTERNAL', 'Sheet tidak ditemukan: ' + name);
    return sh;
  }

  /** Baca satu sheet SEKALI, kembalikan array objek + nomor baris fisik. */
  function readAll(name) {
    const ttl = CACHEABLE[name];
    if (ttl) {
      const hit = CacheService.getScriptCache().get('sd_' + name);
      if (hit) return JSON.parse(hit);
    }
    const values = sheet_(name).getDataRange().getValues();
    if (values.length < 2) return [];
    const head = values[0].map(String);
    const out = [];
    for (let i = 1; i < values.length; i++) {
      const o = { _row: i + 1 };
      for (let c = 0; c < head.length; c++) if (head[c]) o[head[c]] = String(values[i][c]);
      out.push(o);
    }
    if (ttl) {
      const s = JSON.stringify(out);
      if (s.length < 95000) CacheService.getScriptCache().put('sd_' + name, s, ttl);
    }
    return out;
  }

  function find(name, col, val) {
    const rows = readAll(name);
    for (let i = 0; i < rows.length; i++) if (rows[i][col] === val) return rows[i];
    return null;
  }
  function filter(name, fn) { return readAll(name).filter(fn); }

  // Header sheet tidak pernah berubah saat runtime (hanya setupAll yang menulisnya),
  // jadi aman dimemoisasi selama satu eksekusi. Tanpa ini, setiap append/update
  // memicu satu round-trip SpreadsheetApp tambahan (~300ms) hanya untuk baca header.
  const _headerMemo = {};
  function headers_(name) {
    if (_headerMemo[name]) return _headerMemo[name];
    // SCHEMA di 00_Config.gs adalah sumber kebenaran urutan kolom -- pakai itu
    // kalau tersedia, supaya tidak perlu menyentuh sheet sama sekali.
    if (typeof SCHEMA !== 'undefined' && SCHEMA[name]) {
      _headerMemo[name] = SCHEMA[name].slice();
      return _headerMemo[name];
    }
    const sh = sheet_(name);
    _headerMemo[name] = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    return _headerMemo[name];
  }

  /** Append satu objek. WAJIB dipanggil dari dalam LockService (CLAUDE.md §3.5). */
  /**
   * Append satu objek.
   * appendRow() menulis baris di luar rentang yang sudah diformat, jadi kolom
   * timestamp baris baru kembali ke format default dan Sheets bisa mem-parse
   * string ISO jadi Date (01-schema.md, Konvensi). Karena itu format '@'
   * diterapkan ulang pada baris yang baru ditulis.
   */
  function append(name, obj) {
    const head = headers_(name);
    const row = head.map(function (h) {
      return (obj[h] === undefined || obj[h] === null) ? '' : String(obj[h]);
    });
    const sh = sheet_(name);
    sh.appendRow(row);

    const tsCols = (typeof TIMESTAMP_COLUMNS !== 'undefined') ? TIMESTAMP_COLUMNS[name] : null;
    if (tsCols && tsCols.length) {
      const r = sh.getLastRow();
      tsCols.forEach(function (colName) {
        const c = head.indexOf(colName);
        if (c !== -1) sh.getRange(r, c + 1).setNumberFormat('@');
      });
    }
    invalidate(name);
  }

  /** Update sebagian kolom pada satu baris fisik. */
  /**
   * Update sebagian kolom pada satu baris fisik.
   * Kolom yang berdekatan ditulis dalam SATU setValues, bukan satu panggilan
   * per kolom -- tiap panggilan SpreadsheetApp berbiaya ~100-300ms terlepas
   * dari jumlah selnya.
   */
  function update(name, rowNumber, patch) {
    const sh = sheet_(name);
    const head = headers_(name);
    const keys = Object.keys(patch);
    if (!keys.length) return;

    const cols = keys.map(function (k) {
      const c = head.indexOf(k);
      if (c === -1) throw new AppError('INTERNAL', 'Kolom tidak ada di ' + name + ': ' + k);
      return c;
    });
    const minC = Math.min.apply(null, cols);
    const maxC = Math.max.apply(null, cols);

    // Baca rentang sekali, timpa hanya kolom yang diminta, tulis balik sekali.
    const width = maxC - minC + 1;
    const range = sh.getRange(rowNumber, minC + 1, 1, width);
    const row = range.getValues()[0];
    keys.forEach(function (k, i) { row[cols[i] - minC] = String(patch[k]); });
    range.setNumberFormat('@').setValues([row]);

    invalidate(name);
  }

  function invalidate(name) {
    CacheService.getScriptCache().remove('sd_' + name);
    // CONFIG punya DUA cache: 'sd_CONFIG' di sini dan 'cfg_all' di Config_
    // (00_Config.gs). Kalau hanya satu yang dibuang, CASE_COUNTER bisa terbaca
    // basi sampai 6 jam dan Case_No jadi duplikat.
    if (name === S.CONFIG && typeof Config_ !== 'undefined') Config_.invalidate();
  }

  /** CONFIG sebagai objek key-value. */
  function config() {
    const o = {};
    readAll(S.CONFIG).forEach(function (r) { o[r.Key] = r.Value; });
    return o;
  }
  function cfgNum(key, dflt) {
    const v = config()[key];
    return (v === undefined || v === '') ? dflt : Number(v);
  }

  function nowIso() { return isoOf(new Date()); }
  function isoOf(d) { return Utilities.formatDate(d, 'Asia/Jakarta', "yyyy-MM-dd'T'HH:mm:ssXXX"); }
  function parseIso(s) { return (!s) ? null : new Date(s); }

  function withLock(fn) {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(20000)) throw new AppError('BUSY', 'Sistem sedang sibuk, coba lagi.');
    try { return fn(); } finally { lock.releaseLock(); }
  }

  /**
   * Paksa write tertunda benar-benar tersimpan SEBELUM lock dilepas.
   * Tanpa ini, eksekusi berikutnya bisa mendapat lock lalu membaca nilai lama —
   * penyebab Case_No duplikat. Satu-satunya tempat SpreadsheetApp.flush() boleh
   * dipanggil (CLAUDE.md §4: tidak ada SpreadsheetApp di file lain).
   */
  function flush() { SpreadsheetApp.flush(); }

  return { S: S, readAll: readAll, find: find, filter: filter, append: append,
           update: update, invalidate: invalidate, config: config, cfgNum: cfgNum,
           nowIso: nowIso, isoOf: isoOf, parseIso: parseIso, withLock: withLock,
           flush: flush, prop: prop_ };
})();

/** Audit trail keamanan — 01-schema.md §10. Signature tunggal. */
var Audit_ = {
  log: function (ctx, action, target, result, detail) {
    try {
      TC.append(TC.S.AUDIT, {
        Log_ID: 'AL-' + Utilities.getUuid().slice(0, 8),
        Timestamp: TC.nowIso(),
        User_ID: (ctx && ctx.user && ctx.user.userId) ? ctx.user.userId : '',
        Action: action,
        Target: target || '',
        Result: result || 'OK',
        Detail: detail || '',
        UA_Hint: (ctx && ctx.uaHint) ? ctx.uaHint : ''
      });
    } catch (e) { console.error('Audit gagal: ' + e); }
  }
};

/** Antrean email minimal untuk Fase 1 (lockout). Fase 6 menggantikan pengirimannya. */
var AuthMail_ = {
  queue: function (userId, toAddress, subject, body) {
    if (!toAddress) return;
    try {
      TC.append(TC.S.NOTIF, {
        Notif_ID: 'NT-' + Utilities.getUuid().slice(0, 8),
        Case_No: '', Event_Type: 'ACCOUNT_LOCKED', Recipient_User_ID: userId,
        Channel: 'EMAIL', To_Address: toAddress, Subject: subject, Body: body,
        Status: 'PENDING', Attempts: 0, Created_At: TC.nowIso(), Sent_At: '', Error: ''
      });
    } catch (e) { console.error('Enqueue gagal: ' + e); }
  }
};