# Roadmap & Progress MB T-CASE Management

File ini dipakai untuk tracking status implementasi MB T-CASE secara bertahap.

> **Revisi Fase 0 — ditulis ulang total.** Draf sebelumnya punya 8 fase dengan urutan
> dan penomoran berbeda dari `CLAUDE.md` §7 (11 fase, 0–10), dan menyebut stack frontend
> React CDN padahal `CLAUDE.md` §2 menetapkan **Alpine.js** (bukan React). File ini
> sekarang mengikuti `CLAUDE.md` §7 persis — itu yang jadi acuan tunggal urutan fase.
> Jangan edit urutan fase di sini tanpa mengubah `CLAUDE.md` §7 dulu.

---

## 📌 Phase Overview & Status

- [X] **Fase 0 — Environment & Foundation Setup**
  clasp setup, `appsscript.json`, route worker `/tcase/*`, `90_Setup.gs` membuat
  seluruh sheet (20, lihat `01-schema.md` §2A) + seed data.
  Referensi: `00-getting-started.md`, `01-schema.md`, `CLAUDE.md` §2–§3.
  **Selesai kalau:** buka URL custom domain (`https://afs-digitalsolution.web.id/tcase/`)
  memunculkan halaman login.

- [x] **Fase 1 — Authentication & RBAC Engine**
  PIN hash (`hashPin_`), session token (JWT-like HMAC), lockout, guard `requirePerm_`
  dan `assertCanAccessCase_`.
  Referensi: `03-rbac.md`.
  **Selesai kalau:** dealer A login lalu coba akses case dealer B lewat payload →
  ditolak backend (`FORBIDDEN`, tercatat di `AUDIT_LOG`).
REVISI (Fase 1): worker afs-digitalsolution bukan reverse proxy melainkan iframe
wrapper (renderAppFrame()), sama seperti 4 app lain di portal. SPA berjalan di dalam
iframe pada origin *.googleusercontent.com dan memanggil /exec langsung — URL-nya
disuntik server ke window.__MBTCASE_EXEC_URL__ (lihat ui/Index.html, ui/js_core.html).
POST ke afs-digitalsolution.web.id/tcase/ mengembalikan HTML shell, bukan JSON.
CLAUDE.md §2 dan §3.8 yang menyebut "reverse proxy" dan "redirect: 'follow'" perlu
dikoreksi dengan cara yang sama — pola proxy itu tidak pernah ada di worker.

- [x] **Fase 2 — Case CRUD, Penomoran & State Machine**
  CRUD case, penomoran via `LockService`, transisi status legal,
  tulis `CASE_EVENTS` di setiap mutasi. Semua di `20_CaseService.gs`
  (namespace `Case_`), akses sheet hanya lewat `TC`.
  Referensi: `04-state-machine.md`, `01-schema.md` §4, §9.
  **Selesai kalau:** bikin 3 case bersamaan → nomor berurutan dan unik,
  `CASE_COUNTER` naik persis 3.

  > **REVISI (Fase 2) — acceptance:**
  > ```
  > KODE LAMA:
  > Selesai kalau: bikin 3 case bersamaan → CN-0001..0003, tidak ada duplikat.
  >
  > KODE BARU:
  > Selesai kalau: bikin 3 case bersamaan → nomor berurutan dan unik,
  > CASE_COUNTER naik persis 3.
  > ```
  > Alasan: nomor literal `CN-0001..0003` tidak bisa dipakai sebagai kriteria.
  > `CASE_COUNTER` naik terus dan tidak pernah reset (`01-schema.md` §19), jadi
  > nomor yang terpakai pengujian hangus permanen. Uji konkurensi sungguhan
  > memakai trigger terpisah: `seedConcurrentCaseTest()` lalu
  > `checkConcurrentCaseNo()` di `99_Tests.gs` — `runCaseTests()` hanya
  > sekuensial dan tidak pernah menyentuh jalur rebutan `ScriptLock`.
  > Hasil verifikasi 01 Sep 2026: `runCaseTests()` 17/17 PASS,
  > `checkConcurrentCaseNo()` → CN-0057/0058/0059 unik, counter +3,
  > 5 uji HTTP ke `/exec` sesuai (`case.list` ok, `case.bogus` NOT_FOUND,
  > `case.get` NOT_FOUND, `case.setPriority` FORBIDDEN, token rusak
  > UNAUTHENTICATED).

  **Belum tercakup, dibawa ke fase berikutnya:**
  - Kolom deadline masih `''` sampai `30_SlaEngine.gs` ada (Fase 3).
    Akibatnya override closure oleh `IIDI_Tech_Mgr` belum bisa dijalankan.
  - Filter `slaStatus[]` di `case.list` belum aktif (Fase 3).
  - `Quality_Score` berplafon 90 — 10 poin evidence coverage butuh
    `EVIDENCE_RULES` (Fase 7).
  - Scope `IIDI_Area_Mgr` (`ctx.user.areas`) belum teruji: `DEALERS.Area_Manager_User_ID`
    masih kosong.
  - `seedDemoData()` menghasilkan data tidak konsisten dengan spec (owner kosong,
    semua deadline terisi, `Created_By_User_ID` berisi user IIDI, quality score acak).
    Perbaiki di Fase 8 sebelum uji performa 500 case.

