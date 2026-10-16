/**
 * CivicVision AI — DBSCAN Spatial Clustering & Hotspot Service (Phase 4.2B-B)
 *
 * Implements density-based spatial clustering of applications with noise (DBSCAN)
 * using geodesic Haversine distance in meters.
 *
 * Scopes Covered:
 * - Scope C: Pure DBSCAN clustering with Haversine distance and robust edge-case handling.
 * - Scope D: Duplicate report aggregation to prevent inflating distinct defect counts.
 * - Scope E: Deterministic cluster matching, identity preservation, and conservative lifecycle.
 * - Scope F: Alert deduplication and escalation bookkeeping (zero external notification calls).
 */

const Issue = require("../models/Issue");
const Hotspot = require("../models/Hotspot");
const {
  CANONICAL_CATEGORIES,
  normalizeCategory,
  getDepartmentForCategory
} = require("./routing.service");
const { dispatchHotspotNotification } = require("./adminNotification.service");

// Default Configuration Constants (Research Paper Section VI & Phase 4.2B Specs)
const DEFAULT_HOTSPOT_EPS_METERS = 100;
const DEFAULT_HOTSPOT_MIN_SAMPLES = 3;
const DEFAULT_HOTSPOT_ROLLING_WINDOW_DAYS = 14;
const EARTH_RADIUS_METERS = 6371000;

/**
 * Validates and retrieves the DBSCAN configuration parameters.
 * Reads environment overrides safely with strict validation and fallbacks.
 *
 * @param {object} [overrides={}] - Optional parameter overrides for testing or manual execution.
 * @returns {{ epsMeters: number, minSamples: number, rollingWindowDays: number }}
 */
function getDbscanConfig(overrides = {}) {
  const envEps = process.env.HOTSPOT_EPS_METERS;
  const envMinSamples = process.env.HOTSPOT_MIN_SAMPLES;
  const envWindow = process.env.HOTSPOT_ROLLING_WINDOW_DAYS;

  const rawEps = overrides.epsMeters !== undefined ? overrides.epsMeters : envEps;
  const rawMinSamples = overrides.minSamples !== undefined ? overrides.minSamples : envMinSamples;
  const rawWindow = overrides.rollingWindowDays !== undefined ? overrides.rollingWindowDays : envWindow;

  const epsMeters =
    rawEps !== undefined && !isNaN(Number(rawEps)) && Number(rawEps) > 0
      ? Number(rawEps)
      : DEFAULT_HOTSPOT_EPS_METERS;

  const minSamples =
    rawMinSamples !== undefined && !isNaN(parseInt(rawMinSamples, 10)) && parseInt(rawMinSamples, 10) >= 1
      ? parseInt(rawMinSamples, 10)
      : DEFAULT_HOTSPOT_MIN_SAMPLES;

  const rollingWindowDays =
    rawWindow !== undefined && !isNaN(Number(rawWindow)) && Number(rawWindow) > 0
      ? Number(rawWindow)
      : DEFAULT_HOTSPOT_ROLLING_WINDOW_DAYS;

  return { epsMeters, minSamples, rollingWindowDays };
}

/**
 * Validates custom DBSCAN configuration values.
 * Throws descriptive Error if invalid.
 */
function validateDbscanConfig(config = {}) {
  if (config.epsMeters !== undefined) {
    const eps = Number(config.epsMeters);
    if (isNaN(eps) || eps <= 0) {
      throw new Error(`Invalid epsMeters: ${config.epsMeters}. Must be a positive number of meters.`);
    }
  }
  if (config.minSamples !== undefined) {
    const minS = Number(config.minSamples);
    if (isNaN(minS) || !Number.isInteger(minS) || minS < 1) {
      throw new Error(`Invalid minSamples: ${config.minSamples}. Must be an integer >= 1.`);
    }
  }
  if (config.rollingWindowDays !== undefined) {
    const win = Number(config.rollingWindowDays);
    if (isNaN(win) || win <= 0) {
      throw new Error(`Invalid rollingWindowDays: ${config.rollingWindowDays}. Must be a positive number of days.`);
    }
  }
  return true;
}

