# 03 — Role, Akses, dan Keamanan

## 1. Role

| Role | Pihak | Scope data |
|---|---|---|
| `CDT` | Dealer | Case di dealer sendiri |
| `Senior_Tech` | Dealer | Case di dealer sendiri |
| `Dealer_SM` | Dealer | Case di dealer sendiri (semua user) |
| `IIDI_Tech` | Distributor | Semua dealer |
| `IIDI_Tech_Mgr` | Distributor | Semua dealer |
| `IIDI_Area_Mgr` | Distributor | Dealer di area-nya saja |
| `IIDI_Director` | Distributor | Semua dealer, read-only + approval |

## 2. Matrix permission

✅ boleh · ⛔ tidak · 🔸 dengan syarat

| Aksi | CDT | Senior_Tech | Dealer_SM | IIDI_Tech | IIDI_Tech_Mgr | IIDI_Area_Mgr | IIDI_Director |
|---|---|---|---|---|---|---|---|
| Buat case | ✅ | ✅ | ✅ | ⛔ | ⛔ | ⛔ | ⛔ |
| Edit case (sebelum submit) | 🔸 milik sendiri | ✅ dealer-nya | ✅ dealer-nya | ⛔ | ⛔ | ⛔ | ⛔ |
| Lihat case dealer sendiri | ✅ | ✅ | ✅ | ✅ | ✅ | 🔸 area-nya | ✅ |
| Lihat case dealer lain | ⛔ | ⛔ | ⛔ | ✅ | ✅ | 🔸 area-nya | ✅ |
| Set priority | ✅ | ✅ | ✅ | ⛔ | 🔸 usul saja | ⛔ | ⛔ |
| Kirim ke IIDI | ✅ | ✅ | ✅ | ⛔ | ⛔ | ⛔ | ⛔ |
| Ambil case (assign diri) | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ⛔ | ⛔ |
| Assign ke orang lain | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ⛔ | ⛔ |
| Request additional data | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ⛔ | ⛔ |
| Penuhi data request | 🔸 case sendiri | 🔸 case sendiri | ✅ dealer-nya | ⛔ | ⛔ | ⛔ | ⛔ |
| Balas thread | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Thread `IIDI_Only` | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ | ✅ |
| Upload lampiran | ✅ | ✅ | ✅ | ✅ | ✅ | ⛔ | ⛔ |
| Hapus lampiran | 🔸 milik sendiri | 🔸 milik sendiri | 🔸 dealer-nya | 🔸 milik sendiri | ✅ | ⛔ | ⛔ |
| Eskalasi ke MBAG | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ⛔ | ⛔ |
| Update info MBAG | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ⛔ | ⛔ |
| Ajukan closure | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ⛔ | ⛔ |
| Konfirmasi closure | ✅ | ✅ | ✅ | ⛔ | 🔸 override | ⛔ | ⛔ |
| Reopen case | ⛔ | ⛔ | 🔸 ≤7 hari | ✅ | ✅ | ⛔ | ⛔ |
| Dashboard dealer | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Dashboard distributor | ⛔ | ⛔ | ⛔ | ✅ | ✅ | 🔸 area-nya | ✅ |
| Buat artikel KB | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ⛔ | ⛔ |
| Kelola user | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ⛔ | ⛔ |
| Lihat audit log | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ⛔ | ✅ |
| Export data | ⛔ | ⛔ | 🔸 dealer-nya | ✅ | ✅ | 🔸 area-nya | ✅ |
> **REVISI (Fase 5):** baris "Penuhi data request" ditambahkan. Sebelumnya matrix
> ini punya "Request additional data" (sisi IIDI) tapi tidak punya sisi dealernya,
> jadi `request.fulfill` tidak punya perm key. Key di `PERMISSIONS`:
> `request.fulfill`, aktif untuk `CDT`, `Senior_Tech`, dan `Dealer_SM`.
> Syarat 🔸 ("case sendiri") ditegakkan di `Request_.fulfill`, bukan di matrix:
> selain `Dealer_SM`, hanya `Created_By_User_ID` yang boleh memenuhi permintaan.
## 3. Penegakan di backend

Dua guard wajib. Tidak boleh ada handler case yang melewatinya.

```js
// Guard 1 — apakah role ini boleh melakukan aksi ini?
function requirePerm_(ctx, perm) {
  if (!PERMISSIONS[ctx.user.role] || !PERMISSIONS[ctx.user.role][perm]) {
    Audit_.log(ctx, 'ACCESS_DENIED', perm, 'DENIED');
    throw new AppError('FORBIDDEN', 'Role Anda tidak memiliki akses untuk aksi ini.');
  }
}

// Guard 2 — apakah user ini boleh menyentuh case ini?
function assertCanAccessCase_(ctx, caseRow) {
  const role = ctx.user.role;

  if (role.indexOf('IIDI_') === 0) {
    if (role === 'IIDI_Area_Mgr') {
      const dealer = Dealers_.get(caseRow.Dealer_ID);
      // ctx.user.areas = array, diturunkan dari DEALERS.Area_Manager_User_ID
      if (ctx.user.areas.indexOf(dealer.Area) === -1) denyCase_(ctx, caseRow);
    }
    return;
  }
  if (caseRow.Dealer_ID !== ctx.user.dealerId) denyCase_(ctx, caseRow);
}
```

