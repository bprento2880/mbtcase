/**
 * 12_Auth.gs — login, hashing PIN, lockout, ganti PIN.
 * Acuan: 03-rbac.md §4, 02-api-contract.md §4 "Auth".
 *
 * Konstanta iterasi (PIN_HASH_ITERATIONS) dan generator salt (generateSalt_)
 * milik 00_Config.gs — JANGAN didefinisikan ulang di sini. Satu skema hash
 * = satu sumber angka, supaya penyesuaian iterasi per 03-rbac.md §4 tidak
 * menyisakan versi kedua yang bikin hash lama gagal diverifikasi.
 */

/**
 * Satu-satunya implementasi. Dipakai 90_Setup.gs, login, dan changePin.
 * @param {string} pin
 * @param {string} saltB64
 * @param {number=} version PIN_Version milik hash yang sedang diverifikasi.
 *                          Kosongkan untuk membuat hash BARU (pakai versi aktif).
 */
function hashPin_(pin, saltB64, version) {
  const iterations = pinIterations_(version || PIN_HASH_VERSION);
  const pepper = scriptProp_('PIN_PEPPER');
  let acc = Utilities.base64Decode(saltB64)
    .concat(Utilities.newBlob(String(pin) + pepper).getBytes());
  for (let i = 0; i < iterations; i++) {
    acc = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, acc);
  }
  return Utilities.base64Encode(acc);
}

/** Alias ke generateSalt_ (00_Config.gs) — sumber acak yang lebih baik dari Math.random. */
function newSalt_() { return generateSalt_(); }

/** 6 digit; tolak semua digit sama, berurutan naik/turun, dan 000000. */
function validatePinFormat_(pin) {
  const p = String(pin || '');
  if (!/^\d{6}$/.test(p)) throw new AppError('VALIDATION', 'PIN harus 6 digit angka.');
  if (p === '000000') throw new AppError('VALIDATION', 'PIN terlalu mudah ditebak.');
  if (/^(\d)\1{5}$/.test(p)) throw new AppError('VALIDATION', 'PIN tidak boleh semua digit sama.');
  const asc = '01234567890', desc = '09876543210';
  if (asc.indexOf(p) !== -1 || desc.indexOf(p) !== -1)
    throw new AppError('VALIDATION', 'PIN tidak boleh berurutan.');
  return p;
}

function publicUser_(u, areas) {
  return { userId: u.User_ID, fullName: u.Full_Name, role: u.Role,
           dealerId: u.Dealer_ID || '', dealerName: u.Dealer_Name || '',
           area: (areas || []).join(', '), email: u.Email };
}

