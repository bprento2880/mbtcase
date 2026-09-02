/**
 * 41_Gemini.gs — FASE 7, LAPIS 2 (Gemini)
 *
 * Acuan: docs/07-ai-advisory.md §4.
 *
 * KONTRAK KE PEMANGGIL: Gemini_.advise() TIDAK PERNAH melempar exception.
 * Selalu mengembalikan { ok: true, data } atau { ok: false, error }.
 * 40_Advisory.gs mengandalkan itu untuk fallback diam-diam.
 *
 * PRIVASI: SEMUA panggilan wajib lewat redactForAi_(). Tidak ada pengecualian.
 * Free tier Gemini mengizinkan Google memakai prompt untuk pengembangan produk,
 * sementara sheet ini berisi data pelanggan dan kendaraan.
 */
var Gemini_ = (function () {

  const ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

  /**
   * UrlFetchApp TIDAK punya opsi timeout — batas kerasnya ~60 detik dan tidak
   * bisa diturunkan ke 20 detik seperti tertulis di docs §4. Yang bisa kita
   * kendalikan adalah UKURAN kerja: maxOutputTokens kecil + input yang sudah
   * diringkas. Latency tetap dicatat supaya kalau benar-benar sering >20 detik,
   * itu terlihat di AI_ADVISORY_LOG dan bisa ditindak.
   */
  const MAX_OUTPUT_TOKENS = 1024;
  const RETRY_TRANSIENT_DELAY_MS = 3000;

  const SYSTEM_PROMPT = [
    'Anda adalah asisten technical advisor untuk after-sales kendaraan Mercedes-Benz.',
    'Anda membantu teknisi dealer menyiapkan case teknis sebelum diteruskan ke tim',
    'technical distributor.',
    '',
    'Tugas Anda:',
    '1. Menilai apakah priority yang dipilih dealer masuk akal terhadap kondisi kendaraan',
    '   dan keluhan. Beri saran, jangan memutuskan.',
    '2. Merekomendasikan bukti diagnostik yang sebaiknya dilampirkan, spesifik terhadap',
    '   gejala dan DTC yang ada. Sebut sebagai "recommended evidence".',
    '3. Menyebutkan informasi penting yang belum diisi.',
    '4. Menyebutkan arah investigasi yang paling mungkin, dengan bahasa hati-hati.',
    '',
    'Aturan:',
    '- Jangan pernah menyatakan diagnosis sebagai kepastian. Gunakan "kemungkinan",',
    '  "perlu diverifikasi".',
    '- Jangan menyebut bukti sebagai wajib.',
    '- Jangan merekomendasikan penggantian part tanpa verifikasi pengukuran.',
    '- Jawab dalam Bahasa Indonesia teknis yang ringkas.',
    '- Kalau data terlalu sedikit untuk disimpulkan, katakan begitu dan set confidence "low".'
  ].join('\n');

  const RESPONSE_SCHEMA = {
    type: 'OBJECT',
    properties: {
      priorityAdvice: {
        type: 'OBJECT',
        properties: {
          suggested: { type: 'STRING', enum: ['Normal', 'Urgent', 'Critical', 'No_Change'] },
          reason: { type: 'STRING' }
        }
      },
      recommendedEvidence: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            evidenceType: { type: 'STRING' },
            label: { type: 'STRING' },
            why: { type: 'STRING' }
          }
        }
      },
      missingInformation: { type: 'ARRAY', items: { type: 'STRING' } },
      likelyDirection: { type: 'STRING' },
      confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] }
    },
    required: ['priorityAdvice', 'recommendedEvidence', 'confidence']
  };

  function s(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }
  function n(v) { const x = Number(v); return isNaN(x) ? 0 : x; }

  // ── Kuota harian (01-schema.md §19, REVISI Fase 7) ────────────────────────

  /**
   * Counter dengan reset MALAS berbasis tanggal, pola sama dengan
   * EMAIL_SENT_TODAY / EMAIL_SENT_DATE di 50_Notify.gs.
   *
   * Sengaja TIDAK mematikan FEATURE_GEMINI seperti bunyi harfiah docs §4 no.4.
   * FEATURE_GEMINI adalah sakelar MANUSIA; kalau kode ikut menulisinya, tidak
   * ada yang tahu apakah nilai FALSE hari ini berarti "kuota habis kemarin"
   * atau "sengaja dimatikan admin", dan tanpa trigger tengah malam ia mati
   * permanen. Gerbang kuota ada di fungsi ini, sakelar tetap milik admin.
   */
  function quotaGate() {
    const today = TC.nowIso().slice(0, 10);
    const limit = n(Config_.get('GEMINI_DAILY_LIMIT', 200)) || 200;
    const date = s(Config_.get('GEMINI_CALLS_DATE', ''));
    const used = (date === today) ? n(Config_.get('GEMINI_CALLS_TODAY', 0)) : 0;
    return { today: today, limit: limit, used: used, ok: used < limit };
  }

  function quotaBump(today, used) {
    try {
      TC.withLock(function () {
        const rowC = TC.find(TC.S.CONFIG, 'Key', 'GEMINI_CALLS_TODAY');
        const rowD = TC.find(TC.S.CONFIG, 'Key', 'GEMINI_CALLS_DATE');
        const ts = TC.nowIso();
        if (rowC) TC.update(TC.S.CONFIG, rowC._row, { Value: String(used + 1), Updated_At: ts });
        if (rowD) TC.update(TC.S.CONFIG, rowD._row, { Value: today, Updated_At: ts });
      });
      Config_.invalidate();
      TC.invalidate(TC.S.CONFIG);
    } catch (e) {
      // Counter meleset lebih baik daripada advisory gagal.
      console.error('Gemini_.quotaBump: ' + e);
    }
  }

  // ── Redaksi data (docs §4 "Privasi data") ─────────────────────────────────

  /**
   * Buang jejak identitas dari teks bebas. Dealer sering menulis nama pelanggan
   * atau nomor polisi di dalam Complaint_Desc, dan itu lolos dari daftar kolom
   * terlarang kalau hanya kolomnya yang dibuang.
   */
  function scrubText_(text, secrets) {
    let t = s(text);
    if (!t) return '';
    (secrets || []).forEach(function (sec) {
      const v = s(sec);
      if (v.length < 4) return;   // terlalu pendek -> risiko menyensor kata biasa
      t = t.replace(new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[REDACTED]');
    });
    // Pola nomor polisi Indonesia: B 1234 XYZ / AB1234CD
    t = t.replace(/\b[A-Z]{1,2}\s?\d{1,4}\s?[A-Z]{1,3}\b/g, '[NOPOL]');
    // Sisa VIN 17 karakter yang mungkin ditempel di teks
    t = t.replace(/\b[A-HJ-NPR-Z0-9]{17}\b/gi, '[VIN]');
    return t.slice(0, 4000);   // pagar panjang, sekaligus hemat token
  }

  /**
   * SATU-SATUNYA pintu data menuju Gemini.
   *
   * DIBUANG total: Cust_Name, Reg_No, Engine_No, Trans_No, Dealer_ID,
   *                Dealer_Name, semua User_ID, Case_No.
   * DIPOTONG:      VIN -> 8 karakter terakhir saja (untuk konteks varian).
   * DIKIRIM:       model, tahun, kilometer, keluhan, kategori, DTC, control unit,
   *                hasil diagnosis, kondisi kendaraan.
   */
  function redactForAi_(c, d) {
    c = c || {}; d = d || {};
    const secrets = [c.Cust_Name, c.Reg_No, c.VIN, c.Engine_No, c.Trans_No, c.Dealer_Name];
    const vin = s(c.VIN);

    return {
      vehicle: {
        model: s(c.Model),
        prodYear: s(c.Prod_Year),
        mileageKm: n(c.Mileage),
        vinTail: vin.length === 17 ? vin.slice(-8) : '',
        warrantyStatus: s(c.Warranty_Status),
        vehicleStatus: s(c.Vehicle_Status)
      },
      complaint: {
        description: scrubText_(c.Complaint_Desc, secrets),
        symptomCategory: s(c.Symptom_Category),
        frequency: s(c.Frequency),
        drivingCondition: scrubText_(c.Driving_Condition, secrets),
        outsideTemp: s(c.Outside_Temp),
        fuelLevel: s(c.Fuel_Level),
        roadCondition: s(c.Road_Condition)
      },
      diagnostics: {
        dtcCodes: s(d.DTC_Codes),
        controlUnit: s(d.Control_Unit),
        initialDiagnosis: scrubText_(d.Initial_Diag, secrets),
        dealerAnalysis: scrubText_(d.Dealer_Analysis, secrets),
        suspectedRootCause: scrubText_(d.Suspected_Root_Cause, secrets),
        workshopFindings: scrubText_(d.Workshop_Findings, secrets),
        diagnosticPath: scrubText_(d.Diagnostic_Path, secrets),
        xentryVersion: s(d.Xentry_Version),
        swVersionBefore: s(d.SW_Version_Before),
        swVersionAfter: s(d.SW_Version_After),
        partsReplaced: scrubText_(d.Parts_Replaced, secrets)
      },
      dealerPriority: s(c.Priority) || 'Normal'
    };
  }

  // ── Panggilan HTTP ────────────────────────────────────────────────────────

  function callOnce_(model, key, payload) {
    const url = ENDPOINT_BASE + encodeURIComponent(model) + ':generateContent';
    return UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  }

  /** Ambil bagian teks dari response Gemini. Bentuknya bisa multi-part. */
  function extractText_(body) {
    const cand = body && body.candidates && body.candidates[0];
    if (!cand) return '';
    // Jawaban terpotong karena maxOutputTokens -> JSON pasti rusak. Tolak lebih
    // awal daripada membiarkan JSON.parse gagal dengan pesan membingungkan.
    if (cand.finishReason && cand.finishReason !== 'STOP') {
      throw new Error('finishReason=' + cand.finishReason);
    }
    const parts = (cand.content && cand.content.parts) || [];
    return parts.map(function (p) { return s(p.text); }).filter(Boolean).join('');
  }

  /** Validasi minimal terhadap schema. JSON di luar bentuk ini ditolak. */
  function validateShape_(o) {
    if (!o || typeof o !== 'object') return 'bukan objek';
    if (!o.priorityAdvice || typeof o.priorityAdvice !== 'object') return 'priorityAdvice hilang';
    if (['Normal', 'Urgent', 'Critical', 'No_Change'].indexOf(s(o.priorityAdvice.suggested)) === -1) {
      return 'priorityAdvice.suggested tidak valid';
    }
    if (!Array.isArray(o.recommendedEvidence)) return 'recommendedEvidence bukan array';
    if (['low', 'medium', 'high'].indexOf(s(o.confidence)) === -1) return 'confidence tidak valid';
    return '';
  }

  /**
   * Titik masuk tunggal dari 40_Advisory.gs.
   * @return {{ok: boolean, data?: Object, error?: string}}
   */
  function advise(c, d) {
    const model = s(Config_.get('GEMINI_MODEL', ''));
    if (!model) return { ok: false, error: 'CONFIG.GEMINI_MODEL belum diisi' };

    let key = '';
    try { key = scriptProp_('GEMINI_API_KEY'); }
    catch (e) { return { ok: false, error: 'GEMINI_API_KEY belum diisi di Script Properties' }; }

    const q = quotaGate();
    if (!q.ok) return { ok: false, error: 'Kuota harian Gemini tercapai (' + q.used + '/' + q.limit + ')' };

    const redacted = redactForAi_(c, d);
    const payload = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(redacted) }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA
      }
    };

    let res;
    try {
      res = callOnce_(model, key, payload);
      quotaBump(q.today, q.used);

      // 429 = rate/kuota. 503 = model sedang padat, dan pesan Google sendiri
      // menyuruh mencoba lagi. Keduanya transien -> retry SEKALI, 3 detik.
      // Ini melebihi docs §4 ("5xx fallback langsung") secara sadar: 503 pada
      // model Flash populer sering terjadi dan hilang dalam hitungan detik.
      const rc = res.getResponseCode();
      if (rc === 429 || rc === 503) {
        Utilities.sleep(RETRY_TRANSIENT_DELAY_MS);
        res = callOnce_(model, key, payload);
        quotaBump(q.today, q.used + 1);
      }
    } catch (e) {
      return { ok: false, error: 'fetch gagal: ' + e };
    }

    const code = res.getResponseCode();
    if (code !== 200) {
      // Badan error Google bisa panjang; potong supaya sel sheet tidak jebol.
      return { ok: false, error: 'HTTP ' + code + ' ' + s(res.getContentText()).slice(0, 300) };
    }

    let parsed;
    try {
      const body = JSON.parse(res.getContentText());
      const text = extractText_(body);
      if (!text) return { ok: false, error: 'response kosong' };
      parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ''));
    } catch (e) {
      return { ok: false, error: 'parse gagal: ' + e };
    }

    const bad = validateShape_(parsed);
    if (bad) return { ok: false, error: 'schema tidak sesuai: ' + bad };

    return { ok: true, data: parsed };
  }

  return {
    advise: advise,
    // dibuka untuk 99_Tests.gs — redaksi WAJIB bisa diuji
    redactForAi: redactForAi_,
    scrubText: scrubText_,
    quotaGate: quotaGate
  };
})();

