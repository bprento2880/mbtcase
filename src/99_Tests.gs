/** Jalankan dari editor GAS. Membuat fixture sementara lalu menghapusnya. */
function runAuthTests() {
  const out = [];
  function t(name, fn) {
    try { fn(); out.push('PASS  ' + name); }
    catch (e) { out.push('FAIL  ' + name + ' → ' + (e.message || e)); }
  }
  function expect(cond, msg) { if (!cond) throw new Error(msg || 'kondisi tidak terpenuhi'); }
  function expectErr(code, fn) {
    try { fn(); }
    catch (e) {
      if (e.code === code) return;
      // Tampilkan pesan & stack aslinya -- 'kode=undefined' biasanya berarti
      // yang terlempar TypeError dari kode kita, bukan AppError.
      throw new Error('kode=' + e.code + ' (harusnya ' + code + ') | ' +
                      (e.message || e) + ' | ' + String(e.stack || '').split('\n').slice(0, 3).join(' <- '));
    }
    throw new Error('tidak melempar ' + code);
  }

  const fx = _mkFixtures();
  try {
    t('hashPin_ deterministik', function () {
      const s = 'AAAAAAAAAAAAAAAAAAAAAA==';
      expect(hashPin_('481336', s) === hashPin_('481336', s));
      expect(hashPin_('481336', s) !== hashPin_('481337', s));
    });

    // CATATAN: durasi hashPin_ TIDAK diukur di sini. Test lain sudah memanggil
    // hashPin_ belasan kali sebelum baris ini, dan GAS men-throttle
    // Utilities.computeDigest yang dipanggil beruntun -- hasilnya 3-4x lebih
    // lambat dari kondisi nyata (terukur 2,9 detik sendirian vs 11,9 detik
    // di tengah rentetan test). Ukur pakai benchmarkLogin() yang berdiri sendiri.
    t('hashPin_ menghasilkan panjang hash konsisten', function () {
      const h = hashPin_('123457', 'AAAAAAAAAAAAAAAAAAAAAA==');
      expect(typeof h === 'string' && h.length === 44, 'panjang hash = ' + h.length);
    });

    t('hash v1 lama tetap bisa diverifikasi', function () {
      const s = 'AAAAAAAAAAAAAAAAAAAAAA==';
      const h1 = hashPin_('481336', s, 1);
      expect(Session_.safeEqual(hashPin_('481336', s, 1), h1), 'v1 tidak reproducible');
      expect(!Session_.safeEqual(hashPin_('481336', s, 2), h1), 'v1 dan v2 harusnya beda');
    });

    t('PIN policy menolak pola lemah', function () {
      ['111111', '123456', '654321', '000000', '12345', 'abcdef']
        .forEach(function (p) { expectErr('VALIDATION', function () { validatePinFormat_(p); }); });
      expect(validatePinFormat_('481336') === '481336');
    });

    t('login sukses + token valid', function () {
      const r = Auth_.login({ user: null }, { email: fx.a.email, pin: fx.pin });
      expect(r.token && r.user.userId === fx.a.userId);
      const ctx = Session_.validate(r.token);
      expect(ctx.user.dealerId === fx.a.dealerId);
      fx.tokenA = r.token;
    });

    t('token dirusak → UNAUTHENTICATED', function () {
      expectErr('UNAUTHENTICATED', function () { Session_.validate(fx.tokenA + 'x'); });
    });

    t('email tidak ada & PIN salah = pesan identik', function () {
      let m1 = '', m2 = '';
      try { Auth_.login({ user: null }, { email: 'nope-' + fx.rnd + '@x.id', pin: fx.pin }); }
      catch (e) { m1 = e.message; }
      try { Auth_.login({ user: null }, { email: fx.a.email, pin: '999111' }); }
      catch (e) { m2 = e.message; }
      expect(m1 === m2 && m1 === 'Email atau PIN salah.', 'm1=' + m1 + ' m2=' + m2);
    });

    t('lockout setelah MAX_FAILED_ATTEMPTS', function () {
      const max = TC.cfgNum('MAX_FAILED_ATTEMPTS', 5);
      for (let i = 0; i < max; i++) {
        try { Auth_.login({ user: null }, { email: fx.b.email, pin: '999111' }); } catch (e) {}
      }
      expectErr('LOCKED', function () {
        Auth_.login({ user: null }, { email: fx.b.email, pin: fx.pin });
      });
      const locked = TC.filter(TC.S.AUDIT, function (r) {
        return r.Action === 'ACCOUNT_LOCKED' && r.User_ID === fx.b.userId;
      });
      expect(locked.length > 0, 'ACCOUNT_LOCKED tidak tercatat di AUDIT_LOG');
    });

    // ── ACCEPTANCE UTAMA FASE 1 ──────────────────────────────
    t('ACCEPTANCE: dealer A tidak bisa akses case dealer B', function () {
      const ctxA = Session_.validate(fx.tokenA);
      const before = TC.filter(TC.S.AUDIT, function (r) { return r.Action === 'ACCESS_DENIED'; }).length;
      expectErr('FORBIDDEN', function () {
        assertCanAccessCase_(ctxA, { Case_No: fx.caseB, Dealer_ID: fx.b.dealerId });
      });
      TC.invalidate(TC.S.AUDIT);
      const after = TC.filter(TC.S.AUDIT, function (r) { return r.Action === 'ACCESS_DENIED'; }).length;
      expect(after > before, 'ACCESS_DENIED tidak tercatat di AUDIT_LOG');
      // case dealer sendiri tetap boleh
      assertCanAccessCase_(ctxA, { Case_No: 'CN-TEST', Dealer_ID: fx.a.dealerId });
    });

    t('requirePerm_ menolak aksi di luar role', function () {
      const ctxA = Session_.validate(fx.tokenA);
      requirePerm_(ctxA, 'case.create');
      expectErr('FORBIDDEN', function () { requirePerm_(ctxA, 'dashboard.distributor'); });
      expectErr('FORBIDDEN', function () { requirePerm_(ctxA, 'escalation.create'); });
    });

    // Guard ini TIDAK teruji lewat doPost: lookup ROUTES melempar NOT_FOUND
    // lebih dulu untuk action yang belum terdaftar. Jadi diuji langsung di sini.
    t('guard Must_Change_PIN memblokir action non-auth', function () {
      const u = TC.find(TC.S.USERS, 'User_ID', fx.a.userId);
      TC.update(TC.S.USERS, u._row, { Must_Change_PIN: 'TRUE' });
      // Session_.validate men-cache ctx 60 detik -- buang dulu, kalau tidak
      // yang terbaca masih mustChangePin=false dari test sebelumnya.
      CacheService.getScriptCache().remove('sess_' + Session_.sha256b64(fx.tokenA));

      const ctx = Session_.validate(fx.tokenA);
      expect(ctx.user.mustChangePin === true, 'mustChangePin tidak terbaca dari sheet');

      // Action auth.* tetap boleh, kalau tidak user terkunci total.
      Guard_.assertPinChanged(ctx, 'auth.changePin');
      Guard_.assertPinChanged(ctx, 'auth.me');
      Guard_.assertPinChanged(ctx, 'auth.logout');
      // Selain itu harus ditolak.
      expectErr('FORBIDDEN', function () { Guard_.assertPinChanged(ctx, 'case.create'); });
      expectErr('FORBIDDEN', function () { Guard_.assertPinChanged(ctx, 'dashboard.get'); });

      TC.update(TC.S.USERS, u._row, { Must_Change_PIN: 'FALSE' });
      CacheService.getScriptCache().remove('sess_' + Session_.sha256b64(fx.tokenA));
    });

    t('logout mencabut sesi', function () {
      Auth_.logout(null, {}, fx.tokenA);
      expectErr('UNAUTHENTICATED', function () { Session_.validate(fx.tokenA); });
    });

  } finally {
    _rmFixtures(fx);
  }
  console.log(out.join('\n'));
  return out;
}

