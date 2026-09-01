# 01 — Skema Database (Google Sheets)

Sumber kebenaran struktur data. Kalau kode dan file ini beda, **file ini yang benar**.

> **Revisi Fase 0:** ada 6 perubahan dari draf awal, semua ditandai dengan blok
> `> **REVISI (Fase 0)**` di bagian terkait. Ringkasan:
> 1. `USERS` — tambah kolom `Notif_Level`, tambah aturan `Email` harus unik.
> 2. Sheet baru `VEHICLE_MODELS` (§2A) — sebelumnya direferensikan (`seed/models.csv`,
>    `master.bootstrap.models`) tapi tidak punya sheet. Total sheet jadi **20**, bukan 19.
> 3. `CASE_ATTACHMENTS` — tambah kolom `Upload_Method` untuk mendukung alur upload hybrid.
> 4. `CASE_EVENTS` — tambah `Priority_Suggested` ke enum `Event_Type`.
> 5. `DASHBOARD_SNAPSHOT` — tambah kolom `Storage` dan `Drive_File_ID` untuk fallback
>    saat payload > 45.000 karakter.
> 6. `CONFIG` (§19) — beberapa key diganti/ditambah untuk mendukung upload hybrid,
>    kuota email per-penerima, dan WA provider.

## Konvensi

- Semua timestamp: string ISO 8601 dengan offset WIB, contoh `2026-08-30T09:15:00+07:00`.
- Semua boolean: `TRUE` / `FALSE` (string uppercase).
- Kolom kosong: string kosong `""`, bukan `null`.
- Baris 1 = header. Data mulai baris 2.
- Kolom ID selalu kolom A.
- **Semua kolom timestamp/date wajib diformat `Plain Text` (`setNumberFormat('@')`)
  SEBELUM baris data ditulis**, supaya Sheets tidak mem-parsing string ISO menjadi
  objek Date. Urutan ini wajib: format dulu, baru `setValues()`. Kalau terbalik,
  sel yang sudah kadung ter-parse tidak otomatis kembali jadi string.
- Sheet yang jarang berubah (`DEALERS`, `VEHICLE_MODELS`, `HOLIDAY_CALENDAR`,
  `EVIDENCE_RULES`, `CONFIG`) wajib di-cache pakai `CacheService` selama 6 jam,
  invalidate saat ada write.

---

## 1. `USERS`

| Kolom | Tipe | Catatan |
|---|---|---|
| User_ID | string | PK. Format: `U-0001` |
| Full_Name | string | |
| Role | enum | Lihat `docs/03-rbac.md` |
| Dealer_ID | string | Kosong untuk role IIDI_* |
| Dealer_Name | string | Denormalisasi untuk tampilan |
| Email | string | **Kredensial login.** Lihat aturan unik di bawah |
| Phone_WA | string | Format 62xxx, tanpa `+` |
| PIN_Hash | string | Base64. **JANGAN pernah dikirim ke frontend** |
| PIN_Salt | string | Base64, 16 byte random per user |
| PIN_Version | number | 1. Untuk migrasi algoritma nanti |
| Status | enum | `ACTIVE` / `SUSPENDED` / `INACTIVE` |
| Must_Change_PIN | boolean | `TRUE` saat user baru dibuat |
| Failed_Attempts | number | Reset ke 0 saat login sukses |
| Locked_Until | timestamp | Kosong kalau tidak terkunci |
| Notif_Level | enum | `All` / `Important_Only` / `Daily_Digest`. Default `All` — lihat `docs/08-notifications.md` §2 |
| Created_At | timestamp | |
| Updated_At | timestamp | |
| Last_Login_At | timestamp | |

