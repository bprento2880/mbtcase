/**
 * 21_DiagService.gs — CASE_DIAGNOSTICS (docs/01-schema.md §5)
 * Action: diag.save (docs/02-api-contract.md §"Diagnostics")
 *
 * KENAPA FILE INI BARU ADA SEKARANG:
 * File ini terdaftar di CLAUDE.md §4 sebagai bagian Fase 2, tapi tidak pernah
 * ditulis dan 'diag.save' tidak pernah didaftarkan ke ROUTES. Akibatnya kolom
 * diagnostik hanya bisa diisi SEKALI lewat case.create dan tidak pernah bisa
 * diperbarui — padahal alur Fase 5 (request.fulfill) mengandaikan dealer
 * menambahkan DTC/Workshop_Findings setelah diminta IIDI.
 *
 * Ini ditulis sebagai PATCH FASE 2, bukan bagian Fase 7. Fase 7 membutuhkannya
 * karena rule engine advisory membaca DTC_Codes dan Control_Unit dari sheet ini.
 *
 * Kontrak yang dipakai dari file lain:
 *   TC.find / TC.update / TC.append / TC.withLock / TC.flush   (10_SheetDB.gs)
 *   requirePerm_ / assertCanAccessCase_                        (13_Guard.gs)
 *   Case_.event / Case_.recalcScore                            (20_CaseService.gs)
 */
