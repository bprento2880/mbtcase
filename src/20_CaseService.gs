/**
 * 20_CaseService.gs — FASE 2
 * Case CRUD, penomoran Case_No, state machine, CASE_EVENTS.
 *
 * Acuan: docs/04-state-machine.md, docs/01-schema.md §4 §9 §20,
 *        docs/02-api-contract.md §"Case", docs/03-rbac.md §2-§3.
 *
 * ATURAN: akses sheet HANYA lewat TC (10_SheetDB.gs). Tidak ada SpreadsheetApp
 * di file ini. Semua util waktu/konfig pakai TC.*, bukan definisi baru —
 * nowIso_() sudah ada di 00_Config.gs, jangan dideklarasikan ulang.
 */
var Case_ = (function () {

  // ── 1. Konstanta status (04-state-machine.md §1) ──────────────────────────
  const ST = {
    CREATED: 'Created', OPEN: 'Open', IN_PROGRESS: 'In Progress',
    WAIT_DEALER: 'Waiting Dealer Reply', WAIT_IIDI: 'Waiting IIDI',
    ESCALATED: 'Escalated to MBAG', REQ_CLOSURE: 'Request Closure', CLOSED: 'Closed'
  };

  const DEALER_ROLES = ['CDT', 'Senior_Tech', 'Dealer_SM'];
  const IIDI_TECHS   = ['IIDI_Tech', 'IIDI_Tech_Mgr'];

  // Transisi legal — 04-state-machine.md §2. Di luar tabel ini → CONFLICT.
  const TRANSITIONS = {
    'Created':              { 'Open': DEALER_ROLES, 'Closed': DEALER_ROLES },
    'Open':                 { 'In Progress': IIDI_TECHS, 'Waiting Dealer Reply': IIDI_TECHS },
    'In Progress':          { 'Waiting Dealer Reply': IIDI_TECHS,
                              'Escalated to MBAG': ['IIDI_Tech_Mgr'],
                              'Request Closure': IIDI_TECHS },
    'Waiting Dealer Reply': { 'Waiting IIDI': DEALER_ROLES },
    'Waiting IIDI':         { 'In Progress': IIDI_TECHS,
                              'Escalated to MBAG': ['IIDI_Tech_Mgr'],
                              'Request Closure': IIDI_TECHS },
    'Escalated to MBAG':    { 'In Progress': IIDI_TECHS,
                              'Waiting Dealer Reply': IIDI_TECHS,
                              'Request Closure': IIDI_TECHS },
    'Request Closure':      { 'Closed': DEALER_ROLES.concat(['IIDI_Tech_Mgr']),
                              'In Progress': DEALER_ROLES },
    'Closed':               { 'In Progress': IIDI_TECHS.concat(['Dealer_SM']) }
  };

  const NEEDS_REASON = { 'Waiting Dealer Reply': 1, 'Waiting IIDI': 1, 'Escalated to MBAG': 1 };
  const WAIT_REASONS = ['Additional_Data', 'Dealer_Verification', 'IIDI_Technical_Review',
                        'MBAG_Feedback', 'Repair_Verification', 'Customer_Confirmation'];
  const CLOSURE_TYPES = ['Solved', 'Not_Reproducible', 'Duplicate', 'Cancelled_By_Dealer'];
  const SYMPTOMS = ['Engine','Transmission','Electrical','Software','Chassis','Body',
                    'HVAC','Infotainment','Other'];
  const WARRANTY = ['In_Warranty','Out_Warranty','Goodwill','Extended'];
  const PRIORITIES = ['Normal','Urgent','Critical'];
  const FREQUENCIES = ['Always','Intermittent','Once','Under_Condition',''];
  const VEHICLE_STATUS = ['Drivable','Not_Drivable','In_Workshop',''];
  const REOPEN_LIMIT_DAYS = 7;

  // ── 2. Util lokal ─────────────────────────────────────────────────────────
  function s(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }
  function n(v) { const x = Number(v); return isNaN(x) ? 0 : x; }
  function has(list, v) { return list.indexOf(v) !== -1; }
  function isIidi(role) { return String(role).indexOf('IIDI_') === 0; }
  function pad4(x) { return x < 10000 ? ('0000' + x).slice(-4) : String(x); }

  /**
   * Jembatan ke Fase 3. Selama 30_SlaEngine.gs belum ada, kolom deadline
   * ditulis kosong dan SLA_Status = 'NONE' (05-sla-engine.md §3: deadline
   * kosong -> status NONE, jangan tampilkan badge). Bukan bug.
   */
  function deadline(fromIso, workingDays) {
    if (typeof Sla_ === 'undefined' || typeof Sla_.deadline !== 'function') return '';
    return Sla_.deadline(fromIso, workingDays);
  }
  function slaOf(row) {
    if (typeof Sla_ === 'undefined' || typeof Sla_.statusOf !== 'function') return { status: 'NONE' };
    return Sla_.statusOf(row);
  }
  function activityOf(lastActivityIso) {
    if (typeof Sla_ === 'undefined' || typeof Sla_.activityStatus !== 'function') return 'Active';
    return Sla_.activityStatus(lastActivityIso);
  }
  /**
   * Hook Fase 5/6. `this` TIDAK dipakai lagi: saat dipanggil lewat
   * Case_.transition(), `this` = objek Case_, sehingga Case_['Thread_'] selalu
   * undefined dan hook diam-diam jadi no-op. Resolusi lewat globalThis —
   * 22/24 karena itu WAJIB deklarasi `var Thread_` / `var Request_`.
   */
  function hook(nsName, fnName, args) {
    const g = (typeof globalThis !== 'undefined') ? globalThis : null;
    const ns = g ? g[nsName] : null;
    if (ns && typeof ns[fnName] === 'function') {
      try { ns[fnName].apply(ns, args); } catch (e) { console.error(nsName + '.' + fnName + ': ' + e); }
    }
  }

  // ── 3. Akses baris ────────────────────────────────────────────────────────
  function row(caseNo) {
    const r = TC.find(TC.S.CASES, 'Case_No', caseNo);
    if (!r) throw new AppError(ERROR_CODES.NOT_FOUND, 'Case ' + caseNo + ' tidak ditemukan.');
    return r;
  }
  function diagOf(caseNo) { return TC.find(TC.S.DIAG, 'Case_No', caseNo) || {}; }
  function attachOf(caseNo) {
    return TC.filter(TC.S.ATTACH, function (r) {
      return r.Case_No === caseNo && r.Deleted !== 'TRUE';
    });
  }
  function roleOf(userId) {
    const u = userId ? TC.find(TC.S.USERS, 'User_ID', userId) : null;
    return u ? u.Role : '';
  }

  /** Satu-satunya penulis CASE_EVENTS (01-schema.md §9). */
  function event(ctx, caseNo, type, from, to, note, detail) {
    TC.append(TC.S.EVENTS, {
      Event_ID: 'EV-' + Utilities.getUuid().replace(/-/g, '').slice(0, 12),
      Case_No: caseNo,
      Event_Type: type,
      From_Value: s(from),
      To_Value: s(to),
      Actor_User_ID: (ctx && ctx.user) ? ctx.user.userId : 'SYSTEM',
      Actor_Role: (ctx && ctx.user) ? ctx.user.role : 'SYSTEM',
      Note: s(note),
      Detail_JSON: detail ? JSON.stringify(detail) : '',
      Created_At: TC.nowIso()
    });
  }

  /**
   * Penomoran Case_No. WAJIB dipanggil dari dalam TC.withLock.
   * CONFIG di-cache 6 jam (10_SheetDB.gs CACHEABLE), jadi cache dibuang DULU
   * sebelum baca — kalau tidak, dua eksekusi berurutan membaca counter sama.
   */
  function nextCaseNo() {
    TC.invalidate(TC.S.CONFIG);
    const cfgRow = TC.find(TC.S.CONFIG, 'Key', 'CASE_COUNTER');
    if (!cfgRow) throw new AppError(ERROR_CODES.INTERNAL,
      'CONFIG.CASE_COUNTER tidak ada. Jalankan setupAll().');
    const next = n(cfgRow.Value) + 1;
    TC.update(TC.S.CONFIG, cfgRow._row, { Value: String(next), Updated_At: TC.nowIso() });
    return 'CN-' + pad4(next);
  }

  // ── 4. Quality Score (01-schema.md §20) ───────────────────────────────────
  function qualityScore(c, d, atts) {
    d = d || {}; atts = atts || [];
    let sc = 0;
    if (s(c.VIN) && s(c.Model) && s(c.Mileage) && s(c.Complaint_Desc) &&
        s(c.Symptom_Category) && s(c.Warranty_Status)) sc += 20;
    if (s(d.Initial_Diag).length >= 50) sc += 15;
    if (s(d.Dealer_Analysis).length >= 100) sc += 15;
    if (s(d.Suspected_Root_Cause)) sc += 10;
    const dtc = s(d.DTC_Codes).toLowerCase();
    if (dtc && dtc !== '-') sc += 10;
    let qt = false, media = false;
    atts.forEach(function (a) {
      if (a.Evidence_Type === 'Quick_Test') qt = true;
      if (a.Evidence_Type === 'Photo' || a.Evidence_Type === 'Video') media = true;
    });
    if (qt) sc += 15;
    if (media) sc += 5;
    // 10 poin ">=60% recommended evidence" butuh EVIDENCE_RULES -> Fase 7.
    // Sengaja tidak dihitung sekarang; skor maksimum realistis Fase 2 = 90.
    return Math.min(100, sc);
  }
  function scoreCategory(x) {
    return x >= 85 ? 'Excellent' : x >= 70 ? 'Good' : x >= 55 ? 'Fair' : 'Poor';
  }

  // ── 5. Validasi ───────────────────────────────────────────────────────────
  /** @param {Object} rec flat, memakai nama kolom CASES_MASTER. */
  function validate(rec, isCreate) {
    const f = {};
    function req(k) { return isCreate || rec[k] !== undefined; }

    if (req('VIN') && s(rec.VIN).length !== 17) f.VIN = 'VIN wajib tepat 17 karakter.';
    if (req('Model') && !s(rec.Model)) f.Model = 'Model wajib diisi.';
    if (req('Mileage') && !(n(rec.Mileage) > 0)) f.Mileage = 'Kilometer wajib diisi berupa angka.';
    if (req('Complaint_Desc') && !s(rec.Complaint_Desc)) f.Complaint_Desc = 'Deskripsi keluhan wajib diisi.';
    if (req('Symptom_Category') && !has(SYMPTOMS, s(rec.Symptom_Category)))
      f.Symptom_Category = 'Kategori gejala tidak valid.';
    if (req('Warranty_Status') && !has(WARRANTY, s(rec.Warranty_Status)))
      f.Warranty_Status = 'Status garansi tidak valid.';
    if (rec.Frequency !== undefined && !has(FREQUENCIES, s(rec.Frequency)))
      f.Frequency = 'Frekuensi gejala tidak valid.';
    if (rec.Vehicle_Status !== undefined && !has(VEHICLE_STATUS, s(rec.Vehicle_Status)))
      f.Vehicle_Status = 'Kondisi kendaraan tidak valid.';

    if (Object.keys(f).length) {
      throw new AppError(ERROR_CODES.VALIDATION, 'Ada isian yang belum benar.', f);
    }
  }

  // ── 6. Bentuk keluaran ────────────────────────────────────────────────────
  function toPublic(r) {
    const out = {};
    for (const k in r) if (k !== '_row') out[k] = r[k];
    // readAll() mengembalikan semua sebagai string — kembalikan tipe numeriknya.
    out.Mileage = n(r.Mileage);
    out.Quality_Score = n(r.Quality_Score);
    out.Prod_Year = s(r.Prod_Year) ? n(r.Prod_Year) : '';
    // Dihitung saat read, tidak pernah disimpan (01-schema.md §4, 04-state-machine.md §6).
    out.Activity_Status = (r.Status === ST.CLOSED) ? 'Active' : activityOf(r.Last_Activity_At);
    out.SLA_Status = slaOf(r).status;
    return out;
  }

  function touch(ctx) {
    const ts = TC.nowIso();
    return { Updated_At: ts, Last_Activity_At: ts, Last_Activity_By: ctx.user.userId };
  }

  // ── 7. case.create ────────────────────────────────────────────────────────
  function create(ctx, p) {
    requirePerm_(ctx, 'case.create');
    const v = p.vehicle || {}, cm = p.complaint || {}, dg = p.diagnostics || {};
    const ts = TC.nowIso();

    const rec = {
      VIN: s(v.VIN).toUpperCase(), Model: s(v.Model),
      Engine_No: s(v.Engine_No), Trans_No: s(v.Trans_No),
      Mileage: n(v.Mileage), Prod_Year: s(v.Prod_Year), Reg_No: s(v.Reg_No),
      Warranty_Status: s(v.Warranty_Status),
      Cust_Name: s(cm.Cust_Name), Complaint_No: s(cm.Complaint_No),
      Complaint_Desc: s(cm.Complaint_Desc), Symptom_Category: s(cm.Symptom_Category),
      Date_Occurred: s(cm.Date_Occurred), Frequency: s(cm.Frequency),
      Driving_Condition: s(cm.Driving_Condition), Vehicle_Status: s(cm.Vehicle_Status),
      Outside_Temp: s(cm.Outside_Temp), Fuel_Level: s(cm.Fuel_Level),
      Driving_Style: s(cm.Driving_Style), Road_Condition: s(cm.Road_Condition)
    };
    validate(rec, true);

    const diag = {
      Initial_Diag: s(dg.Initial_Diag), Dealer_Analysis: s(dg.Dealer_Analysis),
      Suspected_Root_Cause: s(dg.Suspected_Root_Cause), Workshop_Findings: s(dg.Workshop_Findings),
      DTC_Codes: s(dg.DTC_Codes).toUpperCase(), Control_Unit: s(dg.Control_Unit),
      Diagnostic_Path: s(dg.Diagnostic_Path), Xentry_Version: s(dg.Xentry_Version),
      SW_Version_Before: s(dg.SW_Version_Before), SW_Version_After: s(dg.SW_Version_After),
      Parts_Replaced: s(dg.Parts_Replaced), Previous_Repair_History: s(dg.Previous_Repair_History)
    };

    // Skor dihitung SEBELUM append supaya cukup satu write, bukan append lalu update.
    const score = qualityScore(rec, diag, []);
    const priority = has(PRIORITIES, s(p.priority)) ? s(p.priority) : 'Normal';

    const caseNo = TC.withLock(function () {
      const no = nextCaseNo();

      rec.Case_No = no;
      // Dealer_ID & Created_By SELALU dari ctx, payload dibuang diam-diam
      // (CLAUDE.md §5, 02-api-contract.md §"Case").
      rec.Dealer_ID = ctx.user.dealerId;
      rec.Created_By_User_ID = ctx.user.userId;
      rec.Priority = priority;
      rec.Status = ST.CREATED;
      rec.Current_Owner_User_ID = ctx.user.userId;
      rec.Current_Owner_Role = ctx.user.role;
      rec.Current_Waiting_Reason = '';
      rec.Quality_Score = score;
      rec.Score_Category = scoreCategory(score);
      rec.Activity_Status = 'Active';
      rec.Dealer_Self_Diagnosis_Deadline = deadline(ts, TC.cfgNum('SLA_DEALER_SELF_DIAG_DAYS', 3));
      rec.IIDI_Response_Deadline = '';
      rec.Dealer_Response_Deadline = '';
      rec.IIDI_Decision_Deadline = '';
      rec.Closure_Deadline = '';
      rec.Created_At = ts; rec.Updated_At = ts;
      rec.Last_Activity_At = ts; rec.Last_Activity_By = ctx.user.userId;
      rec.Submitted_To_IIDI_At = ''; rec.First_IIDI_Response_At = ''; rec.Escalated_At = '';
      rec.Closed_At = ''; rec.Closed_By = ''; rec.Closure_Type = ''; rec.MBAG_Ref_No = '';
      TC.append(TC.S.CASES, rec);

      diag.Case_No = no;
      diag.Updated_At = ts;
      diag.Updated_By = ctx.user.userId;
      TC.append(TC.S.DIAG, diag);

      TC.flush();   // commit sebelum lock dilepas — kalau tidak, counter bisa dobel
      return no;
    });

    event(ctx, caseNo, 'Created', '', ST.CREATED, 'Case dibuat', { priority: priority });
    return { caseNo: caseNo, qualityScore: score, advisory: null };   // advisory -> Fase 7
  }

  // ── 8. case.get ───────────────────────────────────────────────────────────
  function get(ctx, p) {
    const caseNo = s(p.caseNo);
    if (!caseNo) throw new AppError(ERROR_CODES.VALIDATION, 'caseNo wajib diisi.', { caseNo: 'Wajib diisi.' });
    const r = row(caseNo);
    assertCanAccessCase_(ctx, r);
    // Draft belum dikirim = belum terlihat oleh IIDI (04-state-machine.md §1).
    if (r.Status === ST.CREATED && isIidi(ctx.user.role)) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Case ini masih draft dan belum dikirim ke IIDI.');
    }
    return {
      'case': toPublic(r),
      diagnostics: diagOf(caseNo),
      sla: slaOf(r),
      attachments: attachOf(caseNo),
      // Baris IIDI_Only disaring di dalam Thread_.forCase untuk role dealer.
      thread: (typeof Thread_ !== 'undefined') ? Thread_.forCase(ctx, caseNo) : [],
      dataRequests: (typeof Request_ !== 'undefined') ? Request_.forCase(caseNo) : [],
      escalation: null,    // Fase 9
      advisory: null,      // Fase 7
      similarCases: []     // Fase 10
    };
  }

  // ── 9. case.list ──────────────────────────────────────────────────────────
  const NUMERIC_SORT = { Mileage: 1, Quality_Score: 1, Prod_Year: 1 };
  const SORTABLE = ['Case_No','Created_At','Updated_At','Last_Activity_At','Priority',
                    'Status','Model','Quality_Score','Dealer_ID'];

  function list(ctx, p) {
    const u = ctx.user;
    const f = p.filters || {};
    let rows = TC.readAll(TC.S.CASES);

    // Scope role dipaksa backend, di atas filter apapun (03-rbac.md §3).
    if (!isIidi(u.role)) {
      rows = rows.filter(function (r) { return r.Dealer_ID === u.dealerId; });
    } else {
      rows = rows.filter(function (r) { return r.Status !== ST.CREATED; });
      if (u.role === 'IIDI_Area_Mgr') {
        const areas = [].concat(u.areas || []);   // ARRAY, bukan string
        const allow = {};
        TC.readAll(TC.S.DEALERS).forEach(function (d) {
          if (areas.indexOf(d.Area) !== -1) allow[d.Dealer_ID] = true;
        });
        rows = rows.filter(function (r) { return allow[r.Dealer_ID] === true; });
      }
    }

    // Peta Dealer_ID -> Area, hanya dibangun kalau filter area dipakai.
    let areaOf = null;
    if (f.area && f.area.length) {
      areaOf = {};
      TC.readAll(TC.S.DEALERS).forEach(function (d) { areaOf[d.Dealer_ID] = d.Area; });
    }

    const q = s(f.q).toLowerCase();
    rows = rows.filter(function (r) {
      if (f.status && f.status.length && f.status.indexOf(r.Status) === -1) return false;
      if (f.priority && f.priority.length && f.priority.indexOf(r.Priority) === -1) return false;
      if (f.dealerId && f.dealerId.length && f.dealerId.indexOf(r.Dealer_ID) === -1) return false;
      if (areaOf && f.area.indexOf(areaOf[r.Dealer_ID]) === -1) return false;
      if (f.model && r.Model !== f.model) return false;
      if (f.symptomCategory && r.Symptom_Category !== f.symptomCategory) return false;
      if (f.assignedToMe && r.Current_Owner_User_ID !== u.userId) return false;
      if (f.dateFrom && r.Created_At < f.dateFrom) return false;
      if (f.dateTo && r.Created_At > f.dateTo + 'T23:59:59+07:00') return false;
      if (f.activityStatus && f.activityStatus.length &&
          f.activityStatus.indexOf(activityOf(r.Last_Activity_At)) === -1) return false;
      if (f.slaStatus && f.slaStatus.length &&
          f.slaStatus.indexOf(slaOf(r).status) === -1) return false;
      if (q) {
        const hay = (r.Case_No + ' ' + r.VIN + ' ' + r.Model + ' ' + r.Reg_No + ' ' +
                     r.Complaint_No + ' ' + r.Complaint_Desc).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
    const sort = p.sort || {};
    const key = has(SORTABLE, s(sort.key)) ? s(sort.key) : 'Last_Activity_At';
    const dir = (sort.dir === 'asc') ? 1 : -1;
    rows.sort(function (a, b) {
      if (NUMERIC_SORT[key]) return (n(a[key]) - n(b[key])) * dir;
      const x = s(a[key]), y = s(b[key]);
      return x === y ? 0 : (x > y ? dir : -dir);
    });

    const total = rows.length;
    const pageSize = Math.min(Math.max(n(p.pageSize) || 20, 1), 50);   // maks 50
    const page = Math.max(n(p.page) || 1, 1);
    const items = rows.slice((page - 1) * pageSize, page * pageSize).map(toPublic);
    return { items: items, total: total, page: page, pageSize: pageSize };
  }

  // ── 10. case.update (hanya sebelum submit) ────────────────────────────────
  const EDITABLE = ['VIN','Model','Engine_No','Trans_No','Mileage','Prod_Year','Reg_No',
    'Warranty_Status','Cust_Name','Complaint_No','Complaint_Desc','Symptom_Category',
    'Date_Occurred','Frequency','Driving_Condition','Vehicle_Status','Outside_Temp',
    'Fuel_Level','Driving_Style','Road_Condition'];

  function update(ctx, p) {
    requirePerm_(ctx, 'case.editDraft');
    const r = row(s(p.caseNo));
    assertCanAccessCase_(ctx, r);
    if (r.Status !== ST.CREATED) {
      throw new AppError(ERROR_CODES.CONFLICT, 'Case hanya bisa diubah sebelum dikirim ke IIDI.');
    }
    // 03-rbac.md §2: CDT hanya boleh edit case miliknya sendiri.
    if (ctx.user.role === 'CDT' && r.Created_By_User_ID !== ctx.user.userId) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Anda hanya bisa mengubah case yang Anda buat sendiri.');
    }

    const fields = p.fields || {}, patch = {}, diff = {};
    EDITABLE.forEach(function (k) {
      if (fields[k] === undefined) return;
      const val = (k === 'VIN') ? s(fields[k]).toUpperCase()
                : (k === 'Mileage') ? n(fields[k]) : s(fields[k]);
      if (String(r[k]) !== String(val)) { patch[k] = val; diff[k] = [r[k], val]; }
    });
    if (!Object.keys(patch).length) {
      return { 'case': toPublic(r), qualityScore: n(r.Quality_Score) };
    }
    validate(patch, false);

    const merged = {};
    for (const k in r) merged[k] = r[k];
    for (const k in patch) merged[k] = patch[k];
    const score = qualityScore(merged, diagOf(r.Case_No), attachOf(r.Case_No));

    patch.Quality_Score = score;
    patch.Score_Category = scoreCategory(score);
    const t = touch(ctx);
    for (const k in t) patch[k] = t[k];

    TC.withLock(function () { TC.update(TC.S.CASES, r._row, patch); });
    event(ctx, r.Case_No, 'Field_Updated', '', Object.keys(diff).join(','), '', diff);

    return { 'case': toPublic(row(r.Case_No)), qualityScore: score };
  }

  /**
   * Fase 4 — hitung ulang Quality_Score setelah lampiran ditambah/dihapus
   * (01-schema.md §20: 15 poin Quick_Test + 5 poin foto/video). Dipanggil
   * 23_AttachService.gs. Tidak menulis apa-apa kalau skor tidak berubah,
   * supaya tidak menghasilkan write dan Last_Activity_At palsu.
   */
  function recalcScore(ctx, caseNo) {
    const r = row(caseNo);
    const score = qualityScore(r, diagOf(caseNo), attachOf(caseNo));
    if (n(r.Quality_Score) === score) return score;

    const patch = touch(ctx);
    patch.Quality_Score = score;
    patch.Score_Category = scoreCategory(score);
    TC.withLock(function () { TC.update(TC.S.CASES, r._row, patch); });
    return score;
  }

  // ── 11. case.setPriority ──────────────────────────────────────────────────
  function setPriority(ctx, p) {
    // 02-api-contract.md: role IIDI_* ditolak FORBIDDEN. Mereka hanya boleh
    // "usul" lewat thread.post messageType Decision (Fase 5).
    if (isIidi(ctx.user.role)) {
      throw new AppError(ERROR_CODES.FORBIDDEN,
        'Role IIDI hanya dapat mengusulkan priority lewat diskusi, bukan mengubahnya.');
    }
    requirePerm_(ctx, 'case.setPriority');
    const r = row(s(p.caseNo));
    assertCanAccessCase_(ctx, r);
    const np = s(p.priority);
    if (!has(PRIORITIES, np)) {
      throw new AppError(ERROR_CODES.VALIDATION, 'Priority tidak valid.', { priority: 'Pilih Normal, Urgent, atau Critical.' });
    }
    if (r.Status === ST.CLOSED) throw new AppError(ERROR_CODES.CONFLICT, 'Case sudah ditutup.');
    if (np === r.Priority) return { 'case': toPublic(r) };

    const patch = touch(ctx);
    patch.Priority = np;
    TC.withLock(function () { TC.update(TC.S.CASES, r._row, patch); });
    event(ctx, r.Case_No, 'Priority_Changed', r.Priority, np, s(p.reason));
    return { 'case': toPublic(row(r.Case_No)) };
  }

  // ── 12. case.assign ───────────────────────────────────────────────────────
  function assign(ctx, p) {
    const target = s(p.toUserId) || ctx.user.userId;
    const self = (target === ctx.user.userId);
    requirePerm_(ctx, self ? 'case.claim' : 'case.assign');

    const r = row(s(p.caseNo));
    assertCanAccessCase_(ctx, r);
    if (r.Status === ST.CLOSED) throw new AppError(ERROR_CODES.CONFLICT, 'Case sudah ditutup.');

    const targetRole = self ? ctx.user.role : roleOf(target);
    if (!targetRole) throw new AppError(ERROR_CODES.NOT_FOUND, 'User tujuan tidak ditemukan.');
    if (!isIidi(targetRole)) {
      throw new AppError(ERROR_CODES.VALIDATION, 'Case hanya bisa ditugaskan ke user IIDI.');
    }

    const patch = touch(ctx);
    patch.Current_Owner_User_ID = target;
    patch.Current_Owner_Role = targetRole;
    TC.withLock(function () { TC.update(TC.S.CASES, r._row, patch); });
    event(ctx, r.Case_No, 'Assigned', r.Current_Owner_User_ID, target, s(p.note));
    return { 'case': toPublic(row(r.Case_No)) };
  }

  // ── 13. case.transition — inti state machine ──────────────────────────────
  /**
   * Pintu PUBLIK (route 'case.transition').
   * Fase 5: perpindahan ke 'Waiting Dealer Reply' HARUS lewat request.create.
   * Kalau dibiarkan terbuka, case bisa pindah ke status itu tanpa baris
   * DATA_REQUESTS — dealer melihat "bola di saya" tanpa tahu apa yang diminta.
   */
  function transition(ctx, p) {
    if (s(p.toStatus) === ST.WAIT_DEALER) {
      throw new AppError(ERROR_CODES.VALIDATION,
        'Untuk meminta data ke dealer, gunakan permintaan data tambahan (request.create).',
        { toStatus: 'Gunakan permintaan data tambahan.' });
    }
    return transitionCore(ctx, p);
  }

  /** Pintu INTERNAL. Hanya dipanggil service lain, TIDAK terdaftar di ROUTES. */
  function transitionCore(ctx, p) {
    const caseNo = s(p.caseNo), to = s(p.toStatus);
    if (!caseNo || !to) {
      throw new AppError(ERROR_CODES.VALIDATION, 'caseNo dan toStatus wajib diisi.',
        { caseNo: caseNo ? '' : 'Wajib diisi.', toStatus: to ? '' : 'Wajib diisi.' });
    }
    const res = TC.withLock(function () {
      const r = row(caseNo);                 // dibaca DI DALAM lock, bukan sebelumnya
      const from = r.Status;
      assertCanAccessCase_(ctx, r);

      const allowed = (TRANSITIONS[from] || {})[to];
      if (!allowed) {
        throw new AppError(ERROR_CODES.CONFLICT,
          'Case tidak bisa berpindah dari "' + from + '" ke "' + to + '".');
      }
      if (allowed.indexOf(ctx.user.role) === -1) {
        throw new AppError(ERROR_CODES.FORBIDDEN, 'Role Anda tidak berwenang melakukan perpindahan ini.');
      }
      const reason = s(p.waitingReason);
      if (NEEDS_REASON[to] && !reason) {
        throw new AppError(ERROR_CODES.VALIDATION, 'Alasan penundaan wajib diisi.',
          { waitingReason: 'Wajib diisi untuk status ini.' });
      }
      if (reason && !has(WAIT_REASONS, reason)) {
        throw new AppError(ERROR_CODES.VALIDATION, 'Alasan penundaan tidak dikenal.',
          { waitingReason: 'Nilai tidak dikenal.' });
      }

      const patch = touch(ctx);
      patch.Status = to;
      patch.Current_Waiting_Reason = NEEDS_REASON[to] ? reason : '';
      sideEffects(ctx, r, from, to, p, patch);

      TC.update(TC.S.CASES, r._row, patch);
      TC.flush();
      return { from: from, patch: patch };
    });

    // Penulisan event di LUAR lock: append CASE_EVENTS tidak dibaca oleh
    // pemeriksaan transisi manapun, jadi tidak perlu menahan lock lebih lama.
    event(ctx, caseNo, 'Status_Changed', res.from, to, s(p.note),
          { waitingReason: res.patch.Current_Waiting_Reason });
    if (to === ST.ESCALATED)   event(ctx, caseNo, 'Escalated', res.from, to, s(p.note));
    if (to === ST.REQ_CLOSURE) event(ctx, caseNo, 'Closure_Requested', res.from, to, s(p.note));
    if (to === ST.CLOSED)      event(ctx, caseNo, 'Closed', res.from, res.patch.Closure_Type, s(p.note));
    if (res.from === ST.CLOSED) event(ctx, caseNo, 'Reopened', res.from, to, s(p.note));

    hook.call(this, 'Thread_', 'system',
      [caseNo, 'Status diubah menjadi ' + to + ' oleh ' + (ctx.user.fullName || ctx.user.userId) + '.']);

    // FASE 6: argumen ke-3 WAJIB objek, bukan string. `from` dipakai Notify_
    // untuk membedakan "MBAG menjawab" (Escalated to MBAG -> In Progress) dari
    // "dealer sudah balas" (Waiting IIDI -> In Progress); `actorUserId` dipakai
    // untuk TIDAK mengirim email ke orang yang baru menekan tombolnya sendiri
    // (08-notifications.md §2). Contoh bentuk string di 04-state-machine.md §4
    // sudah dikoreksi — jangan dikembalikan.
    hook.call(this, 'Notify_', 'enqueue', ['STATUS_CHANGED', caseNo, {
      from: res.from,
      to: to,
      actorUserId: ctx.user.userId,
      actorRole: ctx.user.role,
      waitingReason: res.patch.Current_Waiting_Reason,
      note: s(p.note)
    }]);

    const fresh = row(caseNo);
    return { 'case': toPublic(fresh), sla: slaOf(fresh) };
  }

  /** Efek samping per transisi — 04-state-machine.md §2. Memodifikasi `patch`. */
  function sideEffects(ctx, r, from, to, p, patch) {
    const ts = TC.nowIso();

    if (from === ST.CREATED && to === ST.OPEN) {
      patch.Submitted_To_IIDI_At = ts;
      patch.IIDI_Response_Deadline = deadline(ts, TC.cfgNum('SLA_IIDI_RESPONSE_DAYS', 1));
      patch.Current_Owner_User_ID = '';          // masuk pool IIDI, belum diambil siapapun
      patch.Current_Owner_Role = 'IIDI_Tech';
      return;
    }
    if (from === ST.CREATED && to === ST.CLOSED) {
      patch.Closure_Type = 'Cancelled_By_Dealer';
      closeFields(ctx, patch, ts);
      return;
    }
    if (to === ST.IN_PROGRESS && from !== ST.CLOSED) {
      if (isIidi(ctx.user.role)) {
        patch.Current_Owner_User_ID = ctx.user.userId;
        patch.Current_Owner_Role = ctx.user.role;
        if (!s(r.First_IIDI_Response_At)) patch.First_IIDI_Response_At = ts;
      } else {
        // Dealer menolak Request Closure — bola balik ke pemilik IIDI terakhir.
        patch.Current_Owner_Role = 'IIDI_Tech';
      }
      patch.Closure_Deadline = '';
      return;
    }
    if (to === ST.WAIT_DEALER) {
      patch.Current_Owner_User_ID = r.Created_By_User_ID;
      patch.Current_Owner_Role = roleOf(r.Created_By_User_ID);
      patch.Dealer_Response_Deadline = deadline(ts, TC.cfgNum('SLA_DEALER_RESPONSE_DAYS', 2));
      if (!s(r.First_IIDI_Response_At)) patch.First_IIDI_Response_At = ts;
      // Baris DATA_REQUESTS dibuat oleh request.create (Fase 5), bukan di sini.
      return;
    }
    if (to === ST.WAIT_IIDI) {
      patch.Current_Owner_Role = 'IIDI_Tech';
      patch.IIDI_Decision_Deadline = deadline(ts, TC.cfgNum('SLA_IIDI_DECISION_DAYS', 2));
      return;
    }
    if (to === ST.ESCALATED) {
      patch.Escalated_At = ts;
      patch.Current_Owner_User_ID = ctx.user.userId;
      patch.Current_Owner_Role = 'IIDI_Tech_Mgr';
      // MBAG_ESCALATIONS + folder paket bukti -> escalation.create (Fase 9).
      return;
    }
    if (to === ST.REQ_CLOSURE) {
      patch.Closure_Deadline = deadline(ts, TC.cfgNum('SLA_CLOSURE_DAYS', 2));
      patch.Current_Owner_User_ID = r.Created_By_User_ID;
      patch.Current_Owner_Role = roleOf(r.Created_By_User_ID);
      return;
    }
    if (from === ST.REQ_CLOSURE && to === ST.CLOSED) {
      if (ctx.user.role === 'IIDI_Tech_Mgr') {
        // Override hanya sah SETELAH Closure_Deadline lewat (04-state-machine.md §2).
        // Semua ISO memakai offset +07:00 yang sama, jadi perbandingan string valid.
        const dl = s(r.Closure_Deadline);
        if (!dl || ts <= dl) {
          throw new AppError(ERROR_CODES.FORBIDDEN,
            'Override penutupan hanya boleh setelah batas konfirmasi dealer terlewati.');
        }
      }
      // CATATAN: `closureType` BELUM ada di 02-api-contract.md untuk case.transition.
      // Fase 9 (closure.confirm) yang akan memilikinya secara resmi. Sampai itu,
      // nilai diterima kalau dikirim, default 'Solved'.
      const ct = s(p.closureType) || 'Solved';
      if (!has(CLOSURE_TYPES, ct)) {
        throw new AppError(ERROR_CODES.VALIDATION, 'Tipe penutupan tidak valid.', { closureType: 'Nilai tidak dikenal.' });
      }
      patch.Closure_Type = ct;
      closeFields(ctx, patch, ts);
      return;
    }
    if (from === ST.CLOSED && to === ST.IN_PROGRESS) {
      if (ctx.user.role === 'Dealer_SM') {
        const closedAt = TC.parseIso(r.Closed_At);
        const days = closedAt ? (Date.now() - closedAt.getTime()) / 86400000 : 999;
        if (days > REOPEN_LIMIT_DAYS) {
          throw new AppError(ERROR_CODES.FORBIDDEN,
            'Reopen oleh dealer hanya boleh dalam ' + REOPEN_LIMIT_DAYS + ' hari setelah case ditutup.');
        }
      }
      patch.Closed_At = ''; patch.Closed_By = ''; patch.Closure_Type = '';
      patch.Closure_Deadline = '';
      patch.Current_Owner_User_ID = isIidi(ctx.user.role) ? ctx.user.userId : '';
      patch.Current_Owner_Role = 'IIDI_Tech';
    }
  }

  function closeFields(ctx, patch, ts) {
    patch.Closed_At = ts;
    patch.Closed_By = ctx.user.userId;
    patch.Current_Owner_User_ID = '';
    patch.Current_Owner_Role = '';
    patch.Current_Waiting_Reason = '';
  }

  return {
    create: create, get: get, list: list, update: update,
    transition: transition, assign: assign, setPriority: setPriority,
    // Fase 4 — 23_AttachService.gs butuh keduanya. event() tetap satu-satunya
    // penulis CASE_EVENTS (01-schema.md §9), jangan tulis langsung dari file lain.
    event: event, recalcScore: recalcScore,
    // Fase 5 — 24_RequestService.gs melewati blokir Waiting Dealer Reply di
    // transition(). JANGAN daftarkan ini ke ROUTES.
    transitionInternal: transitionCore,
    // dibuka untuk 99_Tests.gs dan fase berikutnya
    ST: ST, TRANSITIONS: TRANSITIONS, qualityScore: qualityScore
  };
})();