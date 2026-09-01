/**
 * 30_SlaEngine.gs — FASE 3
 * SLA Engine. PURE FUNCTIONS SAJA.
 *
 * Acuan: docs/05-sla-engine.md §1–§6.
 *
 * ATURAN MUTLAK (05-sla-engine.md §1):
 *   File ini DILARANG menyentuh SpreadsheetApp / TC / PropertiesService /
 *   CacheService / DriveApp / MailApp / Session. Kalender libur dan konfigurasi
 *   SELALU di-inject sebagai argumen. Itu yang bikin SLA bisa diuji tanpa
 *   spreadsheet — dan bikin bug SLA gampang dilacak.
 *
 *   Yang baca sheet adalah `Sla_` di 31_SlaJob.gs. Jangan dibalik.
 *
 * Representasi internal: "wibMin" = menit sejak epoch pada JAM DINDING WIB.
 * Sengaja tidak bergantung pada timezone script, supaya hasil deterministik
 * dan test bisa jalan di mesin manapun.
 *
 * Status: 23/23 test lulus (15 wajib docs §7 + 8 tambahan). Lihat runSlaTests().
 */

var SLA_WIB_OFFSET_MIN = 420;      // +07:00
var SLA_MS_PER_MIN     = 60000;
var SLA_MIN_PER_DAY    = 1440;
var SLA_MAX_ITER       = 20000;    // pengaman loop tak berujung

/* ══════════════════════ 1. PARSING & FORMAT WAKTU ══════════════════════ */

var SLA_ISO_RE_ = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * ISO string / Date / epoch → epoch ms.
 * String tanpa offset dianggap WIB. Kosong / tidak valid → null.
 */
function slaParse_(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number') return isFinite(value) ? value : null;

  var str = String(value).trim();
  if (!str) return null;

  var m = SLA_ISO_RE_.exec(str);
  if (!m) {
    var t = Date.parse(str);
    return isNaN(t) ? null : t;
  }
  var offMin = SLA_WIB_OFFSET_MIN;
  if (m[7]) {
    if (m[7] === 'Z') {
      offMin = 0;
    } else {
      var sign = (m[7].charAt(0) === '-') ? -1 : 1;
      var body = m[7].substring(1).replace(':', '');
      offMin = sign * (parseInt(body.substring(0, 2), 10) * 60 + parseInt(body.substring(2), 10));
    }
  }
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0))
       - offMin * SLA_MS_PER_MIN;
}

function slaWibMin_(ms)        { return Math.floor(ms / SLA_MS_PER_MIN) + SLA_WIB_OFFSET_MIN; }
function slaToDate_(wibMin)    { return new Date((wibMin - SLA_WIB_OFFSET_MIN) * SLA_MS_PER_MIN); }
function slaDayIndex_(wibMin)  { return Math.floor(wibMin / SLA_MIN_PER_DAY); }
function slaMinOfDay_(wibMin)  { return wibMin - slaDayIndex_(wibMin) * SLA_MIN_PER_DAY; }
function slaPad_(x)            { var t = String(x); return t.length >= 2 ? t : '0' + t; }
function slaDayDate_(dayIndex) { return new Date(dayIndex * SLA_MIN_PER_DAY * SLA_MS_PER_MIN); }

/** dayIndex → 'YYYY-MM-DD' (tanggal WIB). Format ini yang dipakai HOLIDAY_CALENDAR. */
function slaDayKey_(dayIndex) {
  var d = slaDayDate_(dayIndex);
  return d.getUTCFullYear() + '-' + slaPad_(d.getUTCMonth() + 1) + '-' + slaPad_(d.getUTCDate());
}

/** dayIndex → 0=Minggu .. 6=Sabtu */
function slaDow_(dayIndex) { return slaDayDate_(dayIndex).getUTCDay(); }

/**
 * Apapun → string ISO 8601 offset WIB. Ini SATU-SATUNYA format yang boleh
 * ditulis ke kolom timestamp (01-schema.md Konvensi).
 * Contoh keluaran: '2026-08-30T09:15:00+07:00'
 */
