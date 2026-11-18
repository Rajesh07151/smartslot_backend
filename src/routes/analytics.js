import { Router } from 'express';
import { analyticsService } from '../services/analyticsService.js';

const router = Router();

// GET all overview metrics & staff utilization
router.get('/', (req, res) => {
  try {
    const data = analyticsService.getOverviewMetrics();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
