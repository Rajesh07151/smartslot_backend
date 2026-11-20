/**
 * Strict Input Validation Utilities for SmartSlot Backend
 */

/**
 * Validates 'YYYY-MM-DD' calendar date and checks that it is not in the past
 * and not too far in the future (default max 60 days).
 * @param {string} dateStr
 * @param {boolean} allowPast - default false (bookings must be today or future)
 * @param {number} maxDaysAhead - default 60 days
 */
export function isValidDate(dateStr, allowPast = false, maxDaysAhead = 60) {
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

  const targetDate = new Date(year, month - 1, day);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (!allowPast) {
    if (targetDate < today) return false;
  }

  if (maxDaysAhead && typeof maxDaysAhead === 'number') {
    const maxDate = new Date(today);
    maxDate.setDate(maxDate.getDate() + maxDaysAhead);
    if (targetDate > maxDate) return false;
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
 * Validates that an appointment time is aligned to the workshop's 30-minute slot grid
 * and falls within standard workshop operational hours (08:00 to 18:00).
 * Rejects off-grid times like 10:10, 09:15, 14:47, etc.
 * @param {string} timeStr
 */
export function isValidSlotGridTime(timeStr) {
  if (!isValidTime(timeStr)) return false;
  const [hourStr, minStr] = timeStr.split(':');
  const hour = parseInt(hourStr, 10);
  const min = parseInt(minStr, 10);

  // Minutes must be exactly :00 or :30
  if (min !== 0 && min !== 30) return false;

  // Workshop operational hours: 08:00 to 18:00
  if (hour < 8 || hour >= 18) return false;

  return true;
}

/**
 * Checks if a specific date and time combination is in the past relative to now.
 * @param {string} dateStr - 'YYYY-MM-DD'
 * @param {string} timeStr - 'HH:MM'
 */
export function isPastDateTime(dateStr, timeStr) {
  if (!isValidDate(dateStr, true) || !isValidTime(timeStr)) return false;
  const [year, month, day] = dateStr.split('-').map(n => parseInt(n, 10));
  const [hour, min] = timeStr.split(':').map(n => parseInt(n, 10));

  const targetDateTime = new Date(year, month - 1, day, hour, min, 0, 0);
  const now = new Date();

  return targetDateTime.getTime() < now.getTime();
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
