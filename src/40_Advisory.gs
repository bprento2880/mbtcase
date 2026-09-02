/**
 * 40_Advisory.gs — FASE 7, LAPIS 1 (rule engine)
 *
 * Acuan: docs/07-ai-advisory.md §1–§3.
 *
 * PRINSIP YANG TIDAK BOLEH DILANGGAR:
 *   1. AI/advisory HANYA memberi saran. File ini TIDAK PERNAH menulis kolom
 *      Priority, Status, atau field case manapun. Satu-satunya sheet yang
 *      ditulis di sini adalah AI_ADVISORY_LOG dan CASE_EVENTS.
 *   2. Lapis rule harus BERDIRI SENDIRI. Kalau 41_Gemini.gs tidak ada, mati,
 *      atau FEATURE_GEMINI=FALSE, semua fungsi di file ini tetap jalan penuh.
 *   3. Dealer tidak pernah melihat pesan error Gemini. Kegagalan lapis 2
 *      diturunkan diam-diam jadi source:'RULE'.
 *
 * Bentuk response (docs/02-api-contract.md §"Advisory", REVISI Fase 7):
 *   { source, priorityAdvice, recommendedEvidence[], missingInformation[],
 *     likelyDirection, confidence, flags[], generatedAt, cached }
 */
var Advisory_ = (function () {

  // ── Konstanta ──────────────────────────────────────────────────────────────

  /**
   * Kata kunci keselamatan (07-ai-advisory.md §3). Dicocokkan dengan BATAS KATA,
   * bukan substring — tanpa itu "rem" ikut cocok di "kerem", "trem", "premium",
   * dan hampir semua case jadi disarankan Urgent sampai saran ini diabaikan orang.
   */
  const SAFETY_PATTERNS = [
    { re: /\b(rem|pengereman|blong)\b/i,            label: 'sistem pengereman' },
    { re: /\b(kemudi|setir|steering)\b/i,           label: 'sistem kemudi' },
    { re: /\b(airbag|srs)\b/i,                      label: 'sistem airbag/SRS' },
    { re: /\b(terbakar|kebakaran|api)\b/i,          label: 'indikasi kebakaran' },
    { re: /\b(asap|berasap)\b/i,                    label: 'asap' },
    { re: /\b(hilang tenaga|kehilangan tenaga|mati mendadak|mogok saat jalan)\b/i,
      label: 'kehilangan tenaga saat berjalan' },
    { re: /\b(oleng|limbung|tidak terkendali)\b/i,  label: 'kestabilan kendaraan' }
  ];

  /** Berapa hari kerja kendaraan tertahan sebelum priority disarankan ditinjau. */
  const WORKSHOP_REVIEW_WORKING_DAYS = 5;

  /** Jendela deteksi case berulang untuk VIN yang sama (hari kalender). */
  const RECURRING_WINDOW_DAYS = 90;

  /** Ambang §20 01-schema.md: >=60% evidence rekomendasi terunggah -> 10 poin. */
  const COVERAGE_THRESHOLD = 0.6;

  /** Batas advisory.get dengan force=true (03-rbac.md §6). */
  const FORCE_LIMIT_PER_CASE_PER_DAY = 5;

  const PRIORITIES = ['Normal', 'Urgent', 'Critical'];

  // ── Util lokal ─────────────────────────────────────────────────────────────

  function s(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }
  function n(v) { const x = Number(v); return isNaN(x) ? 0 : x; }
  function isTrue(v) { return String(v).toUpperCase() === 'TRUE'; }

  function sha256B64(str) {
    return Utilities.base64Encode(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8)
    );
  }

  /** DTC "P0087,B1234" -> ['P0087','B1234']. Toleran terhadap koma/spasi/titik koma. */
  function dtcList(raw) {
    return s(raw).toUpperCase().split(/[,;\s]+/).filter(function (x) {
      return x && x !== '-' && x !== 'NODTC' && x !== 'NONE';
    });
  }

  /** Dealer menyatakan eksplisit tidak ada DTC. Bukan sama dengan "belum diisi". */
  function declaredNoDtc(raw) {
    return /^(-|no dtc|tidak ada dtc|nihil|none)$/i.test(s(raw));
  }

  // ── Lapis 1a: rekomendasi bukti (07-ai-advisory.md §3) ─────────────────────

  /** Baris EVIDENCE_RULES aktif. Sheet ini di-cache 6 jam oleh TC (CACHEABLE). */
  function activeRules() {
    try {
      return TC.readAll(TC.S.RULES).filter(function (r) { return isTrue(r.Active); });
    } catch (e) {
      // Sheet belum ada / gagal dibaca: advisory tanpa rekomendasi bukti masih
      // berguna (saran priority tetap jalan). Jangan matikan seluruh endpoint.
      console.error('Advisory_.activeRules: ' + e);
      return [];
    }
  }

  /** Apakah satu baris rule cocok dengan case ini? */
  function ruleMatches(rule, c, d) {
    const type = s(rule.Match_Type);
    const val = s(rule.Match_Value);
    if (!val) return false;

    // Applies_To_Priority kosong = berlaku untuk semua priority.
    const applies = s(rule.Applies_To_Priority);
    if (applies && applies.split(',').map(function (x) { return x.trim(); })
        .indexOf(s(c.Priority) || 'Normal') === -1) return false;

    if (type === 'Symptom_Category') {
      return s(c.Symptom_Category) === val;
    }
    if (type === 'DTC_Prefix') {
      const up = val.toUpperCase();
      return dtcList(d.DTC_Codes).some(function (code) { return code.indexOf(up) === 0; });
    }
    if (type === 'Control_Unit') {
      return s(d.Control_Unit).toUpperCase().indexOf(val.toUpperCase()) !== -1;
    }
    if (type === 'Keyword') {
      const hay = (s(c.Complaint_Desc) + ' ' + s(d.Initial_Diag) + ' ' +
                   s(d.Dealer_Analysis) + ' ' + s(d.Workshop_Findings)).toLowerCase();
      return hay.indexOf(val.toLowerCase()) !== -1;
    }
    return false;   // Match_Type tidak dikenal -> abaikan, jangan lempar error
  }

  /**
   * Rekomendasi bukti + penanda mana yang sudah diunggah.
   * PURE terhadap sheet CASES: hanya membaca EVIDENCE_RULES (cached).
   * Karena itu aman dipanggil dari qualityScore() saat case BELUM ada di sheet.
   *
   * @param {Object} c   baris CASES_MASTER (atau rec yang belum ditulis)
   * @param {Object} d   baris CASE_DIAGNOSTICS
   * @param {Array}  atts baris CASE_ATTACHMENTS yang belum dihapus
   */
  function evidence(c, d, atts) {
    c = c || {}; d = d || {}; atts = atts || [];

    const uploaded = {};
    atts.forEach(function (a) {
      if (!isTrue(a.Deleted)) uploaded[s(a.Evidence_Type)] = true;
    });

    const seen = {};
    const out = [];
    activeRules().forEach(function (rule) {
      if (!ruleMatches(rule, c, d)) return;
      // Dedupe: dua rule berbeda boleh merekomendasikan bukti yang sama
      // (mis. Quick_Test dari Symptom_Category dan dari DTC_Prefix).
      const key = s(rule.Evidence_Type) + '|' + s(rule.Label);
      if (seen[key]) return;
      seen[key] = true;
      out.push({
        ruleId: s(rule.Rule_ID),
        evidenceType: s(rule.Evidence_Type),
        label: s(rule.Label),
        priority: n(rule.Priority) || 99,
        mandatory: isTrue(rule.Mandatory),
        alreadyUploaded: !!uploaded[s(rule.Evidence_Type)]
      });
    });

    out.sort(function (a, b) {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.label < b.label ? -1 : 1;
    });
    return out;
  }

  /**
   * Rasio evidence rekomendasi yang sudah terunggah, untuk 10 poin terakhir
   * Quality_Score (01-schema.md §20) yang sengaja ditunda sampai Fase 7.
   *
   * CATATAN PENTING: kalau TIDAK ADA rule yang cocok, kriteria ini tidak dapat
   * diterapkan dan mengembalikan 1 (poin penuh). Menghukum dealer karena baris
   * EVIDENCE_RULES belum diisi untuk kategorinya jelas tidak adil. Konsekuensinya:
   * selama EVIDENCE_RULES baru berisi Software & Electrical, tujuh kategori
   * symptom lain otomatis mendapat 10 poin ini. Isi rule-nya untuk memperbaiki.
   */
  function coverage(c, d, atts) {
    const items = evidence(c, d, atts);
    if (!items.length) return 1;
    let done = 0;
    items.forEach(function (i) { if (i.alreadyUploaded) done++; });
    return done / items.length;
  }

  /** Dipanggil 20_CaseService.gs qualityScore(). Mengembalikan 0 atau 10. */
  function coveragePoints(c, d, atts) {
    return (coverage(c, d, atts) >= COVERAGE_THRESHOLD) ? 10 : 0;
  }

  // ── Lapis 1b: saran priority (07-ai-advisory.md §3) ────────────────────────

  /** Selisih hari kerja dari sebuah ISO sampai sekarang. -1 kalau tidak terhitung. */
  function workingDaysSince(iso) {
    if (!s(iso)) return -1;
    try {
      if (typeof Sla_ === 'undefined' || typeof workingMinutesBetween_ !== 'function') return -1;
      const mins = workingMinutesBetween_(iso, TC.nowIso(), Sla_.holidays(), Sla_.cfg());
      return mins / 540;   // 1 hari kerja = 9 jam = 540 menit (05-sla-engine.md §1)
    } catch (e) {
      console.error('Advisory_.workingDaysSince: ' + e);
      return -1;
    }
  }

  /** Case lain dengan VIN sama dalam RECURRING_WINDOW_DAYS hari. */
  function recurringVin(c) {
    const vin = s(c.VIN).toUpperCase();
    if (vin.length !== 17) return [];
    const cutoff = Date.now() - RECURRING_WINDOW_DAYS * 86400000;
    try {
      return TC.filter(TC.S.CASES, function (r) {
        if (s(r.VIN).toUpperCase() !== vin) return false;
        if (s(r.Case_No) === s(c.Case_No)) return false;
        const t = TC.parseIso(r.Created_At);
        return t && t.getTime() >= cutoff;
      }).map(function (r) {
        return { caseNo: r.Case_No, status: r.Status, createdAt: r.Created_At };
      });
    } catch (e) {
      console.error('Advisory_.recurringVin: ' + e);
      return [];
    }
  }

  function higher(a, b) {
    return PRIORITIES.indexOf(a) >= PRIORITIES.indexOf(b) ? a : b;
  }

  /**
   * Saran priority. TIDAK mengubah apapun — hanya mengembalikan usulan.
   * @return {{dealerPriority, suggested, reason, flags}}
   *         suggested = 'No_Change' berarti priority dealer sudah masuk akal.
   */
  function priorityAdvice(c, d) {
    const dealer = s(c.Priority) || 'Normal';
    const status = s(c.Vehicle_Status);
    const freq = s(c.Frequency);
    const reasons = [];
    const flags = [];
    let target = 'Normal';

    // Aturan 3: Frequency=Always + Not_Drivable -> Critical. Dicek DULU karena
    // paling spesifik; aturan 1 di bawah cuma akan menaikkan ke Urgent.
    if (freq === 'Always' && status === 'Not_Drivable') {
      target = higher(target, 'Critical');
      reasons.push('gejala selalu muncul dan kendaraan tidak dapat dikendarai');
    } else if (status === 'Not_Drivable') {
      // Aturan 1
      target = higher(target, 'Urgent');
      reasons.push('kendaraan tidak dapat dikendarai');
    }

    // Aturan 2: kata kunci keselamatan.
    const hay = s(c.Complaint_Desc) + ' ' + s(d.Initial_Diag);
    const hits = [];
    SAFETY_PATTERNS.forEach(function (p) { if (p.re.test(hay)) hits.push(p.label); });
    if (hits.length) {
      target = higher(target, status === 'Not_Drivable' ? 'Critical' : 'Urgent');
      reasons.push('keluhan menyinggung ' + hits.join(' dan '));
      flags.push({ type: 'SAFETY_KEYWORD', detail: hits });
    }

    // Aturan 4: kendaraan tertahan lama. Tidak menaikkan target, hanya minta tinjau.
    const held = (status === 'In_Workshop' || status === 'Not_Drivable')
      ? workingDaysSince(c.Created_At) : -1;
    if (held > WORKSHOP_REVIEW_WORKING_DAYS) {
      flags.push({ type: 'LONG_IN_WORKSHOP', detail: Math.floor(held) + ' hari kerja' });
      reasons.push('kendaraan sudah ' + Math.floor(held) + ' hari kerja tertahan di bengkel');
    }

    // Aturan 5: case berulang pada VIN yang sama.
    const prev = recurringVin(c);
    if (prev.length) {
      flags.push({
        type: 'RECURRING_VIN',
        detail: prev.length + ' case dalam ' + RECURRING_WINDOW_DAYS + ' hari',
        cases: prev.map(function (x) { return x.caseNo; })
      });
    }

    // Saran hanya diberikan kalau MENAIKKAN priority. Sistem tidak pernah
    // menyarankan penurunan — dealer yang paling tahu kondisi lapangan, dan
    // saran menurunkan priority hanya akan dibaca sebagai sistem meremehkan.
    const suggested = (PRIORITIES.indexOf(target) > PRIORITIES.indexOf(dealer))
      ? target : 'No_Change';

    let reason = '';
    if (suggested !== 'No_Change') {
      reason = 'Berdasarkan ' + reasons.join(', ') + ', case ini berpotensi membutuhkan '
             + 'penanganan ' + suggested + '. Silakan tinjau kembali priority case.';
    } else if (held > WORKSHOP_REVIEW_WORKING_DAYS) {
      reason = 'Priority yang dipilih sudah sesuai, namun kendaraan sudah lama '
             + 'tertahan di bengkel. Silakan tinjau kembali prioritas penanganan.';
    } else {
      reason = 'Priority yang dipilih sudah sesuai dengan kondisi kendaraan dan keluhan.';
    }

    return { dealerPriority: dealer, suggested: suggested, reason: reason, flags: flags };
  }

  // ── Lapis 1c: informasi yang belum lengkap ─────────────────────────────────

  function missingInformation(c, d) {
    const out = [];
    if (!s(c.Vehicle_Status))    out.push('Kondisi kendaraan (drivable / tidak) belum diisi.');
    if (!s(c.Frequency))         out.push('Frekuensi munculnya gejala belum diisi.');
    if (!s(c.Driving_Condition)) out.push('Kondisi saat gejala muncul belum diisi.');
    if (!s(c.Prod_Year))         out.push('Tahun produksi belum diisi.');
    if (!s(d.Initial_Diag))      out.push('Hasil diagnosis awal belum diisi.');
    if (s(d.Initial_Diag) && s(d.Initial_Diag).length < 50) {
      out.push('Diagnosis awal masih terlalu singkat untuk bisa ditindaklanjuti.');
    }
    if (!s(d.Dealer_Analysis))   out.push('Analisis dealer belum diisi.');
    if (!s(d.DTC_Codes)) {
      out.push('Kode DTC belum diisi. Kalau memang tidak ada DTC, tulis "-" supaya jelas.');
    }
    if (!s(d.Control_Unit) && dtcList(d.DTC_Codes).length) {
      out.push('Control unit sumber DTC belum disebutkan.');
    }
    if (!s(d.Xentry_Version) && s(c.Symptom_Category) === 'Software') {
      out.push('Versi Xentry belum diisi, padahal kategorinya Software.');
    }
    return out;
  }

  // ── Perakitan hasil lapis 1 ────────────────────────────────────────────────

  /**
   * Advisory murni rule. Tidak menyentuh Gemini, tidak menulis sheet apapun.
   * Inilah nilai balik saat Gemini mati, dimatikan, atau belum pernah dipanggil.
   */
  function ruleAdvisory(c, d, atts) {
    const pa = priorityAdvice(c, d);
    return {
      source: 'RULE',
      priorityAdvice: { dealerPriority: pa.dealerPriority, suggested: pa.suggested, reason: pa.reason },
      recommendedEvidence: evidence(c, d, atts),
      missingInformation: missingInformation(c, d),
      likelyDirection: '',        // hanya diisi lapis Gemini
      confidence: 'low',          // rule engine tidak pernah mengklaim lebih
      flags: pa.flags,
      generatedAt: TC.nowIso(),
      cached: false
    };
  }

  /**
   * Sidik jari input yang dikirim ke Gemini. Dipakai dua hal:
   *   a. cache — hash sama berarti tidak perlu panggil ulang;
   *   b. deteksi basi — hasil Gemini lama tidak ditampilkan kalau case sudah berubah.
   * Hanya field yang MEMPENGARUHI jawaban yang ikut; timestamp sengaja tidak.
   */
  function inputHash(c, d, model) {
    return sha256B64(JSON.stringify([
      s(c.Model), s(c.Prod_Year), s(c.Mileage), s(c.Complaint_Desc),
      s(c.Symptom_Category), s(c.Frequency), s(c.Vehicle_Status), s(c.Driving_Condition),
      s(d.DTC_Codes), s(d.Control_Unit), s(d.Initial_Diag), s(d.Dealer_Analysis),
      s(d.Suspected_Root_Cause), s(d.Workshop_Findings), s(model)
    ]));
  }

  // ── AI_ADVISORY_LOG ────────────────────────────────────────────────────────

  function writeLog(rec) {
    try {
      TC.append(TC.S.AI_LOG, {
        Advisory_ID: 'AD-' + Utilities.getUuid().replace(/-/g, '').slice(0, 12),
        Case_No: s(rec.caseNo),
        Trigger: s(rec.trigger),
        Source: s(rec.source),
        Model: s(rec.model),
        Input_Hash: s(rec.inputHash),
        Response_JSON: rec.response ? JSON.stringify(rec.response) : '',
        Latency_Ms: n(rec.latencyMs),
        Error: s(rec.error),
        Created_At: TC.nowIso(),
        Acknowledged_By: ''
      });
    } catch (e) {
      // Gagal mencatat log TIDAK BOLEH menggagalkan advisory ke user.
      console.error('Advisory_.writeLog: ' + e);
    }
  }

  /** Hasil Gemini terakhir untuk case ini yang hash-nya masih cocok. */
  function cachedGemini(caseNo, hash) {
    try {
      const rows = TC.filter(TC.S.AI_LOG, function (r) {
        return r.Case_No === caseNo && r.Source === 'GEMINI' &&
               r.Input_Hash === hash && !s(r.Error) && s(r.Response_JSON);
      });
      if (!rows.length) return null;
      rows.sort(function (a, b) { return a.Created_At < b.Created_At ? 1 : -1; });
      return { json: JSON.parse(rows[0].Response_JSON), at: rows[0].Created_At };
    } catch (e) {
      console.error('Advisory_.cachedGemini: ' + e);
      return null;
    }
  }

  /** Gabungkan jawaban Gemini DI ATAS hasil rule. Rule tetap jadi lantai dasar. */
  function mergeGemini(base, g) {
    const out = {};
    for (const k in base) out[k] = base[k];
    out.source = 'GEMINI';

    if (g.priorityAdvice && s(g.priorityAdvice.suggested)) {
      const sug = s(g.priorityAdvice.suggested);
      // Rule engine menang kalau ia menyarankan LEBIH tinggi. Gemini tidak boleh
      // menurunkan kesimpulan deterministik yang sudah bisa dijelaskan ke dealer.
      const ruleSug = base.priorityAdvice.suggested;
      const ruleWins = ruleSug !== 'No_Change' &&
        (sug === 'No_Change' || PRIORITIES.indexOf(ruleSug) > PRIORITIES.indexOf(sug));
      if (!ruleWins) {
        out.priorityAdvice = {
          dealerPriority: base.priorityAdvice.dealerPriority,
          suggested: sug,
          reason: s(g.priorityAdvice.reason) || base.priorityAdvice.reason
        };
      }
    }

    // Evidence tambahan dari Gemini ditempel di BAWAH daftar rule, ditandai
    // sumbernya, dan tidak pernah mandatory (07-ai-advisory.md §1).
    if (Array.isArray(g.recommendedEvidence)) {
      const seen = {};
      base.recommendedEvidence.forEach(function (i) { seen[i.evidenceType + '|' + i.label] = true; });
      g.recommendedEvidence.forEach(function (i) {
        const et = s(i.evidenceType), lb = s(i.label);
        if (!et && !lb) return;
        if (seen[et + '|' + lb]) return;
        seen[et + '|' + lb] = true;
        out.recommendedEvidence.push({
          ruleId: '', evidenceType: et, label: lb || et,
          priority: 90, mandatory: false, alreadyUploaded: false,
          why: s(i.why), fromAi: true
        });
      });
    }

    if (Array.isArray(g.missingInformation)) {
      g.missingInformation.forEach(function (m) {
        if (s(m) && out.missingInformation.indexOf(s(m)) === -1) out.missingInformation.push(s(m));
      });
    }
    if (s(g.likelyDirection)) out.likelyDirection = s(g.likelyDirection);
    if (['low', 'medium', 'high'].indexOf(s(g.confidence)) !== -1) out.confidence = s(g.confidence);
    return out;
  }

  // ── Pemuat data case ───────────────────────────────────────────────────────

  function loadCase(ctx, caseNo) {
    // Tambahin baris preload di sini
    TC.preload([TC.S.CASES, TC.S.DIAG, TC.S.ATTACH, TC.S.RULES, TC.S.AI_LOG]);

    const c = TC.find(TC.S.CASES, 'Case_No', caseNo);
    if (!c) throw new AppError(ERROR_CODES.NOT_FOUND, 'Case ' + caseNo + ' tidak ditemukan.');
    assertCanAccessCase_(ctx, c);
    const d = (typeof Diag_ !== 'undefined')
      ? Diag_.forCase(caseNo)
      : (TC.find(TC.S.DIAG, 'Case_No', caseNo) || {});
    const atts = TC.filter(TC.S.ATTACH, function (r) {
      return r.Case_No === caseNo && !isTrue(r.Deleted);
    });
    return { c: c, d: d, atts: atts };
  }

  // ── Jalur pemanggilan Gemini ───────────────────────────────────────────────

  /**
   * Lapis 2. SELALU mengembalikan objek advisory yang valid — tidak pernah
   * melempar. Kegagalan apapun diturunkan diam-diam ke hasil rule.
   */
  function enrich(caseNo, base, c, d, trigger, allowCall) {
    const model = s(Config_.get('GEMINI_MODEL', ''));
    const enabled = String(Config_.get('FEATURE_GEMINI', 'FALSE')).toUpperCase() === 'TRUE';
    if (!enabled || !model || typeof Gemini_ === 'undefined') return base;

    const hash = inputHash(c, d, model);

    // 1. Cache dulu — gratis dan instan (07-ai-advisory.md §4 "Hemat kuota").
    const hit = cachedGemini(caseNo, hash);
    if (hit) {
      const merged = mergeGemini(base, hit.json);
      merged.cached = true;
      merged.generatedAt = hit.at;
      return merged;
    }
    if (!allowCall) return base;   // case.get tidak pernah membakar kuota

    // 2. Panggil.
    const started = Date.now();
    let res;
    try {
      res = Gemini_.advise(c, d);
    } catch (e) {
      console.error('Advisory_.enrich: ' + e);
      res = { ok: false, error: String(e) };
    }
    const latency = Date.now() - started;

    if (!res || !res.ok) {
      writeLog({ caseNo: caseNo, trigger: trigger, source: 'GEMINI', model: model,
                 inputHash: hash, latencyMs: latency, error: (res && res.error) || 'unknown' });
      return base;   // fallback DIAM — dealer tidak diberi tahu apa-apa
    }

    writeLog({ caseNo: caseNo, trigger: trigger, source: 'GEMINI', model: model,
               inputHash: hash, response: res.data, latencyMs: latency });
    return mergeGemini(base, res.data);
  }

  // ── API publik ─────────────────────────────────────────────────────────────

  /**
   * Dipakai 20_CaseService.gs get(). TIDAK memanggil Gemini dan TIDAK menulis
   * log — halaman detail case dibuka berkali-kali, dan setiap pembukaan tidak
   * boleh membakar kuota atau menambah baris log (07-ai-advisory.md §4 no.2).
   * Hasil Gemini lama tetap ditampilkan kalau hash-nya masih cocok.
   */
  function forCase(ctx, c, d, atts) {
    try {
      const base = ruleAdvisory(c, d, atts);
      return enrich(s(c.Case_No), base, c, d, 'Manual', false);
    } catch (e) {
      console.error('Advisory_.forCase: ' + e);
      return null;   // advisory gagal TIDAK boleh menggagalkan case.get
    }
  }

  /**
   * Dipakai 20_CaseService.gs create(). Rule engine saja — instan, gratis,
   * deterministik. Gemini sengaja TIDAK dipanggil di sini supaya tombol
   * "Simpan case" tidak menggantung 3–8 detik.
   */
  function onCreate(ctx, c, d) {
    try {
      const base = ruleAdvisory(c, d, []);
      writeLog({ caseNo: s(c.Case_No), trigger: 'On_Create', source: 'RULE',
                 model: '', inputHash: '', response: base, latencyMs: 0 });
      return base;
    } catch (e) {
      console.error('Advisory_.onCreate: ' + e);
      return null;
    }
  }

  /**
   * Dipanggil saat case benar-benar dikirim ke IIDI (Created -> Open).
   * Inilah satu-satunya titik Gemini dipanggil otomatis (07-ai-advisory.md §4).
   * Tidak pernah melempar — transisi status tidak boleh gagal karena AI.
   */
  function onSubmit(ctx, caseNo) {
    try {
      const L = loadCase(ctx, caseNo);
      const base = ruleAdvisory(L.c, L.d, L.atts);
      return enrich(caseNo, base, L.c, L.d, 'On_Request_Support', true);
    } catch (e) {
      console.error('Advisory_.onSubmit: ' + e);
      return null;
    }
  }

  /** Route 'advisory.get' — { caseNo, force } */
  function get(ctx, p) {
    const caseNo = s(p.caseNo);
    if (!caseNo) {
      throw new AppError(ERROR_CODES.VALIDATION, 'caseNo wajib diisi.', { caseNo: 'Wajib diisi.' });
    }
    const L = loadCase(ctx, caseNo);
    const base = ruleAdvisory(L.c, L.d, L.atts);

    if (!p.force) return enrich(caseNo, base, L.c, L.d, 'Manual', false);

    // force=true: maks 5x per case per hari (03-rbac.md §6).
    const cache = CacheService.getScriptCache();
    const key = 'advforce_' + caseNo + '_' + TC.nowIso().slice(0, 10);
    const used = n(cache.get(key));
    if (used >= FORCE_LIMIT_PER_CASE_PER_DAY) {
      throw new AppError(ERROR_CODES.RATE_LIMIT,
        'Saran ulang untuk case ini sudah mencapai batas ' +
        FORCE_LIMIT_PER_CASE_PER_DAY + ' kali hari ini. Coba lagi besok.');
    }
    cache.put(key, String(used + 1), 86400);
    return enrich(caseNo, base, L.c, L.d, 'Manual', true);
  }

  /**
   * Route 'advisory.acknowledge' — mencatat pilihan dealer pada dialog
   * self-diagnosis dan pada panel saran (07-ai-advisory.md §3).
   * Ini SATU-SATUNYA jejak bahwa dealer sadar diberi saran lalu memilih apa.
   * Tidak mengubah field case manapun.
   *
   * payload: { caseNo, decision, context, note }
   *   decision: 'PROCEED' | 'CONTINUE_SELF_DIAG' | 'APPLIED' | 'DISMISSED'
   */
  const DECISIONS = ['PROCEED', 'CONTINUE_SELF_DIAG', 'APPLIED', 'DISMISSED'];
  function acknowledge(ctx, p) {
    const caseNo = s(p.caseNo);
    const decision = s(p.decision).toUpperCase();
    if (!caseNo) {
      throw new AppError(ERROR_CODES.VALIDATION, 'caseNo wajib diisi.', { caseNo: 'Wajib diisi.' });
    }
    if (DECISIONS.indexOf(decision) === -1) {
      throw new AppError(ERROR_CODES.VALIDATION, 'Pilihan tidak dikenal.',
        { decision: 'Nilai tidak dikenal.' });
    }
    const c = TC.find(TC.S.CASES, 'Case_No', caseNo);
    if (!c) throw new AppError(ERROR_CODES.NOT_FOUND, 'Case ' + caseNo + ' tidak ditemukan.');
    assertCanAccessCase_(ctx, c);

    Case_.event(ctx, caseNo, 'Advisory_Acknowledged', '', decision, s(p.note),
                { context: s(p.context) });
    return { ok: true };
  }

  return {
    // dipakai service lain
    onCreate: onCreate,
    onSubmit: onSubmit,
    forCase: forCase,
    coveragePoints: coveragePoints,
    // route
    get: get,
    acknowledge: acknowledge,
    // dibuka untuk 99_Tests.gs
    ruleAdvisory: ruleAdvisory,
    evidence: evidence,
    coverage: coverage,
    priorityAdvice: priorityAdvice,
    missingInformation: missingInformation,
    inputHash: inputHash
  };
})();