/**
 * Calculates geodesic great-circle distance between two points on Earth using Haversine formula.
 * Accurately normalizes longitude difference to [-180, 180] degrees to handle anti-meridian crossing safely.
 *
 * @param {number} lat1 - Latitude of point 1 in degrees (-90 to 90)
 * @param {number} lon1 - Longitude of point 1 in degrees (-180 to 180)
 * @param {number} lat2 - Latitude of point 2 in degrees (-90 to 90)
 * @param {number} lon2 - Longitude of point 2 in degrees (-180 to 180)
 * @returns {number} Distance in meters rounded to 1 decimal place
 */
function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
  if (
    typeof lat1 !== "number" || isNaN(lat1) ||
    typeof lon1 !== "number" || isNaN(lon1) ||
    typeof lat2 !== "number" || isNaN(lat2) ||
    typeof lon2 !== "number" || isNaN(lon2)
  ) {
    return Infinity;
  }

  const toRad = deg => (deg * Math.PI) / 180;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLat = toRad(lat2 - lat1);

  // Normalize longitude delta to [-180, 180] to handle the 180th meridian correctly
  let diffLonDeg = ((lon2 - lon1 + 540) % 360) - 180;
  const dLon = toRad(diffLonDeg);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(EARTH_RADIUS_METERS * c * 10) / 10;
}

/**
 * Extracts and validates [lng, lat] coordinates from an arbitrary point or issue object.
 *
 * @param {object|Array} item
 * @returns {[number, number]|null} [longitude, latitude] or null if invalid
 */
function extractCoordinates(item) {
  if (!item) return null;

  // Case 1: Plain [lng, lat] array
  if (Array.isArray(item) && item.length === 2) {
    const [lng, lat] = item.map(Number);
    if (!isNaN(lng) && !isNaN(lat) && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90) {
      return [lng, lat];
    }
    return null;
  }

  // Case 2: Object with coordinates array (GeoJSON Point)
  if (item.coordinates && Array.isArray(item.coordinates) && item.coordinates.length === 2) {
    const [lng, lat] = item.coordinates.map(Number);
    if (!isNaN(lng) && !isNaN(lat) && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90) {
      return [lng, lat];
    }
    return null;
  }

  // Case 3: Object with location.coordinates
  if (item.location && item.location.coordinates && Array.isArray(item.location.coordinates)) {
    const [lng, lat] = item.location.coordinates.map(Number);
    if (!isNaN(lng) && !isNaN(lat) && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90) {
      return [lng, lat];
    }
    return null;
  }

  // Case 4: Legacy { lat, lng }
  if (item.lat !== undefined && item.lng !== undefined) {
    const lat = Number(item.lat);
    const lng = Number(item.lng);
    if (!isNaN(lng) && !isNaN(lat) && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90) {
      return [lng, lat];
    }
    return null;
  }

  return null;
}

/**
 * Calculates the exact spherical center of a collection of [lng, lat] coordinates.
 * Operates on the 3D unit sphere to avoid distortion across poles, equator, and antimeridian.
 *
 * @param {Array<[number, number]>} coordsList - Array of [lng, lat] pairs
 * @returns {[number, number]} Spherical centroid [longitude, latitude]
 */
function calculateSphericalCentroid(coordsList) {
  if (!coordsList || coordsList.length === 0) return [0, 0];
  if (coordsList.length === 1) return [coordsList[0][0], coordsList[0][1]];

  let xSum = 0;
  let ySum = 0;
  let zSum = 0;

  for (const [lng, lat] of coordsList) {
    const latRad = (lat * Math.PI) / 180;
    const lngRad = (lng * Math.PI) / 180;
    xSum += Math.cos(latRad) * Math.cos(lngRad);
    ySum += Math.cos(latRad) * Math.sin(lngRad);
    zSum += Math.sin(latRad);
  }

  const count = coordsList.length;
  const x = xSum / count;
  const y = ySum / count;
  const z = zSum / count;

  const hyp = Math.sqrt(x * x + y * y);
  const latCentroid = Math.atan2(z, hyp) * (180 / Math.PI);
  const lngCentroid = Math.atan2(y, x) * (180 / Math.PI);

  return [
    Math.round(lngCentroid * 1e7) / 1e7,
    Math.round(latCentroid * 1e7) / 1e7
  ];
}

