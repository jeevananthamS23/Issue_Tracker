/**
 * CivicVision AI — Nodemailer Email Service (Phase 4.2C-A)
 *
 * Provides configurable SMTP email alerts for administrative hotspot notifications.
 *
 * Features:
 * - Configurable SMTP via environment variables (SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS).
 * - Target recipient configured via ADMIN_ALERT_EMAIL.
 * - Admin dashboard link configured via ADMIN_DASHBOARD_URL.
 * - HTML escaping for all user-controlled text to prevent injection.
 * - Injectable/mockable transport for testing without real network or email dispatch.
 * - Credential protection: never logs passwords, auth strings, or connection secrets.
 * - Sanitized, bounded error messages on dispatch failure.
 */

const nodemailer = require("nodemailer");

// Module-level custom transporter for testing injection
let customTransporter = null;

/**
 * Escapes HTML special characters to prevent HTML injection in emails.
 *
 * @param {string|number|any} value
 * @returns {string} Escaped string
 */
function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Reads and validates SMTP configuration from environment variables.
 *
 * @returns {{
 *   isConfigured: boolean,
 *   host?: string,
 *   port?: number,
 *   secure?: boolean,
 *   user?: string,
 *   pass?: string,
 *   toEmail?: string,
 *   dashboardUrl?: string,
 *   missingFields: string[]
 * }}
 */
function getSmtpConfig() {
  const host = process.env.SMTP_HOST ? process.env.SMTP_HOST.trim() : "";
  const user = process.env.SMTP_USER ? process.env.SMTP_USER.trim() : "";
  const pass = process.env.SMTP_PASS ? process.env.SMTP_PASS.trim() : "";
  const toEmail = process.env.ADMIN_ALERT_EMAIL ? process.env.ADMIN_ALERT_EMAIL.trim() : "";
  const portStr = process.env.SMTP_PORT ? process.env.SMTP_PORT.trim() : "587";
  const secureStr = process.env.SMTP_SECURE ? process.env.SMTP_SECURE.trim().toLowerCase() : "false";
  const dashboardUrl = process.env.ADMIN_DASHBOARD_URL
    ? process.env.ADMIN_DASHBOARD_URL.trim()
    : "http://localhost:3000";

  const port = parseInt(portStr, 10) || 587;
  const secure = secureStr === "true" || port === 465;

  const missingFields = [];
  if (!host) missingFields.push("SMTP_HOST");
  if (!user) missingFields.push("SMTP_USER");
  if (!pass) missingFields.push("SMTP_PASS");
  if (!toEmail) missingFields.push("ADMIN_ALERT_EMAIL");

  const isConfigured = missingFields.length === 0;

  return {
    isConfigured,
    host,
    port,
    secure,
    user,
    pass,
    toEmail,
    dashboardUrl,
    missingFields
  };
}

/**
 * Checks whether SMTP email alerting is fully configured in environment.
 *
 * @returns {boolean}
 */
function isSmtpConfigured() {
  // If custom transport was explicitly injected (e.g. In tests), treat as configured
  if (customTransporter) return true;
  return getSmtpConfig().isConfigured;
}

/**
 * Injects a mock transporter for testing.
 *
 * @param {object|null} transporter - Mock transporter with sendMail method, or null to clear.
 */
function setTransporter(transporter) {
  customTransporter = transporter;
}

/**
 * Resets any custom injected transporter back to standard environment config.
 */
function resetTransporter() {
  customTransporter = null;
}

/**
 * Creates or retrieves the active Nodemailer transporter.
 *
 * @returns {object|null}
 */
function getTransporter() {
  if (customTransporter) {
    return customTransporter;
  }

  const config = getSmtpConfig();
  if (!config.isConfigured) {
    return null;
  }

  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.pass
    }
  });
}

/**
 * Sanitizes an error message or object to guarantee no passwords, tokens,
 * or authorization strings can leak into logs or database records.
 *
 * @param {Error|string|any} error
 * @returns {string} Sanitized string max 500 chars
 */