function _mkFixtures() {
  const rnd = Utilities.getUuid().slice(0, 6);
  const pin = '481336';
  const dealers = TC.readAll(TC.S.DEALERS);
  const dA = dealers[0], dB = dealers[1];
  function mk(sfx, dealer) {
    const salt = newSalt_();
    const u = {
      User_ID: 'UTEST-' + rnd + '-' + sfx, Full_Name: 'Test ' + sfx, Role: 'CDT',
      Dealer_ID: dealer.Dealer_ID, Dealer_Name: dealer.Dealer_Name,
      Email: 'test-' + rnd + '-' + sfx + '@example.test', Phone_WA: '',
      PIN_Hash: hashPin_(pin, salt), PIN_Salt: salt, PIN_Version: String(PIN_HASH_VERSION),
      Status: 'ACTIVE', Must_Change_PIN: 'FALSE', Failed_Attempts: '0',
      Locked_Until: '', Notif_Level: 'All', Created_At: TC.nowIso(),
      Updated_At: TC.nowIso(), Last_Login_At: ''
    };
    TC.append(TC.S.USERS, u);
    return { userId: u.User_ID, email: u.Email, dealerId: u.Dealer_ID };
  }
  return { rnd: rnd, pin: pin, a: mk('A', dA), b: mk('B', dB), caseB: 'CN-FAKE-B' };
}

function _rmFixtures(fx) {
  const sh = SpreadsheetApp.openById(TC.prop('SHEET_ID')).getSheetByName(TC.S.USERS);
  const rows = TC.readAll(TC.S.USERS)
    .filter(function (r) { return r.User_ID.indexOf('UTEST-' + fx.rnd) === 0; })
    .map(function (r) { return r._row; })
    .sort(function (x, y) { return y - x; });
  rows.forEach(function (r) { sh.deleteRow(r); });
  TC.invalidate(TC.S.USERS);
  TC.filter(TC.S.SESSIONS, function (r) { return r.User_ID.indexOf('UTEST-' + fx.rnd) === 0; })
    .forEach(function (r) { TC.update(TC.S.SESSIONS, r._row, { Revoked: 'TRUE' }); });
}
// ── Diagnostik (jalankan manual dari editor GAS, bukan lewat router) ──────

/** Cek semua simbol lintas-file terdefinisi setelah push. */
function checkPrereq() {
  const MISSING = '>>> TIDAK ADA <<<';
  function show(label, val) { console.log(label + ' = ' + (val === undefined ? MISSING : val)); }

  show('APP_VERSION        ', typeof APP_VERSION !== 'undefined' ? APP_VERSION : undefined);
  show('PIN_HASH_VERSION   ', typeof PIN_HASH_VERSION !== 'undefined' ? PIN_HASH_VERSION : undefined);
  show('iterasi v aktif    ', typeof pinIterations_ === 'function' ? pinIterations_(PIN_HASH_VERSION) : undefined);
  show('pinIterations_     ', typeof pinIterations_);
  show('ERROR_CODES.INTERNL', typeof ERROR_CODES !== 'undefined' ? ERROR_CODES.INTERNAL : undefined);
  show('AppError           ', typeof AppError);
  show('TC                 ', typeof TC);
  show('Session_           ', typeof Session_);
  show('Auth_              ', typeof Auth_);
  show('Guard_             ', typeof Guard_);
  show('PERMISSIONS.CDT    ', (typeof PERMISSIONS !== 'undefined' && PERMISSIONS.CDT) ? 'ok' : undefined);
  show('hashPin_           ', typeof hashPin_);
  show('generateSalt_      ', typeof generateSalt_);
  show('constantTimeEquals_', typeof constantTimeEquals_);
  show('sysPing_           ', typeof sysPing_);
  console.log('--- sanity TC.nowIso() = ' + TC.nowIso());
  console.log('--- sanity sys.ping    = ' + JSON.stringify(sysPing_({ user: null }, {})));
}

/** Verifikasi kolom timestamp benar-benar Plain Text (01-schema.md, Konvensi). */
function checkPlainText() {
  const ss = SpreadsheetApp.openById(scriptProp_('SHEET_ID'));
  const targets = [
    [SHEETS.SESSIONS, 'Expires_At'],
    [SHEETS.SESSIONS, 'Last_Seen_At'],
    [SHEETS.AUDIT_LOG, 'Timestamp'],
    [SHEETS.USERS, 'Locked_Until'],
    [SHEETS.USERS, 'Last_Login_At']
  ];
  targets.forEach(function (p) {
    const sh = ss.getSheetByName(p[0]);
    const c = colIndex_(p[0], p[1]) + 1;
    const last = Math.max(sh.getLastRow(), 2);
    const fmt = sh.getRange(last, c).getNumberFormat();
    const val = sh.getRange(last, c).getValue();
    console.log((fmt === '@' ? 'PASS  ' : 'FAIL  ') + p[0] + '.' + p[1] +
                ' baris ' + last + ' format=' + fmt +
                ' tipe=' + (val instanceof Date ? 'Date <-- MASALAH' : typeof val));
  });
}

/**
 * Ukur latensi auth.login end-to-end dalam kondisi bersih.
 * JALANKAN SENDIRIAN, bukan setelah runAuthTests() -- GAS men-throttle
 * computeDigest yang dipanggil beruntun dan hasilnya jadi menyesatkan.
 * Target: < 8000ms (CLAUDE.md §3.7).
 */
function benchmarkLogin() {
  const fx = _mkFixtures();
  try {
    Utilities.sleep(2000);   // beri jeda dari hash pembuatan fixture
    const t0 = Date.now();
    const r = Auth_.login({ user: null }, { email: fx.a.email, pin: fx.pin });
    const ms = Date.now() - t0;
    console.log((ms < 8000 ? 'PASS  ' : 'FAIL  ') + 'auth.login end-to-end = ' + ms +
                'ms (target < 8000ms, CLAUDE.md 3.7)');
    console.log('  iterasi=' + pinIterations_(PIN_HASH_VERSION) + ' v' + PIN_HASH_VERSION);
    Session_.revokeToken(r.token);
  } finally {
    _rmFixtures(fx);
  }
}

/**
 * Bedah latensi auth.login per tahap.
 * JALANKAN SENDIRIAN dan beri jeda >30 detik dari eksekusi lain --
 * GAS men-throttle computeDigest yang dipanggil beruntun.
 */
