/**
 * 99_Tests_Fase5.gs — checklist penerimaan Fase 5 (otomatis).
 *
 * CARA PAKAI: buka editor GAS → pilih fungsi `runFase5Tests` → Run →
 * lihat hasilnya di panel Execution log.
 *
 * Tes ini MENULIS ke spreadsheet sungguhan: satu case baru (CN-xxxx) dan
 * beberapa user bertanda "ZZ TEST". Itu memang disengaja — Fase 5 tidak bisa
 * dibuktikan tanpa data nyata. Nomor case yang dipakai dicetak di akhir log
 * supaya bisa Anda hapus manual kalau mau. User tes dibuat dengan
 * Status = INACTIVE sehingga tidak bisa dipakai login.
 */
function runFase5Tests() {
  var pass = 0, fail = 0, notes = [];

  function ok(name, cond, extra) {
    if (cond) { pass++; console.log('PASS  ' + name); }
    else { fail++; console.error('FAIL  ' + name + (extra ? '  → ' + extra : '')); }
  }
  /** Memastikan sebuah panggilan GAGAL dengan kode error tertentu. */
  function expectErr(name, code, fn) {
    try { fn(); ok(name, false, 'tidak menolak sama sekali'); }
    catch (e) {
      var got = (e && e.code) ? e.code : String(e);
      ok(name, got === code, 'dapat ' + got + ', harusnya ' + code);
    }
  }

  // ── 0. Prasyarat ────────────────────────────────────────────────────────
  // CONFIG & DEALERS di-cache 6 jam (CACHEABLE di 10_SheetDB.gs). Baris yang
  // ditambah MANUAL lewat spreadsheet tidak membuang cache itu, jadi buang
  // dulu di sini — kalau tidak, THREAD_COUNTER yang sudah ada tetap tak terbaca.
  TC.invalidate(TC.S.CONFIG);
  TC.invalidate(TC.S.DEALERS);
  if (!TC.find(TC.S.CONFIG, 'Key', 'THREAD_COUNTER')) {
    console.error('SETUP BELUM LENGKAP: tambahkan baris THREAD_COUNTER (nilai 0) di sheet CONFIG.');
    return;
  }
  var dealer = TC.filter(TC.S.DEALERS, function (d) { return d.Status === 'ACTIVE'; })[0];
  if (!dealer) { console.error('Tidak ada dealer ACTIVE di sheet DEALERS.'); return; }

  function ctxOf(u) {
    return {
      uaHint: 'runFase5Tests',
      user: {
        userId: u.User_ID, fullName: u.Full_Name, role: u.Role,
        dealerId: u.Dealer_ID, dealerName: u.Dealer_Name,
        areas: Guard_.areasOf(u), email: u.Email, mustChangePin: false
      }
    };
  }
  /** Cari user tes; buat kalau belum ada. PIN_Hash sengaja tidak valid. */
  function testUser(tag, role, dealerId) {
    var id = 'U-TEST-' + tag;
    var found = TC.find(TC.S.USERS, 'User_ID', id);
    if (found) return found;
    TC.append(TC.S.USERS, {
      User_ID: id, Full_Name: 'ZZ TEST ' + tag, Role: role,
      Dealer_ID: dealerId || '', Dealer_Name: dealerId ? dealer.Dealer_Name : '',
      Email: 'zz-test-' + tag.toLowerCase() + '@invalid.local', Phone_WA: '',
      PIN_Hash: 'DISABLED', PIN_Salt: 'DISABLED', PIN_Version: '3',
      Status: 'INACTIVE', Must_Change_PIN: 'FALSE', Failed_Attempts: '0',
      Locked_Until: '', Notif_Level: 'Daily_Digest',
      Created_At: TC.nowIso(), Updated_At: TC.nowIso(), Last_Login_At: ''
    });
    return TC.find(TC.S.USERS, 'User_ID', id);
  }

  var cDealer = ctxOf(testUser('DLR1', 'CDT', dealer.Dealer_ID));         // pembuat case
  var cOther  = ctxOf(testUser('DLR2', 'CDT', dealer.Dealer_ID));         // dealer lain, bukan pembuat
  var cIidi   = ctxOf(testUser('IIDI', 'IIDI_Tech_Mgr', ''));

  // ── 1. Siapkan case sampai status In Progress ───────────────────────────
  var caseNo;
  try {
    caseNo = Case_.create(cDealer, {
      vehicle: { VIN: 'WDD2050421F' + String(Date.now()).slice(-6), Model: 'W205',
                 Mileage: 45000, Warranty_Status: 'In_Warranty', Prod_Year: 2019 },
      complaint: { Complaint_Desc: 'ZZ TEST Fase 5 — mesin pincang saat idle.',
                   Symptom_Category: 'Engine', Vehicle_Status: 'In_Workshop' },
      diagnostics: { Initial_Diag: 'Quick test dilakukan, ditemukan DTC pada ME9.7.' },
      priority: 'Normal'
    }).caseNo;
  } catch (e) { console.error('Gagal membuat case tes: ' + (e.message || e)); return; }

  Case_.transition(cDealer, { caseNo: caseNo, toStatus: 'Open' });
  Case_.transition(cIidi,   { caseNo: caseNo, toStatus: 'In Progress' });

  // ── 2. Pintu langsung ke Waiting Dealer Reply harus tertutup (B1) ────────
  expectErr('transition langsung ke Waiting Dealer Reply ditolak', 'VALIDATION', function () {
    Case_.transition(cIidi, { caseNo: caseNo, toStatus: 'Waiting Dealer Reply',
                              waitingReason: 'Additional_Data' });
  });

  // ── 3. request.create ───────────────────────────────────────────────────
  var req = Request_.create(cIidi, {
    caseNo: caseNo,
    items: [{ label: 'Actual values ME9.7 saat idle', evidenceType: 'Actual_Value' },
            'Foto konektor injector silinder 3'],
    note: 'Mohon dilengkapi sebelum batas waktu.'
  });
  ok('request.create → status Waiting Dealer Reply',
     req['case'].Status === 'Waiting Dealer Reply', req['case'].Status);
  ok('request.create → Dealer_Response_Deadline terisi',
     !!req['case'].Dealer_Response_Deadline, 'kosong (cek Sla_ / HOLIDAY_CALENDAR)');
  ok('request.create → Current_Waiting_Reason = Additional_Data',
     req['case'].Current_Waiting_Reason === 'Additional_Data');
  ok('request.create → 1 baris DATA_REQUESTS berstatus OPEN',
     TC.filter(TC.S.REQUESTS, function (r) {
       return r.Case_No === caseNo && r.Status === 'OPEN';
     }).length === 1);

  var tAfterReq = Thread_.forCase(cIidi, caseNo);
  ok('request.create → thread berisi baris Request_Data',
     tAfterReq.some(function (t) { return t.Message_Type === 'Request_Data'; }));
  ok('transisi status menulis baris System di thread (hook Thread_.system jalan)',
     tAfterReq.some(function (t) { return t.Message_Type === 'System'; }),
     'hook() di 20_CaseService.gs mungkin belum diperbaiki');

  expectErr('request.create kedua saat masih OPEN ditolak', 'CONFLICT', function () {
    Request_.create(cIidi, { caseNo: caseNo, items: ['apa saja'] });
  });

  // ── 4. request.fulfill ──────────────────────────────────────────────────
  expectErr('fulfill oleh dealer bukan pembuat case ditolak', 'FORBIDDEN', function () {
    Request_.fulfill(cOther, { requestId: req.request.Request_ID, note: 'coba-coba' });
  });

  var ful = Request_.fulfill(cDealer, {
    requestId: req.request.Request_ID, note: 'Data sudah dilampirkan.', attachmentIds: []
  });
  ok('fulfill oleh pembuat case → request FULFILLED',
     ful.request.Status === 'FULFILLED', ful.request.Status);
  ok('fulfill → status case Waiting IIDI',
     ful['case'].Status === 'Waiting IIDI', ful['case'].Status);
  ok('fulfill → IIDI_Decision_Deadline terisi', !!ful['case'].IIDI_Decision_Deadline);

  // ── 5. Visibilitas thread ───────────────────────────────────────────────
  var secret = Thread_.post(cIidi, {
    caseNo: caseNo, message: 'ZZ TEST catatan internal IIDI.',
    messageType: 'Comment', visibility: 'IIDI_Only'
  }).item;

  function seenBy(ctx) {
    return Thread_.list(ctx, { caseNo: caseNo }).items.some(function (t) {
      return t.Thread_ID === secret.Thread_ID;
    });
  }
  ok('baris IIDI_Only terlihat oleh IIDI', seenBy(cIidi));
  ok('baris IIDI_Only TIDAK terlihat oleh dealer', !seenBy(cDealer));
  ok('baris IIDI_Only tidak ikut di case.get milik dealer',
     !Case_.get(cDealer, { caseNo: caseNo }).thread.some(function (t) {
       return t.Thread_ID === secret.Thread_ID;
     }));

  expectErr('dealer memposting IIDI_Only ditolak', 'FORBIDDEN', function () {
    Thread_.post(cDealer, { caseNo: caseNo, message: 'ZZ TEST', visibility: 'IIDI_Only' });
  });

  // ── 6. Usulan priority (B2) ─────────────────────────────────────────────
  var before = TC.find(TC.S.CASES, 'Case_No', caseNo).Priority;
  var sug = Thread_.post(cIidi, {
    caseNo: caseNo, message: 'Kendaraan tidak dapat dikendarai, mohon ditinjau ke Urgent.',
    suggestedPriority: 'Urgent'
  }).item;
  ok('usulan priority dipaksa jadi Message_Type Decision', sug.Message_Type === 'Decision');
  ok('usulan priority menulis event Priority_Suggested',
     TC.filter(TC.S.EVENTS, function (e) {
       return e.Case_No === caseNo && e.Event_Type === 'Priority_Suggested';
     }).length === 1);
  ok('usulan priority TIDAK mengubah field Priority',
     TC.find(TC.S.CASES, 'Case_No', caseNo).Priority === before);

  // ── 7. Case tertutup mengunci diskusi (C7) ──────────────────────────────
  Case_.transition(cIidi,   { caseNo: caseNo, toStatus: 'Request Closure' });
  Case_.transition(cDealer, { caseNo: caseNo, toStatus: 'Closed', closureType: 'Solved' });
  expectErr('thread.post pada case Closed ditolak', 'CONFLICT', function () {
    Thread_.post(cDealer, { caseNo: caseNo, message: 'ZZ TEST setelah ditutup' });
  });

  // ── 8. Thread_ID berurutan dan unik ─────────────────────────────────────
  var ids = Thread_.forCase(cIidi, caseNo).map(function (t) { return t.Thread_ID; });
  var urut = true, unik = {};
  for (var i = 0; i < ids.length; i++) {
    if (!/^TH-\d{6}$/.test(ids[i])) urut = false;
    if (unik[ids[i]]) urut = false;
    unik[ids[i]] = true;
    if (i && ids[i] <= ids[i - 1]) urut = false;
  }
  ok('Thread_ID berformat TH-000000, urut naik, tidak kembar', urut, ids.join(' '));

  console.log('──────────────────────────────');
  console.log('Case tes: ' + caseNo + ' (boleh dihapus manual)');
  console.log('HASIL: ' + pass + ' PASS, ' + fail + ' FAIL');
  return { caseNo: caseNo, pass: pass, fail: fail };
}