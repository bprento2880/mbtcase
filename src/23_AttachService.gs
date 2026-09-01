/**
 * 23_AttachService.gs — FASE 4: Evidence Upload.
 * Acuan: 01-schema.md §7-§8, 02-api-contract.md §"Attachment", 03-rbac.md §2 §6.
 *
 * D1=A: file TIDAK PERNAH di-share publik. Baca file lewat attach.download
 * (POST, base64, per-chunk). GAS tidak bisa mengembalikan biner, jadi frontend
 * menyusun Blob sendiri.
 * Drive diakses langsung di file ini — larangan CLAUDE.md §4 hanya soal SpreadsheetApp.
 */
var Attach_ = (function () {

  const EVIDENCE_TYPES = ['Quick_Test','Actual_Value','Guided_Test','Photo','Video',
    'Wiring_Check','Measurement','Programming_Log','SCN_Coding','Repair_Doc','Other'];

  const CHUNK_BYTES   = 4 * 1024 * 1024;   // 4 MB/chunk untuk attach.download
  const UPLOAD_PER_HR = 30;                // 03-rbac.md §6
  const ORPHAN_HOURS  = 24;                // 02-api-contract.md §"Attachment"
  const DRIVE_API     = 'https://www.googleapis.com/drive/v3/files';
  const DRIVE_UPLOAD  = 'https://www.googleapis.com/upload/drive/v3/files';

  function s(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }
  function n(v) { const x = Number(v); return isNaN(x) ? 0 : x; }
  function has(a, v) { return a.indexOf(v) !== -1; }
  function pad6(x) { return ('000000' + x).slice(-6); }
  function tok() { return ScriptApp.getOAuthToken(); }

  // ── 1. Rate limit (03-rbac.md §6) ─────────────────────────────────────────
  function rateGuard_(ctx) {
    const key = 'rl_up_' + ctx.user.userId;
    const c = CacheService.getScriptCache();
    const cur = n(c.get(key));
    if (cur >= UPLOAD_PER_HR) {
      throw new AppError(ERROR_CODES.RATE_LIMIT,
        'Batas ' + UPLOAD_PER_HR + ' unggahan per jam tercapai. Coba lagi nanti.');
    }
    c.put(key, String(cur + 1), 3600);
  }

  // ── 2. Baris & guard case ─────────────────────────────────────────────────
  /** Semua entry point lewat sini: NOT_FOUND -> isolasi dealer -> status. */
  function caseFor_(ctx, caseNo, forWrite) {
    const r = TC.find(TC.S.CASES, 'Case_No', s(caseNo));
    if (!r) throw new AppError(ERROR_CODES.NOT_FOUND, 'Case ' + caseNo + ' tidak ditemukan.');
    assertCanAccessCase_(ctx, r);
    if (forWrite && r.Status === 'Closed') {
      throw new AppError(ERROR_CODES.CONFLICT, 'Case sudah ditutup, lampiran tidak bisa ditambah.');
    }
    return r;
  }

  function attachRow_(attachmentId) {
    const r = TC.find(TC.S.ATTACH, 'Attachment_ID', s(attachmentId));
    if (!r || r.Deleted === 'TRUE') {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Lampiran tidak ditemukan.');
    }
    return r;
  }

  /** ATTACH_COUNTER. WAJIB dipanggil di dalam TC.withLock (pola nextCaseNo). */
  function nextAttachId_() {
    TC.invalidate(TC.S.CONFIG);
    const c = TC.find(TC.S.CONFIG, 'Key', 'ATTACH_COUNTER');
    if (!c) throw new AppError(ERROR_CODES.INTERNAL,
      'CONFIG.ATTACH_COUNTER tidak ada. Jalankan migrateFase4() sekali.');
    const next = n(c.Value) + 1;
    TC.update(TC.S.CONFIG, c._row, { Value: String(next), Updated_At: TC.nowIso() });
    return 'AT-' + pad6(next);
  }

  // ── 3. Folder Drive: ROOT / [Dealer_ID] / [Case_No]_[VIN] ─────────────────
  function childFolder_(parent, name) {
    const it = parent.getFoldersByName(name);
    return it.hasNext() ? it.next() : parent.createFolder(name);
  }

  /**
   * Registry CASE_FOLDERS mencegah folder ganda saat dua user upload bersamaan
   * (01-schema.md §8). Pembuatan folder + tulis registry ada di dalam SATU lock.
   */
  function folderOf_(caseRow) {
    const hit = TC.find(TC.S.FOLDERS, 'Case_No', caseRow.Case_No);
    if (hit && s(hit.Folder_ID)) return s(hit.Folder_ID);

    return TC.withLock(function () {
      const again = TC.find(TC.S.FOLDERS, 'Case_No', caseRow.Case_No);   // cek ulang di dalam lock
      if (again && s(again.Folder_ID)) return s(again.Folder_ID);

      const root   = DriveApp.getFolderById(TC.prop('DRIVE_ROOT_ID'));
      const dealer = childFolder_(root, s(caseRow.Dealer_ID) || 'NO_DEALER');
      const fld    = childFolder_(dealer, caseRow.Case_No + '_' + s(caseRow.VIN));

      TC.append(TC.S.FOLDERS, {
        Case_No: caseRow.Case_No, Folder_ID: fld.getId(),
        Folder_URL: fld.getUrl(), Created_At: TC.nowIso()
      });
      TC.flush();
      return fld.getId();
    });
  }

  // ── 4. Tulis baris + efek samping ─────────────────────────────────────────
  function writeRow_(ctx, caseRow, meta) {
    const id = TC.withLock(function () {
      const aid = nextAttachId_();
      TC.append(TC.S.ATTACH, {
        Attachment_ID: aid, Case_No: caseRow.Case_No, Thread_ID: s(meta.threadId),
        Evidence_Type: meta.evidenceType, File_Name: meta.fileName,
        Drive_File_ID: meta.driveFileId, Drive_URL: meta.driveUrl,
        Mime_Type: meta.mimeType, Size_Bytes: meta.sizeBytes,
        Upload_Method: meta.method, Uploaded_By: ctx.user.userId,
        Uploaded_At: TC.nowIso(), Deleted: 'FALSE'
      });
      TC.flush();
      return aid;
    });

    Case_.event(ctx, caseRow.Case_No, 'Attachment_Added', '', meta.evidenceType,
                meta.fileName, { attachmentId: id, method: meta.method });
    Case_.recalcScore(ctx, caseRow.Case_No);   // 01-schema.md §20
    return publicOf_(attachRow_(id));
  }

  /** Drive_File_ID sengaja TIDAK dikirim ke frontend — akses hanya via attach.download. */
  function publicOf_(r) {
    return {
      attachmentId: r.Attachment_ID, caseNo: r.Case_No, threadId: r.Thread_ID,
      evidenceType: r.Evidence_Type, fileName: r.File_Name, mimeType: r.Mime_Type,
      sizeBytes: n(r.Size_Bytes), uploadMethod: r.Upload_Method,
      uploadedBy: r.Uploaded_By, uploadedAt: r.Uploaded_At,
      chunks: Math.max(1, Math.ceil(n(r.Size_Bytes) / CHUNK_BYTES))
    };
  }

  function evidenceOf_(v) {
    const e = s(v) || 'Other';
    if (!has(EVIDENCE_TYPES, e)) {
      throw new AppError(ERROR_CODES.VALIDATION, 'Jenis bukti tidak dikenal.',
        { evidenceType: 'Pilih salah satu jenis bukti yang tersedia.' });
    }
    return e;
  }

  // ── 5. attach.upload — inline base64, <= MAX_INLINE_UPLOAD_MB ─────────────
  function upload(ctx, p) {
    requirePerm_(ctx, 'attach.upload');
    rateGuard_(ctx);
    const caseRow = caseFor_(ctx, p.caseNo, true);
    const ev = evidenceOf_(p.evidenceType);
    const fileName = s(p.fileName) || 'lampiran';
    const b64 = s(p.dataBase64);
    if (!b64) throw new AppError(ERROR_CODES.VALIDATION, 'Isi file kosong.', { dataBase64: 'Wajib diisi.' });

    // Panjang base64 -> byte asli, dicek SEBELUM decode supaya file kelewat
    // besar tidak sempat memakan memori eksekusi.
    const bytes = Math.floor(b64.replace(/=+$/, '').length * 3 / 4);
    const maxMb = TC.cfgNum('MAX_INLINE_UPLOAD_MB', 5);
    if (bytes > maxMb * 1024 * 1024) {
      throw new AppError(ERROR_CODES.VALIDATION,
        'File melebihi ' + maxMb + ' MB. Pakai unggah file besar (resumable).',
        { fileName: 'Ukuran maksimum ' + maxMb + ' MB.' });
    }

    const mime = s(p.mimeType) || 'application/octet-stream';
    const folder = DriveApp.getFolderById(folderOf_(caseRow));
    const file = folder.createFile(
      Utilities.newBlob(Utilities.base64Decode(b64), mime, fileName));

    return { attachment: writeRow_(ctx, caseRow, {
      threadId: p.threadId, evidenceType: ev, fileName: fileName,
      driveFileId: file.getId(), driveUrl: file.getUrl(), mimeType: mime,
      sizeBytes: bytes, method: 'INLINE'
    }) };
  }

  // ── 6. attach.initUpload — sesi resumable Drive v3 ────────────────────────
  function initUpload(ctx, p) {
    requirePerm_(ctx, 'attach.upload');
    rateGuard_(ctx);
    const caseRow = caseFor_(ctx, p.caseNo, true);   // guard DULU, baru buka sesi
    const ev = evidenceOf_(p.evidenceType);
    const fileName = s(p.fileName) || 'lampiran';
    const size = n(p.sizeBytes);
    const maxMb = TC.cfgNum('MAX_RESUMABLE_UPLOAD_MB', 100);
    if (size <= 0 || size > maxMb * 1024 * 1024) {
      throw new AppError(ERROR_CODES.VALIDATION, 'Ukuran file maksimum ' + maxMb + ' MB.',
        { sizeBytes: 'Ukuran tidak valid.' });
    }
    const mime = s(p.mimeType) || 'application/octet-stream';

    // D4: penanda yatim disimpan di appProperties Drive, bukan di sheet.
    const meta = {
      name: fileName, parents: [folderOf_(caseRow)],
      mimeType: mime,
      appProperties: {
        tcasePending: 'TRUE', tcaseCase: caseRow.Case_No,
        tcaseUser: ctx.user.userId, tcaseEvidence: ev
      }
    };
    const res = UrlFetchApp.fetch(DRIVE_UPLOAD + '?uploadType=resumable&supportsAllDrives=true', {
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + tok(),
                 'X-Upload-Content-Type': mime,
                 'X-Upload-Content-Length': String(size) },
      payload: JSON.stringify(meta), muteHttpExceptions: true
    });
    if (res.getResponseCode() >= 300) {
      console.error('initUpload gagal: ' + res.getContentText());
      throw new AppError(ERROR_CODES.UPSTREAM, 'Gagal menyiapkan unggahan ke Drive.');
    }
    const h = res.getHeaders();
    const uploadUrl = h.Location || h.location;
    if (!uploadUrl) throw new AppError(ERROR_CODES.UPSTREAM, 'Drive tidak mengembalikan alamat unggah.');

    // uploadUrl adalah session URI Google (berisi upload_id), BUKAN token akun
    // pemilik script. Aman dikirim ke browser (02-api-contract.md §"Attachment").
    return { uploadUrl: uploadUrl, expiresInSeconds: 604800 };
  }

  // ── 7. attach.completeUpload ──────────────────────────────────────────────
  function completeUpload(ctx, p) {
    requirePerm_(ctx, 'attach.upload');
    const caseRow = caseFor_(ctx, p.caseNo, true);
    const ev = evidenceOf_(p.evidenceType);
    const fid = s(p.driveFileId);
    if (!fid) throw new AppError(ERROR_CODES.VALIDATION, 'driveFileId wajib diisi.', { driveFileId: 'Wajib diisi.' });

    const info = driveGet_(fid, 'id,name,size,mimeType,parents,appProperties,trashed');

    // WAJIB: file harus benar-benar berada di folder case ini. Tanpa cek ini,
    // user bisa mengirim ID file Drive lain dan "menempelkannya" ke case.
    const folderId = folderOf_(caseRow);
    if (info.trashed || !info.parents || info.parents.indexOf(folderId) === -1) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 'File bukan milik case ini.');
    }
    if (TC.find(TC.S.ATTACH, 'Drive_File_ID', fid)) {
      throw new AppError(ERROR_CODES.CONFLICT, 'File ini sudah tercatat sebagai lampiran.');
    }
    const maxMb = TC.cfgNum('MAX_RESUMABLE_UPLOAD_MB', 100);
    if (n(info.size) > maxMb * 1024 * 1024) {
      DriveApp.getFileById(fid).setTrashed(true);
      throw new AppError(ERROR_CODES.VALIDATION, 'File melebihi ' + maxMb + ' MB.');
    }

    drivePatch_(fid, { appProperties: { tcasePending: null } });   // bukan yatim lagi

    return { attachment: writeRow_(ctx, caseRow, {
      threadId: p.threadId, evidenceType: ev,
      fileName: s(p.fileName) || info.name,
      driveFileId: fid, driveUrl: 'https://drive.google.com/file/d/' + fid + '/view',
      mimeType: s(info.mimeType) || s(p.mimeType), sizeBytes: n(info.size),
      method: 'RESUMABLE'
    }) };
  }

  // ── 8. attach.list ────────────────────────────────────────────────────────
  function list(ctx, p) {
    const caseRow = caseFor_(ctx, p.caseNo, false);
    const items = TC.filter(TC.S.ATTACH, function (r) {
      return r.Case_No === caseRow.Case_No && r.Deleted !== 'TRUE';
    }).sort(function (a, b) { return a.Uploaded_At < b.Uploaded_At ? -1 : 1; })
      .map(publicOf_);
    return { items: items };
  }

  // ── 9. attach.download — D1 Opsi A, per-chunk base64 ──────────────────────
  /**
   * GAS tidak bisa mengembalikan biner, jadi file dikirim base64 dan frontend
   * menyusunnya jadi Blob. File besar diambil bertahap pakai header Range
   * supaya tidak menabrak batas memori/6 menit satu eksekusi.
   * Tidak ada requirePerm_ di sini: hak baca sepenuhnya ditentukan
   * assertCanAccessCase_ (IIDI_Area_Mgr/Director boleh lihat, tidak boleh unggah).
   */
  function download(ctx, p) {
    const r = attachRow_(p.attachmentId);
    caseFor_(ctx, r.Case_No, false);

    const size   = n(r.Size_Bytes);
    const total  = Math.max(1, Math.ceil(size / CHUNK_BYTES));
    const idx    = Math.min(Math.max(n(p.chunkIndex), 0), total - 1);
    const from   = idx * CHUNK_BYTES;
    const to     = Math.min(from + CHUNK_BYTES, size) - 1;

    const res = UrlFetchApp.fetch(DRIVE_API + '/' + r.Drive_File_ID + '?alt=media&supportsAllDrives=true', {
      method: 'get',
      headers: { Authorization: 'Bearer ' + tok(), Range: 'bytes=' + from + '-' + to },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() >= 300) {
      console.error('download gagal: ' + res.getContentText());
      throw new AppError(ERROR_CODES.UPSTREAM, 'File tidak dapat diambil dari Drive.');
    }
    return {
      fileName: r.File_Name, mimeType: r.Mime_Type, sizeBytes: size,
      chunkIndex: idx, totalChunks: total, chunkBytes: CHUNK_BYTES,
      dataBase64: Utilities.base64Encode(res.getBlob().getBytes())
    };
  }

  // ── 10. attach.delete — soft delete + trash Drive ─────────────────────────
  function del(ctx, p) {
    requirePerm_(ctx, 'attach.delete');
    const r = attachRow_(p.attachmentId);
    const caseRow = caseFor_(ctx, r.Case_No, true);

    // D6: ikut 03-rbac.md §2 (lebih spesifik dari 02-api-contract.md).
        const role = ctx.user.role;
    const boleh = r.Uploaded_By === ctx.user.userId ||
                  role === 'IIDI_Tech_Mgr' ||
                  (role === 'Dealer_SM' && caseRow.Dealer_ID === ctx.user.dealerId);
    if (!boleh) {
      Audit_.log(ctx, 'ACCESS_DENIED', r.Attachment_ID, 'DENIED', 'hapus lampiran orang lain');
      throw new AppError(ERROR_CODES.FORBIDDEN, 'Anda hanya bisa menghapus lampiran yang Anda unggah.');
    }

    TC.withLock(function () {
      TC.update(TC.S.ATTACH, r._row, { Deleted: 'TRUE' });
      TC.flush();
    });
    try { DriveApp.getFileById(r.Drive_File_ID).setTrashed(true); }
    catch (e) { console.error('Trash Drive gagal ' + r.Drive_File_ID + ': ' + e); }

    Case_.event(ctx, caseRow.Case_No, 'Field_Updated', r.File_Name, '(dihapus)',
                'Lampiran dihapus', { attachmentId: r.Attachment_ID });
    Case_.recalcScore(ctx, caseRow.Case_No);
    return {};
  }

  // ── 11. Drive API helper ──────────────────────────────────────────────────
  function driveGet_(fileId, fields) {
    const res = UrlFetchApp.fetch(DRIVE_API + '/' + fileId + '?supportsAllDrives=true&fields=' +
      encodeURIComponent(fields), {
      method: 'get', headers: { Authorization: 'Bearer ' + tok() }, muteHttpExceptions: true
    });
    if (res.getResponseCode() >= 300) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'File tidak ditemukan di Drive.');
    }
    return JSON.parse(res.getContentText());
  }

  function drivePatch_(fileId, body) {
    UrlFetchApp.fetch(DRIVE_API + '/' + fileId + '?supportsAllDrives=true', {
      method: 'patch', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + tok() },
      payload: JSON.stringify(body), muteHttpExceptions: true
    });
  }

  // ── 12. Housekeeping file yatim (D2 + D4) ─────────────────────────────────
  /**
   * File hasil initUpload yang tidak pernah di-completeUpload masih membawa
   * appProperties.tcasePending = TRUE. Setelah 24 jam, buang ke trash.
   */
  function housekeeping() {
    const cutoff = Utilities.formatDate(
      new Date(Date.now() - ORPHAN_HOURS * 3600000), 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
    const q = "appProperties has { key='tcasePending' and value='TRUE' } and " +
              "trashed = false and modifiedTime < '" + cutoff + "'";
    const url = DRIVE_API + '?pageSize=100&fields=files(id,name)&q=' + encodeURIComponent(q);

    const res = UrlFetchApp.fetch(url, {
      method: 'get', headers: { Authorization: 'Bearer ' + tok() }, muteHttpExceptions: true
    });
    if (res.getResponseCode() >= 300) { console.error('housekeeping: ' + res.getContentText()); return 0; }

    const files = (JSON.parse(res.getContentText()).files || []);
    let killed = 0;
    files.forEach(function (f) {
      if (TC.find(TC.S.ATTACH, 'Drive_File_ID', f.id)) return;
      try { DriveApp.getFileById(f.id).setTrashed(true); killed++; }
      catch (e) { console.error('trash ' + f.id + ': ' + e); }
    });
    console.log('attachHousekeeping_: ' + killed + ' file yatim dibuang.');
    return killed;
  }

  return { upload: upload, initUpload: initUpload, completeUpload: completeUpload,
           list: list, download: download, del: del, housekeeping: housekeeping,
           EVIDENCE_TYPES: EVIDENCE_TYPES };
})();