var Auth_ = {

  /** auth.login — payload { email, pin } */
  login: function (ctx, payload) {
    const email = String(payload.email || '').trim().toLowerCase();
    const pin = String(payload.pin || '');
    if (!email || !pin) throw new AppError('VALIDATION', 'Email dan PIN wajib diisi.');

    Rate_.hit('login:' + email, 10, 900,
      'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.');

    // Pesan error email-tidak-ada dan PIN-salah HARUS sama persis (03-rbac.md §4).
    const GENERIC = 'Email atau PIN salah.';
    const u = TC.filter(TC.S.USERS, function (r) {
      return String(r.Email).trim().toLowerCase() === email && r.Status !== 'INACTIVE';
    })[0];
    if (!u) {
      Audit_.log({ user: null }, 'LOGIN_FAILED', email, 'DENIED', 'email tidak dikenal');
      throw new AppError('UNAUTHENTICATED', GENERIC);
    }
    if (u.Status === 'SUSPENDED') {
      Audit_.log({ user: { userId: u.User_ID } }, 'LOGIN_FAILED', email, 'DENIED', 'suspended');
      throw new AppError('FORBIDDEN', 'Akun Anda dinonaktifkan. Hubungi IIDI Technical Manager.');
    }

    const lockedUntil = TC.parseIso(u.Locked_Until);
    if (lockedUntil && lockedUntil > new Date()) {
      const mins = Math.ceil((lockedUntil - new Date()) / 60000);
      throw new AppError('LOCKED', 'Akun terkunci. Coba lagi dalam ' + mins + ' menit.');
    }

    const pinVersion = Number(u.PIN_Version || 1);
    if (!Session_.safeEqual(hashPin_(pin, u.PIN_Salt, pinVersion), u.PIN_Hash)) {
      Auth_._registerFailure(u);
      Audit_.log({ user: { userId: u.User_ID } }, 'LOGIN_FAILED', email, 'DENIED', 'PIN salah');
      throw new AppError('UNAUTHENTICATED', GENERIC);
    }

    // Rehash transparan ke versi aktif. Hanya bisa dilakukan di sini, karena
    // ini satu-satunya titik di mana PIN mentah tersedia. User tidak perlu
    // tahu, tidak perlu ganti PIN, dan login berikutnya jadi lebih cepat.
    if (pinVersion !== PIN_HASH_VERSION) {
      const newSaltB64 = generateSalt_();
      TC.update(TC.S.USERS, u._row, {
        PIN_Hash: hashPin_(pin, newSaltB64),
        PIN_Salt: newSaltB64,
        PIN_Version: String(PIN_HASH_VERSION),
        Updated_At: TC.nowIso()
      });
    }

    const areas = Guard_.areasOf(u);
    TC.update(TC.S.USERS, u._row, {
      Failed_Attempts: '0', Locked_Until: '', Last_Login_At: TC.nowIso()
    });
    const sess = Session_.create(
      { userId: u.User_ID, role: u.Role, dealerId: u.Dealer_ID, areas: areas },
      payload.uaHint);
    Audit_.log({ user: { userId: u.User_ID } }, 'LOGIN_SUCCESS', email, 'OK', '');

    return { token: sess.token, expiresAt: sess.expiresAt,
             user: publicUser_(u, areas), mustChangePin: u.Must_Change_PIN === 'TRUE' };
  },

  _registerFailure: function (u) {
    const max = TC.cfgNum('MAX_FAILED_ATTEMPTS', 5);
    const mins = TC.cfgNum('LOCKOUT_MINUTES', 15);
    const n = Number(u.Failed_Attempts || 0) + 1;
    const patch = { Failed_Attempts: String(n) };
    if (n >= max) {
      const until = new Date(Date.now() + mins * 60000);
      patch.Locked_Until = TC.isoOf(until);
      patch.Failed_Attempts = '0';
      Audit_.log({ user: { userId: u.User_ID } }, 'ACCOUNT_LOCKED', u.Email, 'DENIED',
                 n + ' percobaan gagal');
      const subj = '[MB T-CASE] Akun terkunci sementara';
      const body = 'Akun ' + u.Email + ' terkunci sampai ' + TC.isoOf(until) +
                   ' setelah ' + n + ' percobaan PIN salah.';
      AuthMail_.queue(u.User_ID, u.Email, subj, body);
      TC.filter(TC.S.USERS, function (r) {
        return r.Role === 'IIDI_Tech_Mgr' && r.Status === 'ACTIVE';
      }).forEach(function (m) { AuthMail_.queue(m.User_ID, m.Email, subj, body); });
    }
    TC.update(TC.S.USERS, u._row, patch);
  },

  /** auth.logout */
  logout: function (ctx, payload, token) {
    if (token) Session_.revokeToken(token);
    return {};
  },

  /** auth.me */
  me: function (ctx) {
    return { user: {
      userId: ctx.user.userId, fullName: ctx.user.fullName, role: ctx.user.role,
      dealerId: ctx.user.dealerId, dealerName: ctx.user.dealerName,
      area: ctx.user.areas.join(', '), email: ctx.user.email,
      mustChangePin: ctx.user.mustChangePin
    }, permissions: PERMISSIONS[ctx.user.role] || {} };
  },

  /** auth.changePin — { oldPin, newPin } */
  changePin: function (ctx, payload) {
    const oldPin = String(payload.oldPin || '');
    const newPin = validatePinFormat_(payload.newPin);
    if (oldPin === newPin) throw new AppError('VALIDATION', 'PIN baru harus berbeda dari PIN lama.');

    const u = TC.find(TC.S.USERS, 'User_ID', ctx.user.userId);
    if (!u) throw new AppError('NOT_FOUND', 'User tidak ditemukan.');
    if (!Session_.safeEqual(hashPin_(oldPin, u.PIN_Salt, u.PIN_Version), u.PIN_Hash))
      throw new AppError('UNAUTHENTICATED', 'PIN lama salah.');

    const salt = newSalt_();
    TC.withLock(function () {
      TC.update(TC.S.USERS, u._row, {
        PIN_Hash: hashPin_(newPin, salt), PIN_Salt: salt,
        PIN_Version: String(PIN_HASH_VERSION),
        Must_Change_PIN: 'FALSE', Failed_Attempts: '0', Locked_Until: '',
        Updated_At: TC.nowIso()
      });
    });
    Session_.revokeAllForUser(ctx.user.userId, ctx.sid);
    Session_.invalidateSid(ctx.sid);   // ctx lama masih membawa mustChangePin: true
    Audit_.log(ctx, 'PIN_CHANGED', ctx.user.userId, 'OK', '');
    return {};
  }
};