> **REVISI (Fase 0):**
> ```
> KODE LAMA (tidak ada kolom Notif_Level; login memakai User_ID):
> | Email | string | Untuk notifikasi |
> ... (kolom terakhir langsung Created_At/Updated_At/Last_Login_At)
>
> KODE BARU:
> | Email | string | Kredensial login. Lihat aturan unik di bawah |
> ... + kolom baru Notif_Level di atas
> ```
> **Login memakai `Email`, bukan `User_ID`** (lebih mudah diingat teknisi bengkel).
> Konsekuensi: `Email` **wajib unik** di antara baris `Status != INACTIVE`. `setupAll()`
> dan pembuatan user baru harus menolak email duplikat dengan `AppError('VALIDATION', ...)`
> sebelum menulis baris. `auth.login` menerima `{ email, pin }`, lihat `02-api-contract.md`.
> Kolom `Notif_Level` ditambahkan karena sudah diwajibkan oleh `08-notifications.md` §2
> tapi belum ada tempat penyimpanannya di draf awal skema ini.

---

## 2. `DEALERS`

| Kolom | Tipe | Catatan |
|---|---|---|
| Dealer_ID | string | PK. Contoh `DLR-JKT-01` |
| Dealer_Name | string | |
| Area | string | Untuk scope IIDI_Area_Mgr |
| Area_Manager_User_ID | string | FK ke USERS. Kosong sampai IIDI_Area_Mgr dibuat (Fase 1) |
| City | string | |
| Status | enum | `ACTIVE` / `INACTIVE` |
| Created_At | timestamp | |

Seed awal: 15 dealer placeholder, lihat `seed/dealers.csv`.

---

## 2A. `VEHICLE_MODELS`

> **REVISI (Fase 0) — sheet baru.** `00-getting-started.md` merujuk `seed/models.csv`
> dan `master.bootstrap` (§`02-api-contract.md`) mengembalikan `models`, tapi draf awal
> skema ini tidak punya sheet untuk menyimpannya (beda dengan `Symptom_Category` yang
> memang enum tetap dan kecil, jumlah model kendaraan yang dilayani lebih banyak dan
> perlu bisa ditambah tanpa ubah kode). Sheet ini mengisi gap tersebut.

| Kolom | Tipe | Catatan |
|---|---|---|
| Model_Code | string | PK. Contoh `W206` |
| Model_Name | string | Nama tampilan. Contoh `C-Class (W206)` |
| Category | enum | `Sedan` / `SUV` / `Coupe` / `MPV` / `Cabriolet` |
| Active | boolean | Model tidak aktif tetap tersimpan untuk case lama, tapi hilang dari dropdown |
| Created_At | timestamp | |

Seed awal: lihat `seed/models.csv` (data placeholder, ganti dengan daftar riil yang
benar-benar dilayani dealer).

---

## 3. `SESSIONS`

| Kolom | Tipe | Catatan |
|---|---|---|
| Session_ID | string | PK, UUID |
| User_ID | string | FK |
| Token_Hash | string | SHA-256 dari token. Token mentah tidak disimpan |
| Issued_At | timestamp | |
| Expires_At | timestamp | Default +8 jam |
| Last_Seen_At | timestamp | |
| Revoked | boolean | |
| UA_Hint | string | 60 karakter pertama user-agent |

Housekeeping: trigger harian menghapus baris yang `Expires_At` lewat 7 hari.

---

## 4. `CASES_MASTER`

### Identitas kendaraan
| Kolom | Tipe | Wajib |
|---|---|---|
| Case_No | string | PK, `CN-0001` |
| VIN | string | ✅ 17 karakter |
| Model | string | ✅ |
| Engine_No | string | |
| Trans_No | string | |
| Mileage | number | ✅ |
| Prod_Year | number | |
| Reg_No | string | |
| Warranty_Status | enum | ✅ `In_Warranty` / `Out_Warranty` / `Goodwill` / `Extended` |

### Keluhan
| Kolom | Tipe | Wajib |
|---|---|---|
| Cust_Name | string | |
| Complaint_No | string | Nomor WO/RO dealer |
| Complaint_Desc | text | ✅ |
| Symptom_Category | enum | ✅ `Engine` / `Transmission` / `Electrical` / `Software` / `Chassis` / `Body` / `HVAC` / `Infotainment` / `Other` |
| Date_Occurred | date | |
| Frequency | enum | `Always` / `Intermittent` / `Once` / `Under_Condition` |
| Driving_Condition | string | |
| Vehicle_Status | enum | `Drivable` / `Not_Drivable` / `In_Workshop` |
| Outside_Temp | string | |
| Fuel_Level | string | |
| Driving_Style | string | |
| Road_Condition | string | |

