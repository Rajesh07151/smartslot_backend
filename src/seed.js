import db from './db.js';
import { hashPassword } from './services/authService.js';

export function runSeed() {
  console.log('🌱 Checking SmartSlot database baseline state (Persistent Storage Safe)...');

  // Clean up only expired slot checkout holds
  db.prepare(`DELETE FROM slot_holds WHERE expires_at < ?`).run(Date.now());

  // Clean up only QA/test dummy records without touching genuine customer records
  try {
    const deletedQACount = db.prepare(`
      DELETE FROM appointments
      WHERE (
        LOWER(customer_name) LIKE '%qa test%'
        OR LOWER(customer_name) LIKE '%unit test%'
        OR LOWER(customer_name) = 'test user'
        OR LOWER(customer_name) = 'test'
        OR LOWER(customer_email) IN ('test@test.com', 'test@example.com', 'test@qa.com')
      ) AND customer_email != 'harsha121@gmail.com'
    `).run().changes;
    if (deletedQACount > 0) {
      console.log(`🧹 Cleaned up ${deletedQACount} QA/test booking(s). Genuine customer records preserved.`);
    }
  } catch (cleanErr) {
    console.warn('Note on QA cleanup:', cleanErr.message);
  }

  // 0. Seed Admin & Baseline Accounts (INSERT OR IGNORE to never overwrite active customer updates)
  const users = [
    {
      id: 'usr-admin',
      name: 'Facility Operations Admin',
      email: 'admin@smartslot.service',
      phone: '+91 98200 11111',
      vehicle_details: 'Service Operations Lead',
      password_hash: hashPassword('admin123'),
      role: 'ADMIN',
      staff_id: null
    },
    {
      id: 'usr-customer-1',
      name: 'Rajesh Sharma',
      email: 'rajesh@example.com',
      phone: '+91 98765 43210',
      vehicle_details: '2022 Hyundai Creta SX',
      password_hash: hashPassword('customer123'),
      role: 'CUSTOMER',
      staff_id: null
    },
    {
      id: 'usr-d04170a0',
      name: 'Harsha',
      email: 'harsha121@gmail.com',
      phone: '+918074920177',
      vehicle_details: 'AP31DA7607',
      password_hash: hashPassword('harsha123'),
      role: 'CUSTOMER',
      staff_id: null
    },
    {
      id: 'usr-staff-marcus',
      name: 'Marcus Vance',
      email: 'marcus@smartslot.service',
      phone: '+91 98201 12345',
      vehicle_details: 'Diagnostic Bay Lead',
      password_hash: hashPassword('staff123'),
      role: 'STAFF',
      staff_id: 'stf-marcus'
    },
    {
      id: 'usr-staff-elena',
      name: 'Elena Rostova',
      email: 'elena@smartslot.service',
      phone: '+91 98202 23456',
      vehicle_details: 'Powertrain Bay Lead',
      password_hash: hashPassword('staff123'),
      role: 'STAFF',
      staff_id: 'stf-elena'
    },
    {
      id: 'usr-staff-david',
      name: 'David Chen',
      email: 'david@smartslot.service',
      phone: '+91 98203 34567',
      vehicle_details: 'Chassis & Alignment Bay',
      password_hash: hashPassword('staff123'),
      role: 'STAFF',
      staff_id: 'stf-david'
    },
    {
      id: 'usr-staff-vikram',
      name: 'Vikram Sharma',
      email: 'vikram@smartslot.service',
      phone: '+91 98206 67890',
      vehicle_details: 'Brake & Laser Bay 2',
      password_hash: hashPassword('staff123'),
      role: 'STAFF',
      staff_id: 'stf-vikram'
    },
    {
      id: 'usr-staff-rahul',
      name: 'Rahul Verma',
      email: 'rahul@smartslot.service',
      phone: '+91 98207 78901',
      vehicle_details: 'Suspension & Alignment Bay 3',
      password_hash: hashPassword('staff123'),
      role: 'STAFF',
      staff_id: 'stf-rahul'
    }
  ];

  const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users (id, name, email, phone, vehicle_details, password_hash, role, staff_id)
    VALUES (@id, @name, @email, @phone, @vehicle_details, @password_hash, @role, @staff_id)
  `);
  for (const u of users) {
    insertUser.run(u);
  }

  // 1. Insert Services with Indian Rupee (INR) Pricing
  const services = [
    {
      id: 'srv-diag',
      name: 'Full ECU & Computer Diagnostics',
      category: 'Diagnostics',
      description: 'Comprehensive computer scan for engine, transmission, ABS and safety warning codes with detailed health report.',
      duration_minutes: 60,
      price: 2499.00,
      buffer_minutes: 10,
      icon: 'Cpu'
    },
    {
      id: 'srv-oil',
      name: 'Express Oil & Filter Change',
      category: 'Routine Care',
      description: 'Premium full-synthetic engine oil replacement, OEM filter replacement, and multi-point fluid level top-up.',
      duration_minutes: 45,
      price: 1899.00,
      buffer_minutes: 10,
      icon: 'Droplet'
    },
    {
      id: 'srv-brake',
      name: 'Brake Pad & Rotor Replacement',
      category: 'Brakes & Suspension',
      description: 'Axle brake inspection, precision ceramic brake pad installation, and rotor disc resurfacing or replacement.',
      duration_minutes: 90,
      price: 4999.00,
      buffer_minutes: 15,
      icon: 'Disc'
    },
    {
      id: 'srv-align',
      name: '4-Wheel Laser Alignment & Balancing',
      category: 'Brakes & Suspension',
      description: 'Computerized laser alignment of camber, caster, toe angles and dynamic road-force wheel balancing.',
      duration_minutes: 60,
      price: 1499.00,
      buffer_minutes: 10,
      icon: 'Compass'
    },
    {
      id: 'srv-ac',
      name: 'A/C Recharge & Climate Sanitize',
      category: 'Electrical & Climate',
      description: 'Refrigerant pressure test, vacuum evacuation, refrigerant recharge (R134a/R1234yf) and evaporator disinfection.',
      duration_minutes: 45,
      price: 2199.00,
      buffer_minutes: 10,
      icon: 'Wind'
    },
    {
      id: 'srv-ev',
      name: 'Hybrid & EV High-Voltage Health Check',
      category: 'Diagnostics',
      description: 'High-voltage traction battery cell voltage analysis, thermal management system check, and inverter diagnostics.',
      duration_minutes: 60,
      price: 3499.00,
      buffer_minutes: 15,
      icon: 'Zap'
    },
    {
      id: 'srv-trans',
      name: 'Transmission Flush & Fluid Service',
      category: 'Powertrain',
      description: 'Full automated transmission fluid extraction, pan inspection, pan gasket/filter renewal and fluid replenishment.',
      duration_minutes: 90,
      price: 5499.00,
      buffer_minutes: 15,
      icon: 'Gauge'
    },
    {
      id: 'srv-detail',
      name: 'Signature Ceramic Wash & Detailing',
      category: 'Detailing',
      description: 'Two-bucket hand wash, clay bar paint decontamination, light single-stage gloss polish, and interior vacuum & leather conditioning.',
      duration_minutes: 120,
      price: 3999.00,
      buffer_minutes: 15,
      icon: 'Sparkles'
    },
    {
      id: 'srv-elec',
      name: 'Auto Electrical & Wiring Diagnostics',
      category: 'Electrical & Climate',
      description: 'Tracing parasitic battery drain, alternator & starter load testing, relay replacement, and sensor wire harness repair.',
      duration_minutes: 75,
      price: 2799.00,
      buffer_minutes: 10,
      icon: 'Activity'
    },
    {
      id: 'srv-inspect',
      name: 'Comprehensive 80-Point Pre-Trip Check',
      category: 'Routine Care',
      description: 'Complete bumper-to-bumper inspection including brakes, belts, hoses, suspension, exhaust, lights, and battery health.',
      duration_minutes: 60,
      price: 1299.00,
      buffer_minutes: 10,
      icon: 'CheckCircle2'
    }
  ];

  const insertService = db.prepare(`
    INSERT OR IGNORE INTO services (id, name, category, description, duration_minutes, price, buffer_minutes, icon, is_active)
    VALUES (@id, @name, @category, @description, @duration_minutes, @price, @buffer_minutes, @icon, 1)
  `);
  for (const s of services) {
    insertService.run(s);
  }

  // 2. Insert Staff Members
  const staffMembers = [
    {
      id: 'stf-marcus',
      name: 'Marcus Vance',
      email: 'marcus.vance@smartslot.service',
      phone: '+91 98201 12345',
      role: 'Senior Diagnostic Specialist',
      avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=256&q=80',
      bio: 'Master ASE-certified technician specializing in complex ECU scans, engine sensors, and EV high-voltage systems. 14+ years experience.'
    },
    {
      id: 'stf-elena',
      name: 'Elena Rostova',
      email: 'elena.rostova@smartslot.service',
      phone: '+91 98202 23456',
      role: 'Master Powertrain Technician',
      avatar: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&w=256&q=80',
      bio: 'Specialist in transmission systems, engine mechanical diagnostics, and performance fluid services. 10 years dealership experience.'
    },
    {
      id: 'stf-david',
      name: 'David Chen',
      email: 'david.chen@smartslot.service',
      phone: '+91 98203 34567',
      role: 'Brake & Suspension Specialist',
      avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=256&q=80',
      bio: 'Expert in high-precision laser alignment, multi-link suspension tuning, and high-performance braking systems.'
    },
    {
      id: 'stf-sarah',
      name: 'Sarah Jenkins',
      email: 'sarah.jenkins@smartslot.service',
      phone: '+91 98204 45678',
      role: 'Auto Electrical & Climate Specialist',
      avatar: 'https://images.unsplash.com/photo-1580489944761-15a19d654956?auto=format&fit=crop&w=256&q=80',
      bio: 'Dedicated to climate control, A/C thermodynamic troubleshooting, modern infotainment wiring, and electronic accessories.'
    },
    {
      id: 'stf-carlos',
      name: 'Carlos Mendez',
      email: 'carlos.mendez@smartslot.service',
      phone: '+91 98205 56789',
      role: 'Express Service & Detailing Lead',
      avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=256&q=80',
      bio: 'Fast-track maintenance pro and IDA-certified master detailer specializing in express fluid care and ceramic vehicle preservation.'
    },
    {
      id: 'stf-vikram',
      name: 'Vikram Sharma',
      email: 'vikram.sharma@smartslot.service',
      phone: '+91 98206 67890',
      role: 'Senior Brake & Suspension Technician',
      avatar: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?auto=format&fit=crop&w=256&q=80',
      bio: 'ASE-certified brake and steering specialist with 11+ years tuning race disc rotors, hydraulic calipers, and 3D laser alignment.'
    },
    {
      id: 'stf-rahul',
      name: 'Rahul Verma',
      email: 'rahul.verma@smartslot.service',
      phone: '+91 98207 78901',
      role: 'Chassis & Laser Alignment Specialist',
      avatar: 'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?auto=format&fit=crop&w=256&q=80',
      bio: 'Factory-trained suspension geometry expert specializing in multi-axle laser calibration, road-force balancing, and ABS brake diagnostics.'
    }
  ];

  const insertStaff = db.prepare(`
    INSERT OR IGNORE INTO staff (id, name, email, phone, role, avatar, bio, is_active)
    VALUES (@id, @name, @email, @phone, @role, @avatar, @bio, 1)
  `);
  for (const st of staffMembers) {
    insertStaff.run(st);
  }

  // 3. Map Staff Capabilities (staff_services)
  const staffCapabilities = [
    { staff_id: 'stf-marcus', service_id: 'srv-diag' },
    { staff_id: 'stf-marcus', service_id: 'srv-ev' },
    { staff_id: 'stf-marcus', service_id: 'srv-elec' },
    { staff_id: 'stf-marcus', service_id: 'srv-inspect' },

    { staff_id: 'stf-elena', service_id: 'srv-trans' },
    { staff_id: 'stf-elena', service_id: 'srv-oil' },
    { staff_id: 'stf-elena', service_id: 'srv-diag' },
    { staff_id: 'stf-elena', service_id: 'srv-inspect' },

    { staff_id: 'stf-david', service_id: 'srv-brake' },
    { staff_id: 'stf-david', service_id: 'srv-align' },
    { staff_id: 'stf-david', service_id: 'srv-oil' },
    { staff_id: 'stf-david', service_id: 'srv-inspect' },

    { staff_id: 'stf-sarah', service_id: 'srv-ac' },
    { staff_id: 'stf-sarah', service_id: 'srv-elec' },
    { staff_id: 'stf-sarah', service_id: 'srv-ev' },
    { staff_id: 'stf-sarah', service_id: 'srv-inspect' },

    { staff_id: 'stf-carlos', service_id: 'srv-detail' },
    { staff_id: 'stf-carlos', service_id: 'srv-oil' },
    { staff_id: 'stf-carlos', service_id: 'srv-inspect' },

    { staff_id: 'stf-vikram', service_id: 'srv-brake' },
    { staff_id: 'stf-vikram', service_id: 'srv-align' },
    { staff_id: 'stf-vikram', service_id: 'srv-oil' },
    { staff_id: 'stf-vikram', service_id: 'srv-inspect' },

    { staff_id: 'stf-rahul', service_id: 'srv-brake' },
    { staff_id: 'stf-rahul', service_id: 'srv-align' },
    { staff_id: 'stf-rahul', service_id: 'srv-oil' },
    { staff_id: 'stf-rahul', service_id: 'srv-inspect' }
  ];

  const insertCapability = db.prepare(`
    INSERT OR IGNORE INTO staff_services (staff_id, service_id) VALUES (?, ?)
  `);
  for (const cap of staffCapabilities) {
    insertCapability.run(cap.staff_id, cap.service_id);
  }

  // 4. Staff Schedules
  const insertSchedule = db.prepare(`
    INSERT OR IGNORE INTO staff_schedules (staff_id, day_of_week, start_time, end_time, break_start, break_end, is_working)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (let d = 0; d <= 6; d++) {
    const isWorking = (d >= 1 && d <= 5) ? 1 : 0;
    insertSchedule.run('stf-marcus', d, '08:30', '16:30', '12:00', '13:00', isWorking);
  }

  for (let d = 0; d <= 6; d++) {
    if (d >= 1 && d <= 5) {
      insertSchedule.run('stf-elena', d, '09:00', '17:30', '13:00', '14:00', 1);
    } else if (d === 6) {
      insertSchedule.run('stf-elena', d, '09:00', '13:00', null, null, 1);
    } else {
      insertSchedule.run('stf-elena', d, '09:00', '17:30', null, null, 0);
    }
  }

  for (let d = 0; d <= 6; d++) {
    const isWorking = (d >= 2 && d <= 6) ? 1 : 0;
    insertSchedule.run('stf-david', d, '08:00', '16:30', '12:30', '13:30', isWorking);
    insertSchedule.run('stf-vikram', d, '08:00', '16:30', '12:30', '13:30', isWorking);
    insertSchedule.run('stf-rahul', d, '08:00', '16:30', '12:30', '13:30', isWorking);
  }

  for (let d = 0; d <= 6; d++) {
    const isWorking = (d === 1 || d === 3 || d === 4 || d === 5 || d === 6) ? 1 : 0;
    insertSchedule.run('stf-sarah', d, '09:30', '18:00', '13:30', '14:30', isWorking);
  }

  for (let d = 0; d <= 6; d++) {
    const isWorking = (d >= 1 && d <= 6) ? 1 : 0;
    insertSchedule.run('stf-carlos', d, '08:00', '16:00', '12:00', '13:00', isWorking);
  }

  // 5. Seed Real Customer Appointment (Harsha's live booking) if not already exists
  const existingApt = db.prepare(`SELECT id FROM appointments WHERE id = ?`).get('apt-40173698-abfc-4776-b7b3-4a4e4cedd27a');
  if (!existingApt) {
    db.prepare(`
      INSERT INTO appointments (
        id, booking_reference, user_id, customer_name, customer_email, customer_phone,
        service_id, service_ids, staff_id, date, start_time, end_time, duration_minutes,
        total_price, status, cancellation_reason, vehicle_details, customer_notes,
        staff_notes, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, datetime('now'), datetime('now')
      )
    `).run(
      'apt-40173698-abfc-4776-b7b3-4a4e4cedd27a',
      'SLOT-HQ2S',
      'usr-d04170a0',
      'Harsha',
      'harsha121@gmail.com',
      '+918074920177',
      'srv-align',
      'srv-align',
      'stf-david',
      '2026-11-26',
      '10:30',
      '11:30',
      60,
      1499.00,
      'CONFIRMED',
      null,
      'AP31DA7607',
      '4-Wheel laser calibration',
      null
    );
  }

  const aptCount = db.prepare('SELECT COUNT(*) as count FROM appointments').get().count;
  console.log(`✅ SmartSlot database verified (${aptCount} active customer booking(s) safely persisted).`);
}

// Auto-run if executed directly
if (process.argv[1]?.endsWith('seed.js')) {
  runSeed();
}