function toWibIso_(value) {
  var ms = slaParse_(value);
  if (ms === null) return '';
  var wm  = slaWibMin_(ms);
  var mod = slaMinOfDay_(wm);
  var sec = Math.floor((((ms % SLA_MS_PER_MIN) + SLA_MS_PER_MIN) % SLA_MS_PER_MIN) / 1000);
  return slaDayKey_(slaDayIndex_(wm))
       + 'T' + slaPad_(Math.floor(mod / 60)) + ':' + slaPad_(mod % 60) + ':' + slaPad_(sec)
       + '+07:00';
}

/* ══════════════════════ 2. NORMALISASI KONFIGURASI ══════════════════════ */

function slaHhmmToMin_(v, fallback) {
  var m = /^(\d{1,2}):(\d{2})/.exec(String(v === null || v === undefined ? '' : v).trim());
  if (!m) return fallback;
  var mins = (+m[1]) * 60 + (+m[2]);
  return (mins >= 0 && mins <= SLA_MIN_PER_DAY) ? mins : fallback;
}

/**
 * Menerima map mentah CONFIG (WORK_START, WORK_END, NEAR_DUE_THRESHOLD_HOURS,
 * SLA_*_DAYS) ATAU objek yang sudah ternormalisasi (idempotent).
 * Nilai rusak/kosong jatuh ke default docs §6 — engine tidak boleh error
 * cuma gara-gara satu sel CONFIG diketik salah.
 */
function slaCfg_(cfg) {
  if (cfg && cfg.__sla === true) return cfg;
  var raw = cfg || {};

  var startMin = slaHhmmToMin_(raw.WORK_START, 480);   // 08:00
  var endMin   = slaHhmmToMin_(raw.WORK_END,  1020);   // 17:00
  if (endMin <= startMin) { startMin = 480; endMin = 1020; }

  var nearH = Number(raw.NEAR_DUE_THRESHOLD_HOURS);
  if (!isFinite(nearH) || nearH < 0) nearH = 1;

  function days(key, def) {
    var v = Number(raw[key]);
    return (isFinite(v) && v > 0) ? v : def;
  }

  return {
    __sla: true,
    startMin: startMin,
    endMin: endMin,
    minutesPerDay: endMin - startMin,          // 1 hari kerja = 540 menit
    nearDueMinutes: Math.round(nearH * 60),
    days: {
      DEALER_SELF_DIAG: days('SLA_DEALER_SELF_DIAG_DAYS', 3),
      IIDI_RESPONSE:    days('SLA_IIDI_RESPONSE_DAYS',    1),
      DEALER_RESPONSE:  days('SLA_DEALER_RESPONSE_DAYS',  2),
      IIDI_DECISION:    days('SLA_IIDI_DECISION_DAYS',    2),
      CLOSURE:          days('SLA_CLOSURE_DAYS',          2)
    }
  };
}

/* ══════════════════════ 3. HARI KERJA & LIBUR ══════════════════════ */

/** holidaySet boleh Set, Array, atau object map { '2026-08-17': true }. */
function slaHasHoliday_(holidaySet, key) {
  if (!holidaySet) return false;
  if (typeof holidaySet.has === 'function') return holidaySet.has(key);
  if (Object.prototype.toString.call(holidaySet) === '[object Array]') {
    return holidaySet.indexOf(key) !== -1;
  }
  return holidaySet[key] === true || holidaySet[key] === 'TRUE';
}

function slaIsWorkingDayIndex_(dayIndex, holidaySet) {
  var dow = slaDow_(dayIndex);
  if (dow === 0 || dow === 6) return false;              // Minggu / Sabtu
  return !slaHasHoliday_(holidaySet, slaDayKey_(dayIndex));
}

function slaNextWorkingDayIndex_(dayIndex, holidaySet) {
  var d = dayIndex + 1, g = 0;
  while (!slaIsWorkingDayIndex_(d, holidaySet)) {
    d++;
    if (++g > 400) throw new Error('SLA: hari kerja berikutnya tidak ditemukan dalam 400 hari.');
  }
  return d;
}