### Kepemilikan & alur
| Kolom | Tipe | Catatan |
|---|---|---|
| Dealer_ID | string | ✅ Diambil dari session, **bukan dari payload** |
| Created_By_User_ID | string | Dari session |
| Priority | enum | `Normal` / `Urgent` / `Critical`. Hanya dealer yang set |
| Status | enum | Lihat `docs/04-state-machine.md` |
| Current_Owner_User_ID | string | Siapa yang harus bertindak |
| Current_Owner_Role | string | |
| Current_Waiting_Reason | enum | `Additional_Data` / `Dealer_Verification` / `IIDI_Technical_Review` / `MBAG_Feedback` / `Repair_Verification` / `Customer_Confirmation` / `""` |

### Skor & status turunan
| Kolom | Tipe | Catatan |
|---|---|---|
| Quality_Score | number | 0–100, rumus di bagian 20 file ini |
| Score_Category | enum | `Excellent` ≥85 / `Good` 70–84 / `Fair` 55–69 / `Poor` <55 |
| Activity_Status | enum | `Active` (<2 hari kerja) / `No_Recent_Activity` (2–5) / `Stale` (>5) |

> **`SLA_Status` TIDAK disimpan sebagai kolom.** Dihitung saat read dari kolom deadline.
> Kolom tersimpan pasti basi karena tidak ada yang meng-update.

### Deadline SLA (fakta immutable, diisi saat event terjadi)
| Kolom | Diisi saat |
|---|---|
| Dealer_Self_Diagnosis_Deadline | Case dibuat |
| IIDI_Response_Deadline | Case masuk ke IIDI |
| Dealer_Response_Deadline | IIDI request additional data |
| IIDI_Decision_Deadline | Data tambahan diterima |
| Closure_Deadline | Status jadi Request Closure |

### Jejak waktu
| Kolom | Tipe |
|---|---|
| Created_At | timestamp |
| Updated_At | timestamp |
| Last_Activity_At | timestamp |
| Last_Activity_By | string |
| Submitted_To_IIDI_At | timestamp |
| First_IIDI_Response_At | timestamp |
| Escalated_At | timestamp |
| Closed_At | timestamp |
| Closed_By | string |
| Closure_Type | enum: `Solved` / `Not_Reproducible` / `Duplicate` / `Cancelled_By_Dealer` |
| MBAG_Ref_No | string — **terpisah dari Case_No** |

---

## 5. `CASE_DIAGNOSTICS`

| Kolom | Tipe |
|---|---|
| Case_No | string (PK, 1:1 dengan CASES_MASTER) |
| Initial_Diag | text |
| Dealer_Analysis | text |
| Suspected_Root_Cause | text |
| Workshop_Findings | text |
| DTC_Codes | string — dipisah koma, contoh `P0087,B1234` |
| Control_Unit | string |
| Diagnostic_Path | text |
| Xentry_Version | string |
| SW_Version_Before | string |
| SW_Version_After | string |
| Parts_Replaced | text |
| Previous_Repair_History | text |
| Updated_At | timestamp |
| Updated_By | string |

---

## 6. `CASE_THREAD`

Diskusi teknis. Ini pengganti WhatsApp-nya.

| Kolom | Tipe | Catatan |
|---|---|---|
| Thread_ID | string | PK, `TH-000001` |
| Case_No | string | FK |
| Parent_ID | string | Untuk balasan bersarang, kosong = top level |
| Author_User_ID | string | |
| Author_Role | string | |
| Message_Type | enum | `Comment` / `Question` / `Answer` / `Request_Data` / `Decision` / `System` |
| Message | text | |
| Visibility | enum | `All` / `IIDI_Only`. Dealer tidak pernah menerima baris `IIDI_Only` |
| Created_At | timestamp | |
| Edited_At | timestamp | |
| Deleted | boolean | Soft delete, jangan hapus baris |