function profileLogin() {
  const fx = _mkFixtures();
  const marks = [];
  function step(label, fn) {
    const t0 = Date.now();
    const out = fn();
    marks.push([label, Date.now() - t0]);
    return out;
  }

  try {
    Utilities.sleep(3000);   // dinginkan dulu dari hash pembuatan fixture
    CacheService.getScriptCache().removeAll(['sd_DEALERS', 'sd_CONFIG', 'cfg_all']);

    const email = fx.a.email.toLowerCase();

    const u = step('1. baca USERS (cari email)', function () {
      return TC.filter(TC.S.USERS, function (r) {
        return String(r.Email).trim().toLowerCase() === email && r.Status !== 'INACTIVE';
      })[0];
    });

    step('2. rate limit (CacheService)', function () {
      return CacheService.getScriptCache().get('rl_probe');
    });

    step('3. hashPin_ (' + pinIterations_(PIN_HASH_VERSION) + ' iterasi)', function () {
      return hashPin_(fx.pin, u.PIN_Salt, u.PIN_Version);
    });

    step('4. Guard_.areasOf', function () { return Guard_.areasOf(u); });

    step('5. TC.update USERS (3 kolom)', function () {
      return TC.update(TC.S.USERS, u._row, {
        Failed_Attempts: '0', Locked_Until: '', Last_Login_At: TC.nowIso()
      });
    });

    step('6. baca CONFIG (SESSION_TTL)', function () {
      return TC.cfgNum('SESSION_TTL_HOURS', 8);
    });

    const sess = step('7. Session_.create (lock + append)', function () {
      return Session_.create({ userId: u.User_ID, role: u.Role, dealerId: u.Dealer_ID, areas: [] }, 'probe');
    });

    step('8. Audit_.log (append AUDIT_LOG)', function () {
      return Audit_.log({ user: { userId: u.User_ID } }, 'LOGIN_SUCCESS', email, 'OK', 'probe');
    });

    step('9. Session_.validate (cache MISS)', function () {
      CacheService.getScriptCache().remove('sess_' + Session_.sha256b64(sess.token));
      return Session_.validate(sess.token);
    });

    step('10. Session_.validate (cache HIT)', function () {
      return Session_.validate(sess.token);
    });

    let total = 0;
    marks.forEach(function (m) { total += m[1]; });
    console.log('--- Bedah latensi login ---');
    marks.forEach(function (m) {
      const pct = Math.round(m[1] / total * 100);
      console.log(pad_(m[1] + 'ms', 8) + pad_(pct + '%', 5) + m[0]);
    });
    console.log('TOTAL tahap 1-8 (= satu login) = ' +
      (total - marks[8][1] - marks[9][1]) + 'ms');

    console.log('--- Ukuran sheet (penyebab I/O lambat) ---');
     [TC.S.USERS, TC.S.SESSIONS, TC.S.AUDIT, TC.S.DEALERS].forEach(function (n) {
      const sh = SpreadsheetApp.openById(TC.prop('SHEET_ID')).getSheetByName(n);
      console.log(pad_(n, 22) + sh.getLastRow() + ' baris x ' + sh.getLastColumn() + ' kolom');
    });

    Session_.revokeToken(sess.token);
  } finally {
    _rmFixtures(fx);
  }
}

function pad_(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}

/**
 * Ukur auth.changePin end-to-end. Jalankan SENDIRIAN, jeda >60 detik
 * dari eksekusi apapun -- changePin melakukan 2x hash berurutan dan
 * paling rentan terhadap throttling computeDigest di GAS.
 */
function benchmarkChangePin() {
  const fx = _mkFixtures();
  try {
    Utilities.sleep(5000);
    const r = Auth_.login({ user: null }, { email: fx.a.email, pin: fx.pin });
    const ctx = Session_.validate(r.token);

    Utilities.sleep(5000);   // dinginkan sebelum mengukur
    const t0 = Date.now();
    Auth_.changePin(ctx, { oldPin: fx.pin, newPin: '284917' });
    const ms = Date.now() - t0;

    console.log((ms < 8000 ? 'PASS  ' : 'FAIL  ') + 'auth.changePin end-to-end = ' + ms +
                'ms (target < 8000ms, CLAUDE.md 3.7)');
    console.log('  2x hashPin_ @ ' + pinIterations_(PIN_HASH_VERSION) + ' iterasi + revokeAllForUser');
  } finally {
    _rmFixtures(fx);
  }
}

/**
 * Acceptance Fase 2. Membuat user + case fixture lalu menghapusnya.
 * CATATAN: CASE_COUNTER ikut naik dan TIDAK dikembalikan — itu memang
 * perilaku yang benar (01-schema.md §19: naik terus, tidak pernah turun).
 * Nomor case yang terpakai test akan "hangus", itu wajar.
 */
