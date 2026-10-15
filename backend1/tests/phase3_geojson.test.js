/**
 * Phase 3.1 GeoJSON Location & Migration Automated Test Suite
 *
 * Verifies all 10 requirements:
 * 1. Valid GeoJSON Point construction
 * 2. Longitude/latitude coordinate order ([lng, lat])
 * 3. Invalid and out-of-range coordinates rejection
 * 4. Legacy { lat, lng } compatibility
 * 5. API serialization and map-rendering compatibility (JSON virtuals)
 * 6. Preservation of issue identity and unrelated fields
 * 7. Migration dry-run behavior and idempotency
 * 8. Handling of malformed legacy records
 * 9. Protection against leaking internalNotes
 * 10. Genuine MongoDB 2dsphere index and spatial $near query behavior on a disposable database
 */

const assert = require("assert");
const mongoose = require("mongoose");
const Issue = require("../models/Issue");
const { migrateIssues, isValidGeoJsonPoint, isValidLegacyLocation } = require("../scripts/migrateGeoJson");
const { getAllIssues, getUserIssues, reportIssue, getNearbyIssues } = require("../controllers/issue.controller");

const DISPOSABLE_DB_URI = "mongodb://127.0.0.1:27017/civicvision_test_geojson_disposable";

let realDbAvailable = false;

