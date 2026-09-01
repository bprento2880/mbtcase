# 04 — State Machine Case

## 1. Status

| Status | Arti | Siapa yang harus bertindak |
|---|---|---|
| `Created` | Draft, dealer masih mengisi. Belum terlihat oleh IIDI | Dealer |
| `Open` | Sudah dikirim ke IIDI, belum diambil siapapun | IIDI (pool) |
| `In Progress` | Sudah diambil IIDI_Tech tertentu | IIDI_Tech |
| `Waiting Dealer Reply` | IIDI menunggu data/konfirmasi dari dealer | Dealer |
| `Waiting IIDI` | Dealer sudah membalas, bola di IIDI | IIDI_Tech |
| `Escalated to MBAG` | Sudah dinaikkan ke MBAG | IIDI_Tech_Mgr |
| `Request Closure` | IIDI mengusulkan penutupan, menunggu konfirmasi dealer | Dealer |
| `Closed` | Selesai | — |

`Current_Waiting_Reason` memperjelas alasan penundaan dan **wajib diisi** untuk status
`Waiting Dealer Reply`, `Waiting IIDI`, dan `Escalated to MBAG`.

## 2. Transisi yang legal

Transisi di luar tabel ini → `CONFLICT`. Tidak ada pengecualian.

| Dari | Ke | Siapa | Efek samping |
|---|---|---|---|
| `Created` | `Open` | Dealer | Set `Submitted_To_IIDI_At`, set `IIDI_Response_Deadline`, notif IIDI |
| `Created` | `Closed` | Dealer | `Closure_Type = Cancelled_By_Dealer` |
| `Open` | `In Progress` | IIDI_Tech | Set `Current_Owner_User_ID`, set `First_IIDI_Response_At` kalau masih kosong |
| `Open` | `Waiting Dealer Reply` | IIDI_Tech | Sekaligus membuat `DATA_REQUESTS` |
| `In Progress` | `Waiting Dealer Reply` | IIDI_Tech | Buat `DATA_REQUESTS`, set `Dealer_Response_Deadline` |
| `In Progress` | `Escalated to MBAG` | IIDI_Tech_Mgr | Buat `MBAG_ESCALATIONS`, siapkan folder paket bukti |
| `In Progress` | `Request Closure` | IIDI_Tech | Set `Closure_Deadline`, notif dealer |
| `Waiting Dealer Reply` | `Waiting IIDI` | Dealer | Tutup `DATA_REQUESTS`, set `IIDI_Decision_Deadline` |
| `Waiting IIDI` | `In Progress` | IIDI_Tech | |
| `Waiting IIDI` | `Escalated to MBAG` | IIDI_Tech_Mgr | |
| `Waiting IIDI` | `Request Closure` | IIDI_Tech | |
| `Escalated to MBAG` | `In Progress` | IIDI_Tech | MBAG sudah menjawab |
| `Escalated to MBAG` | `Waiting Dealer Reply` | IIDI_Tech | MBAG minta data tambahan |
| `Escalated to MBAG` | `Request Closure` | IIDI_Tech | |
| `Request Closure` | `Closed` | Dealer (konfirmasi) | Set `Closed_At`, `Closed_By`, `Closure_Type` |
| `Request Closure` | `In Progress` | Dealer (tolak) | Dealer menyatakan masalah belum selesai |
| `Request Closure` | `Closed` | IIDI_Tech_Mgr | Override setelah `Closure_Deadline` lewat |
| `Closed` | `In Progress` | IIDI_Tech / Dealer_SM (≤7 hari) | Reopen, catat `Reopened` di CASE_EVENTS |

## 3. Diagram

