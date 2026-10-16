/**
 * CivicVision AI — Staging Integration Test Suite
 *
 * Verifies live FastAPI Render deployment integration with Node.js ai.service client.
 * Non-production, harmless test fixture, zero database mutations.
 *
 * Safeguards:
 * 1. Strictly prohibits production MongoDB Atlas connections and mutations.
 * 2. Mocks/isolates spatial database operations during fallback testing.
 * 3. Restores all temporarily modified environment variables and globals in finally blocks.
 * 4. Never prints, logs, or guesses API keys or secret values.
 * 5. Verifies deployed health reports "deterministic_engine_v1".
 * 6. Skips live authenticated embedding if AI_SERVICE_API_KEY is unset locally.
 * 7. Reports controlled timeout test mechanics and limitations honestly.
 */

const assert = require("assert");

// Strict database guard: Defensively neutralize any Atlas connection URI
if (process.env.MONGO_URI && (process.env.MONGO_URI.includes("mongodb+srv") || process.env.MONGO_URI.includes("mongodb.net"))) {
  delete process.env.MONGO_URI;
}

// Ensure AI_SERVICE_URL is set before requiring ai.service (module captures it at load time)
const TARGET_DEPLOYED_URL = process.env.AI_SERVICE_URL || "https://civicvision-ai-service.onrender.com";
if (!process.env.AI_SERVICE_URL) {
  process.env.AI_SERVICE_URL = TARGET_DEPLOYED_URL;
}

const {
  fetchClipEmbedding,
  validateEmbeddingVector,
  assessIssueDuplicates,
  EXPECTED_EMBEDDING_DIM
} = require("../services/ai.service");
const Issue = require("../models/Issue");

// Harmless, public test image on approved Cloudinary domain (matches ALLOWED_IMAGE_HOSTS)
const TEST_IMAGE_URL = "https://res.cloudinary.com/demo/image/upload/sample.jpg";