`Author_Name` **tidak** disimpan. Backend meresolusinya dari `USERS` saat read
dan menyertakannya di response `thread.list` / `case.get`.

Baris `System` ditulis otomatis saat status berubah, supaya timeline terbaca utuh.

Usulan priority dari `IIDI_Tech_Mgr` (RBAC §2: "usul saja") ditulis sebagai baris
`Message_Type = 'Decision'`, `Visibility = 'IIDI_Only'` kalau usulan itu dibahas
internal dulu, atau `'All'` kalau langsung ditujukan ke dealer. Lihat juga
`Priority_Suggested` di `CASE_EVENTS` (§9).

---

## 7. `CASE_ATTACHMENTS`

| Kolom | Tipe | Catatan |
|---|---|---|
| Attachment_ID | string | PK, `AT-000001` |
| Case_No | string | FK |
| Thread_ID | string | Opsional |
| Evidence_Type | enum | `Quick_Test` / `Actual_Value` / `Guided_Test` / `Photo` / `Video` / `Wiring_Check` / `Measurement` / `Programming_Log` / `SCN_Coding` / `Repair_Doc` / `Other` |
| File_Name | string | |
| Drive_File_ID | string | **Hanya ID yang disimpan, bukan file** |
| Drive_URL | string | |
| Mime_Type | string | |
| Size_Bytes | number | Maks sesuai `Upload_Method`, lihat catatan di bawah |
| Upload_Method | enum | `INLINE` (base64 via `attach.upload`, ≤ `MAX_INLINE_UPLOAD_MB`) / `RESUMABLE` (via `attach.initUpload`/`attach.completeUpload`, ≤ `MAX_RESUMABLE_UPLOAD_MB`) |
| Uploaded_By | string | |
| Uploaded_At | timestamp | |
| Deleted | boolean | |

> **REVISI (Fase 0):**
> ```
> KODE LAMA:
> | Size_Bytes | number | Maks 10 MB per file |
> (tidak ada kolom Upload_Method, langsung ke Uploaded_By)
>
> KODE BARU:
> | Size_Bytes | number | Maks sesuai Upload_Method, lihat catatan di bawah |
> | Upload_Method | enum | INLINE / RESUMABLE |
> ... lalu Uploaded_By
> ```
> Alasan: foto ≤5 MB tetap lewat `attach.upload` (base64, satu round-trip, sederhana).
> Video/file besar (>5 MB, maks `MAX_RESUMABLE_UPLOAD_MB`) lewat sesi resumable ke
> Drive API supaya tidak membengkak jadi ~13 MB body base64 dan kena limit `/exec`.
> Detail alur di `02-api-contract.md` §"Attachment".

Folder Drive: `MBTCASE_ROOT / [Dealer_ID] / [Case_No]_[VIN] /`.
Pembuatan folder wajib di dalam LockService dan dicatat di `CASE_FOLDERS`.
Folder **tidak** di-share publik — akses file selalu lewat proxy GAS yang memvalidasi
session dan `assertCanAccessCase_` (lihat `03-rbac.md` §3), bukan link Drive terbuka.

---

## 8. `CASE_FOLDERS`

| Kolom | Tipe |
|---|---|
| Case_No | string (PK) |
| Folder_ID | string |
| Folder_URL | string |
| Created_At | timestamp |

Registry ini mencegah folder ganda saat dua user upload bersamaan.

---

## 9. `CASE_EVENTS` — audit trail per case

Setiap mutasi case menulis satu baris. Tidak ada pengecualian.

| Kolom | Tipe |
|---|---|
| Event_ID | string (PK) |
| Case_No | string |
| Event_Type | enum: `Created` / `Status_Changed` / `Priority_Changed` / `Priority_Suggested` / `Assigned` / `Data_Requested` / `Data_Fulfilled` / `Attachment_Added` / `Escalated` / `Closure_Requested` / `Closed` / `Reopened` / `SLA_Breached` / `Field_Updated` |
| From_Value | string |
| To_Value | string |
| Actor_User_ID | string |
| Actor_Role | string |
| Note | text |
| Detail_JSON | string |
| Created_At | timestamp |

