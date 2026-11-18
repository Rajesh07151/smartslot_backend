import { Router } from 'express';
import db from '../db.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

// GET all staff with capabilities and working days
router.get('/', (req, res) => {
  try {
    const staffMembers = db.prepare(`SELECT * FROM staff WHERE is_active = 1`).all();

    const staffWithDetails = staffMembers.map(st => {
      // Get services
      const services = db.prepare(`
        SELECT s.id, s.name, s.category, s.duration_minutes
        FROM services s
        JOIN staff_services ss ON s.id = ss.service_id
        WHERE ss.staff_id = ?
      `).all(st.id);

      // Get schedules
      const schedules = db.prepare(`
        SELECT day_of_week, start_time, end_time, break_start, break_end, is_working
        FROM staff_schedules
        WHERE staff_id = ?
        ORDER BY day_of_week ASC
      `).all(st.id);

      // Today's status
      const todayDow = new Date().getDay();
      const todaySchedule = schedules.find(s => s.day_of_week === todayDow);

      return {
        ...st,
        services,
        schedules,
        todaySchedule: todaySchedule || { is_working: 0 }
      };
    });

    res.json({ success: true, data: staffWithDetails });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET single staff
router.get('/:id', (req, res) => {
  try {
    const staff = db.prepare(`SELECT * FROM staff WHERE id = ?`).get(req.params.id);
    if (!staff) {
      return res.status(404).json({ success: false, error: 'Staff member not found' });
    }

    const services = db.prepare(`
      SELECT s.id, s.name, s.category, s.duration_minutes, s.price
      FROM services s
      JOIN staff_services ss ON s.id = ss.service_id
      WHERE ss.staff_id = ?
    `).all(req.params.id);

    const schedules = db.prepare(`
      SELECT day_of_week, start_time, end_time, break_start, break_end, is_working
      FROM staff_schedules
      WHERE staff_id = ?
      ORDER BY day_of_week ASC
    `).all(req.params.id);

    res.json({ success: true, data: { ...staff, services, schedules } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT update staff schedule (Admin)
router.put('/:id/schedule', (req, res) => {
  try {
    const { schedules } = req.body; // array of { day_of_week, start_time, end_time, break_start, break_end, is_working }
    if (!Array.isArray(schedules)) {
      return res.status(400).json({ success: false, error: 'Schedules must be an array' });
    }

    const updateStmt = db.prepare(`
      INSERT INTO staff_schedules (staff_id, day_of_week, start_time, end_time, break_start, break_end, is_working)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(staff_id, day_of_week) DO UPDATE SET
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        break_start = excluded.break_start,
        break_end = excluded.break_end,
        is_working = excluded.is_working
    `);

    const transaction = db.transaction((rows) => {
      for (const row of rows) {
        updateStmt.run(
          req.params.id,
          row.day_of_week,
          row.start_time,
          row.end_time,
          row.break_start || null,
          row.break_end || null,
          row.is_working ? 1 : 0
        );
      }
    });

    transaction(schedules);

    res.json({ success: true, message: 'Schedule updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT update staff services / capabilities (Admin)
router.put('/:id/services', (req, res) => {
  try {
    const { serviceIds } = req.body; // array of service ids
    if (!Array.isArray(serviceIds)) {
      return res.status(400).json({ success: false, error: 'serviceIds must be an array' });
    }

    const transaction = db.transaction((ids) => {
      db.prepare(`DELETE FROM staff_services WHERE staff_id = ?`).run(req.params.id);
      const insert = db.prepare(`INSERT INTO staff_services (staff_id, service_id) VALUES (?, ?)`);
      for (const sId of ids) {
        insert.run(req.params.id, sId);
      }
    });

    transaction(serviceIds);

    res.json({ success: true, message: 'Staff capabilities updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST create new technician (Admin)
router.post('/', (req, res) => {
  try {
    const { name, role, email, phone, avatar, bio, serviceIds, schedules } = req.body;

    if (!name || !role || !email) {
      return res.status(400).json({ success: false, error: 'Name, role, and email are required' });
    }

    const existing = db.prepare('SELECT id FROM staff WHERE email = ?').get(email.trim());
    if (existing) {
      return res.status(409).json({ success: false, error: 'A technician with this email address already exists' });
    }

    const staffId = `stf-${uuidv4().slice(0, 8)}`;
    const defaultAvatar = avatar || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=256&q=80';

    const insertTx = db.transaction(() => {
      // 1. Insert staff record
      db.prepare(`
        INSERT INTO staff (id, name, email, phone, role, avatar, bio, is_active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
      `).run(
        staffId,
        name.trim(),
        email.trim(),
        phone ? phone.trim() : null,
        role.trim(),
        defaultAvatar,
        bio ? bio.trim() : 'Certified vehicle service technician'
      );

      // 2. Insert qualified services
      if (Array.isArray(serviceIds) && serviceIds.length > 0) {
        const insertCap = db.prepare('INSERT INTO staff_services (staff_id, service_id) VALUES (?, ?)');
        for (const sId of serviceIds) {
          insertCap.run(staffId, sId);
        }
      }

      // 3. Insert weekly working schedules
      const insertSch = db.prepare(`
        INSERT INTO staff_schedules (staff_id, day_of_week, start_time, end_time, break_start, break_end, is_working)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      if (Array.isArray(schedules) && schedules.length > 0) {
        for (const s of schedules) {
          insertSch.run(
            staffId,
            s.day_of_week,
            s.start_time || '08:30',
            s.end_time || '17:00',
            s.break_start || '12:30',
            s.break_end || '13:30',
            s.is_working ? 1 : 0
          );
        }
      } else {
        // Default Mon-Sat schedule
        for (let d = 0; d <= 6; d++) {
          const isWorking = (d >= 1 && d <= 5) ? 1 : 0;
          insertSch.run(staffId, d, '08:30', '17:00', '12:30', '13:30', isWorking);
        }
      }
    });

    insertTx();

    const created = db.prepare('SELECT * FROM staff WHERE id = ?').get(staffId);
    res.status(201).json({ success: true, message: 'Technician added successfully', data: created });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT update technician profile, capabilities, and schedule (Admin)
router.put('/:id', (req, res) => {
  try {
    const staffId = req.params.id;
    const { name, role, email, phone, avatar, bio, serviceIds, schedules } = req.body;

    const existing = db.prepare('SELECT * FROM staff WHERE id = ?').get(staffId);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Technician not found' });
    }

    const updateTx = db.transaction(() => {
      // 1. Update basic fields
      db.prepare(`
        UPDATE staff
        SET name = COALESCE(?, name),
            role = COALESCE(?, role),
            email = COALESCE(?, email),
            phone = COALESCE(?, phone),
            avatar = COALESCE(?, avatar),
            bio = COALESCE(?, bio)
        WHERE id = ?
      `).run(
        name ? name.trim() : existing.name,
        role ? role.trim() : existing.role,
        email ? email.trim() : existing.email,
        phone !== undefined ? phone : existing.phone,
        avatar || existing.avatar,
        bio !== undefined ? bio : existing.bio,
        staffId
      );

      // 2. Update services if provided
      if (Array.isArray(serviceIds)) {
        db.prepare('DELETE FROM staff_services WHERE staff_id = ?').run(staffId);
        const insertCap = db.prepare('INSERT INTO staff_services (staff_id, service_id) VALUES (?, ?)');
        for (const sId of serviceIds) {
          insertCap.run(staffId, sId);
        }
      }

      // 3. Update schedules if provided
      if (Array.isArray(schedules)) {
        const updateScheduleStmt = db.prepare(`
          INSERT INTO staff_schedules (staff_id, day_of_week, start_time, end_time, break_start, break_end, is_working)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(staff_id, day_of_week) DO UPDATE SET
            start_time = excluded.start_time,
            end_time = excluded.end_time,
            break_start = excluded.break_start,
            break_end = excluded.break_end,
            is_working = excluded.is_working
        `);
        for (const s of schedules) {
          updateScheduleStmt.run(
            staffId,
            s.day_of_week,
            s.start_time,
            s.end_time,
            s.break_start || null,
            s.break_end || null,
            s.is_working ? 1 : 0
          );
        }
      }
    });

    updateTx();

    const updated = db.prepare('SELECT * FROM staff WHERE id = ?').get(staffId);
    res.json({ success: true, message: 'Technician details updated successfully', data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE remove technician (Admin)
router.delete('/:id', (req, res) => {
  try {
    const staffId = req.params.id;
    const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(staffId);
    if (!staff) {
      return res.status(404).json({ success: false, error: 'Technician not found' });
    }

    const activeApts = db.prepare(`
      SELECT COUNT(*) as count FROM appointments
      WHERE staff_id = ? AND status NOT IN ('CANCELLED', 'COMPLETED')
    `).get(staffId).count;

    if (activeApts > 0) {
      return res.status(400).json({
        success: false,
        error: `Cannot delete technician ${staff.name}: they have ${activeApts} active upcoming booking(s). Please reassign or cancel those bookings first.`
      });
    }

    const deleteTx = db.transaction(() => {
      db.prepare('DELETE FROM staff_services WHERE staff_id = ?').run(staffId);
      db.prepare('DELETE FROM staff_schedules WHERE staff_id = ?').run(staffId);
      const totalApts = db.prepare('SELECT COUNT(*) as count FROM appointments WHERE staff_id = ?').get(staffId).count;
      if (totalApts > 0) {
        db.prepare('UPDATE staff SET is_active = 0 WHERE id = ?').run(staffId);
      } else {
        db.prepare('DELETE FROM staff WHERE id = ?').run(staffId);
      }
    });

    deleteTx();
    res.json({ success: true, message: `Technician ${staff.name} deleted successfully` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
