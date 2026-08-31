# 00 — Cara Memulai

Urutan ini dikerjakan **sebelum** Claude Code menulis baris kode pertama.

> **Revisi Fase 0:** dua koreksi teks kecil di Langkah 7 supaya konsisten dengan
> `01-schema.md` (20 sheet, bukan 19 — ada sheet baru `VEHICLE_MODELS`) dan jumlah
> trigger yang benar-benar dipasang (empat, bukan tiga — daftarnya sudah selalu
> berisi 4 item, hanya angkanya yang keliru).

---

## Langkah 1 — Keputusan yang harus diambil dulu

Isi jawabannya di sini, lalu file ini ikut dibaca Claude Code.

| # | Pertanyaan | Jawaban |
|---|---|---|
| 1 | Akun Google mana yang jadi pemilik Spreadsheet, Drive, dan Script? Akun customerservicesmarketing@gmail.com
| 2 | Path final di custom domain: `/tcase`? betul ini jadi satu dengan project afs-digitalsolution.web.id 
| 3 | Berapa user awal per dealer? (saran: 1 Dealer_SM + 2 teknisi) gw setuju
| 4 | Siapa `IIDI_Tech_Mgr` pertama (super admin)? IIDI tech manager, director dan administrator
| 5 | Daftar 15 dealer + area + area manager | lihat `seed/dealers.csv` |
| 6 | Model kendaraan yang dilayani (untuk dropdown) | lihat `seed/models.csv` |
| 7 | Email pengirim notifikasi | satria.laksana@inchcape.co.id atau technical-handlingmb@inchcape.co.id atau manager atau orang yang mengambil tiketnya |

---

## Langkah 2 — Buat aset Google

1. **Spreadsheet** baru, namanya `MBTCASE_DB_PROD`. Catat ID-nya dari URL. 18fgu-GSSmSxlXPn38n5bfbfIU8t5IYjbPziUz9DfzRU
2. **Folder Drive** `MBTCASE_FILES`, set sharing "Anyone with the link can view".
   Catat ID folder. 1kK0ETsMT9nWDZPKQ7xMSji_jATxGaXHC
3. **Apps Script project** baru (standalone, bukan yang terikat spreadsheet).
   Catat Script ID.  1WbWi5aVhiiO_oNomGcG4cnIDvAYoazOoaQAMIhAyRtjWJZ2q0GZ2jY2p

Standalone dipilih supaya `clasp` bisa mengelola project secara bersih dan
spreadsheet bisa diganti tanpa memindahkan kode.

---

## Langkah 3 — Setup clasp di PowerShell

Ini bagian yang paling sering bikin macet di hari pertama. **Claude Code tidak bisa
mengedit script.google.com.** Kode ditulis lokal, lalu di-push.

```powershell
# 1. Pasang clasp
npm install -g @google/clasp

# 2. Login (browser terbuka)
clasp login

# 3. Aktifkan Apps Script API sekali saja
#    Buka https://script.google.com/home/usersettings → aktifkan "Google Apps Script API"

# 4. Buat folder project
mkdir C:\Users\<user>\Projects\mbtcase
cd C:\Users\<user>\Projects\mbtcase

# 5. Kaitkan ke script yang sudah dibuat di Langkah 2
clasp clone <SCRIPT_ID> --rootDir ./src
```

Isi `.clasp.json`:
```json
{ "scriptId": "<SCRIPT_ID>", "rootDir": "src" }
```

Alur kerja harian:
```powershell
clasp push          # kirim kode lokal ke GAS
clasp push --watch  # auto-push saat file berubah (paling nyaman saat ngoding)
clasp open          # buka editor GAS di browser
clasp deployments   # lihat daftar deployment
```

**Penting:** setelah `clasp push`, web app **belum** berubah. Harus deploy versi baru:
```powershell
clasp deploy --deploymentId <DEPLOYMENT_ID> --description "fase 1"
```
Pakai `--deploymentId` yang sama terus supaya URL `/exec` tidak berubah dan route
Cloudflare tidak perlu diutak-atik. Ini gotcha yang sering bikin bingung: kode
sudah di-push tapi yang jalan masih versi lama.

---

## Langkah 4 — Script Properties

