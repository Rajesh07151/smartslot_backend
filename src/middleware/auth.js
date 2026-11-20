import db from '../db.js';
import { verifyToken } from '../services/authService.js';

/**
 * Extracts and verifies Bearer token, attaching req.user
 */
export function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required. Please sign in.'
    });
  }

  const token = authHeader.slice(7).trim();
  const decoded = verifyToken(token);
  if (!decoded || !decoded.id) {
    return res.status(401).json({
      success: false,
      error: 'Invalid or expired session token. Please sign in again.'
    });
  }

  const user = db.prepare(`SELECT id, name, email, phone, vehicle_details, role, staff_id FROM users WHERE id = ?`).get(decoded.id);
  if (!user) {
    return res.status(401).json({
      success: false,
      error: 'User account not found or deactivated.'
    });
  }

  req.user = user;
  next();
}

/**
 * Attaches req.user if valid token present, otherwise continues as unauthenticated guest
 */
export function optionalToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  const token = authHeader.slice(7).trim();
  const decoded = verifyToken(token);
  if (decoded && decoded.id) {
    const user = db.prepare(`SELECT id, name, email, phone, vehicle_details, role, staff_id FROM users WHERE id = ?`).get(decoded.id);
    req.user = user || null;
  } else {
    req.user = null;
  }
  next();
}

/**
 * Restricts access to users with ADMIN role
 */
export function requireAdmin(req, res, next) {
  authenticateToken(req, res, () => {
    if (req.user?.role !== 'ADMIN') {
      return res.status(403).json({
        success: false,
        error: 'Access denied: Administrator permissions required.'
      });
    }
    next();
  });
}

/**
 * Restricts access to users with STAFF or ADMIN role
 */
export function requireStaffOrAdmin(req, res, next) {
  authenticateToken(req, res, () => {
    if (!['ADMIN', 'STAFF'].includes(req.user?.role)) {
      return res.status(403).json({
        success: false,
        error: 'Access denied: Staff or Administrator permissions required.'
      });
    }
    next();
  });
}
