/**
 * CivicVision AI — Sprint Block 2: Performance Analytics Test Suite
 *
 * Comprehensive integration tests for GET /api/admin-dashboard/analytics:
 * 1. Admin Authentication & Role Isolation (401 missing, 403 citizen, 200 admin).
 * 2. Empty Database / Zero Data Handling (no division by zero, null MTTR, zero-filled trend).
 * 3. Accurate Aggregation Counts (total, open, resolved, needsReview, resolution rate).
 * 4. Mean Time to Resolution (MTTR) calculation (strictly excludes legacy/unresolved/corrupted records).
 * 5. Breakdown Aggregations (byStatus, byCategory, byDepartment with Unassigned policy).
 * 6. Daily Time-Series Trend (UTC boundaries, zero-filling, custom ?days parameter).
 * 7. Hotspot Summary Aggregation (populated vs empty).
 * 8. Privacy & Data Protection (no personal info, internalNotes, or passwords leaked).
 */

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const Issue = require("../models/Issue");
const Hotspot = require("../models/Hotspot");
const Admin = require("../models/Admin");
const User = require("../models/User");
const adminDashboardRoutes = require("../routes/adminDashboard.routes");

const TEST_SECRET = "analytics_test_jwt_secret_2026_xyz";
process.env.JWT_SECRET = TEST_SECRET;

const DISPOSABLE_DB_URI = "mongodb://127.0.0.1:27017/civicvision_test_analytics_disposable";

