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
    THREAD: 'CASE_THREAD', REQUESTS: 'DATA_REQUESTS',
    // ── Fase 7 ── rule engine + jejak panggilan AI (01-schema.md §14, §16)
    RULES: 'EVIDENCE_RULES', AI_LOG: 'AI_ADVISORY_LOG'
  };
  const CACHEABLE = { DEALERS: 21600, CONFIG: 21600, VEHICLE_MODELS: 21600,
                      HOLIDAY_CALENDAR: 21600, EVIDENCE_RULES: 21600,
                      // TTL pendek, bukan 6 jam: sheet ini sering berubah.
                      // Aman karena setiap append/update memanggil invalidate()
                      // yang menghapus key ini secara GLOBAL -- tidak ada user
                      // yang bisa membaca data basi setelah user lain menulis.
                      // TTL 90 detik hanya menutup celah kalau spreadsheet
                      // diedit MANUAL, di luar aplikasi.
                      CASES_MASTER: 90, CASE_THREAD: 90, CASE_EVENTS: 90,
                      // Dibaca di SETIAP cache-miss Session_.validate.
                      // USERS jarang berubah; SESSIONS berubah tiap login tapi
                      // append/update sudah memanggil invalidate() yang
                      // menghapus key ini secara global.
                      USERS: 300, SESSIONS: 60,
                      // Ditulis tiap panggilan Gemini, dibaca tiap case.get
                      // untuk cek cache advisory. TTL pendek supaya hasil
                      // Gemini baru langsung terlihat.
                      AI_ADVISORY_LOG: 60,
                      CASE_ATTACHMENTS: 90, CASE_DIAGNOSTICS: 90,
                      DATA_REQUESTS: 90 };

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

  /**
   * Memo per-EKSEKUSI. Beda dari CACHEABLE: umurnya hanya selama satu request,
   * jadi tidak ada risiko data basi antar-user dan berlaku untuk SEMUA sheet.
   *
   * Alasannya diukur, bukan ditebak: satu case.get membaca CASES_MASTER dua kali
   * (row() dan Advisory_.recurringVin()), masing-masing ~1,4 detik. Tanpa memo,
   * separuh waktu request habis membaca sheet yang sama berulang.
   *
   * PERINGATAN: pemanggil TIDAK BOLEH memutasi objek hasil readAll/find —
   * objeknya kini dipakai bersama dalam satu eksekusi. Semua service sudah
   * menyalin dulu (toPublic, Diag_.forCase), jadi aman; jaga kebiasaan itu.
   */
  const _execMemo = {};
