/**
 * 00_Config.gs
 *
 * Konstanta sistem: nama sheet, definisi kolom, akses Script Properties,
 * pembacaan CONFIG sheet dengan cache, dan primitif hashing PIN.
 *
 * ATURAN: file ini TIDAK BOLEH berisi logika bisnis (state machine, SLA, dll).
 * Hanya konstanta dan fungsi baca-konfigurasi/kripto murni yang dipakai lintas fase.
 *
 * Sumber kebenaran struktur data: docs/01-schema.md. Kalau sheet berubah,
 * update SCHEMA/TIMESTAMP_COLUMNS di sini DULU, baru kode lain.
 */

// ── Nama Sheet (20 total, lihat docs/01-schema.md §2A untuk VEHICLE_MODELS) ──
const SHEETS = {
  USERS: 'USERS',
  DEALERS: 'DEALERS',
  VEHICLE_MODELS: 'VEHICLE_MODELS',
  SESSIONS: 'SESSIONS',
  CASES_MASTER: 'CASES_MASTER',
  CASE_DIAGNOSTICS: 'CASE_DIAGNOSTICS',
  CASE_THREAD: 'CASE_THREAD',
  CASE_ATTACHMENTS: 'CASE_ATTACHMENTS',
  CASE_FOLDERS: 'CASE_FOLDERS',
  CASE_EVENTS: 'CASE_EVENTS',
  AUDIT_LOG: 'AUDIT_LOG',
  DATA_REQUESTS: 'DATA_REQUESTS',
  MBAG_ESCALATIONS: 'MBAG_ESCALATIONS',
  HOLIDAY_CALENDAR: 'HOLIDAY_CALENDAR',
  EVIDENCE_RULES: 'EVIDENCE_RULES',
  NOTIFICATIONS_QUEUE: 'NOTIFICATIONS_QUEUE',
  AI_ADVISORY_LOG: 'AI_ADVISORY_LOG',
  KB_ARTICLES: 'KB_ARTICLES',
  DASHBOARD_SNAPSHOT: 'DASHBOARD_SNAPSHOT',
  CONFIG: 'CONFIG'
};

// Urutan sheet dibuat mengikuti urutan ini (tidak wajib, tapi enak dibaca di tab GAS).
const SHEET_ORDER = [
  SHEETS.CONFIG, SHEETS.USERS, SHEETS.DEALERS, SHEETS.VEHICLE_MODELS, SHEETS.SESSIONS,
  SHEETS.CASES_MASTER, SHEETS.CASE_DIAGNOSTICS, SHEETS.CASE_THREAD, SHEETS.CASE_ATTACHMENTS,
  SHEETS.CASE_FOLDERS, SHEETS.CASE_EVENTS, SHEETS.AUDIT_LOG, SHEETS.DATA_REQUESTS,
  SHEETS.MBAG_ESCALATIONS, SHEETS.HOLIDAY_CALENDAR, SHEETS.EVIDENCE_RULES,
  SHEETS.NOTIFICATIONS_QUEUE, SHEETS.AI_ADVISORY_LOG, SHEETS.KB_ARTICLES,
  SHEETS.DASHBOARD_SNAPSHOT
];