function runCaseTests() {
  const out = [];
  function t(name, fn) {
    try { fn(); out.push('PASS  ' + name); }
    catch (e) { out.push('FAIL  ' + name + ' → ' + (e.message || e)); }
  }
  function expect(cond, msg) { if (!cond) throw new Error(msg || 'kondisi tidak terpenuhi'); }
  function expectErr(code, fn) {
    try { fn(); } catch (e) {
      if (e.code === code) return;
      throw new Error('kode=' + e.code + ' (harusnya ' + code + ') | ' + (e.message || e));
    }
    throw new Error('tidak melempar ' + code);
  }

  const fx = _mkCaseFixtures();
  try {
    let nos = [];

    t('ACCEPTANCE: 3 case berurutan, tanpa duplikat', function () {
      const before = TC.cfgNum('CASE_COUNTER', 0);
      for (let i = 1; i <= 3; i++) nos.push(_mkCase(fx.dealer, i).caseNo);
      fx.cases = nos.slice();
      const num = nos.map(function (x) { return Number(x.slice(3)); });
      expect(nos[0] !== nos[1] && nos[1] !== nos[2] && nos[0] !== nos[2], 'ada Case_No duplikat: ' + nos);
      expect(num[1] === num[0] + 1 && num[2] === num[1] + 1, 'tidak berurutan: ' + nos);
      expect(/^CN-\d{4}$/.test(nos[0]), 'format salah: ' + nos[0]);
      TC.invalidate(TC.S.CONFIG);
      expect(TC.cfgNum('CASE_COUNTER', 0) === before + 3, 'CASE_COUNTER tidak naik 3');
    });

    t('validasi tolak VIN pendek & symptom tak dikenal', function () {
      expectErr('VALIDATION', function () {
        Case_.create(fx.dealer, {
          vehicle: { VIN: 'PENDEK', Model: 'W206', Mileage: 100, Warranty_Status: 'In_Warranty' },
          complaint: { Complaint_Desc: 'x', Symptom_Category: 'Engine' }
        });
      });
      expectErr('VALIDATION', function () {
        Case_.create(fx.dealer, {
          vehicle: { VIN: 'WDD2050421A100999', Model: 'W206', Mileage: 100, Warranty_Status: 'In_Warranty' },
          complaint: { Complaint_Desc: 'x', Symptom_Category: 'Mesin' }
        });
      });
    });

    t('Created → Open oleh dealer + efek samping', function () {
      const r = Case_.transition(fx.dealer, { caseNo: nos[0], toStatus: 'Open' });
      expect(r['case'].Status === 'Open', 'status = ' + r['case'].Status);
      expect(r['case'].Submitted_To_IIDI_At !== '', 'Submitted_To_IIDI_At kosong');
      expect(r['case'].Current_Owner_User_ID === '', 'owner harus kosong (pool IIDI)');
    });

    t('transisi ilegal Open → Closed → CONFLICT', function () {
      expectErr('CONFLICT', function () {
        Case_.transition(fx.dealer, { caseNo: nos[0], toStatus: 'Closed' });
      });
    });

    // Ini test role guard yang SAH: transisinya legal, rolenya yang tidak berhak.
    t('ACCEPTANCE: Open → In Progress oleh dealer → FORBIDDEN', function () {
      expectErr('FORBIDDEN', function () {
        Case_.transition(fx.dealer, { caseNo: nos[0], toStatus: 'In Progress' });
      });
    });

    t('Open → In Progress oleh IIDI_Tech + First_IIDI_Response_At', function () {
      const r = Case_.transition(fx.iidi, { caseNo: nos[0], toStatus: 'In Progress' });
      expect(r['case'].Current_Owner_User_ID === fx.iidi.user.userId, 'owner tidak berpindah');
      expect(r['case'].First_IIDI_Response_At !== '', 'First_IIDI_Response_At kosong');
    });

    t('Waiting Dealer Reply wajib waitingReason', function () {
      expectErr('VALIDATION', function () {
        Case_.transition(fx.iidi, { caseNo: nos[0], toStatus: 'Waiting Dealer Reply' });
      });
      const r = Case_.transition(fx.iidi, {
        caseNo: nos[0], toStatus: 'Waiting Dealer Reply', waitingReason: 'Additional_Data'
      });
      expect(r['case'].Current_Waiting_Reason === 'Additional_Data', 'reason tidak tersimpan');
      expect(r['case'].Current_Owner_User_ID === fx.dealer.user.userId, 'bola tidak balik ke dealer');
    });

    t('Created → Closed = Cancelled_By_Dealer', function () {
      const r = Case_.transition(fx.dealer, { caseNo: nos[1], toStatus: 'Closed' });
      expect(r['case'].Closure_Type === 'Cancelled_By_Dealer', 'Closure_Type = ' + r['case'].Closure_Type);
      expect(r['case'].Closed_By === fx.dealer.user.userId, 'Closed_By salah');
    });

    t('ACCEPTANCE: dealer lain tidak bisa case.get', function () {
      expectErr('FORBIDDEN', function () { Case_.get(fx.other, { caseNo: nos[0] }); });
    });

    t('IIDI tidak melihat draft (Created)', function () {
      expectErr('FORBIDDEN', function () { Case_.get(fx.iidi, { caseNo: nos[2] }); });
      const l = Case_.list(fx.iidi, { filters: {}, pageSize: 50 });
      expect(l.items.every(function (c) { return c.Status !== 'Created'; }), 'draft bocor ke list IIDI');
    });

    t('case.update hanya sebelum submit', function () {
      const r = Case_.update(fx.dealer, { caseNo: nos[2], fields: { Mileage: 99999 } });
      expect(r['case'].Mileage === 99999, 'Mileage tidak berubah');
      expectErr('CONFLICT', function () {
        Case_.update(fx.dealer, { caseNo: nos[0], fields: { Mileage: 1234 } });
      });
    });

    t('case.setPriority ditolak untuk role IIDI', function () {
      expectErr('FORBIDDEN', function () {
        Case_.setPriority(fx.iidi, { caseNo: nos[0], priority: 'Urgent' });
      });
      const r = Case_.setPriority(fx.dealer, { caseNo: nos[2], priority: 'Urgent', reason: 'uji' });
      expect(r['case'].Priority === 'Urgent', 'priority tidak berubah');
    });

    t('case.assign: claim diri sendiri oleh IIDI_Tech', function () {
      const r = Case_.assign(fx.iidi, { caseNo: nos[0] });
      expect(r['case'].Current_Owner_User_ID === fx.iidi.user.userId, 'owner tidak berpindah');
      expect(r['case'].Current_Owner_Role === 'IIDI_Tech', 'role owner = ' + r['case'].Current_Owner_Role);
    });

    t('case.assign: dealer tidak boleh claim, target non-IIDI ditolak', function () {
      expectErr('FORBIDDEN', function () { Case_.assign(fx.dealer, { caseNo: nos[0] }); });
      // assign ke user dealer -> VALIDATION (case hanya untuk user IIDI)
      expectErr('VALIDATION', function () {
        Case_.assign(fx.mgr, { caseNo: nos[0], toUserId: fx.dealer.user.userId });
      });
      // assign ke user yang tidak ada -> NOT_FOUND
      expectErr('NOT_FOUND', function () {
        Case_.assign(fx.mgr, { caseNo: nos[0], toUserId: 'U-TIDAK-ADA' });
      });
      // IIDI_Tech tidak punya perm case.assign (hanya case.claim)
      expectErr('FORBIDDEN', function () {
        Case_.assign(fx.iidi, { caseNo: nos[0], toUserId: fx.mgr.user.userId });
      });
      // IIDI_Tech_Mgr boleh assign ke IIDI lain
      const r = Case_.assign(fx.mgr, { caseNo: nos[0], toUserId: fx.iidi.user.userId });
      expect(r['case'].Current_Owner_User_ID === fx.iidi.user.userId, 'assign gagal');
    });

    t('setiap mutasi menulis CASE_EVENTS', function () {
      const ev = TC.filter(TC.S.EVENTS, function (r) { return r.Case_No === nos[0]; });
      const types = ev.map(function (r) { return r.Event_Type; });
      expect(types.indexOf('Created') !== -1, 'tidak ada event Created');
      expect(types.filter(function (x) { return x === 'Status_Changed'; }).length === 3,
             'Status_Changed = ' + types.filter(function (x) { return x === 'Status_Changed'; }).length + ' (harusnya 3)');
      expect(ev.every(function (r) { return r.Actor_User_ID && r.Created_At; }), 'ada event tanpa aktor/waktu');
    });

    t('SLA_Status = NONE selama Fase 3 belum ada', function () {
      const c = Case_.get(fx.dealer, { caseNo: nos[0] })['case'];
      const ada = (typeof Sla_ !== 'undefined');
      expect(ada || c.SLA_Status === 'NONE', 'SLA_Status = ' + c.SLA_Status);
    });

    // Dijalankan SELAGI baris fixture masih ada. Kalau ditaruh di checkPlainText()
    // setelah cleanup, yang terbaca sel kosong dan hasilnya lolos palsu.
    t('kolom timestamp baris baru tetap Plain Text', function () {
      const ss = SpreadsheetApp.openById(TC.prop('SHEET_ID'));
      [[SHEETS.CASES_MASTER, 'Case_No', nos[0]],
       [SHEETS.CASE_EVENTS, 'Case_No', nos[0]],
       [SHEETS.CASE_DIAGNOSTICS, 'Case_No', nos[0]]].forEach(function (tgt) {
        const sheetName = tgt[0];
        const rec = TC.filter(sheetName, function (r) { return r[tgt[1]] === tgt[2]; })[0];
        expect(rec, 'baris fixture tidak ketemu di ' + sheetName);
        const sh = ss.getSheetByName(sheetName);
        (TIMESTAMP_COLUMNS[sheetName] || []).forEach(function (col) {
          const c = colIndex_(sheetName, col) + 1;
          const cell = sh.getRange(rec._row, c);
          expect(cell.getNumberFormat() === '@',
                 sheetName + '.' + col + ' format=' + cell.getNumberFormat());
          expect(!(cell.getValue() instanceof Date),
                 sheetName + '.' + col + ' ter-parse jadi Date');
        });
      });
    });

  } finally {
    _rmCaseFixtures(fx);
  }
  console.log(out.join('\n'));
  return out;
}

