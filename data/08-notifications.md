# 08 — Notifikasi

Ini fitur penentu apakah sistem dipakai atau ditinggalkan. Dealer tidak akan membuka
portal setiap hari dengan sendirinya. Kalau notifikasinya lemah, semua orang balik ke
WhatsApp dan sistem ini jadi arsip mati.

## 1. Arsitektur

**Queue + worker.** Jangan pernah kirim email langsung di dalam request user.

```
Aksi user → Notify_.enqueue(...)          → tulis PENDING ke NOTIFICATIONS_QUEUE
                                             (request selesai cepat)

Trigger tiap 5 menit → Notify_.processQueue() → ambil PENDING (maks 50)
                                              → kirim per channel
                                              → tandai SENT / FAILED
```

Alasan: `MailApp.sendEmail` bisa lambat, dan kalau gagal user tidak boleh ikut gagal.
Queue juga memberi retry dan jejak audit gratis.

Retry: maks 3 percobaan, jeda 5 / 15 / 60 menit. Setelah itu `FAILED` dan muncul di
panel admin.

Kuota: akun Google Workspace ~1.500 email/hari, akun gratis ~100/hari. Jauh di atas
kebutuhan (~50–100 email/hari). Tetap catat pemakaian harian di `CONFIG` agar ketahuan
kalau ada yang salah.

## 2. Pemicu notifikasi

| Event | Penerima | Channel |
|---|---|---|
| Case dikirim ke IIDI | Semua `IIDI_Tech` + `IIDI_Tech_Mgr` | Email |
| Case Urgent/Critical dikirim | IIDI_Tech, IIDI_Tech_Mgr, IIDI_Area_Mgr | Email (subjek diberi tanda) |
| Case diambil IIDI | Pembuat case | Email |
| Balasan thread baru | Pihak lawan (dealer ↔ IIDI) | Email |
| Additional data request | Pembuat case + Dealer_SM | Email |
| Data request dipenuhi | IIDI pemilik case | Email |
| Status berubah | Pemilik lama + pemilik baru | Email |
| SLA near due (< 1 jam kerja) | Pemilik saat ini | Email |
| SLA overdue | Pemilik + atasannya | Email |
| Eskalasi ke MBAG | Pembuat case, Dealer_SM, IIDI_Area_Mgr | Email |
| MBAG menjawab | IIDI pemilik case | Email |
| Request closure | Pembuat case + Dealer_SM | Email |
| Case ditutup | Semua yang terlibat | Email |
| Akun terkunci | User + IIDI_Tech_Mgr | Email |
| Ringkasan harian | Setiap user dengan case butuh aksi | Email, 08:15 WIB |

**Anti-spam wajib:**
- Kelompokkan balasan thread: maks satu email per case per user per 30 menit.
- Ringkasan harian menggantikan notifikasi individual untuk case yang sudah lama menunggu.
- Jangan kirim ke pelaku aksinya sendiri.
- Setiap user punya preferensi `Notif_Level`: `All` / `Important_Only` / `Daily_Digest`.
  Simpan sebagai kolom tambahan di `USERS`.
**Keputusan implementasi Fase 6:**

- Pemetaan `Notif_Level`. `Important_Only` menerima: case Urgent/Critical masuk,
  additional data request, SLA overdue, MBAG menjawab, eskalasi ke MBAG, dan
  ringkasan harian. Sisanya hanya untuk `All`.
- **`ACCOUNT_LOCKED` lolos semua filter**, termasuk `Daily_Digest`. Ini email
  keamanan — kalau ada yang menebak PIN akun seseorang, dia harus tahu hari itu
  juga, bukan besok pagi. Penyimpangan sadar dari aturan preferensi di atas.
- "MBAG menjawab" dikirim ke sisi dealer + `IIDI_Tech_Mgr`, bukan ke "IIDI pemilik
  case" seperti tabel di atas. Alasannya: MBAG tidak pernah login ke sistem —
  jawabannya masuk lewat teknisi IIDI yang mengembalikan status, sehingga pemilik
  case adalah pelaku aksinya sendiri dan sudah disaring keluar. Yang benar-benar
  menunggu kabar itu dealer.
- Notifikasi ke `IIDI_Area_Mgr` diturunkan dari `DEALERS.Area_Manager_User_ID`.
  Selama kolom itu masih kosong, penerima tersebut dilewati diam-diam dan dicatat
  di log — satu area manager yang belum terdaftar tidak boleh menggagalkan
  notifikasi ke penerima lain.
## 3. Template email

Plain HTML sederhana. Jangan pakai gambar. Banyak yang dibaca di HP dengan koneksi bengkel.

