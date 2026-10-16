/**
 * CivicVision AI — AI & Image Similarity Service (Phase 3.3)
 *
 * Implements Stage 2 of the Two-Stage Duplicate Suppression Pipeline:
 * 1. Mathematical Cosine Similarity engine with dimension and finite checks.
 * 2. HTTP Client for FastAPI CLIP inference microservice with timeout protection.
 * 3. Two-stage duplicate evaluation orchestrator (Stage 1 geospatial + Stage 2 CLIP).
 * 4. Soft-failure degradation: Issue submission always proceeds even if AI inference fails.
 */

const { retrieveSpatialDuplicateCandidates } = require("./spatial.service");

const DEFAULT_AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://127.0.0.1:8000";
const DEFAULT_SIMILARITY_THRESHOLD = parseFloat(process.env.CLIP_SIMILARITY_THRESHOLD) || 0.85;
const DEFAULT_TIMEOUT_MS = parseInt(process.env.AI_SERVICE_TIMEOUT_MS, 10) || 3500;
const EXPECTED_EMBEDDING_DIM = 512;

/**
 * Calculates cosine similarity between two float vectors.
 * Handles zero vectors, mismatched dimensions, and non-finite values safely.
 *
 * @param {Array<number>} vecA - First vector
 * @param {Array<number>} vecB - Second vector
 * @returns {number} Cosine similarity in range [-1.0, 1.0], or 0.0 for invalid input
 */
function cosineSimilarity(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length === 0 || vecB.length === 0) {
    return 0.0;
  }
  if (vecA.length !== vecB.length) {
    return 0.0;
  }

  let dotProduct = 0.0;
  let normA = 0.0;
  let normB = 0.0;

  for (let i = 0; i < vecA.length; i++) {
    const a = Number(vecA[i]);
    const b = Number(vecB[i]);

    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return 0.0;
    }

    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }

  if (normA === 0.0 || normB === 0.0) {
    return 0.0;
  }

  const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  // Bound to [-1.0, 1.0] and round to 4 decimal places
  return Math.round(Math.max(-1.0, Math.min(1.0, similarity)) * 10000) / 10000;
}

/**
 * Validates a float vector for dimensions, numeric finiteness, and non-zero norm.
 *
 * @param {Array<number>} vec - Vector to validate
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateEmbeddingVector(vec) {
  if (!Array.isArray(vec) || vec.length !== EXPECTED_EMBEDDING_DIM) {
    return {
      valid: false,
      reason: `Expected array of ${EXPECTED_EMBEDDING_DIM} elements, got ${Array.isArray(vec) ? vec.length : typeof vec}`
    };
  }

  let normSq = 0.0;
  for (let i = 0; i < vec.length; i++) {
    const val = Number(vec[i]);
    if (!Number.isFinite(val)) {
      return { valid: false, reason: `Element at index ${i} is non-finite (${vec[i]})` };
    }
    normSq += val * val;
  }

  if (normSq === 0.0) {
    return { valid: false, reason: "Zero-norm vector (magnitude is 0.0)" };
  }

  return { valid: true };
}

/**
 * Validates whether two embedding vectors were produced by compatible model engines/versions.
 * Missing metadata is treated as incompatible to prevent false similarity assertions.
 *
 * @param {string} modelA - Model identifier for vector A
 * @param {string} modelB - Model identifier for vector B
 * @returns {boolean} True if models are identical and compatible
 */
function areModelsCompatible(modelA, modelB) {
  if (!modelA || !modelB || typeof modelA !== "string" || typeof modelB !== "string") {
    return false;
  }
  return modelA.trim().toLowerCase() === modelB.trim().toLowerCase();
}

/**
 * Fetches a 512-dim CLIP embedding from the FastAPI service for a given image URL.
 * Enforces strict timeout with AbortSignal.
 *
 * @param {string} imageUrl - Public image URL
 * @param {number} timeoutMs - Timeout in milliseconds (default 3500ms)
 * @returns {Promise<{ success: boolean, embedding?: Array<number>, model?: string, error?: string }>}
 */