> **REVISI (Fase 0):** enum `Event_Type` menambah `Priority_Suggested`.
> ```
> KODE LAMA:
> ... / `Priority_Changed` / `Assigned` / ...
>
> KODE BARU:
> ... / `Priority_Changed` / `Priority_Suggested` / `Assigned` / ...
> ```
> `Priority_Changed` tetap khusus untuk perubahan aktual field `Priority` (hanya dealer,
> per RBAC §2). `Priority_Suggested` dipakai saat `IIDI_Tech_Mgr` mengusulkan tinjauan
> priority — tidak mengubah field apapun, hanya jejak + trigger baris `CASE_THREAD`
> terkait (lihat §6).

---

## 10. `AUDIT_LOG` — keamanan & sistem

| Kolom | Tipe |
|---|---|
| Log_ID | string (PK) |
| Timestamp | timestamp |
| User_ID | string |
| Action | string: `LOGIN_SUCCESS` / `LOGIN_FAILED` / `ACCOUNT_LOCKED` / `PIN_CHANGED` / `ACCESS_DENIED` / `SESSION_EXPIRED` / `EXPORT` |
| Target | string |
| Result | `OK` / `DENIED` / `ERROR` |
| Detail | string |
| UA_Hint | string |

`ACCESS_DENIED` wajib dicatat setiap kali `assertCanAccessCase` gagal. Ini alarm dini.

---

## 11. `DATA_REQUESTS`

| Kolom | Tipe |
|---|---|
| Request_ID | string (PK) |
| Case_No | string |
| Requested_By | string |
| Requested_At | timestamp |
| Items_JSON | string — array item yang diminta |
| Due_At | timestamp — hasil SLA 2 hari kerja |
| Status | `OPEN` / `FULFILLED` / `PARTIAL` / `CANCELLED` |
| Fulfilled_At | timestamp |
| Fulfilled_By | string |
| Response_Note | text |
`Request_ID` berformat `DR-XXXXXXXX` (8 karakter dari UUID), bukan nomor berurutan.
Nomor ini tidak pernah ditampilkan ke user — `Case_No` tetap satu-satunya nomor
yang dibaca orang — jadi counter berurutan hanya menambah satu LockService per
permintaan tanpa manfaat. Polanya sama dengan `EV-`, `AL-`, dan `NT-`.
---

## 12. `MBAG_ESCALATIONS`

| Kolom | Tipe |
|---|---|
| Escalation_ID | string (PK) |
| Case_No | string |
| MBAG_Ref_No | string |
| Escalated_By | string |
| Escalated_At | timestamp |
| Reason | text |
| Package_Folder_ID | string — folder Drive berisi paket bukti |
| MBAG_Status | `Submitted` / `In_Review` / `Info_Requested` / `Answered` / `Closed` |
| MBAG_Response | text |
| Response_At | timestamp |
| Closed_At | timestamp |

---

## 13. `HOLIDAY_CALENDAR`

| Kolom | Tipe | Contoh |
|---|---|---|
| Date | date | `2026-08-17` |
| Name | string | Hari Kemerdekaan RI |
| Type | enum | `National` / `Joint_Leave` / `Company` |
| Active | boolean | `TRUE` |

Seed: hari libur nasional Indonesia tahun berjalan + tahun berikutnya. Isi manual di sheet,
di-cache 6 jam.

---

## 14. `EVIDENCE_RULES`

Mesin rekomendasi bukti berbasis aturan. Ini yang dipakai duluan, sebelum Gemini.

| Kolom | Tipe | Contoh |
|---|---|---|
| Rule_ID | string | `ER-001` |
| Match_Type | enum | `Symptom_Category` / `DTC_Prefix` / `Control_Unit` / `Keyword` |
| Match_Value | string | `Software` atau `P00` atau `ME9.7` |
| Evidence_Type | enum | `Quick_Test` |
| Label | string | Initial Quick Test sebelum programming |
| Priority | number | 1 = paling penting |
| Mandatory | boolean | Hampir selalu `FALSE` |
| Applies_To_Priority | string | `Normal,Urgent,Critical` |
| Active | boolean | |