/**
 * Pure DBSCAN clustering algorithm.
 * Operates entirely in memory without database queries, ensuring deterministic testability.
 *
 * @param {object} options
 * @param {Array<object>} options.points - Array of points, each having `{ id, coordinates: [lng, lat] }`
 * @param {number} [options.epsMeters=100] - Neighborhood distance radius in meters
 * @param {number} [options.minSamples=3] - Minimum samples required to form a dense core
 * @param {Function} [options.distanceFn] - Optional distance function: `(lat1, lon1, lat2, lon2) => meters`
 * @returns {{ clusters: Array<Array<object>>, noise: Array<object>, invalidPoints: Array<object> }}
 */
function dbscan(options = {}) {
  const {
    points = [],
    epsMeters = DEFAULT_HOTSPOT_EPS_METERS,
    minSamples = DEFAULT_HOTSPOT_MIN_SAMPLES,
    distanceFn = haversineDistanceMeters
  } = options;

  validateDbscanConfig({ epsMeters, minSamples });

  const validPoints = [];
  const invalidPoints = [];

  for (const p of points) {
    const coords = extractCoordinates(p.coordinates || p.location || p);
    if (coords) {
      validPoints.push({
        ...p,
        coordinates: coords,
        lat: coords[1],
        lng: coords[0]
      });
    } else {
      invalidPoints.push(p);
    }
  }

  if (validPoints.length === 0) {
    return { clusters: [], noise: [], invalidPoints };
  }

  // Deterministic stable sorting by ID
  validPoints.sort((a, b) => String(a.id || a._id).localeCompare(String(b.id || b._id)));

  const visited = new Set();
  const noiseIds = new Set();
  const clusteredIds = new Set();
  const clusters = [];

  // Helper to query neighborhood
  function getNeighbors(targetPoint) {
    const neighbors = [];
    for (const other of validPoints) {
      const d = distanceFn(targetPoint.lat, targetPoint.lng, other.lat, other.lng);
      if (d <= epsMeters) {
        neighbors.push(other);
      }
    }
    return neighbors;
  }

  for (const point of validPoints) {
    const pId = String(point.id || point._id);
    if (visited.has(pId)) continue;

    visited.add(pId);
    const neighbors = getNeighbors(point);

    if (neighbors.length < minSamples) {
      noiseIds.add(pId);
    } else {
      // Start a new cluster
      const currentCluster = [];
      noiseIds.delete(pId);
      clusteredIds.add(pId);
      currentCluster.push(point);

      const queue = [...neighbors.filter(n => String(n.id || n._id) !== pId)];
      const queueIds = new Set(queue.map(n => String(n.id || n._id)));

      while (queue.length > 0) {
        const neighbor = queue.shift();
        const nId = String(neighbor.id || neighbor._id);
        queueIds.delete(nId);

        if (noiseIds.has(nId)) {
          noiseIds.delete(nId);
          clusteredIds.add(nId);
          currentCluster.push(neighbor);
        }

        if (!visited.has(nId)) {
          visited.add(nId);
          clusteredIds.add(nId);
          currentCluster.push(neighbor);

          const neighborNeighbors = getNeighbors(neighbor);
          if (neighborNeighbors.length >= minSamples) {
            for (const nn of neighborNeighbors) {
              const nnId = String(nn.id || nn._id);
              if (!visited.has(nnId) && !queueIds.has(nnId) && !clusteredIds.has(nnId)) {
                queue.push(nn);
                queueIds.add(nnId);
              }
            }
          }
        }
      }

      clusters.push(currentCluster);
    }
  }

  const noise = validPoints.filter(p => noiseIds.has(String(p.id || p._id)));

  return { clusters, noise, invalidPoints };
}

/**
 * Scope D: Duplicate Report Treatment & Canonical Defect Aggregator.
 *
 * Avoids inflating distinct defect counts with confirmed duplicates by grouping
 * confirmed duplicate reports under their canonical root parent issue.
 *
 * Safely prevents infinite loops, circular duplicate references, and self-references.
 * Unresolved duplicates (needsDuplicateReview = true without confirmation) remain
 * distinct candidates so unreviewed citizen reports are not prematurely discarded.
 *
 * @param {Array<object>} issues - Raw or mongoose issue documents
 * @returns {Array<object>} Array of canonical defect units ready for spatial clustering
 */