describe("CivicVision AI — Sprint Block 2: Performance Analytics Integration Suite", () => {
  let server;
  let baseUrl;
  let adminToken;
  let adminId;
  let citizenToken;
  let citizenId;

  // Helper for HTTP requests
  async function apiRequest(path, options = {}) {
    const url = `${baseUrl}${path}`;
    const headers = { ...(options.headers || {}) };
    if (options.body && typeof options.body === "object" && !(options.body instanceof String)) {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(options.body);
    }
    const response = await fetch(url, { ...options, headers });
    let data;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { status: response.status, data };
  }

  before(async () => {
    // 1. Connect to disposable test database
    await mongoose.connect(DISPOSABLE_DB_URI, { serverSelectionTimeoutMS: 4000 });
    await mongoose.connection.db.dropDatabase();

    // 2. Setup Express test app
    const app = express();
    app.use(express.json());
    app.use("/api/admin-dashboard", adminDashboardRoutes);

    app.use((err, req, res, next) => {
      res.status(err.status || 500).json({ error: true, message: err.message });
    });

    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });

    // 3. Seed test Admin
    const adminDoc = await Admin.create({
      fullName: "Analytics Officer",
      email: "analytics.admin@civicvision.gov",
      password: "hashedpassword123"
    });
    adminId = adminDoc._id.toString();
    adminToken = jwt.sign({ adminId, role: "admin", email: adminDoc.email }, TEST_SECRET, { expiresIn: "2h" });

    // 4. Seed test Citizen
    const citizenDoc = await User.create({
      fullName: "Sample Citizen",
      email: "citizen@civicvision.local",
      password: "citizenpassword"
    });
    citizenId = citizenDoc._id.toString();
    citizenToken = jwt.sign({ userId: citizenId, role: "citizen", email: citizenDoc.email }, TEST_SECRET, { expiresIn: "2h" });
  });

  after(async () => {
    try {
      if (server) await new Promise((r) => server.close(r));
      if (mongoose.connection.readyState !== 0) {
        await mongoose.connection.db.dropDatabase();
        await mongoose.disconnect();
      }
    } catch (e) {
      // Clean shutdown
    }
  });

  beforeEach(async () => {
    // Clean collections before each test for deterministic assertions
    await Issue.deleteMany({});
    await Hotspot.deleteMany({});
  });

  // =========================================================================
  // CATEGORY 1: Authentication & Role Enforcement
  // =========================================================================
  describe("1. Authentication & Role Boundaries", () => {
    it("1.1 Rejects request without token with 401 Unauthorized", async () => {
      const res = await apiRequest("/api/admin-dashboard/analytics");
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.data.error, true);
    });

    it("1.2 Rejects citizen token with 403 Forbidden", async () => {
      const res = await apiRequest("/api/admin-dashboard/analytics", {
        headers: { Authorization: `Bearer ${citizenToken}` }
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.data.error, true);
    });

    it("1.3 Accepts valid admin token with 200 OK", async () => {
      const res = await apiRequest("/api/admin-dashboard/analytics", {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.error, false);
      assert.ok(res.data.data);
    });
  });

  // =========================================================================
  // CATEGORY 2: Empty Database & Zero-Data Boundary Handling
  // =========================================================================
  describe("2. Zero Data & Division-by-Zero Protection", () => {
    it("2.1 Returns clean zero-values without arithmetic or division errors on empty database", async () => {
      const res = await apiRequest("/api/admin-dashboard/analytics", {
        headers: { Authorization: `Bearer ${adminToken}` }
      });

      assert.strictEqual(res.status, 200);
      const { summary, mttr, breakdowns, hotspots, trend, metadata } = res.data.data;

      // Summary assertions
      assert.strictEqual(summary.totalIssues, 0);
      assert.strictEqual(summary.openIssues, 0);
      assert.strictEqual(summary.resolvedIssues, 0);
      assert.strictEqual(summary.reportedIssues, 0);
      assert.strictEqual(summary.inProgressIssues, 0);
      assert.strictEqual(summary.needsReviewIssues, 0);
      assert.strictEqual(summary.resolutionRate, 0.0);
      assert.strictEqual(summary.resolutionRateFormatted, "0.0%");

      // MTTR assertions on empty database
      assert.strictEqual(mttr.avgMs, null);
      assert.strictEqual(mttr.avgHours, null);
      assert.strictEqual(mttr.avgDays, null);
      assert.strictEqual(mttr.sampleSize, 0);
      assert.match(mttr.formatted, /N\/A/i);

      // Breakdowns
      assert.strictEqual(breakdowns.byStatus.reported, 0);
      assert.strictEqual(breakdowns.byStatus["in-progress"], 0);
      assert.strictEqual(breakdowns.byStatus.resolved, 0);
      assert.deepStrictEqual(breakdowns.byCategory, []);
      assert.deepStrictEqual(breakdowns.byDepartment, []);

      // Hotspots on empty collection
      assert.strictEqual(hotspots.total, 0);
      assert.strictEqual(hotspots.active, 0);
      assert.strictEqual(hotspots.totalDistinctDefects, 0);
      assert.deepStrictEqual(hotspots.byCategory, []);

      // Trend: 30 continuous zero-filled daily buckets
      assert.strictEqual(trend.interval, "daily");
      assert.strictEqual(trend.timezone, "UTC");
      assert.strictEqual(trend.days, 30);
      assert.strictEqual(trend.data.length, 30);
      assert.ok(trend.data.every((d) => d.created === 0 && d.resolved === 0));

      // Policies metadata present
      assert.ok(metadata.policies.openIssuesDefinition);
      assert.ok(metadata.policies.resolutionRateDenominator);
      assert.ok(metadata.policies.mttrDenominator);
    });
  });

  // =========================================================================
  // CATEGORY 3: Accurate Aggregations & Status Semantics
  // =========================================================================
  describe("3. Aggregation Counts & Status Semantics", () => {
    it("3.1 Correctly computes total, open (reported + in-progress), and resolved counts", async () => {
      const now = new Date();

      // Seed 2 reported
      await Issue.create([
        {
          userId: new mongoose.Types.ObjectId(citizenId),
          type: "pothole",
          description: "Pothole 1",
          location: { type: "Point", coordinates: [77.72, 11.34] },
          status: "reported",
          createdAt: now
        },
        {
          userId: new mongoose.Types.ObjectId(citizenId),
          type: "garbage",
          description: "Garbage pile",
          location: { type: "Point", coordinates: [77.72, 11.34] },
          status: "reported",
          createdAt: now
        }
      ]);

      // Seed 3 in-progress
      await Issue.create([
        {
          userId: new mongoose.Types.ObjectId(citizenId),
          type: "pothole",
          description: "Pothole 2",
          location: { type: "Point", coordinates: [77.72, 11.34] },
          status: "in-progress",
          createdAt: now
        },
        {
          userId: new mongoose.Types.ObjectId(citizenId),
          type: "street_light",
          description: "Light out",
          location: { type: "Point", coordinates: [77.72, 11.34] },
          status: "in-progress",
          createdAt: now
        },
        {
          userId: new mongoose.Types.ObjectId(citizenId),
          type: "road_damage",
          description: "Cracked curb",
          location: { type: "Point", coordinates: [77.72, 11.34] },
          status: "in-progress",
          needsReview: true,
          createdAt: now
        }
      ]);

      // Seed 5 resolved
      await Issue.create([
        {
          userId: new mongoose.Types.ObjectId(citizenId),
          type: "pothole",
          description: "Pothole 3",
          location: { type: "Point", coordinates: [77.72, 11.34] },
          status: "resolved",
          resolvedAt: new Date(now.getTime() + 3600000),
          createdAt: now
        },
        {
          userId: new mongoose.Types.ObjectId(citizenId),
          type: "pothole",
          description: "Pothole 4",
          location: { type: "Point", coordinates: [77.72, 11.34] },
          status: "resolved",
          resolvedAt: new Date(now.getTime() + 7200000),
          createdAt: now
        },
        {
          userId: new mongoose.Types.ObjectId(citizenId),
          type: "water_leak",
          description: "Water pipe",
          location: { type: "Point", coordinates: [77.72, 11.34] },
          status: "resolved",
          resolvedAt: new Date(now.getTime() + 10800000),
          createdAt: now
        },
        {
          userId: new mongoose.Types.ObjectId(citizenId),
          type: "garbage",
          description: "Litter cleared",
          location: { type: "Point", coordinates: [77.72, 11.34] },
          status: "resolved",
          resolvedAt: new Date(now.getTime() + 14400000),
          createdAt: now
        },
        {
          userId: new mongoose.Types.ObjectId(citizenId),
          type: "traffic_signal",
          description: "Signal bulb fixed",
          location: { type: "Point", coordinates: [77.72, 11.34] },
          status: "resolved",
          resolvedAt: new Date(now.getTime() + 18000000),
          createdAt: now
        }
      ]);

      const res = await apiRequest("/api/admin-dashboard/analytics", {
        headers: { Authorization: `Bearer ${adminToken}` }
      });

      assert.strictEqual(res.status, 200);
      const { summary } = res.data.data;

      assert.strictEqual(summary.totalIssues, 10);
      assert.strictEqual(summary.reportedIssues, 2);
      assert.strictEqual(summary.inProgressIssues, 3);
      assert.strictEqual(summary.openIssues, 5, "Open issues must equal reported (2) + in-progress (3)");
      assert.strictEqual(summary.resolvedIssues, 5);
      assert.strictEqual(summary.needsReviewIssues, 1);
      assert.strictEqual(summary.resolutionRate, 0.5);
      assert.strictEqual(summary.resolutionRateFormatted, "50.0%");
    });
  });

  // =========================================================================
  // CATEGORY 4: MTTR Calculation & Timestamp Edge Cases
  // =========================================================================
  describe("4. Mean Time to Resolution (MTTR) Edge Cases", () => {
    it("4.1 Calculates exact MTTR from valid resolved records, strictly excluding unresolved, legacy, and corrupted records", async () => {
      const baseTime = new Date("2026-10-01T10:00:00.000Z");

      // Valid 1: took 2.0 hours (7,200,000 ms)
      const res1 = new Date(baseTime.getTime() + 2 * 3600 * 1000);
      await Issue.create({
        userId: new mongoose.Types.ObjectId(citizenId),
        type: "pothole",
        description: "Valid resolution 1",
        location: { type: "Point", coordinates: [77.72, 11.34] },
        status: "resolved",
        createdAt: baseTime,
        resolvedAt: res1
      });

      // Valid 2: took 4.0 hours (14,400,000 ms)
      const res2 = new Date(baseTime.getTime() + 4 * 3600 * 1000);
      await Issue.create({
        userId: new mongoose.Types.ObjectId(citizenId),
        type: "pothole",
        description: "Valid resolution 2",
        location: { type: "Point", coordinates: [77.72, 11.34] },
        status: "resolved",
        createdAt: baseTime,
        resolvedAt: res2
      });

      // Legacy resolved issue without resolvedAt timestamp: MUST NOT BE INVENTED OR COUNTED
      await Issue.create({
        userId: new mongoose.Types.ObjectId(citizenId),
        type: "pothole",
        description: "Legacy resolved issue without resolvedAt",
        location: { type: "Point", coordinates: [77.72, 11.34] },
        status: "resolved",
        createdAt: baseTime,
        resolvedAt: null
      });

      // Unresolved issue with createdAt: MUST NOT BE COUNTED
      await Issue.create({
        userId: new mongoose.Types.ObjectId(citizenId),
        type: "pothole",
        description: "Open in-progress issue",
        location: { type: "Point", coordinates: [77.72, 11.34] },
        status: "in-progress",
        createdAt: baseTime
      });

      // Corrupted record with resolvedAt before createdAt (negative duration): MUST BE EXCLUDED
      await Issue.create({
        userId: new mongoose.Types.ObjectId(citizenId),
        type: "pothole",
        description: "Corrupted timestamp record",
        location: { type: "Point", coordinates: [77.72, 11.34] },
        status: "resolved",
        createdAt: baseTime,
        resolvedAt: new Date(baseTime.getTime() - 3600 * 1000)
      });

      const res = await apiRequest("/api/admin-dashboard/analytics", {
        headers: { Authorization: `Bearer ${adminToken}` }
      });

      assert.strictEqual(res.status, 200);
      const { mttr } = res.data.data;

      // Expected MTTR: (2 + 4) / 2 = 3.0 hours = 10,800,000 ms
      assert.strictEqual(mttr.sampleSize, 2, "Only the 2 valid resolved records must be in sample");
      assert.strictEqual(mttr.avgHours, 3.0);
      assert.strictEqual(mttr.avgMs, 10800000);
      assert.strictEqual(mttr.formatted, "3.0 hrs");
    });
  });

  // =========================================================================
  // CATEGORY 5: Category & Department Breakdowns
  // =========================================================================
  describe("5. Category & Department Breakdowns", () => {
    it("5.1 Groups categories and canonicalizes null/empty departments as 'Unassigned'", async () => {
      const now = new Date();

      await Issue.create([
        // Department: Roads & Infrastructure
        {
          userId: new mongoose.Types.ObjectId(citizenId),
          type: "pothole",
          description: "Road issue 1",
          department: "Roads & Infrastructure",
          location: { type: "Point", coordinates: [77.72, 11.34] },
          status: "reported",
          createdAt: now
        },
        {
          userId: new mongoose.Types.ObjectId(citizenId),
          type: "road_damage",
          description: "Road issue 2",
          department: "Roads & Infrastructure",
          location: { type: "Point", coordinates: [77.72, 11.34] },
          status: "in-progress",
          createdAt: now
        },
        // Department: Waste Management
        {
          userId: new mongoose.Types.ObjectId(citizenId),
          type: "garbage",
          description: "Waste issue",
          department: "Waste Management",
          location: { type: "Point", coordinates: [77.72, 11.34] },
          status: "reported",
          createdAt: now
        },
        // Department null -> Unassigned
        {
          userId: new mongoose.Types.ObjectId(citizenId),
          type: "pothole",
          description: "Unassigned issue 1",
          department: null,
          location: { type: "Point", coordinates: [77.72, 11.34] },
          status: "reported",
          createdAt: now
        },
        // Department empty string -> Unassigned
        {
          userId: new mongoose.Types.ObjectId(citizenId),
          type: "street_light",
          description: "Unassigned issue 2",
          department: "",
          location: { type: "Point", coordinates: [77.72, 11.34] },
          status: "in-progress",
          createdAt: now
        }
      ]);

      const res = await apiRequest("/api/admin-dashboard/analytics", {
        headers: { Authorization: `Bearer ${adminToken}` }
      });

      assert.strictEqual(res.status, 200);
      const { byCategory, byDepartment } = res.data.data.breakdowns;

      // Category breakdown checks
      const potholeCat = byCategory.find((c) => c.category === "pothole");
      assert.ok(potholeCat);
      assert.strictEqual(potholeCat.count, 2);
      assert.strictEqual(potholeCat.percentage, "40.0%");

      // Department breakdown checks: Unassigned policy
      const unassignedDept = byDepartment.find((d) => d.department === "Unassigned");
      assert.ok(unassignedDept, "Must aggregate null/empty departments as 'Unassigned'");
      assert.strictEqual(unassignedDept.count, 2);
      assert.strictEqual(unassignedDept.percentage, "40.0%");

      const roadsDept = byDepartment.find((d) => d.department === "Roads & Infrastructure");
      assert.ok(roadsDept);
      assert.strictEqual(roadsDept.count, 2);

      const wasteDept = byDepartment.find((d) => d.department === "Waste Management");
      assert.ok(wasteDept);
      assert.strictEqual(wasteDept.count, 1);
    });
  });

  // =========================================================================
  // CATEGORY 6: Daily Trend & Query Window Bounds
  // =========================================================================
  describe("6. Daily Time Series & Trend Query Bounds", () => {
    it("6.1 Zero-fills missing dates and respects query parameter ?days=14", async () => {
      // Seed an issue created today in UTC
      const today = new Date();
      await Issue.create({
        userId: new mongoose.Types.ObjectId(citizenId),
        type: "pothole",
        description: "Today's pothole",
        location: { type: "Point", coordinates: [77.72, 11.34] },
        status: "reported",
        createdAt: today
      });

      const res = await apiRequest("/api/admin-dashboard/analytics?days=14", {
        headers: { Authorization: `Bearer ${adminToken}` }
      });

      assert.strictEqual(res.status, 200);
      const { trend } = res.data.data;

      assert.strictEqual(trend.days, 14);
      assert.strictEqual(trend.data.length, 14);

      // Verify today has created: 1 and earlier days are zero-filled
      const todayUtcStr = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
      const todayEntry = trend.data.find((d) => d.date === todayUtcStr);
      assert.ok(todayEntry, `Today's date ${todayUtcStr} must exist in trend data`);
      assert.strictEqual(todayEntry.created, 1);

      // Other 13 days should have created: 0
      const otherDays = trend.data.filter((d) => d.date !== todayUtcStr);
      assert.strictEqual(otherDays.length, 13);
      assert.ok(otherDays.every((d) => d.created === 0 && d.resolved === 0));
    });

    it("6.2 Bounds out-of-range days parameters between 1 and 90", async () => {
      const resLow = await apiRequest("/api/admin-dashboard/analytics?days=-5", {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      assert.strictEqual(resLow.status, 200);
      assert.strictEqual(resLow.data.data.trend.days, 1);

      const resHigh = await apiRequest("/api/admin-dashboard/analytics?days=500", {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      assert.strictEqual(resHigh.status, 200);
      assert.strictEqual(resHigh.data.data.trend.days, 90);
    });
  });

  // =========================================================================
  // CATEGORY 7: Hotspot Summary Integration
  // =========================================================================
  describe("7. Hotspot Summary Aggregation", () => {
    it("7.1 Summarizes active clusters, report counts, and mean severity from Hotspot model", async () => {
      const now = new Date();

      await Hotspot.create([
        {
          title: "Cluster A - Potholes",
          category: "pothole",
          department: "Roads & Infrastructure",
          centroid: { type: "Point", coordinates: [77.72, 11.34] },
          radiusMeters: 45,
          distinctDefectCount: 4,
          totalReportCount: 9,
          meanSeverity: 7.5,
          status: "active",
          firstDetectedAt: now,
          lastDetectedAt: now,
          issueIds: [new mongoose.Types.ObjectId()]
        },
        {
          title: "Cluster B - Garbage",
          category: "garbage",
          department: "Waste Management",
          centroid: { type: "Point", coordinates: [77.73, 11.35] },
          radiusMeters: 60,
          distinctDefectCount: 3,
          totalReportCount: 7,
          meanSeverity: 6.0,
          status: "resolving",
          firstDetectedAt: now,
          lastDetectedAt: now,
          issueIds: [new mongoose.Types.ObjectId()]
        }
      ]);

      const res = await apiRequest("/api/admin-dashboard/analytics", {
        headers: { Authorization: `Bearer ${adminToken}` }
      });

      assert.strictEqual(res.status, 200);
      const { hotspots } = res.data.data;

      assert.strictEqual(hotspots.total, 2);
      assert.strictEqual(hotspots.active, 1);
      assert.strictEqual(hotspots.resolving, 1);
      assert.strictEqual(hotspots.totalDistinctDefects, 7);
      assert.strictEqual(hotspots.totalCitizenReports, 16);
      assert.strictEqual(hotspots.avgSeverity, 6.75); // (7.5 + 6.0) / 2
      assert.strictEqual(hotspots.byCategory.length, 2);
    });
  });

  // =========================================================================
  // CATEGORY 8: Privacy & Data Protection Audit
  // =========================================================================
  describe("8. Privacy & Security Data Protection", () => {
    it("8.1 Response strictly excludes passwords, tokens, private internal notes, and citizen personal info", async () => {
      await Issue.create({
        userId: new mongoose.Types.ObjectId(citizenId),
        type: "pothole",
        description: "Public issue description",
        internalNotes: "Highly confidential municipal contractor contract #99812",
        location: { type: "Point", coordinates: [77.72, 11.34] },
        status: "in-progress"
      });

      const res = await apiRequest("/api/admin-dashboard/analytics", {
        headers: { Authorization: `Bearer ${adminToken}` }
      });

      assert.strictEqual(res.status, 200);
      const jsonStr = JSON.stringify(res.data);

      assert.strictEqual(jsonStr.includes("Highly confidential municipal contractor"), false);
      assert.strictEqual(jsonStr.includes("internalNotes"), false);
      assert.strictEqual(jsonStr.includes("password"), false);
      assert.strictEqual(jsonStr.includes("citizen@civicvision.local"), false);
    });
  });
});
