/**
 * 31_SlaJob.gs — FASE 3
 *
 * Dua isi:
 *   A. `Sla_`      — ADAPTER. Satu-satunya tempat yang membaca HOLIDAY_CALENDAR
 *                    dan CONFIG, lalu meneruskannya ke pure function di
 *                    30_SlaEngine.gs. Inilah yang dipanggil 20_CaseService.gs
 *                    lewat jembatan deadline()/slaOf()/activityOf() (baris 62–78).
 *   B. `slaJob()`  — Job trigger tiap 30 menit (docs/05-sla-engine.md §8).
 *
 * Pemisahan ini disengaja: engine tetap murni & bisa diuji tanpa spreadsheet,
 * pembacaan sheet dikurung di sini. JANGAN memindahkan TC.* ke 30_SlaEngine.gs.
 */

/* ════════════════════════ A. ADAPTER `Sla_` ════════════════════════ */

var Sla_ = (function () {

  // Memo per-eksekusi. Sheet libur & CONFIG dibaca maksimal SEKALI per request,
  // meskipun case.list memanggil statusOf() 50 kali.
  var _holidays = null;
  var _cfg = null;

  /** Nama sheet HOLIDAY_CALENDAR — dicari fleksibel agar cocok apapun key di TC.S. */
  function holidaySheet() {
    var S = (typeof TC !== 'undefined' && TC.S) ? TC.S : {};
    return S.HOLIDAYS || S.HOLIDAY || S.HOLIDAY_CALENDAR || S.CALENDAR || 'HOLIDAY_CALENDAR';
  }

  /** @return {Object} map { '2026-08-17': true } untuk baris Active = TRUE. */
  function holidays() {
    if (_holidays) return _holidays;
    var out = {};
    try {
      var rows = TC.readAll(holidaySheet()) || [];
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (String(r.Active).toUpperCase() !== 'TRUE') continue;
        var key = toWibIso_(r.Date).substring(0, 10);   // normalisasi Date/string apapun
        if (/^\d{4}-\d{2}-\d{2}$/.test(key)) out[key] = true;
      }
    } catch (e) {
      // Sheet libur belum ada / gagal dibaca: jangan matikan sistem.
      // Fallback = Sabtu-Minggu saja. Dicatat supaya ketahuan, bukan didiamkan.
      console.error('Sla_.holidays: ' + e);
    }
    _holidays = out;
    return out;
  }

  function cfgStr(key, def) {
    try {
      var r = TC.find(TC.S.CONFIG, 'Key', key);
      var v = r ? String(r.Value).trim() : '';
      return v || def;
    } catch (e) { return def; }
  }
  function cfgNum(key, def) {
    try { return TC.cfgNum(key, def); } catch (e) { return def; }
  }

  /** Konfigurasi SLA ternormalisasi (lihat slaCfg_ di 30_SlaEngine.gs). */
  function cfg() {
    if (_cfg) return _cfg;
    _cfg = slaCfg_({
      WORK_START: cfgStr('WORK_START', '08:00'),
      WORK_END:   cfgStr('WORK_END',   '17:00'),
      NEAR_DUE_THRESHOLD_HOURS:  cfgNum('NEAR_DUE_THRESHOLD_HOURS', 1),
      SLA_DEALER_SELF_DIAG_DAYS: cfgNum('SLA_DEALER_SELF_DIAG_DAYS', 3),
      SLA_IIDI_RESPONSE_DAYS:    cfgNum('SLA_IIDI_RESPONSE_DAYS', 1),
      SLA_DEALER_RESPONSE_DAYS:  cfgNum('SLA_DEALER_RESPONSE_DAYS', 2),
      SLA_IIDI_DECISION_DAYS:    cfgNum('SLA_IIDI_DECISION_DAYS', 2),
      SLA_CLOSURE_DAYS:          cfgNum('SLA_CLOSURE_DAYS', 2)
    });
    return _cfg;
  }

  return {
    /**
     * Dipakai 20_CaseService.gs → deadline(ts, workingDays).
     * @return {string} ISO 8601 +07:00
     */
    deadline: function (fromIso, workingDays) {
      var d = Number(workingDays);
      if (!isFinite(d) || d <= 0) return '';
      return toWibIso_(addWorkingDays_(fromIso, d, holidays(), cfg()));
    },

    /** Versi bernama target (DEALER_SELF_DIAG, IIDI_RESPONSE, ...). */
    deadlineFor: function (targetKey, fromIso) {
      return computeDeadline_(targetKey, fromIso, holidays(), cfg());
    },

    /**
     * Dipakai 20_CaseService.gs → slaOf(row).
     * @return {{status,remainingWorkingMinutes,overdueWorkingMinutes,deadline,field,advisory,label}}
     */
    statusOf: function (caseRow, nowIso) {
      var res = caseSlaStatus_(caseRow, nowIso || TC.nowIso(), holidays(), cfg());
      res.label = slaHumanLabel_(res);
      return res;
    },

    /** Dipakai 20_CaseService.gs → activityOf(r.Last_Activity_At). */
    activityStatus: function (lastActivityIso, nowIso) {
      return activityStatus_(lastActivityIso, nowIso || TC.nowIso(), holidays(), cfg());
    },

    /** Status terhadap deadline lepas (bukan dari baris case). */
    statusAgainst: function (deadlineIso, nowIso) {
      return slaStatus_(nowIso || TC.nowIso(), deadlineIso, holidays(), cfg());
    },

    isWorkingDay: function (d) { return isWorkingDay_(d, holidays()); },
    label:        function (sla) { return slaHumanLabel_(sla); },
    cfg:          cfg,
    holidays:     holidays,

    /** Panggil setelah HOLIDAY_CALENDAR atau CONFIG diubah dalam eksekusi yang sama. */
    invalidate: function () { _holidays = null; _cfg = null; }
  };
})();