/**
   * Matriks nilai -> array objek. Dipakai readAll() DAN preload(), jadi aturan
   * normalisasi (boolean, sel kosong) hanya ditulis sekali.
   */
  function toObjects_(values) {
    if (!values || values.length < 2) return [];
    const head = values[0].map(String);
    const out = [];
    for (let i = 1; i < values.length; i++) {
      const o = { _row: i + 1 };
      for (let c = 0; c < head.length; c++) {
        if (!head[c]) continue;
        const v = values[i][c];
        // batchGet MEMOTONG sel kosong di ujung kanan baris, jadi v bisa
        // undefined. Tanpa penjagaan ini, String(undefined) menghasilkan
        // string "undefined" yang lolos ke UI sebagai teks.
        if (v === undefined || v === null) { o[head[c]] = ''; continue; }
        o[head[c]] = (typeof v === 'boolean') ? (v ? 'TRUE' : 'FALSE') : String(v);
      }
      out.push(o);
    }
    return out;
  }

  /** Baca satu sheet SEKALI, kembalikan array objek + nomor baris fisik. */
  function readAll(name) {
    if (_execMemo[name]) return _execMemo[name];
    const ttl = CACHEABLE[name];
    if (ttl) {
      const hit = CacheService.getScriptCache().get('sd_' + name);
      if (hit) return (_execMemo[name] = JSON.parse(hit));
    }
    const out = toObjects_(sheet_(name).getDataRange().getValues());
    if (ttl) {
      const s = JSON.stringify(out);
      if (s.length < 95000) CacheService.getScriptCache().put('sd_' + name, s, ttl);
      // Lewat batas ini cache berhenti bekerja DIAM-DIAM dan performa turun
      // tanpa sebab yang terlihat. Dicatat supaya ketahuan di Stackdriver.
      else console.warn('Cache dilewati, ' + name + ' terlalu besar: ' +
                        Math.round(s.length / 1024) + ' KB. Perlu paginasi/arsip.');
    }
    _execMemo[name] = out;
    return out;
  }
  /**
   * Baca BANYAK sheet sekaligus dalam SATU panggilan HTTP (Sheets API v4).
   *
   * Alasannya diukur: satu getValues() berbiaya 300-1700 ms terlepas dari
   * jumlah barisnya (USERS 5 baris pernah 1755 ms). Biayanya per-round-trip,
   * bukan per-data. case.get menyentuh 6 sheet -> 6 round-trip -> 3-5 detik.
   * batchGet menjadikannya satu.
   *
   * Aman gagal: kalau Advanced Service belum aktif, fungsi ini diam saja dan
   * readAll() tetap jalan seperti biasa, hanya lebih lambat.
   */
  function preload(names) {
    const missing = (names || []).filter(function (nm) {
      if (_execMemo[nm]) return false;
      const ttl = CACHEABLE[nm];
      if (!ttl) return true;
      const hit = CacheService.getScriptCache().get('sd_' + nm);
      if (!hit) return true;
      _execMemo[nm] = JSON.parse(hit);
      return false;
    });
    if (!missing.length) return;
    if (typeof Sheets === 'undefined') return;   // Advanced Service belum aktif

    try {
      const res = Sheets.Spreadsheets.Values.batchGet(prop_('SHEET_ID'), {
        ranges: missing.map(function (nm) { return "'" + nm + "'"; }),
        // UNFORMATTED_VALUE, BUKAN FORMATTED_VALUE: yang terakhir mengembalikan
        // "41,000" untuk Mileage dan Number() akan menghasilkan NaN.
        valueRenderOption: 'UNFORMATTED_VALUE'
      });
      const vrs = res.valueRanges || [];
      for (let i = 0; i < missing.length; i++) {
        if (!vrs[i]) continue;                    // urutan respons = urutan ranges
        _execMemo[missing[i]] = toObjects_(vrs[i].values || []);
      }
    } catch (e) {
      // Jangan lempar. Kegagalan preload cuma berarti kembali ke jalur lambat.
      console.error('TC.preload: ' + e);
    }
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

  /**
   * Append BANYAK objek sekaligus dalam SATU setValues.
   * Notify_.enqueue menulis satu baris per penerima; "case masuk ke IIDI"
   * bisa 8 penerima. Lewat append() itu 8 appendRow (~2-3 detik) di dalam
   * request user, melanggar CLAUDE.md §3.7.
   *
   * Berbeda dari append(): setValues menulis ke nomor baris yang dihitung
   * dari getLastRow(), jadi dua eksekusi bersamaan bisa saling menimpa.
   * appendRow() tidak punya masalah itu. Karena itu HANYA fungsi ini yang
   * mengambil lock sendiri. Jangan panggil dari dalam TC.withLock lain.
   */
  function appendMany(name, objs) {
    if (!objs || !objs.length) return;
    if (objs.length === 1) return append(name, objs[0]);

    const head = headers_(name);
    const rows = objs.map(function (o) {
      return head.map(function (h) {
        return (o[h] === undefined || o[h] === null) ? '' : String(o[h]);
      });
    });
    const tsCols = (typeof TIMESTAMP_COLUMNS !== 'undefined') ? TIMESTAMP_COLUMNS[name] : null;

    withLock(function () {
      const sh = sheet_(name);
      const start = sh.getLastRow() + 1;
      // Format '@' DULU, baru setValues (01-schema.md, Konvensi).
      if (tsCols && tsCols.length) {
        tsCols.forEach(function (colName) {
          const c = head.indexOf(colName);
          if (c !== -1) sh.getRange(start, c + 1, rows.length, 1).setNumberFormat('@');
        });
      }
      sh.getRange(start, 1, rows.length, head.length).setValues(rows);
      SpreadsheetApp.flush();
    });
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
    delete _execMemo[name];       // WAJIB: tanpa ini, pembacaan setelah
                                  // append/update mengembalikan data sebelum tulisan
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

 return { S: S, readAll: readAll, preload: preload, find: find, filter: filter, append: append,
           appendMany: appendMany, update: update, invalidate: invalidate,
           config: config, cfgNum: cfgNum, nowIso: nowIso, isoOf: isoOf,
           parseIso: parseIso, withLock: withLock, flush: flush, prop: prop_ };
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