async function fetchClipEmbedding(imageUrl, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!imageUrl || typeof imageUrl !== "string") {
    return { success: false, error: "Image URL must be a non-empty string" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = { "Content-Type": "application/json" };
    if (process.env.AI_SERVICE_API_KEY) {
      headers["X-API-Key"] = process.env.AI_SERVICE_API_KEY.trim();
    }

    const response = await fetch(`${DEFAULT_AI_SERVICE_URL}/embed-image`, {
      method: "POST",
      headers,
      body: JSON.stringify({ image_url: imageUrl }),
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, error: `AI service returned HTTP ${response.status}: ${errText}` };
    }

    const data = await response.json();
    const validation = validateEmbeddingVector(data.embedding);
    if (!validation.valid) {
      return {
        success: false,
        error: `Invalid embedding received from AI service: ${validation.reason}`
      };
    }

    return {
      success: true,
      embedding: data.embedding,
      model: data.model || "unknown"
    };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      return { success: false, error: `AI service embedding request timed out after ${timeoutMs}ms` };
    }
    return { success: false, error: `Failed to connect to AI service: ${err.message}` };
  }
}

/**
 * Compares a target embedding against a candidate shortlist using cosine similarity.
 * Validates candidate vectors and checks model compatibility.
 * Any uncomparable candidate (missing vector, malformed, zero-norm, incompatible model)
 * is tracked in `unverifiedCandidates` so caller can require manual review.
 *
 * @param {object} options
 *   - targetEmbedding: Array<number> (required)
 *   - targetModel: string (optional/required for model compatibility)
 *   - candidates: Array<{ _id, imageUrl, embedding, embeddingModel }>
 *   - threshold: number (optional, default 0.85)
 * @returns {object} Comparison results with ranked candidates, unverified candidates, and duplicate flag
 */
function compareEmbeddingWithCandidates(options = {}) {
  const {
    targetEmbedding,
    targetModel,
    candidates = [],
    threshold = DEFAULT_SIMILARITY_THRESHOLD
  } = options;

  const targetValidation = validateEmbeddingVector(targetEmbedding);
  if (!targetValidation.valid) {
    return {
      hasDuplicate: false,
      topMatch: null,
      rankedCandidates: [],
      unverifiedCandidates: candidates.map(c => ({
        id: c._id ? c._id.toString() : c.id,
        reason: `Target embedding invalid: ${targetValidation.reason}`
      })),
      error: `Invalid target embedding: ${targetValidation.reason}`
    };
  }

  const ranked = [];
  const unverifiedCandidates = [];

  for (const cand of candidates) {
    const candId = cand._id ? cand._id.toString() : cand.id;

    // Validate candidate embedding
    const candValidation = validateEmbeddingVector(cand.embedding);
    if (!candValidation.valid) {
      unverifiedCandidates.push({
        id: candId,
        reason: `Candidate embedding invalid: ${candValidation.reason}`
      });
      continue;
    }

    // Check model compatibility
    if (!areModelsCompatible(targetModel, cand.embeddingModel)) {
      unverifiedCandidates.push({
        id: candId,
        reason: `Incompatible embedding models: target='${targetModel || "unknown"}' vs candidate='${cand.embeddingModel || "missing"}'`
      });
      continue;
    }

    const sim = cosineSimilarity(targetEmbedding, cand.embedding);
    const isDup = sim >= threshold;

    ranked.push({
      id: candId,
      similarity: sim,
      isDuplicate: isDup
    });
  }

  ranked.sort((a, b) => b.similarity - a.similarity);

  const topMatch = ranked.length > 0 && ranked[0].isDuplicate ? ranked[0] : null;
  const hasDuplicate = ranked.some(c => c.isDuplicate);

  return {
    threshold,
    hasDuplicate,
    topMatch,
    rankedCandidates: ranked,
    unverifiedCandidates
  };
}

