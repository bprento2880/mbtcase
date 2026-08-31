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
  'sys.ping': sysPing_
  // 'auth.login': Auth_.login,        // didaftarkan di 12_Auth.gs, Fase 1
  // 'case.create': CaseService_.create, // didaftarkan di 20_CaseService.gs, Fase 2
  // ...dst per fase, lihat docs/00-roadmap.md
};

function doGet(e) {
  // Hanya melayani shell SPA. TIDAK ADA data API lewat GET (02-api-contract.md §1).
  const tpl = HtmlService.createTemplateFromFile('ui/Index');
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

    const data = handler(ctx, req.payload || {});
    return jsonOutput_({ ok: true, data: data, meta: { serverTime: nowIso_() } });

  } catch (err) {
    const appErr = (err instanceof AppError) ? err : new AppError(ERROR_CODES.INTERNAL, 'Terjadi kesalahan sistem.');
    if (appErr.code === ERROR_CODES.INTERNAL) console.error(err.stack || err);
    if (typeof Audit_ !== 'undefined') Audit_.log(req.action, appErr.code); // aktif mulai Fase 1
    return jsonOutput_({
      ok: false,
      error: { code: appErr.code, message: appErr.message, fields: appErr.fields }
    });
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
  return {
    version: 'fase-0',
    serverTime: nowIso_(),
    features: {
      gemini: Config_.get('FEATURE_GEMINI', 'FALSE') === 'TRUE',
      wa: Config_.get('FEATURE_WA', 'FALSE') === 'TRUE'
    }
  };
}
