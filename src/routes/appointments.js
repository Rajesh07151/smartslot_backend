import { Router } from 'express';
import db from '../db.js';
import { v4 as uuidv4 } from 'uuid';
import {
  validateSlotAvailable,
  getAvailableSlots,
  timeToMinutes,
  minutesToTime,
  purgeExpiredHolds
} from '../services/slotAllocationEngine.js';
import { notificationService } from '../services/notificationService.js';
import {
  authenticateToken,
  optionalToken,
  requireAdmin,
  requireStaffOrAdmin
} from '../middleware/auth.js';
import {
  isValidDate,
  isValidTime,
  isValidEmail,
  isValidPhone,
  isValidName
} from '../utils/validators.js';

const router = Router();

// Helper to generate a memorable booking reference like SLOT-7B42
function generateBookingReference() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `SLOT-${code}`;
}

// Helper to mask customer sensitive contact info for unauthenticated tracking
function maskCustomerDetails(apt) {
  if (!apt) return null;

  const maskEmail = (email) => {
    if (!email || !email.includes('@')) return '***@***.***';
    const [user, domain] = email.split('@');
    if (user.length <= 2) return `${user[0]}*@${domain}`;
    return `${user[0]}${'*'.repeat(Math.max(1, user.length - 2))}${user[user.length - 1]}@${domain}`;
  };

  const maskPhone = (phone) => {
    if (!phone) return '***';
    const clean = phone.trim();
    if (clean.length <= 4) return '***';
    return clean.slice(0, -4).replace(/./g, '*') + clean.slice(-4);
  };

  const maskName = (name) => {
    if (!name) return 'Customer';
    const parts = name.trim().split(' ');
    if (parts.length === 1) return parts[0];
    return `${parts[0]} ${parts[1].charAt(0)}.`;
  };

  return {
    ...apt,
    customer_name: maskName(apt.customer_name),
    customer_email: maskEmail(apt.customer_email),
    customer_phone: maskPhone(apt.customer_phone),
    customer_notes: null,
    staff_notes: null
  };
}

// Helper to enrich service_name when multiple services are booked
function enrichServiceNames(apt) {
  if (!apt) return apt;
  let serviceName = apt.service_name;
  if (apt.service_ids && apt.service_ids.includes(',')) {
    const ids = apt.service_ids.split(',').map(s => s.trim()).filter(Boolean);
    const ph = ids.map(() => '?').join(',');
    const svcs = db.prepare(`SELECT name FROM services WHERE id IN (${ph})`).all(...ids);
    if (svcs.length > 0) {
      serviceName = svcs.map(s => s.name).join(' + ');
    }
  }
  return { ...apt, service_name: serviceName };
}

