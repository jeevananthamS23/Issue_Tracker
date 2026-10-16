/**
 * CivicVision AI — Phase F5-C: Backend Location-Source Integration Automated Test Suite
 *
 * Verifies all Phase F5-C requirements:
 * 1. Valid `geoSource` values (`exif`, `ocr`, `device`, `manual`) accepted by schema and API.
 * 2. Backward-compatible default: missing `geoSource` resolves to `manual` without data loss.
 * 3. Invalid `geoSource` values are rejected with HTTP 400.
 * 4. Invalid, non-finite, missing, and out-of-range coordinates are rejected with HTTP 400.
 * 5. Strict GeoJSON canonical coordinate ordering: [longitude, latitude].
 * 6. Private location metadata excluded from public and citizen responses (`select: false`).
 * 7. Non-blocking resilience: issue creation succeeds when AI service is unavailable.
 * 8. OCR client helper: success, no-result, malformed response, timeout, and HTTP failure.
 * 9. Authorization & privacy boundaries: only authorized admin select retrieves audit metadata.
 * 10. Location invariance: client metadata never overrides citizen's chosen location.
 *
 * Safety:
 * - Operates strictly against a disposable local MongoDB instance.
 * - Defensive guard neutralizes any production Atlas MONGO_URI.
 */

const assert = require("assert");
const mongoose = require("mongoose");

// Strict Atlas protection
if (process.env.MONGO_URI && (process.env.MONGO_URI.includes("mongodb+srv") || process.env.MONGO_URI.includes("mongodb.net"))) {
  delete process.env.MONGO_URI;
}

const DISPOSABLE_DB_URI = "mongodb://127.0.0.1:27017/civicvision_test_phase5_geosource_disposable";
const TEST_JWT_SECRET = "phase5_test_jwt_secret_key_32_chars_min";
process.env.JWT_SECRET = TEST_JWT_SECRET;