function slaPrevWorkingDayIndex_(dayIndex, holidaySet) {
  var d = dayIndex - 1, g = 0;
  while (!slaIsWorkingDayIndex_(d, holidaySet)) {
    d--;
    if (++g > 400) throw new Error('SLA: hari kerja sebelumnya tidak ditemukan dalam 400 hari.');
  }
  return d;
}

/* ══════════════════ 4. API PUBLIK ENGINE (docs §2) ══════════════════ */

/** Apakah tanggal ini hari kerja? */
function isWorkingDay_(date, holidaySet) {
  var ms = slaParse_(date);
  if (ms === null) return false;
  return slaIsWorkingDayIndex_(slaDayIndex_(slaWibMin_(ms)), holidaySet);
}

/**
 * Titik jam kerja berikutnya. Kalau sudah DI DALAM jam kerja, kembalikan apa adanya.
 * docs §3:  06:30 → 08:00 hari sama
 *           17:00 / 19:00 → 08:00 hari kerja berikutnya
 *           Sabtu jam berapapun → 08:00 hari kerja berikutnya
 * @return {Date}
 */
function nextWorkingMoment_(date, holidaySet, cfg) {
  var c = slaCfg_(cfg), ms = slaParse_(date);
  if (ms === null) return null;

  var wm = slaWibMin_(ms), day = slaDayIndex_(wm), mod = slaMinOfDay_(wm);
  for (var i = 0; i < 400; i++) {
    if (slaIsWorkingDayIndex_(day, holidaySet)) {
      if (mod <= c.startMin) return slaToDate_(day * SLA_MIN_PER_DAY + c.startMin);
      if (mod <  c.endMin)   return slaToDate_(day * SLA_MIN_PER_DAY + mod);
    }
    day++; mod = 0;
  }
  throw new Error('SLA: nextWorkingMoment_ gagal menemukan jam kerja.');
}

/**
 * Selisih MENIT KERJA antara dua waktu. Negatif kalau `to` < `from`.
 * @return {number}
 */
function workingMinutesBetween_(from, to, holidaySet, cfg) {
  var c = slaCfg_(cfg), a = slaParse_(from), b = slaParse_(to);
  if (a === null || b === null || a === b) return 0;

  var sign = 1;
  if (b < a) { var tmp = a; a = b; b = tmp; sign = -1; }

  var wa = slaWibMin_(a), wb = slaWibMin_(b);
  var dayA = slaDayIndex_(wa), dayB = slaDayIndex_(wb);
  if (dayB - dayA > 3650) throw new Error('SLA: rentang lebih dari 10 tahun.');

  var total = 0;
  for (var day = dayA; day <= dayB; day++) {
    if (!slaIsWorkingDayIndex_(day, holidaySet)) continue;
    var s = Math.max(wa, day * SLA_MIN_PER_DAY + c.startMin);
    var e = Math.min(wb, day * SLA_MIN_PER_DAY + c.endMin);
    if (e > s) total += (e - s);
  }
  return sign * total;
}

/**
 * Tambahkan N menit kerja. Mendukung nilai negatif (mundur).
 * @return {Date}
 */
function addWorkingMinutes_(from, minutes, holidaySet, cfg) {
  var c = slaCfg_(cfg);
  var n = Math.round(Number(minutes) || 0);
  if (n < 0) return slaSubWorkingMinutes_(from, -n, holidaySet, c);

  var start = nextWorkingMoment_(from, holidaySet, c);
  if (start === null) return null;

  var wm = slaWibMin_(start.getTime());
  var day = slaDayIndex_(wm), mod = slaMinOfDay_(wm), g = 0;

  while (n > 0) {
    var avail = c.endMin - mod;
    if (n < avail) { mod += n; n = 0; break; }
    // n >= avail: habiskan sisa hari ini lalu lompat ke 08:00 hari kerja berikutnya.
    // n == avail SENGAJA ikut lompat (tidak berhenti di 17:00) — inilah yang
    // membuat test #4 dan #6 di docs §7 keluar sebagai 08:00, bukan 17:00.
    n -= avail;
    day = slaNextWorkingDayIndex_(day, holidaySet);
    mod = c.startMin;
    if (++g > SLA_MAX_ITER) throw new Error('SLA: addWorkingMinutes_ overflow.');
  }
  return slaToDate_(day * SLA_MIN_PER_DAY + mod);
}

