/**
 * 22_ThreadService.gs — FASE 5
 * Diskusi teknis per case. Ini pengganti WhatsApp-nya.
 *
 * Acuan: docs/01-schema.md §6, docs/02-api-contract.md §"Thread",
 *        docs/03-rbac.md §2 (thread.post, thread.iidiOnly).
 *
 * ATURAN:
 * - Akses sheet HANYA lewat TC (10_SheetDB.gs).
 * - `var Thread_` WAJIB pakai var, bukan const/let: hook() di 20_CaseService.gs
 *   mencarinya lewat globalThis, dan const/let tidak menempel ke sana di GAS V8.
 * - thread.post TIDAK menulis CASE_EVENTS. Enum Event_Type (01-schema.md §9)
 *   tidak punya nilai untuk balasan thread, dan posting bukan mutasi field case.
 *   Satu-satunya pengecualian: Priority_Suggested (02-api-contract.md, revisi Fase 5).
 */
var Thread_ = (function () {

  // 'System' sengaja TIDAK ada di sini — hanya Thread_.system() yang boleh menulisnya.
  const TYPES = ['Comment', 'Question', 'Answer', 'Request_Data', 'Decision'];
  const VISIBILITIES = ['All', 'IIDI_Only'];
  const PRIORITIES = ['Normal', 'Urgent', 'Critical'];
  const MAX_LEN = 5000;

  function s(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }
  function has(list, v) { return list.indexOf(v) !== -1; }
  function isIidi(role) { return String(role).indexOf('IIDI_') === 0; }
  function pad6(x) { return x < 1000000 ? ('000000' + x).slice(-6) : String(x); }

  /** Hook ke Fase 6. No-op sampai 50_Notify.gs ada. */
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

  // Nama penulis TIDAK disimpan di CASE_THREAD (01-schema.md §6 hanya punya
  // Author_User_ID). Diresolusi saat read, satu kali baca USERS per eksekusi.
  let _users = null;
  function nameOf(userId) {
    if (!userId || userId === 'SYSTEM') return 'Sistem';
    if (!_users) {
      _users = {};
      TC.readAll(TC.S.USERS).forEach(function (u) { _users[u.User_ID] = u.Full_Name; });
    }
    return _users[userId] || userId;
  }

  /**
   * Nomor Thread_ID berurutan (TH-000001, 01-schema.md §6).
   * WAJIB dipanggil dari dalam TC.withLock. CONFIG di-cache 6 jam, jadi cache
   * dibuang DULU — kalau tidak, dua eksekusi berurutan membaca counter sama.
   */
  function nextId() {
    TC.invalidate(TC.S.CONFIG);
    const row = TC.find(TC.S.CONFIG, 'Key', 'THREAD_COUNTER');
    if (!row) {
      throw new AppError(ERROR_CODES.INTERNAL,
        'CONFIG.THREAD_COUNTER tidak ada. Tambahkan barisnya di sheet CONFIG (nilai 0).');
    }
    const next = (Number(row.Value) || 0) + 1;
    TC.update(TC.S.CONFIG, row._row, { Value: String(next), Updated_At: TC.nowIso() });
    return 'TH-' + pad6(next);
  }

  /**
   * Penulis TUNGGAL sheet CASE_THREAD. Jangan append dari file lain.
   * @param {boolean} touchCase update Last_Activity_* di baris case pada lock
   *        yang sama. FALSE untuk baris System — Case_.transition sudah
   *        meng-update-nya, dan menimpanya membuat Last_Activity_By = SYSTEM.
   */
  function write(rec, touchCase) {
    return TC.withLock(function () {
      const id = nextId();
      const ts = TC.nowIso();
      const row = {
        Thread_ID: id,
        Case_No: rec.Case_No,
        Parent_ID: s(rec.Parent_ID),
        Author_User_ID: rec.Author_User_ID || 'SYSTEM',
        Author_Role: rec.Author_Role || 'SYSTEM',
        Message_Type: rec.Message_Type,
        Message: rec.Message,
        Visibility: rec.Visibility || 'All',
        Created_At: ts,
        Edited_At: '',
        Deleted: 'FALSE'
      };
      TC.append(TC.S.THREAD, row);

      if (touchCase) {
        const c = TC.find(TC.S.CASES, 'Case_No', rec.Case_No);
        if (c) {
          TC.update(TC.S.CASES, c._row, {
            Updated_At: ts, Last_Activity_At: ts, Last_Activity_By: row.Author_User_ID
          });
        }
      }
      TC.flush();
      return row;
    });
  }

  function toPublic(r) {
    const o = {};
    for (const k in r) if (k !== '_row') o[k] = r[k];
    o.Author_Name = nameOf(r.Author_User_ID);
    return o;
  }

  /**
   * Baris yang boleh dilihat ctx. Dealer TIDAK PERNAH menerima baris IIDI_Only
   * (01-schema.md §6). Urut naik pakai Thread_ID, bukan Created_At: dua baris
   * bisa lahir di detik yang sama, Thread_ID tidak pernah kembar.
   */
  function rowsFor(ctx, caseNo, since) {
    const dealerView = !isIidi(ctx.user.role);
    const from = s(since);
    return TC.filter(TC.S.THREAD, function (r) {
      if (r.Case_No !== caseNo) return false;
      if (r.Deleted === 'TRUE') return false;
      if (dealerView && r.Visibility === 'IIDI_Only') return false;
      if (from && r.Created_At <= from) return false;
      return true;
    }).sort(function (a, b) {
      return a.Thread_ID < b.Thread_ID ? -1 : (a.Thread_ID > b.Thread_ID ? 1 : 0);
    }).map(toPublic);
  }

  /** Guard baca: akses case + draft tidak terlihat IIDI (04-state-machine.md §1). */
  function assertReadable(ctx, r) {
    assertCanAccessCase_(ctx, r);
    if (r.Status === 'Created' && isIidi(ctx.user.role)) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Case ini masih draft dan belum dikirim ke IIDI.');
    }
  }

  // ── thread.list ───────────────────────────────────────────────────────────
  function list(ctx, p) {
    const caseNo = s(p.caseNo);
    if (!caseNo) throw new AppError(ERROR_CODES.VALIDATION, 'caseNo wajib diisi.', { caseNo: 'Wajib diisi.' });
    assertReadable(ctx, caseRow(caseNo));
    return { items: rowsFor(ctx, caseNo, p.since) };
  }

  // ── thread.post ───────────────────────────────────────────────────────────
  function post(ctx, p) {
    requirePerm_(ctx, 'thread.post');

    const caseNo = s(p.caseNo);
    const message = s(p.message);
    const f = {};
    if (!caseNo) f.caseNo = 'Wajib diisi.';
    if (!message) f.message = 'Pesan tidak boleh kosong.';
    if (message.length > MAX_LEN) f.message = 'Pesan maksimal ' + MAX_LEN + ' karakter.';
    if (Object.keys(f).length) throw new AppError(ERROR_CODES.VALIDATION, 'Ada isian yang belum benar.', f);

    const r = caseRow(caseNo);
    assertReadable(ctx, r);

    // C7: case tertutup boleh dibaca, tidak boleh ditambah diskusi.
    if (r.Status === 'Closed') {
      throw new AppError(ERROR_CODES.CONFLICT,
        'Case sudah ditutup. Buka kembali (reopen) case ini kalau diskusi perlu dilanjutkan.');
    }

    let type = s(p.messageType) || 'Comment';
    if (!has(TYPES, type)) {
      throw new AppError(ERROR_CODES.VALIDATION, 'Jenis pesan tidak dikenal.',
        { messageType: 'Pilih salah satu: ' + TYPES.join(', ') + '.' });
    }

    let visibility = s(p.visibility) || 'All';
    if (!has(VISIBILITIES, visibility)) {
      throw new AppError(ERROR_CODES.VALIDATION, 'Visibilitas tidak dikenal.',
        { visibility: 'Pilih All atau IIDI_Only.' });
    }
    if (visibility === 'IIDI_Only') requirePerm_(ctx, 'thread.iidiOnly');

    // Balasan bersarang: parent harus ada di case yang sama. Balasan atas baris
    // IIDI_Only ikut IIDI_Only — kalau tidak, isinya bocor ke dealer lewat kutipan.
    const parentId = s(p.parentId);
    if (parentId) {
      const parent = TC.find(TC.S.THREAD, 'Thread_ID', parentId);
      if (!parent || parent.Case_No !== caseNo || parent.Deleted === 'TRUE') {
        throw new AppError(ERROR_CODES.NOT_FOUND, 'Pesan yang dibalas tidak ditemukan.');
      }
      if (parent.Visibility === 'IIDI_Only') {
        requirePerm_(ctx, 'thread.iidiOnly');
        visibility = 'IIDI_Only';
      }
    }

    // Usulan priority oleh IIDI_Tech_Mgr (01-schema.md §6 & §9, 03-rbac.md §2:
    // "usul saja"). TIDAK mengubah field Priority — hanya jejak + baris Decision.
    const suggested = s(p.suggestedPriority);
    if (suggested) {
      requirePerm_(ctx, 'case.suggestPriority');
      if (!has(PRIORITIES, suggested)) {
        throw new AppError(ERROR_CODES.VALIDATION, 'Priority usulan tidak valid.',
          { suggestedPriority: 'Pilih Normal, Urgent, atau Critical.' });
      }
      type = 'Decision';
    }

    const row = write({
      Case_No: caseNo, Parent_ID: parentId,
      Author_User_ID: ctx.user.userId, Author_Role: ctx.user.role,
      Message_Type: type, Message: message, Visibility: visibility
    }, true);

    if (suggested) {
      Case_.event(ctx, caseNo, 'Priority_Suggested', r.Priority, suggested, message,
                  { threadId: row.Thread_ID });
    }

    notify('THREAD_REPLY', caseNo, {
      threadId: row.Thread_ID, authorUserId: ctx.user.userId,
      authorRole: ctx.user.role, visibility: visibility, messageType: type
    });

    return { item: toPublic(row) };
  }

  return {
    list: list,
    post: post,

    /**
     * Dipanggil hook() di 20_CaseService.gs setiap transisi status.
     * Signature persis (caseNo, message) — jangan diubah tanpa mengubah
     * call site di 20_CaseService.gs.
     */
    system: function (caseNo, message) {
      return write({
        Case_No: caseNo, Message_Type: 'System', Message: s(message), Visibility: 'All'
      }, false);
    },

    /** Baris thread yang ditulis service lain atas nama user (24_RequestService.gs). */
    serviceNote: function (ctx, caseNo, messageType, message, visibility) {
      return write({
        Case_No: caseNo,
        Author_User_ID: ctx.user.userId, Author_Role: ctx.user.role,
        Message_Type: messageType, Message: s(message), Visibility: visibility || 'All'
      }, true);
    },

    /** Dipakai Case_.get — sudah ter-scope oleh guard di case.get. */
    forCase: function (ctx, caseNo) { return rowsFor(ctx, caseNo, ''); }
  };
})();