function resolveCanonicalDefects(issues = []) {
  if (!issues || issues.length === 0) return [];

  // Build lookup index by issue ID
  const issueMap = new Map();
  for (const issue of issues) {
    const idStr = String(issue._id || issue.id);
    issueMap.set(idStr, issue);
  }

  /**
   * Helper to resolve the root parent issue ID while detecting cycles and self-references.
   */
  function findRootParentId(startId) {
    const visitedChain = new Set();
    let currentId = String(startId);

    while (currentId) {
      if (visitedChain.has(currentId)) {
        // Cycle detected! Break cycle conservatively at startId
        return String(startId);
      }
      visitedChain.add(currentId);

      const issue = issueMap.get(currentId);
      if (!issue) {
        // Parent not present in active issue set (e.g., resolved or outside window)
        return currentId;
      }

      const isConfirmedDuplicate =
        Boolean(issue.duplicateOf) &&
        (issue.reviewResolution === "confirmed_duplicate" ||
          issue.duplicateStatus === "flagged_duplicate");

      if (isConfirmedDuplicate) {
        const nextParentId = String(issue.duplicateOf);
        if (nextParentId === currentId) {
          // Self-reference detected: break immediately
          return currentId;
        }
        currentId = nextParentId;
      } else {
        // Found root canonical parent
        return currentId;
      }
    }
    return String(startId);
  }

  // Group issues into canonical defect units
  const defectGroups = new Map();

  for (const issue of issues) {
    const issueId = String(issue._id || issue.id);
    const rootId = findRootParentId(issueId);

    // If root issue is in the active set, use it; otherwise use this issue
    const rootIssue = issueMap.get(rootId) || issue;

    if (!defectGroups.has(rootId)) {
      defectGroups.set(rootId, {
        id: rootId,
        _id: rootIssue._id || rootId,
        canonicalIssue: rootIssue,
        coordinates: extractCoordinates(rootIssue.location || rootIssue.coordinates || rootIssue),
        category: normalizeCategory(rootIssue.type),
        department: rootIssue.department || getDepartmentForCategory(normalizeCategory(rootIssue.type)),
        constituentIssues: [],
        constituentIssueIds: [],
        totalVotes: 0,
        severities: []
      });
    }

    const group = defectGroups.get(rootId);
    group.constituentIssues.push(issue);
    group.constituentIssueIds.push(issue._id || issue.id);
    group.totalVotes += Number(issue.votes) || 0;
    if (typeof issue.severity === "number" && !isNaN(issue.severity)) {
      group.severities.push(issue.severity);
    }
  }

  // Convert groups into canonical defect units with distinctDefectCount = 1
  const canonicalDefects = [];
  for (const [defectId, group] of defectGroups.entries()) {
    // If coordinates could not be extracted from root, attempt extraction from any constituent issue
    if (!group.coordinates) {
      for (const item of group.constituentIssues) {
        const fallbackCoords = extractCoordinates(item.location || item.coordinates || item);
        if (fallbackCoords) {
          group.coordinates = fallbackCoords;
          break;
        }
      }
    }

    canonicalDefects.push({
      id: defectId,
      _id: group._id,
      coordinates: group.coordinates,
      category: group.category,
      department: group.department,
      distinctDefectCount: 1, // Crucial: distinct physical defect is counted exactly once
      totalReportCount: group.constituentIssues.length, // Citizen reports counted separately
      totalVotes: group.totalVotes,
      severities: group.severities,
      constituentIssueIds: group.constituentIssueIds
    });
  }

  return canonicalDefects;
}

/**
 * Builds cluster summary metrics from a group of clustered canonical defects.
 *
 * @param {Array<object>} clusterDefects - Array of canonical defect units
 * @param {string} category - Canonical category name
 * @param {string} department - Municipal department name
 * @returns {object} Aggregated cluster summary
 */