/** Rate limit sederhana berbasis CacheService — 03-rbac.md §6. */
var Rate_ = {
  hit: function (key, max, windowSec, message) {
    const c = CacheService.getScriptCache();
    const k = 'rl_' + Utilities.base64EncodeWebSafe(key);
    const n = Number(c.get(k) || 0) + 1;
    c.put(k, String(n), windowSec);
    if (n > max) throw new AppError('RATE_LIMIT', message);
  }
};

// ── Utilitas manual (jalankan dari editor GAS, bukan dari router) ────────────

/** Cek apakah hash admin hasil Fase 0 cocok dengan hashPin_ di file ini. */
function verifyAdminPinHash() {
  const email = 'customerservicesmarketing@gmail.com';
  const u = TC.filter(TC.S.USERS, function (r) {
    return String(r.Email).toLowerCase() === email;
  })[0];
  if (!u) { console.log('FAIL: admin tidak ditemukan'); return; }
  const t0 = Date.now();
  const ok = Session_.safeEqual(hashPin_('481336', u.PIN_Salt, u.PIN_Version), u.PIN_Hash);
  console.log((ok ? 'PASS' : 'FAIL') + ' - hash cocok=' + ok +
              ', PIN_Version=' + (u.PIN_Version || 1) +
              ', durasi=' + (Date.now() - t0) + 'ms (target < 3000ms)');
}

/** Kalau verifyAdminPinHash() FAIL, jalankan ini sekali. */
function regenerateAdminPin(pin) {
  const p = validatePinFormat_(pin || '481336');
  const u = TC.filter(TC.S.USERS, function (r) {
    return String(r.Email).toLowerCase() === 'customerservicesmarketing@gmail.com';
  })[0];
  if (!u) throw new AppError('NOT_FOUND', 'Admin tidak ditemukan.');
  const salt = newSalt_();
  TC.update(TC.S.USERS, u._row, {
    PIN_Hash: hashPin_(p, salt), PIN_Salt: salt, PIN_Version: String(PIN_HASH_VERSION),
   Must_Change_PIN: 'TRUE', Failed_Attempts: '0', Locked_Until: '', Updated_At: TC.nowIso()
  });
  console.log('PIN admin di-hash ulang. Login pakai ' + p + ', wajib ganti PIN.');
}

/** Jalankan DULU untuk lihat Dealer_ID yang sah. */
function listDealers() {
  TC.readAll(TC.S.DEALERS).forEach(function (d) {
    console.log(d.Dealer_ID + ' | ' + d.Dealer_Name + ' | ' + d.Area + ' | ' + d.Status);
  });
}

