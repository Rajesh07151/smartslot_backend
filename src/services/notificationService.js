import db from '../db.js';
import { v4 as uuidv4 } from 'uuid';

export const notificationService = {
  /**
   * Dispatch a notification (Email + SMS simulated)
   */
  dispatch({ appointmentId, bookingReference, recipientName, recipientEmail, recipientPhone, type, subject, message }) {
    const emailNotifId = `notif-em-${uuidv4().slice(0, 8)}`;
    const smsNotifId = `notif-sms-${uuidv4().slice(0, 8)}`;

    const insertNotif = db.prepare(`
      INSERT INTO notifications (
        id, appointment_id, booking_reference, recipient_name, recipient_email, recipient_phone,
        type, channel, subject, message, status, sent_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DELIVERED', datetime('now'))
    `);

    // Log Email
    insertNotif.run(
      emailNotifId,
      appointmentId,
      bookingReference,
      recipientName,
      recipientEmail,
      recipientPhone,
      type,
      'EMAIL',
      subject,
      message
    );

    // Log SMS if phone is provided
    if (recipientPhone) {
      const smsMessage = `[SmartSlot] ${subject}: ${message.slice(0, 130)}... Manage: smartslot.app/manage/${bookingReference}`;
      insertNotif.run(
        smsNotifId,
        appointmentId,
        bookingReference,
        recipientName,
        recipientEmail,
        recipientPhone,
        type,
        'SMS',
        subject,
        smsMessage
      );
    }

    return { emailId: emailNotifId, smsId: smsNotifId };
  },

  /**
   * Helper: Send booking confirmation
   */
  sendBookingConfirmation(appointment, serviceName, staffName) {
    const subject = `Confirmed: SmartSlot Appointment #${appointment.booking_reference}`;
    const message = `Dear ${appointment.customer_name}, your appointment for "${serviceName}" has been successfully booked with specialist ${staffName} on ${appointment.date} at ${appointment.start_time} - ${appointment.end_time}. Vehicle: ${appointment.vehicle_details || 'Standard'}. Need to reschedule or cancel? You can manage your appointment online anytime using Reference Code: ${appointment.booking_reference}.`;

    return this.dispatch({
      appointmentId: appointment.id,
      bookingReference: appointment.booking_reference,
      recipientName: appointment.customer_name,
      recipientEmail: appointment.customer_email,
      recipientPhone: appointment.customer_phone,
      type: 'CONFIRMATION',
      subject,
      message
    });
  },

  /**
   * Helper: Send reschedule notification
   */
  sendRescheduleNotification(appointment, serviceName, staffName, oldDate, oldTime) {
    const subject = `Rescheduled: Appointment #${appointment.booking_reference}`;
    const message = `Dear ${appointment.customer_name}, your appointment for "${serviceName}" has been updated. New Schedule: ${appointment.date} at ${appointment.start_time} with ${staffName} (previously ${oldDate} at ${oldTime}).`;

    return this.dispatch({
      appointmentId: appointment.id,
      bookingReference: appointment.booking_reference,
      recipientName: appointment.customer_name,
      recipientEmail: appointment.customer_email,
      recipientPhone: appointment.customer_phone,
      type: 'RESCHEDULED',
      subject,
      message
    });
  },

  /**
   * Helper: Send cancellation notification
   */
  sendCancellationNotification(appointment, serviceName, reason) {
    const subject = `Cancelled: Appointment #${appointment.booking_reference}`;
    const message = `Hello ${appointment.customer_name}, your booking #${appointment.booking_reference} for "${serviceName}" on ${appointment.date} at ${appointment.start_time} has been cancelled.${reason ? ` Reason: ${reason}.` : ''} Your appointment slot has been released.`;

    return this.dispatch({
      appointmentId: appointment.id,
      bookingReference: appointment.booking_reference,
      recipientName: appointment.customer_name,
      recipientEmail: appointment.customer_email,
      recipientPhone: appointment.customer_phone,
      type: 'CANCELLED',
      subject,
      message
    });
  },

  /**
   * Helper: Send automated reminder
   */
  sendReminder(appointment, serviceName, staffName, reminderType = 'REMINDER_24H') {
    const timing = reminderType === 'REMINDER_2H' ? 'in 2 hours' : 'tomorrow';
    const subject = `Reminder: Service Appointment ${timing}`;
    const message = `Reminder: ${appointment.customer_name}, your "${serviceName}" service is scheduled for ${timing} at ${appointment.start_time} with specialist ${staffName}. Please arrive 5 minutes early.`;

    return this.dispatch({
      appointmentId: appointment.id,
      bookingReference: appointment.booking_reference,
      recipientName: appointment.customer_name,
      recipientEmail: appointment.customer_email,
      recipientPhone: appointment.customer_phone,
      type: reminderType,
      subject,
      message
    });
  }
};
