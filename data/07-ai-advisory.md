# 07 — AI Advisory (Gemini)

## 1. Batas kewenangan AI

AI **hanya memberi saran**. Tidak pernah mengubah data.

| AI boleh | AI tidak boleh |
|---|---|
| Menyarankan priority perlu ditinjau | Mengubah `Priority` |
| Merekomendasikan bukti yang sebaiknya dilampirkan | Menandai bukti sebagai wajib |
| Menunjukkan case serupa | Menutup, mengeskalasi, atau memindahkan status |
| Menyoroti informasi yang kurang | Menolak submit |

Setiap output AI di UI diberi label jelas: **"Saran sistem — perlu ditinjau"**, dengan
tombol "Terapkan" yang tetap membutuhkan klik manusia.

## 2. Arsitektur dua lapis

```
advisory.get
   ├─ Lapis 1: RULE ENGINE  (selalu jalan, instan, gratis, deterministik)
   │     └─ EVIDENCE_RULES + logika priority
   └─ Lapis 2: GEMINI       (opsional, memperkaya lapis 1)
         └─ gagal / kuota habis / FEATURE_GEMINI=FALSE → pakai hasil lapis 1 saja
```

**Rule engine dibangun duluan dan harus berdiri sendiri.** Gemini adalah lapisan tambahan.
Kalau Gemini mati, sistem tetap berguna. Jangan pernah bikin alur yang menggantung
menunggu respons Gemini.

## 3. Lapis 1 — Rule engine

### Rekomendasi bukti
1. Ambil `Symptom_Category`, `DTC_Codes`, `Control_Unit`, `Complaint_Desc` dari case.
2. Cocokkan dengan `EVIDENCE_RULES` (`Match_Type` + `Match_Value`).
3. Gabungkan hasil, buang duplikat, urutkan berdasarkan `Priority`.
4. Silangkan dengan `CASE_ATTACHMENTS` untuk menandai mana yang sudah ada.

Output per item: `{ evidenceType, label, priority, mandatory, alreadyUploaded }`.

### Saran priority
Aturan sederhana, transparan, gampang dijelaskan ke dealer:

| Kondisi | Saran |
|---|---|
| `Vehicle_Status = Not_Drivable` dan priority `Normal` | Sarankan tinjau ke `Urgent` |
| Kata kunci keselamatan di keluhan (rem, kemudi, airbag, kebakaran, asap, hilang tenaga saat jalan) | Sarankan tinjau ke `Urgent`/`Critical` |
| `Frequency = Always` + `Not_Drivable` | Sarankan `Critical` |
| Kendaraan sudah > 5 hari di bengkel | Sarankan tinjau prioritas |
| VIN yang sama sudah pernah kena case dalam 90 hari | Tandai sebagai kasus berulang |

Format saran persis seperti di master prompt asli:

> Dealer Priority: Normal
> Saran sistem: Berdasarkan kondisi kendaraan dan keluhan, case ini berpotensi
> membutuhkan penanganan Urgent. Silakan tinjau kembali priority case.

### Advisory self-diagnosis
Saat dealer menekan "Kirim ke IIDI" dan umur case < 3 hari kerja, tampilkan dialog:

> Berdasarkan standard troubleshooting flow, dealer masih berada dalam periode
> self-diagnosis 3 hari kerja. Technical support tetap dapat diminta apabila diperlukan.
>
> [ Lanjut kirim ke IIDI ]   [ Lanjutkan self-diagnosis ]

Tombol kirim **tetap aktif dan berfungsi**. Ini dialog informatif, bukan gerbang.
Pilihan dealer dicatat di `CASE_EVENTS`.

## 4. Lapis 2 — Gemini

### Endpoint
```
POST https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent
Header: x-goog-api-key: <GEMINI_API_KEY>
```

- `MODEL` diambil dari `CONFIG.GEMINI_MODEL`, **bukan hardcode**. Nama model Gemini
  berubah cukup sering, jadi harus bisa diganti tanpa deploy ulang.
