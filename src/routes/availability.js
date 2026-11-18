import { Router } from 'express';
import { getAvailableSlots } from '../services/slotAllocationEngine.js';

const router = Router();

// GET available slots for service & date
router.get('/', (req, res) => {
  try {
    const { serviceId, date, staffId, excludeAppointmentId, sessionId } = req.query;

    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId query parameter is required' });
    }
    if (!date) {
      return res.status(400).json({ success: false, error: 'date query parameter is required (YYYY-MM-DD)' });
    }

    const result = getAvailableSlots(serviceId, date, staffId, excludeAppointmentId, sessionId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
