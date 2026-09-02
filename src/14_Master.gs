/**
 * 14_Master.gs — master.bootstrap (docs/02-api-contract.md §"Master data")
 *
 * KENAPA FILE INI BARU ADA SEKARANG:
 * `master.bootstrap` tercantum di kontrak API sejak Fase 0 tapi tidak pernah
 * diimplementasikan dan tidak pernah didaftarkan ke ROUTES. Baru ketahuan saat
 * UI dikerjakan: form buat case tidak punya sumber data untuk dropdown model,
 * kategori gejala, dan tipe evidence. Ditulis sebagai PATCH FASE 2.
 *
 * Dipanggil SEKALI setelah login, lalu di-cache di frontend.
 *
 * ATURAN SCOPE: daftar dealer yang dikembalikan mengikuti role pemanggil
 * (03-rbac.md §1). Dealer tidak boleh melihat daftar dealer lain — itu bocoran
 * kecil tapi tetap bocoran, dan dipakai frontend untuk mengisi filter.
 */
var Master_ = (function () {

  function s(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }
  function isTrue(v) { return String(v).toUpperCase() === 'TRUE'; }

  /**
   * Enum Evidence_Type dari 01-schema.md §7.
   * CATATAN: ini satu-satunya tempat enum tersebut ditulis sebagai daftar.
   * Kalau 01-schema.md §7 berubah, ubah di sini juga.
   */
  const EVIDENCE_TYPES = [
    'Quick_Test', 'Actual_Value', 'Guided_Test', 'Photo', 'Video', 'Wiring_Check',
    'Measurement', 'Programming_Log', 'SCN_Coding', 'Repair_Doc', 'Other'
  ];

  /**
   * Key CONFIG yang boleh dilihat frontend. Whitelist, BUKAN blacklist —
   * mengirim seluruh CONFIG berarti membocorkan CASE_COUNTER, SLA_JOB_CURSOR,
   * kuota email, dan setiap key baru yang ditambahkan fase berikutnya tanpa
   * ada yang memikirkannya lagi.
   */
  const PUBLIC_CONFIG_KEYS = [
    'MAX_INLINE_UPLOAD_MB', 'MAX_RESUMABLE_UPLOAD_MB',
    'SLA_DEALER_SELF_DIAG_DAYS', 'SLA_IIDI_RESPONSE_DAYS', 'SLA_DEALER_RESPONSE_DAYS',
    'SLA_IIDI_DECISION_DAYS', 'SLA_CLOSURE_DAYS',
    'WORK_START', 'WORK_END', 'NEAR_DUE_THRESHOLD_HOURS',
    'FEATURE_GEMINI', 'FEATURE_WA', 'APP_BASE_URL'
  ];

  /** Dealer sesuai scope role (03-rbac.md §1). */
  function dealersFor(ctx) {
    const u = ctx.user;
    const all = TC.readAll(TC.S.DEALERS).filter(function (d) { return d.Status === 'ACTIVE'; });

    if (u.role.indexOf('IIDI_') !== 0) {
      // Role dealer hanya melihat dealer-nya sendiri.
      return all.filter(function (d) { return d.Dealer_ID === u.dealerId; }).map(slim);
    }
    if (u.role === 'IIDI_Area_Mgr') {
      const areas = u.areas || [];
      return all.filter(function (d) { return areas.indexOf(d.Area) !== -1; }).map(slim);
    }
    return all.map(slim);
  }

  function slim(d) {
    return { dealerId: d.Dealer_ID, dealerName: d.Dealer_Name, area: d.Area, city: d.City };
  }

  function models() {
    try {
      return TC.readAll(SHEETS.VEHICLE_MODELS)
        .filter(function (m) { return isTrue(m.Active); })
        .map(function (m) {
          return { code: s(m.Model_Code), name: s(m.Model_Name), category: s(m.Category) };
        })
        .sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    } catch (e) {
      console.error('Master_.models: ' + e);
      return [];
    }
  }

  function publicConfig() {
    const all = TC.config();
    const out = {};
    PUBLIC_CONFIG_KEYS.forEach(function (k) { if (all[k] !== undefined) out[k] = all[k]; });
    return out;
  }

  /**
   * master.bootstrap — {} -> { dealers, models, symptomCategories, evidenceTypes,
   *                            roles, statuses, priorities, warrantyStatuses,
   *                            frequencies, vehicleStatuses, permissions, config }
   *
   * Enum diambil dari Case_.ENUMS, BUKAN ditulis ulang di sini. Validasi backend
   * dan dropdown frontend harus berasal dari daftar yang sama persis — kalau
   * tidak, dealer bisa memilih nilai yang lalu ditolak backend.
   */
  function bootstrap(ctx) {
    // Tambahin baris TC.preload ini di paling atas
    TC.preload([TC.S.DEALERS, SHEETS.VEHICLE_MODELS, TC.S.CONFIG]);

    const E = (typeof Case_ !== 'undefined' && Case_.ENUMS) ? Case_.ENUMS : {};
    return {
      dealers: dealersFor(ctx),
      models: models(),
      symptomCategories: E.symptoms || [],
      statuses: E.statuses || [],
      priorities: E.priorities || [],
      warrantyStatuses: E.warranty || [],
      frequencies: E.frequencies || [],
      vehicleStatuses: (E.vehicleStatus || []).filter(function (x) { return !!x; }),
      waitingReasons: E.waitingReasons || [],
      evidenceTypes: EVIDENCE_TYPES,
      roles: Object.keys(PERMISSIONS),
      // Frontend memakai ini untuk MENYEMBUNYIKAN tombol yang tidak relevan.
      // Ini kenyamanan tampilan, bukan keamanan — penegakan tetap di
      // requirePerm_ pada setiap handler (03-rbac.md §3).
      permissions: PERMISSIONS[ctx.user.role] || {},
      config: publicConfig()
    };
  }

  return { bootstrap: bootstrap, EVIDENCE_TYPES: EVIDENCE_TYPES };
})();