const Issue = require("../models/Issue");
const User = require("../models/User");
const { reportIssue, getAllIssues, getUserIssues } = require("../controllers/issue.controller");
const { extractOcrGps } = require("../services/ai.service");

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
  console.log("   CIVICVISION AI - PHASE F5-C BACKEND LOCATION-SOURCE TESTS");
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

  // Seed test citizen user
  const testUserId = new mongoose.Types.ObjectId();
  if (realDbAvailable) {
    const user = new User({
      _id: testUserId,
      fullName: "Civic Citizen",
      email: "citizen.f5@example.com",
      password: "hashedpassword123"
    });
    await user.save();
  }

  console.log("\n--- Category 1: Schema Construction, Validation, & geoSource Enum ---");

  await test("1. Issue model accepts valid geoSource enum values (exif, ocr, device, manual)", async () => {
    const validSources = ["exif", "ocr", "device", "manual"];
    for (const src of validSources) {
      const doc = new Issue({
        userId: testUserId,
        type: "pothole",
        description: `Issue with source ${src}`,
        geoSource: src,
        location: { type: "Point", coordinates: [77.72, 11.34] }
      });
      const validationErr = doc.validateSync();
      assert.strictEqual(validationErr, undefined, `Expected ${src} to be valid`);
      assert.strictEqual(doc.geoSource, src);
    }
  });

  await test("2. Issue model rejects invalid geoSource values via Mongoose validation", async () => {
    const invalidSources = ["satellite", "gps_camera", "auto", "unknown", 12345];
    for (const src of invalidSources) {
      const doc = new Issue({
        userId: testUserId,
        type: "pothole",
        description: `Issue with invalid source ${src}`,
        geoSource: src,
        location: { type: "Point", coordinates: [77.72, 11.34] }
      });
      const err = doc.validateSync();
      assert.ok(err, `Expected ${src} to fail validation`);
      assert.ok(err.errors["geoSource"], `Expected geoSource error for ${src}`);
    }
  });

  await test("3. Backward-compatible default: geoSource defaults to 'manual' when omitted", async () => {
    const doc = new Issue({
      userId: testUserId,
      type: "pothole",
      description: "Older caller with no geoSource",
      location: { type: "Point", coordinates: [77.72, 11.34] }
    });
    assert.strictEqual(doc.geoSource, "manual");
  });

  if (realDbAvailable) {
    await test("4. Database backward-compatibility: legacy document in MongoDB returns geoSource 'manual'", async () => {
      // Insert a raw document without geoSource directly via native collection
      const legacyId = new mongoose.Types.ObjectId();
      await mongoose.connection.db.collection("issues").insertOne({
        _id: legacyId,
        userId: testUserId,
        type: "road_damage",
        description: "Legacy unmigrated database document",
        location: { type: "Point", coordinates: [77.72, 11.34] },
        status: "reported",
        createdAt: new Date(),
        updatedAt: new Date()
      });

      const loaded = await Issue.findById(legacyId);
      assert.ok(loaded);
      assert.strictEqual(loaded.geoSource, "manual", "Legacy document without stored geoSource must resolve to manual default");
    });
  }

  await test("5. GeoJSON canonical coordinate ordering is strictly [longitude, latitude]", async () => {
    const doc = new Issue({
      userId: testUserId,
      type: "pothole",
      description: "Coordinate ordering verification",
      geoSource: "exif",
      location: { type: "Point", coordinates: [77.7214, 11.3412] }
    });
    assert.strictEqual(doc.location.coordinates[0], 77.7214, "Index 0 must be longitude");
    assert.strictEqual(doc.location.coordinates[1], 11.3412, "Index 1 must be latitude");
    assert.strictEqual(doc.location.lng, 77.7214);
    assert.strictEqual(doc.location.lat, 11.3412);
  });

  await test("6. Location metadata subdocument validates valid fields and canonical [lng, lat]", async () => {
    const doc = new Issue({
      userId: testUserId,
      type: "pothole",
      description: "Audit metadata test",
      geoSource: "ocr",
      location: { type: "Point", coordinates: [77.7214, 11.3412] },
      locationMetadata: {
        exifCoordinates: [77.7210, 11.3410],
        ocrCoordinates: [77.7214, 11.3412],
        ocrConfidence: 0.95,
        discrepancyMeters: 45.2,
        rawOcrText: "11°20'28.3\"N 77°43'17.0\"E",
        geoReviewedAt: new Date("2026-10-16T10:00:00Z")
      }
    });
    const err = doc.validateSync();
    assert.strictEqual(err, undefined);
    assert.strictEqual(doc.locationMetadata.ocrConfidence, 0.95);
    assert.strictEqual(doc.locationMetadata.discrepancyMeters, 45.2);
  });

  await test("7. Location metadata subdocument rejects out-of-range audit coordinates", async () => {
    const doc = new Issue({
      userId: testUserId,
      type: "pothole",
      description: "Invalid audit coordinates",
      geoSource: "ocr",
      location: { type: "Point", coordinates: [77.72, 11.34] },
      locationMetadata: {
        ocrCoordinates: [200.0, 11.34] // Longitude > 180
      }
    });
    const err = doc.validateSync();
    assert.ok(err);
    assert.ok(err.errors["locationMetadata.ocrCoordinates"]);
  });

  await test("8. Location metadata subdocument rejects out-of-bounds confidence and negative discrepancy", async () => {
    const docConf = new Issue({
      userId: testUserId,
      type: "pothole",
      description: "Invalid confidence",
      geoSource: "ocr",
      location: { type: "Point", coordinates: [77.72, 11.34] },
      locationMetadata: {
        ocrConfidence: 1.5 // Max 1
      }
    });
    assert.ok(docConf.validateSync());

    const docDisc = new Issue({
      userId: testUserId,
      type: "pothole",
      description: "Negative discrepancy",
      geoSource: "ocr",
      location: { type: "Point", coordinates: [77.72, 11.34] },
      locationMetadata: {
        discrepancyMeters: -10 // Min 0
      }
    });
    assert.ok(docDisc.validateSync());
  });

  console.log("\n--- Category 2: Express Controller (reportIssue) Validation ---");

  if (realDbAvailable) {
    await test("9. reportIssue accepts valid geoSource ('ocr', 'device', 'exif', 'manual') from request body", async () => {
      const sources = ["ocr", "device", "exif", "manual"];
      for (let i = 0; i < sources.length; i++) {
        const src = sources[i];
        const req = {
          user: { userId: testUserId },
          body: {
            type: "pothole",
            description: `Issue reported with geoSource ${src}`,
            lat: 11.34 + i * 0.01,
            lng: 77.72 + i * 0.01,
            geoSource: src
          }
        };
        const res = createMockRes();
        await reportIssue(req, res);

        assert.strictEqual(res.statusCode, 201);
        assert.strictEqual(res.body.issue.geoSource, src);

        // Verify stored in DB
        const saved = await Issue.findById(res.body.issue._id);
        assert.strictEqual(saved.geoSource, src);
      }
    });

    await test("10. reportIssue defaults to 'manual' when older caller omits geoSource with valid coordinates", async () => {
      const req = {
        user: { userId: testUserId },
        body: {
          type: "street_light",
          description: "Older caller report without geoSource field",
          lat: 11.39,
          lng: 77.79
        }
      };
      const res = createMockRes();
      await reportIssue(req, res);

      assert.strictEqual(res.statusCode, 201);
      assert.strictEqual(res.body.issue.geoSource, "manual");

      const saved = await Issue.findById(res.body.issue._id);
      assert.strictEqual(saved.geoSource, "manual");
    });

    await test("11. reportIssue rejects invalid geoSource values with HTTP 400", async () => {
      const req = {
        user: { userId: testUserId },
        body: {
          type: "pothole",
          description: "Issue with invalid source",
          lat: 11.34,
          lng: 77.72,
          geoSource: "satellite_telemetry"
        }
      };
      const res = createMockRes();
      await reportIssue(req, res);

      assert.strictEqual(res.statusCode, 400);
      assert.ok(res.body.message.includes("Invalid geoSource"));
      assert.ok(res.body.message.includes("exif, ocr, device, manual"));
    });

    await test("12. reportIssue rejects missing coordinates with HTTP 400 without inventing coordinates", async () => {
      const req = {
        user: { userId: testUserId },
        body: {
          type: "garbage",
          description: "Missing coordinates entirely"
        }
      };
      const res = createMockRes();
      await reportIssue(req, res);

      assert.strictEqual(res.statusCode, 400);
      assert.ok(res.body.message.includes("Valid latitude and longitude coordinates are required"));
    });

    await test("13. reportIssue rejects non-finite coordinates (NaN, Infinity, -Infinity) with HTTP 400", async () => {
      const nonFiniteCases = [
        { lat: "not-a-number", lng: 77.72 },
        { lat: Infinity, lng: 77.72 },
        { lat: 11.34, lng: -Infinity }
      ];

      for (const coords of nonFiniteCases) {
        const req = {
          user: { userId: testUserId },
          body: {
            type: "pothole",
            description: "Non-finite coords test",
            lat: coords.lat,
            lng: coords.lng
          }
        };
        const res = createMockRes();
        await reportIssue(req, res);
        assert.strictEqual(res.statusCode, 400, `Expected 400 for non-finite lat=${coords.lat}, lng=${coords.lng}`);
      }
    });

    await test("14. reportIssue rejects out-of-range coordinates with HTTP 400", async () => {
      const outOfRangeCases = [
        { lat: 91.0, lng: 77.0 },
        { lat: -95.0, lng: 77.0 },
        { lat: 11.0, lng: 185.0 },
        { lat: 11.0, lng: -185.0 }
      ];

      for (const coords of outOfRangeCases) {
        const req = {
          user: { userId: testUserId },
          body: {
            type: "pothole",
            description: "Out-of-range coords test",
            lat: coords.lat,
            lng: coords.lng
          }
        };
        const res = createMockRes();
        await reportIssue(req, res);
        assert.strictEqual(res.statusCode, 400, `Expected 400 for out-of-bounds lat=${coords.lat}, lng=${coords.lng}`);
        assert.ok(res.body.message.includes("Invalid coordinates range"));
      }
    });

    await test("15. Location invariance: client-supplied locationMetadata never overwrites citizen's chosen coordinates", async () => {
      const citizenChosenLat = 11.3412;
      const citizenChosenLng = 77.7214;
      const differentOcrLat = 11.4500;
      const differentOcrLng = 77.8500;

      const req = {
        user: { userId: testUserId },
        body: {
          type: "pothole",
          description: "Testing authoritative coordinate preservation",
          lat: citizenChosenLat,
          lng: citizenChosenLng,
          geoSource: "manual",
          locationMetadata: JSON.stringify({
            ocrCoordinates: [differentOcrLng, differentOcrLat],
            ocrConfidence: 0.88,
            discrepancyMeters: 14200.0,
            rawOcrText: "11.4500 N, 77.8500 E"
          })
        }
      };
      const res = createMockRes();
      await reportIssue(req, res);

      assert.strictEqual(res.statusCode, 201);
      assert.strictEqual(res.body.issue.location.coordinates[0], citizenChosenLng);
      assert.strictEqual(res.body.issue.location.coordinates[1], citizenChosenLat);
      assert.strictEqual(res.body.issue.geoSource, "manual");

      // Verify in MongoDB that authoritative location remained the citizen's choice
      const saved = await Issue.findById(res.body.issue._id).select("+locationMetadata");
      assert.strictEqual(saved.location.coordinates[0], citizenChosenLng);
      assert.strictEqual(saved.location.coordinates[1], citizenChosenLat);
      assert.strictEqual(saved.locationMetadata.ocrCoordinates[0], differentOcrLng);
      assert.strictEqual(saved.locationMetadata.ocrCoordinates[1], differentOcrLat);
    });
  }

  console.log("\n--- Category 3: Privacy & Authorization Hardening ---");

  if (realDbAvailable) {
    await test("16. Private locationMetadata is strictly excluded from reportIssue HTTP 201 response", async () => {
      const req = {
        user: { userId: testUserId },
        body: {
          type: "water_leak",
          description: "Burst pipe with location audit",
          lat: 11.35,
          lng: 77.73,
          geoSource: "ocr",
          locationMetadata: JSON.stringify({
            ocrCoordinates: [77.73, 11.35],
            ocrConfidence: 0.94,
            rawOcrText: "PRIVATE_WATERMARK_GPS_TEXT_999"
          })
        }
      };
      const res = createMockRes();
      await reportIssue(req, res);

      assert.strictEqual(res.statusCode, 201);
      assert.strictEqual(res.body.issue.locationMetadata, undefined, "locationMetadata must NOT leak in citizen 201 response");
    });

    await test("17. Public getAllIssues and citizen getUserIssues strictly exclude locationMetadata", async () => {
      // 1. Query public endpoint
      const resPublic = createMockRes();
      await getAllIssues({}, resPublic);
      assert.strictEqual(resPublic.statusCode, 200);
      assert.ok(Array.isArray(resPublic.body));
      for (const item of resPublic.body) {
        assert.strictEqual(item.locationMetadata, undefined, "Public issue item must not contain locationMetadata");
      }

      // 2. Query citizen endpoint
      const reqUser = { user: { userId: testUserId } };
      const resUser = createMockRes();
      await getUserIssues(reqUser, resUser);
      assert.strictEqual(resUser.statusCode, 200);
      assert.ok(Array.isArray(resUser.body));
      for (const item of resUser.body) {
        assert.strictEqual(item.locationMetadata, undefined, "Citizen issue item must not contain locationMetadata");
      }
    });

    await test("18. Standard Mongoose queries exclude locationMetadata by default (select: false)", async () => {
      // Create issue directly with locationMetadata
      const issue = new Issue({
        userId: testUserId,
        type: "sewage",
        description: "Sewage overflow with audit metadata",
        geoSource: "ocr",
        location: { type: "Point", coordinates: [77.72, 11.34] },
        locationMetadata: {
          ocrCoordinates: [77.72, 11.34],
          ocrConfidence: 0.99,
          rawOcrText: "SEWAGE_AUDIT_TEXT"
        }
      });
      await issue.save();

      // Standard findById: should NOT contain locationMetadata
      const fetched = await Issue.findById(issue._id);
      assert.strictEqual(fetched.locationMetadata, undefined, "Default findById must omit locationMetadata due to select: false");

      // Explicit select('+locationMetadata'): authorized admin query retrieves it
      const fetchedWithAudit = await Issue.findById(issue._id).select("+locationMetadata");
      assert.ok(fetchedWithAudit.locationMetadata, "Explicit select('+locationMetadata') must retrieve the audit data");
      assert.strictEqual(fetchedWithAudit.locationMetadata.ocrConfidence, 0.99);
      assert.strictEqual(fetchedWithAudit.locationMetadata.rawOcrText, "SEWAGE_AUDIT_TEXT");
    });
  }

  console.log("\n--- Category 4: AI OCR Client Helper (extractOcrGps) ---");

  const originalFetch = globalThis.fetch;

  await test("19. extractOcrGps rejects empty or invalid image URL gracefully", async () => {
    const resEmpty = await extractOcrGps("");
    assert.strictEqual(resEmpty.success, false);
    assert.strictEqual(resEmpty.found, false);
    assert.ok(resEmpty.error.includes("non-empty string"));

    const resNull = await extractOcrGps(null);
    assert.strictEqual(resNull.success, false);
    assert.strictEqual(resNull.found, false);
  });

  await test("20. extractOcrGps parses valid GPS coordinates successfully from FastAPI response", async () => {
    globalThis.fetch = async (url, options) => {
      assert.ok(url.includes("/extract-ocr-gps"));
      assert.strictEqual(options.method, "POST");
      const body = JSON.parse(options.body);
      assert.strictEqual(body.image_url, "https://res.cloudinary.com/test/gps_watermark.jpg");

      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          found: true,
          latitude: 11.341234,
          longitude: 77.721456,
          confidence: 0.95,
          format: "degrees_minutes_seconds",
          raw_text: "11°20'28.4\"N 77°43'17.2\"E GPS Map Camera",
          error: null
        })
      };
    };

    try {
      const result = await extractOcrGps("https://res.cloudinary.com/test/gps_watermark.jpg");
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.found, true);
      assert.strictEqual(result.latitude, 11.341234);
      assert.strictEqual(result.longitude, 77.721456);
      assert.strictEqual(result.confidence, 0.95);
      assert.strictEqual(result.format, "degrees_minutes_seconds");
      assert.ok(result.rawText.includes("GPS Map Camera"));
      assert.strictEqual(result.error, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await test("21. extractOcrGps handles valid no-result gracefully (no coordinates on image)", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        found: false,
        latitude: null,
        longitude: null,
        confidence: null,
        format: null,
        raw_text: "Municipal Notice Board: No parking",
        error: null
      })
    });

    try {
      const result = await extractOcrGps("https://res.cloudinary.com/test/plain_photo.jpg");
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.found, false);
      assert.strictEqual(result.latitude, null);
      assert.strictEqual(result.longitude, null);
      assert.strictEqual(result.error, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await test("22. extractOcrGps handles OCR service unavailability (e.g. Tesseract missing on host)", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: false,
        found: false,
        latitude: null,
        longitude: null,
        confidence: null,
        format: null,
        raw_text: null,
        error: "Tesseract OCR executable not installed on host"
      })
    });

    try {
      const result = await extractOcrGps("https://res.cloudinary.com/test/photo.jpg");
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.found, false);
      assert.ok(result.error.includes("Tesseract OCR executable not installed"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await test("23. extractOcrGps detects malformed coordinate bounds returned from AI service", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        found: true,
        latitude: 999.0, // Invalid latitude
        longitude: 77.0,
        confidence: 0.9,
        format: "decimal_degrees",
        raw_text: "Lat: 999.0",
        error: null
      })
    });

    try {
      const result = await extractOcrGps("https://res.cloudinary.com/test/photo.jpg");
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.found, false);
      assert.ok(result.error.includes("invalid coordinate bounds"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await test("24. extractOcrGps handles network/connection failure gracefully without throwing", async () => {
    globalThis.fetch = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8000");
    };

    try {
      const result = await extractOcrGps("https://res.cloudinary.com/test/photo.jpg");
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.found, false);
      assert.ok(result.error.includes("ECONNREFUSED"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await test("25. extractOcrGps handles HTTP 500 error response from microservice", async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error in OCR pipeline"
    });

    try {
      const result = await extractOcrGps("https://res.cloudinary.com/test/photo.jpg");
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.found, false);
      assert.ok(result.error.includes("HTTP 500"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await test("26. extractOcrGps handles request timeout gracefully via AbortController", async () => {
    globalThis.fetch = async (url, { signal }) => {
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    };

    try {
      const result = await extractOcrGps("https://res.cloudinary.com/test/photo.jpg", 50);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.found, false);
      assert.ok(result.error.includes("timed out after 50ms"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  console.log("\n--- Category 5: End-to-End Non-Blocking Resilience ---");

  if (realDbAvailable) {
    await test("27. Issue creation succeeds with HTTP 201 even when AI microservice is down", async () => {
      // Point AI service URL to dead port to verify soft failure guarantee
      process.env.AI_SERVICE_URL = "http://127.0.0.1:59999";

      const req = {
        user: { userId: testUserId },
        body: {
          type: "traffic_signal",
          description: "Broken signal during total AI outage",
          lat: 11.36,
          lng: 77.74,
          geoSource: "device"
        }
      };
      const res = createMockRes();
      await reportIssue(req, res);

      assert.strictEqual(res.statusCode, 201);
      assert.strictEqual(res.body.issue.type, "traffic_signal");
      assert.strictEqual(res.body.issue.geoSource, "device");
      assert.strictEqual(res.body.duplicateCheck.status, "unique");

      delete process.env.AI_SERVICE_URL;
    });
  }

  // Teardown
  if (realDbAvailable) {
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
    console.log("[Teardown] Disposable test database dropped and disconnected.");
  }

  console.log("\n==================================================================");
  console.log(`TOTAL PHASE F5-C TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log("==================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
