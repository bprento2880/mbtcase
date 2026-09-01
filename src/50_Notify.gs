/**
 * 50_Notify.gs — FASE 6
 * Queue notifikasi + worker email + digest harian + adapter WA (stub).
 *
 * Acuan: docs/08-notifications.md, docs/01-schema.md §15, §19,
 *        docs/02-api-contract.md §"Notifikasi" (revisi Fase 6).
 *
 * ATURAN:
 * - `var Notify_` WAJIB pakai var: hook() di 20_CaseService.gs, 22_ThreadService.gs,
 *   24_RequestService.gs, dan 31_SlaJob.gs mencarinya lewat globalThis.
 * - enqueue() TIDAK PERNAH melempar error. Notifikasi gagal tidak boleh
 *   menggagalkan aksi user yang memicunya.
 * - enqueue() TIDAK mengirim email. Hanya menulis baris PENDING (§1).
 * - Akses sheet HANYA lewat TC (10_SheetDB.gs).
 * - Stub notifyProcessQueue_() dan dailyDigest_() di 90_Setup.gs WAJIB DIHAPUS.
 *   90_Setup.gs di-load SETELAH file ini, jadi stub kosongnya akan menimpa
 *   fungsi asli di bawah tanpa error apapun.
 */
var Notify_ = (function () {

  // ── Konstanta ─────────────────────────────────────────────────────────────
  var BATCH            = 50;            // maks baris per eksekusi worker
  var RETRY_MINUTES    = [5, 15, 60];   // jeda percobaan ke-2, ke-3, ke-4 (§1)
  var MAX_ATTEMPTS     = 3;
  var THREAD_GROUP_SEC = 1800;          // 30 menit anti-spam balasan thread (§2)
  var JOB_FLAG_TTL     = 300;           // penjaga tumpang-tindih worker (K14)
  var QUOTA_RESERVE    = 5;             // sisakan kuota untuk email darurat
  var MAX_BODY         = 45000;         // batas aman sel Sheets

  var SENDER_NAME = 'MB T-CASE';
  var DEFAULT_BASE_URL = 'https://afs-digitalsolution.web.id/tcase/';

  var DEALER_ROLES = ['CDT', 'Senior_Tech', 'Dealer_SM'];
  var IIDI_TECHS   = ['IIDI_Tech', 'IIDI_Tech_Mgr'];

  /**
   * Event yang tetap dikirim ke user ber-Notif_Level = 'Important_Only'.
   * ACCOUNT_LOCKED sengaja TIDAK ada di sini — dia lolos SEMUA filter,
   * termasuk 'Daily_Digest'. Email keamanan tidak boleh bisa dimatikan user.
   */
  var IMPORTANT = {
    CASE_SUBMITTED_URGENT: 1, DATA_REQUESTED: 1, SLA_OVERDUE: 1,
    MBAG_ANSWERED: 1, ESCALATED: 1, DAILY_DIGEST: 1
  };
  var ALWAYS_SEND = { ACCOUNT_LOCKED: 1 };

  // ── Util kecil ────────────────────────────────────────────────────────────
  function s(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }
  function has(list, v) { return list.indexOf(v) !== -1; }
  function isIidi(role) { return String(role).indexOf('IIDI_') === 0; }
  function esc(v) {
    return s(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function uid() { return 'NT-' + Utilities.getUuid().replace(/-/g, '').slice(0, 10).toUpperCase(); }

  function cfg(key, dflt) {
    try {
      var r = TC.find(TC.S.CONFIG, 'Key', key);
      var v = r ? s(r.Value) : '';
      return v || dflt;
    } catch (e) { return dflt; }
  }

  function baseUrl() {
    var u = cfg('APP_BASE_URL', DEFAULT_BASE_URL);
    return u.charAt(u.length - 1) === '/' ? u : u + '/';
  }
  function caseUrl(caseNo) { return baseUrl() + '#/case/' + encodeURIComponent(caseNo); }
  function tasksUrl() { return baseUrl() + '#/tasks'; }

  /** Tambah N menit kalender (retry pakai jam dinding, bukan jam kerja). */
  function plusMinutes(minutes) {
    return TC.isoOf(new Date(Date.now() + minutes * 60000));
  }

  var HARI  = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  var BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

  /** "Senin, 1 Sep 2026 pukul 14:00 WIB" — §3 melarang "2 hari lagi". */
  function fmtDeadline(iso) {
    var d = TC.parseIso(s(iso));
    if (!d || isNaN(d.getTime())) return '-';
    var parts = Utilities.formatDate(d, 'Asia/Jakarta', 'u|d|M|yyyy|HH:mm').split('|');
    var dow = Number(parts[0]) % 7;   // 'u': 1=Senin .. 7=Minggu
    return HARI[dow] + ', ' + Number(parts[1]) + ' ' + BULAN[Number(parts[2]) - 1] + ' ' +
           parts[3] + ' pukul ' + parts[4] + ' WIB';
  }

  // ── Memo per-eksekusi (satu request bisa memicu beberapa enqueue) ─────────
  var _users = null, _byId = null;
  function users() {
    if (_users) return _users;
    _users = TC.readAll(TC.S.USERS) || [];
    _byId = {};
    _users.forEach(function (u) { _byId[u.User_ID] = u; });
    return _users;
  }
  function userOf(userId) {
    if (!s(userId)) return null;
    users();
    return _byId[userId] || null;
  }
  function nameOf(userId) {
    var u = userOf(userId);
    return u ? (u.Full_Name || u.User_ID) : (s(userId) || 'Sistem');
  }
  function byRole(roles) {
    return users().filter(function (u) {
      return has(roles, u.Role) && u.Status === 'ACTIVE' && s(u.Email);
    });
  }

  function dealerOf(dealerId) { return TC.find(TC.S.DEALERS, 'Dealer_ID', dealerId); }
  function caseRow(caseNo) { return s(caseNo) ? TC.find(TC.S.CASES, 'Case_No', caseNo) : null; }

  // ── Resolusi penerima ─────────────────────────────────────────────────────
  /** Sisi dealer: pembuat case + semua Dealer_SM dealer itu. */
  function dealerSide(c) {
    var out = [];
    var creator = userOf(c.Created_By_User_ID);
    if (creator) out.push(creator);
    users().forEach(function (u) {
      if (u.Role === 'Dealer_SM' && u.Dealer_ID === c.Dealer_ID) out.push(u);
    });
    return out;
  }

  /** Sisi IIDI: pemilik case kalau sudah ada, kalau belum seluruh pool teknisi. */
  function iidiSide(c) {
    var owner = userOf(c.Current_Owner_User_ID);
    if (owner && isIidi(owner.Role)) return [owner];
    return byRole(IIDI_TECHS);
  }

  function ownerOf(c) {
    var u = userOf(c.Current_Owner_User_ID);
    return u ? [u] : [];
  }

  /**
   * Atasan pemilik case (K8, dipakai SLA_OVERDUE).
   * Role dealer → semua Dealer_SM dealer itu. IIDI_Tech → IIDI_Tech_Mgr.
   * IIDI_Tech_Mgr → IIDI_Director.
   */
  function supervisorOf(u, c) {
    if (!u) return [];
    if (u.Role === 'IIDI_Tech') return byRole(['IIDI_Tech_Mgr']);
    if (u.Role === 'IIDI_Tech_Mgr') return byRole(['IIDI_Director']);
    if (has(DEALER_ROLES, u.Role)) {
      return users().filter(function (x) {
        return x.Role === 'Dealer_SM' && x.Dealer_ID === (c ? c.Dealer_ID : u.Dealer_ID) &&
               x.User_ID !== u.User_ID;
      });
    }
    return [];
  }

  /**
   * Area manager dealer pemilik case. Diturunkan dari DEALERS.Area_Manager_User_ID
   * (pola yang sama dengan Guard_.areasOf di 13_Guard.gs). Kolom itu masih kosong
   * untuk seluruh dealer hasil seed Fase 0 — kalau kosong, penerima ini DILEWATI
   * diam-diam (K9). Satu area manager yang belum terdaftar tidak boleh
   * menggagalkan notifikasi ke penerima lain.
   */
  function areaMgrOf(c) {
    var d = dealerOf(c.Dealer_ID);
    if (!d || !s(d.Area_Manager_User_ID)) {
      console.log('Notify_: Area_Manager_User_ID kosong untuk ' + c.Dealer_ID + ', penerima dilewati.');
      return [];
    }
    var u = userOf(d.Area_Manager_User_ID);
    return (u && u.Status === 'ACTIVE') ? [u] : [];
  }

  /** "Semua yang terlibat" (case ditutup): dealer + IIDI + penulis thread. */
  function participants(c) {
    var out = dealerSide(c).concat(iidiSide(c));
    try {
      var seen = {};
      TC.filter(TC.S.THREAD, function (t) { return t.Case_No === c.Case_No; })
        .forEach(function (t) {
          var id = s(t.Author_User_ID);
          if (!id || id === 'SYSTEM' || seen[id]) return;
          seen[id] = true;
          var u = userOf(id);
          if (u) out.push(u);
        });
    } catch (e) { console.error('Notify_.participants: ' + e); }
    return out;
  }

  // ── Normalisasi argumen (K1) ──────────────────────────────────────────────
  /**
   * Argumen ke-3 enqueue() selalu objek. Bentuk string masih diterima dan
   * diperlakukan sebagai { to: <string> } — pola lama yang masih tercetak di
   * docs/04-state-machine.md §4. Jaring pengaman, bukan jalur utama.
   */
  function normalizeDetail(detail) {
    if (detail === null || detail === undefined) return {};
    if (typeof detail === 'string') return { to: detail };
    return detail;
  }

  // ── Perencanaan: event mentah → event spesifik + daftar penerima ──────────
  /**
   * STATUS_CHANGED dipecah di sini, BUKAN dengan menambah call site baru di
   * 20_CaseService.gs (K3). Semua pemicu di 08-notifications.md §2 yang berupa
   * perpindahan status diturunkan dari pasangan from/to.
   */
  function plan(eventType, c, d) {
    var to = s(d.to), from = s(d.from);

    if (eventType === 'STATUS_CHANGED') {
      if (to === 'Open') {
        var urgent = (c.Priority === 'Urgent' || c.Priority === 'Critical');
        var rcpt = byRole(IIDI_TECHS);
        if (urgent) rcpt = rcpt.concat(areaMgrOf(c));
        return { event: urgent ? 'CASE_SUBMITTED_URGENT' : 'CASE_SUBMITTED', recipients: rcpt };
      }
      if (to === 'In Progress') {
        if (from === 'Escalated to MBAG') {
          // K2: MBAG tidak pernah login. Jawaban MBAG masuk lewat teknisi IIDI
          // yang mengembalikan status. Yang menunggu kabar itu dealer, jadi
          // penerimanya sisi dealer + manajer teknik, bukan "pemilik IIDI"
          // (= pelaku aksi, yang justru disaring keluar).
          return { event: 'MBAG_ANSWERED', recipients: dealerSide(c).concat(byRole(['IIDI_Tech_Mgr'])) };
        }
        if (from === 'Open')    return { event: 'CASE_CLAIMED',   recipients: [userOf(c.Created_By_User_ID)] };
        if (from === 'Closed')  return { event: 'CASE_REOPENED',  recipients: dealerSide(c).concat(iidiSide(c)) };
        if (from === 'Request Closure') return { event: 'CLOSURE_REJECTED', recipients: iidiSide(c) };
        return { event: 'STATUS_CHANGED', recipients: dealerSide(c).concat(iidiSide(c)) };
      }
      if (to === 'Waiting Dealer Reply') {
        // request.create memanggil transitionInternal DULU, baru enqueue
        // DATA_REQUESTED yang isinya jauh lebih berguna. Tanpa penyaringan ini
        // dealer menerima dua email untuk satu aksi. Aman karena transition()
        // publik memblokir status ini (20_CaseService.gs baris 498).
        if (s(d.waitingReason) === 'Additional_Data') return null;
        return { event: 'STATUS_CHANGED', recipients: dealerSide(c) };
      }
      if (to === 'Waiting IIDI') {
        // Sama: kalau masih ada DATA_REQUESTS OPEN, artinya ini bagian dari
        // request.fulfill dan DATA_FULFILLED menyusul. Kalau tidak ada, dealer
        // memindahkan status manual — email generik ini satu-satunya kabar.
        if (openRequests(c.Case_No).length) return null;
        return { event: 'STATUS_CHANGED', recipients: iidiSide(c) };
      }
      if (to === 'Escalated to MBAG') {
        return { event: 'ESCALATED',
                 recipients: dealerSide(c).concat(areaMgrOf(c)) };
      }
      if (to === 'Request Closure') {
        return { event: 'CLOSURE_REQUESTED', recipients: dealerSide(c) };
      }
      if (to === 'Closed') {
        return { event: 'CASE_CLOSED', recipients: participants(c) };
      }
      return { event: 'STATUS_CHANGED', recipients: dealerSide(c).concat(iidiSide(c)) };
    }

    if (eventType === 'THREAD_REPLY') {
      if (s(d.visibility) === 'IIDI_Only') {
        return { event: 'THREAD_REPLY', recipients: iidiSide(c).concat(byRole(['IIDI_Tech_Mgr'])) };
      }
      // "Pihak lawan" (§2): penulis IIDI → dealer, penulis dealer → IIDI.
      return { event: 'THREAD_REPLY',
               recipients: isIidi(d.authorRole) ? dealerSide(c) : iidiSide(c) };
    }

    if (eventType === 'DATA_REQUESTED') return { event: 'DATA_REQUESTED', recipients: dealerSide(c) };
    if (eventType === 'DATA_FULFILLED') return { event: 'DATA_FULFILLED', recipients: iidiSide(c) };

    if (eventType === 'SLA_NEAR_DUE') return { event: 'SLA_NEAR_DUE', recipients: ownerOf(c) };
    if (eventType === 'SLA_OVERDUE') {
      var owner = userOf(c.Current_Owner_User_ID);
      return { event: 'SLA_OVERDUE', recipients: ownerOf(c).concat(supervisorOf(owner, c)) };
    }

    console.log('Notify_: event tidak dikenal, dilewati: ' + eventType);
    return null;
  }

  function openRequests(caseNo) {
    try {
      return TC.filter(TC.S.REQUESTS, function (r) {
        return r.Case_No === caseNo && r.Status === 'OPEN';
      });
    } catch (e) { return []; }
  }

  // ── Penyaringan penerima ──────────────────────────────────────────────────
  function eligible(list, event, actorUserId) {
    var seen = {}, out = [];
    (list || []).forEach(function (u) {
      if (!u || !s(u.Email) || u.Status !== 'ACTIVE') return;
      if (seen[u.User_ID]) return;                       // dedup
      if (u.User_ID === s(actorUserId)) return;          // §2: jangan kirim ke pelakunya
      if (!ALWAYS_SEND[event]) {
        var lvl = s(u.Notif_Level) || 'All';
        if (lvl === 'Daily_Digest' && event !== 'DAILY_DIGEST') return;
        if (lvl === 'Important_Only' && !IMPORTANT[event]) return;
      }
      seen[u.User_ID] = true;
      out.push(u);
    });
    return out;
  }

  /**
   * Anti-spam balasan thread: maks satu email per case per user per 30 menit (§2).
   * Penanda di CacheService, bukan di sheet — pola yang sama dipakai slaJob untuk
   * NEAR_DUE (31_SlaJob.gs). Yang tersaring tetap ditulis sebagai baris SKIPPED
   * supaya keluhan "kok emailnya nggak masuk" bisa ditelusuri.
   */
  function grouped(event, caseNo, userId) {
    if (event !== 'THREAD_REPLY') return false;
    var cache = CacheService.getScriptCache();
    var key = 'ntgrp_' + caseNo + '_' + userId;
    if (cache.get(key)) return true;
    cache.put(key, '1', THREAD_GROUP_SEC);
    return false;
  }

  // ── Penyusunan email ──────────────────────────────────────────────────────
  function line(label, value) {
    return '  ' + (label + '                ').slice(0, 14) + ': ' + esc(value);
  }

  function shell(greeting, intro, blockLines, extra, caseNo) {
    var html = 'Halo ' + esc(greeting) + ',<br><br>' + esc(intro) + '<br><br>' +
               '<pre style="font:13px/1.5 monospace;margin:0">' + blockLines.join('\n') + '</pre>';
    if (extra) html += '<br>' + extra;
    html += '<br><br>&nbsp;&nbsp;Buka case: <a href="' + caseUrl(caseNo) + '">' + esc(caseNo) + '</a>';
    html += '<br><br>--<br>MB T-CASE · Technical Case Escalation &amp; Management System<br>' +
            '<span style="color:#666;font-size:12px">Anda menerima email ini karena terlibat dalam case ' +
            esc(caseNo) + '. Preferensi notifikasi diatur oleh administrator sistem.</span>';
    return html.length > MAX_BODY ? html.slice(0, MAX_BODY) : html;
  }

  function vehicle(c) {
    return s(c.Model) + (s(c.Prod_Year) ? ' (' + s(c.Prod_Year) + ')' : '');
  }
  function shortComplaint(c) {
    var t = s(c.Complaint_Desc);
    return t.length > 120 ? t.slice(0, 117) + '...' : t;
  }

  /** @return {{subject:string, body:string}} */
  function render(event, c, d, u) {
    var caseNo = c.Case_No;
    var base = [
      line('Case', caseNo),
      line('Kendaraan', vehicle(c)),
      line('Dealer', s(c.Dealer_ID)),
      line('Keluhan', shortComplaint(c))
    ];
    var tag, intro, extra = '';

    switch (event) {
      case 'CASE_SUBMITTED':
      case 'CASE_SUBMITTED_URGENT':
        tag = (event === 'CASE_SUBMITTED_URGENT' ? '[' + s(c.Priority).toUpperCase() + '] ' : '') +
              'Case baru masuk';
        intro = 'Ada case baru dari dealer yang menunggu penanganan tim technical IIDI.';
        base.push(line('Priority', c.Priority));
        base.push(line('Dikirim oleh', nameOf(c.Created_By_User_ID)));
        base.push(line('Batas respons', fmtDeadline(c.IIDI_Response_Deadline)));
        break;

      case 'CASE_CLAIMED':
        tag = 'Case sudah diambil IIDI';
        intro = 'Case Anda sudah diambil oleh tim technical IIDI.';
        base.push(line('Ditangani oleh', nameOf(d.actorUserId)));
        break;

      case 'DATA_REQUESTED':
        tag = 'Data tambahan diminta';
        intro = 'Tim technical IIDI meminta data tambahan untuk case berikut.';
        base.push(line('Diminta oleh', nameOf(d.requestedBy || d.actorUserId)));
        base.push(line('Batas waktu', fmtDeadline(d.dueAt || c.Dealer_Response_Deadline)));
        extra = itemsHtml(d.items, 'Yang diminta:');
        break;

      case 'DATA_FULFILLED':
        tag = 'Data tambahan sudah dikirim dealer';
        intro = 'Dealer sudah melengkapi data yang diminta. Bola kembali di tim IIDI.';
        base.push(line('Dikirim oleh', nameOf(d.fulfilledBy || d.actorUserId)));
        base.push(line('Lampiran', (d.attachmentCount || 0) + ' berkas'));
        break;

      case 'THREAD_REPLY':
        tag = 'Balasan diskusi baru';
        intro = 'Ada balasan baru pada diskusi case ini.';
        base.push(line('Dari', nameOf(d.authorUserId)));
        base.push(line('Jenis', d.messageType || 'Comment'));
        break;

      case 'ESCALATED':
        tag = 'Dieskalasi ke MBAG';
        intro = 'Case ini sudah dinaikkan ke MBAG untuk penanganan lanjutan.';
        base.push(line('Dieskalasi oleh', nameOf(d.actorUserId)));
        if (s(d.note)) base.push(line('Alasan', d.note));
        break;

      case 'MBAG_ANSWERED':
        tag = 'MBAG sudah menjawab';
        intro = 'Jawaban dari MBAG sudah diterima dan case dilanjutkan oleh tim technical IIDI.';
        base.push(line('Diperbarui oleh', nameOf(d.actorUserId)));
        if (s(c.MBAG_Ref_No)) base.push(line('Ref MBAG', c.MBAG_Ref_No));
        break;

      case 'CLOSURE_REQUESTED':
        tag = 'Konfirmasi penutupan diminta';
        intro = 'Tim IIDI mengusulkan case ini ditutup. Mohon konfirmasi atau tolak bila masalah belum selesai.';
        base.push(line('Batas konfirm', fmtDeadline(c.Closure_Deadline)));
        break;

      case 'CLOSURE_REJECTED':
        tag = 'Dealer menolak penutupan';
        intro = 'Dealer menyatakan masalah belum selesai. Case kembali berjalan.';
        if (s(d.note)) base.push(line('Catatan', d.note));
        break;

      case 'CASE_CLOSED':
        tag = 'Case ditutup';
        intro = 'Case ini sudah ditutup.';
        base.push(line('Hasil', c.Closure_Type));
        base.push(line('Ditutup oleh', nameOf(d.actorUserId || c.Closed_By)));
        break;

      case 'CASE_REOPENED':
        tag = 'Case dibuka kembali';
        intro = 'Case yang sudah ditutup dibuka kembali.';
        base.push(line('Dibuka oleh', nameOf(d.actorUserId)));
        break;

      case 'SLA_NEAR_DUE':
        tag = 'Mendekati batas waktu';
        intro = 'Case ini mendekati batas waktu penanganan Anda.';
        base.push(line('Batas waktu', fmtDeadline(d.deadline)));
        base.push(line('Sisa', s(d.label)));
        break;

      case 'SLA_OVERDUE':
        tag = 'TERLAMBAT';
        intro = 'Case ini sudah melewati batas waktu penanganan.';
        base.push(line('Batas waktu', fmtDeadline(d.deadline)));
        base.push(line('Keterangan', s(d.label)));
        break;

      default:
        tag = 'Status berubah';
        intro = 'Status case berubah dari "' + s(d.from) + '" menjadi "' + s(d.to) + '".';
        base.push(line('Oleh', nameOf(d.actorUserId)));
        if (s(d.note)) base.push(line('Catatan', d.note));
    }

    return {
      subject: '[' + SENDER_NAME + '] ' + caseNo + ' · ' + tag + ' · ' + vehicle(c),
      body: shell(nameOf(u.User_ID), intro, base, extra, caseNo)
    };
  }

  function itemsHtml(items, title) {
    if (!items || !items.length) return '';
    var li = items.map(function (it, i) {
      var label = (typeof it === 'string') ? it : s(it.label);
      var et = (typeof it === 'string') ? '' : s(it.evidenceType);
      return '  ' + (i + 1) + '. ' + esc(label) + (et ? ' [' + esc(et) + ']' : '');
    }).join('\n');
    return esc(title) + '<br><pre style="font:13px/1.5 monospace;margin:0">' + li + '</pre>';
  }

  // ── Penulis baris queue ───────────────────────────────────────────────────
  function queueRow(caseNo, event, u, subject, body, status, err) {
    return {
      Notif_ID: uid(),
      Case_No: s(caseNo),
      Event_Type: event,
      Recipient_User_ID: u.User_ID,
      Channel: 'EMAIL',
      To_Address: s(u.Email),
      Subject: subject,
      Body: body,
      Status: status || 'PENDING',
      Attempts: 0,
      Created_At: TC.nowIso(),
      Sent_At: '',
      Next_Attempt_At: '',
      Error: err || ''
    };
  }

  // ── API 1: enqueue ────────────────────────────────────────────────────────
  /**
   * Dipanggil dari Case_.transition, Thread_.post, Request_.create/fulfill,
   * dan slaNotify_. TIDAK PERNAH melempar — kegagalan notifikasi tidak boleh
   * menggagalkan aksi user.
   * @return {number} jumlah baris PENDING yang ditulis
   */
  function enqueue(eventType, caseNo, detail) {
    try {
      var d = normalizeDetail(detail);
      var c = caseRow(caseNo);
      if (!c) { console.log('Notify_: case tidak ditemukan, dilewati: ' + caseNo); return 0; }

      var p = plan(s(eventType), c, d);
      if (!p) return 0;

      var rcpt = eligible(p.recipients, p.event, d.actorUserId);
      if (!rcpt.length) return 0;

      var rows = [], pending = 0;
      rcpt.forEach(function (u) {
        var m = render(p.event, c, d, u);
        if (grouped(p.event, c.Case_No, u.User_ID)) {
          rows.push(queueRow(c.Case_No, p.event, u, m.subject, m.body, 'SKIPPED',
                             'Digabung: sudah ada email case ini < 30 menit lalu.'));
        } else {
          rows.push(queueRow(c.Case_No, p.event, u, m.subject, m.body, 'PENDING'));
          pending++;
        }
      });

      TC.appendMany(TC.S.NOTIF, rows);
      return pending;
    } catch (e) {
      console.error('Notify_.enqueue(' + eventType + ', ' + caseNo + '): ' + (e.stack || e));
      return 0;
    }
  }

  // ── Kuota ─────────────────────────────────────────────────────────────────
  /**
   * Sumber kebenaran kuota adalah MailApp.getRemainingDailyQuota(), BUKAN
   * counter di CONFIG. Counter bisa meleset (reset gagal, eksekusi mati di
   * tengah); angka dari Google tidak. CONFIG.EMAIL_DAILY_QUOTA tetap dipakai
   * sebagai batas lunak yang bisa diturunkan operator tanpa deploy.
   */
  function quotaLeft() {
    try { return MailApp.getRemainingDailyQuota(); } catch (e) { return 0; }
  }

  /** Counter harian dengan reset malas — tidak butuh trigger tengah malam (K6). */
  function bumpSent(n) {
    if (!n) return;
    try {
      var today = TC.nowIso().slice(0, 10);
      var dRow = TC.find(TC.S.CONFIG, 'Key', 'EMAIL_SENT_DATE');
      var cRow = TC.find(TC.S.CONFIG, 'Key', 'EMAIL_SENT_TODAY');
      if (!cRow) return;
      var sameDay = dRow && s(dRow.Value) === today;
      var total = (sameDay ? (Number(cRow.Value) || 0) : 0) + n;
      TC.update(TC.S.CONFIG, cRow._row, { Value: String(total), Updated_At: TC.nowIso() });
      if (dRow && !sameDay) TC.update(TC.S.CONFIG, dRow._row, { Value: today, Updated_At: TC.nowIso() });
      TC.invalidate(TC.S.CONFIG);
    } catch (e) { console.error('Notify_.bumpSent: ' + e); }
  }

  // ── Adapter kanal (§4) ────────────────────────────────────────────────────
  function sendEmail(rec) {
    MailApp.sendEmail({
      to: rec.To_Address,
      subject: rec.Subject,
      htmlBody: rec.Body,
      name: SENDER_NAME
    });
    return { status: 'SENT', error: '' };
  }

  /** Stub sampai provider WA siap. Kontrak: { status, providerId, error }. */
  function sendWhatsapp(rec) {
    if (cfg('FEATURE_WA', 'FALSE') !== 'TRUE') {
      return { status: 'SKIPPED', providerId: '', error: 'Kanal WA belum aktif.' };
    }
    var provider = cfg('WA_PROVIDER', '');
    var fn = WA_PROVIDERS[provider];
    if (!fn) return { status: 'FAILED', providerId: '', error: 'WA_PROVIDER tidak dikenal: ' + provider };
    return fn(rec);
  }

  // Isi fungsi adapter di sini saat provider sudah ada. Tidak ada logika bisnis
  // manapun yang perlu berubah — cukup satu fungsi + 3 baris di CONFIG (§4).
  var WA_PROVIDERS = {
    FONNTE: null, WABLAS: null, META: null, CUSTOM: null
  };

  var CHANNELS = { EMAIL: sendEmail, WA: sendWhatsapp };

  // ── API 2: worker antrean ─────────────────────────────────────────────────
  /**
   * Trigger tiap 5 menit. TIDAK memegang script lock selama batch — 50 email
   * bisa memakan ~60 detik dan itu akan membuat setiap aksi user kena BUSY
   * (TC.withLock hanya menunggu 20 detik). Penjaga tumpang-tindih memakai
   * penanda cache; append baris baru dari request user tidak menggeser nomor
   * baris yang sedang di-update di sini, jadi aman tanpa lock.
   */
  function processQueue() {
    var cache = CacheService.getScriptCache();
    if (cache.get('notif_job')) {
      console.log('Notify_.processQueue: eksekusi lain masih jalan, dilewati.');
      return { skipped: true };
    }
    cache.put('notif_job', '1', JOB_FLAG_TTL);

    try {
      var now = TC.nowIso();
      var all = TC.readAll(TC.S.NOTIF) || [];
      var due = all.filter(function (r) {
        if (r.Status !== 'PENDING') return false;
        var next = s(r.Next_Attempt_At);
        return !next || next <= now;
      }).slice(0, BATCH);

      if (!due.length) return { sent: 0, failed: 0, pending: 0 };

      var left = quotaLeft();
      var softCap = Number(cfg('EMAIL_DAILY_QUOTA', '1500')) || 1500;
      var sent = 0, failed = 0, held = 0;

      for (var i = 0; i < due.length; i++) {
        var rec = due[i];

        if (left - QUOTA_RESERVE <= 0) { held = due.length - i; break; }

        var channel = CHANNELS[rec.Channel] || sendEmail;
        var res;
        try {
          res = channel(rec);
        } catch (err) {
          res = { status: 'FAILED', error: String(err).slice(0, 400) };
        }

        if (res.status === 'SENT') {
          TC.update(TC.S.NOTIF, rec._row, { Status: 'SENT', Sent_At: TC.nowIso(), Error: '' });
          sent++; left--;
        } else if (res.status === 'SKIPPED') {
          TC.update(TC.S.NOTIF, rec._row, { Status: 'SKIPPED', Error: s(res.error) });
        } else {
          var attempts = (Number(rec.Attempts) || 0) + 1;
          var patch = { Attempts: String(attempts), Error: s(res.error) };
          if (attempts >= MAX_ATTEMPTS) {
            patch.Status = 'FAILED';
          } else {
            patch.Status = 'PENDING';
            patch.Next_Attempt_At = plusMinutes(RETRY_MINUTES[attempts - 1] || 60);
          }
          TC.update(TC.S.NOTIF, rec._row, patch);
          failed++;
        }
      }

      bumpSent(sent);
      var out = { sent: sent, failed: failed, held: held, quotaLeft: left, softCap: softCap };
      console.log('Notify_.processQueue ' + JSON.stringify(out));
      return out;

    } finally {
      cache.remove('notif_job');
    }
  }

  // ── API 3: ringkasan harian (§6) ──────────────────────────────────────────
  /**
   * Trigger 08:15 WIB, hari kerja saja. Satu email per user yang punya case
   * butuh aksi. Ditulis sebagai baris queue biasa, bukan dikirim langsung —
   * supaya ikut hitungan kuota dan punya retry yang sama.
   */
  function dailyDigest() {
    try {
      if (typeof Sla_ !== 'undefined' && typeof Sla_.isWorkingDay === 'function') {
        if (!Sla_.isWorkingDay(new Date())) {
          console.log('dailyDigest: bukan hari kerja, dilewati.');
          return { skipped: 'holiday' };
        }
      }

      var now = TC.nowIso();
      var cases = (TC.readAll(TC.S.CASES) || []).filter(function (c) {
        return c.Status !== 'Closed' && c.Status !== 'Created';
      });

      var buckets = {};   // userId -> [{ caseNo, what, sla }]
      function push(userId, item) {
        if (!s(userId)) return;
        (buckets[userId] = buckets[userId] || []).push(item);
      }

      cases.forEach(function (c) {
        var sla = { status: 'NONE', label: '' };
        try {
          if (typeof Sla_ !== 'undefined') sla = Sla_.statusOf(c, now);
        } catch (e) { /* SLA tidak tersedia: item tetap dimunculkan tanpa badge */ }

        var what = digestLabel(c.Status);

        if (s(c.Current_Owner_User_ID)) {
          push(c.Current_Owner_User_ID, { c: c, what: what, sla: sla });
          return;
        }
        if (c.Status === 'Open') {
          byRole(IIDI_TECHS).forEach(function (u) {
            push(u.User_ID, { c: c, what: 'Belum diambil', sla: sla });
          });
          return;
        }
        // K11: pemilik kosong di sisi dealer -> pembuat case + Dealer_SM.
        if (c.Status === 'Waiting Dealer Reply' || c.Status === 'Request Closure') {
          dealerSide(c).forEach(function (u) { push(u.User_ID, { c: c, what: what, sla: sla }); });
        }
      });

      var rows = [], made = 0;
      Object.keys(buckets).forEach(function (userId) {
        var u = userOf(userId);
        if (!u || u.Status !== 'ACTIVE' || !s(u.Email)) return;

        var items = buckets[userId].sort(function (a, b) {
          return rank(a.sla) - rank(b.sla);
        });
        var m = renderDigest(u, items);
        rows.push({
          Notif_ID: uid(), Case_No: '', Event_Type: 'DAILY_DIGEST',
          Recipient_User_ID: userId, Channel: 'EMAIL', To_Address: s(u.Email),
          Subject: m.subject, Body: m.body, Status: 'PENDING', Attempts: 0,
          Created_At: TC.nowIso(), Sent_At: '', Next_Attempt_At: '', Error: ''
        });
        made++;
      });

      if (rows.length) TC.appendMany(TC.S.NOTIF, rows);
      console.log('dailyDigest: ' + made + ' ringkasan diantrekan.');
      return { queued: made };

    } catch (e) {
      console.error('dailyDigest: ' + (e.stack || e));
      return { error: String(e) };
    }
  }

  function digestLabel(status) {
    if (status === 'Waiting Dealer Reply') return 'Data tambahan';
    if (status === 'Request Closure')      return 'Konfirmasi closure';
    if (status === 'Waiting IIDI')         return 'Menunggu keputusan IIDI';
    if (status === 'In Progress')          return 'Sedang ditangani';
    if (status === 'Escalated to MBAG')    return 'Menunggu MBAG';
    if (status === 'Open')                 return 'Belum diambil';
    return status;
  }
  function rank(sla) {
    return sla.status === 'OVERDUE' ? 0 : sla.status === 'NEAR_DUE' ? 1 : 2;
  }
  function dot(sla) {
    return sla.status === 'OVERDUE' ? '🔴' : sla.status === 'NEAR_DUE' ? '🟡' : '🟢';
  }

  function renderDigest(u, items) {
    var lines = items.map(function (it) {
      return '  ' + dot(it.sla) + ' ' + esc(it.c.Case_No) + '  ' +
             esc((it.what + '                      ').slice(0, 22)) + '  ' +
             esc(it.sla.label || '');
    }).join('\n');

    var body = 'Selamat pagi ' + esc(u.Full_Name || u.User_ID) + ',<br><br>' +
      'Menunggu tindakan Anda hari ini:<br><br>' +
      '<pre style="font:13px/1.5 monospace;margin:0">' + lines + '</pre>' +
      '<br>&nbsp;&nbsp;Buka daftar: <a href="' + tasksUrl() + '">' + esc(tasksUrl()) + '</a>' +
      '<br><br>--<br>MB T-CASE · Technical Case Escalation &amp; Management System';

    return {
      subject: '[' + SENDER_NAME + '] ' + items.length + ' case menunggu tindakan Anda',
      body: body.length > MAX_BODY ? body.slice(0, MAX_BODY) : body
    };
  }

  // ── API 4: panel admin (§5) ───────────────────────────────────────────────
  function adminQueue(ctx, p) {
    requirePerm_(ctx, 'notif.admin');
    var limit = Math.min(Number(p.limit) || 50, 200);
    var all = TC.readAll(TC.S.NOTIF) || [];
    var counts = { PENDING: 0, SENT: 0, FAILED: 0, SKIPPED: 0 };

    all.forEach(function (r) {
      if (counts[r.Status] !== undefined) counts[r.Status]++;
    });

    function slim(r) {
      return {
        notifId: r.Notif_ID, caseNo: r.Case_No, eventType: r.Event_Type,
        recipient: nameOf(r.Recipient_User_ID), to: r.To_Address,
        subject: r.Subject, status: r.Status, attempts: Number(r.Attempts) || 0,
        createdAt: r.Created_At, sentAt: r.Sent_At,
        nextAttemptAt: r.Next_Attempt_At, error: r.Error
      };
    }
    function pick(status) {
      return all.filter(function (r) { return r.Status === status; })
                .sort(function (a, b) { return a.Created_At < b.Created_At ? 1 : -1; })
                .slice(0, limit).map(slim);
    }

    var today = TC.nowIso().slice(0, 10);
    var dRow = TC.find(TC.S.CONFIG, 'Key', 'EMAIL_SENT_DATE');
    var cRow = TC.find(TC.S.CONFIG, 'Key', 'EMAIL_SENT_TODAY');

    return {
      counts: counts,
      pending: pick('PENDING'),
      failed: pick('FAILED'),
      quota: {
        remainingToday: quotaLeft(),
        softCap: Number(cfg('EMAIL_DAILY_QUOTA', '1500')) || 1500,
        sentToday: (dRow && s(dRow.Value) === today && cRow) ? (Number(cRow.Value) || 0) : 0
      }
    };
  }

  function adminRetry(ctx, p) {
    requirePerm_(ctx, 'notif.admin');
    var ids = Array.isArray(p.notifIds) ? p.notifIds.map(s).filter(String) : [];
    var allFailed = p.allFailed === true;
    if (!ids.length && !allFailed) {
      throw new AppError(ERROR_CODES.VALIDATION, 'Pilih minimal satu notifikasi.',
        { notifIds: 'Wajib diisi.' });
    }
    var target = TC.filter(TC.S.NOTIF, function (r) {
      if (r.Status !== 'FAILED') return false;
      return allFailed || ids.indexOf(r.Notif_ID) !== -1;
    });
    target.forEach(function (r) {
      TC.update(TC.S.NOTIF, r._row, {
        Status: 'PENDING', Attempts: '0', Next_Attempt_At: '', Error: ''
      });
    });
    Audit_.log(ctx, 'NOTIF_RETRY', String(target.length), 'OK');
    return { requeued: target.length };
  }

  function adminTest(ctx, p) {
    requirePerm_(ctx, 'notif.admin');
    var to = s(p.to) || s(ctx.user.email);
    if (!to) throw new AppError(ERROR_CODES.VALIDATION, 'Alamat email tujuan wajib diisi.',
      { to: 'Wajib diisi.' });

    var subject = '[' + SENDER_NAME + '] Email uji';
    var body = 'Ini email uji dari MB T-CASE.<br><br>' +
      'Dikirim oleh: ' + esc(ctx.user.fullName || ctx.user.userId) + '<br>' +
      'Waktu server: ' + esc(TC.nowIso()) + '<br>' +
      'Sisa kuota hari ini: ' + quotaLeft() + '<br><br>--<br>MB T-CASE';

    var status = 'SENT', error = '';
    try {
      MailApp.sendEmail({ to: to, subject: subject, htmlBody: body, name: SENDER_NAME });
      bumpSent(1);
    } catch (e) {
      status = 'FAILED'; error = String(e).slice(0, 400);
    }

    TC.append(TC.S.NOTIF, {
      Notif_ID: uid(), Case_No: '', Event_Type: 'TEST', Recipient_User_ID: ctx.user.userId,
      Channel: 'EMAIL', To_Address: to, Subject: subject, Body: body, Status: status,
      Attempts: 1, Created_At: TC.nowIso(),
      Sent_At: status === 'SENT' ? TC.nowIso() : '', Next_Attempt_At: '', Error: error
    });

    if (status === 'FAILED') throw new AppError(ERROR_CODES.UPSTREAM, 'Email uji gagal terkirim: ' + error);
    return { sent: true, to: to, quotaLeft: quotaLeft() };
  }

  // ── Tautan wa.me (§4) — dipakai UI di sesi berikutnya ─────────────────────
  function waLink(caseNo, phone) {
    var c = caseRow(caseNo);
    if (!c) return '';
    var text = '[' + SENDER_NAME + '] ' + c.Case_No + '\n' + vehicle(c) + '\n' +
               shortComplaint(c) + '\n\nBuka: ' + caseUrl(c.Case_No);
    return 'https://wa.me/' + s(phone).replace(/[^0-9]/g, '') + '?text=' + encodeURIComponent(text);
  }

  return {
    enqueue: enqueue,
    processQueue: processQueue,
    dailyDigest: dailyDigest,
    waLink: waLink,
    // route handler
    adminQueue: adminQueue,
    adminRetry: adminRetry,
    adminTest: adminTest,
    // dibuka untuk 99_Tests.gs
    _render: render,
    _plan: plan
  };
})();

/* ═══════════════ Handler trigger — dipasang oleh 90_Setup.gs ═══════════════ */
/**
 * Nama fungsi ini WAJIB sama dengan TRIGGER_HANDLERS di 90_Setup.gs baris 332.
 * Stub kosong dengan nama yang sama di 90_Setup.gs baris 360-369 HARUS dihapus:
 * file 90 di-load setelah file 50, jadi stub itu menimpa fungsi ini diam-diam.
 */
function notifyProcessQueue_() { return Notify_.processQueue(); }
function dailyDigest_() { return Notify_.dailyDigest(); }