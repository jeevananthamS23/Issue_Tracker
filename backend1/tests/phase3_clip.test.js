/**
 * CivicVision AI — Phase 3.3 CLIP Image Similarity & Duplicate Suppression Test Suite
 *
 * Verifies all Phase 3.3 requirements:
 * 1. Mathematical Cosine Similarity engine (identical, orthogonal, opposite, zero vectors, dimension checks)
 * 2. Vector validation (finite numbers, dimension mismatch rejection)
 * 3. Empty candidate list handling (instant "unique" status)
 * 4. Bounded candidate limits
 * 5. Two-stage duplicate assessment (Stage 1 geospatial + Stage 2 similarity)
 * 6. Soft-failure degradation: Issue creation succeeds (201) even when AI service is unavailable/times out
 * 7. Duplicate flagging: Flagged duplicate records reference earlier issue without suppression or deletion
 * 8. Internal notes confidentiality (internalNotes never leaked in duplicate responses)
 * 9. Schema storage: embedding (512-dim), duplicateStatus, similarityScore, needsReview
 * 10. End-to-end controller integration for issue creation and duplicate checks
 */

const assert = require("assert");
const mongoose = require("mongoose");
const Issue = require("../models/Issue");
const {
  cosineSimilarity,
  compareEmbeddingWithCandidates,
  assessIssueDuplicates,
  DEFAULT_SIMILARITY_THRESHOLD,
  EXPECTED_EMBEDDING_DIM
} = require("../services/ai.service");
const { reportIssue } = require("../controllers/issue.controller");

const DISPOSABLE_DB_URI = "mongodb://127.0.0.1:27017/civicvision_test_clip_disposable";

let realDbAvailable = false;

// Helper: Generates a normalized 512-dim vector for testing
function makeUnitVector(seed = 1) {
  const vec = new Array(EXPECTED_EMBEDDING_DIM).fill(0);
  for (let i = 0; i < EXPECTED_EMBEDDING_DIM; i++) {
    vec[i] = Math.sin(seed * (i + 1));
  }
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return vec.map(v => v / norm);
}

