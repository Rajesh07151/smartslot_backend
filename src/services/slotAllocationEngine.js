import db from '../db.js';

// Helper: Convert "HH:MM" to minutes from midnight
export function timeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

// Helper: Convert minutes from midnight to "HH:MM"
export function minutesToTime(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

// Clean up expired checkout holds
export function purgeExpiredHolds() {
  const now = Date.now();
  db.prepare(`DELETE FROM slot_holds WHERE expires_at < ?`).run(now);
}

/**
 * Check if two time intervals overlap
 */
export function intervalsOverlap(startA, endA, startB, endB) {
  return Math.max(startA, startB) < Math.min(endA, endB);
}

/**
 * Get available time slots for a given service on a specific date
 * @param {string} serviceId
 * @param {string} dateStr 'YYYY-MM-DD'
 * @param {string|null} preferredStaffId optional
 * @param {string|null} excludeAppointmentId optional (used when rescheduling)
 * @param {string|null} currentSessionId optional
 */
export function getAvailableSlots(serviceId, dateStr, preferredStaffId = null, excludeAppointmentId = null, currentSessionId = null) {
  purgeExpiredHolds();

  // 1. Fetch service details
  const service = db.prepare(`SELECT * FROM services WHERE id = ? AND is_active = 1`).get(serviceId);
  if (!service) {
    throw new Error('Service not found or inactive');
  }

  const serviceDuration = service.duration_minutes;
  const bufferTime = service.buffer_minutes || 10;
  const totalOccupiedDuration = serviceDuration + bufferTime;

  // 2. Determine Day of Week (0=Sun, 1=Mon, ..., 6=Sat)
  // Ensure we parse dateStr accurately regardless of local server timezone
  const [year, month, day] = dateStr.split('-').map(Number);
  const dateObj = new Date(year, month - 1, day);
  const dayOfWeek = dateObj.getDay();

  // 3. Find qualified staff members who provide this service
  let qualifiedStaffQuery = `
    SELECT s.id, s.name, s.role, s.avatar, s.email,
           sch.start_time, sch.end_time, sch.break_start, sch.break_end, sch.is_working
    FROM staff s
    JOIN staff_services ss ON s.id = ss.staff_id
    JOIN staff_schedules sch ON s.id = sch.staff_id AND sch.day_of_week = ?
    WHERE ss.service_id = ?
      AND s.is_active = 1
      AND sch.is_working = 1
  `;
  const params = [dayOfWeek, serviceId];

  if (preferredStaffId && preferredStaffId !== 'any') {
    qualifiedStaffQuery += ` AND s.id = ?`;
    params.push(preferredStaffId);
  }

  const staffRoster = db.prepare(qualifiedStaffQuery).all(...params);

  if (!staffRoster || staffRoster.length === 0) {
    return {
      date: dateStr,
      service: {
        id: service.id,
        name: service.name,
        duration: serviceDuration,
        price: service.price
      },
      availableSlots: [],
      reason: preferredStaffId && preferredStaffId !== 'any' 
        ? 'Selected specialist is not scheduled to work or qualified on this date.'
        : 'No qualified specialists are scheduled to work on this day.'
    };
  }

  // 4. Fetch all active bookings and holds for that date
  let appointmentsQuery = `
    SELECT id, staff_id, start_time, end_time, duration_minutes
    FROM appointments
    WHERE date = ? AND status NOT IN ('CANCELLED')
  `;
  const aptParams = [dateStr];

  if (excludeAppointmentId) {
    appointmentsQuery += ` AND id != ?`;
    aptParams.push(excludeAppointmentId);
  }

  const existingAppointments = db.prepare(appointmentsQuery).all(...aptParams);

  // Active holds (excluding current session's own hold if any)
  let holdsQuery = `
    SELECT staff_id, start_time, end_time, session_id
    FROM slot_holds
    WHERE date = ? AND expires_at > ?
  `;
  const holdParams = [dateStr, Date.now()];
  if (currentSessionId) {
    holdsQuery += ` AND session_id != ?`;
    holdParams.push(currentSessionId);
  }
  const activeHolds = db.prepare(holdsQuery).all(...holdParams);

  // 5. Generate candidate time slots for the day (e.g. in 30-minute intervals from 08:00 to 18:00)
  // We can find the earliest shift start and latest shift end among qualified working staff
  let minShiftStart = 24 * 60;
  let maxShiftEnd = 0;

  for (const staff of staffRoster) {
    const sStart = timeToMinutes(staff.start_time);
    const sEnd = timeToMinutes(staff.end_time);
    if (sStart < minShiftStart) minShiftStart = sStart;
    if (sEnd > maxShiftEnd) maxShiftEnd = sEnd;
  }

  // Interval step: 30 minutes
  const intervalMinutes = 30;
  const candidateSlotsMap = new Map(); // '09:00' -> { startTime, endTime, availableStaff: [] }

  for (let candidateStart = minShiftStart; candidateStart + serviceDuration <= maxShiftEnd; candidateStart += intervalMinutes) {
    const candidateEnd = candidateStart + serviceDuration;
    const candidateSlotKey = minutesToTime(candidateStart);
    const candidateEndStr = minutesToTime(candidateEnd);

    // Check which staff members are free for this candidate slot
    const freeStaffForSlot = [];
    let hadApptConflict = false;
    let hadBreakConflict = false;
    let inShiftCount = 0;

    for (const staff of staffRoster) {
      const shiftStart = timeToMinutes(staff.start_time);
      const shiftEnd = timeToMinutes(staff.end_time);

      // Must be within staff's working hours
      if (candidateStart < shiftStart || candidateEnd > shiftEnd) {
        continue;
      }

      inShiftCount++;

      // Check if slot overlaps with staff's lunch break
      if (staff.break_start && staff.break_end) {
        const breakStart = timeToMinutes(staff.break_start);
        const breakEnd = timeToMinutes(staff.break_end);
        if (intervalsOverlap(candidateStart, candidateEnd, breakStart, breakEnd)) {
          hadBreakConflict = true;
          continue;
        }
      }

      // Check collisions with existing appointments
      // Candidate occupied window includes service buffer
      const candidateOccupiedEnd = candidateStart + totalOccupiedDuration;

      const staffAppointments = existingAppointments.filter(a => a.staff_id === staff.id);
      let staffApptConflict = false;

      for (const apt of staffAppointments) {
        const aptStart = timeToMinutes(apt.start_time);
        const aptEnd = timeToMinutes(apt.end_time);
        // Existing appointment also needs buffer time
        const aptEndWithBuffer = aptEnd + bufferTime;

        if (intervalsOverlap(candidateStart, candidateOccupiedEnd, aptStart, aptEndWithBuffer)) {
          staffApptConflict = true;
          hadApptConflict = true;
          break;
        }
      }

      if (staffApptConflict) {
        continue;
      }

      // Check collisions with active checkout holds
      const staffHolds = activeHolds.filter(h => h.staff_id === staff.id);
      let holdConflict = false;
      for (const hold of staffHolds) {
        const holdStart = timeToMinutes(hold.start_time);
        const holdEnd = timeToMinutes(hold.end_time) + bufferTime;
        if (intervalsOverlap(candidateStart, candidateOccupiedEnd, holdStart, holdEnd)) {
          holdConflict = true;
          hadApptConflict = true;
          break;
        }
      }

      if (holdConflict) {
        continue;
      }

      // Staff is free!
      freeStaffForSlot.push({
        id: staff.id,
        name: staff.name,
        role: staff.role,
        avatar: staff.avatar,
        email: staff.email
      });
    }

    // Include candidate slots within working hours
    if (inShiftCount > 0) {
      // Exclude lunch breaks if no staff is available and break conflict occurred
      if (hadBreakConflict && freeStaffForSlot.length === 0 && !hadApptConflict) {
        continue;
      }

      const isAvailable = freeStaffForSlot.length > 0;
      const isBooked = !isAvailable && hadApptConflict;

      candidateSlotsMap.set(candidateSlotKey, {
        startTime: candidateSlotKey,
        endTime: candidateEndStr,
        isAvailable,
        isBooked,
        disabledReason: isBooked ? 'Booked' : !isAvailable ? 'Unavailable' : null,
        availableStaff: freeStaffForSlot,
        spotsAvailable: freeStaffForSlot.length
      });
    }
  }

  const availableSlots = Array.from(candidateSlotsMap.values());

  return {
    date: dateStr,
    service: {
      id: service.id,
      name: service.name,
      duration: serviceDuration,
      price: service.price,
      buffer: bufferTime
    },
    totalSlots: availableSlots.length,
    availableSlots
  };
}

/**
 * Validate if a specific slot can be booked by a specific staff member
 * Used inside transactional booking commit
 */
export function validateSlotAvailable(staffId, serviceId, dateStr, startTime, excludeAppointmentId = null, sessionId = null) {
  purgeExpiredHolds();

  const service = db.prepare(`SELECT * FROM services WHERE id = ?`).get(serviceId);
  if (!service) return { valid: false, message: 'Invalid service' };

  const [year, month, day] = dateStr.split('-').map(Number);
  const dateObj = new Date(year, month - 1, day);
  const dayOfWeek = dateObj.getDay();

  // Check staff schedule & capability
  const staff = db.prepare(`
    SELECT s.id, s.name, sch.start_time, sch.end_time, sch.break_start, sch.break_end, sch.is_working
    FROM staff s
    JOIN staff_services ss ON s.id = ss.staff_id
    JOIN staff_schedules sch ON s.id = sch.staff_id AND sch.day_of_week = ?
    WHERE s.id = ? AND ss.service_id = ? AND s.is_active = 1 AND sch.is_working = 1
  `).get(dayOfWeek, staffId, serviceId);

  if (!staff) {
    return { valid: false, message: 'Specialist is not qualified or scheduled to work on this date.' };
  }

  const duration = service.duration_minutes;
  const buffer = service.buffer_minutes || 10;
  const startMins = timeToMinutes(startTime);
  const endMins = startMins + duration;
  const occupiedEndMins = endMins + buffer;

  const shiftStart = timeToMinutes(staff.start_time);
  const shiftEnd = timeToMinutes(staff.end_time);

  if (startMins < shiftStart || endMins > shiftEnd) {
    return { valid: false, message: 'Selected time falls outside technician working hours.' };
  }

  if (staff.break_start && staff.break_end) {
    const breakStart = timeToMinutes(staff.break_start);
    const breakEnd = timeToMinutes(staff.break_end);
    if (intervalsOverlap(startMins, endMins, breakStart, breakEnd)) {
      return { valid: false, message: 'Selected time conflicts with technician scheduled lunch/break.' };
    }
  }

  // Check existing appointments
  let checkAptQuery = `
    SELECT id, start_time, end_time FROM appointments
    WHERE staff_id = ? AND date = ? AND status NOT IN ('CANCELLED')
  `;
  const params = [staffId, dateStr];
  if (excludeAppointmentId) {
    checkAptQuery += ` AND id != ?`;
    params.push(excludeAppointmentId);
  }

  const existingApts = db.prepare(checkAptQuery).all(...params);
  for (const apt of existingApts) {
    const aStart = timeToMinutes(apt.start_time);
    const aEnd = timeToMinutes(apt.end_time) + buffer;
    if (intervalsOverlap(startMins, occupiedEndMins, aStart, aEnd)) {
      return { valid: false, message: 'Selected time slot is already booked for this technician.' };
    }
  }

  // Check temporary holds
  let checkHoldQuery = `
    SELECT id FROM slot_holds
    WHERE staff_id = ? AND date = ? AND expires_at > ?
  `;
  const holdParams = [staffId, dateStr, Date.now()];
  if (sessionId) {
    checkHoldQuery += ` AND session_id != ?`;
    holdParams.push(sessionId);
  }
  const activeHolds = db.prepare(checkHoldQuery).all(...holdParams);
  for (const hold of activeHolds) {
    // Hold conflict
    return { valid: false, message: 'This slot is currently temporarily reserved by another checkout in progress.' };
  }

  return { valid: true, endTime: minutesToTime(endMins), duration, price: service.price };
}