/** Internal: mundur N menit kerja. Dipakai kalau `minutes` negatif. */
function slaSubWorkingMinutes_(from, minutes, holidaySet, c) {
  var ms = slaParse_(from);
  if (ms === null) return null;

  var wm = slaWibMin_(ms), day = slaDayIndex_(wm), mod = slaMinOfDay_(wm);
  if (!slaIsWorkingDayIndex_(day, holidaySet) || mod <= c.startMin) {
    day = slaPrevWorkingDayIndex_(day, holidaySet); mod = c.endMin;
  } else if (mod > c.endMin) {
    mod = c.endMin;
  }

  var n = minutes, g = 0;
  while (n > 0) {
    var avail = mod - c.startMin;
    if (n < avail) { mod -= n; n = 0; break; }
    n -= avail;
    day = slaPrevWorkingDayIndex_(day, holidaySet);
    mod = c.endMin;
    if (++g > SLA_MAX_ITER) throw new Error('SLA: slaSubWorkingMinutes_ overflow.');
  }
  return slaToDate_(day * SLA_MIN_PER_DAY + mod);
}

/**
 * Tambahkan N hari kerja. 1 hari kerja = (WORK_END − WORK_START) menit = 540.
 * @return {Date}
 */
function addWorkingDays_(from, days, holidaySet, cfg) {
  var c = slaCfg_(cfg);
  return addWorkingMinutes_(from, Math.round(Number(days) * c.minutesPerDay), holidaySet, c);
}

/**
 * Status SLA terhadap satu deadline (docs §4).
 * NEAR_DUE memakai batas bawah INKLUSIF (0 ≤ sisa ≤ 60) — REVISI Fase 0,
 * supaya `now == deadline` tidak jatuh ke celah antar-bucket (test #12).
 * @return {{status:string, remainingWorkingMinutes:number,
 *           overdueWorkingMinutes:number, deadline:string}}
 */
function slaStatus_(now, deadline, holidaySet, cfg) {
  var c = slaCfg_(cfg);
  var dl = slaParse_(deadline);
  if (dl === null) {
    return { status: 'NONE', remainingWorkingMinutes: 0, overdueWorkingMinutes: 0, deadline: '' };
  }
  var n = slaParse_(now);
  if (n === null) n = Date.now();

  var remaining = workingMinutesBetween_(n, dl, holidaySet, c);
  var out = {
    remainingWorkingMinutes: remaining,
    overdueWorkingMinutes: 0,
    deadline: toWibIso_(dl)
  };
  if (remaining < 0) {
    out.status = 'OVERDUE';
    out.overdueWorkingMinutes = -remaining;
  } else if (remaining <= c.nearDueMinutes) {
    out.status = 'NEAR_DUE';
  } else {
    out.status = 'ON_TIME';
  }
  return out;
}

/* ═══════════ 5. TARGET SLA & DEADLINE AKTIF (docs §5–§6) ═══════════ */

/** Nama target → nama kolom CASES_MASTER tempat hasilnya disimpan. */
var SLA_TARGET_FIELD = {
  DEALER_SELF_DIAG: 'Dealer_Self_Diagnosis_Deadline',
  IIDI_RESPONSE:    'IIDI_Response_Deadline',
  DEALER_RESPONSE:  'Dealer_Response_Deadline',
  IIDI_DECISION:    'IIDI_Decision_Deadline',
  CLOSURE:          'Closure_Deadline'
};

