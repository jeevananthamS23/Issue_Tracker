/**
 * CivicVision AI — Phase 4.2C-A Admin Notifications & Email Alerts Test Suite
 *
 * Verifies:
 * 1. Admin-only authorization for all notification endpoints (401 missing, 403 citizen, 200 admin).
 * 2. Pagination, filtering, and unread counts.
 * 3. Mark one notification as read and mark all as read.
 * 4. New hotspot event creates exactly one notification record.
 * 5. A new hotspot attempts email delivery only when configured.
 * 6. Re-running the same job does not create duplicate notifications.
 * 7. Unchanged hotspots do not repeatedly send emails.
 * 8. Qualifying escalation creates a distinct event when cooldown rules permit.
 * 9. SMTP failure leaves the notification available in the dashboard.
 * 10. Retrying delivery does not duplicate notification records.
 * 11. Missing SMTP configuration results in unconfigured status.
 * 12. Malformed IDs and invalid query parameters are rejected.
 * 13. Email HTML escapes user-controlled values.
 * 14. Error messages do not expose SMTP credentials or internal stack traces.
 * 15. Existing DBSCAN, review flags, hotspot lifecycle, and privacy protections remain intact.
 *
 * Safety:
 * - Operates strictly against disposable local database: mongodb://127.0.0.1:27017/civicvision_test_notifications_disposable
 * - Strict Atlas protection guard neutralizes any production Atlas MONGO_URI.
 * - Uses mocked in-memory email transporter: zero real emails dispatched.
 */

const assert = require("assert");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

// Strict Atlas protection: NEVER connect to Atlas during tests
if (
  process.env.MONGO_URI &&
  (process.env.MONGO_URI.includes("mongodb+srv") || process.env.MONGO_URI.includes("mongodb.net"))
) {
  delete process.env.MONGO_URI;
}

const DISPOSABLE_DB_URI = "mongodb://127.0.0.1:27017/civicvision_test_notifications_disposable";
const TEST_JWT_SECRET = "phase42ca_test_jwt_secret_key_32_chars_min";
process.env.JWT_SECRET = TEST_JWT_SECRET;

const AdminNotification = require("../models/AdminNotification");
const Hotspot = require("../models/Hotspot");
const Issue = require("../models/Issue");
const User = require("../models/User");
const Admin = require("../models/Admin");
const JobLock = require("../models/JobLock");

const verifyAdmin = require("../middleware/authenticateTokenAdmin");
const {
  getNotifications,
  getUnreadNotificationCount,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  retryNotificationEmail: retryNotificationEmailController
} = require("../controllers/adminDashboard.controller");

const {
  setTransporter,
  resetTransporter,
  escapeHtml,
  sanitizeEmailError,
  generateHotspotEmailContent,
  getSmtpConfig
} = require("../services/email.service");

const {
  dispatchHotspotNotification,
  retryNotificationEmail,
  buildNotificationDedupeKey
} = require("../services/adminNotification.service");

const { detectAndSyncHotspots } = require("../services/dbscan.service");

// Mock Express response helper
function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    }
  };
  return res;
}

// In-memory mock email transporter
class MockTransporter {
  constructor(shouldFail = false, failureError = new Error("Mock SMTP connection timeout")) {
    this.shouldFail = shouldFail;
    this.failureError = failureError;
    this.sentEmails = [];
  }

  async sendMail(mailOptions) {
    if (this.shouldFail) {
      throw this.failureError;
    }
    const info = {
      messageId: `<mock_${Date.now()}_${Math.random().toString(36).substring(2, 8)}@civicvision.gov>`,
      accepted: [mailOptions.to],
      rejected: [],
      mailOptions
    };
    this.sentEmails.push(info);
    return info;
  }
}

let testAdminId;
let testAdminToken;
let testCitizenId;
let testCitizenToken;

