/**
 * Strict Input Validation Utilities for SmartSlot Backend
 */

/**
 * Validates 'YYYY-MM-DD' calendar date and checks that it is not in the past
 * @param {string} dateStr
 * @param {boolean} allowPast - default false (bookings must be today or future)
 */
export function isValidDate(dateStr, allowPast = false) {
  if (!dateStr || typeof dateStr !== 'string') return false;
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);

  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;

  // Validate exact days per month (including leap year)
  const daysInMonth = new Date(year, month, 0).getDate();
  if (day > daysInMonth) return false;

  if (!allowPast) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const targetDate = new Date(year, month - 1, day);
    if (targetDate < today) return false;
  }

  return true;
}

/**
 * Validates 'HH:MM' time string (24-hour format: 00:00 to 23:59)
 * @param {string} timeStr
 */
export function isValidTime(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return false;
  const match = timeStr.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return Boolean(match);
}

/**
 * Validates email format
 * @param {string} email
 */
export function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const clean = email.trim();
  if (clean.length > 254) return false;
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  return emailRegex.test(clean);
}

/**
 * Validates mobile / phone number (7 to 15 digits with optional '+' prefix)
 * @param {string} phone
 */
export function isValidPhone(phone) {
  if (!phone || typeof phone !== 'string') return false;
  const clean = phone.trim();
  if (!/^\+?[0-9\s\-()]{7,20}$/.test(clean)) return false;
  const digitsOnly = clean.replace(/\D/g, '');
  return digitsOnly.length >= 7 && digitsOnly.length <= 15;
}

/**
 * Validates person name
 * @param {string} name
 */
export function isValidName(name) {
  if (!name || typeof name !== 'string') return false;
  const clean = name.trim();
  return clean.length >= 2 && clean.length <= 100;
}
