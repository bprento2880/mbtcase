# MB T-CASE — Technical Case Escalation & Management System

Platform dukungan teknis internal. Alur bisnis: **Dealer → IIDI Technical → MBAG Escalation**.
Menggantikan support berbasis WhatsApp dengan sistem yang punya SLA, audit trail, dan dashboard.

---

## 1. Aturan main untuk Claude Code

**BACA DULU sebelum nulis kode apapun:**
- `docs/01-schema.md` — struktur sheet. Ini sumber kebenaran. Jangan pernah bikin kolom/sheet baru tanpa update file ini dulu.
- `docs/02-api-contract.md` — kontrak API. Frontend dan backend WAJIB ikut ini persis.
- `docs/03-rbac.md` — siapa boleh apa.
- `docs/04-state-machine.md` — transisi status yang legal.
- `docs/05-sla-engine.md` — perhitungan jam kerja.
- `docs/06-dashboard.md` — KPI per role.
- `docs/07-ai-advisory.md` — integrasi Gemini.
- `docs/08-notifications.md` — email + persiapan WA.

**Aturan kerja:**
1. Kerjakan **satu fase saja** per sesi (lihat bagian 7). Jangan lompat fase.
2. Kalau ada yang ambigu di spec, **berhenti dan tanya**. Jangan mengarang lalu lanjut.
3. Kalau spec perlu berubah, **update file docs dulu**, baru tulis kode.
4. Setiap fase selesai harus lewat acceptance checklist-nya sebelum lanjut.
5. Jangan pernah refactor besar tanpa diminta.

---

## 2. Stack & arsitektur

```
Browser
  → https://afs-digitalsolution.web.id/tcase/*   (custom domain)
  → Cloudflare Worker (reverse proxy, GATEWAY SAJA)
  → Google Apps Script Web App (/exec)
  → Router → Service layer → Google Sheets / Google Drive
```

- **Backend:** Google Apps Script (V8)
- **Database:** Google Sheets
- **File storage:** Google Drive
- **Frontend:** HTML5 SPA, **Alpine.js** (bukan vanilla, bukan React), TailwindCSS CDN, Chart.js, FontAwesome
- **AI Advisory:** Gemini API via `UrlFetchApp`
- **Deploy tooling:** `clasp` (kode ditulis lokal, di-push ke GAS)

**Cloudflare Worker itu gateway, titik.** Semua otorisasi ada di backend GAS. Worker tidak boleh
memutuskan siapa boleh lihat apa. Pakai ulang pola worker yang sudah jalan di project
`afs-digitalsolution` (path routing `/tcase/*`), jangan bikin dari nol.

---

## 3. Gotcha Google Apps Script yang WAJIB dipatuhi

Ini penyebab utama debug loop panjang. Baca pelan-pelan.

### 3.1 GAS tidak bisa membaca HTTP headers
`doGet(e)` / `doPost(e)` hanya menerima: `e.parameter`, `e.parameters`, `e.postData`,
`e.pathInfo`, `e.queryString`, `e.contentLength`.

**Tidak ada `e.headers`. Tidak ada cara membaca `Authorization`.**

→ Session token dikirim di dalam **body JSON** (POST) atau **query param** (GET). Titik.
→ Jangan pernah tulis `headers: { Authorization: ... }` di frontend.

### 3.2 Content-Type harus text/plain
`Content-Type: application/json` memicu CORS preflight `OPTIONS`, dan GAS tidak bisa merespons
`OPTIONS`. Semua POST dari frontend:

```js
fetch(API_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  body: JSON.stringify({ action, token, payload })
});
```

Backend: `const req = JSON.parse(e.postData.contents);`

### 3.3 Timezone
`appsscript.json` wajib berisi `"timeZone": "Asia/Jakarta"`. Semua timestamp disimpan sebagai
string ISO 8601 dengan offset (`2026-08-30T09:15:00+07:00`), bukan objek Date mentah,
bukan string lokal ambigu.

