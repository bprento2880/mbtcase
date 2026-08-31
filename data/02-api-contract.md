# 02 — Kontrak API

Frontend dan backend wajib mengikuti file ini persis. Kalau butuh action baru,
tambahkan ke file ini dulu.

> **Revisi Fase 0:** 2 perubahan, ditandai blok `> **REVISI (Fase 0)**`:
> 1. `auth.login` — payload berubah dari `{ userId, pin }` menjadi `{ email, pin }`
>    (login memakai email, sesuai `01-schema.md` §1).
> 2. Attachment — action baru `attach.initUpload` / `attach.completeUpload` untuk
>    file > `MAX_INLINE_UPLOAD_MB`, melengkapi `attach.upload` yang tetap dipakai
>    untuk file kecil.

## 1. Transport

Satu endpoint, satu bentuk request.

```
POST https://afs-digitalsolution.web.id/tcase/
Content-Type: text/plain;charset=utf-8

{ "action": "case.list", "token": "<session token>", "payload": { ... } }
```

- `Content-Type` **harus** `text/plain`. Alasan: `docs/../CLAUDE.md` bagian 3.2.
- Token di body, **bukan di header**. Alasan: CLAUDE.md bagian 3.1.
- `doGet` hanya melayani `?page=` untuk memuat SPA. Tidak ada data API lewat GET.

## 2. Bentuk response

Sukses:
```json
{ "ok": true, "data": { ... }, "meta": { "serverTime": "2026-08-30T09:15:00+07:00" } }
```

Gagal:
```json
{ "ok": false, "error": { "code": "FORBIDDEN", "message": "Anda tidak punya akses ke case ini." } }
```

HTTP status selalu 200 (keterbatasan GAS). Frontend membaca `ok`, bukan status code.

## 3. Kode error standar

| Code | Arti | Aksi frontend |
|---|---|---|
| `UNAUTHENTICATED` | Token kosong/kadaluarsa/dicabut | Redirect ke login |
| `FORBIDDEN` | Role atau scope tidak mengizinkan | Tampilkan pesan, jangan retry |
| `NOT_FOUND` | Entitas tidak ada | |
| `VALIDATION` | Input tidak valid. `error.fields` berisi detail per field | Tandai field |
| `CONFLICT` | Transisi status ilegal / data sudah berubah | Refresh lalu coba lagi |
| `LOCKED` | Akun terkunci sementara | Tampilkan sisa waktu |
| `RATE_LIMIT` | Terlalu banyak percobaan | |
| `BUSY` | LockService gagal | Auto-retry 1x setelah 2 detik |
| `UPSTREAM` | Gemini / Drive gagal | Degradasi halus, jangan blokir alur |
| `INTERNAL` | Lainnya | Tampilkan pesan umum + log |

## 4. Daftar action

### Auth
| Action | Payload | Data |
|---|---|---|
| `auth.login` | `{ email, pin }` | `{ token, expiresAt, user, mustChangePin }` |
| `auth.logout` | `{}` | `{}` |
| `auth.me` | `{}` | `{ user, permissions }` |
| `auth.changePin` | `{ oldPin, newPin }` | `{}` |

> **REVISI (Fase 0):**
> ```
> KODE LAMA:
> | auth.login | { userId, pin } | { token, expiresAt, user, mustChangePin } |
>
> KODE BARU:
> | auth.login | { email, pin } | { token, expiresAt, user, mustChangePin } |
> ```
> Alasan: login pakai email (lihat `01-schema.md` §1). Pesan error untuk email tidak
> ditemukan dan PIN salah **tetap harus sama persis** ("Email atau PIN salah") sesuai
> `03-rbac.md` §4, supaya tidak bocor email mana yang terdaftar.

`user` = `{ userId, fullName, role, dealerId, dealerName, area, email }`.
**Tidak pernah** menyertakan `PIN_Hash` atau `PIN_Salt`.

### Master data
| Action | Payload | Data |
|---|---|---|
| `master.bootstrap` | `{}` | `{ dealers, models, symptomCategories, evidenceTypes, roles, config }` |

Dipanggil sekali setelah login, di-cache di frontend. `models` diambil dari sheet
`VEHICLE_MODELS` (`01-schema.md` §2A), hanya baris `Active = TRUE`.