/* ══════════════════ Alat setup — dijalankan MANUAL dari editor ══════════════════ */

/**
 * Jalankan SEKALI dari editor GAS, lalu isi CONFIG.GEMINI_MODEL dari hasilnya.
 *
 * Kenapa tidak di-hardcode: nama model Gemini dan status free/paid berubah
 * beberapa kali per tahun (Pro sudah dipindah ke belakang billing). Satu-satunya
 * sumber yang benar adalah daftar yang dikembalikan API key ANDA sendiri.
 * docs/07-ai-advisory.md §4 mensyaratkan pengecekan ini saat setup.
 *
 * Pilih model kelas Flash (bukan Pro) yang mendukung generateContent.
 */
function geminiListModels() {
  const key = scriptProp_('GEMINI_API_KEY');
  const res = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100',
    { method: 'get', headers: { 'x-goog-api-key': key }, muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 200) {
    console.log('GAGAL HTTP ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 500));
    return;
  }
  const models = (JSON.parse(res.getContentText()).models || []).filter(function (m) {
    return (m.supportedGenerationMethods || []).indexOf('generateContent') !== -1;
  });
  console.log('=== Model yang mendukung generateContent ===');
  models.forEach(function (m) {
    console.log(m.name.replace('models/', '') + '   | in ' + m.inputTokenLimit +
                ' / out ' + m.outputTokenLimit + ' | ' + (m.displayName || ''));
  });
  console.log('Isi CONFIG.GEMINI_MODEL dengan salah satu nama di atas (pilih kelas Flash).');
  return models.map(function (m) { return m.name.replace('models/', ''); });
}

/** Uji ujung-ke-ujung setelah GEMINI_MODEL diisi. Tidak menyentuh case nyata. */
function geminiSmokeTest() {
  const c = {
    Model: 'W206 C200', Prod_Year: '2023', Mileage: 41000, VIN: 'W1K2060461R123456',
    Cust_Name: 'Budi Santoso', Reg_No: 'B 1234 XYZ',
    Complaint_Desc: 'Mesin pincang saat idle, milik Budi Santoso mobil B 1234 XYZ',
    Symptom_Category: 'Engine', Frequency: 'Intermittent', Vehicle_Status: 'In_Workshop',
    Warranty_Status: 'In_Warranty', Priority: 'Normal'
  };
  const d = { DTC_Codes: 'P0301,P0087', Control_Unit: 'ME9.7',
              Initial_Diag: 'Quick test menunjukkan misfire silinder 1.' };

  console.log('--- Hasil redaksi (pastikan TIDAK ada nama/nopol/VIN penuh) ---');
  console.log(JSON.stringify(Gemini_.redactForAi(c, d), null, 2));
  console.log('--- Kuota ---');
  console.log(JSON.stringify(Gemini_.quotaGate()));
  console.log('--- Panggilan ---');
  console.log(JSON.stringify(Gemini_.advise(c, d), null, 2));
}