Seed minimal:
- `Software` → Initial Quick Test, versi software, programming log, bukti SCN coding, Post-programming Quick Test
- `Electrical` → Actual values, Guided Test, wiring inspection, pengukuran tegangan/tahanan, foto konektor, dokumen upaya perbaikan

---

## 15. `NOTIFICATIONS_QUEUE`

Lihat `docs/08-notifications.md`.

| Kolom | Tipe |
|---|---|
| Notif_ID | string (PK) |
| Case_No | string |
| Event_Type | string |
| Recipient_User_ID | string |
| Channel | `EMAIL` / `WA` |
| To_Address | string |
| Subject | string |
| Body | text |
| Status | `PENDING` / `SENT` / `FAILED` / `SKIPPED` |
| Attempts | number |
| Created_At | timestamp |
| Sent_At | timestamp |
| Error | string |

---

## 16. `AI_ADVISORY_LOG`

| Kolom | Tipe |
|---|---|
| Advisory_ID | string (PK) |
| Case_No | string |
| Trigger | `On_Create` / `On_Request_Support` / `Manual` |
| Source | `RULE` / `GEMINI` |
| Model | string |
| Input_Hash | string — untuk cache, hindari panggilan ulang |
| Response_JSON | string |
| Latency_Ms | number |
| Error | string |
| Created_At | timestamp |
| Acknowledged_By | string |

---

## 17. `KB_ARTICLES`

| Kolom | Tipe |
|---|---|
| KB_ID | string (PK) |
| Source_Case_No | string |
| Title | string |
| Model | string |
| Symptom_Category | string |
| DTC_Codes | string |
| Root_Cause | text |
| Solution | text |
| Keywords | string — dipisah koma, lowercase |
| Status | `DRAFT` / `PUBLISHED` / `ARCHIVED` |
| Created_By | string |
| Created_At | timestamp |
| View_Count | number |

---

## 18. `DASHBOARD_SNAPSHOT`

| Kolom | Tipe | Catatan |
|---|---|---|
| Snapshot_Key | string | `DIST_ALL`, `DEALER_DLR-JKT-01` |
| Scope | string | |
| Payload_JSON | string | Kosong kalau `Storage = DRIVE` |
| Generated_At | timestamp | |
| Storage | enum | `SHEET` (default) / `DRIVE` — lihat catatan |
| Drive_File_ID | string | Terisi hanya kalau `Storage = DRIVE` |

> **REVISI (Fase 0):** tambah `Storage` dan `Drive_File_ID`.
> ```
> KODE LAMA:
> | Snapshot_Key | string — DIST_ALL, DEALER_DLR-JKT-01 |
> | Scope | string |
> | Payload_JSON | string |
> | Generated_At | timestamp |
>
> KODE BARU: (tabel di atas, + 2 kolom baru)
> ```
> Alasan: sel Google Sheets punya batas ~50.000 karakter. Kalau `Payload_JSON` (leaderboard
> 15 dealer + 6 chart) mendekati/melewati ~45.000 karakter, `Dashboard_.rebuildAll()`
> menyimpan JSON sebagai file di folder `MBTCASE_FILES/_snapshots/` dan mencatat
> `Drive_File_ID`-nya di sini, `Payload_JSON` dikosongkan. `dashboard.get` membaca dari
> Drive kalau `Storage = DRIVE`. Ini murni fallback teknis, tidak mengubah bentuk response
> di `02-api-contract.md` §4.

Di-refresh trigger tiap 30 menit. Dashboard membaca dari sini, bukan dari raw sheet.

---

## 19. `CONFIG`

Sheet key-value generik. Kolom: `Key`, `Value`, `Description`, `Updated_At`.

