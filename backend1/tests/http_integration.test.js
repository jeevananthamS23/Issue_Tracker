const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("http");
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");

const TEST_SECRET = "integration_test_jwt_secret_key_987654321_abc";
process.env.JWT_SECRET = TEST_SECRET;

// Import middlewares and routers
const { authenticateToken } = require("../middleware/authenticateToken");
const verifyAdmin = require("../middleware/authenticateTokenAdmin");
const adminAuthRoutes = require("../routes/adminAuth.routes");
const userAuthRoutes = require("../routes/userAuth.routes");
const issueRoutes = require("../routes/issue.routes");
const adminDashboardRoutes = require("../routes/adminDashboard.routes");
const voteRoutes = require("../routes/vote.routes");

describe("Phase 1 Isolated HTTP Integration Tests (Real HTTP Server & Network Layer)", () => {
  let server;
  let baseUrl;

  before(async () => {
    const app = express();

    const { createCorsOptions } = require("../config/cors");

    // Use actual application CORS options in development mode for the primary test server
    app.use(cors(createCorsOptions({
      NODE_ENV: "development",
      CITIZEN_FRONTEND_ORIGIN: "https://issue-tracker-kappa-pearl.vercel.app"
    })));

    app.use(express.json());

    // Mount routes
    app.use("/api/user", userAuthRoutes);
    app.use("/api/admin", adminAuthRoutes);
    app.use("/api/issues", issueRoutes);
    app.use("/api/admin-dashboard", adminDashboardRoutes);
    app.use("/api/votes", voteRoutes);

    // Error handler matching server.js
    app.use((err, req, res, next) => {
      if (err.code === "CORS_NOT_ALLOWED" || (err.message && err.message.startsWith("CORS policy violation"))) {
        return res.status(403).json({ error: true, message: err.message });
      }
      res.status(500).json({ error: true, message: err.message || "Internal server error" });
    });

    // Bind to ephemeral port (0) for safe isolated HTTP testing
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // 1. Admin Endpoint Access with Citizen Token over HTTP
  it("HTTP GET /api/admin-dashboard/issues rejects citizen token with 403 Forbidden", async () => {
    const citizenToken = jwt.sign(
      { userId: "citizen_999", role: "citizen" },
      TEST_SECRET,
      { expiresIn: "1h" }
    );

    const res = await fetch(`${baseUrl}/api/admin-dashboard/issues`, {
      headers: { Authorization: `Bearer ${citizenToken}` }
    });
    const body = await res.json();

    assert.strictEqual(res.status, 403);
    assert.strictEqual(body.error, true);
    assert.match(body.message, /Administrator access required/i);
  });

  // 2. Admin Endpoint Access with Missing Token over HTTP
  it("HTTP GET /api/admin-dashboard/issues rejects missing token with 401 Unauthorized", async () => {
    const res = await fetch(`${baseUrl}/api/admin-dashboard/issues`);
    const body = await res.json();

    assert.strictEqual(res.status, 401);
    assert.strictEqual(body.error, true);
    assert.match(body.message, /Access token missing/i);
  });

  // 3. Admin Endpoint Access with Malformed/Garbage Token over HTTP
  it("HTTP GET /api/admin-dashboard/issues rejects malformed token with 401 Unauthorized", async () => {
    const res = await fetch(`${baseUrl}/api/admin-dashboard/issues`, {
      headers: { Authorization: "Bearer this-is-not-a-valid-jwt" }
    });
    const body = await res.json();

    assert.strictEqual(res.status, 401);
    assert.strictEqual(body.error, true);
    assert.match(body.message, /Invalid or expired token/i);
  });

  // 4. Admin Endpoint Access with Legacy Token (no role) over HTTP
  it("HTTP GET /api/admin-dashboard/issues rejects legacy token with 403 Forbidden", async () => {
    const legacyToken = jwt.sign(
      { adminId: "admin_legacy_1" },
      TEST_SECRET,
      { expiresIn: "1h" }
    );

    const res = await fetch(`${baseUrl}/api/admin-dashboard/issues`, {
      headers: { Authorization: `Bearer ${legacyToken}` }
    });
    const body = await res.json();

    assert.strictEqual(res.status, 403);
    assert.strictEqual(body.error, true);
    assert.match(body.message, /Administrator access required/i);
  });

  // 5. Citizen Profile Endpoint Access with Admin Token over HTTP
  it("HTTP GET /api/user/profile rejects admin token with 403 Forbidden", async () => {
    const adminToken = jwt.sign(
      { adminId: "admin_100", role: "admin" },
      TEST_SECRET,
      { expiresIn: "1h" }
    );

    const res = await fetch(`${baseUrl}/api/user/profile`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const body = await res.json();

    assert.strictEqual(res.status, 403);
    assert.strictEqual(body.error, true);
    assert.match(body.message, /Citizen access required/i);
  });

  // 6. Citizen Issue Endpoint Access with Admin Token over HTTP
  it("HTTP GET /api/issues/user rejects admin token with 403 Forbidden", async () => {
    const adminToken = jwt.sign(
      { adminId: "admin_100", role: "admin" },
      TEST_SECRET,
      { expiresIn: "1h" }
    );

    const res = await fetch(`${baseUrl}/api/issues/user`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const body = await res.json();

    assert.strictEqual(res.status, 403);
    assert.strictEqual(body.error, true);
    assert.match(body.message, /Citizen access required/i);
  });

  // 7. Citizen Vote Endpoint Access with Admin Token over HTTP
  it("HTTP POST /api/votes/:issueId rejects admin token with 403 Forbidden", async () => {
    const adminToken = jwt.sign(
      { adminId: "admin_100", role: "admin" },
      TEST_SECRET,
      { expiresIn: "1h" }
    );

    const res = await fetch(`${baseUrl}/api/votes/507f1f77bcf86cd799439011`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const body = await res.json();

    assert.strictEqual(res.status, 403);
    assert.strictEqual(body.error, true);
    assert.match(body.message, /Citizen access required/i);
  });

  // 8. Public Admin Signup Endpoint Rejection over HTTP
  it("HTTP POST /api/admin/signup is rejected with 403 Forbidden", async () => {
    const res = await fetch(`${baseUrl}/api/admin/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Attacker",
        email: "attacker@test.com",
        password: "password123",
        adminKey: "someKey"
      })
    });
    const body = await res.json();

    assert.strictEqual(res.status, 403);
    assert.strictEqual(body.error, true);
    assert.match(body.message, /Public administrator registration is disabled/i);
  });

  // 9. CORS Enforcement over HTTP
  it("HTTP request with disallowed Origin header triggers CORS error", async () => {
    const res = await fetch(`${baseUrl}/api/issues`, {
      headers: { Origin: "https://unauthorized-malicious-site.com" }
    });
    const body = await res.json();

    assert.strictEqual(res.status, 403);
    assert.strictEqual(body.error, true);
    assert.match(body.message, /CORS policy violation/i);
  });

  it("HTTP request with allowed Origin header includes CORS headers", async () => {
    const res = await fetch(`${baseUrl}/api/issues`, {
      headers: { Origin: "http://localhost:3000" }
    });

    assert.strictEqual(res.headers.get("access-control-allow-origin"), "http://localhost:3000");
  });

  // 10. CORS in Production Mode: Localhost Rejected over HTTP
  it("HTTP request from localhost is strictly rejected when running with production CORS", async () => {
    const { createCorsOptions } = require("../config/cors");
    const prodApp = express();
    prodApp.use(cors(createCorsOptions({
      NODE_ENV: "production",
      CITIZEN_FRONTEND_ORIGIN: "https://issue-tracker-kappa-pearl.vercel.app"
    })));
    prodApp.get("/test-prod-cors", (req, res) => res.json({ ok: true }));
    prodApp.use((err, req, res, next) => {
      res.status(403).json({ error: true, message: err.message });
    });

    const prodServer = await new Promise((resolve) => {
      const s = prodApp.listen(0, "127.0.0.1", () => resolve(s));
    });
    const prodPort = prodServer.address().port;

    try {
      // Localhost request in production mode
      const res = await fetch(`http://127.0.0.1:${prodPort}/test-prod-cors`, {
        headers: { Origin: "http://localhost:3000" }
      });
      const body = await res.json();

      assert.strictEqual(res.status, 403);
      assert.strictEqual(body.error, true);
      assert.match(body.message, /CORS policy violation/i);

      // Configured deployed origin in production mode
      const allowedRes = await fetch(`http://127.0.0.1:${prodPort}/test-prod-cors`, {
        headers: { Origin: "https://issue-tracker-kappa-pearl.vercel.app" }
      });
      assert.strictEqual(allowedRes.headers.get("access-control-allow-origin"), "https://issue-tracker-kappa-pearl.vercel.app");
    } finally {
      await new Promise((resolve) => prodServer.close(resolve));
    }
  });
});