async function runTests() {
  console.log("==========================================================");
  console.log("   CIVICVISION AI - PHASE 3.1 GEOJSON TEST SUITE");
  console.log("==========================================================");

  // Setup connection to disposable local database
  try {
    await mongoose.connect(DISPOSABLE_DB_URI, { serverSelectionTimeoutMS: 3000 });
    realDbAvailable = true;
    await mongoose.connection.db.dropDatabase();
    console.log("[Setup] Connected to disposable local MongoDB at:", DISPOSABLE_DB_URI);
  } catch (err) {
    console.warn("[Setup Warning] Local MongoDB unavailable, tests requiring DB will be reported accordingly:", err.message);
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

  console.log("\n--- Category 1: Schema Construction, Validation, & Coordinate Order ---");

  await test("1. Valid GeoJSON Point construction with canonical [lng, lat]", async () => {
    const issue = new Issue({
      userId: new mongoose.Types.ObjectId(),
      type: "Pothole",
      description: "Severe pothole on Main St",
      location: {
        type: "Point",
        coordinates: [77.7275, 11.3418] // [lng, lat]
      }
    });

    const valErr = issue.validateSync();
    assert.strictEqual(valErr, undefined, "Validation should pass for valid coordinates");
    assert.strictEqual(issue.location.type, "Point");
    assert.strictEqual(issue.location.coordinates[0], 77.7275, "First coordinate must be longitude");
    assert.strictEqual(issue.location.coordinates[1], 11.3418, "Second coordinate must be latitude");
  });

  await test("2. Strict coordinate ordering: [lng, lat] is maintained without silent swapping", async () => {
    // Erode, TN: lng ~ 77.72, lat ~ 11.34
    const issue = new Issue({
      userId: new mongoose.Types.ObjectId(),
      type: "Garbage",
      description: "Overflowing bin",
      location: {
        type: "Point",
        coordinates: [77.7275, 11.3418]
      }
    });

    assert.strictEqual(issue.location.lng, 77.7275, "Virtual getter lng must equal coordinates[0]");
    assert.strictEqual(issue.location.lat, 11.3418, "Virtual getter lat must equal coordinates[1]");
  });

  await test("3. Out-of-range coordinates are strictly rejected by schema validation", async () => {
    // Latitude > 90
    const invalidLatHigh = new Issue({
      userId: new mongoose.Types.ObjectId(),
      type: "Streetlight",
      description: "Broken lamp",
      location: { type: "Point", coordinates: [77.72, 91.0] }
    });
    assert.ok(invalidLatHigh.validateSync(), "Latitude > 90 must fail validation");

    // Latitude < -90
    const invalidLatLow = new Issue({
      userId: new mongoose.Types.ObjectId(),
      type: "Streetlight",
      description: "Broken lamp",
      location: { type: "Point", coordinates: [77.72, -90.5] }
    });
    assert.ok(invalidLatLow.validateSync(), "Latitude < -90 must fail validation");

    // Longitude > 180
    const invalidLngHigh = new Issue({
      userId: new mongoose.Types.ObjectId(),
      type: "Streetlight",
      description: "Broken lamp",
      location: { type: "Point", coordinates: [181.0, 11.34] }
    });
    assert.ok(invalidLngHigh.validateSync(), "Longitude > 180 must fail validation");

    // Longitude < -180
    const invalidLngLow = new Issue({
      userId: new mongoose.Types.ObjectId(),
      type: "Streetlight",
      description: "Broken lamp",
      location: { type: "Point", coordinates: [-180.5, 11.34] }
    });
    assert.ok(invalidLngLow.validateSync(), "Longitude < -180 must fail validation");

    // Non-numeric / NaN coordinates
    const invalidNaN = new Issue({
      userId: new mongoose.Types.ObjectId(),
      type: "Streetlight",
      description: "Broken lamp",
      location: { type: "Point", coordinates: ["invalid", null] }
    });
    assert.ok(invalidNaN.validateSync(), "NaN / invalid type coordinates must fail validation");
  });

  console.log("\n--- Category 2: Legacy Compatibility & Serialization ---");

  await test("4. Legacy { lat, lng } input automatically normalizes to canonical GeoJSON Point", async () => {
    const issue = new Issue({
      userId: new mongoose.Types.ObjectId(),
      type: "Water Leakage",
      description: "Pipe burst",
      location: { lat: 11.3418, lng: 77.7275 }
    });

    const err = issue.validateSync();
    assert.strictEqual(err, undefined, "Normalization must produce a valid schema instance");
    assert.strictEqual(issue.location.type, "Point");
    assert.strictEqual(issue.location.coordinates[0], 77.7275, "lng mapped to coordinates[0]");
    assert.strictEqual(issue.location.coordinates[1], 11.3418, "lat mapped to coordinates[1]");
    assert.strictEqual(issue.location.lat, 11.3418, "virtual lat accessible");
    assert.strictEqual(issue.location.lng, 77.7275, "virtual lng accessible");
  });

  await test("5. Serialization to JSON maintains virtual lat/lng for map components", async () => {
    const issue = new Issue({
      userId: new mongoose.Types.ObjectId(),
      type: "Road Hazard",
      description: "Missing manhole cover",
      location: { lat: 11.3418, lng: 77.7275 }
    });

    const json = JSON.parse(JSON.stringify(issue.toJSON()));
    assert.strictEqual(json.location.type, "Point");
    assert.deepStrictEqual(json.location.coordinates, [77.7275, 11.3418]);
    assert.strictEqual(json.location.lat, 11.3418, "Frontend Marker position=[issue.location.lat, issue.location.lng] intact");
    assert.strictEqual(json.location.lng, 77.7275, "Admin Dashboard mlat/mlon intact");
  });

  await test("6. Issue identity, timestamps, and unrelated fields are preserved", async () => {
    const userId = new mongoose.Types.ObjectId();
    const issue = new Issue({
      userId,
      type: "Drainage",
      description: "Clogged drainage canal",
      department: "Sanitation",
      status: "in-progress",
      votes: 12,
      location: { lat: 11.35, lng: 77.73 }
    });

    assert.strictEqual(issue.userId.toString(), userId.toString());
    assert.strictEqual(issue.type, "Drainage");
    assert.strictEqual(issue.description, "Clogged drainage canal");
    assert.strictEqual(issue.department, "Sanitation");
    assert.strictEqual(issue.status, "in-progress");
    assert.strictEqual(issue.votes, 12);
  });

  console.log("\n--- Category 3: Migration Safety, Dry-Run, & Idempotency ---");

  if (!realDbAvailable) {
    console.log("  [SKIPPED REAL DB TESTS - Local MongoDB not available]");
  } else {
    const issuesCollection = mongoose.connection.db.collection("issues");

    await test("7. Migration dry-run detects legacy documents without modifying database", async () => {
      await issuesCollection.drop().catch(() => {});

      const legacyDoc1 = {
        _id: new mongoose.Types.ObjectId(),
        type: "Pothole",
        description: "Old pothole 1",
        location: { lat: 11.34, lng: 77.72 },
        createdAt: new Date()
      };
      const geoJsonDoc2 = {
        _id: new mongoose.Types.ObjectId(),
        type: "Garbage",
        description: "New format garbage",
        location: { type: "Point", coordinates: [77.73, 11.35] },
        createdAt: new Date()
      };

      await issuesCollection.insertMany([legacyDoc1, geoJsonDoc2]);

      const dryRunReport = await migrateIssues(mongoose.connection.db, { commit: false, logger: () => {} });
      assert.strictEqual(dryRunReport.mode, "DRY-RUN");
      assert.strictEqual(dryRunReport.totalScanned, 2);
      assert.strictEqual(dryRunReport.alreadyGeoJson, 1);
      assert.strictEqual(dryRunReport.wouldMigrate, 1);
      assert.strictEqual(dryRunReport.migrated, 0);

      // Verify DB was NOT mutated
      const fetched = await issuesCollection.findOne({ _id: legacyDoc1._id });
      assert.strictEqual(fetched.location.lat, 11.34, "Legacy document must remain unchanged in dry-run");
      assert.strictEqual(fetched.location.type, undefined);
    });

    await test("8. Migration commit mode converts legacy records and is strictly idempotent", async () => {
      // Execute commit migration
      const commitReport = await migrateIssues(mongoose.connection.db, { commit: true, logger: () => {} });
      assert.strictEqual(commitReport.mode, "COMMIT");
      assert.strictEqual(commitReport.migrated, 1);

      // Verify in DB that document is now GeoJSON
      const legacyDocs = await issuesCollection.find({ "location.type": "Point" }).toArray();
      assert.strictEqual(legacyDocs.length, 2, "Both records must now be valid GeoJSON");

      // Run migration AGAIN on same database to verify idempotency
      const rerunReport = await migrateIssues(mongoose.connection.db, { commit: true, logger: () => {} });
      assert.strictEqual(rerunReport.totalScanned, 2);
      assert.strictEqual(rerunReport.alreadyGeoJson, 2, "All records recognized as already GeoJSON");
      assert.strictEqual(rerunReport.migrated, 0, "No duplicate conversions performed");
    });

    await test("9. Migration safely skips malformed and corrupted records without crashing", async () => {
      // To simulate an unmigrated collection with malformed records, ensure no 2dsphere index blocks insert
      await issuesCollection.drop().catch(() => {});

      const malformedDoc = {
        _id: new mongoose.Types.ObjectId(),
        type: "Malformed",
        description: "Bad coordinates",
        location: { lat: 999.0, lng: 999.0 } // invalid coordinates
      };
      const missingDoc = {
        _id: new mongoose.Types.ObjectId(),
        type: "Missing",
        description: "No location field"
      };

      await issuesCollection.insertMany([malformedDoc, missingDoc]);

      const report = await migrateIssues(mongoose.connection.db, { commit: true, logger: () => {} });
      assert.strictEqual(report.malformedSkipped, 1, "Malformed coordinates must be skipped");
      assert.strictEqual(report.missingSkipped, 1, "Missing location records must be skipped");
      assert.strictEqual(report.errors.length, 2);

      // Verify the malformed records were NOT deleted or destroyed
      const stillThere = await issuesCollection.findOne({ _id: malformedDoc._id });
      assert.ok(stillThere, "Malformed record must be preserved for operator review");
      assert.strictEqual(stillThere.location.lat, 999.0);
    });

    console.log("\n--- Category 4: Geospatial 2dsphere Indexing & Spatial Queries ---");

    await test("10. Genuine 2dsphere index creation and $near spatial queries on disposable DB", async () => {
      // Clean collection for indexing test
      await issuesCollection.drop().catch(() => {});

      // Point A: Erode Bus Stand [77.7275, 11.3418]
      // Point B: 200m away [77.7290, 11.3425]
      // Point C: 20km away in Bhavani [77.6833, 11.4500]
      const issueNear = new Issue({
        userId: new mongoose.Types.ObjectId(),
        type: "Pothole",
        description: "Pothole 200m away",
        location: { type: "Point", coordinates: [77.7290, 11.3425] }
      });
      const issueFar = new Issue({
        userId: new mongoose.Types.ObjectId(),
        type: "Pothole",
        description: "Pothole 20km away",
        location: { type: "Point", coordinates: [77.6833, 11.4500] }
      });

      await issueNear.save();
      await issueFar.save();

      // Explicitly build 2dsphere index (since autoIndex: false)
      await Issue.createIndexes();

      // Query within 1000m radius of [77.7275, 11.3418]
      const nearResults = await Issue.find({
        location: {
          $near: {
            $geometry: {
              type: "Point",
              coordinates: [77.7275, 11.3418]
            },
            $maxDistance: 1000 // 1km
          }
        }
      });

      assert.strictEqual(nearResults.length, 1, "Only point within 1000m should be returned");
      assert.strictEqual(nearResults[0].description, "Pothole 200m away");
    });

    console.log("\n--- Category 5: Controller & Privacy Invariants ---");

    await test("11. API reportIssue controller accepts both legacy and GeoJSON, rejects out-of-bounds", async () => {
      let createdResponse = null;
      let statusCode = null;

      const mockRes = {
        status: (code) => {
          statusCode = code;
          return {
            json: (data) => { createdResponse = data; }
          };
        }
      };

      // Test valid report with lat/lng
      const reqValid = {
        body: { type: "Pothole", description: "Test controller report", lat: 11.3418, lng: 77.7275 },
        user: { userId: new mongoose.Types.ObjectId() }
      };
      await reportIssue(reqValid, mockRes);
      assert.strictEqual(statusCode, 201);
      assert.strictEqual(createdResponse.issue.location.type, "Point");
      assert.strictEqual(createdResponse.issue.location.coordinates[0], 77.7275);
      assert.strictEqual(createdResponse.issue.location.coordinates[1], 11.3418);

      // Test out-of-bounds coordinates
      let errorResponse = null;
      const mockErrRes = {
        status: (code) => {
          statusCode = code;
          return {
            json: (data) => { errorResponse = data; }
          };
        }
      };
      const reqOutOfBounds = {
        body: { type: "Pothole", description: "Bad coord", lat: 95.0, lng: 77.7275 },
        user: { userId: new mongoose.Types.ObjectId() }
      };
      await reportIssue(reqOutOfBounds, mockErrRes);
      assert.strictEqual(statusCode, 400, "Out-of-bounds latitude must return 400");
    });

    await test("12. internalNotes are strictly excluded from public & spatial API endpoints", async () => {
      const confidentialIssue = new Issue({
        userId: new mongoose.Types.ObjectId(),
        type: "Illegal Encroachment",
        description: "Public walkway blocked",
        internalNotes: "CONFIDENTIAL_ADMIN_NOTE_DO_NOT_LEAK",
        location: { lat: 11.3418, lng: 77.7275 }
      });
      await confidentialIssue.save();

      // Test getAllIssues exclusion
      let fetchedIssues = null;
      const mockRes = {
        status: () => ({
          json: (data) => { fetchedIssues = data; }
        })
      };
      await getAllIssues({}, mockRes);
      const target = fetchedIssues.find(i => i._id.toString() === confidentialIssue._id.toString());
      assert.ok(target, "Created issue should be fetched");
      assert.strictEqual(target.internalNotes, undefined, "internalNotes must NOT be present in getAllIssues");

      // Test getNearbyIssues exclusion
      let nearbyResult = null;
      const mockNearbyRes = {
        status: () => ({
          json: (data) => { nearbyResult = data; }
        })
      };
      await getNearbyIssues({ query: { lat: 11.3418, lng: 77.7275, radius: 1000 } }, mockNearbyRes);
      const nearbyTarget = nearbyResult.find(i => i._id.toString() === confidentialIssue._id.toString());
      assert.ok(nearbyTarget);
      assert.strictEqual(nearbyTarget.internalNotes, undefined, "internalNotes must NOT be present in getNearbyIssues");
    });
  }

  // Teardown
  if (realDbAvailable) {
    try {
      await mongoose.connection.db.dropDatabase();
      await mongoose.disconnect();
      console.log("[Teardown] Disposable test database dropped and disconnected.");
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