```
Subjek: [MB T-CASE] CN-0027 · Data tambahan diminta · W205 C200

Halo Budi,

Tim technical IIDI meminta data tambahan untuk case berikut.

  Case       : CN-0027
  Kendaraan  : W205 C200 (2019)
  Keluhan    : Mesin pincang saat idle
  Diminta oleh: Ahmad (IIDI Technical)
  Batas waktu : Senin, 1 Sep 2026 pukul 14:00 WIB (2 hari kerja)

Yang diminta:
  1. Actual values ME9.7 saat kondisi idle
  2. Foto konektor injector silinder 3

  Buka case: https://afs-digitalsolution.web.id/tcase/#/case/CN-0027

--
MB T-CASE · Technical Case Escalation & Management System
Anda menerima email ini karena terlibat dalam case CN-0027.
Preferensi notifikasi diatur oleh administrator sistem.
```

Aturan penulisan:
- Subjek selalu diawali `[MB T-CASE]` supaya gampang difilter di Gmail.
- Case_No selalu di subjek, supaya thread email tetap terkelompok.
- Batas waktu ditulis lengkap dengan hari dan jam WIB, bukan "2 hari lagi".
- Tautan langsung ke case, bukan ke beranda.

Kirim pakai `MailApp.sendEmail({ to, subject, htmlBody, name: 'MB T-CASE' })`.
Kalau butuh alias pengirim khusus, pakai `GmailApp.sendEmail` dengan opsi `from`
(alias harus sudah terdaftar di akun Gmail pemilik script).

## 4. WhatsApp — siap pasang, belum aktif

Rancang sekarang, aktifkan nanti. Jangan tunda arsitekturnya.

### Lapisan adapter
```js
const CHANNELS = {
  EMAIL: sendEmail_,
  WA:    sendWhatsapp_    // stub sampai provider siap
};

function sendWhatsapp_(notif) {
  const cfg = Config_.all();
  if (cfg.FEATURE_WA !== 'TRUE') {
    return { status: 'SKIPPED', error: 'Kanal WA belum aktif' };
  }
  const provider = cfg.WA_PROVIDER;                  // 'FONNTE' | 'WABLAS' | 'META' | 'CUSTOM'
  return WA_PROVIDERS[provider](notif);
}
```

Setiap provider mengimplementasi kontrak yang sama:
```js
// input : { to, text, caseNo }
// output: { status: 'SENT'|'FAILED', providerId, error }
```

Dengan ini, mengaktifkan WA nanti = tulis satu fungsi + isi 3 baris di CONFIG.
Tidak ada perubahan di logika bisnis manapun.

### Pilihan provider

| Opsi | Biaya | Catatan |
|---|---|---|
| **Deep link `wa.me`** | Gratis | Bukan pengiriman otomatis. Tombol "Bagikan ke WA" di UI yang membuka WhatsApp dengan pesan sudah terisi. **Pasang ini sekarang** di fase 6 |
| Fonnte / Wablas (lokal) | Murah, langganan bulanan | Tidak resmi, pakai nomor sendiri, risiko banned ada. Cocok untuk internal |
| WhatsApp Business API resmi (Meta) | Bayar per percakapan | Resmi dan stabil. Butuh verifikasi bisnis dan template pesan yang disetujui |
| Nomor WA API yang sudah dimiliki | — | Kalau sudah ada, tinggal tulis adapter-nya |

**Yang dipasang di fase 6:** kanal email penuh + tombol `wa.me` di UI. Adapter WA
otomatis dibuat sebagai stub yang mengembalikan `SKIPPED`.

Tombol `wa.me`:
```js
const text = `[MB T-CASE] ${caseNo}\n${model}\n${complaint}\n\nBuka: ${caseUrl}`;
const url  = `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
```

### Saat provider WA sudah ada
1. Isi `WA_PROVIDER`, `FEATURE_WA=TRUE` di CONFIG; token API di Script Properties.
2. Tulis fungsi adapter sesuai kontrak di atas.
3. Tentukan event mana yang naik ke WA. Saran: **hanya yang mendesak** —
   Urgent/Critical baru, SLA overdue, additional data request, MBAG menjawab.
   Sisanya tetap email. Kalau semua event dikirim ke WA, orang akan mematikannya.

## 5. Panel admin notifikasi

Halaman untuk `IIDI_Tech_Mgr`:
- Antrean `PENDING` dan `FAILED`
- Tombol kirim ulang manual
- Jumlah email terkirim hari ini vs kuota
- Kirim email uji

## 6. Ringkasan harian

Trigger 08:15 WIB, hari kerja saja. Satu email per user yang punya case butuh aksi:

```
Subjek: [MB T-CASE] 3 case menunggu tindakan Anda

Selamat pagi Budi,

Menunggu tindakan Anda hari ini:

  🔴 CN-0021  Data tambahan  terlambat 4 jam kerja
  🟡 CN-0027  Data tambahan  sisa 45 menit kerja
  🟢 CN-0033  Konfirmasi closure  sisa 1 hari kerja

  Buka daftar: https://afs-digitalsolution.web.id/tcase/#/tasks
```

Ini yang menggantikan kebiasaan "japri dulu di grup". Satu email, jelas, ada urutan
prioritas, satu tautan.
