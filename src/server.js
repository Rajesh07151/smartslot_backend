import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import authRouter from './routes/auth.js';
import servicesRouter from './routes/services.js';
import staffRouter from './routes/staff.js';
import availabilityRouter from './routes/availability.js';
import appointmentsRouter from './routes/appointments.js';
import analyticsRouter from './routes/analytics.js';
import notificationsRouter from './routes/notifications.js';
import db from './db.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Request logger for development & debugging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (process.env.NODE_ENV !== 'test') {
      console.log(`[${new Date().toISOString().slice(11, 19)}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`);
    }
  });
  next();
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    system: 'SmartSlot API',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// API Routes
app.use('/api/auth', authRouter);
app.use('/api/services', servicesRouter);
app.use('/api/staff', staffRouter);
app.use('/api/availability', availabilityRouter);
app.use('/api/appointments', appointmentsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/notifications', notificationsRouter);

// Serve Frontend Static Files in Production (if built)
const frontendDist = path.resolve(__dirname, '../../frontend/dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
      return res.sendFile(path.resolve(frontendDist, 'index.html'));
    }
    next();
  });
}

// 404 Handler for undefined API routes
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: 'API endpoint not found' });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err);
  res.status(500).json({
    success: false,
    error: err.message || 'Internal server error'
  });
});

// Start listening if run directly
if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(PORT, () => {
    console.log(`🚀 SmartSlot Full-Stack Server running on http://localhost:${PORT}`);
    console.log(`📡 Health Check: http://localhost:${PORT}/api/health`);
    if (fs.existsSync(frontendDist)) {
      console.log(`🌐 Frontend UI live at: http://localhost:${PORT}`);
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n🛑 Gracefully shutting down SmartSlot server...');
    server.close(() => {
      try {
        db.close();
      } catch (e) {
        // ignore
      }
      console.log('Database connection closed.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export default app;