// ── Header per Sheet (URUTAN = URUTAN KOLOM DI SHEET, kolom A = index 0) ─────
const SCHEMA = {};
SCHEMA[SHEETS.USERS] = [
  'User_ID', 'Full_Name', 'Role', 'Dealer_ID', 'Dealer_Name', 'Email', 'Phone_WA',
  'PIN_Hash', 'PIN_Salt', 'PIN_Version', 'Status', 'Must_Change_PIN',
  'Failed_Attempts', 'Locked_Until', 'Notif_Level',
  'Created_At', 'Updated_At', 'Last_Login_At'
];
SCHEMA[SHEETS.DEALERS] = [
  'Dealer_ID', 'Dealer_Name', 'Area', 'Area_Manager_User_ID', 'City', 'Status', 'Created_At'
];
SCHEMA[SHEETS.VEHICLE_MODELS] = [
  'Model_Code', 'Model_Name', 'Category', 'Active', 'Created_At'
];
SCHEMA[SHEETS.SESSIONS] = [
  'Session_ID', 'User_ID', 'Token_Hash', 'Issued_At', 'Expires_At', 'Last_Seen_At', 'Revoked', 'UA_Hint'
];
SCHEMA[SHEETS.CASES_MASTER] = [
  'Case_No', 'VIN', 'Model', 'Engine_No', 'Trans_No', 'Mileage', 'Prod_Year', 'Reg_No', 'Warranty_Status',
  'Cust_Name', 'Complaint_No', 'Complaint_Desc', 'Symptom_Category', 'Date_Occurred', 'Frequency',
  'Driving_Condition', 'Vehicle_Status', 'Outside_Temp', 'Fuel_Level', 'Driving_Style', 'Road_Condition',
  'Dealer_ID', 'Created_By_User_ID', 'Priority', 'Status', 'Current_Owner_User_ID', 'Current_Owner_Role',
  'Current_Waiting_Reason', 'Quality_Score', 'Score_Category', 'Activity_Status',
  'Dealer_Self_Diagnosis_Deadline', 'IIDI_Response_Deadline', 'Dealer_Response_Deadline',
  'IIDI_Decision_Deadline', 'Closure_Deadline',
  'Created_At', 'Updated_At', 'Last_Activity_At', 'Last_Activity_By', 'Submitted_To_IIDI_At',
  'First_IIDI_Response_At', 'Escalated_At', 'Closed_At', 'Closed_By', 'Closure_Type', 'MBAG_Ref_No'
];
SCHEMA[SHEETS.CASE_DIAGNOSTICS] = [
  'Case_No', 'Initial_Diag', 'Dealer_Analysis', 'Suspected_Root_Cause', 'Workshop_Findings',
  'DTC_Codes', 'Control_Unit', 'Diagnostic_Path', 'Xentry_Version', 'SW_Version_Before',
  'SW_Version_After', 'Parts_Replaced', 'Previous_Repair_History', 'Updated_At', 'Updated_By'
];
SCHEMA[SHEETS.CASE_THREAD] = [
  'Thread_ID', 'Case_No', 'Parent_ID', 'Author_User_ID', 'Author_Role', 'Message_Type',
  'Message', 'Visibility', 'Created_At', 'Edited_At', 'Deleted'
];
SCHEMA[SHEETS.CASE_ATTACHMENTS] = [
  'Attachment_ID', 'Case_No', 'Thread_ID', 'Evidence_Type', 'File_Name', 'Drive_File_ID', 'Drive_URL',
  'Mime_Type', 'Size_Bytes', 'Upload_Method', 'Uploaded_By', 'Uploaded_At', 'Deleted'
];
SCHEMA[SHEETS.CASE_FOLDERS] = [
  'Case_No', 'Folder_ID', 'Folder_URL', 'Created_At'
];
SCHEMA[SHEETS.CASE_EVENTS] = [
  'Event_ID', 'Case_No', 'Event_Type', 'From_Value', 'To_Value', 'Actor_User_ID', 'Actor_Role',
  'Note', 'Detail_JSON', 'Created_At'
];
SCHEMA[SHEETS.AUDIT_LOG] = [
  'Log_ID', 'Timestamp', 'User_ID', 'Action', 'Target', 'Result', 'Detail', 'UA_Hint'
];
SCHEMA[SHEETS.DATA_REQUESTS] = [
  'Request_ID', 'Case_No', 'Requested_By', 'Requested_At', 'Items_JSON', 'Due_At', 'Status',
  'Fulfilled_At', 'Fulfilled_By', 'Response_Note'
];
SCHEMA[SHEETS.MBAG_ESCALATIONS] = [
  'Escalation_ID', 'Case_No', 'MBAG_Ref_No', 'Escalated_By', 'Escalated_At', 'Reason',
  'Package_Folder_ID', 'MBAG_Status', 'MBAG_Response', 'Response_At', 'Closed_At'
];
SCHEMA[SHEETS.HOLIDAY_CALENDAR] = [
  'Date', 'Name', 'Type', 'Active'
];
SCHEMA[SHEETS.EVIDENCE_RULES] = [
  'Rule_ID', 'Match_Type', 'Match_Value', 'Evidence_Type', 'Label', 'Priority', 'Mandatory',
  'Applies_To_Priority', 'Active'
];
SCHEMA[SHEETS.NOTIFICATIONS_QUEUE] = [
  'Notif_ID', 'Case_No', 'Event_Type', 'Recipient_User_ID', 'Channel', 'To_Address', 'Subject',
  'Body', 'Status', 'Attempts', 'Created_At', 'Sent_At', 'Error'
];
SCHEMA[SHEETS.AI_ADVISORY_LOG] = [
  'Advisory_ID', 'Case_No', 'Trigger', 'Source', 'Model', 'Input_Hash', 'Response_JSON',
  'Latency_Ms', 'Error', 'Created_At', 'Acknowledged_By'
];
SCHEMA[SHEETS.KB_ARTICLES] = [
  'KB_ID', 'Source_Case_No', 'Title', 'Model', 'Symptom_Category', 'DTC_Codes', 'Root_Cause',
  'Solution', 'Keywords', 'Status', 'Created_By', 'Created_At', 'View_Count'
];
SCHEMA[SHEETS.DASHBOARD_SNAPSHOT] = [
  'Snapshot_Key', 'Scope', 'Payload_JSON', 'Generated_At', 'Storage', 'Drive_File_ID'
];
SCHEMA[SHEETS.CONFIG] = [
  'Key', 'Value', 'Description', 'Updated_At'
];