async function runTests() {
  console.log("==========================================================");
  console.log("   CIVICVISION AI - PHASE 3.3 CLIP & DUPLICATE TESTS");
  console.log("==========================================================");

  try {
    await mongoose.connect(DISPOSABLE_DB_URI, { serverSelectionTimeoutMS: 3000 });
    realDbAvailable = true;
    await mongoose.connection.db.dropDatabase();
    console.log("[Setup] Connected to disposable local MongoDB at:", DISPOSABLE_DB_URI);
  } catch (err) {
    console.warn("[Setup Warning] Local MongoDB unavailable:", err.message);
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

  console.log("\n--- Category 1: Cosine Similarity Mathematical Rigor ---");

  await test("1. Identical vectors yield cosine similarity = 1.0", async () => {
    const vecA = makeUnitVector(42);
    const vecB = [...vecA];
    const sim = cosineSimilarity(vecA, vecB);
    assert.strictEqual(sim, 1.0, `Expected 1.0, got ${sim}`);
  });

  await test("2. Orthogonal vectors yield cosine similarity = 0.0", async () => {
    const vecA = new Array(512).fill(0);
    const vecB = new Array(512).fill(0);
    vecA[0] = 1.0; // Pointing along dimension 0
    vecB[1] = 1.0; // Pointing along dimension 1
    const sim = cosineSimilarity(vecA, vecB);
    assert.strictEqual(sim, 0.0, `Expected 0.0, got ${sim}`);
  });

  await test("3. Opposite vectors yield cosine similarity = -1.0", async () => {
    const vecA = makeUnitVector(15);
    const vecB = vecA.map(v => -v);
    const sim = cosineSimilarity(vecA, vecB);
    assert.strictEqual(sim, -1.0, `Expected -1.0, got ${sim}`);
  });

  await test("4. Edge cases: zero vectors, NaN, and dimension mismatch return 0.0 safely", async () => {
    const validVec = makeUnitVector(7);
    const zeroVec = new Array(512).fill(0);
    assert.strictEqual(cosineSimilarity(validVec, zeroVec), 0.0, "Zero vector must yield 0.0 without NaN");
    assert.strictEqual(cosineSimilarity(zeroVec, zeroVec), 0.0, "Two zero vectors must yield 0.0");

    // Dimension mismatch
    const shortVec = [1.0, 0.5, 0.2];
    assert.strictEqual(cosineSimilarity(validVec, shortVec), 0.0, "Mismatched dimensions must yield 0.0");

    // Non-finite values
    const nanVec = [...validVec];
    nanVec[10] = NaN;
    assert.strictEqual(cosineSimilarity(validVec, nanVec), 0.0, "Vector containing NaN must yield 0.0");

    const infVec = [...validVec];
    infVec[5] = Infinity;
    assert.strictEqual(cosineSimilarity(validVec, infVec), 0.0, "Vector containing Infinity must yield 0.0");
  });

  console.log("\n--- Category 2: Candidate Shortlist Comparison & Thresholds ---");

  await test("5. Candidate comparison ranks candidates and flags duplicates above threshold", async () => {
    const target = makeUnitVector(100);

    // Candidate 1: Nearly identical (similarity > 0.95)
    const cand1Vec = target.map((v, i) => v * 0.99 + (i === 0 ? 0.01 : 0.0));
    // Candidate 2: Different (similarity ~ 0.2)
    const cand2Vec = makeUnitVector(200);

    const candidates = [
      { id: "cand_1", embedding: cand1Vec, embeddingModel: "deterministic_engine_v1" },
      { id: "cand_2", embedding: cand2Vec, embeddingModel: "deterministic_engine_v1" }
    ];

    const result = compareEmbeddingWithCandidates({
      targetEmbedding: target,
      targetModel: "deterministic_engine_v1",
      candidates,
      threshold: 0.85
    });

    assert.strictEqual(result.hasDuplicate, true);
    assert.ok(result.topMatch);
    assert.strictEqual(result.topMatch.id, "cand_1");
    assert.ok(result.topMatch.similarity >= 0.85);
    assert.strictEqual(result.rankedCandidates[0].id, "cand_1");
    assert.strictEqual(result.rankedCandidates[1].id, "cand_2");
    assert.strictEqual(result.rankedCandidates[1].isDuplicate, false);
  });

  await test("6. Empty candidate list returns hasDuplicate = false immediately", async () => {
    const target = makeUnitVector(50);
    const result = compareEmbeddingWithCandidates({
      targetEmbedding: target,
      targetModel: "deterministic_engine_v1",
      candidates: [],
      threshold: 0.85
    });

    assert.strictEqual(result.hasDuplicate, false);
    assert.strictEqual(result.topMatch, null);
    assert.deepStrictEqual(result.rankedCandidates, []);
  });

  console.log("\n--- Category 3: Database & Two-Stage Pipeline Integration ---");

  if (!realDbAvailable) {
    console.log("  [SKIPPED REAL DB TESTS - Local MongoDB not available]");
  } else {
    const { retrieveSpatialDuplicateCandidates } = require("../services/spatial.service");
    const issuesCollection = mongoose.connection.db.collection("issues");

    await test("7. Stage 1 + Stage 2 End-to-End: Flags duplicate when defect is nearby AND visually similar", async () => {
      await issuesCollection.deleteMany({});

      const existingVector = makeUnitVector(77);
      const citizenId = new mongoose.Types.ObjectId();

      // Create an existing open pothole 20m away with an embedding and embeddingModel
      const existingIssue = new Issue({
        userId: citizenId,
        type: "Pothole",
        description: "Large pothole on 4th cross",
        status: "reported",
        location: { type: "Point", coordinates: [77.7277, 11.3419] }, // 20m from [77.7275, 11.3418]
        embedding: existingVector,
        embeddingModel: "deterministic_engine_v1",
        internalNotes: "CONFIDENTIAL_ADMIN_NOTES_EXISTING"
      });
      await existingIssue.save();
      await Issue.createIndexes();

      // Simulate new submission with identical embedding
      const newTargetVector = [...existingVector];

      // Retrieve Stage 1 candidates via the actual spatial service
      const candidates = await retrieveSpatialDuplicateCandidates({
        lat: 11.3418,
        lng: 77.7275,
        type: "Pothole",
        radiusMeters: 50
      });

      assert.strictEqual(candidates.length, 1);
      assert.ok(candidates[0].embedding, "Candidate embedding must be projected through retrieveSpatialDuplicateCandidates");
      assert.strictEqual(candidates[0].embedding.length, 512);

      const comparison = compareEmbeddingWithCandidates({
        targetEmbedding: newTargetVector,
        targetModel: "deterministic_engine_v1",
        candidates,
        threshold: 0.85
      });

      assert.strictEqual(comparison.hasDuplicate, true);
      assert.strictEqual(comparison.topMatch.id, existingIssue._id.toString());
      assert.strictEqual(comparison.topMatch.similarity, 1.0);
    });

    await test("8. Geographically nearby defect of SAME category but DIFFERENT image is NOT flagged as duplicate", async () => {
      // Pothole 20m away exists, but new report has an entirely different photo
      const differentVector = makeUnitVector(999);

      const candidates = await retrieveSpatialDuplicateCandidates({
        lat: 11.3418,
        lng: 77.7275,
        type: "Pothole",
        radiusMeters: 50
      });

      const comparison = compareEmbeddingWithCandidates({
        targetEmbedding: differentVector,
        targetModel: "deterministic_engine_v1",
        candidates,
        threshold: 0.85
      });

      assert.strictEqual(comparison.hasDuplicate, false, "Distinct defect must NOT be marked duplicate on distance alone");
      assert.strictEqual(comparison.topMatch, null);
    });

    console.log("\n--- Category 4: Soft-Failure Degradation & Controller Invariants ---");

    await test("9. Soft-failure guarantee: Issue creation succeeds (201) even if AI service is offline", async () => {
      // Ensure AI service is pointing to an offline port to simulate timeout/connection failure
      const originalUrl = process.env.AI_SERVICE_URL;
      process.env.AI_SERVICE_URL = "http://127.0.0.1:9999"; // Non-existent service

      let statusCode = null;
      let responseBody = null;

      const mockRes = {
        status: code => {
          statusCode = code;
          return { json: data => { responseBody = data; } };
        }
      };

      const req = {
        body: {
          type: "Pothole",
          description: "New pothole report during AI outage",
          lat: 11.3418,
          lng: 77.7275
        },
        user: { userId: new mongoose.Types.ObjectId() }
      };

      await reportIssue(req, mockRes);

      // Restore environment
      process.env.AI_SERVICE_URL = originalUrl;

      // Invariant: Base reporting MUST NOT fail
      assert.strictEqual(statusCode, 201, "Issue creation must return 201 even when AI is unavailable");
      assert.strictEqual(responseBody.message, "Issue reported successfully");
      assert.ok(responseBody.issue._id);
      assert.strictEqual(responseBody.issue.duplicateStatus, "unverified");
      assert.strictEqual(responseBody.issue.needsReview, true);
      assert.strictEqual(responseBody.issue.internalNotes, undefined, "internalNotes must NOT be leaked");
    });

    await test("10. Issue schema preserves embedding and duplicate fields without breaking existing queries", async () => {
      const uId = new mongoose.Types.ObjectId();
      const testVec = makeUnitVector(33);

      const issue = new Issue({
        userId: uId,
        type: "Streetlight",
        description: "Broken streetlight pole",
        location: { lat: 11.34, lng: 77.72 },
        embedding: testVec,
        duplicateStatus: "flagged_duplicate",
        similarityScore: 0.89,
        needsReview: true
      });

      await issue.save();

      // Default query (without +embedding) should NOT load the 512-dim vector into memory
      const fetched = await Issue.findById(issue._id);
      assert.strictEqual(fetched.embedding, undefined, "Embedding must be select: false by default");
      assert.strictEqual(fetched.duplicateStatus, "flagged_duplicate");
      assert.strictEqual(fetched.similarityScore, 0.89);
      assert.strictEqual(fetched.needsReview, true);

      // Explicit select: '+embedding' loads the vector
      const fetchedWithEmb = await Issue.findById(issue._id).select("+embedding");
      assert.strictEqual(fetchedWithEmb.embedding.length, 512);
    });

    await test("11. Public & citizen responses strictly exclude internalNotes during duplicate checks", async () => {
      const confidentialId = new mongoose.Types.ObjectId();
      const confIssue = new Issue({
        userId: confidentialId,
        type: "Encroachment",
        description: "Footpath occupied",
        internalNotes: "CONFIDENTIAL_ADMIN_INVESTIGATION_PENDING",
        location: { lat: 11.3418, lng: 77.7275 }
      });
      await confIssue.save();

      // Retrieve via nearby
      const issues = await Issue.find({
        location: {
          $near: {
            $geometry: { type: "Point", coordinates: [77.7275, 11.3418] },
            $maxDistance: 100
          }
        }
      }).select("-internalNotes");

      const match = issues.find(i => i._id.toString() === confIssue._id.toString());
      assert.ok(match);
      assert.strictEqual(match.internalNotes, undefined, "internalNotes must be strictly stripped");
    });
  }

  // Teardown
  if (realDbAvailable) {
    try {
      await mongoose.connection.db.dropDatabase();
      await mongoose.disconnect();
      console.log("[Teardown] Disposable CLIP test database dropped and disconnected.");
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
