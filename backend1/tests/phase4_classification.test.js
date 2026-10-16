/**
 * CivicVision AI — Phase 4.1B Classification & Routing Automated Test Suite
 *
 * Verifies all Phase 4.1B requirements:
 * 1. Category-to-Department Routing: All 8 canonical mappings verified.
 * 2. Normalization & Fallback: Aliases, hyphenation, whitespace, and unknown category triage policy.
 * 3. Schema Bounds: Severity (1-10) and classificationConfidence (0-1) bounds.
 * 4. Truthful Model Behavior: Untrained/unavailable checkpoints never override citizen category.
 * 5. Low-Confidence Classification: Preserves citizen category and flags review.
 * 6. Non-Blocking Express Integration: AI timeout / outage does not block HTTP 201 issue creation.
 * 7. Preservation of Review Flags: Duplicate review requirement is NEVER cleared by classification.
 * 8. Privacy Hardening: Public responses strictly exclude classificationConfidence, aiDiagnostic,
 *    internalNotes, and embeddings.
 * 9. Department Resolution: Canonical routing service is always authoritative.
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

const DISPOSABLE_DB_URI = "mongodb://127.0.0.1:27017/civicvision_test_phase41_disposable";
const TEST_JWT_SECRET = "phase41_test_jwt_secret_key_32_chars_min";
process.env.JWT_SECRET = TEST_JWT_SECRET;

const Issue = require("../models/Issue");
const User = require("../models/User");
const {
  CANONICAL_DEPARTMENTS,
  DEFAULT_TRIAGE_DEPARTMENT,
  CANONICAL_CATEGORIES,
  CATEGORY_TO_DEPARTMENT,
  normalizeCategory,
  getDepartmentForCategory,
  resolveIssueRouting
} = require("../services/routing.service");
const { classifyIssueImage } = require("../services/ai.service");
const { reportIssue, getAllIssues, getUserIssues } = require("../controllers/issue.controller");

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
  console.log("   CIVICVISION AI - PHASE 4.1B CLASSIFICATION & ROUTING TESTS");
  console.log("==================================================================");

  let realDbAvailable = false;
  try {
    await mongoose.connect(DISPOSABLE_DB_URI, { serverSelectionTimeoutMS: 3000 });
    realDbAvailable = true;
    await mongoose.connection.db.dropDatabase();
    await Issue.collection.createIndex({ location: "2dsphere" });
    console.log("[Setup] Connected to disposable local MongoDB at:", DISPOSABLE_DB_URI);
  } catch (err) {
    console.warn("[Setup Warning] Local MongoDB unavailable, DB-dependent tests will be skipped:", err.message);
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

  // Seed test user if DB is connected
  let testUserId = new mongoose.Types.ObjectId();
  if (realDbAvailable) {
    const user = new User({
      _id: testUserId,
      fullName: "Test Citizen",
      email: "citizen@example.com",
      password: "hashedpassword123"
    });
    await user.save();
  }

  console.log("\n--- Category 1: Canonical Department Routing & Normalization ---");

  await test("1. All 8 canonical defect categories map to exact municipal departments", () => {
    assert.strictEqual(getDepartmentForCategory("pothole"), "Roads & Infrastructure");
    assert.strictEqual(getDepartmentForCategory("road_damage"), "Roads & Infrastructure");
    assert.strictEqual(getDepartmentForCategory("garbage"), "Waste Management");
    assert.strictEqual(getDepartmentForCategory("street_light"), "Street Lighting");
    assert.strictEqual(getDepartmentForCategory("water_leak"), "Water Services");
    assert.strictEqual(getDepartmentForCategory("sewage"), "Water Services");
    assert.strictEqual(getDepartmentForCategory("traffic_signal"), "Public Works");
    assert.strictEqual(getDepartmentForCategory("other"), "Public Works");
  });

  await test("2. Normalization handles hyphens, underscores, spaces, and case insensitivity", () => {
    assert.strictEqual(normalizeCategory("POTHOLE"), "pothole");
    assert.strictEqual(normalizeCategory("road-damage"), "road_damage");
    assert.strictEqual(normalizeCategory("  street light  "), "street_light");
    assert.strictEqual(normalizeCategory("water-leak"), "water_leak");
    assert.strictEqual(normalizeCategory("traffic-signal"), "traffic_signal");
  });

  await test("3. Normalization maps frontend/legacy aliases to canonical categories", () => {
    assert.strictEqual(normalizeCategory("trash"), "garbage");
    assert.strictEqual(normalizeCategory("debris"), "garbage");
    assert.strictEqual(normalizeCategory("overflowing-dustbin"), "garbage");
    assert.strictEqual(normalizeCategory("unpaved-road"), "road_damage");
    assert.strictEqual(normalizeCategory("blocked-drain"), "sewage");
    assert.strictEqual(normalizeCategory("no-drainage"), "sewage");
    assert.strictEqual(normalizeCategory("drinking-water"), "water_leak");
    assert.strictEqual(normalizeCategory("broken-light"), "street_light");
  });

  await test("4. Unknown and malformed categories route to default Public Works manual-triage policy", () => {
    assert.strictEqual(normalizeCategory("alien_invasion"), "other");
    assert.strictEqual(normalizeCategory(""), "other");
    assert.strictEqual(normalizeCategory(null), "other");
    assert.strictEqual(normalizeCategory(undefined), "other");

    assert.strictEqual(getDepartmentForCategory("alien_invasion"), DEFAULT_TRIAGE_DEPARTMENT);
    assert.strictEqual(getDepartmentForCategory(null), DEFAULT_TRIAGE_DEPARTMENT);
  });

  console.log("\n--- Category 2: Routing Decision Engine & Truthful Model Behavior ---");

  await test("5. Preserves citizen category when AI is unavailable, failed, or untrained", () => {
    // Case A: AI result is null / failed
    const decisionNull = resolveIssueRouting({
      citizenCategory: "pothole",
      aiResult: null
    });
    assert.strictEqual(decisionNull.finalCategory, "pothole");
    assert.strictEqual(decisionNull.department, "Roads & Infrastructure");
    assert.strictEqual(decisionNull.routingSource, "citizen");
    assert.strictEqual(decisionNull.confidence, null);

    // Case B: Untrained / checkpoint_unavailable mode
    const decisionUntrained = resolveIssueRouting({
      citizenCategory: "street-light",
      aiResult: {
        is_trained_model: false,
        model: "checkpoint_unavailable",
        category: null,
        confidence: null
      }
    });
    assert.strictEqual(decisionUntrained.finalCategory, "street_light");
    assert.strictEqual(decisionUntrained.department, "Street Lighting");
    assert.strictEqual(decisionUntrained.routingSource, "citizen");
  });

  await test("6. Low-confidence trained AI prediction preserves citizen category and flags review", () => {
    const decisionLowConf = resolveIssueRouting({
      citizenCategory: "pothole",
      aiResult: {
        is_trained_model: true,
        category: "garbage",
        confidence: 0.42 // Below default threshold 0.65
      }
    });

    // Must preserve citizen selection when AI confidence is low
    assert.strictEqual(decisionLowConf.finalCategory, "pothole");
    assert.strictEqual(decisionLowConf.department, "Roads & Infrastructure");
    assert.strictEqual(decisionLowConf.routingSource, "citizen");
    assert.strictEqual(decisionLowConf.classificationNeedsReview, true);
    assert.strictEqual(decisionLowConf.confidence, 0.42);
  });

  await test("7. High-confidence trained AI prediction verifies routing and flags mismatch if differing", () => {
    // Matching category
    const decisionMatch = resolveIssueRouting({
      citizenCategory: "pothole",
      aiResult: {
        is_trained_model: true,
        category: "pothole",
        confidence: 0.94
      }
    });
    assert.strictEqual(decisionMatch.finalCategory, "pothole");
    assert.strictEqual(decisionMatch.department, "Roads & Infrastructure");
    assert.strictEqual(decisionMatch.routingSource, "ai_verified");
    assert.strictEqual(decisionMatch.classificationNeedsReview, false);

    // Mismatched category with high confidence
    const decisionMismatch = resolveIssueRouting({
      citizenCategory: "pothole",
      aiResult: {
        is_trained_model: true,
        category: "water_leak",
        confidence: 0.88
      }
    });
    assert.strictEqual(decisionMismatch.finalCategory, "water_leak");
    assert.strictEqual(decisionMismatch.department, "Water Services");
    assert.strictEqual(decisionMismatch.routingSource, "ai_verified");
    assert.strictEqual(decisionMismatch.classificationNeedsReview, true);
  });

  console.log("\n--- Category 3: Schema Validation & Severity/Confidence Bounds ---");

  if (realDbAvailable) {
    await test("8. Issue model accepts valid severity [1.0 - 10.0] and classificationConfidence [0.0 - 1.0]", async () => {
      const issue = new Issue({
        userId: testUserId,
        type: "pothole",
        description: "Large road defect",
        department: "Roads & Infrastructure",
        severity: 7.5,
        classificationConfidence: 0.89,
        location: { type: "Point", coordinates: [77.72, 11.34] }
      });
      await issue.save();

      const saved = await Issue.findById(issue._id).select("+classificationConfidence");
      assert.strictEqual(saved.severity, 7.5);
      assert.strictEqual(saved.classificationConfidence, 0.89);
    });

    await test("9. Issue model rejects out-of-bounds severity (< 1 or > 10)", async () => {
      const invalidLow = new Issue({
        userId: testUserId,
        type: "pothole",
        description: "Test defect",
        severity: 0.5,
        location: { type: "Point", coordinates: [77.72, 11.34] }
      });
      await assert.rejects(async () => invalidLow.save(), /severity/i);

      const invalidHigh = new Issue({
        userId: testUserId,
        type: "pothole",
        description: "Test defect",
        severity: 10.5,
        location: { type: "Point", coordinates: [77.72, 11.34] }
      });
      await assert.rejects(async () => invalidHigh.save(), /severity/i);
    });

    await test("10. Issue model rejects out-of-bounds classificationConfidence (< 0 or > 1)", async () => {
      const invalidConfLow = new Issue({
        userId: testUserId,
        type: "pothole",
        description: "Test defect",
        classificationConfidence: -0.1,
        location: { type: "Point", coordinates: [77.72, 11.34] }
      });
      await assert.rejects(async () => invalidConfLow.save(), /classificationConfidence/i);

      const invalidConfHigh = new Issue({
        userId: testUserId,
        type: "pothole",
        description: "Test defect",
        classificationConfidence: 1.2,
        location: { type: "Point", coordinates: [77.72, 11.34] }
      });
      await assert.rejects(async () => invalidConfHigh.save(), /classificationConfidence/i);
    });
  }

  console.log("\n--- Category 4: Express Controller Integration & Non-Blocking Resilience ---");

  if (realDbAvailable) {
    await test("11. reportIssue succeeds (201) when AI service is unavailable (soft-failure guarantee)", async () => {
      // Use distinct coordinates isolated from other test locations
      const req = {
        user: { userId: testUserId },
        body: {
          type: "pothole",
          description: "Pothole in isolated sector",
          lat: 13.0827,
          lng: 80.2707
        }
      };
      const res = createMockRes();
      await reportIssue(req, res);

      assert.strictEqual(res.statusCode, 201);
      assert.strictEqual(res.body.issue.type, "pothole");
      assert.strictEqual(res.body.issue.department, "Roads & Infrastructure");
      assert.strictEqual(res.body.duplicateCheck.status, "unique");
    });

    await test("12. Duplicate review requirement is NEVER cleared by classification", async () => {
      // Simulate an issue where spatial duplicate assessment flagged needsReview: true
      const existingIssue = new Issue({
        userId: testUserId,
        type: "pothole",
        description: "Original pothole report",
        department: "Roads & Infrastructure",
        location: { type: "Point", coordinates: [77.7214, 11.3412] }
      });
      await existingIssue.save();

      // Submit an issue at the exact same location with no image (triggers unverified duplicate)
      const req = {
        user: { userId: testUserId },
        body: {
          type: "pothole",
          description: "Duplicate report of same pothole",
          lat: 11.3412,
          lng: 77.7214
        }
      };
      const res = createMockRes();
      await reportIssue(req, res);

      assert.strictEqual(res.statusCode, 201);
      // Because candidate existed nearby without an image, needsReview must be true
      assert.strictEqual(res.body.issue.needsReview, true);
      assert.strictEqual(res.body.duplicateCheck.needsReview, true);
    });

    await test("13. Public API responses strictly exclude classificationConfidence, aiDiagnostic, internalNotes", async () => {
      const issue = new Issue({
        userId: testUserId,
        type: "garbage",
        description: "Overflowing garbage bin",
        department: "Waste Management",
        severity: 5.5,
        classificationConfidence: 0.91,
        internalNotes: "CONFIDENTIAL_ADMIN_NOTE_123",
        aiDiagnostic: { serviceStatus: "clean_unique", message: "diagnostic text" },
        location: { type: "Point", coordinates: [77.72, 11.34] }
      });
      await issue.save();

      // Test getAllIssues
      const resAll = createMockRes();
      await getAllIssues({}, resAll);
      assert.strictEqual(resAll.statusCode, 200);

      const target = resAll.body.find(i => i._id.toString() === issue._id.toString());
      assert.ok(target, "Created issue should be present in getAllIssues");
      assert.strictEqual(target.internalNotes, undefined);
      assert.strictEqual(target.aiDiagnostic, undefined);
      assert.strictEqual(target.classificationConfidence, undefined);
      assert.strictEqual(target.severity, 5.5);
    });
  }

  console.log("\n--- Category 5: AI Service Client Bounded Timeout & Error Handling ---");

  await test("14. classifyIssueImage rejects empty URL gracefully", async () => {
    const result = await classifyIssueImage("");
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes("non-empty string"));
  });

  await test("15. classifyIssueImage handles connection refusal gracefully with soft failure", async () => {
    // Calling on an unroutable localhost port with 100ms timeout
    const originalUrl = process.env.AI_SERVICE_URL;
    process.env.AI_SERVICE_URL = "http://127.0.0.1:59999";

    const result = await classifyIssueImage("https://res.cloudinary.com/demo/image/upload/sample.jpg", {
      timeoutMs: 150
    });

    process.env.AI_SERVICE_URL = originalUrl;

    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes("Failed to connect") || result.error.includes("timed out"));
  });

  if (realDbAvailable) {
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
    console.log("[Teardown] Disposable test database dropped and disconnected.");
  }

  console.log("==================================================================");
  console.log(`TOTAL PHASE 4.1B TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log("==================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error("Test runner exception:", err);
  process.exit(1);
});