function _mkCase(ctx, i) {
  return Case_.create(ctx, {
    vehicle: { VIN: 'WDD2050421A' + (100000 + i), Model: 'W205 C200', Mileage: 45000 + i,
               Prod_Year: '2019', Warranty_Status: 'In_Warranty' },
    complaint: { Complaint_Desc: 'Mesin pincang saat idle (fixture #' + i + ')',
                 Symptom_Category: 'Engine', Vehicle_Status: 'In_Workshop', Frequency: 'Always' },
    diagnostics: { Initial_Diag: 'Quick test dijalankan, ditemukan indikasi awal pada sistem bahan bakar.',
                   DTC_Codes: 'P0087' },
    priority: 'Normal'
  });
}

function _mkCaseFixtures() {
  const rnd = Utilities.getUuid().slice(0, 6);
  const dealers = TC.readAll(TC.S.DEALERS);
  const dA = dealers[0], dB = dealers[1];

  function mkUser(sfx, role, dealer) {
    const u = {
      User_ID: 'UTEST-' + rnd + '-' + sfx, Full_Name: 'Test ' + sfx, Role: role,
      Dealer_ID: dealer ? dealer.Dealer_ID : '', Dealer_Name: dealer ? dealer.Dealer_Name : '',
      Email: 'ctest-' + rnd + '-' + sfx + '@example.test', Phone_WA: '',
      PIN_Hash: '', PIN_Salt: '', PIN_Version: String(PIN_HASH_VERSION),
      Status: 'ACTIVE', Must_Change_PIN: 'FALSE', Failed_Attempts: '0',
      Locked_Until: '', Notif_Level: 'All', Created_At: TC.nowIso(),
      Updated_At: TC.nowIso(), Last_Login_At: ''
    };
    TC.append(TC.S.USERS, u);
    // ctx dibuat langsung, bukan lewat login — Fase 1 sudah lulus dan diuji
    // terpisah di runAuthTests(). Bentuknya harus sama persis dengan hasil
    // Session_.validate(): areas berupa ARRAY.
    return { user: { userId: u.User_ID, fullName: u.Full_Name, role: role,
                     dealerId: u.Dealer_ID, areas: [], mustChangePin: false } };
  }

  return {
    rnd: rnd, cases: [],
    dealer: mkUser('D', 'Dealer_SM', dA),
    other:  mkUser('O', 'Dealer_SM', dB),
    iidi:   mkUser('I', 'IIDI_Tech', null),
    mgr:    mkUser('M', 'IIDI_Tech_Mgr', null)
  };
}

function _rmCaseFixtures(fx) {
  const ss = SpreadsheetApp.openById(TC.prop('SHEET_ID'));
  function purge(sheetName, colName, match) {
    const sh = ss.getSheetByName(sheetName);
    TC.readAll(sheetName)
      .filter(function (r) { return match(r[colName]); })
      .map(function (r) { return r._row; })
      .sort(function (a, b) { return b - a; })
      .forEach(function (r) { sh.deleteRow(r); });
    TC.invalidate(sheetName);
  }
  const isFxCase = function (v) { return fx.cases.indexOf(v) !== -1; };
  purge(TC.S.EVENTS, 'Case_No', isFxCase);
  purge(TC.S.DIAG,   'Case_No', isFxCase);
  purge(TC.S.CASES,  'Case_No', isFxCase);
  purge(TC.S.USERS,  'User_ID', function (v) { return String(v).indexOf('UTEST-' + fx.rnd) === 0; });
}

// 99_Tests.gs — tambahkan di akhir file
/**
 * Uji konkurensi penomoran Case_No. Menjadwalkan 3 eksekusi terpisah yang
 * saling berebut ScriptLock. Jalankan, tunggu ~2 menit, lalu panggil
 * checkConcurrentCaseNo(). Ini yang benar-benar menguji acceptance
 * "3 case bersamaan" di CLAUDE.md §7 — runCaseTests() hanya sekuensial.
 */
function seedConcurrentCaseTest() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('CONC_TEST_BEFORE', String(TC.cfgNum('CASE_COUNTER', 0)));
  props.setProperty('CONC_TEST_TAG', Utilities.getUuid().slice(0, 6));
  for (let i = 0; i < 3; i++) {
    ScriptApp.newTrigger('_concurrentCaseWorker').timeBased().after(30000 + i * 200).create();
  }
  console.log('3 trigger dijadwalkan. Tunggu ~1 menit, lalu jalankan checkConcurrentCaseNo().');
}

function _concurrentCaseWorker() {
  const tag = PropertiesService.getScriptProperties().getProperty('CONC_TEST_TAG');
  const dealer = TC.readAll(TC.S.DEALERS)[0];
  const ctx = { user: { userId: 'UCONC-' + tag, fullName: 'Konkuren', role: 'Dealer_SM',
                        dealerId: dealer.Dealer_ID, areas: [], mustChangePin: false } };
  Case_.create(ctx, {
    vehicle: { VIN: 'WDD2050421ACONC' + Math.floor(Math.random() * 90 + 10),
               Model: 'W205 C200', Mileage: 12345, Warranty_Status: 'In_Warranty' },
    complaint: { Complaint_Desc: 'Uji konkurensi penomoran', Symptom_Category: 'Other' },
    diagnostics: {}, priority: 'Normal'
  });
}

/** Verifikasi hasil + bersihkan trigger dan baris uji. */
function checkConcurrentCaseNo() {
  const props = PropertiesService.getScriptProperties();
  const tag = props.getProperty('CONC_TEST_TAG');
  const before = Number(props.getProperty('CONC_TEST_BEFORE'));

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === '_concurrentCaseWorker') ScriptApp.deleteTrigger(t);
  });

  const rows = TC.filter(TC.S.CASES, function (r) { return r.Created_By_User_ID === 'UCONC-' + tag; });
  const nos = rows.map(function (r) { return r.Case_No; });
  const uniq = nos.filter(function (v, i) { return nos.indexOf(v) === i; });
  TC.invalidate(TC.S.CONFIG);
  const after = TC.cfgNum('CASE_COUNTER', 0);

  console.log('Case_No     : ' + nos.join(', '));
  console.log('JUMLAH      : ' + (rows.length === 3 ? 'PASS' : 'FAIL (' + rows.length + ')'));
  console.log('UNIK        : ' + (uniq.length === rows.length ? 'PASS' : 'FAIL — ADA DUPLIKAT'));
  console.log('COUNTER +3  : ' + (after === before + 3 ? 'PASS' : 'FAIL (' + before + ' → ' + after + ')'));

  const ss = SpreadsheetApp.openById(TC.prop('SHEET_ID'));
  [[TC.S.EVENTS, 'Case_No'], [TC.S.DIAG, 'Case_No'], [TC.S.CASES, 'Case_No']].forEach(function (t) {
    const sh = ss.getSheetByName(t[0]);
    TC.readAll(t[0]).filter(function (r) { return nos.indexOf(r[t[1]]) !== -1; })
      .map(function (r) { return r._row; })
      .sort(function (a, b) { return b - a; })
      .forEach(function (r) { sh.deleteRow(r); });
    TC.invalidate(t[0]);
  });
  props.deleteProperty('CONC_TEST_TAG'); props.deleteProperty('CONC_TEST_BEFORE');
}