function buildClusterMetrics(clusterDefects, category, department) {
  const coordsList = clusterDefects.map(d => d.coordinates).filter(Boolean);
  const centroid = calculateSphericalCentroid(coordsList);

  let totalReportCount = 0;
  let totalVotes = 0;
  const allSeverities = [];
  const allIssueIds = [];

  let maxRadiusMeters = 0;
  for (const defect of clusterDefects) {
    totalReportCount += defect.totalReportCount || 1;
    totalVotes += defect.totalVotes || 0;
    if (Array.isArray(defect.severities)) {
      allSeverities.push(...defect.severities);
    }
    if (Array.isArray(defect.constituentIssueIds)) {
      allIssueIds.push(...defect.constituentIssueIds);
    }
    if (defect.coordinates) {
      const dist = haversineDistanceMeters(centroid[1], centroid[0], defect.coordinates[1], defect.coordinates[0]);
      if (dist > maxRadiusMeters) {
        maxRadiusMeters = dist;
      }
    }
  }

  let meanSeverity = null;
  if (allSeverities.length > 0) {
    const sum = allSeverities.reduce((acc, s) => acc + s, 0);
    meanSeverity = Math.round((sum / allSeverities.length) * 10) / 10;
  }

  return {
    category,
    department,
    centroid: {
      type: "Point",
      coordinates: centroid
    },
    radiusMeters: Math.round(maxRadiusMeters * 10) / 10,
    distinctDefectCount: clusterDefects.length,
    totalReportCount,
    totalVotes,
    meanSeverity,
    issueIds: allIssueIds
  };
}

/**
 * Scope E: Deterministic Cluster Matching Helper.
 *
 * Matches newly detected clusters with existing Hotspots in the database.
 * Prevents unnecessary recreation of Hotspot documents on every refresh run.
 * Defines unambiguous rules for splits, merges, and conservative lifecycle.
 *
 * Score formula: 0.6 * Jaccard(issueIds) + 0.4 * Proximity(centroid, eps)
 * Deterministic greedy resolution guarantees that no two new clusters claim the same old hotspot.
 *
 * @param {object} options
 * @param {Array<object>} options.newClusters - Newly detected clusters
 * @param {Array<object>} options.existingHotspots - Existing active/resolving Hotspot documents
 * @param {number} [options.epsMeters=100] - Neighborhood distance radius in meters
 * @returns {{ matched: Array<{ newCluster: object, existingHotspot: object, score: number }>, unmatchedNewClusters: Array<object>, unmatchedExistingHotspots: Array<object> }}
 */
function matchClustersAndHotspots(options = {}) {
  const {
    newClusters = [],
    existingHotspots = [],
    epsMeters = DEFAULT_HOTSPOT_EPS_METERS
  } = options;

  if (newClusters.length === 0) {
    return {
      matched: [],
      unmatchedNewClusters: [],
      unmatchedExistingHotspots: [...existingHotspots]
    };
  }

  if (existingHotspots.length === 0) {
    return {
      matched: [],
      unmatchedNewClusters: [...newClusters],
      unmatchedExistingHotspots: []
    };
  }

  // Pre-compute candidate pairs with similarity scores
  const candidatePairs = [];

  for (let i = 0; i < newClusters.length; i++) {
    const newClust = newClusters[i];
    const newCoords = extractCoordinates(newClust.centroid || newClust.coordinates);
    if (!newCoords) continue;

    const newIssueSet = new Set(newClust.issueIds.map(String));

    for (let j = 0; j < existingHotspots.length; j++) {
      const oldHotspot = existingHotspots[j];
      const oldCoords = extractCoordinates(oldHotspot.centroid || oldHotspot.coordinates);
      if (!oldCoords) continue;

      const oldIssueSet = new Set((oldHotspot.issueIds || []).map(String));

      // 1. Centroid distance
      const distance = haversineDistanceMeters(newCoords[1], newCoords[0], oldCoords[1], oldCoords[0]);

      // 2. Issue ID Jaccard similarity & overlap
      let intersectionCount = 0;
      for (const id of newIssueSet) {
        if (oldIssueSet.has(id)) {
          intersectionCount++;
        }
      }
      const unionCount = new Set([...newIssueSet, ...oldIssueSet]).size;
      const jaccard = unionCount > 0 ? intersectionCount / unionCount : 0;

      // Candidate matching criteria: within 2 * epsMeters AND (either issue overlap > 0 OR distance <= epsMeters)
      if (distance <= 2 * epsMeters && (intersectionCount > 0 || distance <= epsMeters)) {
        const proximityScore = Math.max(0, 1 - distance / (2 * epsMeters));
        const compositeScore = 0.6 * jaccard + 0.4 * proximityScore;

        candidatePairs.push({
          newClusterIndex: i,
          newCluster: newClust,
          existingHotspotIndex: j,
          existingHotspot: oldHotspot,
          score: Math.round(compositeScore * 1000) / 1000,
          intersectionCount,
          distance,
          firstDetectedAt: oldHotspot.firstDetectedAt
            ? new Date(oldHotspot.firstDetectedAt).getTime()
            : 0,
          hotspotId: String(oldHotspot._id)
        });
      }
    }
  }

  // Deterministic greedy assignment sorting:
  // 1. Highest composite score
  // 2. Highest issue overlap count
  // 3. Lowest distance
  // 4. Oldest firstDetectedAt
  // 5. Lexicographical hotspot ID tie-breaker
  candidatePairs.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.intersectionCount !== a.intersectionCount) return b.intersectionCount - a.intersectionCount;
    if (a.distance !== b.distance) return a.distance - b.distance;
    if (a.firstDetectedAt !== b.firstDetectedAt) return a.firstDetectedAt - b.firstDetectedAt;
    return a.hotspotId.localeCompare(b.hotspotId);
  });

  const matched = [];
  const claimedNewIndices = new Set();
  const claimedOldIndices = new Set();

  for (const pair of candidatePairs) {
    if (claimedNewIndices.has(pair.newClusterIndex) || claimedOldIndices.has(pair.existingHotspotIndex)) {
      continue;
    }

    claimedNewIndices.add(pair.newClusterIndex);
    claimedOldIndices.add(pair.existingHotspotIndex);

    matched.push({
      newCluster: pair.newCluster,
      existingHotspot: pair.existingHotspot,
      score: pair.score
    });
  }

  const unmatchedNewClusters = newClusters.filter((_, idx) => !claimedNewIndices.has(idx));
  const unmatchedExistingHotspots = existingHotspots.filter((_, idx) => !claimedOldIndices.has(idx));

  return {
    matched,
    unmatchedNewClusters,
    unmatchedExistingHotspots
  };
}

