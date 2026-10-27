/**
 * CivicVision AI — Manual Database Index Synchronization Script (Task 1.3)
 *
 * SAFETY GUARANTEES:
 * - This script is strictly MANUAL and is NEVER executed automatically on server startup.
 * - AutoIndex is kept disabled in production to protect against latency spikes and lockups.
 * - Safely verifies and creates compound and geospatial indexes on the Issue collection.
 * - Non-destructive: preserves existing indexes.
 *
 * Usage:
 *   node scripts/syncIndexes.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Issue = require("../models/Issue");

async function syncIssueIndexes() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error("❌ Error: MONGO_URI environment variable is not defined.");
    process.exit(1);
  }

  console.log("ℹ️ Connecting to database for manual index inspection...");
  try {
    await mongoose.connect(mongoUri);
    console.log("✅ Database connection established.");

    console.log("\n📋 Current existing indexes on 'issues' collection:");
    const existingIndexes = await Issue.collection.indexes();
    existingIndexes.forEach((idx) => {
      console.log(`   - ${idx.name}:`, JSON.stringify(idx.key));
    });

    console.log("\n🔨 Creating / verifying declared schema indexes (non-destructive)...");
    const result = await Issue.createIndexes();
    console.log("✅ Index creation completed:", result);

    console.log("\n📋 Updated active indexes on 'issues' collection:");
    const updatedIndexes = await Issue.collection.indexes();
    updatedIndexes.forEach((idx) => {
      console.log(`   - ${idx.name}:`, JSON.stringify(idx.key));
    });

    console.log("\n🎉 Index synchronization finished successfully.");
  } catch (err) {
    console.error("❌ Index synchronization failed:", err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log("🔌 Database connection closed.");
  }
}

if (require.main === module) {
  syncIssueIndexes();
}

module.exports = { syncIssueIndexes };
