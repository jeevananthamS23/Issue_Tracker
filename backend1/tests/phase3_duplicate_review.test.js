/**
 * CivicVision AI — Phase 3.4A Duplicate Review & Privacy Hardening Test Suite
 *
 * Verifies:
 * 1. Privacy Hardening: Public issue creation, listing, nearby queries, and duplicate candidates
 *    strictly exclude internalNotes, embedding, embeddingModel, and aiDiagnostic.
 * 2. Admin Review Authorization: Protected endpoints reject unauthenticated requests (401)
 *    and non-admin / citizen tokens (403).
 * 3. Admin Filtering & Safe Population: Filter by needsReview and duplicateStatus; safe population
 *    of duplicateOf (type, description, imageUrl, status, location, createdAt) without recursive leaks.
 * 4. Review Resolution & Auditability: Actions 'confirm_duplicate' and 'dismiss_duplicate';
 *    accurate transitions for reviewResolution and needsReview: false; server-generated
 *    reviewedBy and reviewedAt; client override protection; invalid action rejection.
 *
 * Safety:
 * - Operates strictly against a disposable local MongoDB instance.
 * - Defensive guard neutralizes any production Atlas MONGO_URI.
 */

const assert = require("assert");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

// Strict Atlas protection
if (process.env.MONGO_URI && (process.env.MONGO_URI.includes("mongodb+srv") || process.env.MONGO_URI.includes("mongodb.net"))) {
  delete process.env.MONGO_URI;
}

const DISPOSABLE_DB_URI = "mongodb://127.0.0.1:27017/civicvision_test_phase34a_disposable";
const TEST_JWT_SECRET = process.env.JWT_SECRET || "phase34a_test_jwt_secret_key_32_chars_min";
process.env.JWT_SECRET = TEST_JWT_SECRET;

const Issue = require("../models/Issue");
const Admin = require("../models/Admin");
const User = require("../models/User");
const {
  getAllIssues: adminGetAllIssues,
  getFilteredIssues: adminGetFilteredIssues,
  updateIssueStatus: adminUpdateIssueStatus,
  resolveDuplicateReview: adminResolveDuplicateReview
} = require("../controllers/adminDashboard.controller");
const {
  getAllIssues: publicGetAllIssues,
  getUserIssues: publicGetUserIssues,
  reportIssue: publicReportIssue,
  getNearbyIssues: publicGetNearbyIssues,
  getDuplicateCandidates: publicGetDuplicateCandidates
} = require("../controllers/issue.controller");
const verifyAdmin = require("../middleware/authenticateTokenAdmin");

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

