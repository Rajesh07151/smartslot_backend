import test from 'node:test';
import assert from 'node:assert/strict';
import { runSeed } from '../src/seed.js';
import db from '../src/db.js';
import { getAvailableSlots, validateSlotAvailable, intervalsOverlap } from '../src/services/slotAllocationEngine.js';

// Setup database state before running tests
test.before(() => {
  runSeed();
});

test('Intervals overlap math correctly identifies intersections', () => {
  // Overlapping intervals
  assert.equal(intervalsOverlap(540, 600, 570, 630), true);
  // Touching intervals (not overlapping)
  assert.equal(intervalsOverlap(540, 600, 600, 660), false);
  // Completely separate
  assert.equal(intervalsOverlap(540, 600, 660, 720), false);
  // Contained interval
  assert.equal(intervalsOverlap(500, 700, 550, 600), true);
});

test('Slot Allocation Engine filters out lunch breaks and non-working days', () => {
  // Check slots for Monday (1) for Marcus Vance (stf-marcus) who does srv-diag
  const d = new Date();
  d.setDate(d.getDate() + ((1 + 7 - d.getDay()) % 7 || 7));
  const mondayStr = d.toISOString().slice(0, 10);

  const availability = getAvailableSlots('srv-diag', mondayStr, 'stf-marcus');
  assert.ok(availability.availableSlots.length > 0, 'Should return available slots for Monday');

  // Marcus's lunch break is 12:00 - 13:00.
  // A 60-min service at 11:30, 12:00 or 12:30 must NOT be present!
  const hasLunchConflict = availability.availableSlots.some(s => {
    return s.startTime === '11:30' || s.startTime === '12:00' || s.startTime === '12:30';
  });
  assert.equal(hasLunchConflict, false, 'Slots overlapping lunch break 12:00-13:00 must be excluded');
});

test('Double booking prevention: Rejects overlapping booking on same staff member', () => {
  // Pick next working Thursday for Marcus
  const d = new Date();
  d.setDate(d.getDate() + ((4 + 7 - d.getDay()) % 7 || 7));
  const testDate = d.toISOString().slice(0, 10);

  // Initial validation: 09:00 should be free
  const initialCheck = validateSlotAvailable('stf-marcus', 'srv-diag', testDate, '09:00');
  assert.equal(initialCheck.valid, true, 'Slot 09:00 should initially be free');

  // Insert an appointment at 09:00 for Marcus (60 mins, ends 10:00)
  db.prepare(`
    INSERT INTO appointments (
      id, booking_reference, customer_name, customer_email, customer_phone,
      service_id, staff_id, date, start_time, end_time, duration_minutes,
      total_price, status
    ) VALUES (
      'apt-test-1', 'SLOT-TEST1', 'John Test', 'john@test.com', '555-0001',
      'srv-diag', 'stf-marcus', ?, '09:00', '10:00', 60,
      149.00, 'CONFIRMED'
    )
  `).run(testDate);

  // Attempt 1: Exact duplicate 09:00 -> MUST FAIL
  const secondCheck = validateSlotAvailable('stf-marcus', 'srv-diag', testDate, '09:00');
  assert.equal(secondCheck.valid, false, 'Exact duplicate slot must be rejected');

  // Attempt 2: Overlapping slot at 09:30 -> MUST FAIL
  const overlapCheck = validateSlotAvailable('stf-marcus', 'srv-diag', testDate, '09:30');
  assert.equal(overlapCheck.valid, false, 'Overlapping slot must be rejected');

  // Attempt 3: Buffer conflict at 10:00 (since 09:00 + 60m + 10m buffer = 10:10) -> MUST FAIL
  const bufferCheck = validateSlotAvailable('stf-marcus', 'srv-diag', testDate, '10:00');
  assert.equal(bufferCheck.valid, false, 'Buffer conflict must be prevented');

  // Attempt 4: Clean slot at 13:00 (after lunch 12:00-13:00, within shift 08:30-16:30) -> MUST SUCCEED
  const cleanCheck = validateSlotAvailable('stf-marcus', 'srv-diag', testDate, '13:00');
  assert.equal(cleanCheck.valid, true, 'Clean slot at 13:00 should be allowed');
});

test('Cancellation frees up the slot immediately', () => {
  const d = new Date();
  d.setDate(d.getDate() + ((4 + 7 - d.getDay()) % 7 || 7));
  const testDate = d.toISOString().slice(0, 10);

  // Cancel the test appointment
  db.prepare(`UPDATE appointments SET status = 'CANCELLED' WHERE id = 'apt-test-1'`).run();

  // Now 09:00 must be available again!
  const postCancelCheck = validateSlotAvailable('stf-marcus', 'srv-diag', testDate, '09:00');
  assert.equal(postCancelCheck.valid, true, 'Cancelled slot must immediately become available');
});

test('Staff capability check prevents assigning unqualified technician', () => {
  const d = new Date();
  d.setDate(d.getDate() + ((4 + 7 - d.getDay()) % 7 || 7));
  const testDate = d.toISOString().slice(0, 10);

  // Carlos (stf-carlos) does detailing and oil changes, but NOT hybrid/EV diagnostic (srv-ev)
  const capabilityCheck = validateSlotAvailable('stf-carlos', 'srv-ev', testDate, '10:00');
  assert.equal(capabilityCheck.valid, false, 'Unqualified technician must be rejected for service');
  assert.match(capabilityCheck.message, /not qualified/i);
});