/**
 * Scope F: Alert Deduplication Foundation.
 *
 * Evaluates whether an alert state change is warranted for a given hotspot.
 * Strictly maintains bookkeeping flags and timestamps without sending external communications.
 *
 * Escalation policy:
 * - Initial detection: triggers initial alert bookkeeping.
 * - Repeated detection with unchanged counts: idempotent, does not reset timestamps.
 * - Significant growth (>= 50% increase over lastAlertIssueCount) after cooldown: triggers escalation.
 *
 * @param {object} hotspot - Hotspot document or object
 * @param {object} [options={}]
 * @param {number} [options.alertCooldownHours=24]
 * @param {number} [options.escalationGrowthRate=0.5]
 * @param {Date} [options.now=new Date()]
 * @returns {{ shouldAlert: boolean, alertType: 'initial'|'escalation'|'none', updates: object }}
 */
function evaluateAlertState(hotspot, options = {}) {
  const {
    alertCooldownHours = 24,
    escalationGrowthRate = 0.5,
    now = new Date()
  } = options;

  const currentReports = Number(hotspot.totalReportCount) || 1;
  const currentDefects = Number(hotspot.distinctDefectCount) || 1;

  // Case 1: Initial alert
  if (!hotspot.alertSent) {
    return {
      shouldAlert: true,
      alertType: "initial",
      updates: {
        alertSent: true,
        alertSentAt: now,
        lastAlertIssueCount: currentReports,
        lastAlertDefectCount: currentDefects
      }
    };
  }

  // Case 2: Escalation alert
  const lastAlertCount = Number(hotspot.lastAlertIssueCount) || 1;
  const growth = (currentReports - lastAlertCount) / Math.max(1, lastAlertCount);

  // Check cooldown if previous alert exists
  const lastAlertTime = hotspot.escalatedAlertSentAt
    ? new Date(hotspot.escalatedAlertSentAt).getTime()
    : hotspot.alertSentAt
    ? new Date(hotspot.alertSentAt).getTime()
    : 0;

  const hoursSinceLastAlert = (now.getTime() - lastAlertTime) / (3600 * 1000);

  if (growth >= escalationGrowthRate && hoursSinceLastAlert >= alertCooldownHours) {
    return {
      shouldAlert: true,
      alertType: "escalation",
      updates: {
        escalatedAlertSentAt: now,
        lastAlertIssueCount: currentReports,
        lastAlertDefectCount: currentDefects,
        status: "escalating"
      }
    };
  }

  // Case 3: No new alert (idempotent repeat run)
  return {
    shouldAlert: false,
    alertType: "none",
    updates: {}
  };
}