- API key di **Script Properties** (`GEMINI_API_KEY`), bukan di sheet, bukan di kode.
- Ambil key di https://aistudio.google.com/apikey (tidak perlu kartu kredit).
- Saat setup, cek dulu daftar model dan kuota yang berlaku di halaman rate limits resmi
  Google, lalu isi `CONFIG.GEMINI_MODEL` dengan model kelas Flash yang tersedia gratis.

### ⚠️ Privasi data — ini penting

Free tier Gemini mengizinkan Google memakai prompt untuk pengembangan produk. Sistem ini
berisi data pelanggan dan kendaraan, jadi:

**Wajib di-redact sebelum dikirim ke Gemini:**
- `VIN` → kirim hanya 8 karakter terakhir, atau tidak sama sekali
- `Cust_Name` → jangan dikirim
- `Reg_No` (nomor polisi) → jangan dikirim
- `Engine_No`, `Trans_No` → jangan dikirim
- Nama dealer dan nama user → jangan dikirim

**Yang boleh dikirim:** model kendaraan, tahun produksi, kilometer, deskripsi keluhan,
kategori symptom, DTC, control unit, hasil diagnosis, kondisi kendaraan.

Tulis fungsi `redactForAi_(caseRow)` dan **semua** panggilan Gemini harus lewat fungsi itu.
Tanpa pengecualian. Kalau nanti pindah ke tier berbayar (data tidak dipakai training),
aturan ini boleh dilonggarkan lewat flag di CONFIG.

### Structured output
Paksa JSON, jangan parsing teks bebas:

```js
const body = {
  systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
  contents: [{ role: 'user', parts: [{ text: JSON.stringify(redacted) }] }],
  generationConfig: {
    temperature: 0.2,
    maxOutputTokens: 1024,
    responseMimeType: 'application/json',
    responseSchema: {
      type: 'OBJECT',
      properties: {
        priorityAdvice: {
          type: 'OBJECT',
          properties: {
            suggested: { type: 'STRING', enum: ['Normal','Urgent','Critical','No_Change'] },
            reason:    { type: 'STRING' }
          }
        },
        recommendedEvidence: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              evidenceType: { type: 'STRING' },
              label:        { type: 'STRING' },
              why:          { type: 'STRING' }
            }
          }
        },
        missingInformation: { type: 'ARRAY', items: { type: 'STRING' } },
        likelyDirection:    { type: 'STRING' },
        confidence:         { type: 'STRING', enum: ['low','medium','high'] }
      },
      required: ['priorityAdvice','recommendedEvidence','confidence']
    }
  }
};

const res = UrlFetchApp.fetch(url, {
  method: 'post',
  contentType: 'application/json',
  headers: { 'x-goog-api-key': key },
  payload: JSON.stringify(body),
  muteHttpExceptions: true
});
```

### System prompt (Bahasa Indonesia)

```
Anda adalah asisten technical advisor untuk after-sales kendaraan Mercedes-Benz.
Anda membantu teknisi dealer menyiapkan case teknis sebelum diteruskan ke tim
technical distributor.

Tugas Anda:
1. Menilai apakah priority yang dipilih dealer masuk akal terhadap kondisi kendaraan
   dan keluhan. Beri saran, jangan memutuskan.
2. Merekomendasikan bukti diagnostik yang sebaiknya dilampirkan, spesifik terhadap
   gejala dan DTC yang ada. Sebut sebagai "recommended evidence".
3. Menyebutkan informasi penting yang belum diisi.
4. Menyebutkan arah investigasi yang paling mungkin, dengan bahasa hati-hati.

Aturan:
- Jangan pernah menyatakan diagnosis sebagai kepastian. Gunakan "kemungkinan",
  "perlu diverifikasi".
- Jangan menyebut bukti sebagai wajib.
- Jangan merekomendasikan penggantian part tanpa verifikasi pengukuran.
- Jawab dalam Bahasa Indonesia teknis yang ringkas.
- Kalau data terlalu sedikit untuk disimpulkan, katakan begitu dan set confidence "low".
```