Buka editor GAS → Project Settings → Script Properties. Isi:

| Key | Nilai | Cara dapat |
|---|---|---|
| `SHEET_ID` | ID spreadsheet | Dari URL spreadsheet |
| `DRIVE_ROOT_ID` | ID folder | Dari URL folder Drive |
| `JWT_SECRET` | 32+ byte acak base64 | `Utilities.base64Encode(Utilities.getUuid()+Utilities.getUuid())` |
| `PIN_PEPPER` | 32+ byte acak base64 | sama seperti di atas |
| `GEMINI_API_KEY` | kunci API | https://aistudio.google.com/apikey |
| `ADMIN_EMAIL` | email admin | untuk alert error |

**Jangan** taruh nilai-nilai ini di file kode. Kalau nanti repo di-push ke GitHub,
rahasianya ikut terbawa.

---

## Langkah 5 — appsscript.json

```json
{
  "timeZone": "Asia/Jakarta",
  "dependencies": {},
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "webapp": {
    "executeAs": "USER_DEPLOYING",
    "access": "ANYONE_ANONYMOUS"
  },
  "oauthScopes": [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/script.send_mail",
    "https://www.googleapis.com/auth/script.scriptapp"
  ]
}
```

`ANYONE_ANONYMOUS` diperlukan karena Cloudflare Worker mengakses tanpa login Google.
Keamanan tidak bergantung pada ini — semuanya ditegakkan oleh PIN + session token di
backend, sesuai `docs/03-rbac.md`.

---

## Langkah 6 — Route Cloudflare

Tambahkan `/tcase/*` di worker `afs-digitalsolution` yang sudah jalan, mengikuti pola
yang sudah terbukti untuk Recall Dashboard dan DSA. Jangan bikin worker baru.

Yang harus dipastikan:
- `redirect: 'follow'` saat fetch ke `/exec`
- Method, body, dan content-type diteruskan apa adanya untuk POST
- Response content-type dari GAS diteruskan kembali

---

## Langkah 7 — Jalankan setup

Dari editor GAS, jalankan sekali:
```js
setupAll();   // di 90_Setup.gs
```
Yang dikerjakan:
1. Membuat 20 sheet lengkap dengan header sesuai `docs/01-schema.md` (termasuk `VEHICLE_MODELS`, §2A)
2. Seed `CONFIG`, `HOLIDAY_CALENDAR`, `EVIDENCE_RULES`, `DEALERS`
3. Membuat user admin pertama dengan PIN sementara
4. Memasang empat trigger: SLA (30 menit), notifikasi (5 menit), dashboard (30 menit),
   ringkasan harian (08:15)

Untuk pengujian, jalankan juga:
```js
seedDemoData(50);   // 50 case dummy tersebar di 15 dealer, berbagai status dan umur
```
Data dummy ini penting. Tanpa itu, dashboard tidak bisa diuji dan bug performa baru
ketahuan setelah dipakai orang sungguhan.

---

## Langkah 8 — Checklist penerimaan fase 0

- [ ] `clasp push` berhasil
- [ ] `setupAll()` membuat semua sheet, tidak ada error
- [ ] `https://afs-digitalsolution.web.id/tcase/` membuka halaman login
- [ ] `sys.ping` mengembalikan `{ ok: true }`
- [ ] Login admin berhasil, dipaksa ganti PIN
- [ ] Banner Google Apps Script tidak muncul
- [ ] Tampilan rapi di HP 360px

Setelah semua tercentang, baru mulai fase 1.

---

## Prompt pembuka untuk Claude Code

```
Baca CLAUDE.md dan semua file di docs/ sebelum menulis kode apapun.

Kerjakan FASE 0 saja: setup clasp, appsscript.json, kerangka router,
dan 90_Setup.gs yang membuat seluruh sheet sesuai docs/01-schema.md
beserta seed data.

Jangan mengerjakan fase lain. Kalau ada yang tidak jelas di spec,
berhenti dan tanya saya dulu.

Setelah selesai, tampilkan checklist penerimaan fase 0 dan sebutkan
apa yang perlu saya jalankan manual.
```

Untuk fase berikutnya, ganti nomor fase dan rujuk file docs yang relevan.
