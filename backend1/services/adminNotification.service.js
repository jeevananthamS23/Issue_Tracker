/**
 * CivicVision AI — Admin Notification & Dispatch Service (Phase 4.2C-A)
 *
 * Coordinates persistent in-app admin notifications and Nodemailer email alerts
 * triggered by DBSCAN hotspot detection and escalation events.
 *
 * Guarantees:
 * - Persistent storage in AdminNotification collection with read-state tracking.
 * - Idempotency via stable event deduplication keys (dedupeKey) with unique DB index.
 * - Concurrency protection: handles duplicate-key collisions (E11000) gracefully.
 * - Email dispatch attempt when SMTP is configured; graceful 'unconfigured' fallback.
 * - Strict failure isolation: email delivery failures never revert in-app notifications
 *   or abort the DBSCAN hotspot synchronization run.
 * - Bounded retry mechanism for administrators with max-attempt guards.
 */

const AdminNotification = require("../models/AdminNotification");
const Hotspot = require("../models/Hotspot");
const { isSmtpConfigured, sendHotspotAlertEmail } = require("./email.service");

const MAX_EMAIL_RETRY_ATTEMPTS = 5;

/**
 * Builds a deterministic, event-specific deduplication key for a hotspot alert.
 *
 * @param {string} type - 'hotspot_detected' or 'hotspot_escalated'
 * @param {object} hotspot - Hotspot document/object
 * @returns {string} Stable dedupe key
 */
function buildNotificationDedupeKey(type, hotspot) {
  const hotspotId = String(hotspot._id || hotspot.id);

  if (type === "hotspot_detected") {
    return `hotspot:${hotspotId}:initial`;
  }

  if (type === "hotspot_escalated") {
    // Unique to the specific escalation count threshold
    const count = hotspot.lastAlertIssueCount || hotspot.totalReportCount || 1;
    return `hotspot:${hotspotId}:escalate:${count}`;
  }

  return `hotspot:${hotspotId}:${type}:${Date.now()}`;
}

/**
 * Formats canonical category name into title case for alerts.
 *
 * @param {string} category
 * @returns {string} Formatted name (e.g. 'Water Leak', 'Pothole')
 */