/**
 * End-to-end Two-Stage Duplicate Suppression Pipeline:
 * Stage 1: Shortlists spatial candidates within 50m using MongoDB 2dsphere index.
 * Stage 2: Generates CLIP embedding and computes cosine similarity against compatible candidates.
 *
 * Soft-failure guarantee: If AI inference fails, times out, or candidates cannot be verified,
 * returns unverified status with needsReview: true so the issue is created normally
 * and flagged for manual admin review. Unsuccessful checks are NEVER disguised as unique.
 *
 * @param {object} options
 *   - lat: number (required)
 *   - lng: number (required)
 *   - type: string (required)
 *   - imageUrl: string (optional)
 *   - threshold: number (optional)
 * @returns {Promise<object>} Duplicate suppression assessment
 */
async function assessIssueDuplicates(options = {}) {
  const { lat, lng, type, imageUrl, threshold = DEFAULT_SIMILARITY_THRESHOLD } = options;

  // Stage 1: Geospatial candidate retrieval within 50m radius (Section VI-C)
  let candidates = [];
  try {
    candidates = await retrieveSpatialDuplicateCandidates({
      lat,
      lng,
      type,
      radiusMeters: 50,
      limit: 10
    });
  } catch (spatialErr) {
    // If spatial retrieval fails, degrade gracefully with unverified status
    return {
      duplicateStatus: "unverified",
      needsReview: true,
      similarityScore: 0.0,
      aiDiagnostic: { serviceStatus: "spatial_error", message: spatialErr.message }
    };
  }

  // If no image is attached to the new issue
  if (!imageUrl) {
    if (!candidates || candidates.length === 0) {
      return {
        duplicateStatus: "unique",
        needsReview: false,
        similarityScore: 0.0,
        candidatesChecked: 0
      };
    }
    // Candidates exist nearby but no image was provided to compare
    return {
      duplicateStatus: "unverified",
      needsReview: true,
      similarityScore: 0.0,
      candidatesChecked: candidates.length,
      aiDiagnostic: {
        serviceStatus: "no_image_provided",
        message: "Candidates exist nearby but no image was attached for comparison"
      }
    };
  }

  // Fetch embedding for the new issue
  const embedResult = await fetchClipEmbedding(imageUrl);

  if (!embedResult.success) {
    // Soft failure: AI service down, timed out, or image failed to download
    return {
      duplicateStatus: "unverified",
      needsReview: true,
      similarityScore: 0.0,
      candidatesChecked: candidates ? candidates.length : 0,
      aiDiagnostic: { serviceStatus: "ai_service_unavailable", message: embedResult.error }
    };
  }

  // If no geographic candidates exist nearby, this defect is geographically unique,
  // but we retain its embedding and model metadata for future candidate checks!
  if (!candidates || candidates.length === 0) {
    return {
      duplicateStatus: "unique",
      needsReview: false,
      similarityScore: 0.0,
      candidatesChecked: 0,
      embedding: embedResult.embedding,
      embeddingModel: embedResult.model
    };
  }

  // Stage 2: Compare embedding against candidates
  const comparison = compareEmbeddingWithCandidates({
    targetEmbedding: embedResult.embedding,
    targetModel: embedResult.model,
    candidates,
    threshold
  });

  // Confirmed threshold match against a compatible candidate -> suspected duplicate flag
  if (comparison.hasDuplicate && comparison.topMatch) {
    return {
      duplicateStatus: "flagged_duplicate",
      duplicateOf: comparison.topMatch.id,
      similarityScore: comparison.topMatch.similarity,
      needsReview: true,
      candidatesChecked: candidates.length,
      embedding: embedResult.embedding,
      embeddingModel: embedResult.model,
      aiDiagnostic: {
        serviceStatus: "duplicate_flagged",
        model: embedResult.model
      }
    };
  }

  // If any nearby candidates could NOT be verified (missing vector, malformed, incompatible model),
  // we cannot safely assert that this issue is unique! Mark as unverified for manual review.
  if (comparison.unverifiedCandidates && comparison.unverifiedCandidates.length > 0) {
    return {
      duplicateStatus: "unverified",
      needsReview: true,
      similarityScore: comparison.rankedCandidates.length > 0 ? comparison.rankedCandidates[0].similarity : 0.0,
      candidatesChecked: candidates.length,
      embedding: embedResult.embedding,
      embeddingModel: embedResult.model,
      aiDiagnostic: {
        serviceStatus: "unverified_candidates",
        message: `${comparison.unverifiedCandidates.length} candidate(s) could not be verified due to missing, malformed, or incompatible embedding`,
        model: embedResult.model
      }
    };
  }

  // All candidates were verified, compatible, and strictly below threshold: defect is unique!
  return {
    duplicateStatus: "unique",
    needsReview: false,
    similarityScore: comparison.rankedCandidates.length > 0 ? comparison.rankedCandidates[0].similarity : 0.0,
    candidatesChecked: candidates.length,
    embedding: embedResult.embedding,
    embeddingModel: embedResult.model,
    aiDiagnostic: {
      serviceStatus: "clean_unique",
      model: embedResult.model
    }
  };
}