var Diag_ = (function () {

  // Kolom isi CASE_DIAGNOSTICS. Case_No / Updated_At / Updated_By TIDAK di sini —
  // ketiganya diisi server, tidak pernah diambil dari payload (CLAUDE.md §5).
  const EDITABLE = [
    'Initial_Diag', 'Dealer_Analysis', 'Suspected_Root_Cause', 'Workshop_Findings',
    'DTC_Codes', 'Control_Unit', 'Diagnostic_Path', 'Xentry_Version',
    'SW_Version_Before', 'SW_Version_After', 'Parts_Replaced', 'Previous_Repair_History'
  ];

  // DTC dinormalkan jadi UPPERCASE tanpa spasi di sekitar koma ("p0087, b1234"
  // -> "P0087,B1234"). Rule engine Fase 7 mencocokkan DTC_Prefix dengan
  // perbandingan string, jadi normalisasi harus terjadi di titik tulis, bukan
  // di titik baca — kalau tidak, data lama dan data baru tidak pernah cocok.
  const NORMALIZE_DTC = { DTC_Codes: 1 };

  // Sel Google Sheets maksimum ~50.000 karakter. 5.000 per field sudah jauh di
  // atas kebutuhan nyata dan mencegah satu field merusak seluruh baris.
  const MAX_FIELD_LEN = 5000;

  const STATUS_CLOSED = 'Closed';

  function s(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }
  function n(v) { const x = Number(v); return isNaN(x) ? 0 : x; }

  function rowOf(caseNo) { return TC.find(TC.S.DIAG, 'Case_No', caseNo); }

  /**
   * Bentuk publik baris diagnostik. Selalu mengembalikan objek (tidak pernah
   * null) supaya pemanggil tidak perlu menjaga null-check di mana-mana.
   * Dipakai juga oleh 40_Advisory.gs (Fase 7) dan 60_Dashboard.gs (Fase 8).
   */
  function forCase(caseNo) {
    const r = rowOf(caseNo);
    const out = {};
    if (!r) return out;
    for (const k in r) if (k !== '_row') out[k] = r[k];
    return out;
  }

  /**
   * diag.save — { caseNo, fields } -> { diagnostics, qualityScore }
   *
   * Perizinan: 'case.editDraft' hanya dimiliki role dealer (13_Guard.gs), jadi
   * praktisnya hanya dealer yang boleh menulis. Ini disengaja — Quality_Score
   * mengukur kualitas input DEALER (01-schema.md §20); kalau IIDI ikut mengisi
   * kolom yang sama, angka itu kehilangan artinya. Temuan IIDI ditulis sebagai
   * baris CASE_THREAD, bukan di sini.
   */
  function save(ctx, p) {
    const caseNo = s(p.caseNo);
    if (!caseNo) {
      throw new AppError(ERROR_CODES.VALIDATION, 'caseNo wajib diisi.', { caseNo: 'Wajib diisi.' });
    }

    requirePerm_(ctx, 'case.editDraft');

    const c = TC.find(TC.S.CASES, 'Case_No', caseNo);
    if (!c) throw new AppError(ERROR_CODES.NOT_FOUND, 'Case ' + caseNo + ' tidak ditemukan.');
    assertCanAccessCase_(ctx, c);

    if (c.Status === STATUS_CLOSED) {
      throw new AppError(ERROR_CODES.CONFLICT, 'Case sudah ditutup, data diagnostik tidak bisa diubah.');
    }

    // ── Susun patch dari whitelist. Field di luar EDITABLE dibuang diam-diam. ──
    const fields = p.fields || {};
    const patch = {};
    const tooLong = {};
    EDITABLE.forEach(function (k) {
      if (fields[k] === undefined) return;
      let val = s(fields[k]);
      if (NORMALIZE_DTC[k]) val = val.toUpperCase().replace(/\s*,\s*/g, ',');
      if (val.length > MAX_FIELD_LEN) {
        tooLong[k] = 'Maksimal ' + MAX_FIELD_LEN + ' karakter.';
        return;
      }
      patch[k] = val;
    });

    if (Object.keys(tooLong).length) {
      throw new AppError(ERROR_CODES.VALIDATION, 'Ada isian yang terlalu panjang.', tooLong);
    }
    if (!Object.keys(patch).length) {
      throw new AppError(ERROR_CODES.VALIDATION, 'Tidak ada field diagnostik yang dikirim.',
        { fields: 'Kirim minimal satu field diagnostik.' });
    }

    const ts = TC.nowIso();
    const diff = {};

    TC.withLock(function () {
      // Dibaca ULANG di dalam lock. Baris di luar lock bisa sudah basi kalau
      // dealer lain di dealer yang sama menyimpan bersamaan.
      const existing = rowOf(caseNo);

      if (existing) {
        Object.keys(patch).forEach(function (k) {
          if (s(existing[k]) !== patch[k]) diff[k] = { from: s(existing[k]), to: patch[k] };
        });
        if (!Object.keys(diff).length) return;      // benar-benar tidak ada perubahan

        patch.Updated_At = ts;
        patch.Updated_By = ctx.user.userId;
        TC.update(TC.S.DIAG, existing._row, patch);

      } else {
        // Baris hilang (case dari sebelum patch ini, atau sheet diedit manual).
        // Dibuat ulang agar 1:1 dengan CASES_MASTER tetap terjaga.
        const rec = { Case_No: caseNo, Updated_At: ts, Updated_By: ctx.user.userId };
        EDITABLE.forEach(function (k) {
          rec[k] = (patch[k] === undefined) ? '' : patch[k];
          if (rec[k]) diff[k] = { from: '', to: rec[k] };
        });
        TC.append(TC.S.DIAG, rec);
      }

      // Last_Activity_At WAJIB ikut naik walau Quality_Score tidak berubah —
      // kalau tidak, case yang aktif diisi dealer tetap terhitung 'Stale'
      // (04-state-machine.md §6). recalcScore() di bawah hanya menyentuh
      // CASES kalau skornya berubah, jadi tidak bisa diandalkan untuk ini.
      if (Object.keys(diff).length) {
        const fresh = TC.find(TC.S.CASES, 'Case_No', caseNo);
        if (fresh) {
          TC.update(TC.S.CASES, fresh._row, {
            Updated_At: ts, Last_Activity_At: ts, Last_Activity_By: ctx.user.userId
          });
        }
      }
      TC.flush();
    });

    if (!Object.keys(diff).length) {
      return { diagnostics: forCase(caseNo), qualityScore: n(c.Quality_Score) };
    }

    // Event dan recalcScore DI LUAR lock. recalcScore mengambil lock-nya
    // sendiri (20_CaseService.gs) — memanggilnya dari dalam TC.withLock di atas
    // berarti nested lock, dan itu penyebab BUSY yang sulit dilacak.
    Case_.event(ctx, caseNo, 'Field_Updated', '', Object.keys(diff).join(','),
                s(p.note), { diagnostics: diff });

    const score = Case_.recalcScore(ctx, caseNo);
    return { diagnostics: forCase(caseNo), qualityScore: score };
  }

  return {
    save: save,
    forCase: forCase,
    // dibuka untuk 99_Tests.gs dan 40_Advisory.gs (Fase 7)
    EDITABLE: EDITABLE
  };
})();