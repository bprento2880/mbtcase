/**
 * 90_Setup.gs
 *
 * Dijalankan manual dari editor GAS (Fase 0). Dua entry point publik:
 *   setupAll()        — bikin semua sheet, seed data awal, user admin pertama, trigger.
 *   seedDemoData(n)    — bikin n case dummy untuk uji dashboard/performa.
 *
 * CATATAN DESAIN: data seed dealer & model kendaraan (seed/dealers.csv,
 * seed/models.csv) di-embed langsung sebagai array JS di bawah (DEALER_SEED,
 * MODEL_SEED), BUKAN dibaca dari file .csv saat runtime. GAS tidak punya akses
 * filesystem lokal, dan meng-upload CSV ke Drive lalu mem-parsing-nya saat
 * setup cuma menambah dependency tanpa manfaat untuk data yang jarang berubah
 * ini. Kalau seed/dealers.csv atau seed/models.csv diedit, salin ulang isinya
 * ke array di bawah sebelum menjalankan setupAll().
 *
 * CATATAN DESAIN: seedDemoData() menulis baris CASES_MASTER secara LANGSUNG
 * (bukan lewat CaseService, yang belum ada — itu baru dibangun di Fase 2) dan
 * memakai perhitungan tanggal sederhana (BUKAN 30_SlaEngine.gs yang baru ada
 * di Fase 3). Ini sengaja — tujuannya cuma menyediakan variasi data untuk uji
 * dashboard/performa di Fase 0, bukan merepresentasikan alur bisnis yang benar.
 */

// ── Seed: DEALERS (data riil dari seed/dealers.csv, lengkap dengan area manager & dealer code) ───
const DEALER_SEED = [
  ['DLR-AJM-01', 'PT. Arista Jaya Abadi', 'Sumatera', 'Medan', 'Novan Ardana', 'NA', 'AJM'],
  ['DLR-CAR-01', 'PT. Cakrawala Automotif Rabhasa', 'Jabodetabek', 'Jakarta Selatan', 'Sony Nur Irawan', 'SI', 'CAR'],
  ['DLR-CAB-01', 'PT. Cakrawala Automotif Rabhasa - Bintaro', 'Jabodetabek', 'Tangerang Selatan', 'Sony Nur Irawan', 'SI', 'CAB'],
  ['DLR-CKP-01', 'PT. Citrakarya Pranata', 'Jawa Barat', 'Bandung', 'Sony Nur Irawan', 'SI', 'CKP'],
  ['DLR-DAM-01', 'PT. Dipo Angkasa Motor', 'Jabodetabek', 'Jakarta Utara', 'Novan Ardana', 'NA', 'DAM'],
  ['DLR-HDP-01', 'PT. Hartono Raya Motor Denpasar', 'Bali-Nusra', 'Denpasar', 'Sony Nur Irawan', 'SI', 'HDP'],
  ['DLR-HSM-01', 'PT. Hartono Raya Motor Semarang', 'Jawa Tengah', 'Semarang', 'Sony Nur Irawan', 'SI', 'HSM'],
  ['DLR-HSB-01', 'PT. Hartono Raya Motor Surabaya', 'Jawa Timur', 'Surabaya', 'Sony Nur Irawan', 'SI', 'HSB'],
  ['DLR-KSM-01', 'PT. Kedaung Satrya Motor', 'Jawa Timur', 'Surabaya', 'Novan Ardana', 'NA', 'KSM'],
  ['DLR-KBC-01', 'PT. Kumala Bintang Cemerlang', 'Sulawesi', 'Makassar', 'Novan Ardana', 'NA', 'KSBC'],
  ['DLR-MAR-01', 'PT. Mercindo Autorama', 'Jabodetabek', 'Jakarta Selatan', 'Novan Ardana', 'NA', 'MAR'],
  ['DLR-PRB-01', 'PT. Panji Rama Otomotif BSD', 'Jabodetabek', 'Tangerang Selatan', 'Novan Ardana', 'NA', 'PRB'],
  ['DLR-PRO-01', 'PT. Panji Rama Otomotif Gandaria', 'Jabodetabek', 'Jakarta Selatan', 'Novan Ardana', 'NA', 'PRO'],
  ['DLR-SMI-01', 'PT. Suri Motor Indonesia', 'Jabodetabek', 'Jakarta Selatan', 'Sony Nur Irawan', 'SI', 'SMI']
];