/**
 * Calls FastAPI microservice to classify civic defect and compute severity estimate.
 * Enforces independent bounded timeout (default 2500ms) with AbortSignal.
 * Validates severity range [1, 10] and confidence range [0, 1].
 * Soft-failure guarantee: Returns { success: false, ... } instead of throwing,
 * so issue creation is NEVER blocked by classification outage or timeout.
 *
 * @param {string} imageUrl - Public image URL
 * @param {object} options - Optional candidateCategory, timeoutMs
 * @returns {Promise<{
 *   success: boolean,
 *   category?: string | null,
 *   confidence?: number | null,
 *   severity?: number | null,
 *   suggestedDepartment?: string | null,
 *   model?: string,
 *   mode?: string,
 *   isTrainedModel?: boolean,
 *   severityMode?: string | null,
 *   status?: string,
 *   error?: string
 * }>}
 */
async function classifyIssueImage(imageUrl, options = {}) {
  const { candidateCategory, timeoutMs = 2500 } = options;

  if (!imageUrl || typeof imageUrl !== "string") {
    return { success: false, error: "Image URL must be a non-empty string" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = { "Content-Type": "application/json" };
    if (process.env.AI_SERVICE_API_KEY) {
      headers["X-API-Key"] = process.env.AI_SERVICE_API_KEY.trim();
    }

    const payload = {
      image_url: imageUrl,
      candidate_category: candidateCategory || null
    };

    const response = await fetch(`${DEFAULT_AI_SERVICE_URL}/classify-issue`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, error: `AI service returned HTTP ${response.status}: ${errText}` };
    }

    const data = await response.json();

    // Validate severity bounds [1.0, 10.0]
    let validatedSeverity = null;
    if (typeof data.severity === "number" && Number.isFinite(data.severity)) {
      if (data.severity >= 1.0 && data.severity <= 10.0) {
        validatedSeverity = Math.round(data.severity * 10) / 10;
      }
    }

    // Validate confidence bounds [0.0, 1.0]
    let validatedConfidence = null;
    if (typeof data.confidence === "number" && Number.isFinite(data.confidence)) {
      if (data.confidence >= 0.0 && data.confidence <= 1.0) {
        validatedConfidence = Math.round(data.confidence * 1000) / 1000;
      }
    }

    return {
      success: true,
      category: data.category || null,
      confidence: validatedConfidence,
      severity: validatedSeverity,
      suggestedDepartment: data.suggested_department || null,
      model: data.model || "unknown",
      mode: data.mode || "unknown",
      isTrainedModel: Boolean(data.is_trained_model),
      severityMode: data.severity_mode || null,
      status: data.status || "unverified"
    };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      return { success: false, error: `AI service classification request timed out after ${timeoutMs}ms` };
    }
    return { success: false, error: `Failed to connect to AI classification service: ${err.message}` };
  }
}

module.exports = {
  cosineSimilarity,
  validateEmbeddingVector,
  areModelsCompatible,
  fetchClipEmbedding,
  compareEmbeddingWithCandidates,
  assessIssueDuplicates,
  classifyIssueImage,
  DEFAULT_SIMILARITY_THRESHOLD,
  EXPECTED_EMBEDDING_DIM
};