/**
 * 99_Tests.gs — runSlaTests()
 * 15 test wajib docs/05-sla-engine.md §7. Jalankan dari editor GAS.
 * Fase 3 TIDAK selesai sebelum semua PASS.
 */

var SLA_TEST_HOLIDAYS = ['2026-08-17'];   // Senin, Hari Kemerdekaan RI
var SLA_TEST_CFG = { WORK_START: '08:00', WORK_END: '17:00', NEAR_DUE_THRESHOLD_HOURS: 1 };

function runSlaTests() {
  var H = SLA_TEST_HOLIDAYS, C = SLA_TEST_CFG;
  var out = [], pass = 0, fail = 0;

  function eqTime(no, desc, actual, expectedIso) {
    var a = slaParse_(actual), b = slaParse_(expectedIso);
    var ok = (a !== null && a === b);
    log_(no, desc, ok, toWibIso_(a), toWibIso_(b));
  }
  function eqNum(no, desc, actual, expected) {
    log_(no, desc, actual === expected, String(actual), String(expected));
  }
  function eqSla(no, desc, res, status, remaining) {
    var ok = (res.status === status) &&
             (remaining === null || res.remainingWorkingMinutes === remaining ||
              res.overdueWorkingMinutes === Math.abs(remaining));
    log_(no, desc, ok,
         res.status + '/' + res.remainingWorkingMinutes,
         status + '/' + remaining);
  }
  function log_(no, desc, ok, got, want) {
    if (ok) { pass++; out.push('PASS #' + no + '  ' + desc); }
    else    { fail++; out.push('FAIL #' + no + '  ' + desc + '\n        got : ' + got + '\n        want: ' + want); }
  }

  eqTime(1,  'addWorkingDays_ Senin 09:00 +1',
         addWorkingDays_('2026-08-03T09:00+07:00', 1, H, C), '2026-08-04T09:00+07:00');
  eqTime(2,  'addWorkingDays_ Jumat 16:00 +1 → Senin',
         addWorkingDays_('2026-08-07T16:00+07:00', 1, H, C), '2026-08-10T16:00+07:00');
  eqTime(3,  'addWorkingDays_ Jumat +1, Senin libur → Selasa',
         addWorkingDays_('2026-08-14T09:00+07:00', 1, H, C), '2026-08-18T09:00+07:00');
  eqTime(4,  'normalisasi 06:30 → 08:00',
         addWorkingDays_('2026-08-03T06:30+07:00', 1, H, C), '2026-08-04T08:00+07:00');
  eqTime(5,  'normalisasi 19:00 → hari kerja berikutnya',
         addWorkingDays_('2026-08-03T19:00+07:00', 1, H, C), '2026-08-05T08:00+07:00');
  eqTime(6,  'Sabtu 10:00 +2 hari kerja → Rabu',
         addWorkingDays_('2026-08-08T10:00+07:00', 2, H, C), '2026-08-12T08:00+07:00');
  eqTime(7,  'addWorkingMinutes_ 16:30 +60 → besok 08:30',
         addWorkingMinutes_('2026-08-03T16:30+07:00', 60, H, C), '2026-08-04T08:30+07:00');

  eqNum(8,   'workingMinutesBetween_ 08:00–17:00',
         workingMinutesBetween_('2026-08-03T08:00', '2026-08-03T17:00', H, C), 540);
  eqNum(9,   'workingMinutesBetween_ lintas akhir pekan',
         workingMinutesBetween_('2026-08-07T16:00', '2026-08-10T09:00', H, C), 120);
  eqNum(10,  'workingMinutesBetween_ Sabtu–Minggu',
         workingMinutesBetween_('2026-08-08T09:00', '2026-08-09T15:00', H, C), 0);

  eqSla(11,  'NEAR_DUE sisa 30',
         slaStatus_('2026-08-04T16:30', '2026-08-04T17:00', H, C), 'NEAR_DUE', 30);
  eqSla(12,  'now == deadline → NEAR_DUE sisa 0',
         slaStatus_('2026-08-04T17:00', '2026-08-04T17:00', H, C), 'NEAR_DUE', 0);
  eqSla(13,  'OVERDUE lewat 1 menit kerja',
         slaStatus_('2026-08-05T08:01', '2026-08-04T17:00', H, C), 'OVERDUE', -1);
  eqSla(14,  'deadline kosong → NONE',
         slaStatus_('2026-08-05T08:01', '', H, C), 'NONE', 0);

  eqTime(15, 'addWorkingDays_ Senin 09:00 +3 → Kamis',
         addWorkingDays_('2026-08-03T09:00+07:00', 3, H, C), '2026-08-06T09:00+07:00');

  // --- Test tambahan: guard "pure function" ---
  var src = String(addWorkingDays_) + String(slaStatus_) + String(workingMinutesBetween_);
  log_(16, 'engine tidak menyentuh SpreadsheetApp', src.indexOf('SpreadsheetApp') === -1,
       'ada referensi', 'tidak ada');

  var header = '=== runSlaTests() — ' + pass + ' PASS / ' + fail + ' FAIL ===';
  var report = header + '\n' + out.join('\n');
  Logger.log(report);
  console.log(report);
  return { pass: pass, fail: fail, ok: fail === 0, lines: out };
}

/* ═══════════════════════════════════════════════════════════════════════
 * TEMPEL BLOK INI DI AKHIR 99_Tests.gs
 * (kalau 99_Tests.gs belum ada, jadikan seluruh isi file ini)
 *
 * runSlaTests() — 15 test wajib docs/05-sla-engine.md §7 + 9 test tambahan.
 * FASE 3 TIDAK SELESAI sebelum semuanya PASS.
 *
 * Jalankan dari editor GAS: pilih fungsi runSlaTests → Run → lihat Execution log.
 * Test ini murni in-memory, TIDAK menyentuh spreadsheet, jadi aman dijalankan
 * kapan saja termasuk di atas data produksi.
 * ═══════════════════════════════════════════════════════════════════════ */

var SLA_TEST_HOLIDAYS = { '2026-08-17': true };   // Senin, Hari Kemerdekaan RI
var SLA_TEST_CFG = { WORK_START: '08:00', WORK_END: '17:00', NEAR_DUE_THRESHOLD_HOURS: 1 };

