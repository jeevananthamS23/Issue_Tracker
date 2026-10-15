/**
 * CivicVision AI — Spatial Service (Phase 3.2)
 *
 * Implements indexed geospatial queries using MongoDB 2dsphere index:
 * 1. Haversine geodesic distance calculation (in meters).
 * 2. General proximity query with category, status, and radius filtering.
 * 3. Spatial duplicate candidate retrieval (Stage 1 of the two-stage duplicate suppression pipeline).
 */

const Issue = require("../models/Issue");

const EARTH_RADIUS_METERS = 6371000;

/**
 * Calculates great-circle distance between two points on a sphere using the Haversine formula.
 * @param {number} lat1 - Latitude of point 1 (in degrees)
 * @param {number} lon1 - Longitude of point 1 (in degrees)
 * @param {number} lat2 - Latitude of point 2 (in degrees)
 * @param {number} lon2 - Longitude of point 2 (in degrees)
 * @returns {number} Distance in meters rounded to 1 decimal place.
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
  const toRad = deg => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(EARTH_RADIUS_METERS * c * 10) / 10;
}

/**
 * Validates coordinate inputs against geographic boundaries.
 * @param {number} lat - Latitude
 * @param {number} lng - Longitude
 * @returns {string|null} Error message or null if valid.
 */
function validateCoordinates(lat, lng) {
  if (lat === undefined || lng === undefined || isNaN(lat) || isNaN(lng)) {
    return "Valid numerical latitude and longitude are required.";
  }
  if (lat < -90 || lat > 90) {
    return "Latitude must be between -90 and 90 degrees.";
  }
  if (lng < -180 || lng > 180) {
    return "Longitude must be between -180 and 180 degrees.";
  }
  return null;
}

/**
 * Finds nearby issues using the 2dsphere index on `location`.
 * Supports category and status filtering, bounded pagination, and distance annotation.
 *
 * @param {object} options
 *   - lat: number (required)
 *   - lng: number (required)
 *   - radiusMeters: number (optional, default 500, max 50000)
 *   - type: string (optional, filter by issue type/category)
 *   - status: string (optional: "open", "all", or specific status e.g. "reported")
 *   - limit: number (optional, default 20, max 100)
 * @returns {Promise<Array<object>>} List of issues with distanceMeters annotated
 */
async function findNearbyIssues(options = {}) {
  const { lat, lng, radiusMeters = 500, type, status, limit = 20 } = options;

  const coordErr = validateCoordinates(lat, lng);
  if (coordErr) throw new Error(coordErr);

  const parsedRadius = Number(radiusMeters);
  if (isNaN(parsedRadius) || parsedRadius <= 0) {
    throw new Error("Search radius must be a positive number of meters.");
  }
  const maxDistance = Math.min(Math.max(parsedRadius, 1), 50000); // 1m to 50km
  const maxLimit = Math.min(Math.max(Number(limit) || 20, 1), 100); // 1 to 100

  // Build compound spatial query
  const query = {
    location: {
      $near: {
        $geometry: {
          type: "Point",
          coordinates: [lng, lat] // canonical [longitude, latitude]
        },
        $maxDistance: maxDistance
      }
    }
  };

  // Optional category/type filtering
  if (type && typeof type === "string" && type.trim()) {
    query.type = type.trim();
  }

  // Optional status filtering
  if (status) {
    if (status === "open") {
      query.status = { $in: ["reported", "in-progress"] };
    } else if (status !== "all") {
      query.status = status;
    }
  }

  const issues = await Issue.find(query)
    .select("-internalNotes")
    .limit(maxLimit);

  // Annotate with exact geodesic distance
  return issues.map(doc => {
    const obj = doc.toJSON();
    const issueLat = obj.location.lat !== undefined ? obj.location.lat : obj.location.coordinates[1];
    const issueLng = obj.location.lng !== undefined ? obj.location.lng : obj.location.coordinates[0];
    obj.distanceMeters = haversineDistance(lat, lng, issueLat, issueLng);
    return obj;
  });
}

/**
 * Stage 1 of Two-Stage Duplicate Suppression (Research Paper Section VI-C):
 * Shortlists nearby open candidate issues of the same defect category within a tight radius.
 *
 * @param {object} options
 *   - lat: number (required)
 *   - lng: number (required)
 *   - type: string (required, defect category to match)
 *   - radiusMeters: number (optional, default 50m per Section VI-C, max 500m)
 *   - excludeIssueId: string|ObjectId (optional, exclude self from candidates)
 *   - limit: number (optional, default 10, max 30 candidates for Stage 2 comparison)
 * @returns {Promise<Array<object>>} Shortlist of duplicate candidates
 */
async function retrieveSpatialDuplicateCandidates(options = {}) {
  const { lat, lng, type, radiusMeters = 50, excludeIssueId, limit = 10 } = options;

  const coordErr = validateCoordinates(lat, lng);
  if (coordErr) throw new Error(coordErr);

  if (!type || typeof type !== "string" || !type.trim()) {
    throw new Error("Defect type/category is required for duplicate candidate retrieval.");
  }

  const parsedRadius = Number(radiusMeters);
  if (isNaN(parsedRadius) || parsedRadius <= 0) {
    throw new Error("Radius must be a positive number of meters.");
  }
  const maxDistance = Math.min(Math.max(parsedRadius, 1), 500); // 1m to 500m max for duplicate check
  const maxLimit = Math.min(Math.max(Number(limit) || 10, 1), 30); // max 30 candidates

  const query = {
    type: type.trim(),
    status: { $in: ["reported", "in-progress"] }, // Only open issues are duplicate candidates
    location: {
      $near: {
        $geometry: {
          type: "Point",
          coordinates: [lng, lat]
        },
        $maxDistance: maxDistance
      }
    }
  };

  if (excludeIssueId) {
    query._id = { $ne: excludeIssueId };
  }

  const candidates = await Issue.find(query)
    .select("-internalNotes +embedding +embeddingModel")
    .limit(maxLimit);

  return candidates.map(doc => {
    const obj = doc.toJSON();
    const issueLat = obj.location.lat !== undefined ? obj.location.lat : obj.location.coordinates[1];
    const issueLng = obj.location.lng !== undefined ? obj.location.lng : obj.location.coordinates[0];
    obj.distanceMeters = haversineDistance(lat, lng, issueLat, issueLng);
    // Explicitly guarantee internal access to embedding and model metadata for Stage 2 comparison
    if (doc.embedding) {
      obj.embedding = doc.embedding;
    }
    if (doc.embeddingModel) {
      obj.embeddingModel = doc.embeddingModel;
    }
    return obj;
  });
}

module.exports = {
  haversineDistance,
  validateCoordinates,
  findNearbyIssues,
  retrieveSpatialDuplicateCandidates
};