// ── Kolom timestamp/date per sheet — WAJIB format Plain Text ('@') SEBELUM
// setValues() dijalankan. Lihat 90_Setup.gs applyPlainTextFormat_(). ─────────
const TIMESTAMP_COLUMNS = {};
TIMESTAMP_COLUMNS[SHEETS.USERS] = ['Locked_Until', 'Created_At', 'Updated_At', 'Last_Login_At'];
TIMESTAMP_COLUMNS[SHEETS.DEALERS] = ['Created_At'];
TIMESTAMP_COLUMNS[SHEETS.VEHICLE_MODELS] = ['Created_At'];
TIMESTAMP_COLUMNS[SHEETS.SESSIONS] = ['Issued_At', 'Expires_At', 'Last_Seen_At'];
TIMESTAMP_COLUMNS[SHEETS.CASES_MASTER] = [
  'Date_Occurred', 'Dealer_Self_Diagnosis_Deadline', 'IIDI_Response_Deadline',
  'Dealer_Response_Deadline', 'IIDI_Decision_Deadline', 'Closure_Deadline',
  'Created_At', 'Updated_At', 'Last_Activity_At', 'Submitted_To_IIDI_At',
  'First_IIDI_Response_At', 'Escalated_At', 'Closed_At'
];
TIMESTAMP_COLUMNS[SHEETS.CASE_DIAGNOSTICS] = ['Updated_At'];
TIMESTAMP_COLUMNS[SHEETS.CASE_THREAD] = ['Created_At', 'Edited_At'];
TIMESTAMP_COLUMNS[SHEETS.CASE_ATTACHMENTS] = ['Uploaded_At'];
TIMESTAMP_COLUMNS[SHEETS.CASE_FOLDERS] = ['Created_At'];
TIMESTAMP_COLUMNS[SHEETS.CASE_EVENTS] = ['Created_At'];
TIMESTAMP_COLUMNS[SHEETS.AUDIT_LOG] = ['Timestamp'];
TIMESTAMP_COLUMNS[SHEETS.DATA_REQUESTS] = ['Requested_At', 'Due_At', 'Fulfilled_At'];
TIMESTAMP_COLUMNS[SHEETS.MBAG_ESCALATIONS] = ['Escalated_At', 'Response_At', 'Closed_At'];
TIMESTAMP_COLUMNS[SHEETS.HOLIDAY_CALENDAR] = ['Date'];
TIMESTAMP_COLUMNS[SHEETS.NOTIFICATIONS_QUEUE] = ['Created_At', 'Sent_At'];
TIMESTAMP_COLUMNS[SHEETS.AI_ADVISORY_LOG] = ['Created_At'];
TIMESTAMP_COLUMNS[SHEETS.KB_ARTICLES] = ['Created_At'];
TIMESTAMP_COLUMNS[SHEETS.DASHBOARD_SNAPSHOT] = ['Generated_At'];
TIMESTAMP_COLUMNS[SHEETS.CONFIG] = ['Updated_At'];