// ── Seed: VEHICLE_MODELS (salinan dari seed/models.csv) ─────────────────────
const MODEL_SEED = [
  ['W177', 'A-Class Sedan/Hatch (W177)', 'Sedan'],
  ['C118', 'CLA-Class (C118)', 'Sedan'],
  ['W206', 'C-Class (W206)', 'Sedan'],
  ['W205', 'C-Class (W205 - legacy)', 'Sedan'],
  ['W214', 'E-Class (W214)', 'Sedan'],
  ['W213', 'E-Class (W213 - legacy)', 'Sedan'],
  ['W223', 'S-Class (W223)', 'Sedan'],
  ['W222', 'S-Class (W222 - legacy)', 'Sedan'],
  ['X247', 'GLA-Class (X247)', 'SUV'],
  ['X253', 'GLC-Class (X253)', 'SUV'],
  ['X254', 'GLC-Class (X254)', 'SUV'],
  ['V167', 'GLE-Class (V167)', 'SUV'],
  ['X167', 'GLS-Class (X167)', 'SUV'],
  ['W463', 'G-Class (W463)', 'SUV'],
  ['H247', 'GLB-Class (H247)', 'SUV'],
  ['R232', 'SL-Class (R232)', 'Cabriolet'],
  ['A238', 'E-Class Cabriolet (A238)', 'Cabriolet'],
  ['C257', 'CLS-Class (C257)', 'Coupe'],
  ['V447', 'V-Class (V447)', 'MPV']
];

// ── Seed: EVIDENCE_RULES minimal (docs/01-schema.md §14) ────────────────────
const EVIDENCE_RULES_SEED = [
  ['ER-001', 'Symptom_Category', 'Software', 'Quick_Test', 'Initial Quick Test sebelum programming', 1, 'FALSE', 'Normal,Urgent,Critical', 'TRUE'],
  ['ER-002', 'Symptom_Category', 'Software', 'Programming_Log', 'Log versi software sebelum & sesudah', 2, 'FALSE', 'Normal,Urgent,Critical', 'TRUE'],
  ['ER-003', 'Symptom_Category', 'Software', 'SCN_Coding', 'Bukti SCN coding', 3, 'FALSE', 'Normal,Urgent,Critical', 'TRUE'],
  ['ER-004', 'Symptom_Category', 'Software', 'Quick_Test', 'Post-programming Quick Test', 4, 'FALSE', 'Normal,Urgent,Critical', 'TRUE'],
  ['ER-005', 'Symptom_Category', 'Electrical', 'Actual_Value', 'Actual values komponen terkait', 1, 'FALSE', 'Normal,Urgent,Critical', 'TRUE'],
  ['ER-006', 'Symptom_Category', 'Electrical', 'Guided_Test', 'Guided Test kelistrikan', 2, 'FALSE', 'Normal,Urgent,Critical', 'TRUE'],
  ['ER-007', 'Symptom_Category', 'Electrical', 'Wiring_Check', 'Inspeksi wiring/konektor', 3, 'FALSE', 'Normal,Urgent,Critical', 'TRUE'],
  ['ER-008', 'Symptom_Category', 'Electrical', 'Measurement', 'Pengukuran tegangan/tahanan', 4, 'FALSE', 'Normal,Urgent,Critical', 'TRUE'],
  ['ER-009', 'Symptom_Category', 'Electrical', 'Photo', 'Foto konektor terkait', 5, 'FALSE', 'Normal,Urgent,Critical', 'TRUE'],
  ['ER-010', 'Symptom_Category', 'Electrical', 'Repair_Doc', 'Dokumen upaya perbaikan sebelumnya', 6, 'FALSE', 'Normal,Urgent,Critical', 'TRUE']
];

