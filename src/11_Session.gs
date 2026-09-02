/**
 * 11_Session.gs — token JWT-like HMAC-SHA256. Acuan: 03-rbac.md §5.
 * Payload: { sid, uid, role, dlr, area, iat, exp }
 */
var Session_ = (function () {
  // 03-rbac.md §5 menyarankan 60 detik. Dinaikkan ke 300 detik: cache-miss
  // berbiaya ~1-3 detik (baca SESSIONS + USERS), jadi 60 detik membuat user
  // aktif membayar ongkos itu tiap menit. Konsekuensinya logout/pencabutan
  // sesi baru benar-benar berlaku setelah maks 5 menit -- kecuali di device
  // yang melakukan logout, karena logout menghapus key cache-nya langsung.
  const CACHE_SEC = 300;

  function b64u_(bytes) { return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, ''); }
  function b64uStr_(str) { return b64u_(Utilities.newBlob(str).getBytes()); }
  function b64uParse_(s) {
    const pad = s + '==='.slice((s.length + 3) % 4);
    return Utilities.newBlob(Utilities.base64DecodeWebSafe(pad)).getDataAsString();
  }
  function sign_(data) {
    return b64u_(Utilities.computeHmacSha256Signature(data, TC.prop('JWT_SECRET')));
  }
  function sha256b64_(str) {
    return Utilities.base64Encode(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8));
  }
   /** Constant-time compare — implementasi tunggal ada di 00_Config.gs. */
  function safeEqual_(a, b) { return constantTimeEquals_(a, b); }

  function create(user, uaHint) {
    const ttl = TC.cfgNum('SESSION_TTL_HOURS', 8);
    const sid = Utilities.getUuid();
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + ttl * 3600;
    const payload = { sid: sid, uid: user.userId, role: user.role,
                      dlr: user.dealerId || '', area: (user.areas || []).join('|'),
                      iat: iat, exp: exp };
    const head = b64uStr_(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = b64uStr_(JSON.stringify(payload));
    const token = head + '.' + body + '.' + sign_(head + '.' + body);
    const expiresAt = TC.isoOf(new Date(exp * 1000));

    // Tanpa LockService. CLAUDE.md §3.5 mewajibkan lock untuk semua append,
    // tapi alasan aturan itu adalah operasi baca-hitung-tulis seperti penomoran
    // Case_No. SESSIONS memakai UUID sebagai PK dan appendRow() sendiri sudah
    // atomik, jadi lock di sini tidak melindungi apapun -- hanya menambah
    // ~200-300ms dan mengantrekan login yang berbarengan.
    TC.append(TC.S.SESSIONS, {
      Session_ID: sid, User_ID: user.userId, Token_Hash: sha256b64_(token),
      Issued_At: TC.isoOf(new Date(iat * 1000)), Expires_At: expiresAt,
      Last_Seen_At: TC.nowIso(), Revoked: 'FALSE',
      UA_Hint: String(uaHint || '').slice(0, 60)
    });
    return { token: token, expiresAt: expiresAt, sid: sid };
  }

  /** Verifikasi penuh: signature → exp → baris SESSIONS → USERS. */
  function validate(token) {
    if (!token) throw new AppError('UNAUTHENTICATED', 'Sesi tidak ditemukan. Silakan login ulang.');
    const cacheKey = 'sess_' + sha256b64_(token);
    const cache = CacheService.getScriptCache();
    const hit = cache.get(cacheKey);
    if (hit) return JSON.parse(hit);

   // SESSIONS + USERS dalam SATU round-trip. Keduanya PASTI dibaca di jalur
    // cache-miss ini, jadi tidak ada pembacaan yang mubazir. Diukur: dua
    // getValues() terpisah ~850 ms, batchGet ~250 ms.
    TC.preload([TC.S.SESSIONS, TC.S.USERS]);

    const parts = String(token).split('.');
    if (parts.length !== 3) throw new AppError('UNAUTHENTICATED', 'Sesi tidak valid.');
    if (!safeEqual_(parts[2], sign_(parts[0] + '.' + parts[1])))
      throw new AppError('UNAUTHENTICATED', 'Sesi tidak valid.');

    let p;
    try { p = JSON.parse(b64uParse_(parts[1])); }
    catch (e) { throw new AppError('UNAUTHENTICATED', 'Sesi tidak valid.'); }
    if (!p.exp || p.exp * 1000 <= Date.now())
      throw new AppError('UNAUTHENTICATED', 'Sesi Anda sudah berakhir. Silakan login ulang.');

    // Cek sheet TETAP dilakukan supaya logout & pencabutan sesi benar-benar berlaku.
    // cacheKey sudah berisi hash yang sama — hitung sekali, pakai ulang.
    const row = TC.find(TC.S.SESSIONS, 'Token_Hash', cacheKey.slice(5));
    if (!row) throw new AppError('UNAUTHENTICATED', 'Sesi tidak dikenal. Silakan login ulang.');
    if (row.Revoked === 'TRUE') throw new AppError('UNAUTHENTICATED', 'Sesi sudah dicabut.');
    if (TC.parseIso(row.Expires_At) <= new Date())
      throw new AppError('UNAUTHENTICATED', 'Sesi Anda sudah berakhir.');

    const u = TC.find(TC.S.USERS, 'User_ID', p.uid);
    if (!u) throw new AppError('UNAUTHENTICATED', 'User tidak ditemukan.');
    if (u.Status !== 'ACTIVE') throw new AppError('FORBIDDEN', 'Akun Anda tidak aktif.');

    const ctx = {
      sid: p.sid,
      user: {
        userId: u.User_ID, fullName: u.Full_Name, role: u.Role,
        dealerId: u.Dealer_ID || '', dealerName: u.Dealer_Name || '',
        email: u.Email, areas: p.area ? p.area.split('|') : [],
        mustChangePin: u.Must_Change_PIN === 'TRUE'
      },
      _sessionRow: row._row
    };
    // Last_Seen_At di-update paling sering sekali per 5 menit, bukan tiap
    // request. Kolom ini cuma untuk housekeeping (01-schema.md §3), tidak
    // dipakai logika manapun -- menulisnya tiap kali menambah satu round-trip
    // sheet (~300ms) ke SETIAP panggilan API yang cache-nya sudah habis.
    const lastSeen = TC.parseIso(row.Last_Seen_At);
    if (!lastSeen || (Date.now() - lastSeen.getTime()) > 300000) {
      TC.update(TC.S.SESSIONS, row._row, { Last_Seen_At: TC.nowIso() });
    }
    cache.put(cacheKey, JSON.stringify(ctx), CACHE_SEC);
    return ctx;
  }

  function revokeToken(token) {
    const row = TC.find(TC.S.SESSIONS, 'Token_Hash', sha256b64_(token));
    if (row) TC.update(TC.S.SESSIONS, row._row, { Revoked: 'TRUE' });
    CacheService.getScriptCache().remove('sess_' + sha256b64_(token));
  }

  /**
   * Buang cache ctx sesi berjalan tanpa mencabutnya. Dipakai ketika atribut
   * user berubah di tengah sesi (ganti PIN, ganti role) — tanpa ini ctx lama
   * masih dipakai sampai CACHE_SEC habis. Token tidak dibawa ctx, jadi
   * hash-nya diambil dari baris SESSIONS lewat Session_ID.
   */
  function invalidateSid(sid) {
    const row = TC.find(TC.S.SESSIONS, 'Session_ID', sid);
    if (row) CacheService.getScriptCache().remove('sess_' + row.Token_Hash);
  }

  /** Ganti PIN mencabut semua sesi lain — 03-rbac.md §4. */
  function revokeAllForUser(userId, exceptSid) {
    TC.filter(TC.S.SESSIONS, function (r) {
      return r.User_ID === userId && r.Revoked !== 'TRUE' && r.Session_ID !== exceptSid;
    }).forEach(function (r) { TC.update(TC.S.SESSIONS, r._row, { Revoked: 'TRUE' }); });
  }

  return { create: create, validate: validate, revokeToken: revokeToken,
           revokeAllForUser: revokeAllForUser, invalidateSid: invalidateSid,
           safeEqual: safeEqual_, sha256b64: sha256b64_ };
})();