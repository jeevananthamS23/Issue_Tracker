/**
 * CivicVision AI — GeoJSON Location Migration Script (Phase 3.1)
 *
 * Converts legacy { lat, lng } issue locations to canonical GeoJSON Point:
 *   { type: "Point", coordinates: [longitude, latitude] }
 *
 * Safety Guarantees:
 * 1. Default mode is DRY-RUN (read-only audit). No database modifications occur without `--commit`.
 * 2. Idempotent: Can be run multiple times safely. Documents already in GeoJSON format are detected and skipped.
 * 3. Non-destructive: Existing fields, timestamps, and issue identities are strictly preserved.
 * 4. Strict coordinate validation: Coordinates out of bounds (-180<=lng<=180, -90<=lat<=90) are NOT guessed or inverted; they are reported for operator inspection.
 * 5. Safe index creation: `2dsphere` index is created only after data consistency is established.
 */

const dns = require("dns");
try {
  // Use public DNS to resolve MongoDB Atlas SRV records when local/ISP DNS blocks SRV lookups
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch {
  // Fall back to system DNS
}
const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

/**
 * Validates whether coordinates represent a valid GeoJSON point on Earth.
 */
function isValidGeoJsonPoint(loc) {
  if (!loc || loc.type !== "Point" || !Array.isArray(loc.coordinates) || loc.coordinates.length !== 2) {
    return false;
  }
  const [lng, lat] = loc.coordinates;
  return (
    typeof lng === "number" &&
    !isNaN(lng) &&
    typeof lat === "number" &&
    !isNaN(lat) &&
    lng >= -180 &&
    lng <= 180 &&
    lat >= -90 &&
    lat <= 90
  );
}

/**
 * Validates whether legacy coordinates are valid numbers and within geographical bounds.
 */
function isValidLegacyLocation(loc) {
  if (!loc || loc.lat === undefined || loc.lng === undefined) {
    return false;
  }
  const lat = Number(loc.lat);
  const lng = Number(loc.lng);
  return (
    !isNaN(lat) &&
    !isNaN(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * Core migration function.
 * @param {object} db - Native MongoDB database instance or Mongoose connection db.
 * @param {object} options - Configuration options:
 *   - commit: boolean (if false, dry-run only)
 *   - createIndex: boolean (if true, creates 2dsphere index)
 *   - logger: function (custom logging handler, defaults to console.log)
 * @returns {Promise<object>} Migration report summary
 */
async function migrateIssues(db, options = {}) {
  const commit = !!options.commit;
  const shouldCreateIndex = !!options.createIndex;
  const log = options.logger || console.log;

  const collection = db.collection ? db.collection("issues") : db;

  const summary = {
    mode: commit ? "COMMIT" : "DRY-RUN",
    totalScanned: 0,
    alreadyGeoJson: 0,
    migrated: 0,
    wouldMigrate: 0,
    malformedSkipped: 0,
    missingSkipped: 0,
    errors: [],
    indexCreated: false
  };

  log(`\n=== CivicVision AI GeoJSON Migration (${summary.mode}) ===`);

  const cursor = collection.find({});
  const docs = await cursor.toArray();
  summary.totalScanned = docs.length;

  for (const doc of docs) {
    const loc = doc.location;

    // Case 1: Already canonical GeoJSON Point
    if (isValidGeoJsonPoint(loc)) {
      summary.alreadyGeoJson++;
      continue;
    }

    // Case 2: Legacy { lat, lng } format
    if (loc && loc.lat !== undefined && loc.lng !== undefined) {
      if (isValidLegacyLocation(loc)) {
        const lat = Number(loc.lat);
        const lng = Number(loc.lng);
        const canonicalLocation = {
          type: "Point",
          coordinates: [lng, lat]
        };

        if (commit) {
          await collection.updateOne(
            { _id: doc._id },
            { $set: { location: canonicalLocation } }
          );
          summary.migrated++;
        } else {
          summary.wouldMigrate++;
        }
      } else {
        summary.malformedSkipped++;
        summary.errors.push({
          issueId: doc._id.toString(),
          reason: "Coordinates out of bounds (-90<=lat<=90, -180<=lng<=180) or NaN",
          rawLocation: loc
        });
      }
      continue;
    }

    // Case 3: Missing, null, or corrupted location
    summary.missingSkipped++;
    summary.errors.push({
      issueId: doc._id.toString(),
      reason: "Missing, null, or unrecognized location structure",
      rawLocation: loc
    });
  }

  // Sequenced index creation
  if (shouldCreateIndex) {
    if (!commit) {
      log("Note: Skipping index creation in DRY-RUN mode. Use --commit --create-index to build index.");
    } else {
      try {
        log("Creating 2dsphere index on 'location' field...");
        await collection.createIndex({ location: "2dsphere" });
        const existingIndexes = await collection.indexes();
        const verified = existingIndexes.some(idx => idx.key && idx.key.location === "2dsphere");
        summary.indexCreated = verified;
        if (verified) {
          log("2dsphere index created and verified in collection catalog.");
        } else {
          log("Warning: 2dsphere index not found in collection catalog after creation attempt.");
        }
      } catch (indexErr) {
        summary.indexError = indexErr.message;
        log(`Failed to create 2dsphere index: ${indexErr.message}`);
      }
    }
  }

  log(`\n--- Migration Summary ---`);
  log(`Execution Mode   : ${summary.mode}`);
  log(`Total Records    : ${summary.totalScanned}`);
  log(`Already GeoJSON  : ${summary.alreadyGeoJson}`);
  log(`Converted        : ${commit ? summary.migrated : summary.wouldMigrate + " (simulated)"}`);
  log(`Malformed Skipped: ${summary.malformedSkipped}`);
  log(`Missing Skipped  : ${summary.missingSkipped}`);
  log(`Index Status     : ${summary.indexCreated ? "CREATED" : "NOT CREATED"}`);

  if (summary.errors.length > 0) {
    log(`\nIdentified ${summary.errors.length} problematic record(s):`);
    summary.errors.forEach(e => {
      log(` - ID: ${e.issueId} | Reason: ${e.reason} | Raw: ${JSON.stringify(e.rawLocation)}`);
    });
  }

  return summary;
}

// CLI runner
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const isCommit = args.includes("--commit");
    const isCreateIndex = args.includes("--create-index");
    const mongoUri = process.env.MONGO_URI;

    if (!mongoUri) {
      console.error("Error: MONGO_URI environment variable is required.");
      process.exit(1);
    }

    // Production safety check
    if (mongoUri.includes("mongodb.net") && isCommit && !args.includes("--force-production")) {
      console.error("Safety guard: Atlas/production URI detected. Direct migration requires --force-production.");
      console.error("To test migration safely, use a local disposable MongoDB or dry-run mode.");
      process.exit(1);
    }

    const masked = mongoUri.replace(/\/\/[^:]+:[^@]+@/, "//***:***@");
    console.log(`Connecting to database (${masked})...`);
    try {
      await mongoose.connect(mongoUri);
      await migrateIssues(mongoose.connection.db, {
        commit: isCommit,
        createIndex: isCreateIndex
      });
    } catch (err) {
      console.error("Migration execution failed:", err);
      process.exit(1);
    } finally {
      await mongoose.disconnect();
      console.log("Database disconnected.");
    }
  })();
}

module.exports = {
  migrateIssues,
  isValidGeoJsonPoint,
  isValidLegacyLocation
};