// ── Kolom Index Helper ───────────────────────────────────────────────────
const _colIndexCache = {};
function colIndex_(sheetName, columnName) {
  if (!_colIndexCache[sheetName]) {
    const headers = SCHEMA[sheetName];
    if (!headers) throw new AppError(ERROR_CODES.INTERNAL, 'Sheet tidak dikenal di SCHEMA: ' + sheetName);
    const map = {};
    headers.forEach(function (h, i) { map[h] = i; });
    _colIndexCache[sheetName] = map;
  }
  const idx = _colIndexCache[sheetName][columnName];
  if (idx === undefined) {
    throw new AppError(ERROR_CODES.INTERNAL, 'Kolom tidak dikenal: ' + sheetName + '.' + columnName);
  }
  return idx;
}

// ── Akses Spreadsheet ────────────────────────────────────────────────────
let _ssCache = null;
function getSpreadsheet_() {
  if (!_ssCache) {
    _ssCache = SpreadsheetApp.openById(scriptProp_('SHEET_ID'));
  }
  return _ssCache;
}
function getSheet_(sheetName) {
  const sheet = getSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) throw new AppError(ERROR_CODES.INTERNAL, 'Sheet belum dibuat: ' + sheetName + '. Jalankan setupAll().');
  return sheet;
}

// ── Script Properties (rahasia) ──────────────────────────────────────────
function scriptProp_(key) {
  const val = PropertiesService.getScriptProperties().getProperty(key);
  if (!val) throw new AppError(ERROR_CODES.INTERNAL, 'Script Property belum diisi: ' + key);
  return val;
}
function scriptPropOptional_(key, fallback) {
  const val = PropertiesService.getScriptProperties().getProperty(key);
  return (val === null || val === undefined || val === '') ? fallback : val;
}

/** Versi aplikasi. Dinaikkan tiap fase; dikembalikan oleh sys.ping. */
const APP_VERSION = 'fase-5';

// ── CONFIG sheet reader (cache 6 jam, key-value) ─────────────────────────
const Config_ = {
  all: function () {
    const cache = CacheService.getScriptCache();
    const cached = cache.get('cfg_all');
    if (cached) return JSON.parse(cached);

    const sheet = getSheet_(SHEETS.CONFIG);
    const rows = sheet.getDataRange().getValues();
    const kIdx = colIndex_(SHEETS.CONFIG, 'Key');
    const vIdx = colIndex_(SHEETS.CONFIG, 'Value');
    const cfg = {};
    for (let i = 1; i < rows.length; i++) {
      const key = rows[i][kIdx];
      if (key) cfg[key] = rows[i][vIdx];
    }
    cache.put('cfg_all', JSON.stringify(cfg), 21600); // 6 jam
    return cfg;
  },
  get: function (key, fallback) {
    const cfg = Config_.all();
    return (key in cfg) ? cfg[key] : fallback;
  },
  invalidate: function () {
    CacheService.getScriptCache().remove('cfg_all');
  }
};