### Penanganan kegagalan
| Kondisi | Aksi |
|---|---|
| HTTP 429 (kuota) | Retry sekali setelah 3 detik, lalu fallback ke hasil rule |
| HTTP 5xx | Fallback langsung |
| Timeout > 20 detik | Fallback langsung |
| JSON tidak sesuai schema | Fallback, catat error di `AI_ADVISORY_LOG` |
| `FEATURE_GEMINI = FALSE` | Lewati Gemini sepenuhnya |

Fallback berarti: kembalikan hasil rule engine dengan `source: 'RULE'`. **Jangan
tampilkan pesan error ke dealer.** Dealer tidak perlu tahu Gemini sedang bermasalah.

### Hemat kuota
Free tier itu ketat (kelas Flash sekitar 10 permintaan per menit; batas harian berubah-ubah
dan sempat dipangkas, jadi cek angka terbaru saat setup). Strategi:

1. **Cache berbasis hash.** Hitung hash dari data yang di-redact. Kalau `AI_ADVISORY_LOG`
   sudah punya hash yang sama untuk case ini, kembalikan hasil lama.
2. **Panggil hanya di dua titik:** saat case pertama kali dikirim ke IIDI, dan saat user
   menekan tombol "Minta saran ulang" (maks 5x per case per hari).
   **Jangan** panggil saat mengetik atau tiap kali halaman dibuka.
3. **Antrean, bukan paralel.** Kalau ada beberapa case sekaligus, proses berurutan.
4. Pantau pemakaian harian di `AI_ADVISORY_LOG`. Kalau mendekati batas, set
   `FEATURE_GEMINI = FALSE` otomatis sampai tengah malam.

Dengan pola ini, 15 dealer membuat ~20 case per hari = ~20–40 panggilan per hari.
Aman jauh di bawah batas gratis manapun.

## 5. Tampilan advisory

Panel di halaman detail case, bisa ditutup:

```
┌─ Saran sistem ─────────────────────────── ditinjau: 30 Agu 09:15 ─┐
│  Priority                                                          │
│  Dealer memilih: Normal                                            │
│  Saran: tinjau ke Urgent — kendaraan tidak dapat dikendarai        │
│                                        [ Ubah ke Urgent ] [ Abaikan ]│
│                                                                     │
│  Bukti yang disarankan                                              │
│  ✓ Initial Quick Test              sudah dilampirkan                │
│  ○ Actual values ME9.7             belum — [ Unggah ]               │
│  ○ Foto konektor                   belum — [ Unggah ]               │
│                                                                     │
│  Informasi yang belum lengkap                                       │
│  • Kondisi saat gejala muncul belum diisi                           │
│                                                                     │
│  Keyakinan: sedang · sumber: Gemini            [ Minta saran ulang ]│
└─────────────────────────────────────────────────────────────────────┘
```

Tombol "Ubah ke Urgent" mengisi form, **tidak** langsung menyimpan. User tetap harus
menekan simpan.

## 6. Similar case retrieval (fase 10)

Tidak perlu embedding. Skoring sederhana sudah cukup akurat untuk 15 dealer:

| Kecocokan | Bobot |
|---|---|
| DTC sama persis | 40 |
| Model sama | 20 |
| Symptom_Category sama | 15 |
| Control_Unit sama | 15 |
| Kata kunci keluhan beririsan (Jaccard) | 0–10 |

Ambil 5 skor tertinggi di atas 40. Tampilkan Case_No, model, root cause, solusi, dan
tautan. Case dari dealer lain **boleh** dilihat isinya dalam konteks KB, tapi tanpa
nama pelanggan dan tanpa nomor polisi.