// ── Seed: HOLIDAY_CALENDAR — libur nasional RI 2026 & 2027 (isi ulang manual
// sesuai SKB 3 Menteri terbaru; ini estimasi tanggal umum untuk placeholder) ─
const HOLIDAY_SEED = [
  ['2026-01-01', 'Tahun Baru Masehi', 'National', 'TRUE'],
  ['2026-02-17', 'Tahun Baru Imlek', 'National', 'TRUE'],
  ['2026-03-19', 'Hari Raya Nyepi', 'National', 'TRUE'],
  ['2026-03-20', 'Wafat Isa Almasih', 'National', 'TRUE'],
  ['2026-03-21', 'Isra Miraj', 'National', 'TRUE'],
  ['2026-04-01', 'Cuti Bersama Idul Fitri', 'Joint_Leave', 'TRUE'],
  ['2026-04-02', 'Cuti Bersama Idul Fitri', 'Joint_Leave', 'TRUE'],
  ['2026-04-03', 'Hari Raya Idul Fitri', 'National', 'TRUE'],
  ['2026-04-04', 'Hari Raya Idul Fitri', 'National', 'TRUE'],
  ['2026-05-01', 'Hari Buruh', 'National', 'TRUE'],
  ['2026-05-14', 'Kenaikan Isa Almasih', 'National', 'TRUE'],
  ['2026-05-31', 'Hari Raya Waisak', 'National', 'TRUE'],
  ['2026-06-01', 'Hari Lahir Pancasila', 'National', 'TRUE'],
  ['2026-06-16', 'Hari Raya Idul Adha', 'National', 'TRUE'],
  ['2026-07-06', 'Tahun Baru Islam', 'National', 'TRUE'],
  ['2026-08-17', 'Hari Kemerdekaan RI', 'National', 'TRUE'],
  ['2026-09-15', 'Maulid Nabi Muhammad SAW', 'National', 'TRUE'],
  ['2026-12-25', 'Hari Raya Natal', 'National', 'TRUE'],
  // TODO: lengkapi/koreksi tahun 2027 saat kalender resmi terbit.
  ['2027-01-01', 'Tahun Baru Masehi', 'National', 'TRUE']
];

// ── 1. ENTRY POINT: setupAll() ──────────────────────────────────────────────
function setupAll() {
  Logger.log('=== MB T-CASE setupAll() mulai ===');

  createAllSheets_();
  seedConfigSheet_();
  seedHolidayCalendar_();
  seedEvidenceRules_();
  seedDealers_();
  seedVehicleModels_();
  const admin = createFirstAdmin_();
  installTriggers_();

  Config_.invalidate();

  Logger.log('=== setupAll() SELESAI ===');
  Logger.log('Admin pertama: ' + admin.email + ' / PIN sementara: ' + admin.tempPin);
  Logger.log('PIN ini WAJIB diganti saat login pertama (Must_Change_PIN = TRUE).');
  return {
    sheetsCreated: SHEET_ORDER.length,
    adminEmail: admin.email,
    adminTempPin: admin.tempPin
  };
}

// ── 2. Pembuatan sheet + header + format Plain Text ─────────────────────────
function createAllSheets_() {
  const ss = getSpreadsheet_();

  SHEET_ORDER.forEach(function (sheetName) {
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
    } else {
      sheet.clear();
    }

    const headers = SCHEMA[sheetName];
    if (!headers) throw new AppError(ERROR_CODES.INTERNAL, 'SCHEMA tidak punya definisi untuk ' + sheetName);

    // WAJIB: format Plain Text dulu, baru tulis header+data. Lihat 01-schema.md
    // bagian "Konvensi" — kalau dibalik, sel yang sudah ter-parse Sheets sebagai
    // Date tidak otomatis kembali jadi string.
    applyPlainTextFormat_(sheet, headers);

    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, headers.length);
  });

  // Hapus "Sheet1" bawaan kalau masih ada dan kosong.
  const default1 = ss.getSheetByName('Sheet1');
  if (default1 && default1.getLastRow() === 0 && ss.getSheets().length > 1) {
    ss.deleteSheet(default1);
  }

  Logger.log('Sheet dibuat: ' + SHEET_ORDER.length + ' (lihat docs/01-schema.md §2A untuk VEHICLE_MODELS).');
}

/**
 * Set format kolom timestamp/date sebuah sheet ke Plain Text ('@'), untuk
 * sejumlah besar baris ke depan (bukan cuma baris yang sudah ada), supaya
 * baris baru yang ditulis nanti (case, event, dst) juga otomatis plain text.
 */