function runSlaTests() {
  var H = SLA_TEST_HOLIDAYS, C = SLA_TEST_CFG;
  var lines = [], pass = 0, fail = 0;

  function check(no, desc, got, want) {
    var ok = (String(got) === String(want));
    if (ok) { pass++; lines.push('PASS #' + no + '  ' + desc); }
    else {
      fail++;
      lines.push('FAIL #' + no + '  ' + desc +
                 '\n        got : ' + got + '\n        want: ' + want);
    }
  }
  function iso(v) { return toWibIso_(v); }

  // ── 15 test wajib docs §7 ────────────────────────────────────────────────
  check(1, 'addWorkingDays_ Senin 09:00 +1hk',
    iso(addWorkingDays_('2026-08-03T09:00+07:00', 1, H, C)), '2026-08-04T09:00:00+07:00');

  check(2, 'addWorkingDays_ Jumat 16:00 +1hk → Senin',
    iso(addWorkingDays_('2026-08-07T16:00+07:00', 1, H, C)), '2026-08-10T16:00:00+07:00');

  check(3, 'addWorkingDays_ Jumat +1hk, Senin libur → Selasa',
    iso(addWorkingDays_('2026-08-14T09:00+07:00', 1, H, C)), '2026-08-18T09:00:00+07:00');

  check(4, 'normalisasi 06:30 → mulai 08:00',
    iso(addWorkingDays_('2026-08-03T06:30+07:00', 1, H, C)), '2026-08-04T08:00:00+07:00');

  check(5, 'normalisasi 19:00 → hari kerja berikutnya',
    iso(addWorkingDays_('2026-08-03T19:00+07:00', 1, H, C)), '2026-08-05T08:00:00+07:00');

  check(6, 'Sabtu 10:00 +2hk → Rabu (REVISI Fase 0)',
    iso(addWorkingDays_('2026-08-08T10:00+07:00', 2, H, C)), '2026-08-12T08:00:00+07:00');

  check(7, 'addWorkingMinutes_ 16:30 +60 → besok 08:30',
    iso(addWorkingMinutes_('2026-08-03T16:30+07:00', 60, H, C)), '2026-08-04T08:30:00+07:00');

  check(8, 'workingMinutesBetween_ 08:00–17:00',
    workingMinutesBetween_('2026-08-03T08:00', '2026-08-03T17:00', H, C), 540);

  check(9, 'workingMinutesBetween_ lintas akhir pekan',
    workingMinutesBetween_('2026-08-07T16:00', '2026-08-10T09:00', H, C), 120);

  check(10, 'workingMinutesBetween_ Sabtu–Minggu',
    workingMinutesBetween_('2026-08-08T09:00', '2026-08-09T15:00', H, C), 0);

  var r11 = slaStatus_('2026-08-04T16:30', '2026-08-04T17:00', H, C);
  check(11, 'NEAR_DUE sisa 30',
    r11.status + '/' + r11.remainingWorkingMinutes, 'NEAR_DUE/30');

  var r12 = slaStatus_('2026-08-04T17:00', '2026-08-04T17:00', H, C);
  check(12, 'now == deadline → NEAR_DUE sisa 0 (REVISI Fase 0)',
    r12.status + '/' + r12.remainingWorkingMinutes, 'NEAR_DUE/0');

  var r13 = slaStatus_('2026-08-05T08:01', '2026-08-04T17:00', H, C);
  check(13, 'OVERDUE lewat 1 menit kerja',
    r13.status + '/' + r13.overdueWorkingMinutes, 'OVERDUE/1');

  check(14, 'deadline kosong → NONE',
    slaStatus_('2026-08-05T08:01', '', H, C).status, 'NONE');

  check(15, 'addWorkingDays_ Senin 09:00 +3hk → Kamis',
    iso(addWorkingDays_('2026-08-03T09:00+07:00', 3, H, C)), '2026-08-06T09:00:00+07:00');

  // ── Test tambahan: tepi yang gampang bikin regresi ───────────────────────
  check('X1', 'Sabtu bukan hari kerja',      isWorkingDay_('2026-08-08', H), false);
  check('X2', '17 Agu libur nasional',       isWorkingDay_('2026-08-17', H), false);
  check('X3', '18 Agu hari kerja',           isWorkingDay_('2026-08-18', H), true);
  check('X4', 'mundur 60 menit dari 08:30',
    iso(addWorkingMinutes_('2026-08-04T08:30+07:00', -60, H, C)), '2026-08-03T16:30:00+07:00');
  check('X5', 'between simetris negatif',
    workingMinutesBetween_('2026-08-10T09:00', '2026-08-07T16:00', H, C), -120);
  check('X6', 'ON_TIME untuk deadline jauh',
    slaStatus_('2026-08-03T08:00', '2026-08-06T09:00', H, C).status, 'ON_TIME');
  check('X7', '+0 hari kerja tidak menggeser',
    iso(addWorkingDays_('2026-08-03T09:00+07:00', 0, H, C)), '2026-08-03T09:00:00+07:00');

  // Deadline aktif per status (docs §5)
  check('X8', 'Escalated to MBAG → tidak dihitung',
    caseSlaStatus_({ Status: 'Escalated to MBAG', IIDI_Response_Deadline: '2026-08-04T17:00+07:00' },
                   '2026-08-05T09:00+07:00', H, C).status, 'NONE');
  check('X9', 'Waiting Dealer Reply pakai Dealer_Response_Deadline',
    caseSlaStatus_({ Status: 'Waiting Dealer Reply', Dealer_Response_Deadline: '2026-08-04T17:00+07:00' },
                   '2026-08-04T16:30+07:00', H, C).field, 'Dealer_Response_Deadline');

  // ── Guard kemurnian: engine tidak boleh menyentuh sheet ──────────────────
  var src = String(addWorkingDays_) + String(addWorkingMinutes_) + String(slaStatus_) +
            String(workingMinutesBetween_) + String(nextWorkingMoment_) +
            String(caseSlaStatus_) + String(computeDeadline_) + String(activityStatus_);
  check('P1', 'engine bebas SpreadsheetApp', src.indexOf('SpreadsheetApp') === -1, true);
  check('P2', 'engine bebas TC.',            src.indexOf('TC.') === -1, true);
  check('P3', 'engine bebas CacheService',   src.indexOf('CacheService') === -1, true);

  var head = '════ runSlaTests(): ' + pass + ' PASS / ' + fail + ' FAIL ════';
  var report = head + '\n' + lines.join('\n') + '\n' + head;
  Logger.log(report);
  console.log(report);
  return { ok: (fail === 0), pass: pass, fail: fail };
}

/**
 * checkPhase3() — verifikasi integrasi Fase 3 terhadap data nyata.
 * READ-ONLY, tidak menulis apapun. Menutup 5 item checklist yang tidak
 * bisa dijangkau runSlaTests().
 */