**Aturan mutlak:** `Dealer_ID`, `role`, `userId` **selalu** diambil dari `ctx` hasil validasi
token. Tidak pernah dari `payload`. Kalau frontend mengirim field ini, backend membuangnya
tanpa peringatan.

Test wajib di fase 1: login sebagai dealer A, panggil `case.get` dengan `caseNo` milik
dealer B → harus `FORBIDDEN` dan tercatat di `AUDIT_LOG`.

## 4. Skema PIN

PIN 6 digit hanya punya 1 juta kombinasi. Hashing saja tidak cukup — **lockout wajib**.

### Hashing
```js
const PEPPER = PropertiesService.getScriptProperties().getProperty('PIN_PEPPER');
const ITERATIONS = 10000;

function hashPin_(pin, saltB64) {
  let acc = Utilities.base64Decode(saltB64).concat(
    Utilities.newBlob(pin + PEPPER).getBytes()
  );
  for (let i = 0; i < ITERATIONS; i++) {
    acc = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, acc);
  }
  return Utilities.base64Encode(acc);
}
```

- Salt: 16 byte random per user, disimpan di `PIN_Salt`.
- Pepper: satu nilai global di Script Properties, **tidak** di sheet.
- Bandingkan dengan constant-time compare, bukan `===` langsung.
- 10.000 iterasi memakan ~0,5–1,5 detik di GAS. Ini wajar dan hanya terjadi saat login.
  Kalau ternyata > 3 detik, turunkan ke 5.000 dan catat di `PIN_Version`.

REVISI (Fase 1): iterasi diturunkan dari 10.000 ke 5.000, dicatat sebagai PIN_Version = 2.
Alasan: 10.000 iterasi terukur 5,6–6,4 detik di GAS (jauh di atas perkiraan 0,5–1,5 detik),
membuat auth.login mendekati batas 8 detik CLAUDE.md §3.7. Dengan 5.000 iterasi, login
end-to-end terukur 6.474 ms. Iterasi disimpan per versi di PIN_HASH_ITERATIONS_BY_VERSION
(00_Config.gs), sehingga hash v1 lama tetap terverifikasi. auth.login melakukan rehash
transparan ke versi aktif setelah PIN cocok — user tidak perlu ganti PIN.

### Aturan PIN
- 6 digit angka.
- Tolak: semua digit sama (`111111`), berurutan (`123456`, `654321`), dan `000000`.
- User baru: `Must_Change_PIN = TRUE`, wajib ganti sebelum bisa aksi apapun.
- Ganti PIN mencabut semua sesi lain.

### Lockout
- `Failed_Attempts` naik tiap PIN salah.
- Mencapai `MAX_FAILED_ATTEMPTS` (5) → `Locked_Until = now + 15 menit`, tulis
  `ACCOUNT_LOCKED` ke `AUDIT_LOG`, kirim email ke user dan ke IIDI_Tech_Mgr.
- Login sukses → reset `Failed_Attempts` ke 0.
- Pesan error untuk PIN salah dan User_ID tidak ada **harus sama persis**
  ("User ID atau PIN salah") supaya tidak bocor user mana yang ada.

## 5. Session token

Format JWT-like, HMAC-SHA256:
```
base64url(header) . base64url(payload) . base64url(HMAC-SHA256(secret, header + '.' + payload))
```

Payload: `{ sid, uid, role, dlr, area, iat, exp }`

- Secret di Script Properties (`JWT_SECRET`), minimal 32 byte random.
- TTL 8 jam.
- Setiap request: verifikasi signature → cek `exp` → cek baris `SESSIONS` (`Revoked = FALSE`,
  belum kadaluarsa) → refresh `Last_Seen_At`.
- **Cek sheet tetap dilakukan** meski signature valid, supaya logout dan pencabutan sesi
  benar-benar berlaku.
- Optimasi: cache hasil validasi di `CacheService` selama 60 detik dengan key
  `sess_<hash token>`, dan hapus key itu saat logout.
- `logout` → `Revoked = TRUE` + hapus cache.

## 6. Rate limit

Pakai `CacheService` sebagai penghitung sederhana:
- `auth.login`: maks 10 percobaan per User_ID per 15 menit → `RATE_LIMIT`.
- `attach.upload`: maks 30 per user per jam.
- `advisory.get` dengan `force=true`: maks 5 per case per hari.