function applyPlainTextFormat_(sheet, headers) {
  const sheetName = sheet.getName();
  const tsColumns = TIMESTAMP_COLUMNS[sheetName] || [];
  if (tsColumns.length === 0) return;

  const MAX_ROWS_TO_FORMAT = 2000;
  tsColumns.forEach(function (colName) {
    const colIdx = headers.indexOf(colName);
    if (colIdx === -1) return;
    sheet.getRange(1, colIdx + 1, MAX_ROWS_TO_FORMAT, 1).setNumberFormat('@');
  });
}

// ── 3. Seed CONFIG ───────────────────────────────────────────────────────────
function seedConfigSheet_() {
  const sheet = getSheet_(SHEETS.CONFIG);
  const now = nowIso_();
  const rows = DEFAULT_CONFIG.map(function (row) {
    return [row[0], row[1], row[2], now];
  });
  sheet.getRange(2, 1, rows.length, SCHEMA[SHEETS.CONFIG].length).setValues(rows);
  Logger.log('CONFIG di-seed: ' + rows.length + ' key.');
}

// ── 4. Seed HOLIDAY_CALENDAR ─────────────────────────────────────────────────
function seedHolidayCalendar_() {
  const sheet = getSheet_(SHEETS.HOLIDAY_CALENDAR);
  sheet.getRange(2, 1, HOLIDAY_SEED.length, SCHEMA[SHEETS.HOLIDAY_CALENDAR].length).setValues(HOLIDAY_SEED);
  Logger.log('HOLIDAY_CALENDAR di-seed: ' + HOLIDAY_SEED.length + ' tanggal. CATATAN: kalender 2027 belum lengkap, lengkapi manual.');
}

// ── 5. Seed EVIDENCE_RULES ───────────────────────────────────────────────────
function seedEvidenceRules_() {
  const sheet = getSheet_(SHEETS.EVIDENCE_RULES);
  sheet.getRange(2, 1, EVIDENCE_RULES_SEED.length, SCHEMA[SHEETS.EVIDENCE_RULES].length).setValues(EVIDENCE_RULES_SEED);
  Logger.log('EVIDENCE_RULES di-seed: ' + EVIDENCE_RULES_SEED.length + ' rule.');
}

// ── 6. Seed DEALERS ───────────────────────────────────────────────────────────
function seedDealers_() {
  const sheet = getSheet_(SHEETS.DEALERS);
  const now = nowIso_();
  const rows = DEALER_SEED.map(function (d) {
    // Format: [Dealer_ID, Dealer_Name, Area, City, Area_Manager_Name, Area_Manager_Alias, Dealer_Code]
    // Output: [Dealer_ID, Dealer_Name, Area, Area_Manager_User_ID (kosong), City, Status, Created_At]
    return [d[0], d[1], d[2], '', d[3], 'ACTIVE', now];
  });
  sheet.getRange(2, 1, rows.length, SCHEMA[SHEETS.DEALERS].length).setValues(rows);
  Logger.log('DEALERS di-seed: ' + rows.length + ' dealer (data riil dengan area manager & dealer code).');
}

// ── 7. Seed VEHICLE_MODELS ───────────────────────────────────────────────────
function seedVehicleModels_() {
  const sheet = getSheet_(SHEETS.VEHICLE_MODELS);
  const now = nowIso_();
  const rows = MODEL_SEED.map(function (m) {
    return [m[0], m[1], m[2], 'TRUE', now];
  });
  sheet.getRange(2, 1, rows.length, SCHEMA[SHEETS.VEHICLE_MODELS].length).setValues(rows);
  Logger.log('VEHICLE_MODELS di-seed: ' + rows.length + ' model.');
}

