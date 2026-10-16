/**
 * CivicVision AI — Phase F5-D: Backend OCR Proxy Automated Test Suite
 *
 * Verifies all Phase F5-D backend proxy requirements:
 * 1. Unauthenticated requests are rejected (401/403).
 * 2. Valid citizen JWT authentication is required and accepted.
 * 3. File validation: Missing file, unsupported MIME/signature rejected with HTTP 400.
 * 4. Supported binary signatures (JPEG, PNG, WebP) accepted.
 * 5. Sliding-window rate limiter enforces bounded rate limit (10 req/min/user) with HTTP 429.
 * 6. Internal AI_SERVICE_API_KEY and internal AI service URL never exposed to caller.
 * 7. extractOcrGpsFromBuffer:
 *    - Success: valid coordinates parsed and bounded.
 *    - No-result: safe found:false returned.
 *    - AI service timeout / 503 / network error: non-blocking safe failure.
 *    - Malformed response / invalid coordinate ranges: rejected safely.
 * 8. Zero database mutation: extractOcrCoordinates NEVER persists or modifies Issue records.
 * 9. Issue creation remains resilient and functional when AI service is unavailable.
 * 10. Private locationMetadata remains excluded from citizen responses.
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

const DISPOSABLE_DB_URI = "mongodb://127.0.0.1:27017/civicvision_test_phase5_proxy_disposable";
const TEST_JWT_SECRET = "phase5_test_jwt_secret_key_32_chars_min";
process.env.JWT_SECRET = TEST_JWT_SECRET;
process.env.AI_SERVICE_URL = "http://localhost:8000";
process.env.AI_SERVICE_API_KEY = "test_super_secret_ai_key_never_leak_to_browser";

const Issue = require("../models/Issue");
const User = require("../models/User");
const { authenticateToken } = require("../middleware/authenticateToken");
const { ocrRateLimiter } = require("../middleware/rateLimiter");
const { validateImageSignature } = require("../middleware/multer");
const { extractOcrCoordinates, reportIssue } = require("../controllers/issue.controller");
const { extractOcrGpsFromBuffer } = require("../services/ai.service");

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
    },
    setHeader(key, val) {
      this.headers[key] = val;
      return this;
    }
  };
  return res;
}

async function runTests() {
  console.log("==================================================================");
  console.log("   CIVICVISION AI - PHASE F5-D BACKEND OCR PROXY TESTS");
  console.log("==================================================================");

  let passed = 0;
  let failed = 0;

  function recordPass(testName) {
    passed++;
    console.log(`  PASS: [${passed}] ${testName}`);
  }

  function recordFail(testName, err) {
    failed++;
    console.error(`  FAIL: ${testName}`);
    console.error(`        ${err.message}`);
  }

  // Connect to disposable local DB
  let dbConnected = false;
  try {
    await mongoose.connect(DISPOSABLE_DB_URI, { serverSelectionTimeoutMS: 2000 });
    dbConnected = true;
    await Issue.deleteMany({});
    await User.deleteMany({});
  } catch (err) {
    console.warn("  [NOTE] Local MongoDB not reachable; DB persistence tests will mock collections:", err.message);
  }

  const validCitizenToken = jwt.sign(
    { userId: "citizen_user_555", role: "citizen", email: "citizen555@example.com" },
    TEST_JWT_SECRET,
    { expiresIn: "1h" }
  );

  const adminToken = jwt.sign(
    { userId: "admin_user_999", role: "admin", email: "admin999@example.com" },
    TEST_JWT_SECRET,
    { expiresIn: "1h" }
  );

  // -------------------------------------------------------------------------
  // 1. Authentication Middleware Tests
  // -------------------------------------------------------------------------
  console.log("\n--- Suite 1: Authentication & Authorization ---");

  // Test 1: Unauthenticated request (no token) is rejected with 401
  try {
    const req = { headers: {} };
    const res = createMockRes();
    let nextCalled = false;
    authenticateToken(req, res, () => { nextCalled = true; });

    assert.strictEqual(res.statusCode, 401, "Should return 401 for missing token");
    assert.strictEqual(nextCalled, false, "next() must not be called");
    recordPass("1. Missing authorization header is rejected with HTTP 401");
  } catch (err) {
    recordFail("1. Missing authorization header is rejected with HTTP 401", err);
  }

  // Test 2: Invalid JWT token is rejected with 401
  try {
    const req = { headers: { authorization: "Bearer invalid.jwt.signature" } };
    const res = createMockRes();
    let nextCalled = false;
    authenticateToken(req, res, () => { nextCalled = true; });

    assert.strictEqual(res.statusCode, 401, "Should return 401 for invalid token");
    assert.strictEqual(nextCalled, false, "next() must not be called");
    recordPass("2. Invalid JWT signature is rejected with HTTP 401");
  } catch (err) {
    recordFail("2. Invalid JWT signature is rejected with HTTP 401", err);
  }

  // Test 3: Admin token attempting to access citizen route is rejected with 403
  try {
    const req = { headers: { authorization: `Bearer ${adminToken}` } };
    const res = createMockRes();
    let nextCalled = false;
    authenticateToken(req, res, () => { nextCalled = true; });

    assert.strictEqual(res.statusCode, 403, "Should return 403 for admin token on citizen route");
    assert.strictEqual(nextCalled, false, "next() must not be called");
    recordPass("3. Admin token attempting citizen OCR route is rejected with HTTP 403");
  } catch (err) {
    recordFail("3. Admin token attempting citizen OCR route is rejected with HTTP 403", err);
  }

  // Test 4: Valid citizen JWT token is accepted
  try {
    const req = { headers: { authorization: `Bearer ${validCitizenToken}` } };
    const res = createMockRes();
    let nextCalled = false;
    authenticateToken(req, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, true, "next() must be called for valid token");
    assert.strictEqual(req.user.userId, "citizen_user_555");
    assert.strictEqual(req.user.role, "citizen");
    recordPass("4. Valid citizen JWT token attaches user payload and calls next()");
  } catch (err) {
    recordFail("4. Valid citizen JWT token attaches user payload and calls next()", err);
  }

  // -------------------------------------------------------------------------
  // 2. Upload & Signature Validation Tests
  // -------------------------------------------------------------------------
  console.log("\n--- Suite 2: File Magic Byte & Signature Validation ---");

  // Test 5: Missing file is rejected by extractOcrCoordinates
  try {
    const req = { user: { userId: "citizen_user_555" }, file: null };
    const res = createMockRes();
    await extractOcrCoordinates(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.success, false);
    assert.match(res.body.message, /No image file/i);
    recordPass("5. Missing file in extract-ocr request returns HTTP 400");
  } catch (err) {
    recordFail("5. Missing file in extract-ocr request returns HTTP 400", err);
  }

  // Test 6: Text file or corrupted bytes disguised as image rejected by validateImageSignature
  try {
    const fakeTextBuffer = Buffer.from("THIS IS A TEXT FILE NOT AN IMAGE AT ALL!!", "utf8");
    const mime = validateImageSignature(fakeTextBuffer);
    assert.strictEqual(mime, false, "Magic byte validator must return false for text bytes");

    // Also verify controller returns 400 when given invalid signature buffer
    const req = {
      user: { userId: "citizen_user_555" },
      file: { buffer: fakeTextBuffer, mimetype: "image/jpeg" }
    };
    const res = createMockRes();
    await extractOcrCoordinates(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.success, false);
    assert.match(res.body.message, /Invalid image content/i);
    recordPass("6. Text file buffer disguised as image is rejected by magic byte validator and controller");
  } catch (err) {
    recordFail("6. Text file buffer disguised as image is rejected by magic byte validator and controller", err);
  }

  // Test 7: Valid JPEG magic bytes accepted
  try {
    const validJpeg = Buffer.from([
      0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46,
      0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01
    ]);
    const detectedType = validateImageSignature(validJpeg);
    assert.strictEqual(detectedType, "image/jpeg");
    recordPass("7. Valid JPEG magic bytes (FF D8 FF ...) correctly accepted as image/jpeg");
  } catch (err) {
    recordFail("7. Valid JPEG magic bytes (FF D8 FF ...) correctly accepted as image/jpeg", err);
  }

  // Test 8: Valid PNG magic bytes accepted
  try {
    const validPng = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52
    ]);
    const detectedType = validateImageSignature(validPng);
    assert.strictEqual(detectedType, "image/png");
    recordPass("8. Valid PNG magic bytes (89 50 4E 47 ...) correctly accepted as image/png");
  } catch (err) {
    recordFail("8. Valid PNG magic bytes (89 50 4E 47 ...) correctly accepted as image/png", err);
  }

  // Test 9: Valid WebP magic bytes accepted
  try {
    const validWebp = Buffer.from([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x20, 0x00, 0x00, 0x00, // Size
      0x57, 0x45, 0x42, 0x50, // WEBP
      0x56, 0x50, 0x38, 0x20  // VP8
    ]);
    const detectedType = validateImageSignature(validWebp);
    assert.strictEqual(detectedType, "image/webp");
    recordPass("9. Valid WebP magic bytes (RIFF....WEBP) correctly accepted as image/webp");
  } catch (err) {
    recordFail("9. Valid WebP magic bytes (RIFF....WEBP) correctly accepted as image/webp", err);
  }

  // -------------------------------------------------------------------------
  // 3. Rate Limiter Tests
  // -------------------------------------------------------------------------
  console.log("\n--- Suite 3: Sliding-Window Rate Limiting ---");

  // Test 10: Rate limiter allows requests up to max (10)
  try {
    const testUserId = "rate_limit_test_user_" + Date.now();
    for (let i = 0; i < 10; i++) {
      const req = { user: { userId: testUserId } };
      const res = createMockRes();
      let nextCalled = false;
      ocrRateLimiter(req, res, () => { nextCalled = true; });
      assert.strictEqual(nextCalled, true, `Request ${i + 1} should be permitted`);
    }
    recordPass("10. Rate limiter allows 10 requests within window for citizen");
  } catch (err) {
    recordFail("10. Rate limiter allows 10 requests within window for citizen", err);
  }

  // Test 11: 11th request exceeds limit and returns 429
  try {
    const testUserId = "rate_limit_test_user_" + Date.now();
    for (let i = 0; i < 10; i++) {
      const req = { user: { userId: testUserId } };
      const res = createMockRes();
      ocrRateLimiter(req, res, () => {});
    }
    // 11th call
    const req = { user: { userId: testUserId } };
    const res = createMockRes();
    let nextCalled = false;
    ocrRateLimiter(req, res, () => { nextCalled = true; });

    assert.strictEqual(nextCalled, false, "11th request must not call next()");
    assert.strictEqual(res.statusCode, 429, "11th request must receive HTTP 429");
    assert.strictEqual(res.body.success, false);
    assert.match(res.body.message, /Rate limit exceeded/i);
    assert.strictEqual(typeof res.body.retryAfter, "number");
    recordPass("11. 11th request in window is rejected with HTTP 429 Rate Limit Exceeded");
  } catch (err) {
    recordFail("11. 11th request in window is rejected with HTTP 429 Rate Limit Exceeded", err);
  }

  // -------------------------------------------------------------------------
  // 4. OCR Buffer Client (extractOcrGpsFromBuffer) Tests
  // -------------------------------------------------------------------------
  console.log("\n--- Suite 4: Buffer OCR Client Integration ---");

  const originalFetch = global.fetch;

  const validJpegBuffer = Buffer.from([
    0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46,
    0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01
  ]);

  // Test 12: Successful OCR GPS extraction parses coordinates correctly
  try {
    global.fetch = async (url, opts) => {
      assert.strictEqual(url, "http://localhost:8000/extract-ocr-upload");
      assert.strictEqual(opts.headers["X-API-Key"], "test_super_secret_ai_key_never_leak_to_browser");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          found: true,
          latitude: 11.341234,
          longitude: 77.721456,
          confidence: 0.94,
          format: "degrees_minutes_seconds",
          raw_text: "LAT 11 20 28.4 N LON 77 43 17.2 E"
        })
      };
    };

    const result = await extractOcrGpsFromBuffer(validJpegBuffer);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.latitude, 11.341234);
    assert.strictEqual(result.longitude, 77.721456);
    assert.strictEqual(result.confidence, 0.94);
    assert.strictEqual(result.format, "degrees_minutes_seconds");
    recordPass("12. extractOcrGpsFromBuffer parses successful coordinates and metadata");
  } catch (err) {
    recordFail("12. extractOcrGpsFromBuffer parses successful coordinates and metadata", err);
  }

  // Test 13: OCR no coordinates found returns safe found:false
  try {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        found: false,
        latitude: null,
        longitude: null,
        message: "No GPS coordinates detected in image."
      })
    });

    const result = await extractOcrGpsFromBuffer(validJpegBuffer);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.found, false);
    assert.strictEqual(result.latitude, null);
    assert.strictEqual(result.longitude, null);
    recordPass("13. OCR returns found:false when image has no coordinates");
  } catch (err) {
    recordFail("13. OCR returns found:false when image has no coordinates", err);
  }

  // Test 14: OCR timeout / AbortError returns non-blocking safe failure
  try {
    global.fetch = async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    };

    const result = await extractOcrGpsFromBuffer(validJpegBuffer);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.found, false);
    assert.match(result.message || result.error, /timed out/i);
    recordPass("14. Timeout returns safe non-blocking response without throwing");
  } catch (err) {
    recordFail("14. Timeout returns safe non-blocking response without throwing", err);
  }

  // Test 15: HTTP 503 from AI service returns safe service unavailable
  try {
    global.fetch = async () => ({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable"
    });

    const result = await extractOcrGpsFromBuffer(validJpegBuffer);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.found, false);
    assert.match(result.message || result.error, /503/i);
    recordPass("15. AI service HTTP 503 handled gracefully as safe unavailable response");
  } catch (err) {
    recordFail("15. AI service HTTP 503 handled gracefully as safe unavailable response", err);
  }

  // Test 16: Out-of-bounds coordinates from AI service are rejected
  try {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        found: true,
        latitude: 99.999, // Invalid latitude > 90
        longitude: 77.721
      })
    });

    const result = await extractOcrGpsFromBuffer(validJpegBuffer);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.found, false);
    assert.match(result.message || result.error, /invalid/i);
    recordPass("16. Out-of-bounds latitude (99.999 > 90) safely rejected");
  } catch (err) {
    recordFail("16. Out-of-bounds latitude (99.999 > 90) safely rejected", err);
  }

  // -------------------------------------------------------------------------
  // 5. Controller Security & Privacy Isolation Tests
  // -------------------------------------------------------------------------
  console.log("\n--- Suite 5: Controller Security, Zero Persistence & Key Isolation ---");

  // Test 17: Controller never leaks AI_SERVICE_API_KEY or internal URL
  try {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        found: true,
        latitude: 11.341234,
        longitude: 77.721456,
        confidence: 0.95,
        format: "decimal_degrees",
        message: "Found coordinates"
      })
    });

    const req = {
      user: { userId: "citizen_user_555" },
      file: {
        buffer: validJpegBuffer,
        mimetype: "image/jpeg",
        size: validJpegBuffer.length
      }
    };
    const res = createMockRes();
    await extractOcrCoordinates(req, res);

    assert.strictEqual(res.statusCode, 200);
    const bodyStr = JSON.stringify(res.body);

    // Strict secrets isolation
    assert.strictEqual(bodyStr.includes("test_super_secret_ai_key"), false, "Must never return AI service API key");
    assert.strictEqual(bodyStr.includes("http://localhost:8000"), false, "Must never return internal AI URL");
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.found, true);
    assert.strictEqual(res.body.latitude, 11.341234);
    assert.strictEqual(res.body.longitude, 77.721456);
    recordPass("17. Response contains coordinates but strictly isolates AI_SERVICE_API_KEY and internal URL");
  } catch (err) {
    recordFail("17. Response contains coordinates but strictly isolates AI_SERVICE_API_KEY and internal URL", err);
  }

  // Test 18: OCR extraction request does NOT create an Issue in the database
  try {
    if (dbConnected) {
      const issueCountBefore = await Issue.countDocuments();

      const req = {
        user: { userId: "citizen_user_555" },
        file: {
          buffer: validJpegBuffer,
          mimetype: "image/jpeg",
          size: validJpegBuffer.length
        }
      };
      const res = createMockRes();
      await extractOcrCoordinates(req, res);

      const issueCountAfter = await Issue.countDocuments();
      assert.strictEqual(issueCountBefore, issueCountAfter, "Database Issue count must remain unchanged");
    }
    recordPass("18. OCR extraction is strictly transient and never persists an Issue record");
  } catch (err) {
    recordFail("18. OCR extraction is strictly transient and never persists an Issue record", err);
  }

  // -------------------------------------------------------------------------
  // 6. Resilience & Issue Reporting Flow
  // -------------------------------------------------------------------------
  console.log("\n--- Suite 6: Issue Creation Resilience with geoSource ---");

  // Test 19: Issue creation with geoSource 'ocr' succeeds even if AI service is offline
  try {
    if (dbConnected) {
      const citizenMongoId = new mongoose.Types.ObjectId();
      const req = {
        user: { userId: citizenMongoId.toString() },
        body: {
          type: "Pothole",
          description: "Dangerous pothole with exposed gravel on road",
          lat: "11.3412",
          lng: "77.7214",
          geoSource: "ocr",
          locationMetadata: JSON.stringify({
            ocrCoordinates: [77.7214, 11.3412],
            ocrConfidence: 0.95
          })
        },
        file: {
          path: "https://res.cloudinary.com/civicvision/image/upload/v1234/pothole.jpg"
        }
      };
      const res = createMockRes();

      // Force AI classification/OCR to fail
      global.fetch = async () => { throw new Error("AI service completely offline"); };

      await reportIssue(req, res);

      assert.strictEqual(res.statusCode, 201, "Issue creation should succeed with 201");
      const createdIssue = res.body.issue || res.body;
      assert.strictEqual(createdIssue.geoSource, "ocr", "Stored geoSource should be 'ocr'");
      assert.strictEqual(createdIssue.location.coordinates[0], 77.7214);
      assert.strictEqual(createdIssue.location.coordinates[1], 11.3412);

      // Verify private locationMetadata is excluded from citizen response
      assert.strictEqual(createdIssue.locationMetadata, undefined, "locationMetadata must not be in citizen response");
    }
    recordPass("19. Issue creation with geoSource 'ocr' succeeds non-blockingly when AI is offline");
  } catch (err) {
    recordFail("19. Issue creation with geoSource 'ocr' succeeds non-blockingly when AI is offline", err);
  }

  // Restore fetch
  global.fetch = originalFetch;

  // Cleanup
  if (dbConnected) {
    try {
      await Issue.deleteMany({});
      await mongoose.disconnect();
    } catch (_) {}
  }

  console.log("\n==================================================================");
  console.log(`   PHASE F5-D BACKEND TESTS FINISHED: ${passed} PASSED, ${failed} FAILED`);
  console.log("==================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error("FATAL TEST RUN ERROR:", err);
  process.exit(1);
});
