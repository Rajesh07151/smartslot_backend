import { Router } from 'express';
import db from '../db.js';
import { v4 as uuidv4 } from 'uuid';
import { validateSlotAvailable, getAvailableSlots, timeToMinutes, minutesToTime, purgeExpiredHolds } from '../services/slotAllocationEngine.js';
import { notificationService } from '../services/notificationService.js';
import { verifyToken } from '../services/authService.js';

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

// 1. Temporary slot hold during customer checkout (prevents race condition)
router.post('/hold', (req, res) => {
  try {
    const { staffId, serviceId, date, startTime, sessionId } = req.body;
    if (!serviceId || !date || !startTime || !sessionId) {
      return res.status(400).json({ success: false, error: 'Missing required hold parameters' });
    }

    purgeExpiredHolds();

    // Determine target staff: if 'any', pick first available
    let targetStaffId = staffId;
    if (!targetStaffId || targetStaffId === 'any') {
      const availability = getAvailableSlots(serviceId, date, 'any');
      const matchingSlot = availability.availableSlots.find(s => s.startTime === startTime);
      if (!matchingSlot || matchingSlot.availableStaff.length === 0) {
        return res.status(409).json({ success: false, error: 'No specialist available for this time slot.' });
      }
      targetStaffId = matchingSlot.availableStaff[0].id;
    }

    const validation = validateSlotAvailable(targetStaffId, serviceId, date, startTime, null, sessionId);
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

// 2. Create Appointment (ACID Transaction with Concurrency Lock Check)
router.post('/', (req, res) => {
  try {
    const {
      serviceId,
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

    if (!serviceId || !date || !startTime || !customerName || !customerEmail || !customerPhone) {
      return res.status(400).json({ success: false, error: 'All customer and appointment details are required' });
    }

    const service = db.prepare(`SELECT * FROM services WHERE id = ?`).get(serviceId);
    if (!service) {
      return res.status(404).json({ success: false, error: 'Service not found' });
    }

    // Run within a database transaction
    const createTransaction = db.transaction(() => {
      purgeExpiredHolds();

      let allocatedStaffId = staffId;

      // Handle "Any Available Specialist" auto-allocation with load balancing
      if (!allocatedStaffId || allocatedStaffId === 'any') {
        const slotData = getAvailableSlots(serviceId, date, 'any', null, sessionId);
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
      const validation = validateSlotAvailable(allocatedStaffId, serviceId, date, startTime, null, sessionId);
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
          service_id, staff_id, date, start_time, end_time, duration_minutes,
          total_price, status, vehicle_details, customer_notes, user_id, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, 'CONFIRMED', ?, ?, ?, datetime('now'), datetime('now')
        )
      `).run(
        appointmentId,
        bookingRef,
        customerName.trim(),
        customerEmail.trim(),
        customerPhone.trim(),
        serviceId,
        allocatedStaffId,
        date,
        startTime,
        validation.endTime,
        validation.duration,
        validation.price,
        vehicleDetails ? vehicleDetails.trim() : null,
        customerNotes ? customerNotes.trim() : null,
        userId || null
      );

      // Release any checkout hold
      if (sessionId) {
        db.prepare(`DELETE FROM slot_holds WHERE session_id = ?`).run(sessionId);
      }

      return {
        id: appointmentId,
        bookingReference: bookingRef,
        serviceId,
        staffId: allocatedStaffId,
        date,
        startTime,
        endTime: validation.endTime,
        durationMinutes: validation.duration,
        totalPrice: validation.price,
        customerName,
        customerEmail,
        customerPhone,
        vehicleDetails,
        customerNotes,
        userId: userId || null
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
      service.name,
      staff?.name || 'Assigned Technician'
    );

    res.status(201).json({
      success: true,
      message: 'Appointment confirmed successfully!',
      data: {
        ...newAppointment,
        serviceName: service.name,
        staffName: staff?.name
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Customer Bookings List & Order Status Tracking (for logged-in customer)
router.get('/my-bookings', (req, res) => {
  try {
    let tokenUser = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      tokenUser = verifyToken(authHeader.slice(7));
    }

    const { userId, email, phone } = req.query;
    const targetUserId = tokenUser?.id || userId || null;
    const targetEmail = tokenUser?.email || email || null;
    const targetPhone = phone || null;

    if (!targetUserId && !targetEmail && !targetPhone) {
      return res.status(400).json({
        success: false,
        error: 'Please sign in or provide user identification (email or phone) to view your bookings.'
      });
    }

    const conditions = [];
    const params = [];

    if (targetUserId) {
      conditions.push('a.user_id = ?');
      params.push(targetUserId);
    }
    if (targetEmail) {
      conditions.push('LOWER(a.customer_email) = LOWER(?)');
      params.push(targetEmail);
    }
    if (targetPhone) {
      conditions.push('a.customer_phone = ?');
      params.push(targetPhone);
    }

    const whereClause = conditions.join(' OR ');

    const query = `
      SELECT a.*,
             s.name as service_name, s.category as service_category, s.price as service_price, s.duration_minutes as service_duration,
             st.name as staff_name, st.role as staff_role, st.avatar as staff_avatar, st.phone as staff_phone
      FROM appointments a
      JOIN services s ON a.service_id = s.id
      JOIN staff st ON a.staff_id = st.id
      WHERE (${whereClause})
      ORDER BY a.created_at DESC, a.date DESC
    `;

    const appointments = db.prepare(query).all(...params);
    const todayStr = new Date().toISOString().slice(0, 10);

    const data = appointments.map(apt => {
      const isFutureOrToday = apt.date >= todayStr;
      const canModify = isFutureOrToday && !['CANCELLED', 'COMPLETED', 'NO_SHOW'].includes(apt.status);
      return {
        ...apt,
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

// 4. Customer Lookup by Booking Reference or Phone
router.get('/lookup/:query', (req, res) => {
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

    // Check if appointment is in the future and can be rescheduled or cancelled
    const todayStr = new Date().toISOString().slice(0, 10);
    const isFutureOrToday = appointment.date >= todayStr;
    const canModify = isFutureOrToday && !['CANCELLED', 'COMPLETED', 'NO_SHOW'].includes(appointment.status);

    res.json({
      success: true,
      data: {
        ...appointment,
        canModify
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Customer / Staff Reschedule
router.post('/:id/reschedule', (req, res) => {
  try {
    const { date, startTime, staffId, reason } = req.body;
    const appointmentId = req.params.id;

    if (!date || !startTime) {
      return res.status(400).json({ success: false, error: 'New date and startTime are required' });
    }

    const currentApt = db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(appointmentId);
    if (!currentApt) {
      return res.status(404).json({ success: false, error: 'Appointment not found' });
    }

    if (currentApt.status === 'CANCELLED' || currentApt.status === 'COMPLETED') {
      return res.status(400).json({ success: false, error: `Cannot reschedule an appointment that is ${currentApt.status.toLowerCase()}` });
    }

    const targetStaffId = staffId || currentApt.staff_id;

    // Transactional reschedule
    const rescheduleTransaction = db.transaction(() => {
      // Validate slot excluding this existing appointment
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

// 5. Customer / Staff Cancellation (releases slot immediately)
router.post('/:id/cancel', (req, res) => {
  try {
    const { reason } = req.body;
    const appointmentId = req.params.id;

    const apt = db.prepare(`
      SELECT a.*, s.name as service_name
      FROM appointments a
      JOIN services s ON a.service_id = s.id
      WHERE a.id = ?
    `).get(appointmentId);

    if (!apt) {
      return res.status(404).json({ success: false, error: 'Appointment not found' });
    }

    if (apt.status === 'CANCELLED') {
      return res.status(400).json({ success: false, error: 'Appointment is already cancelled' });
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

// 6. List Appointments (Admin / Operations Portal)
router.get('/', (req, res) => {
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
    if (staffId && staffId !== 'all') {
      query += ` AND a.staff_id = ?`;
      params.push(staffId);
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

// 7. Update Status (e.g. IN_PROGRESS, COMPLETED, NO_SHOW) + staff notes
router.patch('/:id/status', (req, res) => {
  try {
    const { status, staffNotes } = req.body;
    const validStatuses = ['PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }

    const apt = db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(req.params.id);
    if (!apt) {
      return res.status(404).json({ success: false, error: 'Appointment not found' });
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

// 8. Manual Dispatch of Reminder (Admin tool to reduce No-Shows)
router.post('/:id/send-reminder', (req, res) => {
  try {
    const apt = db.prepare(`
      SELECT a.*, s.name as service_name, st.name as staff_name
      FROM appointments a
      JOIN services s ON a.service_id = s.id
      JOIN staff st ON a.staff_id = st.id
      WHERE a.id = ?
    `).get(req.params.id);

    if (!apt) {
      return res.status(404).json({ success: false, error: 'Appointment not found' });
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