// Nilai default CONFIG — dipakai oleh 90_Setup.gs saat seed pertama kali.
// Penjelasan tiap key: docs/01-schema.md §19.
  const DEFAULT_CONFIG = [
  ['CASE_COUNTER', '0', 'Angka terakhir yang dipakai untuk Case_No. Naik terus.'],
  ['ATTACH_COUNTER', '0', 'Angka terakhir Attachment_ID (AT-000001). Naik terus, tidak pernah turun'],
  ['THREAD_COUNTER', '0', 'Angka terakhir Thread_ID (TH-000001). Naik terus, tidak pernah turun'],
  ['SLA_DEALER_SELF_DIAG_DAYS', '3', 'Hari kerja, target self-diagnosis dealer.'],
  ['SLA_IIDI_RESPONSE_DAYS', '1', 'Hari kerja, target respons awal IIDI.'],
  ['SLA_DEALER_RESPONSE_DAYS', '2', 'Hari kerja, target dealer balas data request.'],
  ['SLA_IIDI_DECISION_DAYS', '2', 'Hari kerja, target keputusan IIDI sebelum MBAG.'],
  ['SLA_CLOSURE_DAYS', '2', 'Hari kerja, target konfirmasi closure dealer.'],
  ['WORK_START', '08:00', 'Jam mulai kerja WIB.'],
  ['WORK_END', '17:00', 'Jam selesai kerja WIB.'],
  ['NEAR_DUE_THRESHOLD_HOURS', '1', 'Jam kerja, ambang status NEAR_DUE.'],
  ['SESSION_TTL_HOURS', '8', 'Masa berlaku session token.'],
  ['MAX_FAILED_ATTEMPTS', '5', 'Batas gagal PIN sebelum lockout.'],
  ['LOCKOUT_MINUTES', '15', 'Lama lockout akun.'],
  ['MAX_INLINE_UPLOAD_MB', '5', 'Batas file base64 inline lewat attach.upload.'],
  ['MAX_RESUMABLE_UPLOAD_MB', '100', 'Batas file lewat attach.initUpload (resumable).'],
  ['FEATURE_GEMINI', 'TRUE', 'Matikan kalau kuota Gemini habis.'],
  ['FEATURE_WA', 'FALSE', 'Aktifkan saat provider WA siap.'],
  ['WA_PROVIDER', '', 'FONNTE | WABLAS | META | CUSTOM. Kosong = belum aktif.'],
  ['GEMINI_MODEL', '', 'Diisi saat setup, lihat docs/07-ai-advisory.md.'],
  ['EMAIL_DAILY_QUOTA', '1500', 'Kuota akun Workspace pengirim. Dihitung per penerima.'],
  ['EMAIL_SENT_TODAY', '0', 'Counter berjalan, direset job harian.'],
  ['SLA_JOB_CURSOR', '0', 'Penanda posisi batch job SLA (maks 300 case/eksekusi).']
];

// ── Primitif kripto PIN (docs/03-rbac.md §4) ─────────────────────────────
// File ini memegang KONSTANTA dan generator salt. Fungsi hashPin_ sendiri
// ada di 12_Auth.gs (Fase 1) — satu implementasi saja.
//
// Iterasi per versi. JANGAN ubah angka versi lama: hash yang sudah tersimpan
// hanya bisa diverifikasi ulang dengan iterasi yang dipakai saat dibuat.
// Untuk mengubah biaya hashing: tambah versi BARU, naikkan PIN_HASH_VERSION.
// v1 = 10000 -> terukur 5.6-6.4 detik di GAS, melanggar CLAUDE.md §3.7.
// v2 = 5000  -> sesuai instruksi 03-rbac.md §4 saat hash > 3 detik.
// v1 = 10000 -> 5,6-6,4 detik. v2 = 5000 -> 2,7 detik. v3 = 1000 -> ~0,54 detik.
//
// Kenapa 1000 dianggap cukup: PIN 6 digit hanya 1 juta kombinasi. Kalau sheet
// USERS *dan* PIN_PEPPER sama-sama bocor, iterasi berapapun tidak menolong --
// GPU menyelesaikan 1e6 x 10000 SHA-256 dalam hitungan detik. Pertahanan yang
// sebenarnya adalah (a) pepper di Script Properties, terpisah dari spreadsheet,
// dan (b) lockout 5x/15 menit untuk serangan online (03-rbac.md §4).
// Iterasi hanya menyisakan nilai untuk skenario "sheet bocor, pepper aman".
// JANGAN turunkan di bawah 1000: hematnya < 300ms, tapi lapisan terakhir hilang.
const PIN_HASH_ITERATIONS_BY_VERSION = { 1: 10000, 2: 5000, 3: 1000 };

