/**
 * CivicVision AI — Phase 4.2B-C Hotspot API & Job Runner Test Suite
 *
 * Verifies:
 * 1. Admin Authentication & Role Enforcement (401 on missing token, 403 on citizen token, 200 on admin).
 * 2. Input Validation (invalid ObjectIds, malformed pagination, invalid category/status, invalid run params).
 * 3. Hotspot Querying & Safe Projection (pagination bounds, privacy exclusion of internalNotes, embeddings, aiDiagnostics).
 * 4. Hotspot Refresh Execution (single-run execution, structured summary output).
 * 5. Concurrency Protection (in-process mutex, distributed lease lock, 409 Conflict rejection).
 * 6. Exception Safety (guaranteed lock release in finally block, failed refresh never falsely resolves hotspots).
 * 7. Alert Bookkeeping Idempotency across refresh executions.
 *
 * Safety:
 * - Operates strictly against disposable local database: mongodb://127.0.0.1:27017/civicvision_test_hotspot_runner_disposable
 * - Strict Atlas protection guard neutralizes any production Atlas MONGO_URI.
 */

const assert = require("assert");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

// Strict Atlas protection: NEVER connect to Atlas
if (
  process.env.MONGO_URI &&
  (process.env.MONGO_URI.includes("mongodb+srv") || process.env.MONGO_URI.includes("mongodb.net"))
) {
  delete process.env.MONGO_URI;
}

const DISPOSABLE_DB_URI = "mongodb://127.0.0.1:27017/civicvision_test_hotspot_runner_disposable";
const TEST_JWT_SECRET = "phase42bc_test_jwt_secret_key_32_chars_min";
process.env.JWT_SECRET = TEST_JWT_SECRET;

const Hotspot = require("../models/Hotspot");
const Issue = require("../models/Issue");
const User = require("../models/User");
const Admin = require("../models/Admin");
const JobLock = require("../models/JobLock");

const verifyAdmin = require("../middleware/authenticateTokenAdmin");
const {
  getHotspots,
  getHotspotById,
  runHotspotRefresh
} = require("../controllers/adminDashboard.controller");
const {
  acquireHotspotLock,
  releaseHotspotLock,
  executeHotspotJob,
  getHotspotJobLockStatus
} = require("../services/hotspotJob.service");
const { CANONICAL_CATEGORIES, CANONICAL_DEPARTMENTS } = require("../services/routing.service");

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

let testAdminId;
let testAdminToken;
let testCitizenId;
let testCitizenToken;

async function setupDatabase() {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(DISPOSABLE_DB_URI, { serverSelectionTimeoutMS: 5000 });
  }
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

async function teardownDatabase() {
  try {
    await Hotspot.deleteMany({});
    await Issue.deleteMany({});
    await User.deleteMany({});
    await Admin.deleteMany({});
    await JobLock.deleteMany({});
    await mongoose.connection.close();
  } catch (err) {
    // Ignore teardown errors
  }
}

