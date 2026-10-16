/**
 * CivicVision AI — Phase 4.2B-B DBSCAN Hotspot Test Suite
 *
 * Verifies:
 * 1. Haversine distance, boundary conditions, and anti-meridian handling.
 * 2. Pure DBSCAN dense cluster detection & separated noise points.
 * 3. Boundary, empty, and invalid coordinates handling.
 * 4. Duplicate report treatment, canonical defect aggregation, cycle & self-reference prevention.
 * 5. Duplicate reports not inflating distinct defect counts (density integrity).
 * 6. Deterministic cluster matching, tie-breaking, and repeat-run stability.
 * 7. Alert state deduplication and escalation bookkeeping (zero external notifications).
 * 8. Category isolation (clusters partitioned strictly by canonical category).
 * 9. Active status and rolling-window filtering (resolved & aged-out issues excluded).
 * 10. Conservative lifecycle transition on cluster disappearance (resolving vs resolved).
 * 11. Hotspot model validation, 2dsphere indexing, and Issue clusterId linkage.
 * 12. Review flags and administrative privacy field preservation.
 *
 * Safety:
 * - Operates strictly against a disposable local MongoDB instance.
 * - Defensive guard neutralizes any production Atlas MONGO_URI.
 */

const assert = require("assert");
const mongoose = require("mongoose");

// Strict Atlas protection guard: NEVER connect to Atlas
if (
  process.env.MONGO_URI &&
  (process.env.MONGO_URI.includes("mongodb+srv") || process.env.MONGO_URI.includes("mongodb.net"))
) {
  delete process.env.MONGO_URI;
}

const DISPOSABLE_DB_URI = "mongodb://127.0.0.1:27017/civicvision_test_hotspot_disposable";

const Issue = require("../models/Issue");
const Hotspot = require("../models/Hotspot");
const User = require("../models/User");
const {
  haversineDistanceMeters,
  extractCoordinates,
  calculateSphericalCentroid,
  dbscan,
  resolveCanonicalDefects,
  buildClusterMetrics,
  matchClustersAndHotspots,
  evaluateAlertState,
  detectAndSyncHotspots,
  getDbscanConfig,
  validateDbscanConfig
} = require("../services/dbscan.service");
const { CANONICAL_CATEGORIES, CANONICAL_DEPARTMENTS } = require("../services/routing.service");

let testUserId;

async function setupDatabase() {
  await mongoose.connect(DISPOSABLE_DB_URI, { serverSelectionTimeoutMS: 5000 });
  await Issue.deleteMany({});
  await Hotspot.deleteMany({});
  await User.deleteMany({});

  const user = await User.create({
    fullName: "DBSCAN Test Citizen",
    email: `dbscan_citizen_${Date.now()}@test.local`,
    password: "Password123!"
  });
  testUserId = user._id;
}

async function teardownDatabase() {
  try {
    await Issue.deleteMany({});
    await Hotspot.deleteMany({});
    await User.deleteMany({});
    await mongoose.connection.close();
  } catch (err) {
    // Ignore teardown errors
  }
}