/**
 * End-to-End Hotspot Detection & Synchronization Pipeline.
 *
 * Queries active issues within the configured rolling window, clusters them by canonical category,
 * matches with existing hotspots deterministically, updates Mongoose documents, and links Issue.clusterId.
 *
 * @param {object} [options={}]
 * @param {string} [options.category] - Optional canonical category to cluster
 * @param {Date} [options.now=new Date()] - Execution timestamp
 * @param {number} [options.epsMeters] - Config override
 * @param {number} [options.minSamples] - Config override
 * @param {number} [options.rollingWindowDays] - Config override
 * @returns {Promise<object>} Sync summary
 */
async function detectAndSyncHotspots(options = {}) {
  validateDbscanConfig(options);
  const now = options.now instanceof Date ? options.now : new Date();
  const config = getDbscanConfig(options);
  validateDbscanConfig(config);

  const windowMs = config.rollingWindowDays * 24 * 60 * 60 * 1000;
  const cutoffDate = new Date(now.getTime() - windowMs);

  // 1. Build Query: Active issues inside rolling window with valid coordinates
  const query = {
    status: { $in: ["reported", "in-progress"] },
    createdAt: { $gte: cutoffDate }
  };

  if (options.category) {
    const normalizedCat = normalizeCategory(options.category);
    const spaced = normalizedCat.replace(/_/g, " ");
    query.type = normalizedCat === spaced ? normalizedCat : { $in: [normalizedCat, spaced] };
  }

  const activeIssues = await Issue.find(query)
    .select("+duplicateOf +reviewResolution +duplicateStatus +severity +votes +location")
    .lean();

  // 2. Partition issues by normalized canonical category
  const issuesByCategory = new Map();
  for (const cat of CANONICAL_CATEGORIES) {
    issuesByCategory.set(cat, []);
  }

  for (const issue of activeIssues) {
    const cat = normalizeCategory(issue.type);
    if (!issuesByCategory.has(cat)) {
      issuesByCategory.set(cat, []);
    }
    issuesByCategory.get(cat).push(issue);
  }

  const categoriesToProcess = options.category
    ? [normalizeCategory(options.category)]
    : CANONICAL_CATEGORIES;

  let createdCount = 0;
  let updatedCount = 0;
  let resolvingCount = 0;
  let resolvedCount = 0;
  const allSyncedHotspotIds = [];

  for (const cat of categoriesToProcess) {
    const catIssues = issuesByCategory.get(cat) || [];
    const department = getDepartmentForCategory(cat);

    // Group confirmed duplicates into canonical defect units
    const canonicalDefects = resolveCanonicalDefects(catIssues);

    // Run pure DBSCAN
    const { clusters } = dbscan({
      points: canonicalDefects,
      epsMeters: config.epsMeters,
      minSamples: config.minSamples
    });

    // Build metrics for each newly detected cluster
    const newClusterMetrics = clusters.map(clusterDefects =>
      buildClusterMetrics(clusterDefects, cat, department)
    );

    // Fetch existing active or resolving hotspots for this category
    const existingHotspots = await Hotspot.find({
      category: cat,
      status: { $in: ["active", "escalating", "resolving"] }
    });

    // Match clusters deterministically
    const {
      matched,
      unmatchedNewClusters,
      unmatchedExistingHotspots
    } = matchClustersAndHotspots({
      newClusters: newClusterMetrics,
      existingHotspots,
      epsMeters: config.epsMeters
    });

    // Handle Matched Hotspots
    for (const match of matched) {
      const { newCluster, existingHotspot } = match;

      existingHotspot.centroid = newCluster.centroid;
      existingHotspot.radiusMeters = newCluster.radiusMeters;
      existingHotspot.distinctDefectCount = newCluster.distinctDefectCount;
      existingHotspot.totalReportCount = newCluster.totalReportCount;
      existingHotspot.totalVotes = newCluster.totalVotes;
      existingHotspot.meanSeverity = newCluster.meanSeverity;
      existingHotspot.issueIds = newCluster.issueIds;
      existingHotspot.lastDetectedAt = now;

      // If it was resolving, revert back to active since it has dense issues again
      if (existingHotspot.status === "resolving") {
        existingHotspot.status = "active";
      }

      // Evaluate alert state
      const alertEval = evaluateAlertState(existingHotspot, { now });
      if (alertEval.shouldAlert) {
        Object.assign(existingHotspot, alertEval.updates);
      }

      await existingHotspot.save();
      allSyncedHotspotIds.push(existingHotspot._id);
      updatedCount++;

      // Dispatch escalation notification & email alert
      if (alertEval.shouldAlert && alertEval.alertType === "escalation") {
        try {
          await dispatchHotspotNotification({
            type: "hotspot_escalated",
            hotspot: existingHotspot,
            now
          });
        } catch (notifErr) {
          console.error(`[DBSCAN] Warning: Failed to dispatch escalation notification: ${notifErr.message}`);
        }
      }

      // Link constituent issues
      await Issue.updateMany(
        { _id: { $in: newCluster.issueIds } },
        { $set: { clusterId: existingHotspot._id } }
      );
    }

    // Handle Unmatched New Clusters (New Hotspots)
    for (const newClust of unmatchedNewClusters) {
      const initialAlert = evaluateAlertState(
        { ...newClust, alertSent: false },
        { now }
      );

      const hotspotDoc = new Hotspot({
        category: newClust.category,
        department: newClust.department,
        centroid: newClust.centroid,
        radiusMeters: newClust.radiusMeters,
        distinctDefectCount: newClust.distinctDefectCount,
        totalReportCount: newClust.totalReportCount,
        totalVotes: newClust.totalVotes,
        meanSeverity: newClust.meanSeverity,
        issueIds: newClust.issueIds,
        status: "active",
        firstDetectedAt: now,
        lastDetectedAt: now,
        ...initialAlert.updates
      });

      await hotspotDoc.save();
      allSyncedHotspotIds.push(hotspotDoc._id);
      createdCount++;

      // Dispatch initial hotspot notification & email alert
      if (initialAlert.shouldAlert && initialAlert.alertType === "initial") {
        try {
          await dispatchHotspotNotification({
            type: "hotspot_detected",
            hotspot: hotspotDoc,
            now
          });
        } catch (notifErr) {
          console.error(`[DBSCAN] Warning: Failed to dispatch initial hotspot notification: ${notifErr.message}`);
        }
      }

      // Link constituent issues
      await Issue.updateMany(
        { _id: { $in: newClust.issueIds } },
        { $set: { clusterId: hotspotDoc._id } }
      );
    }

    // Handle Unmatched Existing Hotspots (Conservative Lifecycle Transition)
    for (const oldHotspot of unmatchedExistingHotspots) {
      // Check status of constituent issues
      const constituentIssues = await Issue.find({
        _id: { $in: oldHotspot.issueIds }
      }).select("status");

      const allResolved =
        constituentIssues.length > 0 &&
        constituentIssues.every(iss => iss.status === "resolved");

      if (allResolved) {
        oldHotspot.status = "resolved";
        resolvedCount++;
      } else {
        // Conservative: do not claim repair is verified if merely aged out or dropped below minSamples
        oldHotspot.status = "resolving";
        resolvingCount++;
      }

      await oldHotspot.save();

      // Clear clusterId from constituent issues that are no longer part of an active cluster
      await Issue.updateMany(
        { _id: { $in: oldHotspot.issueIds }, clusterId: oldHotspot._id },
        { $set: { clusterId: null } }
      );
    }
  }

  return {
    success: true,
    createdCount,
    updatedCount,
    resolvingCount,
    resolvedCount,
    processedCategories: categoriesToProcess,
    syncedHotspotIds: allSyncedHotspotIds
  };
}

module.exports = {
  DEFAULT_HOTSPOT_EPS_METERS,
  DEFAULT_HOTSPOT_MIN_SAMPLES,
  DEFAULT_HOTSPOT_ROLLING_WINDOW_DAYS,
  getDbscanConfig,
  validateDbscanConfig,
  haversineDistanceMeters,
  extractCoordinates,
  calculateSphericalCentroid,
  dbscan,
  resolveCanonicalDefects,
  buildClusterMetrics,
  matchClustersAndHotspots,
  evaluateAlertState,
  detectAndSyncHotspots
};