/* ═══════════════ B. JOB TRIGGER — docs/05-sla-engine.md §8 ═══════════════ */

var SLA_JOB_BATCH = 300;                 // maks case per eksekusi (batas 6 menit GAS)
var SLA_NEAR_CACHE_TTL = 21600;          // 6 jam, penanda anti-spam NEAR_DUE

/**
 * Trigger time-driven tiap 30 menit.
 *
 * PENTING: job ini TIDAK PERNAH mengubah status case (04-state-machine.md §5).
 * SLA habis hanya menulis event + antre notifikasi. Keputusan tetap manusia.
 *
 * Kalau nama handler trigger yang dipasang setupAll() berbeda, samakan ke
 * fungsi ini — atau tambahkan alias di 90_Setup.gs.
 */
function slaJob() {
  var started = Date.now();
  var now = TC.nowIso();
  var cache = CacheService.getScriptCache();

  var rows = TC.readAll(TC.S.CASES) || [];
  var live = rows.filter(function (r) {
    return r.Status !== 'Closed' && r.Status !== 'Created' && r.Status !== 'Escalated to MBAG';
  });
  // 'Created' dilewati: self-diagnosis itu advisory, bukan pelanggaran.
  // 'Escalated to MBAG' dilewati: di luar kendali IIDI (docs §5).

  if (!live.length) return { scanned: 0, nearDue: 0, overdue: 0 };

  var cursor = 0;
  try { cursor = Number(TC.cfgNum('SLA_JOB_CURSOR', 0)) || 0; } catch (e) { cursor = 0; }
  if (cursor >= live.length) cursor = 0;

  var slice = live.slice(cursor, cursor + SLA_JOB_BATCH);
  var nextCursor = (cursor + SLA_JOB_BATCH >= live.length) ? 0 : cursor + SLA_JOB_BATCH;

  // Penanda OVERDUE permanen dibaca sekali dari CASE_EVENTS, bukan per case.
  var breached = {};
  try {
    TC.filter(TC.S.EVENTS, function (e) { return e.Event_Type === 'SLA_Breached'; })
      .forEach(function (e) { breached[e.Case_No + '|' + e.To_Value] = true; });
  } catch (e) { console.error('slaJob: baca CASE_EVENTS gagal: ' + e); }

  var nNear = 0, nOver = 0;

  for (var i = 0; i < slice.length; i++) {
    var r = slice[i];
    var sla = Sla_.statusOf(r, now);
    if (sla.status === 'NONE' || !sla.field) continue;

    if (sla.status === 'OVERDUE') {
      var kOver = r.Case_No + '|' + sla.field;
      if (breached[kOver]) continue;
      slaWriteEvent_(r.Case_No, 'SLA_Breached', sla.field,
        'Melewati batas ' + sla.field + ' — ' + Sla_.label(sla),
        { deadline: sla.deadline, overdueWorkingMinutes: sla.overdueWorkingMinutes });
      slaNotify_('SLA_OVERDUE', r, sla);
      breached[kOver] = true;
      nOver++;

    } else if (sla.status === 'NEAR_DUE') {
      // Anti-spam NEAR_DUE pakai cache, BUKAN CASE_EVENTS: enum Event_Type di
      // 01-schema.md §9 tidak punya nilai untuk "hampir jatuh tempo", dan
      // menambah enum baru berarti mengubah skema — itu butuh revisi docs dulu.
      var kNear = 'slanear_' + r.Case_No + '_' + sla.field;
      if (cache.get(kNear)) continue;
      cache.put(kNear, '1', SLA_NEAR_CACHE_TTL);
      slaNotify_('SLA_NEAR_DUE', r, sla);
      nNear++;
    }

    if (Date.now() - started > 250000) {          // ~4 menit, sisakan margin
      nextCursor = cursor + i + 1;
      break;
    }
  }

  try {
    var cRow = TC.find(TC.S.CONFIG, 'Key', 'SLA_JOB_CURSOR');
    if (cRow) TC.update(TC.S.CONFIG, cRow._row, { Value: String(nextCursor), Updated_At: now });
    TC.invalidate(TC.S.CONFIG);
    TC.flush();
  } catch (e) { console.error('slaJob: update cursor gagal: ' + e); }

  var out = { scanned: slice.length, nearDue: nNear, overdue: nOver, nextCursor: nextCursor };
  console.log('slaJob ' + JSON.stringify(out));
  return out;
}

