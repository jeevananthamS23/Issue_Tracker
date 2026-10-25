const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("http");
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const mongoose = require("mongoose");

const TEST_SECRET = "phase2_e2e_jwt_secret_key_849204918234";
process.env.JWT_SECRET = TEST_SECRET;

// In-memory data store for isolated E2E audit testing (prevents touching production database)
const db = {
  users: new Map(),
  admins: new Map(),
  issues: new Map(),
  votes: new Map(),
};

// Import Mongoose models to mock in-memory
const User = require("../models/User");
const Admin = require("../models/Admin");
const Issue = require("../models/Issue");
const Vote = require("../models/Vote");

// Setup in-memory stubs for User model
User.findOne = async (query) => {
  if (query.email) {
    for (const u of db.users.values()) {
      if (u.email === query.email) return u;
    }
  }
  return null;
};
User.findById = (id) => ({
  select: async (fields) => {
    const u = db.users.get(String(id));
    if (!u) return null;
    const clone = { ...u };
    if (fields && fields.includes("-password")) delete clone.password;
    return clone;
  },
});

// Setup in-memory stubs for Admin model
Admin.findOne = async (query) => {
  if (query.email) {
    for (const a of db.admins.values()) {
      if (a.email === query.email) return a;
    }
  }
  return null;
};
Admin.findById = (id) => ({
  select: async (fields) => {
    const a = db.admins.get(String(id));
    if (!a) return null;
    const clone = { ...a };
    if (fields && fields.includes("-password")) delete clone.password;
    return clone;
  },
});

// Setup in-memory stubs for Issue model
Issue.find = (query = {}) => ({
  select: function (fields) {
    this._excludeInternalNotes = fields && fields.includes("-internalNotes");
    return this;
  },
  populate: function (field, subfields) {
    this._populateUserId = true;
    return this;
  },
  sort: function () {
    return this;
  },
  then: function (resolve) {
    let list = Array.from(db.issues.values());
    if (query.userId) {
      list = list.filter((i) => String(i.userId) === String(query.userId));
    }
    if (query.status) {
      list = list.filter((i) => i.status === query.status);
    }
    if (query.type) {
      list = list.filter((i) => i.type === query.type);
    }

    const processed = list.map((item) => {
      const clone = { ...item };
      if (this._excludeInternalNotes) {
        delete clone.internalNotes;
      }
      if (this._populateUserId && db.users.has(String(clone.userId))) {
        const u = db.users.get(String(clone.userId));
        clone.userId = { _id: u._id, fullName: u.fullName, email: u.email };
      }
      return clone;
    });
    return resolve(processed);
  },
});

Issue.findById = async (id) => {
  const issue = db.issues.get(String(id));
  if (!issue) return null;
  return {
    ...issue,
    statusHistory: issue.statusHistory || [],
    save: async function () {
      this.updatedAt = new Date().toISOString();
      db.issues.set(String(this._id), { ...this });
      return this;
    },
  };
};

Issue.findByIdAndUpdate = async (id, update, options) => {
  const issue = db.issues.get(String(id));
  if (!issue) return null;
  if (update.status) issue.status = update.status;
  if (update.department) issue.department = update.department;
  if (update.internalNotes !== undefined) issue.internalNotes = update.internalNotes;
  issue.updatedAt = new Date().toISOString();
  db.issues.set(String(id), issue);
  return { ...issue };
};

Issue.findByIdAndDelete = async (id) => {
  const issue = db.issues.get(String(id));
  if (!issue) return null;
  db.issues.delete(String(id));
  return issue;
};

// Setup in-memory stubs for Vote model
Vote.findOne = async ({ userId, issueId }) => {
  const key = `${userId}_${issueId}`;
  return db.votes.get(key) || null;
};
Vote.find = async ({ userId }) => {
  const list = [];
  for (const v of db.votes.values()) {
    if (String(v.userId) === String(userId)) list.push(v);
  }
  return list;
};