function sanitizeEmailError(error) {
  if (!error) return "Unknown email dispatch error";
  let msg = typeof error === "string" ? error : error.message || String(error);

  // Redact any occurrences of environment secrets if present in message
  const { user, pass } = getSmtpConfig();
  if (pass && pass.length > 2) {
    msg = msg.split(pass).join("[REDACTED_PASSWORD]");
  }
  if (user && user.length > 2) {
    msg = msg.split(user).join("[REDACTED_USER]");
  }

  // Redact potential connection string secrets
  msg = msg.replace(/:\/\/[^:]+:[^@]+@/g, "://[REDACTED_AUTH]@");
  msg = msg.replace(/bearer\s+[a-zA-Z0-9._-]+/gi, "Bearer [REDACTED_TOKEN]");

  // Strip stack trace lines
  msg = msg.split("\n")[0].trim();

  // Bound length to 500 characters
  return msg.substring(0, 500);
}

/**
 * Generates structured HTML and plain-text templates for a hotspot alert email.
 *
 * @param {object} params
 * @param {string} params.type - 'hotspot_detected' or 'hotspot_escalated'
 * @param {object} params.hotspot - Hotspot document/object
 * @param {string} params.title - Alert title
 * @param {string} params.message - Alert summary message
 * @param {string} params.dashboardUrl - Base dashboard URL
 * @returns {{ html: string, text: string, subject: string }}
 */
