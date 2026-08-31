# 05 — SLA Engine

> **Revisi Fase 0:** §4 (threshold `NEAR_DUE`) dan §7 (test #6, #12) dikoreksi.
> Lihat catatan "REVISI" di masing-masing bagian.

## 1. Prinsip

- Jam kerja: **08:00–17:00 WIB, Senin–Jumat**. 9 jam kerja per hari.
- Libur: Sabtu, Minggu, dan tanggal aktif di `HOLIDAY_CALENDAR`.
- Semua perhitungan pakai **jam kerja**, bukan jam kalender.
- Tidak ada jam istirahat yang dipotong. Kalau nanti perlu, tambahkan di CONFIG, jangan
  hardcode.

**Aturan implementasi:** `30_SlaEngine.gs` berisi **pure function saja**. Tidak boleh
menyentuh `SpreadsheetApp` sama sekali. Kalender libur di-inject sebagai argumen. Ini yang
membuat SLA bisa diuji tanpa spreadsheet, dan ini alasan utama bug SLA jadi gampang dilacak.

## 2. Fungsi yang harus ada

```js
/** Apakah tanggal ini hari kerja? */
function isWorkingDay_(date, holidaySet)            // → boolean

/** Titik jam kerja berikutnya. Kalau sudah di dalam jam kerja, kembalikan apa adanya. */
function nextWorkingMoment_(date, holidaySet, cfg)  // → Date

/** Selisih menit kerja antara dua waktu. Negatif kalau `to` < `from`. */
function workingMinutesBetween_(from, to, holidaySet, cfg)  // → number

/** Tambahkan N menit kerja ke sebuah waktu. */
function addWorkingMinutes_(from, minutes, holidaySet, cfg) // → Date

/** Tambahkan N hari kerja. 1 hari kerja = 9 jam kerja = 540 menit. */
function addWorkingDays_(from, days, holidaySet, cfg)       // → Date

/** Status SLA terhadap deadline. */
function slaStatus_(now, deadline, holidaySet, cfg)
// → { status: 'ON_TIME'|'NEAR_DUE'|'OVERDUE'|'NONE',
//     remainingWorkingMinutes: number,
//     overdueWorkingMinutes: number }
```

## 3. Aturan pembulatan dan tepi

| Situasi | Perlakuan |
|---|---|
| Event terjadi 06:30 (sebelum jam kerja) | Dianggap mulai 08:00 hari yang sama |
| Event terjadi 19:00 (setelah jam kerja) | Dianggap mulai 08:00 hari kerja berikutnya |
| Event terjadi Sabtu jam berapapun | Dianggap mulai 08:00 Senin (atau hari kerja berikutnya) |
| Deadline jatuh tepat 17:00 | Valid. `17:00:00` = akhir hari kerja, belum overdue |
| Deadline jatuh di hari libur | Tidak mungkin, karena selalu hasil `addWorkingMinutes_` |
| `deadline` kosong | `status = 'NONE'`, jangan tampilkan badge |

## 4. Threshold status

| Status | Kondisi | Warna |
|---|---|---|
| `ON_TIME` | sisa > 60 menit kerja | 🟢 |
| `NEAR_DUE` | 0 ≤ sisa ≤ 60 menit kerja | 🟡 |
| `OVERDUE` | sudah lewat deadline (sisa < 0) | 🔴 |
| `NONE` | tidak ada deadline aktif | abu-abu |

Threshold 60 menit dari `CONFIG.NEAR_DUE_THRESHOLD_HOURS`.

> **REVISI (Fase 0):** kondisi `NEAR_DUE` semula `0 < sisa ≤ 60`, sehingga kasus tepat
> `now == deadline` (sisa = 0) tidak masuk bucket manapun. Sekarang `NEAR_DUE` memakai
> batas bawah inklusif (`0 ≤ sisa`), jadi tepat di titik deadline masih `NEAR_DUE`,
> baru menjadi `OVERDUE` satu menit kerja setelahnya. Ini konsisten dengan test #12 di §7.

## 5. Deadline mana yang aktif

Case bisa punya beberapa kolom deadline terisi. Yang ditampilkan sebagai `SLA_Status`
adalah deadline yang relevan dengan status saat ini:

| Status case | Deadline aktif |
|---|---|
| `Created` | `Dealer_Self_Diagnosis_Deadline` (advisory, bukan pelanggaran) |
| `Open` | `IIDI_Response_Deadline` |
| `In Progress` | `IIDI_Response_Deadline` kalau belum ada respons, selain itu `IIDI_Decision_Deadline` |
| `Waiting Dealer Reply` | `Dealer_Response_Deadline` |
| `Waiting IIDI` | `IIDI_Decision_Deadline` |
| `Escalated to MBAG` | `NONE` — MBAG di luar kendali IIDI, jangan hitung sebagai pelanggaran |
| `Request Closure` | `Closure_Deadline` |
| `Closed` | `NONE` |

## 6. Target SLA

| Fase | Target | Dari kolom CONFIG |
|---|---|---|
| Dealer self-diagnosis | 3 hari kerja | `SLA_DEALER_SELF_DIAG_DAYS` |
| IIDI initial response | 1 hari kerja | `SLA_IIDI_RESPONSE_DAYS` |
| Dealer response ke data request | 2 hari kerja | `SLA_DEALER_RESPONSE_DAYS` |
| IIDI decision sebelum MBAG | 2 hari kerja | `SLA_IIDI_DECISION_DAYS` |
| Closure confirmation | 2 hari kerja | `SLA_CLOSURE_DAYS` |

Deadline dihitung **sekali** saat event pemicunya terjadi lalu disimpan. Jangan pernah
dihitung ulang, karena kalender libur bisa berubah dan itu akan menggeser deadline lama.

## 7. Test case wajib

Fase 3 tidak dianggap selesai sebelum semua ini lulus. Asumsi: `HOLIDAY_CALENDAR` berisi
`2026-08-17` (Senin, Hari Kemerdekaan).

| # | Input | Ekspektasi |
|---|---|---|
| 1 | `addWorkingDays_('2026-08-03T09:00+07:00', 1)` (Senin) | `2026-08-04T09:00+07:00` |
| 2 | `addWorkingDays_('2026-08-07T16:00+07:00', 1)` (Jumat) | `2026-08-10T16:00+07:00` (Senin) |
| 3 | `addWorkingDays_('2026-08-14T09:00+07:00', 1)` (Jumat, Senin libur) | `2026-08-18T09:00+07:00` (Selasa) |
| 4 | `addWorkingDays_('2026-08-03T06:30+07:00', 1)` | `2026-08-04T08:00+07:00` — mulai dinormalkan ke 08:00 |
| 5 | `addWorkingDays_('2026-08-03T19:00+07:00', 1)` | `2026-08-05T08:00+07:00` — mulai geser ke Selasa 08:00 |
| 6 | `addWorkingDays_('2026-08-08T10:00+07:00', 2)` (Sabtu) | `2026-08-12T08:00+07:00` (Rabu) — lihat catatan revisi di bawah |
| 7 | `addWorkingMinutes_('2026-08-03T16:30+07:00', 60)` | `2026-08-04T08:30+07:00` |
| 8 | `workingMinutesBetween_('2026-08-03T08:00', '2026-08-03T17:00')` | `540` |
| 9 | `workingMinutesBetween_('2026-08-07T16:00', '2026-08-10T09:00')` | `120` (60 Jumat + 60 Senin) |
| 10 | `workingMinutesBetween_('2026-08-08T09:00', '2026-08-09T15:00')` | `0` (Sabtu–Minggu) |
| 11 | `slaStatus_(now='2026-08-04T16:30', deadline='2026-08-04T17:00')` | `NEAR_DUE`, sisa 30 |
| 12 | `slaStatus_(now='2026-08-04T17:00', deadline='2026-08-04T17:00')` | `NEAR_DUE`, sisa 0 — lihat catatan revisi di bawah |
| 13 | `slaStatus_(now='2026-08-05T08:01', deadline='2026-08-04T17:00')` | `OVERDUE`, lewat 1 menit |
| 14 | `slaStatus_(now, deadline='')` | `NONE` |
| 15 | `addWorkingDays_('2026-08-03T09:00+07:00', 3)` | `2026-08-06T09:00+07:00` |

> **REVISI (Fase 0) — Test #6:**
> ```
> KODE LAMA:
> | 6 | addWorkingDays_('2026-08-08T10:00+07:00', 2) (Sabtu) | 2026-08-11T08:00+07:00 (Selasa) |
>
> KODE BARU:
> | 6 | addWorkingDays_('2026-08-08T10:00+07:00', 2) (Sabtu) | 2026-08-12T08:00+07:00 (Rabu) |
> ```
> Alasan: Sabtu 08 Agu 10:00 dinormalkan ke hari kerja berikutnya = Senin 10 Agu 08:00.
> Dari titik itu, `+1 hari kerja` → Selasa 11 Agu 08:00, `+1 hari kerja` lagi → Rabu
> 12 Agu 08:00. Nilai lama (`2026-08-11`, Selasa) hanya menghitung *satu* pergeseran hari
> kerja padahal diminta dua — tidak konsisten dengan pola normalisasi di test #4, #5, #15.

> **REVISI (Fase 0) — Test #12:**
> ```
> KODE LAMA:
> | 12 | slaStatus_(now='2026-08-04T17:00', deadline='2026-08-04T17:00') | ON_TIME/tepat, belum OVERDUE |
>
> KODE BARU:
> | 12 | slaStatus_(now='2026-08-04T17:00', deadline='2026-08-04T17:00') | NEAR_DUE, sisa 0 |
> ```
> Alasan: nilai lama tidak menyebut status secara pasti ("ON_TIME/tepat"). Dengan
> threshold `NEAR_DUE` baru di §4 (`0 ≤ sisa ≤ 60`), `now == deadline` menghasilkan
> `remainingWorkingMinutes = 0`, sehingga status yang benar dan tidak ambigu adalah
> `NEAR_DUE`.

Tulis test ini di `99_Tests.gs` sebagai fungsi `runSlaTests()` yang bisa dijalankan dari
editor GAS dan mencetak PASS/FAIL per baris.

## 8. Job SLA (trigger)

`31_SlaJob.gs`, time-driven trigger tiap **30 menit** pada jam kerja saja.

Untuk setiap case yang belum `Closed`:
1. Hitung `slaStatus_` pakai deadline aktif.
2. `NEAR_DUE` dan belum pernah dinotifikasi → antre notifikasi ke pemilik case.
3. `OVERDUE` dan belum pernah dicatat → tulis `SLA_Breached` ke `CASE_EVENTS`,
   antre notifikasi ke pemilik + atasannya.
4. **Jangan ubah status case.** SLA breach hanya memicu review.

Anti-spam: satu notifikasi per case per jenis pelanggaran. Simpan penanda di
`CASE_EVENTS` dan cek dulu sebelum antre.

Batasi 300 case per eksekusi trigger dengan penanda posisi di `CONFIG` (`SLA_JOB_CURSOR`),
supaya tidak menabrak batas 6 menit saat volume besar.