### 3.4 Tidak ada bcrypt / PBKDF2
Yang tersedia: `Utilities.computeDigest()` dan `Utilities.computeHmacSha256Signature()`.
Skema hashing PIN ada di `docs/03-rbac.md` bagian 4. Ikuti persis.

### 3.5 Semua write ke Sheet harus lewat LockService
```js
const lock = LockService.getScriptLock();
if (!lock.tryLock(20000)) throw new AppError('BUSY', 'Sistem sedang sibuk, coba lagi.');
try { /* write */ } finally { lock.releaseLock(); }
```
Wajib untuk: pembuatan Case_No, semua append row, semua update row.

### 3.6 Baca sheet sekali, filter di memory
```js
// BENAR
const rows = sheet.getDataRange().getValues();
const mine = rows.filter(r => r[DEALER_ID_COL] === dealerId);

// SALAH — kena quota, lambat
for (let i = 1; i <= n; i++) sheet.getRange(i, 1).getValue();
```

### 3.7 Target performa
Setiap endpoint harus selesai **< 8 detik**. Kalau ada yang lebih lama:
paginate, atau pindahkan ke snapshot yang di-refresh trigger.

### 3.8 Redirect /exec
GAS `/exec` membalas 302 ke `script.googleusercontent.com`. Worker harus `redirect: 'follow'`
dan meneruskan body + content-type hasil akhirnya. Pola ini sudah terbukti jalan di project
`afs-digitalsolution` — salin dari sana.

### 3.9 Rahasia disimpan di Script Properties
`PropertiesService.getScriptProperties()`. Tidak ada API key, pepper, atau JWT secret yang
di-hardcode di source code. Daftar key ada di `docs/00-getting-started.md`.

---

## 4. Struktur file source

```
src/
├── appsscript.json
├── 00_Config.gs           # konstanta, nama sheet, indeks kolom, baca Script Properties
├── 01_Router.gs           # doGet, doPost, dispatch action, error envelope
├── 02_Errors.gs           # AppError, kode error standar
├── 10_SheetDB.gs          # akses sheet generik: readAll, appendRow, updateRow, cache
├── 11_Session.gs          # buat/validasi/revoke token
├── 12_Auth.gs             # login, PIN hash, lockout, changePin
├── 13_Guard.gs            # requireRole, assertCanAccessCase
├── 20_CaseService.gs      # CRUD case, penomoran, state machine
├── 21_DiagService.gs      # diagnostics detail
├── 22_ThreadService.gs    # diskusi
├── 23_AttachService.gs    # Drive upload
├── 24_RequestService.gs   # additional data request
├── 25_EscalationService.gs# MBAG
├── 30_SlaEngine.gs        # PURE FUNCTIONS, tidak menyentuh sheet
├── 31_SlaJob.gs           # trigger: notifikasi near-due/overdue
├── 40_Advisory.gs         # rule-based evidence engine
├── 41_Gemini.gs           # Gemini API client
├── 50_Notify.gs           # queue + email sender + WA adapter stub
├── 60_Dashboard.gs        # agregasi + snapshot
├── 70_Kb.gs               # knowledge base + similar case
├── 90_Setup.gs            # bikin sheet, seed data, pasang trigger
├── 99_Tests.gs            # test runner internal
└── ui/
    ├── Index.html
    ├── css.html
    ├── js_core.html       # api(), store Alpine, router SPA
    ├── js_pages.html
    └── partials_*.html
```

Prefix angka menjaga urutan file di editor GAS dan memperjelas layer.

---

## 5. Standar kode

- Semua fungsi service menerima `ctx` (hasil validasi session) sebagai argumen pertama.
- Tidak ada fungsi service yang percaya `payload.dealerId` atau `payload.role` dari frontend.
  Selalu ambil dari `ctx`.
- Response selalu envelope: `{ ok: true, data }` atau `{ ok: false, error: { code, message } }`.
- Tidak ada `throw 'string'`. Selalu `throw new AppError(code, message)`.
- Semua mutasi case wajib menulis satu baris ke `CASE_EVENTS`.
- Nama kolom sheet diakses lewat konstanta di `00_Config.gs`, bukan angka literal.
- Komentar dan pesan error untuk user dalam **Bahasa Indonesia**. Nama variabel/fungsi English.