```
                        ┌──────────┐
                        │ Created  │
                        └────┬─────┘
                             │ kirim ke IIDI
                        ┌────▼─────┐
                   ┌────┤   Open   │
                   │    └────┬─────┘
                   │         │ IIDI ambil case
                   │    ┌────▼──────────┐
                   │    │  In Progress  │◄──────────────┐
                   │    └──┬────┬────┬──┘               │
       minta data  │       │    │    │ eskalasi         │
                   ▼       │    │    ▼                  │
        ┌──────────────────┴─┐  │  ┌──────────────────┐ │
        │ Waiting Dealer     │  │  │ Escalated to     │ │
        │ Reply              │  │  │ MBAG             ├─┘
        └─────────┬──────────┘  │  └────────┬─────────┘
                  │ dealer balas│           │
        ┌─────────▼──────────┐  │           │
        │   Waiting IIDI     ├──┘           │
        └─────────┬──────────┘              │
                  │                         │
                  └──────────┬──────────────┘
                             ▼
                   ┌──────────────────┐
                   │ Request Closure  │
                   └────┬────────┬────┘
                dealer  │        │ dealer tolak
                konfirm │        └────────► In Progress
                   ┌────▼─────┐
                   │  Closed  │──── reopen ≤7 hari ────► In Progress
                   └──────────┘
```

## 4. Implementasi

```js
const TRANSITIONS = {
  'Created':            { 'Open': ['CDT','Senior_Tech','Dealer_SM'],
                          'Closed': ['CDT','Senior_Tech','Dealer_SM'] },
  'Open':               { 'In Progress': ['IIDI_Tech','IIDI_Tech_Mgr'],
                          'Waiting Dealer Reply': ['IIDI_Tech','IIDI_Tech_Mgr'] },
  // ...dst sesuai tabel bagian 2
};

function transition_(ctx, caseNo, toStatus, opts) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new AppError('BUSY', 'Sistem sedang sibuk, coba lagi.');
  try {
    const row = Cases_.get(caseNo);
    assertCanAccessCase_(ctx, row);

    const allowed = (TRANSITIONS[row.Status] || {})[toStatus];
    if (!allowed) {
      throw new AppError('CONFLICT',
        `Case tidak bisa berpindah dari "${row.Status}" ke "${toStatus}".`);
    }
    if (allowed.indexOf(ctx.user.role) === -1) {
      throw new AppError('FORBIDDEN', 'Role Anda tidak berwenang melakukan perpindahan ini.');
    }
    if (NEEDS_REASON.has(toStatus) && !opts.waitingReason) {
      throw new AppError('VALIDATION', 'Alasan penundaan wajib diisi.');
    }

    applySideEffects_(ctx, row, toStatus, opts);   // deadline, owner, dsb
    Cases_.update(caseNo, { Status: toStatus, /* ... */ });
    Events_.write(caseNo, 'Status_Changed', row.Status, toStatus, ctx, opts.note);
    Thread_.system(caseNo, `Status diubah menjadi ${toStatus} oleh ${ctx.user.fullName}.`);
    // Argumen ke-3 WAJIB objek (Fase 6). `from` membedakan "MBAG menjawab"
    // (Escalated to MBAG -> In Progress) dari "dealer sudah balas"
    // (Waiting IIDI -> In Progress). `actorUserId` mencegah email terkirim ke
    // orang yang baru menekan tombolnya sendiri (08-notifications.md §2).
    Notify_.enqueue('STATUS_CHANGED', caseNo, {
      from: row.Status, to: toStatus,
      actorUserId: ctx.user.userId, actorRole: ctx.user.role
    });
  from: row.Status, to: toStatus,
  actorUserId: ctx.user.userId, actorRole: ctx.user.role
});
    return Cases_.get(caseNo);
  } finally {
    lock.releaseLock();
  }
}
```

## 5. Yang TIDAK dilakukan state machine

- **Tidak** memindahkan status otomatis saat SLA habis. SLA expired hanya menulis event
  `SLA_Breached` dan mengirim notifikasi. Keputusan tetap manusia.
- **Tidak** menutup case otomatis karena tidak ada aktivitas. Case tanpa aktivitas jadi
  `Activity_Status = Stale` dan muncul di dashboard, tapi status tidak berubah.
- **Tidak** mengubah priority berdasarkan saran AI.
- **Tidak** memblokir `Created → Open` karena case belum 3 hari kerja. Yang muncul hanya
  advisory. Tombol tetap aktif.

## 6. Perhitungan `Activity_Status`

Dihitung saat read dari `Last_Activity_At`, dalam hari kerja:

| Selisih | Nilai |
|---|---|
| < 2 hari kerja | `Active` |
| 2–5 hari kerja | `No_Recent_Activity` |
| > 5 hari kerja | `Stale` |

Case berstatus `Closed` selalu `Active` (tidak relevan).