- [X] **Fase 3 — SLA Engine**
  `30_SlaEngine.gs` pure function (jam kerja, deadline, status SLA) + unit test.
  Referensi: `05-sla-engine.md`.
  **Selesai kalau:** semua test case di `05-sla-engine.md` §7 lulus (`runSlaTests()`).

- [x] **Fase 4 — Evidence Upload**
  Backend lulus dari editor GAS: attach.upload (INLINE), attach.list,
  attach.download (chunk base64), attach.delete, registry CASE_FOLDERS,
  Quality_Score recalc, migrateFase4() + trigger attachHousekeeping_ (01:00).
  Belum diverifikasi: jalur RESUMABLE (initUpload → PUT browser → completeUpload)
  dan housekeeping file yatim — keduanya butuh UI upload, diuji di fase frontend.

- [x] **Fase 5 — Thread & Additional Data Request**
  Diskusi teknis (`CASE_THREAD`), alur `request.create` / `request.fulfill`.
  Referensi: `01-schema.md` §6, §11, `02-api-contract.md` §"Thread"/"Additional data request".
  **Selesai kalau:** round-trip dealer ↔ IIDI lengkap dengan deadline.

- [x] **Fase 6 — Notifikasi**
  Queue + worker (`50_Notify.gs`), trigger 5 menit, digest harian 08:15, kuota email
  dihitung per **penerima** (Workspace, 1.500/hari), tombol `wa.me` di UI (adapter WA
  penuh masih stub).
  Referensi: `08-notifications.md`.
  **Selesai kalau:** status case berubah → email masuk dalam 5 menit.

- [ ] **Fase 7 — AI Advisory**
  Rule engine (`EVIDENCE_RULES` + logika priority) dulu, baru lapis Gemini dengan
  redaksi data wajib (`redactForAi_`) dan fallback diam-diam saat Gemini gagal/mati.
  Referensi: `07-ai-advisory.md`.
  **Selesai kalau:** advisory muncul di UI, fallback ke rule engine jalan saat
  `FEATURE_GEMINI = FALSE` atau API mati, dealer tidak melihat pesan error apapun.

- [ ] **Fase 8 — Dashboard**
  Dashboard dealer + distributor, snapshot `DASHBOARD_SNAPSHOT` di-refresh trigger
  30 menit, fallback ke Drive kalau payload > 45.000 karakter.
  Referensi: `06-dashboard.md`, `01-schema.md` §18.
  **Selesai kalau:** dashboard distributor load < 3 detik dengan 500 case dummy
  (`seedDemoData(500)`).

- [ ] **Fase 9 — MBAG Escalation & Closure Flow**
  `escalation.create`/`escalation.update`, `closure.request`/`closure.confirm`,
  override closure oleh `IIDI_Tech_Mgr` setelah `Closure_Deadline` lewat.
  Referensi: `04-state-machine.md`, `01-schema.md` §12.
  **Selesai kalau:** case bisa naik ke MBAG dan ditutup dengan konfirmasi dealer.

- [ ] **Fase 10 — Knowledge Base & Similar Case**
  Skoring kemiripan (DTC, model, symptom, control unit, keyword Jaccard),
  `kb.search`/`kb.similar`/`kb.create`.
  Referensi: `07-ai-advisory.md` §6, `01-schema.md` §17.
  **Selesai kalau:** case baru menampilkan 5 case mirip.

---

## Stack (ikuti CLAUDE.md §2 — jangan menyimpang tanpa alasan tertulis)

- **Backend:** Google Apps Script (V8)
- **Database:** Google Sheets
- **File storage:** Google Drive (folder private, akses via proxy GAS)
- **Frontend:** HTML5 SPA, **Alpine.js** (bukan React, bukan vanilla polos),
  TailwindCSS CDN (versi di-pin), Chart.js, FontAwesome
- **AI Advisory:** Gemini API via `UrlFetchApp`
- **Deploy tooling:** `clasp`

---

## 💡 Petunjuk Penggunaan untuk Chat Claude Baru

Setiap kali akan memulai fase baru:
1. Pastikan `docs/00-roadmap.md` ini ada di **Konteks Proyek Claude**.
2. Ubah `[ ]` menjadi `[x]` pada fase yang sudah lulus acceptance checklist-nya.
3. Kirim prompt singkat ke Claude di **Chat Baru**:
   > *"Sesuai `00-roadmap.md`, kita masuk ke Fase [N]. Baca `CLAUDE.md` dan file
   > docs relevan yang disebut di baris fase itu sebelum menulis kode apapun.
   > Kerjakan fase itu saja."*
4. Jangan tandai `[x]` sebelum acceptance checklist fase itu benar-benar lulus —
   `CLAUDE.md` §1 melarang lompat fase.