/** Diagnosa Bug 2. Jalankan SETELAH ganti PIN gagal, tanpa menutup browser. */
function diagPinState() {
  const EMAIL = 'dealertest2@inchcape.co.id';

  TC.invalidate(TC.S.USERS);
  TC.invalidate(TC.S.SESSIONS);

  const u = TC.filter(TC.S.USERS, function (r) {
    return String(r.Email).trim().toLowerCase() === EMAIL;
  })[0];
  if (!u) { console.log('User tidak ada.'); return; }

  console.log('A. Must_Change_PIN di sheet : ' + u.Must_Change_PIN);
  console.log('B. invalidateSid ter-push   : ' + (typeof Session_.invalidateSid === 'function'));

  const cache = CacheService.getScriptCache();
  const rows = TC.filter(TC.S.SESSIONS, function (r) {
    return r.User_ID === u.User_ID && r.Revoked !== 'TRUE';
  });
  console.log('C. Sesi aktif: ' + rows.length);
  rows.forEach(function (r) {
    const raw = cache.get('sess_' + r.Token_Hash);
    let flag = '(tidak ada di cache)';
    if (raw) {
      try { flag = 'mustChangePin=' + JSON.parse(raw).user.mustChangePin; }
      catch (e) { flag = '(cache rusak)'; }
    }
    console.log('   ' + r.Session_ID.slice(0, 8) + ' | ' + flag);
  });
}

/** Isi OBJ, lalu Run. Dealer_Name diambil dari sheet, tidak diketik ulang. */
function createUserManual() {
  const OBJ = {
    fullName: 'Budi Santoso',
    role:     'CDT',              // CDT | Senior_Tech | Dealer_SM | IIDI_Tech | IIDI_Tech_Mgr | IIDI_Area_Mgr | IIDI_Director
    dealerId: 'DLR-CAR-01',       // '' untuk role IIDI_*
    email:    'dealertest2@inchcape.co.id',
    phoneWa:  '628123456789',
    pin:      '481336'
  };

  const pin   = validatePinFormat_(OBJ.pin);
  const email = String(OBJ.email).trim().toLowerCase();
  if (!PERMISSIONS[OBJ.role]) throw new AppError(ERROR_CODES.VALIDATION, 'Role tidak dikenal: ' + OBJ.role);

  let dealerName = '';
  if (OBJ.dealerId) {
    const d = TC.find(TC.S.DEALERS, 'Dealer_ID', OBJ.dealerId);
    if (!d) throw new AppError(ERROR_CODES.NOT_FOUND, 'Dealer_ID tidak ada di DEALERS: ' + OBJ.dealerId);
    dealerName = d.Dealer_Name;
  } else if (OBJ.role.indexOf('IIDI_') !== 0) {
    throw new AppError(ERROR_CODES.VALIDATION, 'Role dealer wajib punya Dealer_ID.');
  }

  const dup = TC.filter(TC.S.USERS, function (r) {
    return String(r.Email).trim().toLowerCase() === email && r.Status !== 'INACTIVE';
  })[0];
  if (dup) throw new AppError(ERROR_CODES.VALIDATION, 'Email sudah dipakai oleh ' + dup.User_ID);

  let max = 0;
  TC.readAll(TC.S.USERS).forEach(function (r) {
    const m = /^U-(\d+)$/.exec(String(r.User_ID).trim());
    if (m) max = Math.max(max, Number(m[1]));
  });
  const userId = 'U-' + ('0000' + (max + 1)).slice(-4);

  const salt = newSalt_();
  const ts   = TC.nowIso();
  TC.withLock(function () {
    TC.append(TC.S.USERS, {
      User_ID: userId, Full_Name: OBJ.fullName, Role: OBJ.role,
      Dealer_ID: OBJ.dealerId || '', Dealer_Name: dealerName,
      Email: email, Phone_WA: String(OBJ.phoneWa || ''),
      PIN_Hash: hashPin_(pin, salt), PIN_Salt: salt,
      PIN_Version: String(PIN_HASH_VERSION),
      Status: 'ACTIVE', Must_Change_PIN: 'TRUE',
      Failed_Attempts: '0', Locked_Until: '', Notif_Level: 'All',
      Created_At: ts, Updated_At: ts, Last_Login_At: ''
    });
    TC.flush();
  });
  console.log('OK ' + userId + ' | ' + email + ' | PIN sementara ' + pin + ' (wajib ganti saat login)');
}
