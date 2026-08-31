# 06 — Dashboard

Dua dashboard, satu endpoint (`dashboard.get`), scope ditentukan backend dari role.

## 1. Aturan performa (baca dulu)

Dashboard distributor mengagregasi ribuan baris. Kalau dihitung dari raw sheet tiap
kali dibuka, GAS akan lambat dan kena kuota.

**Pola wajib:**
1. Trigger tiap 30 menit menjalankan `Dashboard_.rebuildAll()`.
2. Hasil disimpan sebagai satu JSON per scope di `DASHBOARD_SNAPSHOT`
   (`DIST_ALL`, `AREA_<nama>`, `DEALER_<id>`).
3. `dashboard.get` membaca snapshot, bukan menghitung.
4. `CacheService` 5 menit di atas itu.
5. Response menyertakan `generatedAt` dan `stale: true` kalau umur snapshot > 45 menit.
   UI menampilkan "Data per 09:30" supaya user tahu ini bukan real-time.
6. Kartu "butuh aksi saya" **dihitung live**, bukan dari snapshot, karena harus akurat.

Filter periode: `today`, `7d`, `30d`, `90d`, `ytd`, `custom`. Snapshot dibangun untuk
`30d` sebagai default; periode lain dihitung on-demand dengan pagination.

## 2. Dashboard Dealer

Scope: `Dealer_ID` milik user. Role IIDI yang membuka dealer tertentu melihat tampilan
yang sama dengan scope dealer itu.

### Kartu metrik
| Kartu | Definisi |
|---|---|
| Butuh respons saya | Case berstatus `Waiting Dealer Reply` atau `Request Closure` |
| Case aktif | Semua case belum `Closed` |
| Overdue | Case dengan `SLA_Status = OVERDUE` |
| Menunggu IIDI | Status `Open`, `In Progress`, `Waiting IIDI` |
| Eskalasi MBAG | Status `Escalated to MBAG` |
| Selesai bulan ini | `Closed` dalam bulan berjalan |

Kartu "Butuh respons saya" adalah yang terbesar dan paling atas. Ini satu-satunya angka
yang benar-benar menuntut aksi hari ini.

### Chart
| Chart | Tipe | Isi |
|---|---|---|
| Tren case | Line | Jumlah case dibuat vs ditutup per minggu, 12 minggu |
| Distribusi kategori | Doughnut | `Symptom_Category` |
| Case per model | Bar horizontal | Top 8 model |
| Sebaran status | Stacked bar | Komposisi status saat ini |

### Metrik performa dealer
| Metrik | Rumus |
|---|---|
| Rata-rata waktu respons dealer | Rata-rata jam kerja dari `DATA_REQUESTS.Requested_At` ke `Fulfilled_At` |
| Kepatuhan SLA dealer | % data request yang dipenuhi sebelum `Due_At` |
| Rata-rata Quality Score | Rata-rata `Quality_Score` case periode ini |
| Rata-rata waktu penyelesaian | Jam kerja dari `Submitted_To_IIDI_At` ke `Closed_At` |

Tampilkan setiap metrik dengan pembanding rata-rata nasional, supaya dealer tahu posisinya.

### Tabel aksi
"Perlu tindakan Anda" — diurut deadline terdekat: Case_No, Model, Keluhan singkat,
Yang diminta, Sisa waktu, tombol Buka.

## 3. Dashboard Distributor (IIDI)

Scope: semua dealer. `IIDI_Area_Mgr` otomatis ter-filter ke area-nya.

### Kartu metrik
| Kartu | Definisi |
|---|---|
| Case aktif nasional | Belum `Closed` |
| Belum diambil | Status `Open` |
| Overdue IIDI | Overdue dengan pemilik role IIDI |
| Overdue Dealer | Overdue dengan pemilik role dealer |
| Di MBAG | Status `Escalated to MBAG` |
| Rata-rata waktu tutup | Jam kerja submit → closed, 30 hari terakhir |
| Escalation rate | % case yang naik ke MBAG dari total case ditutup |
| First response compliance | % case dengan respons pertama IIDI dalam SLA |

### Chart
| Chart | Tipe | Isi |
|---|---|---|
| Case per dealer | Bar horizontal | 15 dealer, diurut jumlah case aktif |
| Tren nasional | Line | Dibuat vs ditutup vs backlog per minggu |
| Top symptom | Bar | Top 10 `Symptom_Category` + DTC |
| Top model bermasalah | Bar | Top 10 model, dinormalkan per model kalau data populasi tersedia |
| Beban IIDI_Tech | Bar | Case aktif per teknisi IIDI |
| Sebaran umur case | Histogram | Bucket 0–3, 4–7, 8–14, 15–30, >30 hari kerja |

### Leaderboard dealer
Tabel utama distributor. Satu baris per dealer, bisa diurut per kolom:

| Kolom | Keterangan |
|---|---|
| Dealer | Nama |
| Area | |
| Case aktif | |
| Overdue | Merah kalau > 0 |
| Avg Quality Score | Kualitas input case dealer |
| Avg response time | Jam kerja |
| SLA compliance % | Data request dipenuhi tepat waktu |
| Escalation rate | % case yang harus naik MBAG (indikator kemampuan teknis) |
| Stale cases | Case tanpa aktivitas > 5 hari kerja |

Ini alat coaching. Dealer dengan escalation rate tinggi dan quality score rendah
kemungkinan butuh pelatihan, bukan teguran. Beri catatan itu di UI.

### Tabel operasional
1. **Belum diambil** — case `Open` diurut umur, tombol "Ambil case".
2. **Overdue** — semua case overdue dengan pemilik dan sisa waktu.
3. **Stale** — tidak ada aktivitas > 5 hari kerja.

### Filter
Periode, Area, Dealer, Model, Symptom Category, Priority, Status, Assigned to.
Filter disimpan di URL hash supaya bisa di-bookmark dan di-share.

## 4. Bentuk response

```json
{
  "scope": "distributor",
  "period": "30d",
  "generatedAt": "2026-08-30T09:30:00+07:00",
  "stale": false,
  "cards": [
    { "key": "active", "label": "Case aktif", "value": 128, "delta": -6, "tone": "neutral" },
    { "key": "overdue_iidi", "label": "Overdue IIDI", "value": 4, "delta": 1, "tone": "danger" }
  ],
  "charts": {
    "casesPerDealer": { "labels": ["..."], "datasets": [{ "label": "Aktif", "data": [12, 9] }] },
    "trend": { "labels": ["W31"], "datasets": [{ "label": "Dibuat", "data": [14] }] }
  },
  "tables": {
    "leaderboard": { "columns": ["..."], "rows": [["..."]] },
    "unassigned": { "columns": ["..."], "rows": [["..."]] }
  }
}
```

Bentuk `charts` sengaja langsung cocok dengan Chart.js supaya frontend tidak perlu
menerjemahkan apa-apa.

## 5. Ekspor

Tombol "Unduh CSV" pada leaderboard dan tabel case. Backend membuat CSV dari data yang
sudah ter-scope, catat ke `AUDIT_LOG` dengan action `EXPORT`. Dealer hanya bisa ekspor
data dealer-nya.

## 6. Tampilan di HP

Dashboard distributor di HP: kartu ditumpuk 2 kolom, chart disembunyikan di balik tab,
leaderboard jadi daftar kartu ringkas dengan 3 angka terpenting (aktif, overdue,
SLA %). Jangan paksa tabel 9 kolom muat di layar 360px.