// ── 8. User admin pertama ────────────────────────────────────────────────────
function createFirstAdmin_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new AppError(ERROR_CODES.BUSY, 'Sistem sedang sibuk, coba lagi.');
  try {
    const sheet = getSheet_(SHEETS.USERS);
    const email = 'customerservicesmarketing@gmail.com';

    // Guard: Email harus unik (01-schema.md §1). Karena ini setup pertama kali,
    // sheet USERS pasti masih kosong, tapi guard tetap ditulis di sini supaya
    // setupAll() aman dijalankan ulang tanpa membuat duplikat.
    const existing = sheet.getDataRange().getValues();
    const emailIdx = colIndex_(SHEETS.USERS, 'Email');
    for (let i = 1; i < existing.length; i++) {
      if (String(existing[i][emailIdx]).toLowerCase() === email.toLowerCase()) {
        Logger.log('Admin pertama sudah ada (' + email + '), tidak membuat duplikat.');
        return { email: email, tempPin: '(sudah ada — tidak dibuat ulang)' };
      }
    }

    const tempPin = generateTempPin_();
    const salt = generateSalt_();
    const pinHash = hashPin_(tempPin, salt);
    const now = nowIso_();

    const row = [
      'U-0001',            // User_ID
      'Admin Technical',   // Full_Name
      'IIDI_Tech_Mgr',      // Role — super admin pertama (03-rbac.md §5 asumsi terkonfirmasi)
      '',                   // Dealer_ID (kosong untuk role IIDI_*)
      '',                   // Dealer_Name
      email,                 // Email — kredensial login
      '',                   // Phone_WA
      pinHash,               // PIN_Hash
      salt,                  // PIN_Salt
      1,                      // PIN_Version
      'ACTIVE',               // Status
      'TRUE',                 // Must_Change_PIN
      0,                        // Failed_Attempts
      '',                        // Locked_Until
      'All',                      // Notif_Level
      now, now, ''                // Created_At, Updated_At, Last_Login_At
    ];
    sheet.getRange(2, 1, 1, row.length).setValues([row]);

    // Kirim PIN sementara ke email admin. Ini pengecualian sengaja terhadap
    // arsitektur queue (08-notifications.md §1): pengiriman langsung, sekali
    // saja, saat bootstrap sistem — bukan dalam alur request user biasa, dan
    // queue processor (50_Notify.gs) belum ada di Fase 0.
    try {
      MailApp.sendEmail({
        to: email,
        subject: '[MB T-CASE] Akun admin pertama dibuat',
        htmlBody:
          'Akun admin pertama MB T-CASE sudah dibuat.<br><br>' +
          'Email: ' + email + '<br>' +
          'PIN sementara: <b>' + tempPin + '</b><br><br>' +
          'PIN ini wajib diganti saat login pertama.',
        name: 'MB T-CASE'
      });
    } catch (mailErr) {
      Logger.log('Gagal kirim email PIN sementara (tidak fatal): ' + mailErr);
    }

    return { email: email, tempPin: tempPin };
  } finally {
    lock.releaseLock();
  }
}

/** PIN 6 digit, bukan digit sama semua, bukan berurutan naik/turun, bukan 000000. */
function generateTempPin_() {
  let pin;
  do {
    pin = String(Math.floor(100000 + Math.random() * 900000));
  } while (!isValidPin_(pin));
  return pin;
}

function isValidPin_(pin) {
  if (!/^\d{6}$/.test(pin)) return false;
  if (/^(\d)\1{5}$/.test(pin)) return false; // semua digit sama
  const asc = '0123456789', desc = '9876543210';
  if (asc.indexOf(pin) !== -1 || desc.indexOf(pin) !== -1) return false; // berurutan
  return true;
}

// ── 9. Trigger ────────────────────────────────────────────────────────────────
const TRIGGER_HANDLERS = ['slaJob_', 'notifyProcessQueue_', 'dashboardRebuildAll_', 'dailyDigest_'];

function installTriggers_() {
  // Idempoten: hapus dulu trigger lama dengan handler yang sama, supaya
  // setupAll() aman dijalankan berkali-kali tanpa trigger dobel.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (TRIGGER_HANDLERS.indexOf(t.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('slaJob_').timeBased().everyMinutes(30).create();
  ScriptApp.newTrigger('notifyProcessQueue_').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('dashboardRebuildAll_').timeBased().everyMinutes(30).create();
  ScriptApp.newTrigger('dailyDigest_').timeBased().atHour(8).nearMinute(15).everyDays(1).create();

  Logger.log('4 trigger terpasang: slaJob_ (30mnt), notifyProcessQueue_ (5mnt), dashboardRebuildAll_ (30mnt), dailyDigest_ (08:15).');
}