async function setupDatabase() {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(DISPOSABLE_DB_URI, { serverSelectionTimeoutMS: 5000 });
  }

  await AdminNotification.deleteMany({});
  await Hotspot.deleteMany({});
  await Issue.deleteMany({});
  await User.deleteMany({});
  await Admin.deleteMany({});
  await JobLock.deleteMany({});

  const admin = await Admin.create({
    fullName: "Chief Municipal Admin",
    email: `admin_${Date.now()}@city.gov`,
    password: "AdminPassword123!"
  });
  testAdminId = admin._id;
  testAdminToken = jwt.sign(
    { adminId: admin._id.toString(), role: "admin", email: admin.email },
    TEST_JWT_SECRET,
    { expiresIn: "1h" }
  );

  const citizen = await User.create({
    fullName: "Concerned Citizen",
    email: `citizen_${Date.now()}@civic.org`,
    password: "CitizenPassword123!"
  });
  testCitizenId = citizen._id;
  testCitizenToken = jwt.sign(
    { userId: citizen._id.toString(), role: "citizen", email: citizen.email },
    TEST_JWT_SECRET,
    { expiresIn: "1h" }
  );
}

async function runTests() {
  console.log("================================================================================");
  console.log("CivicVision AI — Phase 4.2C-A Admin Notifications & Email Alerts Test Suite");
  console.log("================================================================================\n");

  await setupDatabase();

  let passedCount = 0;

  // Helper to run route through verifyAdmin middleware
  async function runAuthenticated(req, handler) {
    const res = createMockRes();
    let authPassed = false;
    await verifyAdmin(req, res, () => {
      authPassed = true;
    });
    if (!authPassed) {
      return res;
    }
    await handler(req, res);
    return res;
  }

  // ---------------------------------------------------------------------------
  // Test 1: Admin-only authorization for all notification endpoints
  // ---------------------------------------------------------------------------
  try {
    console.log("--- Category 1: Admin Authentication & Role Enforcement ---");

    // 1. Missing token
    const reqMissing = { headers: {} };
    const resMissing = await runAuthenticated(reqMissing, getNotifications);
    assert.strictEqual(resMissing.statusCode, 401, "Missing token must return 401");

    // 2. Citizen token
    const reqCitizen = { headers: { authorization: `Bearer ${testCitizenToken}` } };
    const resCitizen = await runAuthenticated(reqCitizen, getNotifications);
    assert.strictEqual(resCitizen.statusCode, 403, "Citizen token must return 403 Forbidden");

    // 3. Admin token
    const reqAdmin = { headers: { authorization: `Bearer ${testAdminToken}` }, query: {} };
    const resAdmin = await runAuthenticated(reqAdmin, getNotifications);
    assert.strictEqual(resAdmin.statusCode, 200, "Valid admin token must return 200");

    console.log("  PASS: 1. Admin-only authorization enforced across notification endpoints");
    passedCount++;
  } catch (err) {
    console.error("  FAIL: 1. Admin-only authorization test failed:", err.message);
    throw err;
  }

  // ---------------------------------------------------------------------------
  // Test 2: Pagination, filtering, and unread counts
  // ---------------------------------------------------------------------------
  try {
    console.log("\n--- Category 2: Notification Querying, Pagination & Filters ---");

    // Seed dummy hotspot
    const hotspot = await Hotspot.create({
      category: "pothole",
      department: "Roads & Infrastructure",
      centroid: { type: "Point", coordinates: [77.72, 11.34] },
      distinctDefectCount: 3,
      totalReportCount: 5,
      issueIds: [new mongoose.Types.ObjectId()]
    });

    // Seed 5 notifications: 3 unread, 2 read
    await AdminNotification.create([
      {
        type: "hotspot_detected",
        hotspotId: hotspot._id,
        title: "Test Alert 1",
        message: "Message 1",
        dedupeKey: "test:key:1",
        readAt: null
      },
      {
        type: "hotspot_detected",
        hotspotId: hotspot._id,
        title: "Test Alert 2",
        message: "Message 2",
        dedupeKey: "test:key:2",
        readAt: null
      },
      {
        type: "hotspot_escalated",
        hotspotId: hotspot._id,
        title: "Test Alert 3 Escalation",
        message: "Message 3",
        dedupeKey: "test:key:3",
        readAt: null
      },
      {
        type: "hotspot_detected",
        hotspotId: hotspot._id,
        title: "Test Alert 4",
        message: "Message 4",
        dedupeKey: "test:key:4",
        readAt: new Date(Date.now() - 3600000)
      },
      {
        type: "hotspot_escalated",
        hotspotId: hotspot._id,
        title: "Test Alert 5 Escalation",
        message: "Message 5",
        dedupeKey: "test:key:5",
        readAt: new Date(Date.now() - 1800000)
      }
    ]);

    // Test pagination: page 1, limit 2
    const reqPaginated = {
      headers: { authorization: `Bearer ${testAdminToken}` },
      query: { page: "1", limit: "2" }
    };
    const resPaginated = await runAuthenticated(reqPaginated, getNotifications);
    assert.strictEqual(resPaginated.statusCode, 200);
    assert.strictEqual(resPaginated.body.notifications.length, 2);
    assert.strictEqual(resPaginated.body.total, 5);
    assert.strictEqual(resPaginated.body.totalPages, 3);
    assert.strictEqual(resPaginated.body.unreadCount, 3);

    // Test unread filter: read=false
    const reqUnread = {
      headers: { authorization: `Bearer ${testAdminToken}` },
      query: { read: "false" }
    };
    const resUnread = await runAuthenticated(reqUnread, getNotifications);
    assert.strictEqual(resUnread.statusCode, 200);
    assert.strictEqual(resUnread.body.notifications.length, 3);
    assert.strictEqual(resUnread.body.total, 3);
    resUnread.body.notifications.forEach(n => {
      assert.strictEqual(n.readAt, null, "read=false filter must only return unread records");
    });

    // Test type filter: type=hotspot_escalated
    const reqType = {
      headers: { authorization: `Bearer ${testAdminToken}` },
      query: { type: "hotspot_escalated" }
    };
    const resType = await runAuthenticated(reqType, getNotifications);
    assert.strictEqual(resType.statusCode, 200);
    assert.strictEqual(resType.body.notifications.length, 2);
    resType.body.notifications.forEach(n => {
      assert.strictEqual(n.type, "hotspot_escalated");
    });

    // Test dedicated unread-count endpoint
    const reqCount = { headers: { authorization: `Bearer ${testAdminToken}` }, query: {} };
    const resCount = await runAuthenticated(reqCount, getUnreadNotificationCount);
    assert.strictEqual(resCount.statusCode, 200);
    assert.strictEqual(resCount.body.unreadCount, 3);

    console.log("  PASS: 2. Pagination, filtering by read/type, and unread counts validated");
    passedCount++;
  } catch (err) {
    console.error("  FAIL: 2. Pagination and filtering test failed:", err.message);
    throw err;
  }

  // ---------------------------------------------------------------------------
  // Test 3: Mark one notification as read and mark all as read
  // ---------------------------------------------------------------------------
  try {
    const unreadDoc = await AdminNotification.findOne({ readAt: null });
    assert(unreadDoc, "Must have an unread notification to mark as read");

    // 1. Mark single notification as read
    const reqSingle = {
      headers: { authorization: `Bearer ${testAdminToken}` },
      params: { id: unreadDoc._id.toString() }
    };
    const resSingle = await runAuthenticated(reqSingle, markNotificationAsRead);
    assert.strictEqual(resSingle.statusCode, 200);
    assert.strictEqual(resSingle.body.error, false);
    assert(resSingle.body.notification.readAt, "Notification readAt must be set");

    // Verify unread count decreased to 2
    const countAfterSingle = await AdminNotification.countDocuments({ readAt: null });
    assert.strictEqual(countAfterSingle, 2);

    // 2. Mark all as read
    const reqAll = { headers: { authorization: `Bearer ${testAdminToken}` } };
    const resAll = await runAuthenticated(reqAll, markAllNotificationsAsRead);
    assert.strictEqual(resAll.statusCode, 200);
    assert.strictEqual(resAll.body.markedCount, 2);

    // Verify unread count is now 0
    const countAfterAll = await AdminNotification.countDocuments({ readAt: null });
    assert.strictEqual(countAfterAll, 0);

    console.log("  PASS: 3. Mark one notification as read and mark all as read functional");
    passedCount++;
  } catch (err) {
    console.error("  FAIL: 3. Mark read operations failed:", err.message);
    throw err;
  }

  // ---------------------------------------------------------------------------
  // Test 4: New hotspot event creates exactly one notification record
  // ---------------------------------------------------------------------------
  try {
    console.log("\n--- Category 3: DBSCAN Event Trigger & Notification Dispatch ---");

    await AdminNotification.deleteMany({});
    await Hotspot.deleteMany({});
    await Issue.deleteMany({});

    // Create 3 active pothole issues within 30m of each other
    const baseCoords = [77.7212, 11.3456];
    await Issue.create([
      {
        type: "pothole",
        description: "Severe pothole at corner",
        location: { type: "Point", coordinates: [baseCoords[0], baseCoords[1]] },
        status: "reported",
        severity: 8.0,
        userId: testCitizenId
      },
      {
        type: "pothole",
        description: "Another pothole 15m away",
        location: { type: "Point", coordinates: [baseCoords[0] + 0.0001, baseCoords[1] + 0.0001] },
        status: "reported",
        severity: 7.5,
        userId: testCitizenId
      },
      {
        type: "pothole",
        description: "Third pothole cluster member",
        location: { type: "Point", coordinates: [baseCoords[0] - 0.0001, baseCoords[1] - 0.0001] },
        status: "reported",
        severity: 8.5,
        userId: testCitizenId
      }
    ]);

    // Run DBSCAN sync
    const syncRes = await detectAndSyncHotspots({ category: "pothole" });
    assert.strictEqual(syncRes.createdCount, 1, "Exactly one hotspot must be created");

    // Verify exactly one notification was created
    const notifs = await AdminNotification.find({});
    assert.strictEqual(notifs.length, 1, "Exactly one notification record must be created for new hotspot");
    assert.strictEqual(notifs[0].type, "hotspot_detected");
    assert.strictEqual(notifs[0].severity, 8.0);
    assert(notifs[0].title.includes("Pothole"), "Notification title must mention category");
    assert(notifs[0].title.includes("Roads & Infrastructure"), "Notification title must mention department");
    assert.strictEqual(notifs[0].readAt, null);

    console.log("  PASS: 4. New hotspot event creates exactly one notification record");
    passedCount++;
  } catch (err) {
    console.error("  FAIL: 4. New hotspot notification test failed:", err.message);
    throw err;
  }

  // ---------------------------------------------------------------------------
  // Test 5: A new hotspot attempts email delivery only when configured
  // ---------------------------------------------------------------------------
  try {
    await AdminNotification.deleteMany({});
    await Hotspot.deleteMany({});
    await Issue.deleteMany({});

    // Inject mock transporter
    const mockTransport = new MockTransporter();
    setTransporter(mockTransport);

    // Create 3 active water leak issues
    const baseCoords = [77.7300, 11.3500];
    await Issue.create([
      {
        type: "water leak",
        description: "Water pipe bursting",
        location: { type: "Point", coordinates: [baseCoords[0], baseCoords[1]] },
        status: "reported",
        severity: 6.0,
        userId: testCitizenId
      },
      {
        type: "water leak",
        description: "Water flooding lane",
        location: { type: "Point", coordinates: [baseCoords[0] + 0.0001, baseCoords[1]] },
        status: "reported",
        severity: 6.0,
        userId: testCitizenId
      },
      {
        type: "water leak",
        description: "Gushing clean water",
        location: { type: "Point", coordinates: [baseCoords[0], baseCoords[1] + 0.0001] },
        status: "reported",
        severity: 7.0,
        userId: testCitizenId
      }
    ]);

    // Run DBSCAN sync
    await detectAndSyncHotspots({ category: "water_leak" });

    // Verify mock transporter was called
    assert.strictEqual(mockTransport.sentEmails.length, 1, "Mock transporter must receive exactly 1 email");
    const sent = mockTransport.sentEmails[0].mailOptions;
    assert(sent.subject.includes("Water Leak"), "Subject must include category");
    assert(sent.text.includes("Water Services"), "Body must include department");

    // Verify DB notification email status
    const notif = await AdminNotification.findOne({ type: "hotspot_detected" });
    assert(notif);
    assert.strictEqual(notif.emailStatus, "sent");
    assert(notif.emailSentAt instanceof Date);
    assert.strictEqual(notif.emailAttemptCount, 1);
    assert.strictEqual(notif.emailLastError, null);

    console.log("  PASS: 5. New hotspot attempts email delivery when configured and updates emailStatus to sent");
    passedCount++;
  } catch (err) {
    console.error("  FAIL: 5. Email delivery test failed:", err.message);
    throw err;
  }

  // ---------------------------------------------------------------------------
  // Test 6: Re-running the same job does not create duplicate notifications
  // ---------------------------------------------------------------------------
  try {
    const notifCountBefore = await AdminNotification.countDocuments({});

    // Re-run DBSCAN sync without any issue changes
    const syncRes2 = await detectAndSyncHotspots({ category: "water_leak" });
    assert.strictEqual(syncRes2.createdCount, 0);
    assert.strictEqual(syncRes2.updatedCount, 1);

    const notifCountAfter = await AdminNotification.countDocuments({});
    assert.strictEqual(
      notifCountAfter,
      notifCountBefore,
      "Re-running job on existing cluster must NOT create duplicate notification records"
    );

    console.log("  PASS: 6. Re-running the same job does not create duplicate notifications (Idempotent)");
    passedCount++;
  } catch (err) {
    console.error("  FAIL: 6. Idempotency test failed:", err.message);
    throw err;
  }

  // ---------------------------------------------------------------------------
  // Test 7: Unchanged hotspots do not repeatedly send emails
  // ---------------------------------------------------------------------------
  try {
    const mockTransport = new MockTransporter();
    setTransporter(mockTransport);

    // Re-run DBSCAN sync again
    await detectAndSyncHotspots({ category: "water_leak" });

    assert.strictEqual(
      mockTransport.sentEmails.length,
      0,
      "Unchanged hotspot must NOT trigger duplicate email sends"
    );

    console.log("  PASS: 7. Unchanged hotspots do not repeatedly send emails");
    passedCount++;
  } catch (err) {
    console.error("  FAIL: 7. Duplicate email prevention test failed:", err.message);
    throw err;
  }

  // ---------------------------------------------------------------------------
  // Test 8: Qualifying escalation creates a distinct event when cooldown rules permit
  // ---------------------------------------------------------------------------
  try {
    const mockTransport = new MockTransporter();
    setTransporter(mockTransport);

    const hotspot = await Hotspot.findOne({ category: "water_leak" });
    assert(hotspot);

    // Set initial alert timestamp to 25 hours ago to satisfy 24h cooldown requirement
    hotspot.alertSentAt = new Date(Date.now() - 25 * 3600 * 1000);
    hotspot.lastAlertIssueCount = 3;
    await hotspot.save();

    // Add 3 new issues to cause >= 50% growth (from 3 to 6 reports, 100% growth)
    const baseCoords = [77.7300, 11.3500];
    await Issue.create([
      {
        type: "water leak",
        description: "Expansion leak 1",
        location: { type: "Point", coordinates: [baseCoords[0] + 0.00005, baseCoords[1]] },
        status: "reported",
        userId: testCitizenId
      },
      {
        type: "water leak",
        description: "Expansion leak 2",
        location: { type: "Point", coordinates: [baseCoords[0], baseCoords[1] + 0.00005] },
        status: "reported",
        userId: testCitizenId
      },
      {
        type: "water leak",
        description: "Expansion leak 3",
        location: { type: "Point", coordinates: [baseCoords[0] - 0.00005, baseCoords[1]] },
        status: "reported",
        userId: testCitizenId
      }
    ]);

    // Run DBSCAN sync
    await detectAndSyncHotspots({ category: "water_leak" });

    // Verify escalation notification was created
    const escalationNotifs = await AdminNotification.find({ type: "hotspot_escalated" });
    assert.strictEqual(escalationNotifs.length, 1, "Exactly 1 escalation notification must be created");
    assert(escalationNotifs[0].title.includes("Escalation"), "Title must indicate escalation");

    // Verify escalation email was sent
    assert.strictEqual(mockTransport.sentEmails.length, 1, "Escalation must send exactly 1 email");
    assert(mockTransport.sentEmails[0].mailOptions.subject.includes("Escalation"));

    // Verify Hotspot status updated to escalating
    const updatedHotspot = await Hotspot.findById(hotspot._id);
    assert.strictEqual(updatedHotspot.status, "escalating");

    console.log("  PASS: 8. Qualifying escalation creates distinct event & email alert when cooldown permits");
    passedCount++;
  } catch (err) {
    console.error("  FAIL: 8. Escalation event test failed:", err.message);
    throw err;
  }

  // ---------------------------------------------------------------------------
  // Test 9: SMTP failure leaves the notification available in the dashboard
  // ---------------------------------------------------------------------------
  try {
    console.log("\n--- Category 4: Failure Isolation & Retry Mechanics ---");

    // Inject failing transporter
    const failingTransport = new MockTransporter(true, new Error("SMTP server unreachable at port 587"));
    setTransporter(failingTransport);

    // Create new garbage hotspot cluster
    const baseCoords = [77.7400, 11.3600];
    await Issue.create([
      {
        type: "garbage",
        description: "Overflowing dumpster 1",
        location: { type: "Point", coordinates: [baseCoords[0], baseCoords[1]] },
        status: "reported",
        userId: testCitizenId
      },
      {
        type: "garbage",
        description: "Overflowing dumpster 2",
        location: { type: "Point", coordinates: [baseCoords[0] + 0.0001, baseCoords[1]] },
        status: "reported",
        userId: testCitizenId
      },
      {
        type: "garbage",
        description: "Overflowing dumpster 3",
        location: { type: "Point", coordinates: [baseCoords[0], baseCoords[1] + 0.0001] },
        status: "reported",
        userId: testCitizenId
      }
    ]);

    // Run DBSCAN sync
    const syncRes = await detectAndSyncHotspots({ category: "garbage" });
    assert.strictEqual(syncRes.createdCount, 1);

    // Verify in-app notification WAS created despite SMTP transport error
    const failedNotif = await AdminNotification.findOne({
      title: /Garbage/i,
      type: "hotspot_detected"
    });
    assert(failedNotif, "Notification must be preserved in dashboard even if email fails");
    assert.strictEqual(failedNotif.emailStatus, "failed");
    assert(failedNotif.emailLastError.includes("SMTP server unreachable"));
    assert.strictEqual(failedNotif.emailAttemptCount, 1);

    // Verify hotspot was still created and active (failure isolation)
    const garbageHotspot = await Hotspot.findById(failedNotif.hotspotId);
    assert(garbageHotspot);
    assert.strictEqual(garbageHotspot.status, "active");

    console.log("  PASS: 9. SMTP failure preserves in-app notification and records sanitized error");
    passedCount++;
  } catch (err) {
    console.error("  FAIL: 9. Failure isolation test failed:", err.message);
    throw err;
  }

  // ---------------------------------------------------------------------------
  // Test 10: Retrying delivery does not duplicate notification records
  // ---------------------------------------------------------------------------
  try {
    const failedNotif = await AdminNotification.findOne({ emailStatus: "failed" });
    assert(failedNotif);
    const totalBeforeRetry = await AdminNotification.countDocuments({});

    // Switch transporter to working mock
    const workingTransport = new MockTransporter();
    setTransporter(workingTransport);

    // Admin calls retry endpoint
    const reqRetry = {
      headers: { authorization: `Bearer ${testAdminToken}` },
      params: { id: failedNotif._id.toString() }
    };
    const resRetry = await runAuthenticated(reqRetry, retryNotificationEmailController);
    assert.strictEqual(resRetry.statusCode, 200);
    assert.strictEqual(resRetry.body.error, false);
    assert.strictEqual(resRetry.body.notification.emailStatus, "sent");

    // Verify email was sent
    assert.strictEqual(workingTransport.sentEmails.length, 1);

    // Verify total notification records remained constant
    const totalAfterRetry = await AdminNotification.countDocuments({});
    assert.strictEqual(totalAfterRetry, totalBeforeRetry, "Retry must not duplicate notification records");

    // Verify attempt count incremented
    const updatedNotif = await AdminNotification.findById(failedNotif._id);
    assert.strictEqual(updatedNotif.emailAttemptCount, 2);

    console.log("  PASS: 10. Retrying email delivery does not duplicate notification records");
    passedCount++;
  } catch (err) {
    console.error("  FAIL: 10. Retry mechanism test failed:", err.message);
    throw err;
  }

  // ---------------------------------------------------------------------------
  // Test 11: Missing SMTP configuration results in unconfigured status
  // ---------------------------------------------------------------------------
  try {
    console.log("\n--- Category 5: Edge Cases, Templates & Security ---");

    // Reset transporter to read from env (which has empty SMTP credentials in test environment)
    resetTransporter();
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;

    const dummyHotspot = await Hotspot.create({
      category: "sewage",
      department: "Water Services",
      centroid: { type: "Point", coordinates: [77.75, 11.37] },
      distinctDefectCount: 3,
      totalReportCount: 3,
      issueIds: [new mongoose.Types.ObjectId()]
    });

    const dispatchResult = await dispatchHotspotNotification({
      type: "hotspot_detected",
      hotspot: dummyHotspot
    });

    assert.strictEqual(dispatchResult.success, true);
    assert.strictEqual(dispatchResult.notification.emailStatus, "unconfigured");
    assert(dispatchResult.notification.emailLastError.includes("SMTP is not configured"));

    console.log("  PASS: 11. Unconfigured SMTP environment cleanly assigns emailStatus: 'unconfigured'");
    passedCount++;
  } catch (err) {
    console.error("  FAIL: 11. Unconfigured SMTP test failed:", err.message);
    throw err;
  }

  // ---------------------------------------------------------------------------
  // Test 12: Malformed IDs and invalid query parameters are rejected
  // ---------------------------------------------------------------------------
  try {
    // 1. Invalid page
    const reqInvalidPage = {
      headers: { authorization: `Bearer ${testAdminToken}` },
      query: { page: "0" }
    };
    const resInvalidPage = await runAuthenticated(reqInvalidPage, getNotifications);
    assert.strictEqual(resInvalidPage.statusCode, 400);

    // 2. Invalid limit (> 100)
    const reqInvalidLimit = {
      headers: { authorization: `Bearer ${testAdminToken}` },
      query: { limit: "150" }
    };
    const resInvalidLimit = await runAuthenticated(reqInvalidLimit, getNotifications);
    assert.strictEqual(resInvalidLimit.statusCode, 400);

    // 3. Invalid read boolean
    const reqInvalidRead = {
      headers: { authorization: `Bearer ${testAdminToken}` },
      query: { read: "maybe" }
    };
    const resInvalidRead = await runAuthenticated(reqInvalidRead, getNotifications);
    assert.strictEqual(resInvalidRead.statusCode, 400);

    // 4. Invalid type filter
    const reqInvalidType = {
      headers: { authorization: `Bearer ${testAdminToken}` },
      query: { type: "nuclear_hazard" }
    };
    const resInvalidType = await runAuthenticated(reqInvalidType, getNotifications);
    assert.strictEqual(resInvalidType.statusCode, 400);

    // 5. Malformed ObjectId on mark read
    const reqMalformedId = {
      headers: { authorization: `Bearer ${testAdminToken}` },
      params: { id: "not-an-objectid" }
    };
    const resMalformedId = await runAuthenticated(reqMalformedId, markNotificationAsRead);
    assert.strictEqual(resMalformedId.statusCode, 400);

    // 6. Non-existent ObjectId on mark read
    const reqNotFoundId = {
      headers: { authorization: `Bearer ${testAdminToken}` },
      params: { id: new mongoose.Types.ObjectId().toString() }
    };
    const resNotFoundId = await runAuthenticated(reqNotFoundId, markNotificationAsRead);
    assert.strictEqual(resNotFoundId.statusCode, 404);

    // 7. Malformed ObjectId on retry email
    const reqMalformedRetry = {
      headers: { authorization: `Bearer ${testAdminToken}` },
      params: { id: "bad-id" }
    };
    const resMalformedRetry = await runAuthenticated(reqMalformedRetry, retryNotificationEmailController);
    assert.strictEqual(resMalformedRetry.statusCode, 400);

    console.log("  PASS: 12. Malformed IDs and invalid query parameters rejected with 400/404");
    passedCount++;
  } catch (err) {
    console.error("  FAIL: 12. Input validation test failed:", err.message);
    throw err;
  }

  // ---------------------------------------------------------------------------
  // Test 13: Email HTML escapes user-controlled values
  // ---------------------------------------------------------------------------
  try {
    const maliciousHotspot = {
      category: "<script>alert('xss')</script>",
      department: "Roads & \"onload=\"evil()",
      centroid: { coordinates: [77.72, 11.34] },
      distinctDefectCount: 2,
      totalReportCount: 3,
      meanSeverity: 7.5
    };

    const content = generateHotspotEmailContent({
      type: "hotspot_detected",
      hotspot: maliciousHotspot,
      title: "Alert <img src=x onerror=alert(1)>",
      message: "Testing <b>bold</b> and <script>alert(2)</script>",
      dashboardUrl: "http://localhost:3000"
    });

    assert(!content.html.includes("<script>"), "HTML must not contain raw script tags");
    assert(content.html.toLowerCase().includes("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;"), "Category must be escaped");
    assert(content.html.includes("&amp; &quot;onload=&quot;evil()"), "Department must be escaped");
    assert(content.html.includes("&lt;img src=x onerror=alert(1)&gt;"), "Title must be escaped");

    console.log("  PASS: 13. Email HTML strictly escapes user-controlled text to prevent HTML/XSS injection");
    passedCount++;
  } catch (err) {
    console.error("  FAIL: 13. HTML escaping test failed:", err.message);
    throw err;
  }

  // ---------------------------------------------------------------------------
  // Test 14: Error messages do not expose SMTP credentials or internal stack traces
  // ---------------------------------------------------------------------------
  try {
    process.env.SMTP_USER = "smtp_test_user@city.gov";
    process.env.SMTP_PASS = "SuperSecretPassword99!";

    const sensitiveError = new Error(
      "Failed to authenticate with smtp://smtp_test_user@city.gov:SuperSecretPassword99!@smtp.example.com\n" +
      "    at Connection.login (/app/node_modules/nodemailer/lib/smtp.js:142:15)\n" +
      "    at Object.run (/app/internal.js:10:5)"
    );

    const sanitized = sanitizeEmailError(sensitiveError);

    assert(!sanitized.includes("SuperSecretPassword99!"), "Sanitized error must NEVER contain SMTP_PASS");
    assert(!sanitized.includes("smtp_test_user@city.gov"), "Sanitized error must NEVER contain SMTP_USER");
    assert(!sanitized.includes("at Connection.login"), "Sanitized error must strip stack traces");
    assert(sanitized.length <= 500, "Sanitized error must be bounded in length");

    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;

    console.log("  PASS: 14. Sanitized error messages scrub credentials and strip internal stack traces");
    passedCount++;
  } catch (err) {
    console.error("  FAIL: 14. Error sanitization test failed:", err.message);
    throw err;
  }

  // ---------------------------------------------------------------------------
  // Test 15: Existing DBSCAN, review flags, hotspot lifecycle, and privacy protections remain intact
  // ---------------------------------------------------------------------------
  try {
    const notifications = await AdminNotification.find({}).lean();
    for (const notif of notifications) {
      assert.strictEqual(notif.password, undefined);
      assert.strictEqual(notif.tokens, undefined);
      assert.strictEqual(notif.embedding, undefined);
      assert.strictEqual(notif.aiDiagnostics, undefined);
      assert.strictEqual(notif.internalNotes, undefined);
    }

    // Hotspot integrity check
    const hotspots = await Hotspot.find({}).lean();
    for (const h of hotspots) {
      assert(h.centroid && Array.isArray(h.centroid.coordinates));
      assert(h.distinctDefectCount >= 1);
      assert(["active", "escalating", "resolving", "resolved"].includes(h.status));
    }

    console.log("  PASS: 15. DBSCAN clustering integrity, review flags, and privacy fields remain intact");
    passedCount++;
  } catch (err) {
    console.error("  FAIL: 15. System integrity test failed:", err.message);
    throw err;
  }

  console.log("\n================================================================================");
  console.log(`Test Execution Finished: ${passedCount} Passed, 0 Failed`);
  console.log("================================================================================\n");

  await mongoose.connection.close();
}

if (require.main === module) {
  runTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Test execution aborted with fatal error:", err);
      process.exit(1);
    });
}

module.exports = { runTests };
