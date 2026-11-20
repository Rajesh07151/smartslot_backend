import test from 'node:test';
import assert from 'node:assert/strict';
import { runSeed } from '../src/seed.js';
import db from '../src/db.js';
import { validateSlotAvailable, intervalsOverlap } from '../src/services/slotAllocationEngine.js';
import { isValidDate, isValidTime, isValidSlotGridTime, isValidEmail, isValidPhone, isPastDateTime } from '../src/utils/validators.js';
import { analyticsService } from '../src/services/analyticsService.js';
import { generateToken, verifyToken } from '../src/services/authService.js';

test.before(() => {
  runSeed();
});

test('Validators reject invalid dates, past dates, off-grid times, and distant future dates', () => {
  // Invalid time strings
  assert.equal(isValidTime('abc'), false, 'Non-numeric time must be invalid');
  assert.equal(isValidTime('25:00'), false, 'Hour > 23 must be invalid');
  assert.equal(isValidTime('12:60'), false, 'Minute > 59 must be invalid');
  assert.equal(isValidTime('10:00'), true, 'Valid time must pass');

  // Off-grid times (Item 8)
  assert.equal(isValidSlotGridTime('10:10'), false, '10:10 must be rejected (off-grid)');
  assert.equal(isValidSlotGridTime('09:15'), false, '09:15 must be rejected (off-grid)');
  assert.equal(isValidSlotGridTime('06:00'), false, '06:00 must be rejected (outside operating hours)');
  assert.equal(isValidSlotGridTime('10:00'), true, '10:00 must be valid on-grid');
  assert.equal(isValidSlotGridTime('10:30'), true, '10:30 must be valid on-grid');

  // Past dates & times (Item 8)
  assert.equal(isValidDate('2020-01-01', false), false, 'Past date must be invalid for booking');
  assert.equal(isValidDate('2026-02-30', false), false, 'February 30th must be invalid date');
  assert.equal(isPastDateTime('2020-01-01', '10:00'), true, 'Past date+time must be identified as past');

  // Distant future dates (> 60 days) (Item 8)
  assert.equal(isValidDate('2035-01-01', false, 60), false, 'Distant future date must be rejected (> 60 days)');

  // Future valid date
  const future = new Date();
  future.setDate(future.getDate() + 5);
  const futureStr = future.toISOString().slice(0, 10);
  assert.equal(isValidDate(futureStr, false), true, 'Valid future date must pass');

  // Emails and Phones
  assert.equal(isValidEmail('bademail'), false);
  assert.equal(isValidEmail('user@domain.com'), true);
  assert.equal(isValidPhone('123'), false, 'Phone < 7 digits must fail');
  assert.equal(isValidPhone('+91 98765 43210'), true);
});

test('Slot Allocation Engine rejects invalid timings such as "abc" without throwing', () => {
  const d = new Date();
  d.setDate(d.getDate() + 3);
  const futureDate = d.toISOString().slice(0, 10);

  const res = validateSlotAvailable('stf-marcus', 'srv-diag', futureDate, 'abc');
  assert.equal(res.valid, false, 'Invalid time string "abc" must be rejected');
});

test('Slot hold only blocks overlapping time intervals and does NOT block other slots on same day (Item 6)', () => {
  const d = new Date();
  d.setDate(d.getDate() + ((4 + 7 - d.getDay()) % 7 || 7));
  const testDate = d.toISOString().slice(0, 10);

  // Clean any test holds
  db.prepare(`DELETE FROM slot_holds WHERE date = ?`).run(testDate);

  // Place a temporary hold on 09:00 - 10:00 for David Chen (stf-david)
  const holdId = 'test-hold-01';
  const expiresAt = Date.now() + 60000;
  db.prepare(`
    INSERT INTO slot_holds (id, staff_id, date, start_time, end_time, session_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(holdId, 'stf-david', testDate, '09:00', '10:00', 'session-client-A', expiresAt);

  // Client B tries to check availability for the overlapping slot (09:00): MUST BE REJECTED
  const overlapCheck = validateSlotAvailable('stf-david', 'srv-align', testDate, '09:00', null, 'session-client-B');
  assert.equal(overlapCheck.valid, false, 'Overlapping slot must be blocked by active hold');

  // Client B tries to check availability for an afternoon slot (14:00): MUST BE AVAILABLE! (Item 6)
  const afternoonCheck = validateSlotAvailable('stf-david', 'srv-align', testDate, '14:00', null, 'session-client-B');
  assert.equal(afternoonCheck.valid, true, 'Non-overlapping slot at 14:00 on the same day must NOT be blocked by 09:00 hold');

  // Clean up
  db.prepare(`DELETE FROM slot_holds WHERE id = ?`).run(holdId);
});

test('Analytics calculates realized revenue ONLY from COMPLETED appointments', () => {
  const metrics = analyticsService.getOverviewMetrics();
  
  // Directly query sum of completed appointments
  const expectedCompletedRevenue = db.prepare(`
    SELECT COALESCE(SUM(total_price), 0) as total
    FROM appointments
    WHERE status = 'COMPLETED'
  `).get().total;

  assert.equal(metrics.kpis.realizedRevenue, expectedCompletedRevenue, 'Realized revenue must only include COMPLETED appointments');
  assert.ok(metrics.kpis.projectedRevenue !== undefined, 'Projected revenue should be defined for pipeline bookings');
});

test('No-show rate is computed against past resolved appointments (COMPLETED + NO_SHOW)', () => {
  const metrics = analyticsService.getOverviewMetrics();
  const completed = metrics.kpis.completedAppointments;
  const noShow = metrics.kpis.noShowAppointments;
  const totalResolved = completed + noShow;

  const expectedRate = totalResolved > 0 ? Number(((noShow / totalResolved) * 100).toFixed(1)) : 0;
  assert.equal(metrics.kpis.noShowRate, expectedRate, 'No-show rate must be calculated against completed + no_show appointments');
});

test('Staff user token contains staff_id and is correctly verified', () => {
  const staffUser = {
    id: 'usr-staff-marcus',
    email: 'marcus@smartslot.service',
    role: 'STAFF',
    staff_id: 'stf-marcus'
  };

  const token = generateToken(staffUser);
  const decoded = verifyToken(token);

  assert.equal(decoded.role, 'STAFF');
  assert.equal(decoded.staff_id, 'stf-marcus');
});

test('Multi-service slot allocation sums duration, prices, and matches qualified technician', () => {
  const d = new Date();
  d.setDate(d.getDate() + ((4 + 7 - d.getDay()) % 7 || 7));
  const testDate = d.toISOString().slice(0, 10);

  // David Chen (stf-david) does Brake (srv-brake: 90m, 4999) + Align (srv-align: 60m, 1499)
  const multiCheck = validateSlotAvailable('stf-david', 'srv-brake,srv-align', testDate, '09:00');
  assert.equal(multiCheck.valid, true, 'David Chen should be qualified for both Brake + Alignment');
  assert.equal(multiCheck.duration, 150, 'Combined duration should be 90 + 60 = 150 minutes');
  assert.equal(multiCheck.price, 6498, 'Combined price should be 4999 + 1499 = 6498');

  // Carlos does NOT do srv-brake
  const carlosCheck = validateSlotAvailable('stf-carlos', 'srv-brake,srv-align', testDate, '09:00');
  assert.equal(carlosCheck.valid, false, 'Carlos should be rejected because he is not certified for Brake');
});
