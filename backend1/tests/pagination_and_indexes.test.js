/**
 * CivicVision AI — Database Indexes and Server-Side Pagination Test Suite (Task 1.3)
 *
 * Verifies:
 * 1. Safe parsing and boundary validation of pagination query parameters.
 * 2. Database index definitions on the Issue schema for status, userId, triage, and duplicate moderation.
 * 3. Backward-compatible unpaginated query behavior (array response + pagination headers).
 * 4. Paginated query behavior (issues array, total, page, limit, totalPages, pagination object).
 * 5. Safe handling of invalid page/limit, negative values, and out-of-range boundaries.
 * 6. Continued integrity of admin and citizen endpoint access controls.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const jwt = require("jsonwebtoken");

const Issue = require("../models/Issue");
const {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  parsePaginationParams,
  buildPaginationResponse,
  setPaginationHeaders
} = require("../utils/pagination");

const TEST_SECRET = "test_pagination_jwt_secret_987654321_xyz";
process.env.JWT_SECRET = TEST_SECRET;

describe("Task 1.3: Pagination Utilities Unit Tests", () => {
  it("uses default limit when query is empty", () => {
    const result = parsePaginationParams({});
    assert.strictEqual(result.page, 1);
    assert.strictEqual(result.limit, DEFAULT_PAGE_SIZE);
    assert.strictEqual(result.skip, 0);
    assert.strictEqual(result.isPaginated, false);
  });

  it("recognizes explicit page and limit requests", () => {
    const result = parsePaginationParams({ page: "3", limit: "15" });
    assert.strictEqual(result.page, 3);
    assert.strictEqual(result.limit, 15);
    assert.strictEqual(result.skip, 30);
    assert.strictEqual(result.isPaginated, true);
  });

  it("handles negative and zero page numbers safely by falling back to page 1", () => {
    const resNegative = parsePaginationParams({ page: "-5", limit: "20" });
    assert.strictEqual(resNegative.page, 1);
    assert.strictEqual(resNegative.skip, 0);

    const resZero = parsePaginationParams({ page: "0", limit: "20" });
    assert.strictEqual(resZero.page, 1);
    assert.strictEqual(resZero.skip, 0);
  });

  it("handles invalid non-numeric page and limit inputs safely", () => {
    const result = parsePaginationParams({ page: "invalid_page", limit: "not_a_number" });
    assert.strictEqual(result.page, 1);
    assert.strictEqual(result.limit, DEFAULT_PAGE_SIZE);
    assert.strictEqual(result.skip, 0);
  });

  it("clamps excessive limit values to MAX_PAGE_SIZE (100)", () => {
    const result = parsePaginationParams({ page: "1", limit: "5000" });
    assert.strictEqual(result.limit, MAX_PAGE_SIZE);
  });

  it("builds standardized pagination response payload with navigation flags", () => {
    const mockItems = [{ _id: "1" }, { _id: "2" }];
    const res = buildPaginationResponse(mockItems, 45, 2, 20);

    assert.strictEqual(res.issues.length, 2);
    assert.strictEqual(res.total, 45);
    assert.strictEqual(res.page, 2);
    assert.strictEqual(res.limit, 20);
    assert.strictEqual(res.totalPages, 3);
    assert.strictEqual(res.pagination.hasPrevPage, true);
    assert.strictEqual(res.pagination.hasNextPage, true);
  });

  it("handles zero total records cleanly without division by zero or NaN", () => {
    const res = buildPaginationResponse([], 0, 1, 20);
    assert.strictEqual(res.issues.length, 0);
    assert.strictEqual(res.total, 0);
    assert.strictEqual(res.page, 1);
    assert.strictEqual(res.totalPages, 1);
    assert.strictEqual(res.pagination.hasPrevPage, false);
    assert.strictEqual(res.pagination.hasNextPage, false);
  });
});

describe("Task 1.3: Issue Database Indexes Inspection", () => {
  it("declares required compound and single-field performance indexes on Issue schema", () => {
    const indexes = Issue.schema.indexes();

    // Map each index definition to its field key object
    const indexKeys = indexes.map((item) => JSON.stringify(item[0]));

    // 1. Citizen history index
    assert.ok(
      indexKeys.some((k) => k.includes('"userId":1') && k.includes('"createdAt":-1')),
      "Must define compound index { userId: 1, createdAt: -1 }"
    );

    // 2. Status timeline index
    assert.ok(
      indexKeys.some((k) => k.includes('"status":1') && k.includes('"createdAt":-1')),
      "Must define compound index { status: 1, createdAt: -1 }"
    );

    // 3. Triage & classification review index
    assert.ok(
      indexKeys.some((k) => k.includes('"needsClassificationReview":1') && k.includes('"createdAt":-1')),
      "Must define compound index { needsClassificationReview: 1, createdAt: -1 }"
    );

    // 4. Consolidated moderation queue index
    assert.ok(
      indexKeys.some((k) => k.includes('"needsReview":1') && k.includes('"createdAt":-1')),
      "Must define compound index { needsReview: 1, createdAt: -1 }"
    );

    // 5. Duplicate moderation index
    assert.ok(
      indexKeys.some((k) => k.includes('"duplicateStatus":1') && k.includes('"createdAt":-1')),
      "Must define compound index { duplicateStatus: 1, createdAt: -1 }"
    );

    // 6. Global newest-first timeline index
    assert.ok(
      indexKeys.some((k) => k.includes('"createdAt":-1')),
      "Must define timeline index { createdAt: -1 }"
    );

    // 7. Preserved 2dsphere index
    assert.ok(
      indexKeys.some((k) => k.includes('"location":"2dsphere"')),
      "Must preserve geospatial { location: '2dsphere' } index"
    );
  });

  it("keeps autoIndex disabled on Issue schema to prevent automatic production build lockups", () => {
    assert.strictEqual(Issue.schema.options.autoIndex, false);
  });
});

describe("Task 1.3: HTTP Server-Side Pagination Integration Tests", () => {
  let server;
  let baseUrl;
  let originalFind;
  let originalCount;

  // Mock dataset of 25 community issues
  const mockDataset = Array.from({ length: 25 }, (_, idx) => ({
    _id: `507f1f77bcf86cd79943900${idx + 1}`,
    userId: idx < 10 ? "507f1f77bcf86cd799439088" : "other_user_id",
    type: idx % 2 === 0 ? "pothole" : "street-light",
    description: `Community issue description #${idx + 1}`,
    status: idx % 3 === 0 ? "reported" : idx % 3 === 1 ? "in-progress" : "resolved",
    needsReview: idx % 4 === 0,
    needsClassificationReview: idx % 5 === 0,
    duplicateStatus: "unique",
    votes: idx * 2,
    createdAt: new Date(Date.now() - idx * 3600000).toISOString()
  }));

  // Chainable Mongoose Query mock
  class MockQuery {
    constructor(data) {
      this._data = [...data];
      this._skip = 0;
      this._limit = this._data.length;
    }
    select() { return this; }
    sort() { return this; }
    populate() { return this; }
    skip(n) { this._skip = Math.max(0, n); return this; }
    limit(n) { this._limit = Math.max(0, n); return this; }
    then(resolve, reject) {
      try {
        const sliced = this._data.slice(this._skip, this._skip + this._limit);
        return Promise.resolve(sliced).then(resolve, reject);
      } catch (e) {
        return Promise.reject(e).then(resolve, reject);
      }
    }
  }

  const userAuthRoutes = require("../routes/userAuth.routes");
  const adminAuthRoutes = require("../routes/adminAuth.routes");
  const issueRoutes = require("../routes/issue.routes");
  const adminDashboardRoutes = require("../routes/adminDashboard.routes");

  before(async () => {
    // Stub Mongoose Model methods for safe in-memory execution
    originalFind = Issue.find;
    originalCount = Issue.countDocuments;

    Issue.find = function (filter = {}) {
      let filtered = [...mockDataset];
      if (filter.status) {
        filtered = filtered.filter((i) => i.status === filter.status);
      }
      if (filter.userId) {
        filtered = filtered.filter((i) => i.userId === filter.userId);
      }
      return new MockQuery(filtered);
    };

    Issue.countDocuments = async function (filter = {}) {
      let filtered = [...mockDataset];
      if (filter.status) {
        filtered = filtered.filter((i) => i.status === filter.status);
      }
      if (filter.userId) {
        filtered = filtered.filter((i) => i.userId === filter.userId);
      }
      return filtered.length;
    };

    const app = express();
    app.use(express.json());

    app.use("/api/user", userAuthRoutes);
    app.use("/api/admin", adminAuthRoutes);
    app.use("/api/issues", issueRoutes);
    app.use("/api/admin-dashboard", adminDashboardRoutes);

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
    Issue.find = originalFind;
    Issue.countDocuments = originalCount;
  });

  it("GET /api/issues with unpaginated request returns array and sets X-Total-Count headers", async () => {
    const res = await fetch(`${baseUrl}/api/issues`);
    const body = await res.json();

    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(body), "Unpaginated query must return array for backward compatibility");
    assert.strictEqual(body.length, 25);
    assert.strictEqual(res.headers.get("x-total-count"), "25");
  });

  it("GET /api/issues with page=1&limit=5 returns structured pagination object", async () => {
    const res = await fetch(`${baseUrl}/api/issues?page=1&limit=5`);
    const body = await res.json();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(typeof body, "object");
    assert.ok(Array.isArray(body.issues));
    assert.strictEqual(body.issues.length, 5);
    assert.strictEqual(body.total, 25);
    assert.strictEqual(body.page, 1);
    assert.strictEqual(body.limit, 5);
    assert.strictEqual(body.totalPages, 5);
    assert.strictEqual(body.pagination.hasPrevPage, false);
    assert.strictEqual(body.pagination.hasNextPage, true);

    assert.strictEqual(res.headers.get("x-current-page"), "1");
    assert.strictEqual(res.headers.get("x-page-limit"), "5");
  });

  it("GET /api/issues with invalid negative page and limit clamps to safe defaults", async () => {
    const res = await fetch(`${baseUrl}/api/issues?page=-10&limit=-50`);
    const body = await res.json();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.page, 1);
    assert.strictEqual(body.limit, DEFAULT_PAGE_SIZE);
    assert.strictEqual(body.issues.length, 20); // Clamped to 20
  });

  it("GET /api/issues with out-of-range page number returns empty issues array without error", async () => {
    const res = await fetch(`${baseUrl}/api/issues?page=99999&limit=20`);
    const body = await res.json();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.issues.length, 0);
    assert.strictEqual(body.page, 99999);
    assert.strictEqual(body.pagination.hasNextPage, false);
    assert.strictEqual(body.pagination.hasPrevPage, true);
  });

  it("GET /api/issues/user with citizen token supports pagination and isolates user records", async () => {
    const citizenToken = jwt.sign(
      { userId: "507f1f77bcf86cd799439088", role: "citizen" },
      TEST_SECRET,
      { expiresIn: "1h" }
    );

    const res = await fetch(`${baseUrl}/api/issues/user?page=1&limit=4`, {
      headers: { Authorization: `Bearer ${citizenToken}` }
    });
    const body = await res.json();

    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(body.issues));
    assert.strictEqual(body.issues.length, 4);
    assert.strictEqual(body.total, 10); // 10 issues belong to this citizen
    assert.strictEqual(body.totalPages, 3);
  });

  it("GET /api/admin-dashboard/issues with page=1 returns paginated payload for authorized admin", async () => {
    const adminToken = jwt.sign(
      { adminId: "507f1f77bcf86cd799439099", role: "admin" },
      TEST_SECRET,
      { expiresIn: "1h" }
    );

    const res = await fetch(`${baseUrl}/api/admin-dashboard/issues?page=1&limit=10`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const body = await res.json();

    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(body.issues));
    assert.strictEqual(body.issues.length, 10);
    assert.strictEqual(body.page, 1);
    assert.strictEqual(body.limit, 10);
    assert.strictEqual(body.total, 25);
    assert.strictEqual(body.totalPages, 3);
  });

  it("GET /api/admin-dashboard/issues without pagination params returns array for legacy compatibility", async () => {
    const adminToken = jwt.sign(
      { adminId: "507f1f77bcf86cd799439099", role: "admin" },
      TEST_SECRET,
      { expiresIn: "1h" }
    );

    const res = await fetch(`${baseUrl}/api/admin-dashboard/issues`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const body = await res.json();

    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(body), "Must return array when pagination params are omitted");
    assert.strictEqual(body.length, 25);
    assert.strictEqual(res.headers.get("x-total-count"), "25");
  });

  it("GET /api/admin-dashboard/issues/filter with status=reported&page=1 filters and paginates", async () => {
    const adminToken = jwt.sign(
      { adminId: "507f1f77bcf86cd799439099", role: "admin" },
      TEST_SECRET,
      { expiresIn: "1h" }
    );

    const res = await fetch(`${baseUrl}/api/admin-dashboard/issues/filter?status=reported&page=1&limit=5`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const body = await res.json();

    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(body.issues));
    assert.ok(body.issues.every((i) => i.status === "reported"));
    assert.strictEqual(body.page, 1);
    assert.strictEqual(body.limit, 5);
  });
});