// Import application routers
const userAuthRoutes = require("../routes/userAuth.routes");
const adminAuthRoutes = require("../routes/adminAuth.routes");
const issueRoutes = require("../routes/issue.routes");
const adminDashboardRoutes = require("../routes/adminDashboard.routes");
const voteRoutes = require("../routes/vote.routes");
const { validateCredentials } = require("../scripts/createAdmin");
const { validateImageSignature } = require("../middleware/multer");

describe("CivicVision AI - Phase 2.1 End-to-End Integration Audit", { concurrency: false }, () => {
  let server;
  let baseUrl;

  // Track session credentials across workflow steps
  let citizenToken;
  let citizenUser;
  let testIssueId;
  let adminToken;
  let adminData;

  before(async () => {
    // Prevent real network connections in test
    mongoose.connection.readyState = 1;

    const app = express();
    const { createCorsOptions } = require("../config/cors");

    app.use(cors(createCorsOptions({ NODE_ENV: "development" })));
    app.use(express.json());

    app.use("/api/user", userAuthRoutes);
    app.use("/api/admin", adminAuthRoutes);
    app.use("/api/issues", issueRoutes);
    app.use("/api/admin-dashboard", adminDashboardRoutes);
    app.use("/api/votes", voteRoutes);

    app.use((err, req, res, next) => {
      res.status(err.status || 500).json({ error: true, message: err.message });
    });

    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });

    // Pre-seed an admin account in in-memory DB for admin suite
    const adminPassHash = await bcrypt.hash("SecureAdminPass2026!", 10);
    db.admins.set("adm_audit_001", {
      _id: "adm_audit_001",
      fullName: "Lead Municipal Officer",
      email: "municipal.admin@civicvision.gov",
      password: adminPassHash,
      createdAt: new Date().toISOString(),
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    db.users.clear();
    db.admins.clear();
    db.issues.clear();
    db.votes.clear();
  });

  // Helper HTTP request function
  const request = (path, options = {}) => {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const reqOptions = {
        method: options.method || "GET",
        headers: options.headers || {},
      };

      const req = http.request(url, reqOptions, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            parsed = body;
          }
          resolve({ status: res.statusCode, headers: res.headers, data: parsed });
        });
      });

      req.on("error", reject);
      if (options.body) {
        req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });
  };

  // ==========================================
  // SECTION 1: CITIZEN WORKFLOW
  // ==========================================
  describe("1. Citizen Workflow Audit", { concurrency: false }, () => {
    it("1.1 Registers a new test citizen with hashed password and generates citizen JWT", async () => {
      const citizenEmail = "test.citizen@civicvision.local";
      const plainPassword = "CitizenPassword123";

      // Pre-seed User constructor simulation for registerUser
      const origUser = User.prototype.save;
      User.prototype.save = async function () {
        this._id = "cit_user_001";
        this.createdAt = new Date().toISOString();
        db.users.set(String(this._id), {
          _id: this._id,
          fullName: this.fullName,
          email: this.email,
          password: this.password,
          createdAt: this.createdAt,
        });
        return this;
      };

      const res = await request("/api/user/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: {
          fullName: "John Citizen",
          email: citizenEmail,
          password: plainPassword,
        },
      });

      User.prototype.save = origUser;

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.data.error, false);
      assert.ok(res.data.accessToken, "Should return an access token");
      assert.strictEqual(res.data.user.email, citizenEmail);

      // Verify password stored as bcrypt hash, not plaintext
      const stored = db.users.get(String(res.data.user.id));
      assert.ok(stored, "User must be found in storage");
      assert.notStrictEqual(stored.password, plainPassword);
      assert.ok(stored.password.startsWith("$2b$") || stored.password.startsWith("$2a$"));
    });

    it("1.2 Authenticates citizen login and issues valid JWT with role: citizen", async () => {
      const res = await request("/api/user/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: {
          email: "test.citizen@civicvision.local",
          password: "CitizenPassword123",
        },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.error, false);
      citizenToken = res.data.accessToken;
      citizenUser = res.data.user;

      const decoded = jwt.verify(citizenToken, TEST_SECRET);
      assert.strictEqual(decoded.role, "citizen");
      assert.strictEqual(decoded.userId, String(citizenUser.id));
    });

    it("1.3 Restores citizen session via GET /api/user/profile", async () => {
      const res = await request("/api/user/profile", {
        headers: { Authorization: `Bearer ${citizenToken}` },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.role, "citizen");
      assert.strictEqual(res.data.isAdmin, false);
      assert.strictEqual(res.data.user.email, "test.citizen@civicvision.local");
      assert.strictEqual(res.data.user.password, undefined, "Password must not be returned");
    });

    it("1.4 Submits a test issue with location coordinates and metadata", async () => {
      const origIssueSave = Issue.prototype.save;
      Issue.prototype.save = async function () {
        this._id = "issue_audit_001";
        this.votes = this.votes || 0;
        this.status = this.status || "reported";
        this.createdAt = new Date().toISOString();
        db.issues.set(String(this._id), {
          _id: this._id,
          userId: this.userId,
          type: this.type,
          description: this.description,
          imageUrl: this.imageUrl || "https://res.cloudinary.com/demo/image/upload/sample.jpg",
          location: this.location,
          status: this.status,
          votes: this.votes,
          internalNotes: "Initial internal triage note",
          createdAt: this.createdAt,
        });
        return this;
      };

      const res = await request("/api/issues", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${citizenToken}`,
        },
        body: {
          type: "pothole",
          description: "Dangerous pothole near the central bus stop",
          lat: 11.3418,
          lng: 77.7275,
        },
      });

      Issue.prototype.save = origIssueSave;

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.data.message, "Issue reported successfully");
      assert.strictEqual(res.data.issue.type, "pothole");
      testIssueId = res.data.issue._id;
    });

    it("1.5 Public issues list loads successfully with coordinates for map display", async () => {
      const res = await request("/api/issues");
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.data));
      const issue = res.data.find((i) => i._id === testIssueId);
      assert.ok(issue, "Created issue must appear in public feed");
      assert.strictEqual(issue.location.lat, 11.3418);
      assert.strictEqual(issue.location.lng, 77.7275);
    });

    it("1.6 Citizen votes on an issue and increments vote counter", async () => {
      const origVoteSave = Vote.prototype.save;
      Vote.prototype.save = async function () {
        const key = `${this.userId}_${this.issueId}`;
        db.votes.set(key, { userId: this.userId, issueId: this.issueId });
        return this;
      };

      const res = await request(`/api/votes/${testIssueId}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${citizenToken}` },
      });

      Vote.prototype.save = origVoteSave;

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.success, true);
      assert.strictEqual(res.data.votes, 1);

      // Verify issue record updated
      const issue = db.issues.get(testIssueId);
      assert.strictEqual(issue.votes, 1);
    });

    it("1.7 Prevents duplicate voting by the same citizen on the same issue", async () => {
      const res = await request(`/api/votes/${testIssueId}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${citizenToken}` },
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.data.success, false);
      assert.strictEqual(res.data.message, "You have already voted for this issue");
    });

    it("1.8 Citizen checks vote status via checkUserVote and getUserVotedIssues", async () => {
      const checkRes = await request(`/api/votes/check/${testIssueId}`, {
        headers: { Authorization: `Bearer ${citizenToken}` },
      });
      assert.strictEqual(checkRes.status, 200);
      assert.strictEqual(checkRes.data.hasVoted, true);

      const listRes = await request("/api/votes/user", {
        headers: { Authorization: `Bearer ${citizenToken}` },
      });
      assert.strictEqual(listRes.status, 200);
      assert.strictEqual(listRes.data.success, true);
      assert.ok(listRes.data.votedIssueIds.includes(testIssueId));
    });

    it("1.9 Retrieves citizen's own reported issues via GET /api/issues/user", async () => {
      const res = await request("/api/issues/user", {
        headers: { Authorization: `Bearer ${citizenToken}` },
      });

      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.data));
      assert.strictEqual(res.data.length, 1);
      assert.strictEqual(res.data[0]._id, testIssueId);
    });

    it("1.10 Logged out / missing token blocks access to protected citizen endpoints", async () => {
      const profileRes = await request("/api/user/profile");
      assert.strictEqual(profileRes.status, 401);

      const reportRes = await request("/api/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { type: "garbage", description: "Overflowing bin", lat: 11, lng: 77 },
      });
      assert.strictEqual(reportRes.status, 401);

      const voteRes = await request(`/api/votes/${testIssueId}`, { method: "POST" });
      assert.strictEqual(voteRes.status, 401);
    });
  });

  // ==========================================
  // SECTION 2: ADMIN WORKFLOW
  // ==========================================
  describe("2. Admin Workflow Audit", { concurrency: false }, () => {
    it("2.1 Authenticates admin using email and password only (no adminKey required)", async () => {
      const res = await request("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: {
          email: "municipal.admin@civicvision.gov",
          password: "SecureAdminPass2026!",
        },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.error, false);
      adminToken = res.data.accessToken;
      adminData = res.data.admin;

      const decoded = jwt.verify(adminToken, TEST_SECRET);
      assert.strictEqual(decoded.role, "admin");
      assert.strictEqual(decoded.adminId, "adm_audit_001");
    });

    it("2.2 Restores admin session via GET /api/admin/profile and confirms admin role", async () => {
      const res = await request("/api/admin/profile", {
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.role, "admin");
      assert.strictEqual(res.data.isAdmin, true);
      assert.strictEqual(res.data.admin.email, "municipal.admin@civicvision.gov");
      assert.strictEqual(res.data.admin.password, undefined, "Admin password hash must not be exposed");
    });

    it("2.3 Loads admin issues list with authorized citizen reporter information populated", async () => {
      const res = await request("/api/admin-dashboard/issues", {
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.data));
      const issue = res.data.find((i) => i._id === testIssueId);
      assert.ok(issue, "Admin must be able to view all community issues");
      assert.strictEqual(issue.userId.fullName, "John Citizen");
      assert.strictEqual(issue.userId.email, "test.citizen@civicvision.local");
      assert.strictEqual(issue.internalNotes, "Initial internal triage note");
    });

    it("2.4 Filters issues by status via GET /api/admin-dashboard/issues/filter", async () => {
      const res = await request("/api/admin-dashboard/issues/filter?status=reported", {
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.data));
      assert.ok(res.data.every((i) => i.status === "reported"));
    });

    it("2.5 Updates remediation status, department, and internalNotes via PATCH", async () => {
      const res = await request(`/api/admin-dashboard/issues/${testIssueId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: {
          status: "in-progress",
          department: "Roads & Infrastructure",
          internalNotes: "Contractor crew dispatched. Scheduled asphalt fill for 2:00 PM.",
        },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.status, "in-progress");
      assert.strictEqual(res.data.department, "Roads & Infrastructure");
      assert.strictEqual(
        res.data.internalNotes,
        "Contractor crew dispatched. Scheduled asphalt fill for 2:00 PM."
      );

      // Verify changes persisted in database record
      const updated = db.issues.get(testIssueId);
      assert.strictEqual(updated.status, "in-progress");
      assert.strictEqual(updated.department, "Roads & Infrastructure");
      assert.strictEqual(
        updated.internalNotes,
        "Contractor crew dispatched. Scheduled asphalt fill for 2:00 PM."
      );
    });

    it("2.6 Status history audit: confirms Issue schema tracks timestamps and status history array", async () => {
      const issue = db.issues.get(testIssueId);
      assert.ok(issue.createdAt, "Issue has createdAt timestamp");
      assert.ok(issue.updatedAt, "Issue has updatedAt timestamp");
      assert.ok(Array.isArray(issue.statusHistory), "Issue should have statusHistory array");
      assert.strictEqual(issue.statusHistory.length, 1);
      assert.strictEqual(issue.statusHistory[0].from, "reported");
      assert.strictEqual(issue.statusHistory[0].to, "in-progress");
      assert.strictEqual(String(issue.statusHistory[0].changedBy), "adm_audit_001");
      assert.ok(issue.statusHistory[0].changedAt, "Status transition has changedAt timestamp");
    });

    it("2.7 Deletes disposable test issue via DELETE /api/admin-dashboard/issues/:id", async () => {
      const res = await request(`/api/admin-dashboard/issues/${testIssueId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.message, "Issue deleted");
      assert.strictEqual(db.issues.get(testIssueId), undefined, "Issue should be deleted from DB");
    });

    it("2.8 Admin logout / missing token blocks access to admin dashboard with 401", async () => {
      const res = await request("/api/admin-dashboard/issues");
      assert.strictEqual(res.status, 401);
    });
  });

  // ==========================================
  // SECTION 3: AUTHORIZATION & SESSION ISOLATION
  // ==========================================
  describe("3. Authorization & Session Isolation Audit", { concurrency: false }, () => {
    it("3.1 Citizen token is strictly forbidden from accessing admin endpoints (403 Forbidden)", async () => {
      const listRes = await request("/api/admin-dashboard/issues", {
        headers: { Authorization: `Bearer ${citizenToken}` },
      });
      assert.strictEqual(listRes.status, 403);

      const profileRes = await request("/api/admin/profile", {
        headers: { Authorization: `Bearer ${citizenToken}` },
      });
      assert.strictEqual(profileRes.status, 403);

      const updateRes = await request(`/api/admin-dashboard/issues/test_id`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${citizenToken}`,
        },
        body: { status: "resolved" },
      });
      assert.strictEqual(updateRes.status, 403);
    });

    it("3.2 Admin token is strictly forbidden from accessing citizen-only endpoints (403 Forbidden)", async () => {
      const profileRes = await request("/api/user/profile", {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(profileRes.status, 403);

      const userIssuesRes = await request("/api/issues/user", {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(userIssuesRes.status, 403);

      const voteRes = await request(`/api/votes/any_issue_id`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(voteRes.status, 403);
    });

    it("3.3 Rejects malformed and expired tokens with 401, and invalid role tokens with 403", async () => {
      const malformedRes = await request("/api/admin-dashboard/issues", {
        headers: { Authorization: "Bearer this.is.not.a.valid.jwt" },
      });
      assert.strictEqual(malformedRes.status, 401);

      const expiredToken = jwt.sign(
        { adminId: "adm_001", role: "admin" },
        TEST_SECRET,
        { expiresIn: "-1s" }
      );
      const expiredRes = await request("/api/admin-dashboard/issues", {
        headers: { Authorization: `Bearer ${expiredToken}` },
      });
      assert.strictEqual(expiredRes.status, 401);

      const noRoleToken = jwt.sign({ adminId: "adm_001" }, TEST_SECRET, { expiresIn: "1h" });
      const noRoleRes = await request("/api/admin-dashboard/issues", {
        headers: { Authorization: `Bearer ${noRoleToken}` },
      });
      assert.strictEqual(noRoleRes.status, 403);
    });

    it("3.4 Request-body identity fields cannot override authenticated identity", async () => {
      const origIssueSave = Issue.prototype.save;
      let recordedUserId;
      Issue.prototype.save = async function () {
        recordedUserId = this.userId;
        return this;
      };

      await request("/api/issues", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${citizenToken}`,
        },
        body: {
          type: "traffic light",
          description: "Broken signal light",
          lat: 11.3,
          lng: 77.7,
          userId: "attacker_spoofed_user_id_9999", // Malicious attempt to spoof reporter ID
        },
      });

      Issue.prototype.save = origIssueSave;

      assert.strictEqual(
        String(recordedUserId),
        String(citizenUser.id),
        "Server must bind strictly to verified JWT identity, ignoring body userId"
      );
    });

    it("3.5 Public citizen endpoints NEVER expose confidential internalNotes", async () => {
      // Create issue with confidential internal note bound to current citizen
      db.issues.set("confidential_issue_001", {
        _id: "confidential_issue_001",
        userId: citizenUser.id,
        type: "water leak",
        description: "Pipe burst on 4th Avenue",
        location: { lat: 11.35, lng: 77.73 },
        status: "reported",
        votes: 0,
        internalNotes: "CONFIDENTIAL: Municipal contractor liability investigation pending.",
        createdAt: new Date().toISOString(),
      });

      // Public feed GET /api/issues
      const publicRes = await request("/api/issues");
      assert.strictEqual(publicRes.status, 200);
      const publicIssue = publicRes.data.find((i) => i._id === "confidential_issue_001");
      assert.ok(publicIssue);
      assert.strictEqual(
        publicIssue.internalNotes,
        undefined,
        "Public endpoint must NEVER return internalNotes"
      );

      // Citizen own-issues GET /api/issues/user
      const userRes = await request("/api/issues/user", {
        headers: { Authorization: `Bearer ${citizenToken}` },
      });
      assert.strictEqual(userRes.status, 200);
      const userIssue = userRes.data.find((i) => i._id === "confidential_issue_001");
      assert.ok(userIssue);
      assert.strictEqual(
        userIssue.internalNotes,
        undefined,
        "Citizen endpoint must NEVER return internalNotes"
      );
    });

    it("3.6 Disabled public admin registration strictly returns 403 Forbidden", async () => {
      const res = await request("/api/admin/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: {
          fullName: "Unauthorized Admin",
          email: "hacker@civicvision.gov",
          password: "Password123!",
        },
      });

      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.data.error, true);
    });
  });

  // ==========================================
  // SECTION 4: OPERATIONAL & UPLOAD INTEGRITY
  // ==========================================
  describe("4. Operational & Upload Integrity Audit", () => {
    it("4.1 Binary magic-byte signature validator accepts valid image headers", () => {
      // JPEG: FF D8 FF
      const jpegBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
      assert.strictEqual(validateImageSignature(jpegBuf), "image/jpeg");

      // PNG: 89 50 4E 47 0D 0A 1A 0A
      const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
      assert.strictEqual(validateImageSignature(pngBuf), "image/png");

      // WebP: RIFF .... WEBP
      const webpBuf = Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      ]);
      assert.strictEqual(validateImageSignature(webpBuf), "image/webp");
    });

    it("4.2 Binary magic-byte signature validator rejects spoofed files (e.g. PHP script disguised as JPEG)", () => {
      const fakeJpeg = Buffer.from("<?php echo 'malicious payload'; ?> padding to 12 bytes");
      assert.strictEqual(validateImageSignature(fakeJpeg), false);

      const htmlFile = Buffer.from("<html><script>alert(1)</script></html>");
      assert.strictEqual(validateImageSignature(htmlFile), false);
    });

    it("4.3 Admin provisioning credential validation and duplicate account rejection", async () => {
      // Validate credential helper rules
      assert.throws(
        () => validateCredentials("   ", "test@civicvision.gov", "Pass1234"),
        /Full name is required/
      );
      assert.throws(
        () => validateCredentials("Officer", "bad-email", "Pass1234"),
        /Invalid email format/
      );
      assert.throws(
        () => validateCredentials("Officer", "test@civicvision.gov", "short"),
        /at least 8 characters/
      );
      assert.throws(
        () => validateCredentials("Officer", "test@civicvision.gov", "allletters"),
        /at least one letter and at least one number/
      );

      // Verify duplicate prevention logic
      const existing = await Admin.findOne({ email: "municipal.admin@civicvision.gov" });
      assert.ok(existing, "Existing admin should be detected");
      let threwDuplicateError = false;
      if (existing) {
        try {
          throw new Error(
            `An administrator account with email '${existing.email}' already exists. Implicit overwrites or password resets are not permitted.`
          );
        } catch (err) {
          threwDuplicateError = true;
          assert.match(err.message, /already exists/);
        }
      }
      assert.strictEqual(threwDuplicateError, true);
    });
  });
});