/** Handler trigger harian (dipasang installTriggers_ di 90_Setup.gs). */
function attachHousekeeping_() { Attach_.housekeeping(); }

/**
 * Migrasi Fase 4 — jalankan SEKALI dari editor GAS.
 * setupAll() tidak boleh dijalankan ulang (pengaman SETUP_FORCE_WIPE), jadi
 * key CONFIG baru ditambahkan lewat sini.
 */
function migrateFase4() {
  const out = [];
  if (!TC.find(TC.S.CONFIG, 'Key', 'ATTACH_COUNTER')) {
    TC.append(TC.S.CONFIG, { Key: 'ATTACH_COUNTER', Value: '0',
      Description: 'Angka terakhir Attachment_ID (AT-000001). Naik terus.',
      Updated_At: TC.nowIso() });
    out.push('ATTACH_COUNTER ditambahkan.');
  } else out.push('ATTACH_COUNTER sudah ada.');

  installTriggers_();
  out.push('Trigger dipasang ulang (5 handler).');

  const head = (typeof SCHEMA !== 'undefined' && SCHEMA[TC.S.ATTACH]) || [];
  out.push(head.indexOf('Upload_Method') === -1
    ? 'PERINGATAN: kolom Upload_Method belum ada di SCHEMA CASE_ATTACHMENTS.'
    : 'Kolom Upload_Method OK.');

  TC.invalidate(TC.S.CONFIG);
  Logger.log(out.join('\n'));
  return out;
}