### Case
| Action | Payload | Data |
|---|---|---|
| `case.create` | `{ vehicle, complaint, diagnostics, priority }` | `{ caseNo, qualityScore, advisory }` |
| `case.get` | `{ caseNo }` | `{ case, diagnostics, sla, thread, attachments, dataRequests, escalation, advisory, similarCases }` |
| `case.list` | `{ filters, page, pageSize, sort }` | `{ items, total, page, pageSize }` |
| `case.update` | `{ caseNo, fields }` | `{ case, qualityScore }` |
| `case.transition` | `{ caseNo, toStatus, waitingReason, note }` | `{ case, sla }` |
| `case.assign` | `{ caseNo, toUserId }` | `{ case }` |
| `case.setPriority` | `{ caseNo, priority, reason }` | `{ case }` |

`case.create` **mengabaikan** `dealerId` dan `createdBy` jika dikirim frontend.
Keduanya diambil dari session.

`case.setPriority` hanya untuk role yang benar-benar mengubah field `Priority`
(dealer). Untuk `IIDI_Tech_Mgr` yang hanya boleh "usul" (`03-rbac.md` §2), pakai
`thread.post` dengan `messageType: 'Decision'` — lihat `01-schema.md` §6 dan §9
(`Priority_Suggested`). `case.setPriority` menolak role IIDI_* dengan `FORBIDDEN`.

`filters` yang didukung: `status[]`, `priority[]`, `dealerId[]`, `area[]`, `model`,
`symptomCategory`, `slaStatus[]`, `activityStatus[]`, `assignedToMe`, `dateFrom`, `dateTo`, `q`.
Backend tetap memaksa scope role di atas filter apapun.

`pageSize` maks 50.

### Diagnostics
| Action | Payload | Data |
|---|---|---|
| `diag.save` | `{ caseNo, fields }` | `{ diagnostics, qualityScore }` |

### Thread
| Action | Payload | Data |
|---|---|---|
| `thread.list` | `{ caseNo, since }` | `{ items }` |
| `thread.post` | `{ caseNo, message, parentId, messageType, visibility }` | `{ item }` |

`visibility: "IIDI_Only"` ditolak kalau role pemanggil bukan IIDI_*.

### Attachment

| Action | Payload | Data |
|---|---|---|
| `attach.upload` | `{ caseNo, threadId, evidenceType, fileName, mimeType, dataBase64 }` | `{ attachment }` |
| `attach.initUpload` | `{ caseNo, fileName, mimeType, sizeBytes, evidenceType }` | `{ uploadUrl, expiresInSeconds }` |
| `attach.completeUpload` | `{ caseNo, driveFileId, fileName, mimeType, sizeBytes, evidenceType, threadId }` | `{ attachment }` |
| `attach.list` | `{ caseNo }` | `{ items }` |
| `attach.delete` | `{ attachmentId }` | `{}` |

> **REVISI (Fase 0) — alur upload hybrid:**
> ```
> KODE LAMA:
> | attach.upload | { caseNo, threadId, evidenceType, fileName, mimeType, dataBase64 } | { attachment } |
> | attach.list | ... |
> | attach.delete | ... |
> (Maks 10 MB per file, cek di frontend dan backend)
>
> KODE BARU:
> + attach.initUpload, attach.completeUpload (lihat tabel di atas)
> Batas berubah jadi dua tingkat: attach.upload ≤ MAX_INLINE_UPLOAD_MB (default 5 MB),
> attach.initUpload/completeUpload ≤ MAX_RESUMABLE_UPLOAD_MB (default 100 MB).
> ```
> **Alasan & alur:**
> - **`attach.upload`** (base64 inline) dipakai untuk foto ≤ `MAX_INLINE_UPLOAD_MB`
>   (client wajib kompres dulu: resize sisi terpanjang ke ±2000px, JPEG quality ±82).
>   Satu round-trip, sederhana, cocok untuk mayoritas evidence.
> - **`attach.initUpload` → upload langsung ke `uploadUrl` → `attach.completeUpload`**
>   dipakai untuk file besar (umumnya video):
>   1. `attach.initUpload`: backend menjalankan `assertCanAccessCase_(ctx, caseNo)`
>      **dulu**, baru membuka sesi resumable ke Drive API v3 (`UrlFetchApp`, parent
>      folder = folder case yang benar) dan mengembalikan `uploadUrl` (session URI
>      Google, bukan API key/token akun manapun).
>   2. Client melakukan `PUT` langsung ke `uploadUrl` (bisa per-chunk). Body file
>      **tidak pernah** melewati `/exec`, jadi tidak kena batas payload/timeout GAS.
>   3. `attach.completeUpload`: client mengirim `driveFileId` hasil upload untuk
>      dicatat ke `CASE_ATTACHMENTS` (`Upload_Method = 'RESUMABLE'`). Kalau langkah
>      ini tidak pernah dipanggil, file jadi "yatim" di Drive — job housekeeping
>      Fase 4 wajib membersihkan file tanpa baris `CASE_ATTACHMENTS` setelah 24 jam.
> - Kredensial akun pemilik script **tidak pernah** dikirim ke browser di kedua alur.