---

## 6. Prinsip produk (jangan dilanggar)

1. **Self-diagnosis 3 hari kerja itu target, bukan gerbang.** Dealer boleh minta support kapan
   saja. Tampilkan advisory persuasif, jangan pernah disable tombol submit.
2. **AI hanya memberi masukan.** AI tidak pernah mengubah priority, status, atau field apapun
   secara otomatis. Output AI selalu ditandai sebagai saran dan butuh aksi manusia.
3. **Evidence itu rekomendasi.** Kecuali field yang wajib secara teknis, jangan blokir submit
   karena satu dokumen belum ada. Label yang dipakai: "Recommended evidence".
4. **SLA habis ≠ auto-escalate.** SLA expired hanya memicu review teknis IIDI.
5. **Case_No imutabel.** Sekali terbit tidak pernah berubah, tidak pernah dipakai ulang,
   tidak pernah reset tahunan. Nomor MBAG disimpan di field terpisah.
6. **Isolasi data dealer itu mutlak.** Setiap handler yang menyentuh case harus lewat
   `assertCanAccessCase(ctx, caseNo)`.

---

## 7. Fase pembangunan

Satu fase = satu sesi kerja. Jangan lanjut sebelum checklist hijau.

| Fase | Isi | Selesai kalau |
|---|---|---|
| 0 | clasp setup, appsscript.json, worker route `/tcase`, `90_Setup.gs` bikin semua sheet + seed | Buka URL custom domain muncul halaman login |
| 1 | Auth: PIN hash, session token, lockout, RBAC guard, `assertCanAccessCase` | Dealer A login lalu coba akses case dealer B lewat payload → ditolak backend |
| 2 | Case CRUD + penomoran + state machine + CASE_EVENTS | Bikin 3 case bersamaan → CN-0001..0003, tidak ada duplikat |
| 3 | SLA engine (pure function) + unit test + kolom deadline | Semua test case di `docs/05-sla-engine.md` lulus |
| 4 | Evidence upload ke Drive + folder `[Case_No]_[VIN]` | Upload 3 file, folder terbentuk sekali, sheet cuma simpan File ID |
| 5 | Thread diskusi + additional data request | Round-trip dealer ↔ IIDI lengkap dengan deadline |
| 6 | Notifikasi email + queue + trigger | Status berubah → email masuk dalam 5 menit |
| 7 | AI Advisory (rule-based dulu, lalu Gemini) | Advisory muncul, fallback jalan saat API mati |
| 8 | Dashboard dealer + distributor + snapshot | Dashboard distributor load < 3 detik dengan 500 case dummy |
| 9 | MBAG escalation + closure flow | Case bisa naik ke MBAG dan ditutup dengan konfirmasi |
| 10 | Knowledge base + similar case retrieval | Case baru menampilkan 5 case mirip |

---

## 8. Arah UI

Ini alat kerja harian teknisi bengkel, bukan landing page. Prioritas: **kepadatan informasi,
kecepatan, dan keterbacaan di HP di ruang service**.

- Mobile-first 320px, breakpoint 768px dan 1200px.
- Satu warna aksen saja untuk aksi utama. Warna lain hanya dipakai untuk makna:
  hijau/kuning/merah khusus status SLA. Jangan pakai warna dekoratif.
- Angka besar untuk metrik, label kecil. Tabel padat, bukan kartu besar berjarak.
- Setiap layar punya satu pekerjaan yang jelas. Layar kosong menjelaskan langkah berikutnya,
  bukan sekadar "Tidak ada data".
- Tombol menyebut aksinya: "Kirim ke IIDI", bukan "Submit". Toast setelahnya memakai kata
  yang sama: "Terkirim ke IIDI".
- Pin versi CDN Tailwind, jangan `latest`.
- Skeleton loader untuk dashboard, bukan spinner layar penuh.