async function runStagingVerification() {
  console.log("==================================================================");
  console.log("   CIVICVISION AI - STAGING INTEGRATION VERIFICATION SUITE");
  console.log("==================================================================");
  console.log(`[Target Service URL] ${process.env.AI_SERVICE_URL}`);

  let passedChecks = 0;
  let totalChecks = 5;

  // --------------------------------------------------------------------------
  // Check 1: Deployed Health & Deterministic Engine Pre-Flight
  // --------------------------------------------------------------------------
  console.log("\n[Check 1/5] Verifying deployed health endpoint and truthful model metadata...");
  try {
    const healthUrl = `${process.env.AI_SERVICE_URL}/health`;
    const healthResp = await fetch(healthUrl);
    assert.strictEqual(healthResp.status, 200, `Expected HTTP 200 from /health, got ${healthResp.status}`);

    const healthData = await healthResp.json();
    assert.strictEqual(healthData.status, "ok");
    assert.strictEqual(healthData.live, true);
    assert.strictEqual(healthData.ready, true);
    assert.strictEqual(healthData.model, "deterministic_engine_v1", `Model must be deterministic_engine_v1, got: ${healthData.model}`);
    assert.strictEqual(healthData.use_online_model, false, "use_online_model must be false on Render Free");
    assert.strictEqual(healthData.mode, "deterministic_engine");

    console.log(`  ✓ HTTP 200 OK | Mode: ${healthData.mode} | Model: ${healthData.model} | Live: ${healthData.live} | Ready: ${healthData.ready}`);
    passedChecks++;
  } catch (err) {
    console.error(`  ✗ Check 1 Failed: ${err.message}`);
    throw err;
  }

  // --------------------------------------------------------------------------
  // Check 2: Deployed Readiness Probe
  // --------------------------------------------------------------------------
  console.log("\n[Check 2/5] Verifying deployed readiness probe (/ready)...");
  try {
    const readyUrl = `${process.env.AI_SERVICE_URL}/ready`;
    const readyResp = await fetch(readyUrl);
    assert.strictEqual(readyResp.status, 200, `Expected HTTP 200 from /ready, got ${readyResp.status}`);

    const readyData = await readyResp.json();
    assert.strictEqual(readyData.status, "ready");
    assert.strictEqual(readyData.ready, true);
    assert.strictEqual(readyData.model, "deterministic_engine_v1");

    console.log(`  ✓ HTTP 200 OK | Ready: ${readyData.ready} | Engine: ${readyData.model}`);
    passedChecks++;
  } catch (err) {
    console.error(`  ✗ Check 2 Failed: ${err.message}`);
    throw err;
  }

  // --------------------------------------------------------------------------
  // Check 3: Controlled Client Timeout Handling
  // --------------------------------------------------------------------------
  console.log("\n[Check 3/5] Testing client timeout cancellation (controlled 1ms timeout)...");
  console.log("  * Note: 1ms timeout verifies AbortController signal handling cleanly catches cancellation.");
  try {
    const timeoutResult = await fetchClipEmbedding(TEST_IMAGE_URL, 1);
    assert.strictEqual(timeoutResult.success, false, "Request should not succeed with 1ms timeout");
    assert.ok(
      timeoutResult.error && (timeoutResult.error.includes("timed out") || timeoutResult.error.includes("abort")),
      `Expected timeout/abort error message, got: ${timeoutResult.error}`
    );
    console.log(`  ✓ AbortController cleanly caught timeout without crashing (${timeoutResult.error})`);
    passedChecks++;
  } catch (err) {
    console.error(`  ✗ Check 3 Failed: ${err.message}`);
    throw err;
  }

  // --------------------------------------------------------------------------
  // Check 4: AI-Unavailable Soft-Failure Fallback (Isolated / Mocked DB)
  // --------------------------------------------------------------------------
  console.log("\n[Check 4/5] Testing AI-unavailable soft-failure fallback (isolated DB & simulated failure)...");
  const originalFetch = global.fetch;
  const originalFind = Issue.find;

  try {
    // Isolate Mongoose Issue.find so spatial candidate retrieval operates in memory without DB
    Issue.find = () => ({
      select: () => ({
        limit: async () => [
          {
            toJSON: () => ({
              _id: "staging_candidate_fixture_001",
              location: { type: "Point", coordinates: [80.2707, 13.0827] }
            }),
            embedding: new Array(EXPECTED_EMBEDDING_DIM).fill(0.044194),
            embeddingModel: "deterministic_engine_v1"
          }
        ]
      })
    });

    // Mock global.fetch to simulate AI microservice network outage
    global.fetch = async () => {
      throw new Error("Simulated network outage (FastAPI microservice unreachable)");
    };

    const fallbackResult = await assessIssueDuplicates({
      lat: 13.0827,
      lng: 80.2707,
      type: "Pothole",
      imageUrl: TEST_IMAGE_URL
    });

    assert.strictEqual(fallbackResult.duplicateStatus, "unverified", "Must be unverified when AI service is down");
    assert.strictEqual(fallbackResult.needsReview, true, "Must flag needsReview: true for manual moderation");
    assert.strictEqual(fallbackResult.similarityScore, 0.0);
    assert.strictEqual(fallbackResult.aiDiagnostic.serviceStatus, "ai_service_unavailable");

    console.log("  ✓ Soft-failure verified: status='unverified', needsReview=true, aiDiagnostic recorded.");
    passedChecks++;
  } catch (err) {
    console.error(`  ✗ Check 4 Failed: ${err.message}`);
    throw err;
  } finally {
    // Defensively restore all mocked globals and methods
    global.fetch = originalFetch;
    Issue.find = originalFind;
  }

  // --------------------------------------------------------------------------
  // Check 5: Live Authenticated Embedding (Conditional on Configured Secret)
  // --------------------------------------------------------------------------
  console.log("\n[Check 5/5] Live authenticated embedding retrieval check...");
  const hasKey = Boolean(process.env.AI_SERVICE_API_KEY && process.env.AI_SERVICE_API_KEY.trim());

  if (!hasKey) {
    console.log("  ⚠ SKIPPED (AI_SERVICE_API_KEY is not configured in local environment).");
    console.log("    To run this check, configure AI_SERVICE_API_KEY in backend1/.env with the shared secret.");
    console.log("    Never guess, hardcode, or log secret keys.");
  } else {
    try {
      console.log("  * Executing authenticated embedding retrieval with configured API key...");
      const embedResult = await fetchClipEmbedding(TEST_IMAGE_URL, 8000);
      assert.strictEqual(embedResult.success, true, `Embedding failed: ${embedResult.error}`);
      assert.strictEqual(embedResult.model, "deterministic_engine_v1");

      const validation = validateEmbeddingVector(embedResult.embedding);
      assert.strictEqual(validation.valid, true, `Validation failed: ${validation.reason}`);
      assert.strictEqual(embedResult.embedding.length, EXPECTED_EMBEDDING_DIM);

      let sumSq = 0;
      for (const val of embedResult.embedding) {
        assert.ok(Number.isFinite(val), "Vector component must be finite");
        sumSq += val * val;
      }
      const norm = Math.sqrt(sumSq);
      assert.ok(Math.abs(norm - 1.0) < 0.01, `Expected unit norm ~1.0, got ${norm}`);

      console.log(`  ✓ Received valid 512-D embedding from deployed service (Model: ${embedResult.model}, Norm: ${norm.toFixed(6)})`);
      passedChecks++;
    } catch (err) {
      console.error(`  ✗ Check 5 Failed: ${err.message}`);
      throw err;
    }
  }

  console.log("\n==================================================================");
  console.log(`STAGING TEST SUMMARY: ${passedChecks}/${hasKey ? totalChecks : totalChecks - 1} CHECKS PASSED`);
  if (!hasKey) {
    console.log("(Check 5 was safely skipped pending local key configuration)");
  }
  console.log("==================================================================");
}

runStagingVerification().catch(err => {
  console.error("\nFATAL STAGING VERIFICATION ERROR:", err.message);
  process.exit(1);
});