Maks ukuran dicek di frontend **dan** backend. Hanya pengunggah atau IIDI_Tech_Mgr
yang boleh menghapus. Hapus = soft delete + trash file di Drive.

### Additional data request
| Action | Payload | Data |
|---|---|---|
| `request.create` | `{ caseNo, items[], note }` | `{ request, case }` |
| `request.fulfill` | `{ requestId, note, attachmentIds[] }` | `{ request, case }` |

`request.create` otomatis: status → `Waiting Dealer Reply`,
`Current_Waiting_Reason` → `Additional_Data`, set `Dealer_Response_Deadline`.

### Escalation
| Action | Payload | Data |
|---|---|---|
| `escalation.create` | `{ caseNo, reason }` | `{ escalation, packageFolderUrl }` |
| `escalation.update` | `{ escalationId, mbagRefNo, mbagStatus, mbagResponse }` | `{ escalation }` |

### Closure
| Action | Payload | Data |
|---|---|---|
| `closure.request` | `{ caseNo, solution, closureType }` | `{ case }` |
| `closure.confirm` | `{ caseNo, confirmed, note }` | `{ case }` |

### Advisory
| Action | Payload | Data |
|---|---|---|
| `advisory.get` | `{ caseNo, force }` | `{ source, priorityAdvice, recommendedEvidence[], notes, generatedAt }` |

Lihat `docs/07-ai-advisory.md`.

### Dashboard
| Action | Payload | Data |
|---|---|---|
| `dashboard.get` | `{ scope, period, filters }` | `{ cards, charts, tables, generatedAt, stale }` |

`scope`: `dealer` atau `distributor`. Backend memaksa `dealer` untuk role dealer,
apapun yang dikirim frontend.

### Knowledge base
| Action | Payload | Data |
|---|---|---|
| `kb.search` | `{ q, model, symptomCategory, dtc }` | `{ items }` |
| `kb.similar` | `{ caseNo }` | `{ items }` |
| `kb.create` | `{ caseNo, title, rootCause, solution, keywords }` | `{ kbId }` |

### Health
| Action | Payload | Data |
|---|---|---|
| `sys.ping` | `{}` | `{ version, serverTime, features }` |

## 5. Pola router backend

```js
function doPost(e) {
  let req = {};
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: { code: 'VALIDATION', message: 'Body tidak valid.' } });
  }

  try {
    const handler = ROUTES[req.action];
    if (!handler) throw new AppError('NOT_FOUND', 'Action tidak dikenal: ' + req.action);

    const ctx = PUBLIC_ACTIONS.has(req.action)
      ? { user: null }
      : Session_.validate(req.token);   // throw UNAUTHENTICATED kalau gagal

    const data = handler(ctx, req.payload || {});
    return json({ ok: true, data, meta: { serverTime: nowIso() } });

  } catch (err) {
    const e2 = (err instanceof AppError) ? err : new AppError('INTERNAL', 'Terjadi kesalahan sistem.');
    if (e2.code === 'INTERNAL') console.error(err.stack || err);
    Audit_.log(req.action, e2.code);
    return json({ ok: false, error: { code: e2.code, message: e2.message, fields: e2.fields } });
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
```

`PUBLIC_ACTIONS` hanya berisi `auth.login` dan `sys.ping`.

## 6. Pola client

```js
async function api(action, payload = {}) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, token: Store.token, payload })
  });
  const out = await res.json();
  if (!out.ok) {
    if (out.error.code === 'UNAUTHENTICATED') Store.logout();
    throw out.error;
  }
  return out.data;
}
```

Token disimpan di `sessionStorage`, bukan `localStorage`.
