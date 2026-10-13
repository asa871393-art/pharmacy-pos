'use strict';
// Errors carry an HTTP status and an Arabic message that is shown to the user as-is.
class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const badRequest = (msg) => new AppError(400, msg);
const unauthorized = (msg = 'يجب تسجيل الدخول') => new AppError(401, msg);
const forbidden = (msg = 'ليست لديك صلاحية لهذا الإجراء') => new AppError(403, msg);
const notFound = (msg = 'العنصر غير موجود') => new AppError(404, msg);
const conflict = (msg) => new AppError(409, msg);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict };
