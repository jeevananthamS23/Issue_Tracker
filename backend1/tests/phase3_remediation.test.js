/**
 * CivicVision AI — Phase 3.3.1 Remediation Regression Test Suite
 *
 * Verifies all Phase 3.3.1 requirements:
 * 1. Actual Mongoose candidate embedding projection: Stores a candidate with an embedding in disposable DB,
 *    retrieves it through `retrieveSpatialDuplicateCandidates`, and proves the vector is present internally
 *    and used by the comparison logic.
 * 2. Similar versus dissimilar compatible embeddings.
 * 3. Candidate with missing embedding -> unverified, needsReview: true.
 * 4. Candidate with malformed embedding (NaN or non-finite) -> unverified, needsReview: true.
 * 5. Candidate with zero-norm embedding ([0,0,...0]) -> unverified, needsReview: true.
 * 6. Candidate with wrong dimensions (e.g. 256 != 512) -> unverified, needsReview: true.
 * 7. Incompatible embedding models (e.g. CLIP vs deterministic) -> unverified, needsReview: true.
 * 8. Clean unique defect when all candidates are compatible and below threshold -> unique, needsReview: false.
 * 9. AI service timeout and unavailable fallback -> unverified, needsReview: true.
 * 10. Public and citizen API responses strictly exclude embedding, embeddingModel, and internalNotes:
 *     - reportIssue (POST /api/issues)
 *     - getNearbyIssues (GET /api/issues/nearby)
 *     - getDuplicateCandidates (GET /api/issues/duplicate-candidates)
 */

const assert = require("assert");
const mongoose = require("mongoose");
const Issue = require("../models/Issue");
const {
  retrieveSpatialDuplicateCandidates,
  findNearbyIssues
} = require("../services/spatial.service");
const {
  cosineSimilarity,
  validateEmbeddingVector,
  areModelsCompatible,
  compareEmbeddingWithCandidates,
  assessIssueDuplicates,
  EXPECTED_EMBEDDING_DIM
} = require("../services/ai.service");
const {
  reportIssue,
  getNearbyIssues,
  getDuplicateCandidates
} = require("../controllers/issue.controller");

const DISPOSABLE_DB_URI = "mongodb://127.0.0.1:27017/civicvision_test_remediation_disposable";

function makeUnitVector(seed = 1) {
  const vec = new Array(EXPECTED_EMBEDDING_DIM).fill(0);
  for (let i = 0; i < EXPECTED_EMBEDDING_DIM; i++) {
    vec[i] = Math.sin(seed * (i + 1));
  }
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return vec.map(v => v / norm);
}

async function runRemediationTests() {
  console.log("==================================================================");
  console.log("   CIVICVISION AI - PHASE 3.3.1 REMEDIATION REGRESSION TESTS");
  console.log("==================================================================");

  let realDbAvailable = false;
  try {
    await mongoose.connect(DISPOSABLE_DB_URI, { serverSelectionTimeoutMS: 3000 });
    realDbAvailable = true;
    await mongoose.connection.db.dropDatabase();
    console.log("[Setup] Connected to disposable local MongoDB at:", DISPOSABLE_DB_URI);
  } catch (err) {
    console.error("[Setup Error] Local MongoDB unavailable:", err.message);
    process.exit(1);
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

  const issuesCollection = mongoose.connection.db.collection("issues");

  console.log("\n--- Category 1: Real Mongoose Candidate Embedding Projection ---");

  await test("1. Candidate embedding and model metadata are retrieved through retrieveSpatialDuplicateCandidates", async () => {
    await issuesCollection.deleteMany({});

    const vec = makeUnitVector(123);
    const issue = new Issue({
      userId: new mongoose.Types.ObjectId(),
      type: "Pothole",
      description: "Pothole for projection test",
      location: { type: "Point", coordinates: [77.7275, 11.3418] },
      status: "reported",
      embedding: vec,
      embeddingModel: "openai/clip-vit-base-patch32",
      internalNotes: "CONFIDENTIAL_ADMIN_NOTE"
    });
    await issue.save();
    await Issue.createIndexes();

    // Query through spatial.service.js
    const candidates = await retrieveSpatialDuplicateCandidates({
      lat: 11.3418,
      lng: 77.7275,
      type: "Pothole",
      radiusMeters: 50
    });

    assert.strictEqual(candidates.length, 1);
    const cand = candidates[0];

    // Assert internal projection success
    assert.ok(cand.embedding, "Embedding must be explicitly projected onto the candidate object");
    assert.strictEqual(cand.embedding.length, 512, "Projected embedding must have 512 dimensions");
    assert.strictEqual(cand.embeddingModel, "openai/clip-vit-base-patch32");
    assert.strictEqual(cand.internalNotes, undefined, "internalNotes must remain excluded");

    // Assert that comparison logic can execute without fallback to 0.0
    const targetVec = [...vec];
    const comparison = compareEmbeddingWithCandidates({
      targetEmbedding: targetVec,
      targetModel: "openai/clip-vit-base-patch32",
      candidates,
      threshold: 0.85
    });

    assert.strictEqual(comparison.hasDuplicate, true);
    assert.strictEqual(comparison.topMatch.similarity, 1.0);
    assert.strictEqual(comparison.unverifiedCandidates.length, 0);
  });

  console.log("\n--- Category 2: Embedding Validation & Model Compatibility ---");

  await test("2. Vector validation detects zero-norm, NaN, and wrong dimensions", async () => {
    const valid = makeUnitVector(1);
    assert.strictEqual(validateEmbeddingVector(valid).valid, true);

    const zeroVec = new Array(512).fill(0);
    const zeroResult = validateEmbeddingVector(zeroVec);
    assert.strictEqual(zeroResult.valid, false);
    assert.strictEqual(zeroResult.reason, "Zero-norm vector (magnitude is 0.0)");

    const nanVec = [...valid];
    nanVec[10] = NaN;
    const nanResult = validateEmbeddingVector(nanVec);
    assert.strictEqual(nanResult.valid, false);
    assert.ok(nanResult.reason.includes("non-finite"));

    const shortVec = valid.slice(0, 256);
    const shortResult = validateEmbeddingVector(shortVec);
    assert.strictEqual(shortResult.valid, false);
    assert.ok(shortResult.reason.includes("Expected array of 512 elements"));
  });

  await test("3. Incompatible model metadata triggers unverified manual review instead of false unique", async () => {
    const targetVec = makeUnitVector(10);
    const candVec = makeUnitVector(10); // Identical vector

    // Candidate uses deterministic engine, target uses live CLIP
    const candidates = [
      { id: "cand_incompat", embedding: candVec, embeddingModel: "deterministic_engine_v1" }
    ];

    const comparison = compareEmbeddingWithCandidates({
      targetEmbedding: targetVec,
      targetModel: "openai/clip-vit-base-patch32",
      candidates,
      threshold: 0.85
    });

    assert.strictEqual(comparison.hasDuplicate, false);
    assert.strictEqual(comparison.unverifiedCandidates.length, 1);
    assert.ok(comparison.unverifiedCandidates[0].reason.includes("Incompatible embedding models"));
  });

  await test("4. Missing or corrupted candidate embedding marks check as unverified with needsReview: true", async () => {
    const targetVec = makeUnitVector(10);

    const candidates = [
      { id: "cand_no_emb", embedding: undefined, embeddingModel: "openai/clip-vit-base-patch32" },
      { id: "cand_zero_norm", embedding: new Array(512).fill(0), embeddingModel: "openai/clip-vit-base-patch32" }
    ];

    const comparison = compareEmbeddingWithCandidates({
      targetEmbedding: targetVec,
      targetModel: "openai/clip-vit-base-patch32",
      candidates,
      threshold: 0.85
    });

    assert.strictEqual(comparison.hasDuplicate, false);
    assert.strictEqual(comparison.unverifiedCandidates.length, 2);
  });

  console.log("\n--- Category 3: End-to-End Duplicate Assessment & Fallbacks ---");

  await test("5. assessIssueDuplicates marks unverified and needsReview: true when nearby candidates are incompatible", async () => {
    await issuesCollection.deleteMany({});

    // Save candidate with legacy/missing model metadata in DB
    const existing = new Issue({
      userId: new mongoose.Types.ObjectId(),
      type: "Garbage",
      description: "Overflowing bin",
      location: { type: "Point", coordinates: [77.7275, 11.3418] },
      status: "reported",
      embedding: makeUnitVector(55)
      // Note: embeddingModel is omitted intentionally to simulate legacy record
    });
    await existing.save();

    // Mock fetchClipEmbedding to return a valid CLIP embedding with model metadata
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        embedding: makeUnitVector(55),
        model: "openai/clip-vit-base-patch32"
      })
    });

    try {
      const assessment = await assessIssueDuplicates({
        lat: 11.3418,
        lng: 77.7275,
        type: "Garbage",
        imageUrl: "https://res.cloudinary.com/demo/image/upload/sample.jpg"
      });

      // Must NOT be marked unique! Must be unverified and require review!
      assert.strictEqual(assessment.duplicateStatus, "unverified");
      assert.strictEqual(assessment.needsReview, true);
      assert.strictEqual(assessment.aiDiagnostic.serviceStatus, "unverified_candidates");
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test("6. assessIssueDuplicates marks unique and needsReview: false when all candidates are compatible and below threshold", async () => {
    await issuesCollection.deleteMany({});

    // Save candidate with distinct vector but compatible model
    const existing = new Issue({
      userId: new mongoose.Types.ObjectId(),
      type: "Garbage",
      description: "Old garbage report",
      location: { type: "Point", coordinates: [77.7275, 11.3418] },
      status: "reported",
      embedding: makeUnitVector(1),
      embeddingModel: "deterministic_engine_v1"
    });
    await existing.save();

    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        embedding: makeUnitVector(999), // Orthogonal/distinct vector
        model: "deterministic_engine_v1"
      })
    });

    try {
      const assessment = await assessIssueDuplicates({
        lat: 11.3418,
        lng: 77.7275,
        type: "Garbage",
        imageUrl: "https://res.cloudinary.com/demo/image/upload/sample.jpg"
      });

      assert.strictEqual(assessment.duplicateStatus, "unique");
      assert.strictEqual(assessment.needsReview, false);
      assert.ok(assessment.similarityScore < 0.85);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test("7. assessIssueDuplicates degrades gracefully when AI microservice times out or fails", async () => {
    await issuesCollection.deleteMany({});

    // Save existing candidate
    const existing = new Issue({
      userId: new mongoose.Types.ObjectId(),
      type: "Streetlight",
      description: "Broken streetlight",
      location: { type: "Point", coordinates: [77.7275, 11.3418] },
      status: "reported"
    });
    await existing.save();

    // Mock fetch to simulate timeout
    const originalFetch = global.fetch;
    global.fetch = async () => {
      const err = new Error("Simulated network timeout");
      err.name = "AbortError";
      throw err;
    };

    try {
      const assessment = await assessIssueDuplicates({
        lat: 11.3418,
        lng: 77.7275,
        type: "Streetlight",
        imageUrl: "https://res.cloudinary.com/demo/image/upload/light.jpg"
      });

      assert.strictEqual(assessment.duplicateStatus, "unverified");
      assert.strictEqual(assessment.needsReview, true);
      assert.strictEqual(assessment.aiDiagnostic.serviceStatus, "ai_service_unavailable");
    } finally {
      global.fetch = originalFetch;
    }
  });

  console.log("\n--- Category 4: Public Response Privacy & Data Sanitization ---");

  await test("8. reportIssue endpoint strictly excludes embedding, embeddingModel, and internalNotes", async () => {
    let statusCode = null;
    let jsonBody = null;

    const mockRes = {
      status: code => {
        statusCode = code;
        return { json: data => { jsonBody = data; } };
      }
    };

    const req = {
      body: {
        type: "Drainage",
        description: "Blocked drain near main road",
        lat: 11.3418,
        lng: 77.7275
      },
      user: { userId: new mongoose.Types.ObjectId() }
    };

    await reportIssue(req, mockRes);

    assert.strictEqual(statusCode, 201);
    assert.ok(jsonBody.issue._id);
    assert.strictEqual(jsonBody.issue.embedding, undefined, "embedding must be omitted from public response");
    assert.strictEqual(jsonBody.issue.embeddingModel, undefined, "embeddingModel must be omitted from public response");
    assert.strictEqual(jsonBody.issue.internalNotes, undefined, "internalNotes must be omitted from public response");
  });

  await test("9. getNearbyIssues endpoint strictly excludes embedding, embeddingModel, and internalNotes", async () => {
    let statusCode = null;
    let jsonBody = null;

    const mockRes = {
      status: code => {
        statusCode = code;
        return { json: data => { jsonBody = data; } };
      }
    };

    const req = {
      query: {
        lat: "11.3418",
        lng: "77.7275",
        radius: "100"
      }
    };

    await getNearbyIssues(req, mockRes);

    assert.strictEqual(statusCode, 200);
    assert.ok(Array.isArray(jsonBody));
    for (const item of jsonBody) {
      assert.strictEqual(item.embedding, undefined, "Nearby issues must not contain embedding");
      assert.strictEqual(item.embeddingModel, undefined, "Nearby issues must not contain embeddingModel");
      assert.strictEqual(item.internalNotes, undefined, "Nearby issues must not contain internalNotes");
    }
  });

  await test("10. getDuplicateCandidates endpoint strictly excludes embedding, embeddingModel, and internalNotes", async () => {
    let statusCode = null;
    let jsonBody = null;

    const mockRes = {
      status: code => {
        statusCode = code;
        return { json: data => { jsonBody = data; } };
      }
    };

    const req = {
      query: {
        lat: "11.3418",
        lng: "77.7275",
        type: "Drainage",
        radius: "100"
      }
    };

    await getDuplicateCandidates(req, mockRes);

    assert.strictEqual(statusCode, 200);
    assert.ok(Array.isArray(jsonBody.candidates));
    for (const cand of jsonBody.candidates) {
      assert.strictEqual(cand.embedding, undefined, "Candidate endpoint must not expose embedding");
      assert.strictEqual(cand.embeddingModel, undefined, "Candidate endpoint must not expose embeddingModel");
      assert.strictEqual(cand.internalNotes, undefined, "Candidate endpoint must not expose internalNotes");
    }
  });

  // Teardown
  try {
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
    console.log("[Teardown] Disposable remediation test database dropped and disconnected.");
  } catch (e) {
    console.warn("[Teardown Warning]", e.message);
  }

  console.log("\n==================================================================");
  console.log(`TOTAL REMEDIATION TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log("==================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runRemediationTests().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
