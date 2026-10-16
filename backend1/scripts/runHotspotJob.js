#!/usr/bin/env node

/**
 * CivicVision AI — Hotspot Refresh CLI Job Runner (Phase 4.2B-C)
 *
 * Standalone CLI entry point for executing the DBSCAN hotspot refresh job.
 * Enforces single-run execution with in-process and distributed concurrency guards.
 *
 * Usage:
 *   node scripts/runHotspotJob.js
 *   node scripts/runHotspotJob.js --category=pothole
 *
 * Exit codes:
 *   0: Successful completion
 *   1: Unhandled failure or fatal error
 *   2: Skipped due to active lock (concurrency conflict)
 */

require("dotenv").config();
const mongoose = require("mongoose");
const { executeHotspotJob } = require("../services/hotspotJob.service");

// Strict Atlas protection: prevent accidental connection to Atlas during local test runs
if (
  process.env.NODE_ENV !== "production" &&
  process.env.MONGO_URI &&
  (process.env.MONGO_URI.includes("mongodb+srv") || process.env.MONGO_URI.includes("mongodb.net"))
) {
  console.warn("[HotspotJob] Warning: Atlas MONGO_URI detected in non-production. Falling back to local MongoDB.");
  process.env.MONGO_URI = "mongodb://127.0.0.1:27017/civicvision_test_hotspot_disposable";
}

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/civicvision_test_hotspot_disposable";

// Parse optional CLI arguments
const args = process.argv.slice(2);
const options = {};

for (const arg of args) {
  if (arg.startsWith("--category=")) {
    options.category = arg.split("=")[1];
  } else if (arg.startsWith("--eps=")) {
    options.epsMeters = Number(arg.split("=")[1]);
  } else if (arg.startsWith("--min-samples=")) {
    options.minSamples = parseInt(arg.split("=")[1], 10);
  }
}

async function main() {
  console.log("================================================================================");
  console.log("CivicVision AI — Hotspot Refresh Job Runner");
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log("================================================================================\n");

  try {
    if (mongoose.connection.readyState !== 1) {
      console.log(`[HotspotJob] Connecting to database: ${MONGO_URI}...`);
      await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
      console.log("[HotspotJob] Database connected successfully.\n");
    }

    console.log("[HotspotJob] Attempting to acquire lock and execute hotspot refresh...");
    const result = await executeHotspotJob(options);

    if (!result.success && result.conflict) {
      console.warn(`[HotspotJob] SKIPPED: ${result.message}`);
      process.exitCode = 2;
      return;
    }

    console.log(`[HotspotJob] Execution completed in ${result.durationMs}ms:`);
    console.log(`  - Created Hotspots:   ${result.summary.createdCount}`);
    console.log(`  - Updated Hotspots:   ${result.summary.updatedCount}`);
    console.log(`  - Resolving Hotspots: ${result.summary.resolvingCount}`);
    console.log(`  - Resolved Hotspots:  ${result.summary.resolvedCount}`);
    console.log(`  - Categories Processed: ${result.summary.processedCategories.join(", ")}\n`);
    console.log("[HotspotJob] Finished successfully.");
    process.exitCode = 0;
  } catch (err) {
    console.error(`[HotspotJob] FATAL: Job execution failed: ${err.message}`);
    if (err.stack) {
      console.error(err.stack);
    }
    process.exitCode = 1;
  } finally {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
      console.log("[HotspotJob] Database connection closed.");
    }
  }
}

// Execute if run directly as CLI
if (require.main === module) {
  main().then(() => {
    process.exit(process.exitCode || 0);
  });
}

module.exports = { main };