async function runTests() {
  console.log("================================================================================");
  console.log("CivicVision AI — Phase 4.2B-C Hotspot API & Safe Job Runner Tests");
  console.log("================================================================================\n");

  await setupDatabase();

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL: ${name}`);
      console.error(`    Error: ${err.message}`);
      if (err.stack) {
        console.error(`    Stack: ${err.stack.split("\n").slice(1, 4).join("\n")}`);
      }
      failed++;
    }
  }

  // ============================================================================
  // Category 1: Admin Authentication & Role Enforcement
  // ============================================================================
  console.log("--- Category 1: Admin Authentication & Role Enforcement ---");

  await test("1. verifyAdmin rejects missing token with 401 on hotspot routes", async () => {
    const req = { headers: {} };
    const res = createMockRes();
    let nextCalled = false;

    verifyAdmin(req, res, () => { nextCalled = true; });

    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body.error, true);
    assert.strictEqual(nextCalled, false);
  });

  await test("2. verifyAdmin rejects citizen token with 403 Forbidden on hotspot routes", async () => {
    const req = { headers: { authorization: `Bearer ${testCitizenToken}` } };
    const res = createMockRes();
    let nextCalled = false;

    verifyAdmin(req, res, () => { nextCalled = true; });

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.error, true);
    assert.strictEqual(res.body.message.includes("Administrator access required"), true);
    assert.strictEqual(nextCalled, false);
  });

  await test("3. verifyAdmin accepts valid admin token and attaches req.admin", async () => {
    const req = { headers: { authorization: `Bearer ${testAdminToken}` } };
    const res = createMockRes();
    let nextCalled = false;

    verifyAdmin(req, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, true);
    assert(req.admin);
    assert.strictEqual(req.admin.adminId, testAdminId.toString());
  });

  // ============================================================================
  // Category 2: Parameter Validation & Error Handling
  // ============================================================================
  console.log("\n--- Category 2: Parameter Validation & Error Handling ---");

  await test("4. getHotspots rejects invalid pagination parameters (page < 1, limit > 100, NaN) with 400", async () => {
    // Case A: page = 0
    let req = { query: { page: "0" } };
    let res = createMockRes();
    await getHotspots(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert(res.body.message.includes("Invalid page parameter"));

    // Case B: limit = 200
    req = { query: { limit: "200" } };
    res = createMockRes();
    await getHotspots(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert(res.body.message.includes("Invalid limit parameter"));

    // Case C: page = "abc"
    req = { query: { page: "abc" } };
    res = createMockRes();
    await getHotspots(req, res);
    assert.strictEqual(res.statusCode, 400);
  });

  await test("5. getHotspots rejects invalid category and status filter values with 400", async () => {
    // Case A: invalid category
    let req = { query: { category: "spaceship_damage" } };
    let res = createMockRes();
    await getHotspots(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert(res.body.message.includes("Invalid category filter"));

    // Case B: invalid status
    req = { query: { status: "exploding" } };
    res = createMockRes();
    await getHotspots(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert(res.body.message.includes("Invalid status filter"));
  });

  await test("6. getHotspotById rejects malformed ObjectId format with 400", async () => {
    const req = { params: { id: "not-a-valid-mongo-id" } };
    const res = createMockRes();
    await getHotspotById(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.message, "Invalid hotspot ID format");
  });

  await test("7. getHotspotById returns 404 for non-existent hotspot ID", async () => {
    const nonExistentId = new mongoose.Types.ObjectId();
    const req = { params: { id: nonExistentId.toString() } };
    const res = createMockRes();
    await getHotspotById(req, res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.body.message, "Hotspot not found");
  });

  await test("8. runHotspotRefresh rejects invalid options (minSamples < 1, epsMeters <= 0) with 400", async () => {
    // Case A: minSamples = 0
    let req = { body: { minSamples: 0 } };
    let res = createMockRes();
    await runHotspotRefresh(req, res);
    assert.strictEqual(res.statusCode, 400);

    // Case B: epsMeters = -50
    req = { body: { epsMeters: -50 } };
    res = createMockRes();
    await runHotspotRefresh(req, res);
    assert.strictEqual(res.statusCode, 400);

    // Case C: invalid category
    req = { body: { category: "invalid_cat" } };
    res = createMockRes();
    await runHotspotRefresh(req, res);
    assert.strictEqual(res.statusCode, 400);
  });

  // ============================================================================
  // Category 3: Hotspot Querying & Privacy Hardening
  // ============================================================================
  console.log("\n--- Category 3: Hotspot Querying & Safe Projection ---");

  await test("9. getHotspots returns validated paginated results and filters by category", async () => {
    await Hotspot.deleteMany({});

    // Create 3 pothole hotspots and 2 garbage hotspots
    for (let i = 0; i < 3; i++) {
      await Hotspot.create({
        category: "pothole",
        department: CANONICAL_DEPARTMENTS.ROADS_AND_INFRASTRUCTURE,
        centroid: { coordinates: [77.71 + i * 0.01, 11.34] },
        distinctDefectCount: 3 + i,
        totalReportCount: 5 + i,
        issueIds: [new mongoose.Types.ObjectId()]
      });
    }

    for (let i = 0; i < 2; i++) {
      await Hotspot.create({
        category: "garbage",
        department: CANONICAL_DEPARTMENTS.WASTE_MANAGEMENT,
        centroid: { coordinates: [77.81 + i * 0.01, 11.44] },
        distinctDefectCount: 4,
        totalReportCount: 6,
        issueIds: [new mongoose.Types.ObjectId()]
      });
    }

    // Query with pagination limit=2
    const req1 = { query: { page: "1", limit: "2" } };
    const res1 = createMockRes();
    await getHotspots(req1, res1);

    assert.strictEqual(res1.statusCode, 200);
    assert.strictEqual(res1.body.total, 5);
    assert.strictEqual(res1.body.totalPages, 3);
    assert.strictEqual(res1.body.page, 1);
    assert.strictEqual(res1.body.hotspots.length, 2);

    // Query filter category=garbage
    const req2 = { query: { category: "garbage" } };
    const res2 = createMockRes();
    await getHotspots(req2, res2);

    assert.strictEqual(res2.statusCode, 200);
    assert.strictEqual(res2.body.total, 2);
    assert.strictEqual(res2.body.hotspots.length, 2);
    assert(res2.body.hotspots.every(h => h.category === "garbage"));
  });

  await test("10. getHotspotById returns safe constituent issues with internalNotes, embeddings, and diagnostics strictly excluded", async () => {
    // Create constituent issues with private fields
    const iss1 = await Issue.create({
      userId: testCitizenId,
      type: "pothole",
      description: "Severe crater",
      location: { coordinates: [77.7170, 11.3410] },
      status: "reported",
      internalNotes: "Private admin note: pipeline repair under warranty",
      embedding: [0.1, 0.2, 0.3],
      embeddingModel: "openai/clip-vit-base-patch32",
      aiDiagnostic: { serviceStatus: "online", message: "model prediction" }
    });

    const iss2 = await Issue.create({
      userId: testCitizenId,
      type: "pothole",
      description: "Edge cracking",
      location: { coordinates: [77.7171, 11.3411] },
      status: "reported",
      internalNotes: "Private admin note: contractor notified"
    });

    const hotspot = await Hotspot.create({
      category: "pothole",
      department: CANONICAL_DEPARTMENTS.ROADS_AND_INFRASTRUCTURE,
      centroid: { coordinates: [77.71705, 11.34105] },
      distinctDefectCount: 2,
      totalReportCount: 2,
      issueIds: [iss1._id, iss2._id]
    });

    const req = { params: { id: hotspot._id.toString() } };
    const res = createMockRes();
    await getHotspotById(req, res);

    assert.strictEqual(res.statusCode, 200);
    const returnedHotspot = res.body.hotspot;
    assert.strictEqual(String(returnedHotspot._id), hotspot._id.toString());
    assert.strictEqual(returnedHotspot.issues.length, 2);

    // CRITICAL PRIVACY & SECURITY AUDIT:
    for (const issue of returnedHotspot.issues) {
      assert.strictEqual(
        issue.internalNotes,
        undefined,
        "Constituent issue internalNotes must NOT be exposed in API response"
      );
      assert.strictEqual(
        issue.embedding,
        undefined,
        "Constituent issue embedding vector must NOT be exposed in API response"
      );
      assert.strictEqual(
        issue.embeddingModel,
        undefined,
        "Constituent issue embeddingModel must NOT be exposed in API response"
      );
      assert.strictEqual(
        issue.aiDiagnostic,
        undefined,
        "Constituent issue aiDiagnostic must NOT be exposed in API response"
      );
      // Citizen user projection safety: no password
      assert(issue.userId);
      assert.strictEqual(issue.userId.password, undefined);
      assert.strictEqual(issue.userId.fullName, "Concerned Citizen");
    }
  });

  // ============================================================================
  // Category 4: Safe Job Runner & Concurrency Protection
  // ============================================================================
  console.log("\n--- Category 4: Safe Job Runner & Concurrency Protection ---");

  await test("11. runHotspotRefresh executes single-run clustering and returns structured summary", async () => {
    await Hotspot.deleteMany({});
    await Issue.deleteMany({});

    // Seed 3 active potholes
    for (let i = 0; i < 3; i++) {
      await Issue.create({
        userId: testCitizenId,
        type: "pothole",
        description: `Pothole ${i}`,
        location: { coordinates: [77.7170 + i * 0.0001, 11.3410] },
        status: "reported"
      });
    }

    const req = { body: { epsMeters: 100, minSamples: 3 } };
    const res = createMockRes();
    await runHotspotRefresh(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.error, false);
    assert(res.body.summary);
    assert.strictEqual(res.body.summary.createdCount, 1);
    assert.strictEqual(res.body.summary.updatedCount, 0);

    const count = await Hotspot.countDocuments({ category: "pothole" });
    assert.strictEqual(count, 1);
  });

  await test("12. Concurrency Guard: overlapping run request returns 409 Conflict while lock is active", async () => {
    // Acquire lock manually
    const workerId = "test_manual_worker_lock";
    const acquireResult = await acquireHotspotLock("hotspot_refresh", workerId, 60000);
    assert.strictEqual(acquireResult.acquired, true);

    try {
      // While lock is active, trigger runHotspotRefresh
      const req = { body: {} };
      const res = createMockRes();
      await runHotspotRefresh(req, res);

      assert.strictEqual(res.statusCode, 409, "Must return 409 Conflict when job is already running");
      assert.strictEqual(res.body.error, true);
      assert(res.body.message.includes("already running"));
    } finally {
      // Release lock
      await releaseHotspotLock("hotspot_refresh", workerId);
    }

    // Verify lock is released and subsequent run succeeds
    const status = await getHotspotJobLockStatus("hotspot_refresh");
    assert.strictEqual(status.isLocked, false);
  });

  await test("13. Lock release in finally block: lock is released even if refresh job throws an error", async () => {
    // Verify currently unlocked
    let status = await getHotspotJobLockStatus("hotspot_refresh");
    assert.strictEqual(status.isLocked, false);

    // Call executeHotspotJob with invalid parameters that cause an error inside the try block
    let threw = false;
    try {
      await executeHotspotJob({ epsMeters: -999 }); // Throws validation error
    } catch (err) {
      threw = true;
    }
    assert.strictEqual(threw, true, "Must have thrown validation error");

    // CRITICAL: Lock must be released in finally block!
    status = await getHotspotJobLockStatus("hotspot_refresh");
    assert.strictEqual(
      status.isLocked,
      false,
      "Lock must be released even after an exception occurs"
    );
  });

  await test("14. Failed refresh does NOT falsely mark existing hotspots as resolved", async () => {
    await Hotspot.deleteMany({});

    // Create an active hotspot
    const hotspot = await Hotspot.create({
      category: "pothole",
      department: CANONICAL_DEPARTMENTS.ROADS_AND_INFRASTRUCTURE,
      centroid: { coordinates: [77.7170, 11.3410] },
      distinctDefectCount: 3,
      totalReportCount: 3,
      status: "active",
      issueIds: [new mongoose.Types.ObjectId()]
    });

    // Attempt a failed refresh
    try {
      await executeHotspotJob({ epsMeters: -1 });
    } catch (err) {
      // Expected failure
    }

    // Check hotspot status in database
    const refreshed = await Hotspot.findById(hotspot._id);
    assert.strictEqual(
      refreshed.status,
      "active",
      "Hotspot status must NOT be modified or falsely marked resolved during a failed run"
    );
  });

  // ============================================================================
  // Category 5: Repeat-Run Idempotency & Alert Bookkeeping
  // ============================================================================
  console.log("\n--- Category 5: Repeat-Run Idempotency & Alert State ---");

  await test("15. Repeated refresh runs remain idempotent without duplicating alert records", async () => {
    await Hotspot.deleteMany({});
    await Issue.deleteMany({});

    // Create 3 active potholes
    for (let i = 0; i < 3; i++) {
      await Issue.create({
        userId: testCitizenId,
        type: "pothole",
        description: `Pothole ${i}`,
        location: { coordinates: [77.7170 + i * 0.0001, 11.3410] },
        status: "reported"
      });
    }

    // First execution
    const res1 = await executeHotspotJob({ epsMeters: 100, minSamples: 3 });
    assert.strictEqual(res1.summary.createdCount, 1);

    const initialHotspot = await Hotspot.findOne({ category: "pothole" });
    const initialAlertSentAt = initialHotspot.alertSentAt.getTime();
    assert.strictEqual(initialHotspot.alertSent, true);

    // Second execution on unchanged input
    const res2 = await executeHotspotJob({ epsMeters: 100, minSamples: 3 });
    assert.strictEqual(res2.summary.createdCount, 0);
    assert.strictEqual(res2.summary.updatedCount, 1);

    const refreshedHotspot = await Hotspot.findOne({ category: "pothole" });
    assert.strictEqual(
      String(refreshedHotspot._id),
      String(initialHotspot._id),
      "Hotspot ID must be preserved"
    );
    assert.strictEqual(
      refreshedHotspot.alertSentAt.getTime(),
      initialAlertSentAt,
      "alertSentAt must NOT be overwritten or reset on repeated detection"
    );
  });

  await teardownDatabase();

  console.log("\n================================================================================");
  console.log(`Test Execution Finished: ${passed} Passed, ${failed} Failed`);
  console.log("================================================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