function checkPhase3() {
  var L = [], warn = 0;
  function ok(m)   { L.push('  OK   ' + m); }
  function bad(m)  { L.push('  WARN ' + m); warn++; }

  // 1. Nama handler trigger (docs 05-sla-engine.md §8)
  var names = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  L.push('1. Trigger terpasang: ' + names.join(', '));
  names.indexOf('slaJob') !== -1
    ? ok('slaJob terdaftar sebagai handler')
    : bad('slaJob TIDAK terdaftar. Handler SLA yang ada: ' + names.join(', ') +
          ' → samakan namanya, atau buat alias: function <nama>() { return slaJob(); }');

  // 2. HOLIDAY_CALENDAR
  var h = Sla_.holidays(), n = Object.keys(h).length;
  L.push('2. HOLIDAY_CALENDAR: ' + n + ' tanggal aktif');
  n > 0 ? ok('kalender libur terbaca') : bad('kosong — semua hari kerja dianggap Sen-Jum saja');
  h['2026-08-17'] ? ok('17 Agu 2026 terdaftar') : bad('17 Agu 2026 belum ada / Active != TRUE');

  // 3. CONFIG jam kerja
  var c = Sla_.cfg();
  L.push('3. Jam kerja: ' + Math.floor(c.startMin / 60) + ':00–' + Math.floor(c.endMin / 60) +
         ':00 (' + c.minutesPerDay + ' menit/hari kerja), NEAR_DUE ' + c.nearDueMinutes + ' menit');
  c.minutesPerDay === 540 ? ok('540 menit sesuai spec') : bad('bukan 540 — cek WORK_START/WORK_END');

  // 4. Kolom SLA_Status TIDAK boleh ada di sheet (01-schema.md §4)
  var rows = TC.readAll(TC.S.CASES) || [];
  var sample = rows.length ? rows[0] : {};
  sample.hasOwnProperty('SLA_Status')
    ? bad('4. Kolom SLA_Status ADA di CASES_MASTER → hapus kolomnya, ini dihitung saat read')
    : ok('4. CASES_MASTER tidak menyimpan SLA_Status');

  // 5. Deadline terisi & status hidup
  var kosong = 0, hidup = 0;
  L.push('5. Case tersimpan: ' + rows.length);
  rows.forEach(function (r) {
    var f = activeDeadlineField_(r);
    if (!f) return;
    if (!String(r[f] || '')) kosong++; else hidup++;
  });
  L.push('   deadline aktif terisi: ' + hidup + ' · kosong: ' + kosong);
  if (kosong > 0) bad(kosong + ' case warisan Fase 2 berkolom deadline kosong → ' +
                      'hapus case uji itu, atau jalankan backfillDeadlines_()');

  rows.slice(0, 5).forEach(function (r) {
    var s = Sla_.statusOf(r);
    L.push('   ' + r.Case_No + ' [' + r.Status + '] → ' + s.status +
           ' (' + (s.field || '-') + ') ' + s.label);
  });

  // 6. Engine hidup end-to-end
  var d = Sla_.deadline(TC.nowIso(), 3);
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/.test(d)
    ? ok('6. Sla_.deadline(now, 3) → ' + d)
    : bad('6. format deadline salah: ' + d);

  var head = '════ checkPhase3: ' + (warn ? warn + ' WARNING' : 'SEMUA BERES') + ' ════';
  console.log(head + '\n' + L.join('\n') + '\n' + head);
  return { warnings: warn };
}

/**
 * Backfill deadline case warisan Fase 2. JALANKAN SEKALI, opsional.
 * Menghitung mundur dari timestamp event yang sebenarnya, bukan dari "sekarang",
 * supaya deadline lama tetap jujur secara historis (docs §6).
 */
function backfillDeadlines_() {
throw new Error('DINONAKTIFKAN — sedang diselidiki, lihat chat 1 Sep 2026.');
  var rows = TC.readAll(TC.S.CASES) || [], n = 0;
  rows.forEach(function (r) {
    var p = {};
    if (!String(r.Dealer_Self_Diagnosis_Deadline || '') && r.Created_At)
      p.Dealer_Self_Diagnosis_Deadline = Sla_.deadlineFor('DEALER_SELF_DIAG', r.Created_At);
    if (!String(r.IIDI_Response_Deadline || '') && r.Submitted_To_IIDI_At)
      p.IIDI_Response_Deadline = Sla_.deadlineFor('IIDI_RESPONSE', r.Submitted_To_IIDI_At);
    if (Object.keys(p).length) { TC.update(TC.S.CASES, r._row, p); n++; }
  });
  TC.flush();
  console.log('backfillDeadlines_: ' + n + ' case diperbarui');
  return n;
}

/** Diagnosa slaJob. READ-ONLY. Pakai Logger.log agar pasti tampil di Execution log. */
function diagSlaJob() {
  var L = [];
  function p(s) { L.push(s); }

  p('typeof slaJob   : ' + (typeof slaJob));
  p('typeof Sla_     : ' + (typeof Sla_));

  var rows = TC.readAll(TC.S.CASES) || [];
  p('total CASES     : ' + rows.length);

  var byStatus = {};
  rows.forEach(function (r) { var k = r.Status || '(kosong)'; byStatus[k] = (byStatus[k] || 0) + 1; });
  p('sebaran Status  : ' + JSON.stringify(byStatus));

  var live = rows.filter(function (r) {
    return r.Status !== 'Closed' && r.Status !== 'Created' && r.Status !== 'Escalated to MBAG';
  });
  p('lolos filter    : ' + live.length);

  var cursor = TC.cfgNum('SLA_JOB_CURSOR', 0);
  p('SLA_JOB_CURSOR  : ' + cursor);
  p('slice diproses  : ' + live.slice(cursor >= live.length ? 0 : cursor, 300).length);

  // Panggil slaJob dan tangkap nilai kembaliannya secara eksplisit.
  var hasil, err = '';
  try { hasil = slaJob(); } catch (e) { err = String(e); }
  p('slaJob() return : ' + (err ? 'ERROR ' + err : JSON.stringify(hasil)));

  Logger.log(L.join('\n'));
  return hasil;
}

/** Bandingkan SCHEMA (00_Config.gs) vs header sheet asli. READ-ONLY. */
function checkSchemaAlignment() {
  var L = [], bad = 0;
  if (typeof SCHEMA === 'undefined') { Logger.log('SCHEMA tidak terdefinisi.'); return; }

  var ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
  Object.keys(SCHEMA).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) { L.push('SKIP  ' + name + ' — sheet tidak ada'); return; }
    var real = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    var spec = SCHEMA[name];
    var beda = [];
    var max = Math.max(real.length, spec.length);
    for (var i = 0; i < max; i++) {
      if (String(real[i] || '') !== String(spec[i] || '')) {
        beda.push('kolom ' + (i + 1) + ': sheet="' + (real[i] || '') + '" vs SCHEMA="' + (spec[i] || '') + '"');
      }
    }
    if (beda.length) { bad++; L.push('BEDA  ' + name + '\n        ' + beda.join('\n        ')); }
    else L.push('OK    ' + name + ' (' + spec.length + ' kolom)');
  });

  Logger.log('════ ' + (bad ? bad + ' SHEET TIDAK SINKRON' : 'SEMUA SINKRON') + ' ════\n' + L.join('\n'));
}

/** Smoke test Fase 4 — ganti CASE_NO dengan case milik dealer admin/uji. */
function testFase4() {
  const CASE_NO = 'CN-0001';                  // ← ganti
  const admin = TC.find(TC.S.USERS, 'User_ID', 'U-0001');
  const ctx = { user: { userId: admin.User_ID, role: admin.Role,
                        dealerId: admin.Dealer_ID, fullName: admin.Full_Name, areas: [] } };

  const b64 = Utilities.base64Encode(Utilities.newBlob('halo quick test').getBytes());
  const up = Attach_.upload(ctx, { caseNo: CASE_NO, evidenceType: 'Quick_Test',
    fileName: 'uji.txt', mimeType: 'text/plain', dataBase64: b64 });
  Logger.log('UPLOAD  : ' + JSON.stringify(up.attachment));

  Logger.log('LIST    : ' + Attach_.list(ctx, { caseNo: CASE_NO }).items.length + ' item');

  const dl = Attach_.download(ctx, { attachmentId: up.attachment.attachmentId, chunkIndex: 0 });
  Logger.log('DOWNLOAD: ' + Utilities.newBlob(Utilities.base64Decode(dl.dataBase64)).getDataAsString());

  const fld = TC.find(TC.S.FOLDERS, 'Case_No', CASE_NO);
  Logger.log('FOLDER  : ' + fld.Folder_URL);
  Logger.log('SCORE   : ' + TC.find(TC.S.CASES, 'Case_No', CASE_NO).Quality_Score);

  Attach_.del(ctx, { attachmentId: up.attachment.attachmentId });
  Logger.log('DELETE  : sisa ' + Attach_.list(ctx, { caseNo: CASE_NO }).items.length + ' item');
}