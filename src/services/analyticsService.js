import db from '../db.js';
import { timeToMinutes } from './slotAllocationEngine.js';

export const analyticsService = {
  getOverviewMetrics() {
    // Basic appointment stats
    const totalApts = db.prepare(`SELECT COUNT(*) as count FROM appointments`).get().count;
    const completedApts = db.prepare(`SELECT COUNT(*) as count FROM appointments WHERE status = 'COMPLETED'`).get().count;
    const confirmedApts = db.prepare(`SELECT COUNT(*) as count FROM appointments WHERE status = 'CONFIRMED'`).get().count;
    const inProgressApts = db.prepare(`SELECT COUNT(*) as count FROM appointments WHERE status = 'IN_PROGRESS'`).get().count;
    const cancelledApts = db.prepare(`SELECT COUNT(*) as count FROM appointments WHERE status = 'CANCELLED'`).get().count;
    const noShowApts = db.prepare(`SELECT COUNT(*) as count FROM appointments WHERE status = 'NO_SHOW'`).get().count;

    // Financials
    const realizedRevenue = db.prepare(`
      SELECT COALESCE(SUM(total_price), 0) as total
      FROM appointments
      WHERE status IN ('COMPLETED', 'CONFIRMED', 'IN_PROGRESS')
    `).get().total;

    const lostRevenueNoShow = db.prepare(`
      SELECT COALESCE(SUM(total_price), 0) as total
      FROM appointments
      WHERE status = 'NO_SHOW'
    `).get().total;

    const lostRevenueCancelled = db.prepare(`
      SELECT COALESCE(SUM(total_price), 0) as total
      FROM appointments
      WHERE status = 'CANCELLED'
    `).get().total;

    const noShowRate = totalApts > 0 ? ((noShowApts / totalApts) * 100).toFixed(1) : 0;
    const cancellationRate = totalApts > 0 ? ((cancelledApts / totalApts) * 100).toFixed(1) : 0;
    const completionRate = (completedApts + noShowApts) > 0 ? ((completedApts / (completedApts + noShowApts)) * 100).toFixed(1) : 100;

    // Staff Utilization calculation
    // Calculate each staff member's total booked minutes vs scheduled capacity
    const staffList = db.prepare(`SELECT id, name, role, avatar FROM staff WHERE is_active = 1`).all();
    const staffUtilization = staffList.map(st => {
      // Calculate booked minutes (confirmed, in_progress, completed)
      const bookedData = db.prepare(`
        SELECT COALESCE(SUM(duration_minutes), 0) as booked_minutes,
               COUNT(*) as total_jobs,
               COALESCE(SUM(total_price), 0) as revenue
        FROM appointments
        WHERE staff_id = ? AND status IN ('CONFIRMED', 'IN_PROGRESS', 'COMPLETED')
      `).get(st.id);

      // Calculate weekly scheduled capacity (minutes)
      const schedules = db.prepare(`
        SELECT day_of_week, start_time, end_time, break_start, break_end, is_working
        FROM staff_schedules
        WHERE staff_id = ? AND is_working = 1
      `).all(st.id);

      let weeklyScheduledMinutes = 0;
      for (const sch of schedules) {
        let dayMinutes = timeToMinutes(sch.end_time) - timeToMinutes(sch.start_time);
        if (sch.break_start && sch.break_end) {
          dayMinutes -= (timeToMinutes(sch.break_end) - timeToMinutes(sch.break_start));
        }
        weeklyScheduledMinutes += Math.max(0, dayMinutes);
      }

      // Convert to estimated 2-week active capacity or compare with actual booked load
      const effectiveCapacity = weeklyScheduledMinutes * 2 || 2400; // default benchmark
      const bookedMinutes = bookedData.booked_minutes;
      const utilizationRate = Math.min(100, Math.round((bookedMinutes / (effectiveCapacity || 1)) * 100));

      return {
        staffId: st.id,
        name: st.name,
        role: st.role,
        avatar: st.avatar,
        bookedMinutes,
        totalJobs: bookedData.total_jobs,
        revenue: bookedData.revenue,
        weeklyScheduledHours: (weeklyScheduledMinutes / 60).toFixed(1),
        utilizationRate
      };
    });

    // Service Demand Breakdown
    const serviceDemand = db.prepare(`
      SELECT s.id, s.name, s.category, s.price,
             COUNT(a.id) as booking_count,
             COALESCE(SUM(CASE WHEN a.status IN ('COMPLETED', 'CONFIRMED', 'IN_PROGRESS') THEN a.total_price ELSE 0 END), 0) as total_revenue
      FROM services s
      LEFT JOIN appointments a ON s.id = a.service_id
      GROUP BY s.id
      ORDER BY booking_count DESC
    `).all();

    // Hourly Distribution (Peak Hours)
    const hourlyDistribution = db.prepare(`
      SELECT substr(start_time, 1, 2) || ':00' as hour_slot,
             COUNT(*) as count
      FROM appointments
      WHERE status NOT IN ('CANCELLED')
      GROUP BY hour_slot
      ORDER BY hour_slot ASC
    `).all();

    // Day of week breakdown
    const dayOfWeekDistribution = db.prepare(`
      SELECT strftime('%w', date) as dow_index,
             COUNT(*) as count
      FROM appointments
      WHERE status NOT IN ('CANCELLED')
      GROUP BY dow_index
      ORDER BY dow_index ASC
    `).all().map(d => {
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      return {
        day: days[Number(d.dow_index)],
        count: d.count
      };
    });

    return {
      kpis: {
        totalAppointments: totalApts,
        completedAppointments: completedApts,
        confirmedAppointments: confirmedApts,
        inProgressAppointments: inProgressApts,
        cancelledAppointments: cancelledApts,
        noShowAppointments: noShowApts,
        realizedRevenue,
        lostRevenueNoShow,
        lostRevenueCancelled,
        noShowRate: Number(noShowRate),
        cancellationRate: Number(cancellationRate),
        completionRate: Number(completionRate)
      },
      staffUtilization,
      serviceDemand,
      hourlyDistribution,
      dayOfWeekDistribution
    };
  }
};
