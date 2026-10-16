/**
 * CivicVision AI — Deterministic Municipal Routing Service (Phase 4.1B)
 *
 * Implements deterministic mapping of civic defect categories to municipal departments
 * based on research paper Section VI-B and municipal operations matrix.
 *
 * Canonical Defect Categories:
 * - pothole
 * - road_damage
 * - garbage
 * - street_light
 * - water_leak
 * - sewage
 * - traffic_signal
 * - other
 *
 * Canonical Municipal Departments:
 * - Roads & Infrastructure
 * - Waste Management
 * - Street Lighting
 * - Water Services
 * - Public Works
 *
 * Triage & Fallback Policy:
 * Unclassified, unknown, or "other" defect reports are canonically routed to
 * "Public Works" as the municipal clearinghouse / manual-triage department.
 * Routing is strictly deterministic and independent of external AI availability.
 */

const CANONICAL_DEPARTMENTS = Object.freeze({
  ROADS_AND_INFRASTRUCTURE: "Roads & Infrastructure",
  WASTE_MANAGEMENT: "Waste Management",
  STREET_LIGHTING: "Street Lighting",
  WATER_SERVICES: "Water Services",
  PUBLIC_WORKS: "Public Works"
});

const DEFAULT_TRIAGE_DEPARTMENT = CANONICAL_DEPARTMENTS.PUBLIC_WORKS;

const CANONICAL_CATEGORIES = Object.freeze([
  "pothole",
  "road_damage",
  "garbage",
  "street_light",
  "water_leak",
  "sewage",
  "traffic_signal",
  "other"
]);

/**
 * Canonical Category-to-Department Mapping Matrix.
 */
const CATEGORY_TO_DEPARTMENT = Object.freeze({
  pothole: CANONICAL_DEPARTMENTS.ROADS_AND_INFRASTRUCTURE,
  road_damage: CANONICAL_DEPARTMENTS.ROADS_AND_INFRASTRUCTURE,
  garbage: CANONICAL_DEPARTMENTS.WASTE_MANAGEMENT,
  street_light: CANONICAL_DEPARTMENTS.STREET_LIGHTING,
  water_leak: CANONICAL_DEPARTMENTS.WATER_SERVICES,
  sewage: CANONICAL_DEPARTMENTS.WATER_SERVICES,
  traffic_signal: CANONICAL_DEPARTMENTS.PUBLIC_WORKS,
  other: DEFAULT_TRIAGE_DEPARTMENT
});

/**
 * Normalizes user-submitted, legacy, or frontend category strings into one of
 * the eight canonical categories.
 *
 * Handles hyphenated names, underscores, spaces, aliases, and case variations.
 *
 * @param {string} raw - Input category or issue type
 * @returns {string} One of the 8 canonical category strings
 */
function normalizeCategory(raw) {
  if (!raw || typeof raw !== "string") {
    return "other";
  }

  const cleaned = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");

  // Direct canonical match
  if (CANONICAL_CATEGORIES.includes(cleaned)) {
    return cleaned;
  }

  // Aliases and frontend legacy mappings
  const aliasMap = {
    // Roads
    unpaved_road: "road_damage",
    road_hazard: "road_damage",
    asphalt_crack: "road_damage",
    road: "road_damage",
    potholes: "pothole",

    // Waste / Garbage
    trash: "garbage",
    debris: "garbage",
    illegal_dumping: "garbage",
    dumping: "garbage",
    overflowing_dustbin: "garbage",
    dustbin: "garbage",
    construction_waste: "garbage",
    waste: "garbage",
    litter: "garbage",

    // Lighting
    streetlight: "street_light",
    street_light_out: "street_light",
    dark_street: "street_light",
    broken_light: "street_light",
    lighting: "street_light",

    // Water
    leak: "water_leak",
    pipe_burst: "water_leak",
    damaged_borewell: "water_leak",
    unclean_handpumps: "water_leak",
    drinking_water: "water_leak",
    water_scarcity: "water_leak",
    water: "water_leak",

    // Sewage / Drainage
    blocked_drain: "sewage",
    no_drainage: "sewage",
    drainage: "sewage",
    sanitation: "sewage",
    sewer: "sewage",
    open_defecation: "sewage",
    foul_smell: "sewage",

    // Traffic Signal
    signal: "traffic_signal",
    traffic_light: "traffic_signal",
    broken_signal: "traffic_signal",
    traffic: "traffic_signal"
  };

  if (aliasMap[cleaned]) {
    return aliasMap[cleaned];
  }

  return "other";
}

/**
 * Resolves the assigned municipal department for a given category.
 *
 * @param {string} category - Raw or normalized category string
 * @returns {string} Assigned municipal department name
 */
function getDepartmentForCategory(category) {
  const normalized = normalizeCategory(category);
  return CATEGORY_TO_DEPARTMENT[normalized] || DEFAULT_TRIAGE_DEPARTMENT;
}

/**
 * Evaluates routing decision combining citizen input with AI classification results.
 *
 * Rules:
 * 1. Citizen-selected category is preserved unless AI model is a genuinely trained
 *    classifier with confidence >= confidenceThreshold.
 * 2. If AI is unavailable, heuristic-only, or low-confidence (< threshold), citizen category is used.
 * 3. Mismatches between high-confidence AI and citizen report trigger manual review.
 * 4. Suggested department from AI is NEVER accepted blindly; it is always resolved
 *    through getDepartmentForCategory().
 *
 * @param {object} options
 *   - citizenCategory: string (required)
 *   - aiResult: object (optional AI classification response)
 *   - confidenceThreshold: number (default: 0.65)
 * @returns {{
 *   finalCategory: string,
 *   department: string,
 *   routingSource: 'citizen' | 'ai_verified' | 'manual_triage',
 *   classificationNeedsReview: boolean,
 *   confidence: number | null
 * }}
 */
function resolveIssueRouting(options = {}) {
  const {
    citizenCategory,
    aiResult,
    confidenceThreshold = 0.65
  } = options;

  const normalizedCitizen = normalizeCategory(citizenCategory);

  // If AI result is missing, failed, or untrustworthy (not a trained checkpoint)
  if (!aiResult || !aiResult.is_trained_model || typeof aiResult.confidence !== "number") {
    return {
      finalCategory: normalizedCitizen,
      department: getDepartmentForCategory(normalizedCitizen),
      routingSource: normalizedCitizen === "other" ? "manual_triage" : "citizen",
      classificationNeedsReview: normalizedCitizen === "other",
      confidence: null
    };
  }

  const aiConfidence = aiResult.confidence;
  const normalizedAi = normalizeCategory(aiResult.category);

  // High confidence trained prediction
  if (aiConfidence >= confidenceThreshold && normalizedAi !== "other") {
    const isMismatch = normalizedAi !== normalizedCitizen && normalizedCitizen !== "other";

    return {
      finalCategory: normalizedAi,
      department: getDepartmentForCategory(normalizedAi),
      routingSource: "ai_verified",
      classificationNeedsReview: isMismatch,
      confidence: aiConfidence
    };
  }

  // Low confidence: preserve citizen selection, flag for review if uncertain
  return {
    finalCategory: normalizedCitizen,
    department: getDepartmentForCategory(normalizedCitizen),
    routingSource: "citizen",
    classificationNeedsReview: true,
    confidence: aiConfidence
  };
}

module.exports = {
  CANONICAL_DEPARTMENTS,
  DEFAULT_TRIAGE_DEPARTMENT,
  CANONICAL_CATEGORIES,
  CATEGORY_TO_DEPARTMENT,
  normalizeCategory,
  getDepartmentForCategory,
  resolveIssueRouting
};
