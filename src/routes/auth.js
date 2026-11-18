import { Router } from 'express';
import db from '../db.js';
import { v4 as uuidv4 } from 'uuid';
import { hashPassword, verifyPassword, generateToken, verifyToken } from '../services/authService.js';

const router = Router();

// 1. Customer Registration
router.post('/register', (req, res) => {
  try {
    const { name, email, phone, vehicle_details, password } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Full name is required' });
    }
    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, error: 'A valid email address is required' });
    }
    if (!phone || phone.trim().length < 8) {
      return res.status(400).json({ success: false, error: 'A valid mobile phone number is required' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters long' });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Check if user already exists
    const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(cleanEmail);
    if (existing) {
      return res.status(409).json({ success: false, error: 'An account with this email address already exists. Please sign in.' });
    }

    const userId = `usr-${uuidv4().slice(0, 8)}`;
    const passwordHash = hashPassword(password);

    db.prepare(`
      INSERT INTO users (id, name, email, phone, vehicle_details, password_hash, role)
      VALUES (?, ?, ?, ?, ?, ?, 'CUSTOMER')
    `).run(
      userId,
      name.trim(),
      cleanEmail,
      phone.trim(),
      vehicle_details ? vehicle_details.trim() : null,
      passwordHash
    );

    const user = {
      id: userId,
      name: name.trim(),
      email: cleanEmail,
      phone: phone.trim(),
      vehicle_details: vehicle_details ? vehicle_details.trim() : null,
      role: 'CUSTOMER'
    };

    const token = generateToken(user);

    res.status(201).json({
      success: true,
      message: 'Account registered successfully!',
      data: { user, token }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Standard Login (Customer or Admin)
router.post('/login', (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(cleanEmail);

    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const isValid = verifyPassword(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const safeUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      vehicle_details: user.vehicle_details,
      role: user.role
    };

    const token = generateToken(safeUser);

    res.json({
      success: true,
      message: 'Logged in successfully',
      data: { user: safeUser, token }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Admin-Specific Login (Verifies ADMIN role)
router.post('/admin-login', (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Admin email and password are required' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(cleanEmail);

    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid administrator credentials' });
    }

    const isValid = verifyPassword(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ success: false, error: 'Invalid administrator credentials' });
    }

    if (user.role !== 'ADMIN') {
      return res.status(403).json({ success: false, error: 'Access denied: Administrator permissions required.' });
    }

    const safeUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role
    };

    const token = generateToken(safeUser);

    res.json({
      success: true,
      message: 'Admin access granted',
      data: { user: safeUser, token }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Current User Session Check
router.get('/me', (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = verifyToken(token);

    if (!decoded) {
      return res.status(401).json({ success: false, error: 'Invalid or expired session token' });
    }

    const user = db.prepare(`SELECT id, name, email, phone, vehicle_details, role FROM users WHERE id = ?`).get(decoded.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.json({
      success: true,
      data: { user }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
