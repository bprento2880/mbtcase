/**
 * 24_RequestService.gs — FASE 5
 * Additional data request: IIDI minta data ke dealer, dealer memenuhinya.
 *
 * Acuan: docs/01-schema.md §11, docs/02-api-contract.md §"Additional data request",
 *        docs/04-state-machine.md §2, docs/03-rbac.md §2.
 *
 * ATURAN PENTING — jangan membungkus Case_.transitionInternal dengan TC.withLock.
 * Fungsi itu sudah mengambil script lock sendiri; lock bersarang berisiko gagal.
 * Karena itu urutannya: validasi murah dulu → transisi (yang menangani lock,
 * deadline, owner, CASE_EVENTS, flush) → baru tulis DATA_REQUESTS.
 */
var Request_ = (function () {

  // 04-state-machine.md §2: hanya dari tiga status ini yang legal ke Waiting Dealer Reply.
  const ALLOWED_FROM = ['Open', 'In Progress', 'Escalated to MBAG'];
  const EVIDENCE_TYPES = ['Quick_Test', 'Actual_Value', 'Guided_Test', 'Photo', 'Video',
    'Wiring_Check', 'Measurement', 'Programming_Log', 'SCN_Coding', 'Repair_Doc', 'Other'];
  const MAX_ITEMS = 20;
  const MAX_LABEL = 200;

  function s(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }
  function has(list, v) { return list.indexOf(v) !== -1; }

  function notify(eventType, caseNo, detail) {
    const g = (typeof globalThis !== 'undefined') ? globalThis : null;
    const ns = g ? g['Notify_'] : null;
    if (ns && typeof ns.enqueue === 'function') {
      try { ns.enqueue(eventType, caseNo, detail); } catch (e) { console.error('Notify_: ' + e); }
    }
  }

  function caseRow(caseNo) {
    const r = TC.find(TC.S.CASES, 'Case_No', caseNo);
    if (!r) throw new AppError(ERROR_CODES.NOT_FOUND, 'Case ' + caseNo + ' tidak ditemukan.');
    return r;
  }

  /**
   * Normalisasi items[] menjadi [{ label, evidenceType }].
   * String polos tetap diterima dan dibungkus jadi { label }. Bentuk objek
   * dipertahankan supaya Fase 6 punya label untuk email dan Fase 7 punya
   * evidenceType untuk mencocokkan dengan lampiran yang sudah ada.
   */
  function normalizeItems(raw) {
    const arr = Array.isArray(raw) ? raw : [];
    if (!arr.length) {
      throw new AppError(ERROR_CODES.VALIDATION, 'Minimal satu item data harus diminta.',
        { items: 'Wajib diisi.' });
    }
    if (arr.length > MAX_ITEMS) {
      throw new AppError(ERROR_CODES.VALIDATION, 'Maksimal ' + MAX_ITEMS + ' item per permintaan.',
        { items: 'Terlalu banyak item.' });
    }
    return arr.map(function (it, i) {
      const o = (typeof it === 'string') ? { label: it } : (it || {});
      const label = s(o.label);
      if (!label) {
        throw new AppError(ERROR_CODES.VALIDATION, 'Item ke-' + (i + 1) + ' belum punya keterangan.',
          { items: 'Setiap item wajib punya label.' });
      }
      const et = s(o.evidenceType);
      if (et && !has(EVIDENCE_TYPES, et)) {
        throw new AppError(ERROR_CODES.VALIDATION, 'Jenis bukti tidak dikenal: ' + et,
          { items: 'evidenceType tidak valid.' });
      }
      return { label: label.slice(0, MAX_LABEL), evidenceType: et };
    });
  }

  function parseItems(json) {
    try { const a = JSON.parse(json || '[]'); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }

  function toPublic(r) {
    const o = {};
    for (const k in r) if (k !== '_row' && k !== 'Items_JSON') o[k] = r[k];
    o.Items = parseItems(r.Items_JSON);
    return o;
  }

  function openOf(caseNo) {
    return TC.filter(TC.S.REQUESTS, function (r) {
      return r.Case_No === caseNo && r.Status === 'OPEN';
    });
  }

  // ── request.create ────────────────────────────────────────────────────────
  function create(ctx, p) {
    requirePerm_(ctx, 'request.create');

    const caseNo = s(p.caseNo);
    if (!caseNo) throw new AppError(ERROR_CODES.VALIDATION, 'caseNo wajib diisi.', { caseNo: 'Wajib diisi.' });
    const items = normalizeItems(p.items);
    const note = s(p.note);

    const r = caseRow(caseNo);
    assertCanAccessCase_(ctx, r);
    if (!has(ALLOWED_FROM, r.Status)) {
      throw new AppError(ERROR_CODES.CONFLICT,
        'Permintaan data tidak bisa dibuat saat status case "' + r.Status + '".');
    }
    if (openOf(caseNo).length) {
      throw new AppError(ERROR_CODES.CONFLICT,
        'Masih ada permintaan data yang belum dipenuhi untuk case ini.');
    }

    // Transisi lebih dulu: di sinilah lock, Dealer_Response_Deadline, pemindahan
    // owner ke dealer, CASE_EVENTS Status_Changed, dan baris System ditulis.
    const res = Case_.transitionInternal(ctx, {
      caseNo: caseNo,
      toStatus: 'Waiting Dealer Reply',
      waitingReason: 'Additional_Data',
      note: note
    });

    const ts = TC.nowIso();
    const id = 'DR-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase();
    const rec = {
      Request_ID: id,
      Case_No: caseNo,
      Requested_By: ctx.user.userId,
      Requested_At: ts,
      Items_JSON: JSON.stringify(items),
      Due_At: s(res['case'].Dealer_Response_Deadline),
      Status: 'OPEN',
      Fulfilled_At: '',
      Fulfilled_By: '',
      Response_Note: ''
    };
    TC.withLock(function () { TC.append(TC.S.REQUESTS, rec); TC.flush(); });

    Case_.event(ctx, caseNo, 'Data_Requested', '', id, note,
                { requestId: id, items: items, dueAt: rec.Due_At });

    // Isi permintaan ikut masuk ke thread supaya timeline case terbaca utuh.
    const lines = items.map(function (it, i) {
      return (i + 1) + '. ' + it.label + (it.evidenceType ? ' [' + it.evidenceType + ']' : '');
    }).join('\n');
    Thread_.serviceNote(ctx, caseNo, 'Request_Data',
      'Permintaan data tambahan:\n' + lines + (note ? '\n\nCatatan: ' + note : ''), 'All');

    notify('DATA_REQUESTED', caseNo, {
      requestId: id, items: items, dueAt: rec.Due_At, requestedBy: ctx.user.userId
    });

    return { request: toPublic(rec), 'case': res['case'] };
  }

  // ── request.fulfill ───────────────────────────────────────────────────────
  function fulfill(ctx, p) {
    requirePerm_(ctx, 'request.fulfill');

    const requestId = s(p.requestId);
    if (!requestId) {
      throw new AppError(ERROR_CODES.VALIDATION, 'requestId wajib diisi.', { requestId: 'Wajib diisi.' });
    }
    const req = TC.find(TC.S.REQUESTS, 'Request_ID', requestId);
    if (!req) throw new AppError(ERROR_CODES.NOT_FOUND, 'Permintaan data tidak ditemukan.');

    const r = caseRow(req.Case_No);
    assertCanAccessCase_(ctx, r);

    // Keputusan C13(b): hanya pembuat case + Dealer_SM yang boleh memenuhi.
    if (ctx.user.role !== 'Dealer_SM' && r.Created_By_User_ID !== ctx.user.userId) {
      throw new AppError(ERROR_CODES.FORBIDDEN,
        'Hanya pembuat case atau Service Manager dealer yang dapat memenuhi permintaan ini.');
    }
    if (req.Status !== 'OPEN') {
      throw new AppError(ERROR_CODES.CONFLICT, 'Permintaan data ini sudah ditutup.');
    }
    if (r.Status !== 'Waiting Dealer Reply') {
      throw new AppError(ERROR_CODES.CONFLICT,
        'Status case sudah berubah menjadi "' + r.Status + '". Muat ulang halaman.');
    }

    // Lampiran wajib milik case yang sama — tanpa cek ini, ID lampiran dealer
    // lain bisa ditempelkan ke case ini lewat payload.
    const ids = Array.isArray(p.attachmentIds) ? p.attachmentIds.map(s).filter(String) : [];
    let atts = [];
    if (ids.length) {
      atts = TC.filter(TC.S.ATTACH, function (a) {
        return ids.indexOf(a.Attachment_ID) !== -1 && a.Deleted !== 'TRUE';
      });
      const bad = atts.filter(function (a) { return a.Case_No !== req.Case_No; });
      if (atts.length !== ids.length || bad.length) {
        throw new AppError(ERROR_CODES.VALIDATION, 'Ada lampiran yang tidak valid untuk case ini.',
          { attachmentIds: 'Lampiran tidak ditemukan atau bukan milik case ini.' });
      }
    }

    const note = s(p.note);
    const caseNo = req.Case_No;

    // Transisi dulu (lihat catatan lock di header file).
    const res = Case_.transitionInternal(ctx, {
      caseNo: caseNo,
      toStatus: 'Waiting IIDI',
      waitingReason: 'IIDI_Technical_Review',
      note: note
    });

    const ts = TC.nowIso();
    TC.withLock(function () {
      TC.update(TC.S.REQUESTS, req._row, {
        Status: 'FULFILLED', Fulfilled_At: ts,
        Fulfilled_By: ctx.user.userId, Response_Note: note
      });
      TC.flush();
    });

    // Jawaban dealer masuk thread, lalu lampiran yang belum terikat baris manapun
    // ditautkan ke baris jawaban itu. Tidak ada kolom Request_ID di
    // CASE_ATTACHMENTS (01-schema.md §7), jadi Thread_ID yang jadi penghubung.
    const items = parseItems(req.Items_JSON);
    const answer = Thread_.serviceNote(ctx, caseNo, 'Answer',
      (note || 'Data tambahan telah dilengkapi.') +
      (atts.length ? '\n\nLampiran: ' + atts.map(function (a) { return a.File_Name; }).join(', ') : ''),
      'All');

    atts.forEach(function (a) {
      if (!s(a.Thread_ID)) TC.update(TC.S.ATTACH, a._row, { Thread_ID: answer.Thread_ID });
    });

    Case_.event(ctx, caseNo, 'Data_Fulfilled', requestId, 'FULFILLED', note,
                { requestId: requestId, attachmentIds: ids, threadId: answer.Thread_ID });

    notify('DATA_FULFILLED', caseNo, {
      requestId: requestId, fulfilledBy: ctx.user.userId,
      attachmentCount: ids.length, items: items
    });

    const fresh = TC.find(TC.S.REQUESTS, 'Request_ID', requestId);
    return { request: toPublic(fresh || req), 'case': res['case'] };
  }

  return {
    create: create,
    fulfill: fulfill,

    /** Dipakai Case_.get — sudah ter-scope oleh guard di case.get. */
    forCase: function (caseNo) {
      return TC.filter(TC.S.REQUESTS, function (r) { return r.Case_No === caseNo; })
        .sort(function (a, b) { return a.Requested_At < b.Requested_At ? 1 : -1; })
        .map(toPublic);
    }
  };
})();