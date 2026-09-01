/**
 * 01_Router.gs
 *
 * Entry point GAS: doGet (memuat shell SPA) dan doPost (dispatch API action).
 * Kontrak lengkap: docs/02-api-contract.md
 *
 * CATATAN FASE 0: ROUTES baru berisi 'sys.ping'. Service layer (case, thread,
 * dashboard, dst) mendaftarkan handler-nya ke ROUTES di fase masing-masing —
 * cukup tambah baris ke object ROUTES di bawah, jangan ubah doPost().
 */

// PUBLIC_ACTIONS: satu-satunya action yang boleh dipanggil TANPA token valid.
// 'auth.login' didaftarkan di sini sejak sekarang walau handler-nya baru ada
// di Fase 1 — supaya file ini tidak perlu diubah lagi saat Fase 1 dikerjakan.
const PUBLIC_ACTIONS = new Set(['auth.login', 'sys.ping']);

const ROUTES = {
  'sys.ping':       sysPing_,
  // ── Fase 1 ────────────────────────────────────────────────
  'auth.login':     function (ctx, payload) { return Auth_.login(ctx, payload); },
  'auth.logout':    function (ctx, payload) { return Auth_.logout(ctx, payload, ctx._token); },
  'auth.me':        function (ctx, payload) { return Auth_.me(ctx); },
  'auth.changePin': function (ctx, payload) { return Auth_.changePin(ctx, payload); },
  // ── Fase 2 ────────────────────────────────────────────────
  'case.create':      function (ctx, payload) { return Case_.create(ctx, payload); },
  'case.get':         function (ctx, payload) { return Case_.get(ctx, payload); },
  'case.list':        function (ctx, payload) { return Case_.list(ctx, payload); },
  'case.update':      function (ctx, payload) { return Case_.update(ctx, payload); },
  'case.transition':  function (ctx, payload) { return Case_.transition(ctx, payload); },
  'case.assign':      function (ctx, payload) { return Case_.assign(ctx, payload); },
  'case.setPriority': function (ctx, payload) { return Case_.setPriority(ctx, payload); },
  // ── Fase 5 ────────────────────────────────────────────────
  'thread.list':      function (ctx, payload) { return Thread_.list(ctx, payload); },
  'thread.post':      function (ctx, payload) { return Thread_.post(ctx, payload); },
  'request.create':   function (ctx, payload) { return Request_.create(ctx, payload); },
  'request.fulfill':  function (ctx, payload) { return Request_.fulfill(ctx, payload); },
  // ── Fase 4 ────────────────────────────────────────────────
  // WAJIB pakai wrapper, BUKAN referensi langsung (Attach_.upload). ROUTES
  // dievaluasi saat load, dan 01_Router.gs di-load sebelum 23_AttachService.gs
  // — referensi langsung akan membaca Attach_ yang masih undefined.
  'attach.upload':         function (ctx, payload) { return Attach_.upload(ctx, payload); },
  'attach.initUpload':     function (ctx, payload) { return Attach_.initUpload(ctx, payload); },
  'attach.completeUpload': function (ctx, payload) { return Attach_.completeUpload(ctx, payload); },
  'attach.list':           function (ctx, payload) { return Attach_.list(ctx, payload); },
  'attach.download':       function (ctx, payload) { return Attach_.download(ctx, payload); },
  'attach.delete':         function (ctx, payload) { return Attach_.del(ctx, payload); },
  // ── Fase 6 ────────────────────────────────────────────────
  // Panel notifikasi (08-notifications.md §5). Hanya IIDI_Tech_Mgr —
  // penegakannya di requirePerm_(ctx, 'notif.admin') dalam 50_Notify.gs.
  'notif.queue':  function (ctx, payload) { return Notify_.adminQueue(ctx, payload); },
  'notif.retry':  function (ctx, payload) { return Notify_.adminRetry(ctx, payload); },
  'notif.test':   function (ctx, payload) { return Notify_.adminTest(ctx, payload); }
};
function doGet(e) {
  // Hanya melayani shell SPA. TIDAK ADA data API lewat GET (02-api-contract.md §1).
  const tpl = HtmlService.createTemplateFromFile('ui/Index');
  // Disuntik ke template supaya frontend tetap punya endpoint API yang benar
  // saat halaman dibuka LANGSUNG di /exec (iframe sandbox GAS),
  // bukan lewat Cloudflare Worker /tcase/. Lihat ui/js_core.html API_URL.
  tpl.execUrl = execUrl_();
  return tpl.evaluate()
    .setTitle('MB T-CASE')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  let req = {};
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOutput_({ ok: false, error: { code: ERROR_CODES.VALIDATION, message: 'Body tidak valid.' } });
  }

  try {
    const handler = ROUTES[req.action];
    if (!handler) throw new AppError(ERROR_CODES.NOT_FOUND, 'Action tidak dikenal: ' + req.action);

    // NOTE: di Fase 0, satu-satunya handler terdaftar (sys.ping) ada di
    // PUBLIC_ACTIONS, jadi baris Session_.validate() di bawah tidak pernah
    // tereksekusi sebelum 11_Session.gs ditulis di Fase 1. Aman.
    const ctx = PUBLIC_ACTIONS.has(req.action)
      ? { user: null }
      : Session_.validate(req.token);
    ctx._token = req.token;
    if (ctx.user) Guard_.assertPinChanged(ctx, req.action);   // Fase 1

    const data = handler(ctx, req.payload || {});
    return jsonOutput_({ ok: true, data: data, meta: { serverTime: TC.nowIso() } });

  } catch (err) {
    const appErr = (err instanceof AppError)
      ? err
      : new AppError(ERROR_CODES.INTERNAL, 'Terjadi kesalahan sistem.');
    // Error tak terduga masuk Stackdriver, BUKAN AUDIT_LOG.
    // AUDIT_LOG hanya untuk event keamanan (01-schema.md §10) — sudah
    // ditulis di dalam Auth_/Guard_ (LOGIN_FAILED, ACCESS_DENIED, dst).
    if (appErr.code === ERROR_CODES.INTERNAL) {
      console.error('[' + (req.action || '?') + '] ' + (err.stack || err));
    }
    return jsonOutput_({
      ok: false,
      error: { code: appErr.code, message: appErr.message, fields: appErr.fields }
    });
  }
}

/** URL /exec deployment aktif. Dipakai doGet untuk menyuntik endpoint ke SPA. */
function execUrl_() {
  try {
    return ScriptApp.getService().getUrl() || '';
  } catch (err) {
    return '';   // scope script.scriptapp belum disetujui -> biarkan kosong
  }
}

function jsonOutput_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Dipanggil dari template HTML: <?!= include('ui/js_core') ?> */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ── Handler bawaan Fase 0 ────────────────────────────────────────────────
function sysPing_(ctx, payload) {
  const cfg = TC.config();
  return {
    version: APP_VERSION,
    serverTime: TC.nowIso(),
    features: {
      gemini: cfg.FEATURE_GEMINI === 'TRUE',
      wa: cfg.FEATURE_WA === 'TRUE'
    }
  };
}