/** Penulis CASE_EVENTS untuk job (aktor = SYSTEM, bukan user). */
function slaWriteEvent_(caseNo, type, toValue, note, detail) {
  try {
    TC.append(TC.S.EVENTS, {
      Event_ID: 'EV-' + Utilities.getUuid().replace(/-/g, '').slice(0, 12),
      Case_No: caseNo,
      Event_Type: type,
      From_Value: '',
      To_Value: toValue || '',
      Actor_User_ID: 'SYSTEM',
      Actor_Role: 'SYSTEM',
      Note: note || '',
      Detail_JSON: detail ? JSON.stringify(detail) : '',
      Created_At: TC.nowIso()
    });
  } catch (e) { console.error('slaWriteEvent_: ' + e); }
}

/** Hook ke Fase 6. No-op sampai 50_Notify.gs ada — job tetap jalan. */
function slaNotify_(eventType, caseRow, sla) {
  if (typeof Notify_ === 'undefined' || typeof Notify_.enqueue !== 'function') return;
  try {
    Notify_.enqueue(eventType, caseRow.Case_No, {
      ownerUserId: caseRow.Current_Owner_User_ID,
      ownerRole: caseRow.Current_Owner_Role,
      field: sla.field,
      deadline: sla.deadline,
      label: sla.label
    });
  } catch (e) { console.error('slaNotify_: ' + e); }
}

/**
 * Alias untuk trigger yang dipasang 90_Setup.gs (konvensi underscore).
 * Jangan hapus — trigger 30 menit menunjuk ke nama ini.
 */
function slaJob_() { return slaJob(); }