// Stub — badan asli ditulis di fase masing-masing. Ada di sini SEKARANG supaya
// trigger yang sudah terpasang tidak gagal ("function not found") sebelum fase
// itu dikerjakan. PINDAHKAN ke file fase yang sesuai saat fase itu dikerjakan,
// lalu HAPUS stub ini dari 90_Setup.gs.
function slaJob_() {
  // TODO Fase 3 — lihat docs/05-sla-engine.md §8. Pindahkan ke 31_SlaJob.gs.
}
function notifyProcessQueue_() {
  // TODO Fase 6 — lihat docs/08-notifications.md §1. Pindahkan ke 50_Notify.gs.
}
function dashboardRebuildAll_() {
  // TODO Fase 8 — lihat docs/06-dashboard.md §1. Pindahkan ke 60_Dashboard.gs.
}
function dailyDigest_() {
  // TODO Fase 6 — lihat docs/08-notifications.md §6. Pindahkan ke 50_Notify.gs.
  // Ingat: hari kerja saja — cek isWorkingDay_() begitu 30_SlaEngine.gs ada (Fase 3).
}

// ── 10. Data dummy untuk uji dashboard/performa ──────────────────────────────
// TIDAK memakai CaseService (Fase 2) atau SlaEngine (Fase 3) — lihat catatan
// desain di kepala file. Panggil dari editor GAS: seedDemoData(50)
function seedDemoData(n) {
  n = n || 50;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new AppError(ERROR_CODES.BUSY, 'Sistem sedang sibuk, coba lagi.');

  try {
    const sheet = getSheet_(SHEETS.CASES_MASTER);
    const cfg = Config_.all();
    let counter = parseInt(cfg.CASE_COUNTER || '0', 10);

    const dealerIds = DEALER_SEED.map(function (d) { return d[0]; });
    const modelCodes = MODEL_SEED.map(function (m) { return m[0]; });
    const symptomCategories = ['Engine', 'Transmission', 'Electrical', 'Software', 'Chassis', 'Body', 'HVAC', 'Infotainment', 'Other'];
    const statuses = ['Created', 'Open', 'In Progress', 'Waiting Dealer Reply', 'Waiting IIDI', 'Escalated to MBAG', 'Request Closure', 'Closed'];
    const priorities = ['Normal', 'Normal', 'Normal', 'Urgent', 'Critical']; // bobot ke Normal
    const warrantyStatuses = ['In_Warranty', 'Out_Warranty', 'Goodwill', 'Extended'];

    const rows = [];
    for (let i = 0; i < n; i++) {
      counter++;
      const caseNo = 'CN-' + String(counter).padStart(4, '0');
      const dealerId = pickRandom_(dealerIds);
      const model = pickRandom_(modelCodes);
      const status = pickRandom_(statuses);
      const symptom = pickRandom_(symptomCategories);
      const ageDays = Math.floor(Math.random() * 45); // umur case 0-45 hari kalender
      const createdAt = addCalendarDays_(new Date(), -ageDays);
      const isClosed = status === 'Closed';
      const qualityScore = Math.floor(40 + Math.random() * 60);

      rows.push([
        caseNo,                                              // Case_No
        generateFakeVin_(),                                  // VIN
        model,                                                // Model
        '', '',                                               // Engine_No, Trans_No
        Math.floor(5000 + Math.random() * 95000),             // Mileage
        2019 + Math.floor(Math.random() * 7),                 // Prod_Year
        '',                                                    // Reg_No
        pickRandom_(warrantyStatuses),                         // Warranty_Status
        '',                                                     // Cust_Name (kosong — data dummy tidak butuh nama pelanggan)
        'WO-' + counter,                                          // Complaint_No
        'Keluhan dummy untuk uji dashboard (' + symptom + ').',    // Complaint_Desc
        symptom,                                                    // Symptom_Category
        toIsoDate_(createdAt),                                       // Date_Occurred
        pickRandom_(['Always', 'Intermittent', 'Once', 'Under_Condition']), // Frequency
        '',                                                            // Driving_Condition
        pickRandom_(['Drivable', 'Not_Drivable', 'In_Workshop']),        // Vehicle_Status
        '', '', '', '',                                                   // Outside_Temp, Fuel_Level, Driving_Style, Road_Condition
        dealerId,                                                          // Dealer_ID
        'U-0001',                                                          // Created_By_User_ID (dummy, semua "dibuat" admin)
        pickRandom_(priorities),                                           // Priority
        status,                                                            // Status
        '', '',                                                            // Current_Owner_User_ID, Current_Owner_Role
        (status === 'Waiting Dealer Reply' || status === 'Waiting IIDI' || status === 'Escalated to MBAG') ? 'IIDI_Technical_Review' : '', // Current_Waiting_Reason
        qualityScore,                                                       // Quality_Score
        qualityScore >= 85 ? 'Excellent' : qualityScore >= 70 ? 'Good' : qualityScore >= 55 ? 'Fair' : 'Poor', // Score_Category
        isClosed ? 'Active' : pickRandom_(['Active', 'No_Recent_Activity', 'Stale']), // Activity_Status
        toIsoDateTime_(addCalendarDays_(createdAt, 3)),                     // Dealer_Self_Diagnosis_Deadline
        toIsoDateTime_(addCalendarDays_(createdAt, 4)),                     // IIDI_Response_Deadline
        toIsoDateTime_(addCalendarDays_(createdAt, 6)),                     // Dealer_Response_Deadline
        toIsoDateTime_(addCalendarDays_(createdAt, 8)),                     // IIDI_Decision_Deadline
        toIsoDateTime_(addCalendarDays_(createdAt, 10)),                    // Closure_Deadline
        toIsoDateTime_(createdAt),                                          // Created_At
        toIsoDateTime_(createdAt),                                          // Updated_At
        toIsoDateTime_(addCalendarDays_(createdAt, Math.floor(Math.random() * ageDays))), // Last_Activity_At
        '',                                                                  // Last_Activity_By
        status === 'Created' ? '' : toIsoDateTime_(addCalendarDays_(createdAt, 1)), // Submitted_To_IIDI_At
        '',                                                                    // First_IIDI_Response_At
        status === 'Escalated to MBAG' ? toIsoDateTime_(addCalendarDays_(createdAt, 5)) : '', // Escalated_At
        isClosed ? toIsoDateTime_(addCalendarDays_(createdAt, ageDays)) : '',   // Closed_At
        isClosed ? 'U-0001' : '',                                               // Closed_By
        isClosed ? pickRandom_(['Solved', 'Not_Reproducible', 'Duplicate', 'Cancelled_By_Dealer']) : '', // Closure_Type
        ''                                                                       // MBAG_Ref_No
      ]);
    }

    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, SCHEMA[SHEETS.CASES_MASTER].length).setValues(rows);

    // Update CASE_COUNTER
    const cfgSheet = getSheet_(SHEETS.CONFIG);
    const cfgRows = cfgSheet.getDataRange().getValues();
    const kIdx = colIndex_(SHEETS.CONFIG, 'Key');
    const vIdx = colIndex_(SHEETS.CONFIG, 'Value');
    for (let i = 1; i < cfgRows.length; i++) {
      if (cfgRows[i][kIdx] === 'CASE_COUNTER') {
        cfgSheet.getRange(i + 1, vIdx + 1).setValue(String(counter));
        break;
      }
    }
    Config_.invalidate();

    Logger.log('seedDemoData: ' + rows.length + ' case dummy dibuat (CN-' +
      String(counter - rows.length + 1).padStart(4, '0') + ' s/d CN-' + String(counter).padStart(4, '0') + ').');
    return { created: rows.length, from: counter - rows.length + 1, to: counter };
  } finally {
    lock.releaseLock();
  }
}

// ── Util kecil khusus seed ───────────────────────────────────────────────────
function pickRandom_(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function addCalendarDays_(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}
function toIsoDate_(date) {
  return Utilities.formatDate(date, 'Asia/Jakarta', 'yyyy-MM-dd');
}
function toIsoDateTime_(date) {
  return Utilities.formatDate(date, 'Asia/Jakarta', "yyyy-MM-dd'T'HH:mm:ssXXX");
}
function generateFakeVin_() {
  const chars = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789'; // tanpa I, O, Q sesuai standar VIN
  let vin = 'WDD'; // prefix umum Mercedes-Benz
  for (let i = 0; i < 14; i++) vin += chars.charAt(Math.floor(Math.random() * chars.length));
  return vin;
}