async function runTests() {
  console.log("==================================================================");
  console.log("   CIVICVISION AI - PHASE 3.4A DUPLICATE REVIEW & PRIVACY TESTS");
  console.log("==================================================================");

  let realDbAvailable = false;
  try {
    await mongoose.connect(DISPOSABLE_DB_URI, { serverSelectionTimeoutMS: 3000 });
    realDbAvailable = true;
    await mongoose.connection.db.dropDatabase();
    console.log("[Setup] Connected to disposable local MongoDB at:", DISPOSABLE_DB_URI);
  } catch (err) {
    console.error("[Setup Error] Could not connect to local test MongoDB:", err.message);
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  ✓ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ FAIL: ${name}`);
      console.error("    Details:", err.message);
      failed++;
    }
  }

  const issuesCollection = mongoose.connection.db.collection("issues");

  // Create test administrator & citizen credentials
  const adminId = new mongoose.Types.ObjectId();
  const citizenId = new mongoose.Types.ObjectId();

  const testAdmin = new Admin({
    _id: adminId,
    fullName: "Chief Administrator",
    email: "admin.moderator@civicvision.gov",
    password: "hashed_dummy_password"
  });
  await testAdmin.save();

  const adminToken = jwt.sign(
    { adminId: adminId.toString(), role: "admin" },
    TEST_JWT_SECRET,
    { expiresIn: "1h" }
  );

  const citizenToken = jwt.sign(
    { userId: citizenId.toString(), role: "citizen" },
    TEST_JWT_SECRET,
    { expiresIn: "1h" }
  );

  // --------------------------------------------------------------------------
  // Category 1: Privacy Hardening Across All Public Endpoints
  // --------------------------------------------------------------------------
  console.log("\n--- Category 1: Public Response Privacy Hardening ---");

  await test("1. reportIssue strictly strips internalNotes, embedding, embeddingModel, and aiDiagnostic", async () => {
    await issuesCollection.deleteMany({});

    const req = {
      body: {
        type: "Pothole",
        description: "Public pothole test",
        lat: 13.0827,
        lng: 80.2707
      },
      user: { userId: citizenId.toString() }
    };
    const res = createMockRes();

    await publicReportIssue(req, res);

    assert.strictEqual(res.statusCode, 201);
    const issueData = res.body.issue;
    assert.strictEqual(issueData.internalNotes, undefined, "internalNotes must NOT be present");
    assert.strictEqual(issueData.embedding, undefined, "embedding must NOT be present");
    assert.strictEqual(issueData.embeddingModel, undefined, "embeddingModel must NOT be present");
    assert.strictEqual(issueData.aiDiagnostic, undefined, "aiDiagnostic must NOT be present");
    assert.ok(res.body.duplicateCheck, "duplicateCheck summary must be present");
    assert.strictEqual(res.body.duplicateCheck.aiDiagnostic, undefined);
  });

  await test("2. public getAllIssues strictly deselects internalNotes and aiDiagnostic", async () => {
    await issuesCollection.deleteMany({});

    const doc = new Issue({
      userId: citizenId,
      type: "Garbage",
      description: "Waste on street",
      internalNotes: "CONFIDENTIAL_ADMIN_FLAG_01",
      aiDiagnostic: { serviceStatus: "ai_service_unavailable", message: "internal error detail" },
      location: { lat: 13.08, lng: 80.27 }
    });
    await doc.save();

    const req = {};
    const res = createMockRes();

    await publicGetAllIssues(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.length, 1);
    assert.strictEqual(res.body[0].internalNotes, undefined, "internalNotes must be excluded");
    assert.strictEqual(res.body[0].aiDiagnostic, undefined, "aiDiagnostic must be excluded");
  });

  await test("3. public getUserIssues strictly deselects internalNotes and aiDiagnostic", async () => {
    const req = { user: { userId: citizenId.toString() } };
    const res = createMockRes();

    await publicGetUserIssues(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.length, 1);
    assert.strictEqual(res.body[0].internalNotes, undefined);
    assert.strictEqual(res.body[0].aiDiagnostic, undefined);
  });

  await test("4. public getNearbyIssues strictly deselects internalNotes and aiDiagnostic", async () => {
    await Issue.createIndexes();
    const req = { query: { lat: 13.08, lng: 80.27, radius: 500 } };
    const res = createMockRes();

    await publicGetNearbyIssues(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.length, 1);
    assert.strictEqual(res.body[0].internalNotes, undefined);
    assert.strictEqual(res.body[0].aiDiagnostic, undefined);
  });

  await test("5. public getDuplicateCandidates sanitizes internalNotes, embedding, and aiDiagnostic", async () => {
    const req = { query: { lat: 13.08, lng: 80.27, type: "Garbage", radius: 500 } };
    const res = createMockRes();

    await publicGetDuplicateCandidates(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.candidates.length, 1);
    const cand = res.body.candidates[0];
    assert.strictEqual(cand.internalNotes, undefined);
    assert.strictEqual(cand.embedding, undefined);
    assert.strictEqual(cand.embeddingModel, undefined);
    assert.strictEqual(cand.aiDiagnostic, undefined);
  });

  // --------------------------------------------------------------------------
  // Category 2: Admin Review Authorization & Role Boundaries
  // --------------------------------------------------------------------------
  console.log("\n--- Category 2: Admin Authentication & Role Enforcement ---");

  await test("6. verifyAdmin middleware rejects missing tokens with 401", async () => {
    const req = { headers: {} };
    const res = createMockRes();
    let nextCalled = false;

    verifyAdmin(req, res, () => { nextCalled = true; });

    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(nextCalled, false);
    assert.ok(res.body.message.includes("missing"));
  });

  await test("7. verifyAdmin middleware rejects citizen tokens with 403 Forbidden", async () => {
    const req = { headers: { authorization: `Bearer ${citizenToken}` } };
    const res = createMockRes();
    let nextCalled = false;

    verifyAdmin(req, res, () => { nextCalled = true; });

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(nextCalled, false);
    assert.ok(res.body.message.includes("Administrator access required"));
  });

  await test("8. verifyAdmin middleware accepts valid admin token and attaches req.admin", async () => {
    const req = { headers: { authorization: `Bearer ${adminToken}` } };
    const res = createMockRes();
    let nextCalled = false;

    verifyAdmin(req, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, true);
    assert.strictEqual(req.admin.adminId, adminId.toString());
    assert.strictEqual(req.admin.role, "admin");
  });

  // --------------------------------------------------------------------------
  // Category 3: Admin Duplicate Filtering & Safe Population
  // --------------------------------------------------------------------------
  console.log("\n--- Category 3: Admin Filtering & Safe Population ---");

  // Seed sample issues: Original issue and a candidate flagged as duplicate
  const originalIssue = new Issue({
    userId: citizenId,
    type: "Pothole",
    description: "Original deep pothole on Main St",
    status: "reported",
    location: { lat: 13.0827, lng: 80.2707 },
    internalNotes: "CONFIDENTIAL_ORIGINAL_NOTE",
    duplicateStatus: "unique",
    needsReview: false
  });
  await originalIssue.save();

  const flaggedIssue = new Issue({
    userId: citizenId,
    type: "Pothole",
    description: "Second report of same pothole",
    status: "reported",
    location: { lat: 13.0828, lng: 80.2708 },
    duplicateStatus: "flagged_duplicate",
    duplicateOf: originalIssue._id,
    similarityScore: 0.94,
    needsReview: true,
    aiDiagnostic: { serviceStatus: "duplicate_flagged" }
  });
  await flaggedIssue.save();

  const uniqueIssue = new Issue({
    userId: citizenId,
    type: "Streetlight",
    description: "Streetlight completely dark",
    status: "in-progress",
    location: { lat: 13.0900, lng: 80.2800 },
    duplicateStatus: "unique",
    needsReview: false
  });
  await uniqueIssue.save();

  await test("9. Admin filtering by needsReview=true returns only issues requiring review", async () => {
    const req = { query: { needsReview: "true" } };
    const res = createMockRes();

    await adminGetFilteredIssues(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.length, 1);
    assert.strictEqual(res.body[0]._id.toString(), flaggedIssue._id.toString());
    assert.strictEqual(res.body[0].needsReview, true);
  });

  await test("10. Admin filtering by duplicateStatus=flagged_duplicate returns only flagged duplicates", async () => {
    const req = { query: { duplicateStatus: "flagged_duplicate" } };
    const res = createMockRes();

    await adminGetFilteredIssues(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.length, 1);
    assert.strictEqual(res.body[0].duplicateStatus, "flagged_duplicate");
  });

  await test("11. Admin query validates filter parameters and rejects invalid values with 400", async () => {
    const req1 = { query: { status: "invalid_status_xyz" } };
    const res1 = createMockRes();
    await adminGetFilteredIssues(req1, res1);
    assert.strictEqual(res1.statusCode, 400);

    const req2 = { query: { needsReview: "not_a_boolean" } };
    const res2 = createMockRes();
    await adminGetFilteredIssues(req2, res2);
    assert.strictEqual(res2.statusCode, 400);

    const req3 = { query: { duplicateStatus: "unsupported_status" } };
    const res3 = createMockRes();
    await adminGetFilteredIssues(req3, res3);
    assert.strictEqual(res3.statusCode, 400);
  });

  await test("12. Admin issue listing safely populates duplicateOf without internal notes or embeddings", async () => {
    const req = { query: { duplicateStatus: "flagged_duplicate" } };
    const res = createMockRes();

    await adminGetAllIssues(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.length, 1);
    const item = res.body[0];
    assert.ok(item.duplicateOf, "duplicateOf must be populated");
    assert.strictEqual(item.duplicateOf.description, "Original deep pothole on Main St");
    assert.strictEqual(item.duplicateOf.type, "Pothole");
    assert.strictEqual(item.duplicateOf.status, "reported");
    assert.strictEqual(item.duplicateOf.internalNotes, undefined, "Parent internalNotes must NOT be populated");
    assert.strictEqual(item.duplicateOf.embedding, undefined, "Parent embedding must NOT be populated");
  });

  // --------------------------------------------------------------------------
  // Category 4: Review Resolution Actions & Audit Trail
  // --------------------------------------------------------------------------
  console.log("\n--- Category 4: Review Resolution & Audit Trail ---");

  await test("13. Action 'confirm_duplicate' sets reviewResolution: 'confirmed_duplicate' and needsReview: false", async () => {
    const req = {
      params: { id: flaggedIssue._id.toString() },
      body: {
        action: "confirm_duplicate",
        reviewNotes: "Confirmed same pothole from identical photo."
      },
      admin: { adminId: adminId.toString() }
    };
    const res = createMockRes();

    await adminResolveDuplicateReview(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.error, false);
    const updated = res.body.issue;
    assert.strictEqual(updated.reviewResolution, "confirmed_duplicate");
    assert.strictEqual(updated.needsReview, false);
    assert.strictEqual(updated.reviewedBy._id.toString(), adminId.toString());
    assert.ok(updated.reviewedAt, "reviewedAt timestamp must be set");
    assert.strictEqual(updated.reviewNotes, "Confirmed same pothole from identical photo.");
    // Historical AI assessment is preserved separately
    assert.strictEqual(updated.duplicateStatus, "flagged_duplicate");
    assert.strictEqual(updated.similarityScore, 0.94);
  });

  await test("14. Action 'dismiss_duplicate' sets reviewResolution: 'dismissed_unique' and needsReview: false", async () => {
    // Create an unverified issue needing review
    const unverifiedIssue = new Issue({
      userId: citizenId,
      type: "Pothole",
      description: "Another pothole 30m away",
      status: "reported",
      location: { lat: 13.0829, lng: 80.2709 },
      duplicateStatus: "unverified",
      needsReview: true
    });
    await unverifiedIssue.save();

    const req = {
      params: { id: unverifiedIssue._id.toString() },
      body: {
        action: "dismiss_duplicate",
        reviewNotes: "Different pothole on opposite side of street."
      },
      admin: { adminId: adminId.toString() }
    };
    const res = createMockRes();

    await adminResolveDuplicateReview(req, res);

    assert.strictEqual(res.statusCode, 200);
    const updated = res.body.issue;
    assert.strictEqual(updated.reviewResolution, "dismissed_unique");
    assert.strictEqual(updated.needsReview, false);
    assert.strictEqual(updated.reviewedBy._id.toString(), adminId.toString());
    assert.ok(updated.reviewedAt);
    assert.strictEqual(updated.reviewNotes, "Different pothole on opposite side of street.");
  });

  await test("15. Client-supplied reviewedBy and reviewedAt are strictly overridden by authenticated admin ID and server clock", async () => {
    const rogueAdminId = new mongoose.Types.ObjectId();
    const fakePastDate = new Date("2020-01-01T00:00:00Z");

    const targetIssue = new Issue({
      userId: citizenId,
      type: "Pothole",
      description: "Tamper attempt issue",
      location: { lat: 13.0827, lng: 80.2707 },
      duplicateStatus: "flagged_duplicate",
      needsReview: true
    });
    await targetIssue.save();

    const req = {
      params: { id: targetIssue._id.toString() },
      body: {
        action: "confirm_duplicate",
        reviewedBy: rogueAdminId.toString(),
        reviewedAt: fakePastDate
      },
      admin: { adminId: adminId.toString() }
    };
    const res = createMockRes();

    await adminResolveDuplicateReview(req, res);

    assert.strictEqual(res.statusCode, 200);
    const updated = res.body.issue;
    assert.strictEqual(updated.reviewedBy._id.toString(), adminId.toString(), "Must use authenticated admin, not client payload");
    const diffMs = Math.abs(new Date(updated.reviewedAt).getTime() - Date.now());
    assert.ok(diffMs < 5000, "reviewedAt must be set to current server time, ignoring client payload");
  });

  await test("16. Rejects unsupported review actions with 400 Bad Request", async () => {
    const req = {
      params: { id: originalIssue._id.toString() },
      body: { action: "arbitrary_unsupported_action" },
      admin: { adminId: adminId.toString() }
    };
    const res = createMockRes();

    await adminResolveDuplicateReview(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.message.includes("Unsupported review action"));
  });

  await test("17. Rejects malformed issue ID with 400 and non-existent ID with 404", async () => {
    const req1 = {
      params: { id: "not-a-valid-object-id" },
      body: { action: "confirm_duplicate" },
      admin: { adminId: adminId.toString() }
    };
    const res1 = createMockRes();
    await adminResolveDuplicateReview(req1, res1);
    assert.strictEqual(res1.statusCode, 400);

    const nonExistentId = new mongoose.Types.ObjectId();
    const req2 = {
      params: { id: nonExistentId.toString() },
      body: { action: "confirm_duplicate" },
      admin: { adminId: adminId.toString() }
    };
    const res2 = createMockRes();
    await adminResolveDuplicateReview(req2, res2);
    assert.strictEqual(res2.statusCode, 404);
  });

  await test("18. Invariant: Review resolution never deletes or merges citizen issues", async () => {
    const countBefore = await Issue.countDocuments();
    assert.ok(countBefore >= 3);

    // Resolve an issue
    const req = {
      params: { id: flaggedIssue._id.toString() },
      body: { action: "confirm_duplicate" },
      admin: { adminId: adminId.toString() }
    };
    const res = createMockRes();
    await adminResolveDuplicateReview(req, res);

    const countAfter = await Issue.countDocuments();
    assert.strictEqual(countAfter, countBefore, "Total issues count must remain exactly the same");
  });

  // Teardown
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  console.log("\n[Teardown] Disposable test database dropped and disconnected.");

  console.log("==================================================================");
  console.log(`TOTAL PHASE 3.4A TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log("==================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error("Test runner error:", err);
  process.exit(1);
});
