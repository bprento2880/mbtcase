/**
 * 13_Guard.gs — matrix permission + dua guard wajib. Acuan: 03-rbac.md §2–§3.
 * 🔸 di docs dipetakan jadi true di sini; syarat scope-nya ditegakkan
 * oleh assertCanAccessCase_ atau oleh service layer fase berikutnya.
 */
const PERMISSIONS = {
  CDT: {
    'case.create': true, 'case.editDraft': true, 'case.viewOwnDealer': true,
    'case.setPriority': true, 'case.submit': true, 'thread.post': true,
    'attach.upload': true, 'attach.delete': true, 'closure.confirm': true,
    'dashboard.dealer': true, 'request.fulfill': true          // Fase 5
  },
  Senior_Tech: {
    'case.create': true, 'case.editDraft': true, 'case.viewOwnDealer': true,
    'case.setPriority': true, 'case.submit': true, 'thread.post': true,
    'attach.upload': true, 'attach.delete': true, 'closure.confirm': true,
    'dashboard.dealer': true, 'request.fulfill': true          // Fase 5
  },
  Dealer_SM: {
    'case.create': true, 'case.editDraft': true, 'case.viewOwnDealer': true,
    'case.setPriority': true, 'case.submit': true, 'thread.post': true,
    'attach.upload': true, 'attach.delete': true, 'closure.confirm': true,
    'case.reopen': true, 'dashboard.dealer': true, 'data.export': true,
    'request.fulfill': true                      // Fase 5, 03-rbac.md §2
  },
  IIDI_Tech: {
    'case.viewOwnDealer': true, 'case.viewOtherDealer': true, 'case.claim': true,
    'request.create': true, 'thread.post': true, 'thread.iidiOnly': true,
    'attach.upload': true, 'attach.delete': true, 'escalation.update': true,
    'closure.request': true, 'case.reopen': true, 'dashboard.dealer': true,
    'dashboard.distributor': true, 'kb.create': true, 'data.export': true
  },
  IIDI_Tech_Mgr: {
    'case.viewOwnDealer': true, 'case.viewOtherDealer': true, 'case.claim': true,
    'case.assign': true, 'case.suggestPriority': true, 'request.create': true,
    'thread.post': true, 'thread.iidiOnly': true, 'attach.upload': true,
    'attach.delete': true, 'escalation.create': true, 'escalation.update': true,
    'closure.request': true, 'closure.override': true, 'case.reopen': true,
    'dashboard.dealer': true, 'dashboard.distributor': true, 'kb.create': true,
    'user.manage': true, 'audit.view': true, 'data.export': true
  },
  IIDI_Area_Mgr: {
    'case.viewOwnDealer': true, 'case.viewOtherDealer': true, 'thread.post': true,
    'thread.iidiOnly': true, 'dashboard.dealer': true, 'dashboard.distributor': true,
    'data.export': true
  },
  IIDI_Director: {
    'case.viewOwnDealer': true, 'case.viewOtherDealer': true, 'thread.post': true,
    'thread.iidiOnly': true, 'dashboard.dealer': true, 'dashboard.distributor': true,
    'audit.view': true, 'data.export': true
  }
};

// Fase 2 TIDAK menambah permission baru. Key yang dipakai 20_CaseService.gs —
// case.create, case.editDraft, case.setPriority, case.claim, case.assign,
// case.reopen — semuanya sudah ada di tabel PERMISSIONS di atas.


/** Action yang tetap boleh dipanggil saat Must_Change_PIN = TRUE. */
const ALLOWED_WHEN_MUST_CHANGE_PIN = new Set(['auth.me', 'auth.logout', 'auth.changePin', 'sys.ping']);

/** Guard 1 — apakah role ini boleh melakukan aksi ini? */
function requirePerm_(ctx, perm) {
  const role = ctx && ctx.user ? ctx.user.role : '';
  if (!PERMISSIONS[role] || !PERMISSIONS[role][perm]) {
    Audit_.log(ctx, 'ACCESS_DENIED', perm, 'DENIED', 'role=' + role);
    throw new AppError('FORBIDDEN', 'Role Anda tidak memiliki akses untuk aksi ini.');
  }
}

/** Guard 2 — apakah user ini boleh menyentuh case ini? */
function assertCanAccessCase_(ctx, caseRow) {
  if (!caseRow) throw new AppError('NOT_FOUND', 'Case tidak ditemukan.');
  const role = ctx.user.role;

  if (role.indexOf('IIDI_') === 0) {
    if (role === 'IIDI_Area_Mgr') {
      const dealer = TC.find(TC.S.DEALERS, 'Dealer_ID', caseRow.Dealer_ID);
      if (!dealer || ctx.user.areas.indexOf(dealer.Area) === -1) Guard_.deny(ctx, caseRow);
    }
    return;
  }
  if (caseRow.Dealer_ID !== ctx.user.dealerId) Guard_.deny(ctx, caseRow);
}

var Guard_ = {
  deny: function (ctx, caseRow) {
    Audit_.log(ctx, 'ACCESS_DENIED', caseRow.Case_No || '', 'DENIED',
               'dealer case=' + caseRow.Dealer_ID + ', dealer user=' + ctx.user.dealerId);
    throw new AppError('FORBIDDEN', 'Anda tidak punya akses ke case ini.');
  },

  /** Area seorang IIDI_Area_Mgr diturunkan dari DEALERS.Area_Manager_User_ID. */
  areasOf: function (userRow) {
    if (userRow.Role !== 'IIDI_Area_Mgr') return [];
    const seen = {};
    TC.filter(TC.S.DEALERS, function (d) {
      return d.Area_Manager_User_ID === userRow.User_ID && d.Status === 'ACTIVE';
    }).forEach(function (d) { seen[d.Area] = true; });
    return Object.keys(seen);
  },

  /** Dipanggil router sebelum dispatch. */
  assertPinChanged: function (ctx, action) {
    if (ctx.user && ctx.user.mustChangePin && !ALLOWED_WHEN_MUST_CHANGE_PIN.has(action)) {
      throw new AppError('FORBIDDEN', 'Anda wajib mengganti PIN sementara terlebih dahulu.');
    }
  }
};