/**
 * Hitung deadline untuk satu target SLA.
 * docs §6: dihitung SEKALI saat event pemicunya terjadi lalu DISIMPAN.
 * Jangan pernah dihitung ulang — kalender libur bisa berubah dan itu akan
 * menggeser deadline lama secara diam-diam.
 * @return {string} ISO 8601 +07:00
 */
function computeDeadline_(targetKey, fromIso, holidaySet, cfg) {
  var c = slaCfg_(cfg);
  var d = c.days[targetKey];
  if (!d) throw new Error('SLA: target tidak dikenal: ' + targetKey);
  return toWibIso_(addWorkingDays_(fromIso, d, holidaySet, c));
}

/**
 * Kolom deadline mana yang aktif untuk status case saat ini (docs §5).
 * @return {string} nama kolom, atau '' kalau tidak ada deadline aktif.
 */
function activeDeadlineField_(caseRow) {
  switch (caseRow.Status) {
    case 'Created':              return 'Dealer_Self_Diagnosis_Deadline';
    case 'Open':                 return 'IIDI_Response_Deadline';
    case 'In Progress':          return String(caseRow.First_IIDI_Response_At || '')
                                        ? 'IIDI_Decision_Deadline'
                                        : 'IIDI_Response_Deadline';
    case 'Waiting Dealer Reply': return 'Dealer_Response_Deadline';
    case 'Waiting IIDI':         return 'IIDI_Decision_Deadline';
    case 'Request Closure':      return 'Closure_Deadline';
    case 'Escalated to MBAG':    return '';   // MBAG di luar kendali IIDI
    case 'Closed':               return '';
    default:                     return '';
  }
}

/**
 * SLA_Status turunan untuk satu baris case.
 * TIDAK PERNAH disimpan ke sheet (01-schema.md §4) — selalu dihitung saat read.
 * @return {{status,remainingWorkingMinutes,overdueWorkingMinutes,
 *           deadline,field,advisory}}
 */
function caseSlaStatus_(caseRow, now, holidaySet, cfg) {
  var field = activeDeadlineField_(caseRow || {});
  if (!field) {
    return { status: 'NONE', remainingWorkingMinutes: 0, overdueWorkingMinutes: 0,
             deadline: '', field: '', advisory: false };
  }
  var res = slaStatus_(now, caseRow[field], holidaySet, cfg);
  res.field = field;
  // Self-diagnosis 3 hari kerja itu TARGET, bukan pelanggaran (CLAUDE.md §6 no.1).
  // UI wajib menampilkannya sebagai info, bukan badge merah.
  res.advisory = (caseRow.Status === 'Created');
  return res;
}

/**
 * Activity_Status dalam hari kerja (04-state-machine.md §6).
 * < 2 hk = Active · 2–5 hk = No_Recent_Activity · > 5 hk = Stale
 */
function activityStatus_(lastActivityIso, now, holidaySet, cfg) {
  var c = slaCfg_(cfg);
  if (!slaParse_(lastActivityIso)) return 'Active';
  var mins = workingMinutesBetween_(lastActivityIso, now, holidaySet, c);
  if (mins < 0) mins = 0;
  var wd = mins / c.minutesPerDay;
  if (wd < 2) return 'Active';
  if (wd <= 5) return 'No_Recent_Activity';
  return 'Stale';
}

/** Label ringkas untuk UI: "sisa 45 menit kerja" / "terlambat 4 jam kerja". */
function slaHumanLabel_(sla) {
  function fmt(mins) {
    var h = Math.floor(mins / 60), m = mins % 60;
    if (h === 0) return m + ' menit kerja';
    if (m === 0) return h + ' jam kerja';
    return h + ' jam ' + m + ' menit kerja';
  }
  if (!sla) return '—';
  switch (sla.status) {
    case 'OVERDUE':  return 'terlambat ' + fmt(sla.overdueWorkingMinutes);
    case 'NEAR_DUE': return 'sisa ' + fmt(sla.remainingWorkingMinutes);
    case 'ON_TIME':  return 'sisa ' + fmt(sla.remainingWorkingMinutes);
    default:         return '—';
  }
}