// 1. Temporary slot hold during customer checkout (prevents race condition)
router.post('/hold', (req, res) => {
  try {
    const { staffId, serviceId, serviceIds, date, startTime, sessionId } = req.body;
    const resolvedServiceId = serviceIds
      ? (Array.isArray(serviceIds) ? serviceIds.join(',') : serviceIds)
      : serviceId;

    if (!resolvedServiceId || !date || !startTime || !sessionId) {
      return res.status(400).json({ success: false, error: 'Missing required hold parameters' });
    }

    if (!isValidDate(date, false)) {
      return res.status(400).json({ success: false, error: 'Appointment date must be a valid date (YYYY-MM-DD) and cannot be in the past.' });
    }
    if (!isValidTime(startTime)) {
      return res.status(400).json({ success: false, error: 'Appointment start time must be in valid 24-hour HH:MM format.' });
    }

    const serviceList = resolvedServiceId.split(',').map(s => s.trim()).filter(Boolean);

    // Verify specialist qualification if specific staff requested
    if (staffId && staffId !== 'any') {
      const ph = serviceList.map(() => '?').join(',');
      const isQualified = db.prepare(`
        SELECT COUNT(DISTINCT service_id) as cnt FROM staff_services WHERE staff_id = ? AND service_id IN (${ph})
      `).get(staffId, ...serviceList);
      if (!isQualified || isQualified.cnt < serviceList.length) {
        return res.status(400).json({ success: false, error: 'Selected specialist is not qualified for all requested services.' });
      }
    }

    purgeExpiredHolds();

    // Determine target staff: if 'any', pick first available
    let targetStaffId = staffId;
    if (!targetStaffId || targetStaffId === 'any') {
      const availability = getAvailableSlots(resolvedServiceId, date, 'any');
      const matchingSlot = availability.availableSlots.find(s => s.startTime === startTime);
      if (!matchingSlot || matchingSlot.availableStaff.length === 0) {
        return res.status(409).json({ success: false, error: 'No specialist available for this time slot.' });
      }
      targetStaffId = matchingSlot.availableStaff[0].id;
    }

    const validation = validateSlotAvailable(targetStaffId, resolvedServiceId, date, startTime, null, sessionId);
    if (!validation.valid) {
      return res.status(409).json({ success: false, error: validation.message });
    }

    const holdId = `hold-${uuidv4().slice(0, 8)}`;
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minute hold

    // Clear any previous hold by this session
    db.prepare(`DELETE FROM slot_holds WHERE session_id = ?`).run(sessionId);

    db.prepare(`
      INSERT INTO slot_holds (id, staff_id, date, start_time, end_time, session_id, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(holdId, targetStaffId, date, startTime, validation.endTime, sessionId, expiresAt);

    res.json({
      success: true,
      data: {
        holdId,
        staffId: targetStaffId,
        date,
        startTime,
        endTime: validation.endTime,
        expiresAt
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Create Appointment (ACID Transaction + Concurrency Lock + Idempotency Key)
router.post('/', optionalToken, (req, res) => {
  try {
    const {
      serviceId,
      serviceIds,
      staffId, // specific staff id or 'any'
      date,
      startTime,
      customerName,
      customerEmail,
      customerPhone,
      vehicleDetails,
      customerNotes,
      sessionId,
      userId
    } = req.body;

    // Idempotency check: support header or body key
    const idempotencyKey = req.headers['idempotency-key'] || req.body.idempotencyKey || null;
    if (idempotencyKey) {
      const existingKeyRecord = db.prepare(`SELECT response_data FROM idempotency_keys WHERE key = ?`).get(idempotencyKey);
      if (existingKeyRecord) {
        return res.status(200).json(JSON.parse(existingKeyRecord.response_data));
      }
    }

    // Strict Backend Validations
    if (!isValidName(customerName)) {
      return res.status(400).json({ success: false, error: 'Full customer name is required (minimum 2 characters).' });
    }
    if (!isValidEmail(customerEmail)) {
      return res.status(400).json({ success: false, error: 'A valid email address is required (e.g. name@example.com).' });
    }
    if (!isValidPhone(customerPhone)) {
      return res.status(400).json({ success: false, error: 'A valid mobile phone number is required (7-15 digits).' });
    }
    if (!isValidDate(date, false)) {
      return res.status(400).json({ success: false, error: 'Appointment date must be a valid date (YYYY-MM-DD) and cannot be in the past.' });
    }
    if (!isValidTime(startTime)) {
      return res.status(400).json({ success: false, error: 'Appointment start time must be in valid 24-hour HH:MM format.' });
    }

    const resolvedServiceId = serviceIds
      ? (Array.isArray(serviceIds) ? serviceIds.join(',') : serviceIds)
      : serviceId;

    if (!resolvedServiceId) {
      return res.status(400).json({ success: false, error: 'Service ID is required.' });
    }

    const serviceList = resolvedServiceId.split(',').map(s => s.trim()).filter(Boolean);
    const placeholders = serviceList.map(() => '?').join(',');
    const services = db.prepare(`SELECT * FROM services WHERE id IN (${placeholders})`).all(...serviceList);
    if (!services || services.length !== serviceList.length) {
      return res.status(404).json({ success: false, error: 'One or more requested services not found.' });
    }

    const primaryServiceId = serviceList[0];
    const serviceName = services.map(s => s.name).join(' + ');

    // Specialist qualification check: if specific staff requested, verify qualification for ALL chosen services
    if (staffId && staffId !== 'any') {
      const isQualified = db.prepare(`
        SELECT COUNT(DISTINCT service_id) as cnt FROM staff_services WHERE staff_id = ? AND service_id IN (${placeholders})
      `).get(staffId, ...serviceList);
      if (!isQualified || isQualified.cnt < serviceList.length) {
        return res.status(400).json({
          success: false,
          error: 'Selected specialist is not qualified for all selected services. Please select a certified specialist or choose Any Available Specialist.'
        });
      }
    }

    // Attach authenticated user id if present
    const finalUserId = req.user?.id || userId || null;

    // Run within a database transaction
    const createTransaction = db.transaction(() => {
      purgeExpiredHolds();

      let allocatedStaffId = staffId;

      // Handle "Any Available Specialist" auto-allocation with load balancing
      if (!allocatedStaffId || allocatedStaffId === 'any') {
        const slotData = getAvailableSlots(resolvedServiceId, date, 'any', null, sessionId);
        const slotMatch = slotData.availableSlots.find(s => s.startTime === startTime);

        if (!slotMatch || slotMatch.availableStaff.length === 0) {
          throw new Error('CONFLICT: No specialist is available for this slot. Please select a different time.');
        }

        // Load balance: pick the qualified staff member who has the fewest bookings that day
        const candidateStaff = slotMatch.availableStaff;
        let chosenStaff = candidateStaff[0];
        let minJobs = 999;

        for (const cand of candidateStaff) {
          const jobCount = db.prepare(`
            SELECT COUNT(*) as count FROM appointments
            WHERE staff_id = ? AND date = ? AND status NOT IN ('CANCELLED')
          `).get(cand.id, date).count;

          if (jobCount < minJobs) {
            minJobs = jobCount;
            chosenStaff = cand;
          }
        }
        allocatedStaffId = chosenStaff.id;
      }

      // Re-validate availability under transaction
      const validation = validateSlotAvailable(allocatedStaffId, resolvedServiceId, date, startTime, null, sessionId);
      if (!validation.valid) {
        throw new Error(`CONFLICT: ${validation.message}`);
      }

      // Generate unique reference
      let bookingRef = generateBookingReference();
      while (db.prepare(`SELECT id FROM appointments WHERE booking_reference = ?`).get(bookingRef)) {
        bookingRef = generateBookingReference();
      }

      const appointmentId = `apt-${uuidv4()}`;

      db.prepare(`
        INSERT INTO appointments (
          id, booking_reference, customer_name, customer_email, customer_phone,
          service_id, service_ids, staff_id, date, start_time, end_time, duration_minutes,
          total_price, status, vehicle_details, customer_notes, user_id, idempotency_key, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?,
          ?, 'CONFIRMED', ?, ?, ?, ?, datetime('now'), datetime('now')
        )
      `).run(
        appointmentId,
        bookingRef,
        customerName.trim(),
        customerEmail.trim(),
        customerPhone.trim(),
        primaryServiceId,
        resolvedServiceId,
        allocatedStaffId,
        date,
        startTime,
        validation.endTime,
        validation.duration,
        validation.price,
        vehicleDetails ? vehicleDetails.trim() : null,
        customerNotes ? customerNotes.trim() : null,
        finalUserId,
        idempotencyKey || null
      );

      // Release any checkout hold
      if (sessionId) {
        db.prepare(`DELETE FROM slot_holds WHERE session_id = ?`).run(sessionId);
      }

      return {
        id: appointmentId,
        bookingReference: bookingRef,
        serviceId: primaryServiceId,
        serviceIds: resolvedServiceId,
        services,
        staffId: allocatedStaffId,
        date,
        startTime,
        endTime: validation.endTime,
        durationMinutes: validation.duration,
        totalPrice: validation.price,
        customerName: customerName.trim(),
        customerEmail: customerEmail.trim(),
        customerPhone: customerPhone.trim(),
        vehicleDetails: vehicleDetails ? vehicleDetails.trim() : null,
        customerNotes: customerNotes ? customerNotes.trim() : null,
        userId: finalUserId
      };
    });

    let newAppointment;
    try {
      newAppointment = createTransaction();
    } catch (txErr) {
      if (txErr.message.startsWith('CONFLICT:')) {
        return res.status(409).json({ success: false, error: txErr.message.replace('CONFLICT:', '').trim() });
      }
      throw txErr;
    }

    // Fetch names for notification
    const staff = db.prepare(`SELECT name FROM staff WHERE id = ?`).get(newAppointment.staffId);

    // Trigger automated booking confirmation (Simulated Email & SMS)
    notificationService.sendBookingConfirmation(
      {
        id: newAppointment.id,
        booking_reference: newAppointment.bookingReference,
        customer_name: newAppointment.customerName,
        customer_email: newAppointment.customerEmail,
        customer_phone: newAppointment.customerPhone,
        date: newAppointment.date,
        start_time: newAppointment.startTime,
        end_time: newAppointment.endTime,
        vehicle_details: newAppointment.vehicleDetails
      },
      serviceName,
      staff?.name || 'Assigned Technician'
    );

    const responsePayload = {
      success: true,
      message: 'Appointment confirmed successfully!',
      data: {
        ...newAppointment,
        serviceName,
        services,
        staffName: staff?.name
      }
    };

    // Store idempotency record
    if (idempotencyKey) {
      try {
        db.prepare(`
          INSERT INTO idempotency_keys (key, appointment_id, response_data)
          VALUES (?, ?, ?)
        `).run(idempotencyKey, newAppointment.id, JSON.stringify(responsePayload));
      } catch (e) {
        // Ignore duplicate key race condition
      }
    }

    res.status(201).json(responsePayload);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Customer Bookings List (Authenticated Customer Only - Role-Based Authorization)
router.get('/my-bookings', authenticateToken, (req, res) => {
  try {
    const user = req.user;
    let query;
    let params;

    // Role check: Customers can ONLY view their own bookings
    if (user.role === 'CUSTOMER') {
      query = `
        SELECT a.*,
               s.name as service_name, s.category as service_category, s.price as service_price, s.duration_minutes as service_duration,
               st.name as staff_name, st.role as staff_role, st.avatar as staff_avatar, st.phone as staff_phone
        FROM appointments a
        JOIN services s ON a.service_id = s.id
        JOIN staff st ON a.staff_id = st.id
        WHERE a.user_id = ? OR LOWER(a.customer_email) = LOWER(?)
        ORDER BY a.created_at DESC, a.date DESC
      `;
      params = [user.id, user.email];
    } else if (user.role === 'STAFF') {
      // Staff view assigned appointments
      query = `
        SELECT a.*,
               s.name as service_name, s.category as service_category, s.price as service_price, s.duration_minutes as service_duration,
               st.name as staff_name, st.role as staff_role, st.avatar as staff_avatar, st.phone as staff_phone
        FROM appointments a
        JOIN services s ON a.service_id = s.id
        JOIN staff st ON a.staff_id = st.id
        WHERE a.staff_id = ?
        ORDER BY a.date ASC, a.start_time ASC
      `;
      params = [user.staff_id || ''];
    } else {
      // Admin: can query by specific userId, email, or phone if provided
      const { userId, email, phone } = req.query;
      const conditions = [];
      params = [];
      if (userId) { conditions.push('a.user_id = ?'); params.push(userId); }
      if (email) { conditions.push('LOWER(a.customer_email) = LOWER(?)'); params.push(email); }
      if (phone) { conditions.push('a.customer_phone = ?'); params.push(phone); }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' OR ')}` : '';
      query = `
        SELECT a.*,
               s.name as service_name, s.category as service_category, s.price as service_price, s.duration_minutes as service_duration,
               st.name as staff_name, st.role as staff_role, st.avatar as staff_avatar, st.phone as staff_phone
        FROM appointments a
        JOIN services s ON a.service_id = s.id
        JOIN staff st ON a.staff_id = st.id
        ${whereClause}
        ORDER BY a.created_at DESC, a.date DESC
      `;
    }

    const appointments = db.prepare(query).all(...params);
    const todayStr = new Date().toISOString().slice(0, 10);

    const data = appointments.map(apt => {
      const enriched = enrichServiceNames(apt);
      const isFutureOrToday = enriched.date >= todayStr;
      const canModify = isFutureOrToday && !['CANCELLED', 'COMPLETED', 'NO_SHOW'].includes(enriched.status);
      return {
        ...enriched,
        canModify
      };
    });

    res.json({
      success: true,
      count: data.length,
      data
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Customer Lookup by Booking Reference (Masks sensitive contact details for unauthorized guests)
router.get('/lookup/:query', optionalToken, (req, res) => {
  try {
    const rawQuery = req.params.query.trim().toUpperCase();

    const appointment = db.prepare(`
      SELECT a.*, s.name as service_name, s.category as service_category, s.price as service_price,
             st.name as staff_name, st.role as staff_role, st.avatar as staff_avatar, st.phone as staff_phone
      FROM appointments a
      JOIN services s ON a.service_id = s.id
      JOIN staff st ON a.staff_id = st.id
      WHERE a.booking_reference = ? OR a.customer_phone = ? OR a.id = ?
      ORDER BY a.date DESC
      LIMIT 1
    `).get(rawQuery, req.params.query.trim(), req.params.query.trim());

    if (!appointment) {
      return res.status(404).json({ success: false, error: 'No appointment found with the provided reference code or phone number.' });
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const isFutureOrToday = appointment.date >= todayStr;
    const canModify = isFutureOrToday && !['CANCELLED', 'COMPLETED', 'NO_SHOW'].includes(appointment.status);

    // Authorization check: Is viewer Admin, assigned Staff, or the Owner Customer?
    const isOwner = req.user && (
      req.user.id === appointment.user_id ||
      req.user.email?.toLowerCase() === appointment.customer_email.toLowerCase()
    );
    const isAdmin = req.user?.role === 'ADMIN';
    const isAssignedStaff = req.user?.role === 'STAFF' && req.user.staff_id === appointment.staff_id;

    // Mask sensitive contact details if viewer is an unauthenticated guest
    const finalAppointment = enrichServiceNames(
      (isOwner || isAdmin || isAssignedStaff)
        ? appointment
        : maskCustomerDetails(appointment)
    );

    res.json({
      success: true,
      data: {
        ...finalAppointment,
        canModify
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Customer / Staff Reschedule (Transactional with Pre-Validation to Prevent Booking Corruption)
router.post('/:id/reschedule', optionalToken, (req, res) => {
  try {
    const { date, startTime, staffId, reason, bookingReference, phone } = req.body;
    const appointmentId = req.params.id;

    // 1. Strict Input Validation First
    if (!date || !startTime) {
      return res.status(400).json({ success: false, error: 'New date and startTime are required.' });
    }
    if (!isValidDate(date, false)) {
      return res.status(400).json({ success: false, error: 'New date must be a valid date (YYYY-MM-DD) and cannot be in the past.' });
    }
    if (!isValidTime(startTime)) {
      return res.status(400).json({ success: false, error: 'New startTime must be in valid 24-hour HH:MM format.' });
    }

    const currentApt = db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(appointmentId);
    if (!currentApt) {
      return res.status(404).json({ success: false, error: 'Appointment not found.' });
    }

    // 2. Authorization Check:
    // If logged in as customer, must own the appointment
    if (req.user && req.user.role === 'CUSTOMER') {
      const isOwner = currentApt.user_id === req.user.id || currentApt.customer_email.toLowerCase() === req.user.email.toLowerCase();
      if (!isOwner) {
        return res.status(403).json({ success: false, error: 'You are not authorized to reschedule this appointment.' });
      }
    } else if (!req.user || req.user.role !== 'ADMIN') {
      // Unauthenticated guest must match booking reference or customer phone
      if (bookingReference && currentApt.booking_reference !== bookingReference.trim().toUpperCase()) {
        return res.status(403).json({ success: false, error: 'Invalid booking reference verification.' });
      }
      if (phone && currentApt.customer_phone !== phone.trim()) {
        return res.status(403).json({ success: false, error: 'Invalid phone verification.' });
      }
    }

    if (currentApt.status === 'CANCELLED' || currentApt.status === 'COMPLETED') {
      return res.status(400).json({ success: false, error: `Cannot reschedule an appointment that is ${currentApt.status.toLowerCase()}.` });
    }

    const targetStaffId = staffId || currentApt.staff_id;

    // Verify staff qualification for this service
    const isQualified = db.prepare(`
      SELECT 1 FROM staff_services WHERE staff_id = ? AND service_id = ?
    `).get(targetStaffId, currentApt.service_id);
    if (!isQualified) {
      return res.status(400).json({ success: false, error: 'Selected technician is not qualified for this service.' });
    }

    // 3. Pre-Validate slot availability BEFORE touching any database record
    const preValidation = validateSlotAvailable(targetStaffId, currentApt.service_id, date, startTime, appointmentId);
    if (!preValidation.valid) {
      return res.status(409).json({ success: false, error: preValidation.message });
    }

    // 4. Atomic Transaction: If anything fails, rollback completely keeping original booking unchanged
    const rescheduleTransaction = db.transaction(() => {
      // Re-validate within transaction lock
      const validation = validateSlotAvailable(targetStaffId, currentApt.service_id, date, startTime, appointmentId);
      if (!validation.valid) {
        throw new Error(`CONFLICT: ${validation.message}`);
      }

      db.prepare(`
        UPDATE appointments
        SET staff_id = ?,
            date = ?,
            start_time = ?,
            end_time = ?,
            status = 'CONFIRMED',
            customer_notes = COALESCE(customer_notes || ' ', '') || ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(
        targetStaffId,
        date,
        startTime,
        validation.endTime,
        reason ? `[Rescheduled: ${reason}]` : '[Rescheduled]',
        appointmentId
      );

      return {
        ...currentApt,
        staff_id: targetStaffId,
        date,
        start_time: startTime,
        end_time: validation.endTime
      };
    });

    let updatedApt;
    try {
      updatedApt = rescheduleTransaction();
    } catch (txErr) {
      if (txErr.message.startsWith('CONFLICT:')) {
        return res.status(409).json({ success: false, error: txErr.message.replace('CONFLICT:', '').trim() });
      }
      throw txErr;
    }

    // Send notifications
    const service = db.prepare(`SELECT name FROM services WHERE id = ?`).get(updatedApt.service_id);
    const staff = db.prepare(`SELECT name FROM staff WHERE id = ?`).get(updatedApt.staff_id);

    notificationService.sendRescheduleNotification(
      updatedApt,
      service?.name || 'Service',
      staff?.name || 'Technician',
      currentApt.date,
      currentApt.start_time
    );

    res.json({
      success: true,
      message: 'Appointment successfully rescheduled!',
      data: updatedApt
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Customer / Staff Cancellation (releases slot immediately)
router.post('/:id/cancel', optionalToken, (req, res) => {
  try {
    const { reason, bookingReference, phone } = req.body;
    const appointmentId = req.params.id;

    const apt = db.prepare(`
      SELECT a.*, s.name as service_name
      FROM appointments a
      JOIN services s ON a.service_id = s.id
      WHERE a.id = ?
    `).get(appointmentId);

    if (!apt) {
      return res.status(404).json({ success: false, error: 'Appointment not found.' });
    }

    // Authorization check
    if (req.user && req.user.role === 'CUSTOMER') {
      const isOwner = apt.user_id === req.user.id || apt.customer_email.toLowerCase() === req.user.email.toLowerCase();
      if (!isOwner) {
        return res.status(403).json({ success: false, error: 'You are not authorized to cancel this appointment.' });
      }
    } else if (!req.user || req.user.role !== 'ADMIN') {
      if (bookingReference && apt.booking_reference !== bookingReference.trim().toUpperCase()) {
        return res.status(403).json({ success: false, error: 'Invalid booking reference verification.' });
      }
      if (phone && apt.customer_phone !== phone.trim()) {
        return res.status(403).json({ success: false, error: 'Invalid phone verification.' });
      }
    }

    if (apt.status === 'CANCELLED') {
      return res.status(400).json({ success: false, error: 'Appointment is already cancelled.' });
    }

    db.prepare(`
      UPDATE appointments
      SET status = 'CANCELLED',
          cancellation_reason = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(reason || 'Cancelled by customer', appointmentId);

    // Notify customer
    notificationService.sendCancellationNotification(apt, apt.service_name, reason);

    res.json({
      success: true,
      message: 'Appointment cancelled successfully and slot has been made available to other customers.'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. List Appointments (Restricted to Staff or Admin; Staff only view assigned bookings)
router.get('/', requireStaffOrAdmin, (req, res) => {
  try {
    const { date, startDate, endDate, staffId, status, search } = req.query;

    let query = `
      SELECT a.*,
             s.name as service_name, s.category as service_category,
             st.name as staff_name, st.role as staff_role, st.avatar as staff_avatar
      FROM appointments a
      JOIN services s ON a.service_id = s.id
      JOIN staff st ON a.staff_id = st.id
      WHERE 1=1
    `;
    const params = [];

    // Role-based filtering: STAFF role can ONLY see appointments assigned to their staff_id
    if (req.user.role === 'STAFF') {
      query += ` AND a.staff_id = ?`;
      params.push(req.user.staff_id || '');
    } else if (staffId && staffId !== 'all') {
      query += ` AND a.staff_id = ?`;
      params.push(staffId);
    }

    if (date) {
      query += ` AND a.date = ?`;
      params.push(date);
    }
    if (startDate) {
      query += ` AND a.date >= ?`;
      params.push(startDate);
    }
    if (endDate) {
      query += ` AND a.date <= ?`;
      params.push(endDate);
    }
    if (status && status !== 'all') {
      query += ` AND a.status = ?`;
      params.push(status);
    }
    if (search) {
      const term = `%${search}%`;
      query += ` AND (a.customer_name LIKE ? OR a.customer_phone LIKE ? OR a.customer_email LIKE ? OR a.booking_reference LIKE ? OR a.vehicle_details LIKE ?)`;
      params.push(term, term, term, term, term);
    }

    if (date) {
      query += ` ORDER BY a.start_time ASC`;
    } else {
      query += ` ORDER BY a.created_at DESC, a.date DESC, a.start_time ASC`;
    }

    const appointments = db.prepare(query).all(...params);
    res.json({ success: true, count: appointments.length, data: appointments });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Update Status (Restricted to Staff or Admin; Staff only update their assigned bookings)
router.patch('/:id/status', requireStaffOrAdmin, (req, res) => {
  try {
    const { status, staffNotes } = req.body;
    const validStatuses = ['PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }

    const apt = db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(req.params.id);
    if (!apt) {
      return res.status(404).json({ success: false, error: 'Appointment not found.' });
    }

    // Role check: Staff can only modify appointments assigned to them
    if (req.user.role === 'STAFF' && apt.staff_id !== req.user.staff_id) {
      return res.status(403).json({ success: false, error: 'Access denied: You can only update appointments assigned to you.' });
    }

    db.prepare(`
      UPDATE appointments
      SET status = ?,
          staff_notes = COALESCE(?, staff_notes),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(status, staffNotes || null, req.params.id);

    const updated = db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(req.params.id);
    res.json({ success: true, message: `Status updated to ${status}`, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 9. Manual Dispatch of Reminder (Admin only tool)
router.post('/:id/send-reminder', requireAdmin, (req, res) => {
  try {
    const apt = db.prepare(`
      SELECT a.*, s.name as service_name, st.name as staff_name
      FROM appointments a
      JOIN services s ON a.service_id = s.id
      JOIN staff st ON a.staff_id = st.id
      WHERE a.id = ?
    `).get(req.params.id);

    if (!apt) {
      return res.status(404).json({ success: false, error: 'Appointment not found.' });
    }

    const { reminderType = 'REMINDER_24H' } = req.body;
    const result = notificationService.sendReminder(apt, apt.service_name, apt.staff_name, reminderType);

    res.json({
      success: true,
      message: `Reminder successfully dispatched to ${apt.customer_name} via simulated SMS & Email`,
      notificationIds: result
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