function formatCategory(category) {
  if (!category) return "General Defect";
  return String(category)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Dispatches an admin notification and email alert for a hotspot event.
 *
 * @param {object} params
 * @param {'hotspot_detected'|'hotspot_escalated'} params.type
 * @param {object} params.hotspot - Hotspot document
 * @param {Date} [params.now=new Date()]
 * @returns {Promise<{
 *   success: boolean,
 *   notification: object,
 *   alreadyExisted?: boolean,
 *   emailDispatched?: boolean,
 *   emailError?: string
 * }>}
 */
async function dispatchHotspotNotification(params) {
  const { type, hotspot, now = new Date() } = params;

  if (!hotspot || !hotspot._id) {
    throw new Error("Invalid hotspot provided to dispatchHotspotNotification");
  }

  const categoryName = formatCategory(hotspot.category);
  const departmentName = hotspot.department || "Public Works";
  const distinctDefects = hotspot.distinctDefectCount ?? 1;
  const totalReports = hotspot.totalReportCount ?? hotspot.totalReportsCount ?? 1;

  const dedupeKey = buildNotificationDedupeKey(type, hotspot);

  let title;
  let message;

  if (type === "hotspot_detected") {
    title = `New Hotspot Detected: ${categoryName} (${departmentName})`;
    message = `A high-density cluster of ${distinctDefects} distinct defects (${totalReports} total citizen reports) has been detected in ${departmentName}.`;
  } else if (type === "hotspot_escalated") {
    title = `Hotspot Escalation: ${categoryName} Cluster Growing (${departmentName})`;
    message = `Defect reports in this ${categoryName} cluster increased to ${totalReports} (growth threshold exceeded) in ${departmentName}.`;
  } else {
    title = `Hotspot Alert: ${categoryName}`;
    message = `Hotspot update detected for ${categoryName} in ${departmentName}.`;
  }

  // 1. Idempotent notification record creation
  let notificationDoc;

  try {
    // Check if notification already exists for this event
    notificationDoc = await AdminNotification.findOne({ dedupeKey });

    if (notificationDoc) {
      return {
        success: true,
        notification: notificationDoc,
        alreadyExisted: true
      };
    }

    const smtpReady = isSmtpConfigured();

    notificationDoc = new AdminNotification({
      type,
      hotspotId: hotspot._id,
      title,
      message,
      severity: hotspot.meanSeverity ?? null,
      dedupeKey,
      readAt: null,
      emailStatus: smtpReady ? "pending" : "unconfigured",
      emailLastError: smtpReady ? null : "SMTP is not configured in environment variables"
    });

    await notificationDoc.save();
  } catch (err) {
    // E11000 duplicate key error occurs if two jobs create the same event concurrently
    if (err.code === 11000) {
      notificationDoc = await AdminNotification.findOne({ dedupeKey });
      return {
        success: true,
        notification: notificationDoc,
        alreadyExisted: true
      };
    }
    throw err;
  }

  // 2. Attempt email delivery if status is pending
  if (notificationDoc.emailStatus === "pending") {
    try {
      notificationDoc.emailAttemptCount += 1;
      notificationDoc.emailLastAttemptAt = now;

      const emailResult = await sendHotspotAlertEmail({
        type,
        hotspot,
        title,
        message
      });

      if (emailResult.success) {
        notificationDoc.emailStatus = "sent";
        notificationDoc.emailSentAt = now;
        notificationDoc.emailLastError = null;
      } else if (emailResult.unconfigured) {
        notificationDoc.emailStatus = "unconfigured";
        notificationDoc.emailLastError = emailResult.error || "SMTP unconfigured";
      } else {
        notificationDoc.emailStatus = "failed";
        notificationDoc.emailLastError = emailResult.error || "Email delivery failed";
      }

      await notificationDoc.save();

      return {
        success: true,
        notification: notificationDoc,
        alreadyExisted: false,
        emailDispatched: emailResult.success,
        emailError: emailResult.error
      };
    } catch (emailErr) {
      // Failure isolation: record sanitized error and keep in-app notification intact
      notificationDoc.emailStatus = "failed";
      notificationDoc.emailLastError = emailErr.message || "Email dispatch failed";
      await notificationDoc.save();

      return {
        success: true,
        notification: notificationDoc,
        alreadyExisted: false,
        emailDispatched: false,
        emailError: notificationDoc.emailLastError
      };
    }
  }

  return {
    success: true,
    notification: notificationDoc,
    alreadyExisted: false,
    emailDispatched: false
  };
}

/**
 * Retries sending an email alert for a failed or unconfigured notification.
 * Protected by attempt count limits to prevent infinite tight loops.
 *
 * @param {string} notificationId
 * @returns {Promise<{ success: boolean, message: string, notification: object }>}
 */
async function retryNotificationEmail(notificationId) {
  const notification = await AdminNotification.findById(notificationId);
  if (!notification) {
    const error = new Error("Notification not found");
    error.status = 404;
    throw error;
  }

  if (notification.emailStatus === "sent") {
    return {
      success: false,
      message: "Email alert has already been successfully sent for this notification.",
      notification
    };
  }

  if (notification.emailAttemptCount >= MAX_EMAIL_RETRY_ATTEMPTS) {
    return {
      success: false,
      message: `Maximum email retry attempts (${MAX_EMAIL_RETRY_ATTEMPTS}) reached. Please check SMTP configuration.`,
      notification
    };
  }

  if (!isSmtpConfigured()) {
    return {
      success: false,
      message: "Cannot retry email: SMTP server settings are unconfigured in environment.",
      notification
    };
  }

  const hotspot = await Hotspot.findById(notification.hotspotId).lean();
  if (!hotspot) {
    const error = new Error("Associated hotspot document not found");
    error.status = 404;
    throw error;
  }

  const now = new Date();
  notification.emailAttemptCount += 1;
  notification.emailLastAttemptAt = now;

  try {
    const emailResult = await sendHotspotAlertEmail({
      type: notification.type,
      hotspot,
      title: notification.title,
      message: notification.message
    });

    if (emailResult.success) {
      notification.emailStatus = "sent";
      notification.emailSentAt = now;
      notification.emailLastError = null;
    } else {
      notification.emailStatus = "failed";
      notification.emailLastError = emailResult.error || "Email delivery failed";
    }

    await notification.save();

    return {
      success: emailResult.success,
      message: emailResult.success
        ? "Email alert delivered successfully."
        : `Email delivery failed: ${notification.emailLastError}`,
      notification
    };
  } catch (err) {
    notification.emailStatus = "failed";
    notification.emailLastError = err.message || "Email dispatch failed";
    await notification.save();

    return {
      success: false,
      message: `Email delivery failed: ${notification.emailLastError}`,
      notification
    };
  }
}

module.exports = {
  MAX_EMAIL_RETRY_ATTEMPTS,
  buildNotificationDedupeKey,
  formatCategory,
  dispatchHotspotNotification,
  retryNotificationEmail
};
