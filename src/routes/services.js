import { Router } from 'express';
import db from '../db.js';

const router = Router();

// GET all active services
router.get('/', (req, res) => {
  try {
    const services = db.prepare(`
      SELECT s.*, 
        (SELECT COUNT(*) FROM staff_services ss WHERE ss.service_id = s.id) as qualified_technicians_count
      FROM services s 
      WHERE is_active = 1 
      ORDER BY category ASC, price ASC
    `).all();
    res.json({ success: true, data: services });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET single service
router.get('/:id', (req, res) => {
  try {
    const service = db.prepare(`SELECT * FROM services WHERE id = ?`).get(req.params.id);
    if (!service) {
      return res.status(404).json({ success: false, error: 'Service not found' });
    }
    const staff = db.prepare(`
      SELECT st.id, st.name, st.role, st.avatar
      FROM staff st
      JOIN staff_services ss ON st.id = ss.staff_id
      WHERE ss.service_id = ? AND st.is_active = 1
    `).all(req.params.id);

    res.json({ success: true, data: { ...service, qualified_staff: staff } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT update service (Admin)
router.put('/:id', (req, res) => {
  try {
    const { name, category, description, duration_minutes, price, buffer_minutes, is_active } = req.body;
    const update = db.prepare(`
      UPDATE services 
      SET name = COALESCE(?, name),
          category = COALESCE(?, category),
          description = COALESCE(?, description),
          duration_minutes = COALESCE(?, duration_minutes),
          price = COALESCE(?, price),
          buffer_minutes = COALESCE(?, buffer_minutes),
          is_active = COALESCE(?, is_active)
      WHERE id = ?
    `);
    const result = update.run(name, category, description, duration_minutes, price, buffer_minutes, is_active, req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'Service not found' });
    }
    const updated = db.prepare(`SELECT * FROM services WHERE id = ?`).get(req.params.id);
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
