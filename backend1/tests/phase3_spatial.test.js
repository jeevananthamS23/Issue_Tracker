/**
 * CivicVision AI — Phase 3.2 Spatial Proximity & Duplicate Candidate Retrieval Test Suite
 *
 * Verifies all Phase 3.2 requirements against an isolated disposable local database:
 * 1. Haversine distance accuracy and coordinate ordering ([lng, lat])
 * 2. Spatial radius boundaries (points inside included, points outside excluded)
 * 3. Category / defect type filtering
 * 4. Open status filtering for duplicate candidates (suppressing resolved issues)
 * 5. Clean handling of empty results
 * 6. Rejection of malformed coordinates and invalid radius values
 * 7. Strict privacy protection (internalNotes never leaked)
 * 8. Candidate retrieval shortlist bounding (limit caps and self-exclusion)
 * 9. Frontend backward compatibility (location.lat and location.lng virtuals present)
 * 10. HTTP Controller integration for both /nearby and /duplicate-candidates
 */

const assert = require("assert");
const mongoose = require("mongoose");
const Issue = require("../models/Issue");
const {
  haversineDistance,
  validateCoordinates,
  findNearbyIssues,
  retrieveSpatialDuplicateCandidates
} = require("../services/spatial.service");
const {
  getNearbyIssues,
  getDuplicateCandidates
} = require("../controllers/issue.controller");

const DISPOSABLE_DB_URI = "mongodb://127.0.0.1:27017/civicvision_test_spatial_disposable";

let realDbAvailable = false;

