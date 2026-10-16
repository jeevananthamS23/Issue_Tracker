/**
 * CivicVision AI — Phase 4.2A Review-State Decoupling & Integrity Test Suite
 *
 * Verifies:
 * 1. Independent Review Reasons:
 *    - `needsDuplicateReview` and `needsClassificationReview` operate independently.
 *    - Consolidated `needsReview` is strictly derived from all outstanding review reasons.
 * 2. Duplicate Review Resolution Integrity:
 *    - Resolving or dismissing duplicate review sets `needsDuplicateReview: false`.
 *    - If `needsClassificationReview` is true, consolidated `needsReview` remains TRUE.
 * 3. Classification Review Resolution Integrity:
 *    - Dedicated endpoint `PATCH /issues/:id/classification-review` resolves classification review.
 *    - Resolving classification review sets `needsClassificationReview: false`.
 *    - If `needsDuplicateReview` is true, consolidated `needsReview` remains TRUE.
 * 4. Full Sequential Resolution:
 *    - When all outstanding reasons are resolved, `needsReview` becomes FALSE.
 * 5. Backward Compatibility:
 *    - `PATCH /issues/:id` preserves decoupled states and does not clear unresolved reasons.
 *    - Filter by `needsReview=true` returns issues with any unresolved reason.
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

const DISPOSABLE_DB_URI = "mongodb://127.0.0.1:27017/civicvision_test_phase42a_disposable";
const TEST_JWT_SECRET = process.env.JWT_SECRET || "phase42a_test_jwt_secret_key_32_chars_min";
process.env.JWT_SECRET = TEST_JWT_SECRET;

const Issue = require("../models/Issue");
const Admin = require("../models/Admin");
const User = require("../models/User");
const {
  getAllIssues: adminGetAllIssues,
  getFilteredIssues: adminGetFilteredIssues,
  updateIssueStatus: adminUpdateIssueStatus,
  resolveDuplicateReview: adminResolveDuplicateReview,
  resolveClassificationReview: adminResolveClassificationReview
} = require("../controllers/adminDashboard.controller");

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
let testUserId;

async function setup() {
  await mongoose.connect(DISPOSABLE_DB_URI, { autoIndex: false });
  await mongoose.connection.dropDatabase();

  const user = await User.create({
    fullName: "Citizen Citizen",
    email: "citizen_p42a@example.com",
    password: "Password123!"
  });
  testUserId = user._id;

  const admin = await Admin.create({
    fullName: "Admin Reviewer",
    email: "admin_reviewer_p42a@example.com",
    password: "Password123!"
  });
  testAdminId = admin._id;
  testAdminToken = jwt.sign(
    { adminId: admin._id, email: admin.email, role: "admin" },
    TEST_JWT_SECRET,
    { expiresIn: "1h" }
  );
}

async function teardown() {
  try {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  } catch (err) {
    // Graceful disconnect
  }
}

async function runTests() {
  console.log("==================================================================");
  console.log("   CIVICVISION AI - PHASE 4.2A REVIEW DECOUPLING & INTEGRITY TESTS");
  console.log("==================================================================");

  let passed = 0;
  let failed = 0;

  function recordPass(desc) {
    console.log(`  ✓ PASS: ${desc}`);
    passed++;
  }

  function recordFail(desc, err) {
    console.error(`  ✗ FAIL: ${desc}`);
    console.error(err);
    failed++;
  }

  await setup();

  // Test 1: Model pre-save derivation for individual and combined states
  try {
    const issueDupOnly = new Issue({
      userId: testUserId,
      type: "pothole",
      description: "Pothole needing duplicate review only",
      location: { type: "Point", coordinates: [77.72, 11.34] },
      needsDuplicateReview: true,
      needsClassificationReview: false
    });
    await issueDupOnly.save();
    assert.strictEqual(issueDupOnly.needsReview, true, "needsReview should be true when needsDuplicateReview is true");

    const issueClassOnly = new Issue({
      userId: testUserId,
      type: "garbage",
      description: "Garbage needing classification review only",
      location: { type: "Point", coordinates: [77.73, 11.35] },
      needsDuplicateReview: false,
      needsClassificationReview: true
    });
    await issueClassOnly.save();
    assert.strictEqual(issueClassOnly.needsReview, true, "needsReview should be true when needsClassificationReview is true");

    const issueBoth = new Issue({
      userId: testUserId,
      type: "water_leak",
      description: "Issue needing both reviews",
      location: { type: "Point", coordinates: [77.74, 11.36] },
      needsDuplicateReview: true,
      needsClassificationReview: true
    });
    await issueBoth.save();
    assert.strictEqual(issueBoth.needsReview, true, "needsReview should be true when both review reasons are true");

    const issueNeither = new Issue({
      userId: testUserId,
      type: "street_light",
      description: "Issue needing no reviews",
      location: { type: "Point", coordinates: [77.75, 11.37] },
      needsDuplicateReview: false,
      needsClassificationReview: false
    });
    await issueNeither.save();
    assert.strictEqual(issueNeither.needsReview, false, "needsReview should be false when both reasons are false");

    recordPass("1. Issue schema derives consolidated needsReview from outstanding reasons");
  } catch (err) {
    recordFail("1. Issue schema derives consolidated needsReview from outstanding reasons", err);
  }

  // Test 2: Resolving duplicate review on duplicate-only issue clears needsReview
  try {
    const issue = await Issue.create({
      userId: testUserId,
      type: "pothole",
      description: "Duplicate only resolution test",
      location: { type: "Point", coordinates: [77.72, 11.34] },
      duplicateStatus: "flagged_duplicate",
      needsDuplicateReview: true,
      needsClassificationReview: false
    });

    const req = {
      params: { id: issue._id.toString() },
      body: { action: "confirm_duplicate", reviewNotes: "Confirmed duplicate of parent" },
      admin: { adminId: testAdminId }
    };
    const res = createMockRes();

    await adminResolveDuplicateReview(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.issue.needsDuplicateReview, false);
    assert.strictEqual(res.body.issue.needsClassificationReview, false);
    assert.strictEqual(res.body.issue.needsReview, false);
    assert.strictEqual(res.body.issue.reviewResolution, "confirmed_duplicate");

    // Double check persisted document
    const updated = await Issue.findById(issue._id);
    assert.strictEqual(updated.needsDuplicateReview, false);
    assert.strictEqual(updated.needsReview, false);

    recordPass("2. Resolving duplicate-only issue sets needsReview: false");
  } catch (err) {
    recordFail("2. Resolving duplicate-only issue sets needsReview: false", err);
  }

  // Test 3: Dismissing duplicate review on duplicate-only issue sets needsReview: false
  try {
    const issue = await Issue.create({
      userId: testUserId,
      type: "pothole",
      description: "Duplicate dismiss test",
      location: { type: "Point", coordinates: [77.72, 11.34] },
      duplicateStatus: "suspected_duplicate",
      needsDuplicateReview: true,
      needsClassificationReview: false
    });

    const req = {
      params: { id: issue._id.toString() },
      body: { action: "dismiss_duplicate", reviewNotes: "Distinct pothole location" },
      admin: { adminId: testAdminId }
    };
    const res = createMockRes();

    await adminResolveDuplicateReview(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.issue.needsDuplicateReview, false);
    assert.strictEqual(res.body.issue.needsReview, false);
    assert.strictEqual(res.body.issue.reviewResolution, "dismissed_unique");

    recordPass("3. Dismissing duplicate-only issue sets needsReview: false");
  } catch (err) {
    recordFail("3. Dismissing duplicate-only issue sets needsReview: false", err);
  }

  // Test 4: CRUCIAL: Resolving duplicate review on combined issue MUST NOT clear unresolved classification review
  try {
    const combinedIssue = await Issue.create({
      userId: testUserId,
      type: "road_damage",
      description: "Combined review issue",
      location: { type: "Point", coordinates: [77.72, 11.34] },
      duplicateStatus: "flagged_duplicate",
      needsDuplicateReview: true,
      needsClassificationReview: true,
      department: "Public Works"
    });

    const req = {
      params: { id: combinedIssue._id.toString() },
      body: { action: "dismiss_duplicate", reviewNotes: "Not a duplicate" },
      admin: { adminId: testAdminId }
    };
    const res = createMockRes();

    await adminResolveDuplicateReview(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.issue.needsDuplicateReview, false);
    assert.strictEqual(res.body.issue.needsClassificationReview, true, "needsClassificationReview must remain true");
    assert.strictEqual(res.body.issue.needsReview, true, "consolidated needsReview must remain true!");

    const updated = await Issue.findById(combinedIssue._id);
    assert.strictEqual(updated.needsDuplicateReview, false);
    assert.strictEqual(updated.needsClassificationReview, true);
    assert.strictEqual(updated.needsReview, true);

    recordPass("4. Resolving duplicate review on combined issue PRESERVES classification review and needsReview: true");
  } catch (err) {
    recordFail("4. Resolving duplicate review on combined issue PRESERVES classification review and needsReview: true", err);
  }

  // Test 5: Resolving classification review on classification-only issue sets needsReview: false
  try {
    const classIssue = await Issue.create({
      userId: testUserId,
      type: "garbage",
      description: "Unverified category",
      location: { type: "Point", coordinates: [77.72, 11.34] },
      needsDuplicateReview: false,
      needsClassificationReview: true,
      department: "Public Works"
    });

    const req = {
      params: { id: classIssue._id.toString() },
      body: {
        action: "confirmed_category",
        department: "Waste Management",
        reviewNotes: "Triage confirmed waste management"
      },
      admin: { adminId: testAdminId }
    };
    const res = createMockRes();

    await adminResolveClassificationReview(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.issue.needsClassificationReview, false);
    assert.strictEqual(res.body.issue.needsDuplicateReview, false);
    assert.strictEqual(res.body.issue.needsReview, false);
    assert.strictEqual(res.body.issue.classificationReviewResolution, "confirmed_category");
    assert.strictEqual(res.body.issue.department, "Waste Management");

    const updated = await Issue.findById(classIssue._id);
    assert.strictEqual(updated.needsClassificationReview, false);
    assert.strictEqual(updated.needsReview, false);

    recordPass("5. Dedicated resolveClassificationReview resolves triage and clears needsReview when no duplicate review pending");
  } catch (err) {
    recordFail("5. Dedicated resolveClassificationReview resolves triage and clears needsReview when no duplicate review pending", err);
  }

  // Test 6: Resolving classification review on combined issue PRESERVES pending duplicate review
  try {
    const combinedIssue2 = await Issue.create({
      userId: testUserId,
      type: "water_leak",
      description: "Water leak with duplicate & classification flags",
      location: { type: "Point", coordinates: [77.72, 11.34] },
      duplicateStatus: "flagged_duplicate",
      needsDuplicateReview: true,
      needsClassificationReview: true,
      department: "Public Works"
    });

    const req = {
      params: { id: combinedIssue2._id.toString() },
      body: {
        action: "reclassified",
        type: "water_leak",
        department: "Water Services",
        reviewNotes: "Category corrected to water services"
      },
      admin: { adminId: testAdminId }
    };
    const res = createMockRes();

    await adminResolveClassificationReview(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.issue.needsClassificationReview, false);
    assert.strictEqual(res.body.issue.needsDuplicateReview, true, "needsDuplicateReview must remain true");
    assert.strictEqual(res.body.issue.needsReview, true, "consolidated needsReview must remain true!");
    assert.strictEqual(res.body.issue.classificationReviewResolution, "reclassified");

    const updated = await Issue.findById(combinedIssue2._id);
    assert.strictEqual(updated.needsDuplicateReview, true);
    assert.strictEqual(updated.needsClassificationReview, false);
    assert.strictEqual(updated.needsReview, true);

    recordPass("6. Resolving classification review on combined issue PRESERVES duplicate review and needsReview: true");
  } catch (err) {
    recordFail("6. Resolving classification review on combined issue PRESERVES duplicate review and needsReview: true", err);
  }

  // Test 7: Sequential full resolution: Resolving both reasons clears needsReview
  try {
    const issue = await Issue.create({
      userId: testUserId,
      type: "street_light",
      description: "Sequential resolution test",
      location: { type: "Point", coordinates: [77.72, 11.34] },
      duplicateStatus: "flagged_duplicate",
      needsDuplicateReview: true,
      needsClassificationReview: true
    });

    // Step A: Resolve duplicate review
    const req1 = {
      params: { id: issue._id.toString() },
      body: { action: "confirm_duplicate" },
      admin: { adminId: testAdminId }
    };
    const res1 = createMockRes();
    await adminResolveDuplicateReview(req1, res1);
    assert.strictEqual(res1.body.issue.needsDuplicateReview, false);
    assert.strictEqual(res1.body.issue.needsClassificationReview, true);
    assert.strictEqual(res1.body.issue.needsReview, true);

    // Step B: Resolve classification review
    const req2 = {
      params: { id: issue._id.toString() },
      body: { action: "confirmed_category" },
      admin: { adminId: testAdminId }
    };
    const res2 = createMockRes();
    await adminResolveClassificationReview(req2, res2);
    assert.strictEqual(res2.body.issue.needsDuplicateReview, false);
    assert.strictEqual(res2.body.issue.needsClassificationReview, false);
    assert.strictEqual(res2.body.issue.needsReview, false);

    const finalDoc = await Issue.findById(issue._id);
    assert.strictEqual(finalDoc.needsReview, false);

    recordPass("7. Sequential resolution of both review reasons clears consolidated needsReview only when all are resolved");
  } catch (err) {
    recordFail("7. Sequential resolution of both review reasons clears consolidated needsReview only when all are resolved", err);
  }

  // Test 8: Backward-compatible updateIssueStatus endpoint with partial resolution
  try {
    const issue = await Issue.create({
      userId: testUserId,
      type: "pothole",
      description: "Legacy endpoint test",
      location: { type: "Point", coordinates: [77.72, 11.34] },
      duplicateStatus: "suspected_duplicate",
      needsDuplicateReview: true,
      needsClassificationReview: true,
      status: "reported"
    });

    // Update status to in-progress only: neither review should be cleared
    const reqStatus = {
      params: { id: issue._id.toString() },
      body: { status: "in-progress" },
      admin: { adminId: testAdminId }
    };
    const resStatus = createMockRes();
    await adminUpdateIssueStatus(reqStatus, resStatus);
    assert.strictEqual(resStatus.statusCode, 200);
    assert.strictEqual(resStatus.body.status, "in-progress");
    assert.strictEqual(resStatus.body.needsDuplicateReview, true);
    assert.strictEqual(resStatus.body.needsClassificationReview, true);
    assert.strictEqual(resStatus.body.needsReview, true);

    // Now resolve duplicate review via legacy endpoint
    const reqDup = {
      params: { id: issue._id.toString() },
      body: { action: "dismiss_duplicate" },
      admin: { adminId: testAdminId }
    };
    const resDup = createMockRes();
    await adminUpdateIssueStatus(reqDup, resDup);
    assert.strictEqual(resDup.statusCode, 200);
    assert.strictEqual(resDup.body.needsDuplicateReview, false);
    assert.strictEqual(resDup.body.needsClassificationReview, true);
    assert.strictEqual(resDup.body.needsReview, true);

    recordPass("8. Backward-compatible updateIssueStatus preserves unresolved review reasons");
  } catch (err) {
    recordFail("8. Backward-compatible updateIssueStatus preserves unresolved review reasons", err);
  }

  // Test 9: Input validation: reject unauthorized and invalid actions
  try {
    const issue = await Issue.create({
      userId: testUserId,
      type: "traffic_signal",
      description: "Validation test",
      location: { type: "Point", coordinates: [77.72, 11.34] },
      needsClassificationReview: true
    });

    // Missing admin credentials
    const reqNoAdmin = {
      params: { id: issue._id.toString() },
      body: { action: "confirmed_category" },
      admin: null
    };
    const resNoAdmin = createMockRes();
    await adminResolveClassificationReview(reqNoAdmin, resNoAdmin);
    assert.strictEqual(resNoAdmin.statusCode, 403);

    // Invalid action
    const reqBadAction = {
      params: { id: issue._id.toString() },
      body: { action: "auto_approve_unknown" },
      admin: { adminId: testAdminId }
    };
    const resBadAction = createMockRes();
    await adminResolveClassificationReview(reqBadAction, resBadAction);
    assert.strictEqual(resBadAction.statusCode, 400);

    recordPass("9. resolveClassificationReview enforces admin authorization and valid actions");
  } catch (err) {
    recordFail("9. resolveClassificationReview enforces admin authorization and valid actions", err);
  }

  // Test 10: Filtering by needsReview=true returns issues requiring either review
  try {
    const reqFilter = {
      query: { needsReview: "true" }
    };
    const resFilter = createMockRes();
    await adminGetFilteredIssues(reqFilter, resFilter);
    assert.strictEqual(resFilter.statusCode, 200);
    assert.ok(Array.isArray(resFilter.body));
    for (const item of resFilter.body) {
      assert.strictEqual(item.needsReview, true, `Issue ${item._id} must have needsReview: true`);
    }

    recordPass("10. Admin filtered query returns all issues where consolidated needsReview is true");
  } catch (err) {
    recordFail("10. Admin filtered query returns all issues where consolidated needsReview is true", err);
  }

  await teardown();

  console.log("==================================================================");
  console.log(`TOTAL PHASE 4.2A TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log("==================================================================");

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error("Test harness failed:", err);
  process.exit(1);
});