function generateHotspotEmailContent(params) {
  const { type, hotspot = {}, title, message, dashboardUrl } = params;

  const isEscalation = type === "hotspot_escalated";
  const alertHeadline = isEscalation ? "Hotspot Escalation Detected" : "New Civic Defect Hotspot Detected";
  const bannerColor = isEscalation ? "#ea580c" : "#e11d48";

  const category = hotspot.category || "unknown";
  const categoryFormatted = category.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  const department = hotspot.department || "Public Works";

  const coords =
    hotspot.centroid && Array.isArray(hotspot.centroid.coordinates)
      ? hotspot.centroid.coordinates
      : [0, 0];
  const coordsFormatted = `[Lng: ${coords[0]?.toFixed(5)}, Lat: ${coords[1]?.toFixed(5)}]`;

  const distinctDefects = hotspot.distinctDefectCount ?? 1;
  const totalReports = hotspot.totalReportCount ?? hotspot.totalReportsCount ?? 1;
  const totalVotes = hotspot.totalVotes ?? 0;
  const severityVal =
    hotspot.meanSeverity !== null && hotspot.meanSeverity !== undefined
      ? `${Number(hotspot.meanSeverity).toFixed(1)}/10`
      : "Not calculated (heuristic)";

  const hotspotLink = `${dashboardUrl.replace(/\/$/, "")}/#hotspots`;

  const subject = title
    ? `[CivicVision AI Alert] ${title}`
    : `[CivicVision AI Alert] ${alertHeadline}: ${categoryFormatted} (${department})`;

  // Plain-text representation
  const text = `
CIVICVISION AI — MUNICIPAL DEFECT ALERT
================================================================================
ALERT TYPE:  ${alertHeadline.toUpperCase()}
CATEGORY:    ${categoryFormatted}
DEPARTMENT:  ${department}
LOCATION:    ${coordsFormatted}
SEVERITY:    ${severityVal}
DEFECTS:     ${distinctDefects} distinct defects
REPORTS:     ${totalReports} total citizen reports (Votes: ${totalVotes})
================================================================================

SUMMARY:
${message}

Access the admin dashboard to review constituent issues and dispatch municipal crews:
${hotspotLink}

--
CivicVision AI Automated Municipal Early-Warning System
Notice: Automated notification. Please log in to verify before field dispatch.
`.trim();

  // Professional HTML representation with strict HTML escaping
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0b1120; color: #f1f5f9; margin: 0; padding: 20px; }
    .email-container { max-width: 600px; margin: 0 auto; background: #111827; border: 1px solid #1e293b; border-radius: 8px; overflow: hidden; }
    .email-banner { background: ${bannerColor}; color: #ffffff; padding: 18px 24px; }
    .email-banner h1 { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; }
    .email-body { padding: 24px; color: #cbd5e1; font-size: 14px; line-height: 1.6; }
    .alert-summary { background: #1e293b; border-left: 4px solid ${bannerColor}; padding: 14px 16px; border-radius: 4px; margin-bottom: 20px; color: #f8fafc; font-weight: 500; }
    .metrics-table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    .metrics-table td { padding: 10px 12px; border-bottom: 1px solid #1e293b; font-size: 13px; }
    .metrics-table td.label { color: #94a3b8; font-weight: 600; width: 38%; }
    .metrics-table td.value { color: #f1f5f9; font-weight: 500; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; background: #334155; color: #f8fafc; }
    .btn-action { display: inline-block; background: #2563eb; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600; font-size: 14px; text-align: center; }
    .btn-action:hover { background: #1d4ed8; }
    .email-footer { background: #0b1120; padding: 16px 24px; font-size: 11px; color: #64748b; text-align: center; border-top: 1px solid #1e293b; }
  </style>
</head>
<body>
  <div class="email-container">
    <div class="email-banner">
      <h1>${escapeHtml(alertHeadline)}</h1>
    </div>
    <div class="email-body">
      <div class="alert-summary">
        ${escapeHtml(message)}
      </div>

      <table class="metrics-table">
        <tr>
          <td class="label">Defect Category</td>
          <td class="value"><span class="badge">${escapeHtml(categoryFormatted)}</span></td>
        </tr>
        <tr>
          <td class="label">Assigned Department</td>
          <td class="value"><strong>${escapeHtml(department)}</strong></td>
        </tr>
        <tr>
          <td class="label">Spatial Centroid</td>
          <td class="value"><code>${escapeHtml(coordsFormatted)}</code></td>
        </tr>
        <tr>
          <td class="label">Distinct Defects</td>
          <td class="value">${escapeHtml(distinctDefects)} verified defects</td>
        </tr>
        <tr>
          <td class="label">Report Volume</td>
          <td class="value">${escapeHtml(totalReports)} reports (${escapeHtml(totalVotes)} community votes)</td>
        </tr>
        <tr>
          <td class="label">Estimated Severity</td>
          <td class="value">${escapeHtml(severityVal)}</td>
        </tr>
      </table>

      <div style="text-align: center; margin: 30px 0 10px;">
        <a href="${escapeHtml(hotspotLink)}" class="btn-action" target="_blank" rel="noopener noreferrer">
          Inspect Hotspot in Admin Dashboard &rarr;
        </a>
      </div>
    </div>
    <div class="email-footer">
      CivicVision AI Municipal Early-Warning System &bull; Automated Hotspot Notification<br>
      Please log in to the secure admin portal to verify before deploying maintenance crews.
    </div>
  </div>
</body>
</html>
`.trim();

  return { html, text, subject };
}

/**
 * Dispatches an email alert for a hotspot event using Nodemailer.
 *
 * @param {object} params
 * @param {string} params.type - 'hotspot_detected' or 'hotspot_escalated'
 * @param {object} params.hotspot - Hotspot document/object
 * @param {string} params.title - Notification title
 * @param {string} params.message - Notification message
 * @returns {Promise<{
 *   success: boolean,
 *   unconfigured?: boolean,
 *   messageId?: string,
 *   accepted?: string[],
 *   error?: string
 * }>}
 */
async function sendHotspotAlertEmail(params) {
  const config = getSmtpConfig();
  const transporter = getTransporter();

  // If SMTP is not configured and no custom test transport is active
  if (!transporter) {
    return {
      success: false,
      unconfigured: true,
      error: `SMTP email delivery is unconfigured. Missing: ${config.missingFields.join(", ")}.`
    };
  }

  const { html, text, subject } = generateHotspotEmailContent({
    ...params,
    dashboardUrl: config.dashboardUrl
  });

  const recipient = config.toEmail || "admin@civicvision.gov";
  const fromAddress = config.user
    ? `"CivicVision AI Alerts" <${config.user}>`
    : '"CivicVision AI Alerts" <no-reply@civicvision.gov>';

  try {
    const info = await transporter.sendMail({
      from: fromAddress,
      to: recipient,
      subject,
      text,
      html
    });

    return {
      success: true,
      messageId: info.messageId,
      accepted: info.accepted
    };
  } catch (err) {
    const sanitized = sanitizeEmailError(err);
    return {
      success: false,
      error: sanitized
    };
  }
}

module.exports = {
  escapeHtml,
  getSmtpConfig,
  isSmtpConfigured,
  setTransporter,
  resetTransporter,
  getTransporter,
  sanitizeEmailError,
  generateHotspotEmailContent,
  sendHotspotAlertEmail
};
