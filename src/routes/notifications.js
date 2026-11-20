import { Router } from 'express';
import db from '../db.js';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';

const router = Router();

// GET notifications log (most recent first) - Restricted strictly to Administrator
router.get('/', authenticateToken, requireAdmin, (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const notifications = db.prepare(`
      SELECT * FROM notifications 
      ORDER BY sent_at DESC 
      LIMIT ?
    `).all(limit);

    res.json({ success: true, count: notifications.length, data: notifications });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
