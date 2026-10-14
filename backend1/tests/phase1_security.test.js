const { describe, it } = require("node:test");
const assert = require("node:assert");
const jwt = require("jsonwebtoken");
const path = require("path");
const fs = require("fs");

const TEST_SECRET = "test_super_secret_jwt_key_for_unit_tests_only_123456";
process.env.JWT_SECRET = TEST_SECRET;

// Load components under test
const { authenticateToken } = require("../middleware/authenticateToken");
const verifyAdmin = require("../middleware/authenticateTokenAdmin");
const upload = require("../middleware/multer");
const { registerAdmin } = require("../controllers/adminAuth.controller");

// Helper to mock Express req, res, next
function createMockHttp(headers = {}, body = {}, params = {}) {
  const req = {
    headers,
    body,
    params,
    user: null,
    admin: null,
  };
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    jsonPayload: null,
    json(data) {
      this.jsonPayload = data;
      return this;
    },
    sendStatus(code) {
      this.statusCode = code;
      return this;
    }
  };
  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };
  return { req, res, next, isNextCalled: () => nextCalled };
}

describe("Phase 1 Security & Authentication Verification", () => {

  // 1. Citizen Token on Admin Routes
  it("rejects a citizen token on admin-protected routes with 403 Forbidden", () => {
    const citizenToken = jwt.sign(
      { userId: "citizen_12345", role: "citizen" },
      TEST_SECRET,
      { expiresIn: "1h" }
    );
    const { req, res, next, isNextCalled } = createMockHttp({
      authorization: `Bearer ${citizenToken}`
    });

    verifyAdmin(req, res, next);

    assert.strictEqual(isNextCalled(), false, "next() must not be called for citizen on admin route");
    assert.strictEqual(res.statusCode, 403, "Status must be 403 Forbidden");
    assert.strictEqual(res.jsonPayload.error, true);
    assert.match(res.jsonPayload.message, /Administrator access required/i);
  });

  // 2. Admin Token on Admin Routes
  it("allows a valid admin token on admin-protected routes", () => {
    const adminToken = jwt.sign(
      { adminId: "admin_67890", role: "admin" },
      TEST_SECRET,
      { expiresIn: "1h" }
    );
    const { req, res, next, isNextCalled } = createMockHttp({
      authorization: `Bearer ${adminToken}`
    });

    verifyAdmin(req, res, next);

    assert.strictEqual(isNextCalled(), true, "next() must be called for valid admin");
    assert.strictEqual(req.admin.adminId, "admin_67890");
    assert.strictEqual(req.admin.role, "admin");
  });

  // 3. Admin Token on Citizen Routes
  it("rejects an admin token on citizen-protected routes with 403 Forbidden", () => {
    const adminToken = jwt.sign(
      { adminId: "admin_67890", role: "admin" },
      TEST_SECRET,
      { expiresIn: "1h" }
    );
    const { req, res, next, isNextCalled } = createMockHttp({
      authorization: `Bearer ${adminToken}`
    });

    authenticateToken(req, res, next);

    assert.strictEqual(isNextCalled(), false, "next() must not be called for admin on citizen route");
    assert.strictEqual(res.statusCode, 403, "Status must be 403 Forbidden");
    assert.strictEqual(res.jsonPayload.error, true);
    assert.match(res.jsonPayload.message, /Citizen access required/i);
  });

  // 4. Citizen Token on Citizen Routes
  it("allows a valid citizen token on citizen-protected routes", () => {
    const citizenToken = jwt.sign(
      { userId: "citizen_12345", role: "citizen" },
      TEST_SECRET,
      { expiresIn: "1h" }
    );
    const { req, res, next, isNextCalled } = createMockHttp({
      authorization: `Bearer ${citizenToken}`
    });

    authenticateToken(req, res, next);

    assert.strictEqual(isNextCalled(), true, "next() must be called for valid citizen");
    assert.strictEqual(req.user.userId, "citizen_12345");
    assert.strictEqual(req.user.role, "citizen");
  });

  // 5. Missing Token
  it("rejects requests with missing authorization token with 401 Unauthorized", () => {
    const { req, res, next, isNextCalled } = createMockHttp({});

    authenticateToken(req, res, next);
    assert.strictEqual(isNextCalled(), false);
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.jsonPayload.error, true);

    const adminCheck = createMockHttp({});
    verifyAdmin(adminCheck.req, adminCheck.res, adminCheck.next);
    assert.strictEqual(adminCheck.isNextCalled(), false);
    assert.strictEqual(adminCheck.res.statusCode, 401);
  });

  // 6. Expired Token
  it("rejects expired tokens with 401 Unauthorized", () => {
    const expiredToken = jwt.sign(
      { userId: "citizen_12345", role: "citizen" },
      TEST_SECRET,
      { expiresIn: "-1s" }
    );
    const { req, res, next, isNextCalled } = createMockHttp({
      authorization: `Bearer ${expiredToken}`
    });

    authenticateToken(req, res, next);
    assert.strictEqual(isNextCalled(), false);
    assert.strictEqual(res.statusCode, 401);
    assert.match(res.jsonPayload.message, /Invalid or expired token/i);
  });

  // 7. Legacy Token without Role
  it("rejects legacy tokens lacking role claim with 401 Unauthorized", () => {
    const legacyToken = jwt.sign(
      { userId: "citizen_legacy" },
      TEST_SECRET,
      { expiresIn: "1h" }
    );
    const { req, res, next, isNextCalled } = createMockHttp({
      authorization: `Bearer ${legacyToken}`
    });

    authenticateToken(req, res, next);
    assert.strictEqual(isNextCalled(), false);
    assert.strictEqual(res.statusCode, 401);
    assert.match(res.jsonPayload.message, /Invalid session token/i);
  });

  // 8. Public Admin Signup Disabled
  it("ensures public admin signup is strictly rejected with 403 Forbidden", async () => {
    const { req, res } = createMockHttp({}, {
      fullName: "Attacker",
      email: "attacker@example.com",
      password: "password123",
      adminKey: "any_admin_key"
    });

    await registerAdmin(req, res);

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.jsonPayload.error, true);
    assert.match(res.jsonPayload.message, /Public administrator registration is disabled/i);
  });

  // 9. CORS Policy Verification (Development vs Production Modes)
  it("allows localhost origins in development mode", () => {
    const { getCorsOrigins, createCorsOptions } = require("../config/cors");
    const devEnv = { NODE_ENV: "development", CITIZEN_FRONTEND_ORIGIN: "https://custom-citizen.example.com" };
    const origins = getCorsOrigins(devEnv);

    assert.ok(origins.includes("http://localhost:3000"), "Development must include localhost:3000");
    assert.ok(origins.includes("http://localhost:3001"), "Development must include localhost:3001");
    assert.ok(origins.includes("https://custom-citizen.example.com"));

    // Test through actual CORS options callback
    const options = createCorsOptions(devEnv);
    let allowed = null;
    options.origin("http://localhost:3000", (err, pass) => {
      allowed = !err && pass;
    });
    assert.strictEqual(allowed, true);
  });

  it("strictly rejects localhost origins in production mode", () => {
    const { getCorsOrigins, createCorsOptions } = require("../config/cors");
    const prodEnv = {
      NODE_ENV: "production",
      CITIZEN_FRONTEND_ORIGIN: "https://issue-tracker-kappa-pearl.vercel.app",
      ADMIN_FRONTEND_ORIGIN: "https://civicvision-admin.vercel.app"
    };
    const origins = getCorsOrigins(prodEnv);

    assert.ok(!origins.includes("http://localhost:3000"), "Production must NOT permit localhost:3000");
    assert.ok(!origins.includes("http://localhost:3001"), "Production must NOT permit localhost:3001");
    assert.ok(origins.includes("https://issue-tracker-kappa-pearl.vercel.app"), "Production must permit deployed citizen origin");
    assert.ok(origins.includes("https://civicvision-admin.vercel.app"), "Production must permit deployed admin origin");

    // Test through actual CORS options callback
    const options = createCorsOptions(prodEnv);
    let corsError = null;
    options.origin("http://localhost:3000", (err, pass) => {
      corsError = err;
    });
    assert.ok(corsError, "Localhost in production must trigger a CORS error");
    assert.strictEqual(corsError.code, "CORS_NOT_ALLOWED");

    // Test allowed configured origin
    let prodAllowed = null;
    options.origin("https://issue-tracker-kappa-pearl.vercel.app", (err, pass) => {
      prodAllowed = !err && pass;
    });
    assert.strictEqual(prodAllowed, true);

    // Test non-browser requests (null origin)
    let nullOriginAllowed = null;
    options.origin(null, (err, pass) => {
      nullOriginAllowed = !err && pass;
    });
    assert.strictEqual(nullOriginAllowed, true);
  });

  // 10. Multer Upload Validation & Binary Magic Signature Verification
  it("validates file size limits (5MB) and accepted image MIME types/extensions", () => {
    assert.strictEqual(upload.limits.fileSize, 5 * 1024 * 1024, "Multer fileSize limit must be exactly 5MB");

    const filter = upload.fileFilter;
    let allowed = null;
    let errorReceived = null;

    const cb = (err, pass) => {
      errorReceived = err;
      allowed = pass;
    };

    // Valid MIME + Extension
    filter(null, { originalname: "damage.jpg", mimetype: "image/jpeg" }, cb);
    assert.strictEqual(allowed, true);

    filter(null, { originalname: "pothole.png", mimetype: "image/png" }, cb);
    assert.strictEqual(allowed, true);

    filter(null, { originalname: "road.webp", mimetype: "image/webp" }, cb);
    assert.strictEqual(allowed, true);

    // Invalid PDF
    filter(null, { originalname: "doc.pdf", mimetype: "application/pdf" }, cb);
    assert.strictEqual(allowed, false);
    assert.strictEqual(errorReceived.code, "INVALID_FILE_TYPE");

    // Invalid Executable with spoofed extension
    filter(null, { originalname: "malicious.exe", mimetype: "image/jpeg" }, cb);
    assert.strictEqual(allowed, false);
    assert.strictEqual(errorReceived.code, "INVALID_FILE_TYPE");
  });

  it("validates genuine binary magic signatures for JPEG, PNG, and WebP", () => {
    const { validateImageSignature } = require("../middleware/multer");

    // Valid JPEG signature (FF D8 FF ...)
    const validJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    assert.strictEqual(validateImageSignature(validJpeg), "image/jpeg");

    // Valid PNG signature (89 50 4E 47 0D 0A 1A 0A ...)
    const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    assert.strictEqual(validateImageSignature(validPng), "image/png");

    // Valid WebP signature (RIFF .... WEBP)
    const validWebp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
    assert.strictEqual(validateImageSignature(validWebp), "image/webp");

    // File with allowed MIME/extension name but fake/malicious content (HTML script)
    const fakeContent = Buffer.from("<html><script>alert('xss')</script></html>");
    assert.strictEqual(validateImageSignature(fakeContent), false, "Fake image with text/html must be rejected");

    // Windows PE / binary executable
    const executable = Buffer.from("MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff\x00\x00");
    assert.strictEqual(validateImageSignature(executable), false, "Executable signature must be rejected");

    // Short buffer (< 12 bytes)
    const shortBuffer = Buffer.from([0xff, 0xd8]);
    assert.strictEqual(validateImageSignature(shortBuffer), false);
  });

  // 11. Admin Dashboard Issue Data Endpoint Verification
  it("confirms frontend AdminDashboard calls the protected /admin-dashboard/issues endpoint", () => {
    const adminDashboardCode = fs.readFileSync(
      path.resolve(__dirname, "../../frontend1/src/pages/AdminDashboard.js"),
      "utf8"
    );

    assert.ok(
      adminDashboardCode.includes('API.get("/admin-dashboard/issues")'),
      "AdminDashboard.js must call API.get('/admin-dashboard/issues')"
    );
    assert.ok(
      !adminDashboardCode.includes('API.get("/issues")'),
      "AdminDashboard.js must not fetch issues from public API.get('/issues')"
    );
  });

  // 12. Configurable API Base URL in Frontend
  it("confirms frontend api.js supports configurable REACT_APP_API_URL and strips trailing slashes", () => {
    const apiCode = fs.readFileSync(
      path.resolve(__dirname, "../../frontend1/src/api/api.js"),
      "utf8"
    );

    assert.ok(
      apiCode.includes("process.env.REACT_APP_API_URL"),
      "api.js must read process.env.REACT_APP_API_URL"
    );
    assert.ok(
      apiCode.includes(".replace(/\\/+$"),
      "api.js must strip trailing slash to prevent malformed URL joins"
    );
  });
});
