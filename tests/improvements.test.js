import test from 'node:test';
import assert from 'node:assert/strict';
import { runSeed } from '../src/seed.js';
import db from '../src/db.js';
import { validateSlotAvailable, intervalsOverlap } from '../src/services/slotAllocationEngine.js';
import { isValidDate, isValidTime, isValidSlotGridTime, isValidEmail, isValidPhone, isPastDateTime } from '../src/utils/validators.js';
import { analyticsService } from '../src/services/analyticsService.js';
import { generateToken, verifyToken } from '../src/services/authService.js';
import { verifyAppointmentOwnership } from '../src/routes/appointments.js';

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

test('Booking ownership verification strictly isolates customer data and verifies roles', () => {
  const customerApt = {
    id: 'apt-cust-1',
    user_id: 'usr-customer-1',
    customer_email: 'rajesh@example.com',
    staff_id: 'stf-david'
  };

  // 1. Unauthenticated request: MUST return 401
  const unauthCheck = verifyAppointmentOwnership(customerApt, { user: null });
  assert.equal(unauthCheck.authorized, false);
  assert.equal(unauthCheck.status, 401);

  // 2. Customer B accessing Customer A's booking: MUST return 403 Forbidden
  const otherCustomerReq = {
    user: {
      id: 'usr-customer-2',
      email: 'other@example.com',
      role: 'CUSTOMER'
    }
  };
  const deniedCheck = verifyAppointmentOwnership(customerApt, otherCustomerReq);
  assert.equal(deniedCheck.authorized, false);
  assert.equal(deniedCheck.status, 403);

  // 3. Customer A accessing own booking by user_id: MUST pass
  const ownerReq = {
    user: {
      id: 'usr-customer-1',
      email: 'rajesh@example.com',
      role: 'CUSTOMER'
    }
  };
  const ownerCheck = verifyAppointmentOwnership(customerApt, ownerReq);
  assert.equal(ownerCheck.authorized, true);

  // 4. Another staff member trying to access David's appointment: MUST return 403
  const otherStaffReq = {
    user: {
      id: 'usr-staff-marcus',
      email: 'marcus@smartslot.service',
      role: 'STAFF',
      staff_id: 'stf-marcus'
    }
  };
  const staffDenied = verifyAppointmentOwnership(customerApt, otherStaffReq);
  assert.equal(staffDenied.authorized, false);
  assert.equal(staffDenied.status, 403);

  // 5. Assigned staff member (David Chen): MUST pass
  const assignedStaffReq = {
    user: {
      id: 'usr-staff-david',
      email: 'david@smartslot.service',
      role: 'STAFF',
      staff_id: 'stf-david'
    }
  };
  const staffAllowed = verifyAppointmentOwnership(customerApt, assignedStaffReq);
  assert.equal(staffAllowed.authorized, true);

  // 6. Facility Admin: MUST pass
  const adminReq = {
    user: {
      id: 'usr-admin',
      email: 'admin@smartslot.service',
      role: 'ADMIN'
    }
  };
  const adminAllowed = verifyAppointmentOwnership(customerApt, adminReq);
  assert.equal(adminAllowed.authorized, true);
});

test('Database persistence ensures active customer records survive seed/server restart', () => {
  // Check that Harsha's real booking is in the database
  const harshaBooking = db.prepare('SELECT * FROM appointments WHERE booking_reference = ?').get('SLOT-HQ2S');
  assert.ok(harshaBooking, 'Harsha booking SLOT-HQ2S must exist');
  assert.equal(harshaBooking.customer_email, 'harsha121@gmail.com');

  // Run seed again (simulating container restart on Render)
  runSeed();

  // Re-verify that booking still exists and was not erased
  const postRestartBooking = db.prepare('SELECT * FROM appointments WHERE booking_reference = ?').get('SLOT-HQ2S');
  assert.ok(postRestartBooking, 'Harsha booking SLOT-HQ2S must survive seed restart');
  assert.equal(postRestartBooking.id, harshaBooking.id);
});

test('Technician status transitions support COMPLETED and NO_SHOW', () => {
  const testAptId = 'apt-test-status-cycle';
  db.prepare(`
    INSERT OR REPLACE INTO appointments (
      id, booking_reference, customer_name, customer_email, customer_phone,
      service_id, staff_id, date, start_time, end_time, duration_minutes,
      total_price, status
    ) VALUES (
      ?, 'SLOT-TEST-STAT', 'Status Test', 'statustest@example.com', '9898989898',
      'srv-align', 'stf-david', '2026-11-28', '11:00', '12:00', 60,
      1499.00, 'CONFIRMED'
    )
  `).run(testAptId);

  // Transition to IN_PROGRESS
  db.prepare(`UPDATE appointments SET status = 'IN_PROGRESS' WHERE id = ?`).run(testAptId);
  let current = db.prepare('SELECT status FROM appointments WHERE id = ?').get(testAptId);
  assert.equal(current.status, 'IN_PROGRESS');

  // Transition to COMPLETED
  db.prepare(`UPDATE appointments SET status = 'COMPLETED' WHERE id = ?`).run(testAptId);
  current = db.prepare('SELECT status FROM appointments WHERE id = ?').get(testAptId);
  assert.equal(current.status, 'COMPLETED');

  // Transition to NO_SHOW
  db.prepare(`UPDATE appointments SET status = 'NO_SHOW' WHERE id = ?`).run(testAptId);
  current = db.prepare('SELECT status FROM appointments WHERE id = ?').get(testAptId);
  assert.equal(current.status, 'NO_SHOW');

  // Clean up test appointment
  db.prepare('DELETE FROM appointments WHERE id = ?').run(testAptId);
});