async function runTests() {
  console.log("==========================================================");
  console.log("   CIVICVISION AI - PHASE 3.2 SPATIAL & CANDIDATE TESTS");
  console.log("==========================================================");

  try {
    await mongoose.connect(DISPOSABLE_DB_URI, { serverSelectionTimeoutMS: 3000 });
    realDbAvailable = true;
    await mongoose.connection.db.dropDatabase();
    console.log("[Setup] Connected to disposable local MongoDB at:", DISPOSABLE_DB_URI);
  } catch (err) {
    console.warn("[Setup Warning] Local MongoDB unavailable:", err.message);
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

  console.log("\n--- Category 1: Geodesic Calculation & Coordinate Validation ---");

  await test("1. Haversine formula calculates accurate distances in meters", async () => {
    // Erode Bus Stand: 11.3418, 77.7275
    // Erode Railway Station: 11.3283, 77.7268 (~1.5 km south)
    const dist = haversineDistance(11.3418, 77.7275, 11.3283, 77.7268);
    assert.ok(dist > 1400 && dist < 1600, `Expected ~1500m, got ${dist}m`);

    // Zero distance for identical coordinates
    const zeroDist = haversineDistance(11.3418, 77.7275, 11.3418, 77.7275);
    assert.strictEqual(zeroDist, 0, "Distance to self must be 0 meters");
  });

  await test("2. Coordinate bounds validation rejects out-of-range and non-numeric inputs", async () => {
    assert.strictEqual(validateCoordinates(11.34, 77.72), null, "Valid coordinates return null");
    assert.ok(validateCoordinates(95.0, 77.72).includes("Latitude"), "Lat > 90 rejected");
    assert.ok(validateCoordinates(-92.0, 77.72).includes("Latitude"), "Lat < -90 rejected");
    assert.ok(validateCoordinates(11.34, 185.0).includes("Longitude"), "Lng > 180 rejected");
    assert.ok(validateCoordinates(11.34, -185.0).includes("Longitude"), "Lng < -180 rejected");
    assert.ok(validateCoordinates("invalid", 77.72).includes("numerical"), "Non-numeric lat rejected");
  });

  if (!realDbAvailable) {
    console.log("  [SKIPPED REAL DB TESTS - Local MongoDB not available]");
  } else {
    const issuesCollection = mongoose.connection.db.collection("issues");

    // Seed test issues around Erode Reference Point: [77.7275, 11.3418]
    // Point 1: Pothole ~25m away: [77.7277, 11.3419], status: "reported"
    // Point 2: Pothole ~45m away: [77.7279, 11.3420], status: "in-progress"
    // Point 3: Pothole ~35m away: [77.7278, 11.3419], status: "resolved"
    // Point 4: Garbage ~30m away: [77.7277, 11.3420], status: "reported"
    // Point 5: Pothole ~450m away: [77.7315, 11.3425], status: "reported"
    // Point 6: Pothole ~15km away: [77.6000, 11.4500], status: "reported"

    const userId = new mongoose.Types.ObjectId();
    let seededDocs = [];

    await test("3. Seed disposable test dataset and build 2dsphere index", async () => {
      await issuesCollection.deleteMany({});

      const testData = [
        {
          userId,
          type: "Pothole",
          description: "Close open pothole 1",
          status: "reported",
          votes: 3,
          internalNotes: "CONFIDENTIAL_ADMIN_NOTE_1",
          location: { type: "Point", coordinates: [77.7277, 11.3419] }
        },
        {
          userId,
          type: "Pothole",
          description: "Close in-progress pothole 2",
          status: "in-progress",
          votes: 5,
          internalNotes: "CONFIDENTIAL_ADMIN_NOTE_2",
          location: { type: "Point", coordinates: [77.7279, 11.3420] }
        },
        {
          userId,
          type: "Pothole",
          description: "Close resolved pothole 3",
          status: "resolved",
          votes: 10,
          internalNotes: "CONFIDENTIAL_ADMIN_NOTE_3",
          location: { type: "Point", coordinates: [77.7278, 11.3419] }
        },
        {
          userId,
          type: "Garbage",
          description: "Close open garbage",
          status: "reported",
          votes: 1,
          internalNotes: "CONFIDENTIAL_ADMIN_NOTE_4",
          location: { type: "Point", coordinates: [77.7277, 11.3420] }
        },
        {
          userId,
          type: "Pothole",
          description: "Medium distance pothole",
          status: "reported",
          votes: 2,
          internalNotes: "CONFIDENTIAL_ADMIN_NOTE_5",
          location: { type: "Point", coordinates: [77.7315, 11.3425] }
        },
        {
          userId,
          type: "Pothole",
          description: "Far away pothole",
          status: "reported",
          votes: 0,
          internalNotes: "CONFIDENTIAL_ADMIN_NOTE_6",
          location: { type: "Point", coordinates: [77.6000, 11.4500] }
        }
      ];

      seededDocs = await Issue.create(testData);
      assert.strictEqual(seededDocs.length, 6);

      await Issue.createIndexes();
      const indexes = await issuesCollection.indexes();
      const hasGeo = indexes.some(i => i.key && i.key.location === "2dsphere");
      assert.ok(hasGeo, "2dsphere index must be active on issues collection");
    });

    console.log("\n--- Category 2: Spatial Proximity Queries (findNearbyIssues) ---");

    await test("4. Proximity query respects radius boundaries (inside included, outside excluded)", async () => {
      // Query radius 100m from [77.7275, 11.3418]
      const results = await findNearbyIssues({
        lat: 11.3418,
        lng: 77.7275,
        radiusMeters: 100
      });

      // Points 1, 2, 3, 4 are < 100m away. Points 5 (~450m) and 6 (~15km) must be excluded.
      assert.strictEqual(results.length, 4, "Should find exactly 4 points within 100m");
      results.forEach(r => {
        assert.ok(r.distanceMeters <= 100, `Item ${r.description} has distance ${r.distanceMeters}m > 100m`);
        assert.strictEqual(r.internalNotes, undefined, "internalNotes must NOT be exposed");
      });
    });

    await test("5. Category/type filtering restricts proximity results to matching category", async () => {
      // Within 100m, filter only type="Garbage"
      const garbageResults = await findNearbyIssues({
        lat: 11.3418,
        lng: 77.7275,
        radiusMeters: 100,
        type: "Garbage"
      });

      assert.strictEqual(garbageResults.length, 1, "Only 1 garbage issue within 100m");
      assert.strictEqual(garbageResults[0].type, "Garbage");
      assert.strictEqual(garbageResults[0].description, "Close open garbage");
    });

    await test("6. Status filtering supports 'open', 'all', and specific status", async () => {
      // Query open issues only within 100m for Pothole (reported + in-progress, excluding resolved)
      const openPotholes = await findNearbyIssues({
        lat: 11.3418,
        lng: 77.7275,
        radiusMeters: 100,
        type: "Pothole",
        status: "open"
      });

      assert.strictEqual(openPotholes.length, 2, "Should return 2 open potholes (excluding resolved)");
      openPotholes.forEach(p => {
        assert.ok(["reported", "in-progress"].includes(p.status), `Unexpected status: ${p.status}`);
      });

      // Query resolved issues only
      const resolvedPotholes = await findNearbyIssues({
        lat: 11.3418,
        lng: 77.7275,
        radiusMeters: 100,
        type: "Pothole",
        status: "resolved"
      });
      assert.strictEqual(resolvedPotholes.length, 1);
      assert.strictEqual(resolvedPotholes[0].status, "resolved");
    });

    console.log("\n--- Category 3: Spatial Duplicate Candidate Retrieval (Stage 1) ---");

    await test("7. Duplicate candidate retrieval shortlists nearby open issues of same category (default 50m)", async () => {
      // A new report comes in at [77.7275, 11.3418] with type="Pothole"
      const candidates = await retrieveSpatialDuplicateCandidates({
        lat: 11.3418,
        lng: 77.7275,
        type: "Pothole",
        radiusMeters: 50 // Section VI-C threshold
      });

      // Must find:
      // Point 1: Pothole ~25m away (reported)
      // Point 2: Pothole ~45m away (in-progress)
      // Must NOT find:
      // Point 3: resolved pothole (resolved issues do not suppress new reports)
      // Point 4: garbage issue (different defect category)
      // Point 5: pothole 450m away (exceeds 50m threshold)
      assert.strictEqual(candidates.length, 2, "Expected exactly 2 duplicate candidates");
      candidates.forEach(c => {
        assert.strictEqual(c.type, "Pothole", "Candidate must match defect category");
        assert.ok(["reported", "in-progress"].includes(c.status), "Only open defects can be duplicate candidates");
        assert.ok(c.distanceMeters <= 50, `Distance ${c.distanceMeters}m must be <= 50m threshold`);
        assert.strictEqual(c.internalNotes, undefined, "Confidential notes stripped");
      });
    });

    await test("8. Duplicate candidate retrieval respects self-exclusion (excludeIssueId)", async () => {
      const existingIssueId = seededDocs[0]._id.toString();

      const candidates = await retrieveSpatialDuplicateCandidates({
        lat: 11.3418,
        lng: 77.7275,
        type: "Pothole",
        radiusMeters: 50,
        excludeIssueId: existingIssueId
      });

      assert.strictEqual(candidates.length, 1, "Excluded issue must not appear in candidate list");
      assert.notStrictEqual(candidates[0]._id.toString(), existingIssueId);
    });

    await test("9. Empty result handling returns clean empty array without errors", async () => {
      // Query coordinate in middle of the ocean
      const oceanResults = await findNearbyIssues({
        lat: 0.0,
        lng: 0.0,
        radiusMeters: 500
      });
      assert.deepStrictEqual(oceanResults, []);

      // Query non-existent defect type
      const noCandidates = await retrieveSpatialDuplicateCandidates({
        lat: 11.3418,
        lng: 77.7275,
        type: "NonExistentCategory",
        radiusMeters: 50
      });
      assert.deepStrictEqual(noCandidates, []);
    });

    console.log("\n--- Category 4: HTTP Controller Integration & Edge Cases ---");

    await test("10. GET /api/issues/nearby controller handles filters and input validation", async () => {
      let responseData = null;
      let statusCode = 200;

      const mockRes = {
        status: code => {
          statusCode = code;
          return { json: data => { responseData = data; } };
        }
      };

      // Valid call with filters
      await getNearbyIssues(
        { query: { lat: "11.3418", lng: "77.7275", radius: "100", type: "Pothole", status: "open" } },
        mockRes
      );
      assert.strictEqual(statusCode, 200);
      assert.strictEqual(responseData.length, 2);
      assert.ok(responseData[0].location.lat !== undefined, "virtual lat present for frontend maps");
      assert.ok(responseData[0].location.lng !== undefined, "virtual lng present for frontend maps");
      assert.ok(responseData[0].distanceMeters !== undefined, "distanceMeters annotated");

      // Invalid latitude (out of bounds)
      await getNearbyIssues(
        { query: { lat: "95.0", lng: "77.7275" } },
        mockRes
      );
      assert.strictEqual(statusCode, 400);
      assert.ok(responseData.error);
      assert.ok(responseData.message.includes("Latitude"));

      // Negative radius
      await getNearbyIssues(
        { query: { lat: "11.3418", lng: "77.7275", radius: "-50" } },
        mockRes
      );
      assert.strictEqual(statusCode, 400);
      assert.ok(responseData.error);
    });

    await test("11. GET /api/issues/duplicate-candidates controller returns bounded candidate contract", async () => {
      let responseData = null;
      let statusCode = 200;

      const mockRes = {
        status: code => {
          statusCode = code;
          return { json: data => { responseData = data; } };
        }
      };

      // Valid candidate retrieval
      await getDuplicateCandidates(
        { query: { lat: "11.3418", lng: "77.7275", type: "Pothole", radius: "50" } },
        mockRes
      );
      assert.strictEqual(statusCode, 200);
      assert.strictEqual(responseData.count, 2);
      assert.strictEqual(responseData.thresholdMeters, 50);
      assert.strictEqual(responseData.candidates.length, 2);

      // Missing type parameter returns 400
      await getDuplicateCandidates(
        { query: { lat: "11.3418", lng: "77.7275" } },
        mockRes
      );
      assert.strictEqual(statusCode, 400);
      assert.ok(responseData.message.includes("Defect type"));
    });

    await test("12. Candidate retrieval limit strictly bounds candidate count for Stage 2 CLIP", async () => {
      let responseData = null;
      const mockRes = {
        status: () => ({ json: data => { responseData = data; } })
      };

      // Request with limit=1
      await getDuplicateCandidates(
        { query: { lat: "11.3418", lng: "77.7275", type: "Pothole", radius: "50", limit: "1" } },
        mockRes
      );
      assert.strictEqual(responseData.candidates.length, 1, "Candidate set must be capped by limit=1");
    });
  }

  // Teardown
  if (realDbAvailable) {
    try {
      await mongoose.connection.db.dropDatabase();
      await mongoose.disconnect();
      console.log("[Teardown] Disposable spatial test database dropped and disconnected.");
    } catch (e) {
      console.warn("[Teardown Warning]", e.message);
    }
  }

  console.log("\n==========================================================");
  console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log("==========================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
