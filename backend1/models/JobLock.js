/**
 * CivicVision AI — JobLock Model (Phase 4.2B-C)
 *
 * Mongoose model for distributed lease-based job locking.
 * Uses atomic MongoDB operations with lease expiration to prevent deadlocks
 * during multi-instance background job execution.
 */

const mongoose = require("mongoose");

const jobLockSchema = new mongoose.Schema(
  {
    lockName: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    isLocked: {
      type: Boolean,
      default: false
    },
    lockedAt: {
      type: Date,
      default: null
    },
    lockedBy: {
      type: String,
      default: null
    },
    expiresAt: {
      type: Date,
      default: null,
      index: true
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model("JobLock", jobLockSchema);
