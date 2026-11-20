import test from 'node:test';
import assert from 'node:assert/strict';
import { runSeed } from '../src/seed.js';
import db from '../src/db.js';
import { validateSlotAvailable } from '../src/services/slotAllocationEngine.js';
import { isValidDate, isValidTime, isValidEmail, isValidPhone } from '../src/utils/validators.js';
import { analyticsService } from '../src/services/analyticsService.js';
import { generateToken, verifyToken } from '../src/services/authService.js';

test.before(() => {
  runSeed();
});

test('Validators reject invalid dates, past dates, and invalid times', () => {
  // Invalid time strings
  assert.equal(isValidTime('abc'), false, 'Non-numeric time must be invalid');
  assert.equal(isValidTime('25:00'), false, 'Hour > 23 must be invalid');
  assert.equal(isValidTime('12:60'), false, 'Minute > 59 must be invalid');
  assert.equal(isValidTime('10:00'), true, 'Valid time must pass');

  // Past dates
  assert.equal(isValidDate('2020-01-01', false), false, 'Past date must be invalid for booking');
  assert.equal(isValidDate('2026-02-30', false), false, 'February 30th must be invalid date');

  // Future date
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

  // David Kim (stf-david) does Brake (srv-brake: 90m, 4999) + Align (srv-align: 60m, 1499)
  const multiCheck = validateSlotAvailable('stf-david', 'srv-brake,srv-align', testDate, '09:00');
  assert.equal(multiCheck.valid, true, 'David Kim should be qualified for both Brake + Alignment');
  assert.equal(multiCheck.duration, 150, 'Combined duration should be 90 + 60 = 150 minutes');
  assert.equal(multiCheck.price, 6498, 'Combined price should be 4999 + 1499 = 6498');

  // Carlos does NOT do srv-brake
  const carlosCheck = validateSlotAvailable('stf-carlos', 'srv-brake,srv-align', testDate, '09:00');
  assert.equal(carlosCheck.valid, false, 'Carlos should be rejected because he is not certified for Brake');
});