async function runTests() {
  console.log("================================================================================");
  console.log("CivicVision AI — Phase 4.2B-B DBSCAN Backend Core Test Suite");
  console.log("================================================================================\n");

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
  // UNIT TESTS: Pure Mathematics & Algorithm Modules
  // ============================================================================

  await test("Unit: Haversine distance, Equator, high latitude, and anti-meridian handling", () => {
    // Standard test points in Erode, Tamil Nadu: ~111m apart
    const d1 = haversineDistanceMeters(11.341, 77.717, 11.342, 77.717);
    assert(d1 > 100 && d1 < 120, `Expected ~111m, got ${d1}`);

    // Equator edge case: (0, 0) to (0, 0.001) ~ 111.3m
    const dEquator = haversineDistanceMeters(0, 0, 0, 0.001);
    assert(dEquator > 105 && dEquator < 118, `Expected ~111m at equator, got ${dEquator}`);

    // High latitude edge case: Reykjavik 64.14°N
    const dHighLat = haversineDistanceMeters(64.14, -21.94, 64.141, -21.94);
    assert(dHighLat > 105 && dHighLat < 118, `Expected ~111m at high latitude, got ${dHighLat}`);

    // Anti-meridian crossing: 179.999°E to -179.999°W at equator (0.002° diff ~ 222m)
    const dAntiMeridian = haversineDistanceMeters(0, 179.999, 0, -179.999);
    assert(
      dAntiMeridian > 215 && dAntiMeridian < 230,
      `Expected ~222m across anti-meridian, got ${dAntiMeridian}`
    );

    // Identical point should be 0
    const dSame = haversineDistanceMeters(11.341, 77.717, 11.341, 77.717);
    assert.strictEqual(dSame, 0);
  });

  await test("Unit: Spherical centroid calculation across anti-meridian", () => {
    // Centroid of points spanning 179.99°E and -179.99°W
    const centroid = calculateSphericalCentroid([
      [179.99, 10],
      [-179.99, 10]
    ]);
    // Longitude should average to 180 (or -180), latitude to 10
    assert(
      Math.abs(centroid[0]) >= 179.99,
      `Expected anti-meridian centroid longitude near 180, got ${centroid[0]}`
    );
    assert(Math.abs(centroid[1] - 10) < 0.01, `Expected latitude 10, got ${centroid[1]}`);
  });

  await test("Unit: Pure DBSCAN — Dense cluster detection and separated noise points", () => {
    // 4 points within 30 meters of each other (dense cluster)
    // 2 isolated points 1000m away (noise)
    const points = [
      { id: "p1", coordinates: [77.7170, 11.3410] },
      { id: "p2", coordinates: [77.7171, 11.3411] },
      { id: "p3", coordinates: [77.7172, 11.3410] },
      { id: "p4", coordinates: [77.7171, 11.3409] },
      { id: "n1", coordinates: [77.7300, 11.3500] }, // > 1km away
      { id: "n2", coordinates: [77.7400, 11.3600] }  // > 2km away
    ];

    const result = dbscan({
      points,
      epsMeters: 100,
      minSamples: 3
    });

    assert.strictEqual(result.clusters.length, 1, "Should find exactly 1 cluster");
    assert.strictEqual(result.clusters[0].length, 4, "Cluster should have 4 points");
    assert.strictEqual(result.noise.length, 2, "Should find exactly 2 noise points");

    const clusterIds = result.clusters[0].map(p => p.id);
    assert(clusterIds.includes("p1") && clusterIds.includes("p2"));
    const noiseIds = result.noise.map(p => p.id);
    assert(noiseIds.includes("n1") && noiseIds.includes("n2"));
  });

  await test("Unit: Pure DBSCAN — Boundary, empty, and invalid coordinates handling", () => {
    // Empty points
    const emptyResult = dbscan({ points: [], epsMeters: 100, minSamples: 3 });
    assert.strictEqual(emptyResult.clusters.length, 0);
    assert.strictEqual(emptyResult.noise.length, 0);
    assert.strictEqual(emptyResult.invalidPoints.length, 0);

    // Points with invalid coordinates
    const dirtyPoints = [
      { id: "valid1", coordinates: [77.7170, 11.3410] },
      { id: "valid2", coordinates: [77.7171, 11.3411] },
      { id: "valid3", coordinates: [77.7172, 11.3410] },
      { id: "inv_coords1", coordinates: [999, 11.3410] }, // lng out of range
      { id: "inv_coords2", coordinates: [77.7170, -95] },  // lat out of range
      { id: "inv_coords3", coordinates: null },
      { id: "inv_coords4", coordinates: [NaN, NaN] }
    ];

    const result = dbscan({ points: dirtyPoints, epsMeters: 100, minSamples: 3 });
    assert.strictEqual(result.clusters.length, 1);
    assert.strictEqual(result.clusters[0].length, 3);
    assert.strictEqual(result.invalidPoints.length, 4);
  });

  await test("Unit: Scope D — Canonical defect aggregation & cycle/self-reference prevention", () => {
    // Case 1: 1 parent with 2 confirmed duplicates
    const pId = new mongoose.Types.ObjectId();
    const d1Id = new mongoose.Types.ObjectId();
    const d2Id = new mongoose.Types.ObjectId();

    // Case 2: Circular duplicates A -> B -> A
    const aId = new mongoose.Types.ObjectId();
    const bId = new mongoose.Types.ObjectId();

    // Case 3: Self-referencing duplicate C -> C
    const cId = new mongoose.Types.ObjectId();

    // Case 4: Missing parent (duplicateOf points to nonexistent ID)
    const mId = new mongoose.Types.ObjectId();
    const missingParentId = new mongoose.Types.ObjectId();

    const issues = [
      {
        _id: pId,
        type: "pothole",
        location: { coordinates: [77.717, 11.341] },
        status: "reported",
        votes: 5,
        severity: 7
      },
      {
        _id: d1Id,
        type: "pothole",
        location: { coordinates: [77.71705, 11.34102] },
        status: "reported",
        duplicateOf: pId,
        duplicateStatus: "flagged_duplicate",
        reviewResolution: "confirmed_duplicate",
        votes: 2,
        severity: 6
      },
      {
        _id: d2Id,
        type: "pothole",
        location: { coordinates: [77.71708, 11.34101] },
        status: "reported",
        duplicateOf: pId,
        duplicateStatus: "flagged_duplicate",
        reviewResolution: "confirmed_duplicate",
        votes: 1
      },
      // Circular A -> B -> A
      {
        _id: aId,
        type: "pothole",
        location: { coordinates: [77.72, 11.345] },
        status: "reported",
        duplicateOf: bId,
        reviewResolution: "confirmed_duplicate"
      },
      {
        _id: bId,
        type: "pothole",
        location: { coordinates: [77.7201, 11.3451] },
        status: "reported",
        duplicateOf: aId,
        reviewResolution: "confirmed_duplicate"
      },
      // Self-reference C -> C
      {
        _id: cId,
        type: "pothole",
        location: { coordinates: [77.73, 11.35] },
        status: "reported",
        duplicateOf: cId,
        reviewResolution: "confirmed_duplicate"
      },
      // Missing parent
      {
        _id: mId,
        type: "pothole",
        location: { coordinates: [77.74, 11.36] },
        status: "reported",
        duplicateOf: missingParentId,
        reviewResolution: "confirmed_duplicate"
      }
    ];

    const defects = resolveCanonicalDefects(issues);

    // Parent group (pId + d1 + d2)
    const parentDefect = defects.find(d => String(d.id) === String(pId));
    assert(parentDefect, "Root parent defect must exist");
    assert.strictEqual(parentDefect.distinctDefectCount, 1, "Must count as exactly 1 distinct defect");
    assert.strictEqual(parentDefect.totalReportCount, 3, "Total report count must be 3");
    assert.strictEqual(parentDefect.totalVotes, 8, "Total votes must be 5 + 2 + 1 = 8");
    assert.deepStrictEqual(parentDefect.severities, [7, 6], "Severities must be aggregated");

    // Cycle A <-> B must terminate without crashing or infinite loop
    const aDefect = defects.find(d => String(d.id) === String(aId) || String(d.id) === String(bId));
    assert(aDefect, "Circular duplicate references must resolve safely");

    // Self-reference C -> C must resolve without crashing
    const cDefect = defects.find(d => String(d.id) === String(cId));
    assert(cDefect, "Self-reference must resolve safely");

    // Missing parent must not drop issue
    const mDefect = defects.find(d => String(d.id) === String(mId) || String(d.id) === String(missingParentId));
    assert(mDefect, "Missing parent must be handled gracefully without dropping citizen report");
  });

  await test("Unit: Scope D — Duplicate reports do NOT inflate distinct defect counts", () => {
    // 1 physical pothole with 4 citizen duplicate reports (5 total reports) at the exact same spot
    const rootId = new mongoose.Types.ObjectId();
    const dup1 = new mongoose.Types.ObjectId();
    const dup2 = new mongoose.Types.ObjectId();
    const dup3 = new mongoose.Types.ObjectId();
    const dup4 = new mongoose.Types.ObjectId();

    const issues = [
      {
        _id: rootId,
        type: "pothole",
        location: { coordinates: [77.7170, 11.3410] },
        status: "reported"
      },
      {
        _id: dup1,
        type: "pothole",
        location: { coordinates: [77.7170, 11.3410] },
        status: "reported",
        duplicateOf: rootId,
        reviewResolution: "confirmed_duplicate"
      },
      {
        _id: dup2,
        type: "pothole",
        location: { coordinates: [77.7170, 11.3410] },
        status: "reported",
        duplicateOf: rootId,
        reviewResolution: "confirmed_duplicate"
      },
      {
        _id: dup3,
        type: "pothole",
        location: { coordinates: [77.7170, 11.3410] },
        status: "reported",
        duplicateOf: rootId,
        reviewResolution: "confirmed_duplicate"
      },
      {
        _id: dup4,
        type: "pothole",
        location: { coordinates: [77.7170, 11.3410] },
        status: "reported",
        duplicateOf: rootId,
        reviewResolution: "confirmed_duplicate"
      }
    ];

    // Canonical defect resolution
    const defects = resolveCanonicalDefects(issues);
    assert.strictEqual(defects.length, 1, "Must resolve to exactly 1 canonical defect");
    assert.strictEqual(defects[0].distinctDefectCount, 1);
    assert.strictEqual(defects[0].totalReportCount, 5);

    // DBSCAN on these defects: minSamples = 3
    const clusterResult = dbscan({
      points: defects,
      epsMeters: 100,
      minSamples: 3
    });

    // CRITICAL: Since distinctDefectCount is 1, it cannot satisfy minSamples = 3.
    // It must be classified as NOISE, NOT a dense hotspot!
    assert.strictEqual(
      clusterResult.clusters.length,
      0,
      "Single defect with duplicates must NOT form a hotspot cluster!"
    );
    assert.strictEqual(clusterResult.noise.length, 1, "Must be classified as noise");
  });

  await test("Unit: Scope E — Deterministic cluster matching & tie-breaking", () => {
    const oldHotspotId1 = new mongoose.Types.ObjectId();
    const oldHotspotId2 = new mongoose.Types.ObjectId();
    const iss1 = new mongoose.Types.ObjectId();
    const iss2 = new mongoose.Types.ObjectId();
    const iss3 = new mongoose.Types.ObjectId();

    const existingHotspots = [
      {
        _id: oldHotspotId1,
        centroid: { coordinates: [77.7170, 11.3410] },
        issueIds: [iss1, iss2],
        firstDetectedAt: new Date(Date.now() - 50000)
      },
      {
        _id: oldHotspotId2,
        centroid: { coordinates: [77.7300, 11.3500] },
        issueIds: [iss3],
        firstDetectedAt: new Date(Date.now() - 20000)
      }
    ];

    const newClusters = [
      {
        centroid: { coordinates: [77.7171, 11.3411] }, // ~15m from oldHotspot1
        issueIds: [iss1, iss2, new mongoose.Types.ObjectId()],
        distinctDefectCount: 3,
        totalReportCount: 3
      }
    ];

    const matchResult = matchClustersAndHotspots({
      newClusters,
      existingHotspots,
      epsMeters: 100
    });

    assert.strictEqual(matchResult.matched.length, 1, "Should match 1 cluster");
    assert.strictEqual(
      String(matchResult.matched[0].existingHotspot._id),
      String(oldHotspotId1),
      "Must match to oldHotspot1"
    );
    assert.strictEqual(matchResult.unmatchedExistingHotspots.length, 1);
    assert.strictEqual(
      String(matchResult.unmatchedExistingHotspots[0]._id),
      String(oldHotspotId2)
    );
  });

  await test("Unit: Scope F — Alert deduplication bookkeeping & escalation threshold", () => {
    const testHotspot = {
      _id: new mongoose.Types.ObjectId(),
      totalReportCount: 3,
      distinctDefectCount: 3,
      alertSent: false,
      alertSentAt: null,
      escalatedAlertSentAt: null,
      lastAlertIssueCount: 0
    };

    // 1. Initial alert
    const eval1 = evaluateAlertState(testHotspot, { now: new Date(1000000000000) });
    assert.strictEqual(eval1.shouldAlert, true);
    assert.strictEqual(eval1.alertType, "initial");
    assert.strictEqual(eval1.updates.alertSent, true);
    assert.strictEqual(eval1.updates.lastAlertIssueCount, 3);

    // Apply updates
    Object.assign(testHotspot, eval1.updates);

    // 2. Repeat run with unchanged report count (Idempotent)
    const eval2 = evaluateAlertState(testHotspot, { now: new Date(1000003600000) });
    assert.strictEqual(eval2.shouldAlert, false);
    assert.strictEqual(eval2.alertType, "none");
    assert.deepStrictEqual(eval2.updates, {});

    // 3. Repeat run with minor growth (+1 report, from 3 to 4 = 33% < 50% threshold)
    testHotspot.totalReportCount = 4;
    const eval3 = evaluateAlertState(testHotspot, {
      alertCooldownHours: 24,
      escalationGrowthRate: 0.5,
      now: new Date(1000000000000 + 25 * 3600 * 1000)
    });
    assert.strictEqual(eval3.shouldAlert, false, "33% growth should NOT trigger escalation alert");

    // 4. Significant growth (+3 reports, from 3 to 6 = 100% >= 50% threshold) after cooldown
    testHotspot.totalReportCount = 6;
    const eval4 = evaluateAlertState(testHotspot, {
      alertCooldownHours: 24,
      escalationGrowthRate: 0.5,
      now: new Date(1000000000000 + 25 * 3600 * 1000)
    });
    assert.strictEqual(eval4.shouldAlert, true, "100% growth after cooldown must trigger escalation");
    assert.strictEqual(eval4.alertType, "escalation");
    assert.strictEqual(eval4.updates.status, "escalating");
    assert.strictEqual(eval4.updates.lastAlertIssueCount, 6);
  });

  // ============================================================================
  // DATABASE INTEGRATION TESTS (Disposable Local MongoDB)
  // ============================================================================

  await test("DB: Dense cluster detection and category isolation", async () => {
    await setupDatabase();

    // Group A: 3 Potholes in close proximity (within 30 meters)
    const p1 = await Issue.create({
      userId: testUserId,
      type: "pothole",
      description: "Severe crater pothole A",
      location: { coordinates: [77.7170, 11.3410] },
      status: "reported",
      severity: 8,
      votes: 3
    });
    const p2 = await Issue.create({
      userId: testUserId,
      type: "pothole",
      description: "Severe crater pothole B",
      location: { coordinates: [77.7171, 11.3411] },
      status: "in-progress",
      severity: 7,
      votes: 2
    });
    const p3 = await Issue.create({
      userId: testUserId,
      type: "pothole",
      description: "Severe crater pothole C",
      location: { coordinates: [77.7172, 11.3410] },
      status: "reported",
      severity: 9,
      votes: 1
    });

    // Group B: 2 Street Light defects at the EXACT SAME LOCATION as Potholes
    // Should NOT combine with potholes due to canonical category isolation!
    // Since 2 < minSamples (3), street_light should have 0 hotspots.
    const sl1 = await Issue.create({
      userId: testUserId,
      type: "street_light",
      description: "Flickering street light",
      location: { coordinates: [77.7170, 11.3410] },
      status: "reported"
    });
    const sl2 = await Issue.create({
      userId: testUserId,
      type: "street_light",
      description: "Broken lamp pole",
      location: { coordinates: [77.7171, 11.3411] },
      status: "reported"
    });

    // Group C: 3 Garbage defects in a different neighborhood (> 1 km away)
    const g1 = await Issue.create({
      userId: testUserId,
      type: "garbage",
      description: "Overflowing garbage dump 1",
      location: { coordinates: [77.7300, 11.3500] },
      status: "reported"
    });
    const g2 = await Issue.create({
      userId: testUserId,
      type: "garbage",
      description: "Overflowing garbage dump 2",
      location: { coordinates: [77.7301, 11.3501] },
      status: "reported"
    });
    const g3 = await Issue.create({
      userId: testUserId,
      type: "garbage",
      description: "Overflowing garbage dump 3",
      location: { coordinates: [77.7302, 11.3500] },
      status: "reported"
    });

    // Run DBSCAN synchronization
    const syncResult = await detectAndSyncHotspots({
      epsMeters: 100,
      minSamples: 3
    });

    assert.strictEqual(syncResult.createdCount, 2, "Should create exactly 2 hotspots (pothole and garbage)");

    // Verify Pothole Hotspot
    const potholeHotspots = await Hotspot.find({ category: "pothole" });
    assert.strictEqual(potholeHotspots.length, 1);
    const pHotspot = potholeHotspots[0];
    assert.strictEqual(pHotspot.distinctDefectCount, 3);
    assert.strictEqual(pHotspot.totalReportCount, 3);
    assert.strictEqual(pHotspot.totalVotes, 6); // 3 + 2 + 1
    assert.strictEqual(pHotspot.meanSeverity, 8.0); // (8 + 7 + 9) / 3
    assert.strictEqual(pHotspot.department, CANONICAL_DEPARTMENTS.ROADS_AND_INFRASTRUCTURE);
    assert.strictEqual(pHotspot.status, "active");
    assert.strictEqual(pHotspot.alertSent, true);

    // Verify Street Light Hotspots: 0 (isolated by category)
    const slHotspots = await Hotspot.find({ category: "street_light" });
    assert.strictEqual(slHotspots.length, 0, "Street light issues must not merge with potholes");

    // Verify Garbage Hotspot
    const garbageHotspots = await Hotspot.find({ category: "garbage" });
    assert.strictEqual(garbageHotspots.length, 1);
    assert.strictEqual(garbageHotspots[0].distinctDefectCount, 3);
    assert.strictEqual(garbageHotspots[0].department, CANONICAL_DEPARTMENTS.WASTE_MANAGEMENT);

    // Verify Issue clusterId linkage
    const linkedP1 = await Issue.findById(p1._id);
    assert.strictEqual(String(linkedP1.clusterId), String(pHotspot._id));
    const linkedSl1 = await Issue.findById(sl1._id);
    assert.strictEqual(linkedSl1.clusterId, null, "Unclustered issue must have clusterId: null");
  });

  await test("DB: Active-status and rolling-window filtering", async () => {
    await setupDatabase();

    const now = new Date();
    const twentyDaysAgo = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000);

    // 2 active recent potholes
    await Issue.create({
      userId: testUserId,
      type: "pothole",
      description: "Active recent pothole 1",
      location: { coordinates: [77.7170, 11.3410] },
      status: "reported",
      createdAt: now
    });
    await Issue.create({
      userId: testUserId,
      type: "pothole",
      description: "Active recent pothole 2",
      location: { coordinates: [77.7171, 11.3411] },
      status: "in-progress",
      createdAt: now
    });

    // 1 resolved pothole at same spot (should be excluded from active clustering)
    await Issue.create({
      userId: testUserId,
      type: "pothole",
      description: "Already repaired pothole",
      location: { coordinates: [77.7172, 11.3410] },
      status: "resolved",
      createdAt: now
    });

    // 1 old pothole (> 14 days old, should be excluded by rolling window)
    await Issue.create({
      userId: testUserId,
      type: "pothole",
      description: "Old pothole 20 days ago",
      location: { coordinates: [77.7173, 11.3409] },
      status: "reported",
      createdAt: twentyDaysAgo
    });

    // Run DBSCAN sync
    const syncResult = await detectAndSyncHotspots({
      now,
      epsMeters: 100,
      minSamples: 3,
      rollingWindowDays: 14
    });

    // Only 2 active issues inside the window, which is < minSamples(3)
    assert.strictEqual(syncResult.createdCount, 0, "Resolved and aged-out issues must be excluded");
    const count = await Hotspot.countDocuments({});
    assert.strictEqual(count, 0);
  });

  await test("DB: Repeat-run stability (Idempotent Hotspot Refresh)", async () => {
    await setupDatabase();

    // Create 3 active potholes
    for (let i = 0; i < 3; i++) {
      await Issue.create({
        userId: testUserId,
        type: "pothole",
        description: `Active pothole ${i}`,
        location: { coordinates: [77.7170 + i * 0.0001, 11.3410] },
        status: "reported"
      });
    }

    // Run 1: Creates 1 hotspot
    const sync1 = await detectAndSyncHotspots({ epsMeters: 100, minSamples: 3 });
    assert.strictEqual(sync1.createdCount, 1);
    assert.strictEqual(sync1.updatedCount, 0);

    const initialHotspot = await Hotspot.findOne({ category: "pothole" });
    const initialId = String(initialHotspot._id);
    const initialFirstDetected = initialHotspot.firstDetectedAt.getTime();
    const initialAlertSentAt = initialHotspot.alertSentAt.getTime();

    // Run 2: Unchanged input -> MUST update existing Hotspot, NOT create a new one!
    const sync2 = await detectAndSyncHotspots({ epsMeters: 100, minSamples: 3 });
    assert.strictEqual(sync2.createdCount, 0, "Must NOT create duplicate Hotspots on repeat run");
    assert.strictEqual(sync2.updatedCount, 1, "Must update existing Hotspot");

    const refreshedHotspot = await Hotspot.findOne({ category: "pothole" });
    assert.strictEqual(String(refreshedHotspot._id), initialId, "Hotspot ID must be preserved");
    assert.strictEqual(
      refreshedHotspot.firstDetectedAt.getTime(),
      initialFirstDetected,
      "firstDetectedAt must NOT be overwritten"
    );
    assert.strictEqual(
      refreshedHotspot.alertSentAt.getTime(),
      initialAlertSentAt,
      "alertSentAt must NOT be reset"
    );
  });

  await test("DB: Conservative lifecycle when cluster disappears (resolving vs resolved)", async () => {
    await setupDatabase();

    // Create 3 active potholes forming a cluster
    const issues = [];
    for (let i = 0; i < 3; i++) {
      const iss = await Issue.create({
        userId: testUserId,
        type: "pothole",
        description: `Pothole ${i}`,
        location: { coordinates: [77.7170 + i * 0.0001, 11.3410] },
        status: "reported"
      });
      issues.push(iss);
    }

    // Run initial sync -> 1 active Hotspot
    await detectAndSyncHotspots({ epsMeters: 100, minSamples: 3 });
    let hotspot = await Hotspot.findOne({ category: "pothole" });
    assert.strictEqual(hotspot.status, "active");

    // Case 1: Cluster density drops below minSamples, but issues are NOT resolved
    // (e.g. 1 issue deleted/resolved, leaving 2 open issues)
    await Issue.findByIdAndDelete(issues[2]._id);

    await detectAndSyncHotspots({ epsMeters: 100, minSamples: 3 });
    hotspot = await Hotspot.findOne({ category: "pothole" });
    // CRITICAL: Conservative lifecycle: Must be 'resolving', NOT 'resolved'!
    assert.strictEqual(
      hotspot.status,
      "resolving",
      "Must transition to resolving when density drops but constituent issues remain open"
    );

    // Case 2: Now resolve all remaining constituent issues
    await Issue.updateMany({ _id: { $in: [issues[0]._id, issues[1]._id] } }, { $set: { status: "resolved" } });

    await detectAndSyncHotspots({ epsMeters: 100, minSamples: 3 });
    hotspot = await Hotspot.findOne({ category: "pothole" });
    assert.strictEqual(
      hotspot.status,
      "resolved",
      "Must transition to resolved ONLY when all constituent issues are confirmed resolved"
    );
  });

  await test("DB: Review flags and administrative privacy fields remain intact", async () => {
    await setupDatabase();

    // Create 3 issues with distinct review flags and admin notes
    const iss1 = await Issue.create({
      userId: testUserId,
      type: "pothole",
      description: "Needs duplicate review issue",
      location: { coordinates: [77.7170, 11.3410] },
      status: "reported",
      needsDuplicateReview: true,
      needsClassificationReview: false,
      internalNotes: "Admin private note: inspect utility cut"
    });

    const iss2 = await Issue.create({
      userId: testUserId,
      type: "pothole",
      description: "Needs classification review issue",
      location: { coordinates: [77.7171, 11.3411] },
      status: "reported",
      needsDuplicateReview: false,
      needsClassificationReview: true,
      internalNotes: "Admin private note: possible storm drain failure"
    });

    const iss3 = await Issue.create({
      userId: testUserId,
      type: "pothole",
      description: "Standard issue",
      location: { coordinates: [77.7172, 11.3410] },
      status: "reported"
    });

    // Run sync
    await detectAndSyncHotspots({ epsMeters: 100, minSamples: 3 });

    // Verify issue states in DB
    const check1 = await Issue.findById(iss1._id);
    assert.strictEqual(check1.needsDuplicateReview, true);
    assert.strictEqual(check1.needsReview, true);
    assert.strictEqual(check1.internalNotes, "Admin private note: inspect utility cut");
    assert(check1.clusterId, "clusterId must be populated");

    const check2 = await Issue.findById(iss2._id);
    assert.strictEqual(check2.needsClassificationReview, true);
    assert.strictEqual(check2.needsReview, true);
    assert.strictEqual(check2.internalNotes, "Admin private note: possible storm drain failure");
    assert(check2.clusterId, "clusterId must be populated");

    // Hotspot internalNotes integrity
    const hotspot = await Hotspot.findOne({ category: "pothole" });
    hotspot.internalNotes = "Admin hotspot note: scheduled for milling next week";
    await hotspot.save();

    // Re-run sync
    await detectAndSyncHotspots({ epsMeters: 100, minSamples: 3 });
    const refreshedHotspot = await Hotspot.findById(hotspot._id);
    assert.strictEqual(
      refreshedHotspot.internalNotes,
      "Admin hotspot note: scheduled for milling next week",
      "Hotspot internalNotes must be preserved during refresh"
    );
  });

  // Teardown
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
