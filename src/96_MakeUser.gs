/**
 * Membuat user dealer untuk uji Ronde 3. Jalankan SEKALI dari editor GAS,
 * lalu hapus file ini. Email pakai domain nyata supaya bisa terima notifikasi.
 *
 * PIN sementara: 429517 (bukan berurutan, bukan digit sama - lolos aturan
 * 03-rbac.md §4). Must_Change_PIN = TRUE, jadi wajib ganti saat login pertama.
 */
function makeDealerUser() {
  var EMAIL = 'GANTI_DENGAN_EMAIL_ANDA@gmail.com';   // <-- WAJIB DIISI
  var PIN   = '429517';

  var users = TC.readAll(TC.S.USERS);
  var dup = users.filter(function (u) {
    return String(u.Email).toLowerCase() === EMAIL.toLowerCase() && u.Status !== 'INACTIVE';
  });
  if (dup.length) throw new Error('Email sudah dipakai user aktif: ' + dup[0].User_ID);

  var salt = Utilities.base64Encode(
    Utilities.getUuid().replace(/-/g, '').substring(0, 16)
  );
  var now = new Date().toISOString().replace('Z', '+07:00');

  TC.append(TC.S.USERS, {
    User_ID: 'U-0090',
    Full_Name: 'Teknisi Uji Dealer',
    Role: 'CDT',
    Dealer_ID: 'DLR-AJM-01',          // <-- samakan dengan Dealer_ID di sheet DEALERS
    Dealer_Name: 'PT. Arista Jaya',   // <-- samakan
    Email: EMAIL,
    Phone_WA: '',
    PIN_Hash: hashPin_(PIN, salt),
    PIN_Salt: salt,
    PIN_Version: 3,
    Status: 'ACTIVE',
    Must_Change_PIN: 'TRUE',
    Failed_Attempts: 0,
    Locked_Until: '',
    Notif_Level: 'All',
    Created_At: now,
    Updated_At: now,
    Last_Login_At: ''
  });
  TC.invalidate(TC.S.USERS);
  Logger.log('User dibuat. Login: ' + EMAIL + ' / PIN ' + PIN);
}