| Key | Nilai default | Keterangan |
|---|---|---|
| CASE_COUNTER | 0 | Angka terakhir yang dipakai untuk Case_No. Naik terus, tidak pernah turun |
| ATTACH_COUNTER | 0 | Angka terakhir Attachment_ID (`AT-000001`). Naik terus, tidak pernah turun |
| THREAD_COUNTER | 0 | Angka terakhir Thread_ID (`TH-000001`). Naik terus, tidak pernah turun |
| SLA_DEALER_SELF_DIAG_DAYS | 3 | hari kerja |
| SLA_IIDI_RESPONSE_DAYS | 1 | |
| SLA_DEALER_RESPONSE_DAYS | 2 | |
| SLA_IIDI_DECISION_DAYS | 2 | |
| SLA_CLOSURE_DAYS | 2 | |
| WORK_START | 08:00 | |
| WORK_END | 17:00 | |
| NEAR_DUE_THRESHOLD_HOURS | 1 | jam kerja |
| SESSION_TTL_HOURS | 8 | |
| MAX_FAILED_ATTEMPTS | 5 | |
| LOCKOUT_MINUTES | 15 | |
| MAX_INLINE_UPLOAD_MB | 5 | Batas file base64 lewat `attach.upload` |
| MAX_RESUMABLE_UPLOAD_MB | 100 | Batas file lewat `attach.initUpload`/`attach.completeUpload` |
| FEATURE_GEMINI | TRUE | Matikan kalau kuota habis, sistem fallback ke rule |
| FEATURE_WA | FALSE | Aktifkan saat provider WA siap |
| WA_PROVIDER | (kosong) | `FONNTE` / `WABLAS` / `META` / `CUSTOM`. Kosong = belum aktif |
| GEMINI_MODEL | (isi saat setup) | Nama model disimpan di sini supaya gampang diganti |
| EMAIL_DAILY_QUOTA | 1500 | Kuota akun Workspace pengirim. Dihitung per **penerima**, bukan per baris queue |
| EMAIL_SENT_TODAY | 0 | Counter berjalan, direset job harian |
| SLA_JOB_CURSOR | 0 | Penanda posisi batch job SLA (maks 300 case/eksekusi) |

Rahasia (API key, pepper, JWT secret) **tidak disimpan di sheet ini**, tapi di Script Properties.

> **REVISI (Fase 0):**
> ```
> KODE LAMA:
> | MAX_UPLOAD_MB | 10 | |
> (tidak ada WA_PROVIDER, EMAIL_DAILY_QUOTA, EMAIL_SENT_TODAY, SLA_JOB_CURSOR)
>
> KODE BARU:
> | MAX_INLINE_UPLOAD_MB | 5 | ... |
> | MAX_RESUMABLE_UPLOAD_MB | 100 | ... |
> + WA_PROVIDER, EMAIL_DAILY_QUOTA, EMAIL_SENT_TODAY, SLA_JOB_CURSOR
> ```
> Alasan: `MAX_UPLOAD_MB` tunggal tidak cukup untuk strategi upload hybrid (§7). Key
> tambahan lain sebelumnya disebut di `08-notifications.md`/`50_Notify.gs` tapi belum
> punya tempat resmi di `CONFIG`.

---

## 20. Rumus `Quality_Score`

Skor kelengkapan case, dihitung ulang setiap kali case di-update. Ini mengukur kualitas
input dealer, bukan kualitas kerja IIDI.

| Komponen | Poin |
|---|---|
| Field wajib terisi lengkap (VIN, Model, Mileage, Complaint_Desc, Symptom_Category, Warranty_Status) | 20 |
| `Initial_Diag` terisi ≥ 50 karakter | 15 |
| `Dealer_Analysis` terisi ≥ 100 karakter | 15 |
| `Suspected_Root_Cause` terisi | 10 |
| `DTC_Codes` terisi ATAU dinyatakan eksplisit "no DTC" | 10 |
| Minimal 1 lampiran Quick Test | 15 |
| Minimal 1 lampiran foto/video | 5 |
| ≥ 60% evidence yang direkomendasikan sudah diunggah | 10 |
| **Total** | **100** |

Skor ditampilkan ke dealer sebagai umpan balik saat mengisi form ("Kelengkapan case: 65%"),
dan dipakai di dashboard distributor sebagai indikator kualitas per dealer.
Skor rendah **tidak memblokir** submit.
