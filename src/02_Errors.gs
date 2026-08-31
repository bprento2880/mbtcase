/**
 * 02_Errors.gs
 *
 * Kelas error standar untuk seluruh backend. TIDAK ADA `throw 'string'` di
 * manapun di codebase ini — selalu `throw new AppError(code, message)`.
 * Lihat docs/02-api-contract.md §3 untuk daftar kode dan artinya di frontend.
 */

class AppError extends Error {
  /**
   * @param {string} code - salah satu nilai di ERROR_CODES
   * @param {string} message - pesan untuk ditampilkan ke user, Bahasa Indonesia
   * @param {Object} [fields] - detail per field, hanya dipakai untuk code VALIDATION
   */
  constructor(code, message, fields) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.fields = fields || null;
  }
}

const ERROR_CODES = {
  UNAUTHENTICATED: 'UNAUTHENTICATED', // token kosong/kadaluarsa/dicabut -> frontend redirect ke login
  FORBIDDEN: 'FORBIDDEN',             // role/scope tidak mengizinkan -> tampilkan pesan, jangan retry
  NOT_FOUND: 'NOT_FOUND',             // entitas tidak ada
  VALIDATION: 'VALIDATION',           // input tidak valid, fields berisi detail per field
  CONFLICT: 'CONFLICT',               // transisi status ilegal / data sudah berubah
  LOCKED: 'LOCKED',                   // akun terkunci sementara
  RATE_LIMIT: 'RATE_LIMIT',           // terlalu banyak percobaan
  BUSY: 'BUSY',                       // LockService gagal -> frontend auto-retry 1x setelah 2 detik
  UPSTREAM: 'UPSTREAM',               // Gemini / Drive gagal -> degradasi halus
  INTERNAL: 'INTERNAL'                // lainnya -> pesan umum + log
};