/** Versi yang dipakai untuk hash BARU. Hash lama tetap dibaca dengan versinya sendiri. */
const PIN_HASH_VERSION = 3;

/** Iterasi untuk sebuah PIN_Version. Default v1 kalau kolom kosong (data lama). */
function pinIterations_(version) {
  const v = Number(version || 1);
  const n = PIN_HASH_ITERATIONS_BY_VERSION[v];
  if (!n) throw new AppError(ERROR_CODES.INTERNAL, 'PIN_Version tidak dikenal: ' + version);
  return n;
}

function generateSalt_() {
  // 16 byte turunan UUID (di-hash SHA-256, ambil 16 byte pertama) — cukup acak
  // sebagai salt per-user, tanpa perlu API random-bytes native yang tidak ada di GAS.
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid());
  return Utilities.base64Encode(raw.slice(0, 16));
}

// hashPin_ dipindah ke 12_Auth.gs (Fase 1) supaya hanya ada SATU implementasi.
// Jangan definisikan ulang di sini — duplikat function declaration tidak error,
// tapi diam-diam menimpa dan bikin verifikasi PIN gagal tanpa jejak.

/** Constant-time compare untuk string base64 sepanjang sama. */
function constantTimeEquals_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return diff === 0;
}

// ── Util waktu ────────────────────────────────────────────────────────────
function nowIso_() {
  return Utilities.formatDate(new Date(), 'Asia/Jakarta', "yyyy-MM-dd'T'HH:mm:ssXXX");
}

/* ===================== SLA CONTEXT (Fase 3) ===================== */
// Ditambahkan setelah blok terakhir 00_Config.gs.
// Engine tidak boleh baca sheet, jadi pemuatnya diletakkan di sini.

var HOLIDAY_CACHE_KEY_ = 'holidays_v1';
var HOLIDAY_CACHE_TTL_ = 21600;   // 6 jam, docs/01-schema.md Konvensi

var Holidays_ = {
  /** @return {Object} map { '2026-08-17': true } untuk baris Active = TRUE */
  map: function () {
    var cache = CacheService.getScriptCache();
    var hit = cache.get(HOLIDAY_CACHE_KEY_);
    if (hit) return JSON.parse(hit);

    // KODE MATI sejak Fase 3: Sla_ (31_SlaJob.gs) punya pembaca hari libur
    // sendiri. Blok Holidays_/slaContext_ ini tidak dipanggil siapa pun —
    // dibiarkan hanya untuk runSlaTests(). Helper yang benar adalah TC.
    var rows = TC.readAll(SHEETS.HOLIDAY_CALENDAR);
    var out = {};
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (String(r.Active).toUpperCase() !== 'TRUE') continue;
      var key = String(r.Date || '').trim().substring(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(key)) out[key] = true;
    }
    cache.put(HOLIDAY_CACHE_KEY_, JSON.stringify(out), HOLIDAY_CACHE_TTL_);
    return out;
  },

  invalidate: function () {
    CacheService.getScriptCache().remove(HOLIDAY_CACHE_KEY_);
  }
};

/** Satu-satunya jalan resmi mendapatkan argumen SLA engine. */
function slaContext_() {
  return { holidaySet: Holidays_.map(), cfg: slaCfg_(Config_.all()) };
}
