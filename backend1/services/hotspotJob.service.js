/**
 * CivicVision AI — Hotspot Job Runner Service (Phase 4.2B-C)
 *
 * Implements a safe execution wrapper around `detectAndSyncHotspots` with:
 * 1. In-process mutex flag to prevent overlapping runs within the same Node process.
 * 2. Distributed lease-based lock via MongoDB `JobLock` model with expiration timeout
 *    to prevent deadlocks across multi-instance or clustered environments.
 * 3. Guaranteed lock release in `finally` blocks for exception safety.
 * 4. Structured summary reporting and failure isolation (failed runs never falsely resolve hotspots).
 */

const mongoose = require("mongoose");
const JobLock = require("../models/JobLock");
const { detectAndSyncHotspots } = require("./dbscan.service");

// Default configuration
const DEFAULT_LOCK_NAME = "hotspot_refresh";
const DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1000; // 5-minute lease

// In-process mutex state
let inProcessLocked = false;

/**
 * Attempts to acquire both in-process and distributed MongoDB locks.
 *
 * @param {string} [lockName=DEFAULT_LOCK_NAME]
 * @param {string} workerId
 * @param {number} [leaseDurationMs=DEFAULT_LEASE_DURATION_MS]
 * @returns {Promise<{ acquired: boolean, reason?: string }>}
 */
async function acquireHotspotLock(
  lockName = DEFAULT_LOCK_NAME,
  workerId,
  leaseDurationMs = DEFAULT_LEASE_DURATION_MS
) {
  // 1. In-process concurrency guard
  if (inProcessLocked) {
    return {
      acquired: false,
      reason: "in_process_lock_held"
    };
  }

  // Set in-process lock tentatively
  inProcessLocked = true;

  // 2. Multi-instance distributed lock via MongoDB (if connected)
  if (mongoose.connection.readyState === 1) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseDurationMs);

    try {
      const lockDoc = await JobLock.findOneAndUpdate(
        {
          lockName,
          $or: [
            { isLocked: false },
            { expiresAt: { $lt: now } },
            { expiresAt: null }
          ]
        },
        {
          $set: {
            isLocked: true,
            lockedAt: now,
            lockedBy: workerId,
            expiresAt: expiresAt
          }
        },
        {
          new: true,
          upsert: true
        }
      );

      if (!lockDoc) {
        // Failed to match available lock condition
        inProcessLocked = false;
        return {
          acquired: false,
          reason: "distributed_lock_held"
        };
      }
    } catch (err) {
      inProcessLocked = false;
      // E11000 duplicate key error occurs when another instance upserts concurrently
      if (err.code === 11000) {
        return {
          acquired: false,
          reason: "distributed_lock_held"
        };
      }
      throw err;
    }
  }

  return { acquired: true };
}

/**
 * Releases both in-process and distributed locks.
 *
 * @param {string} [lockName=DEFAULT_LOCK_NAME]
 * @param {string} workerId
 * @returns {Promise<void>}
 */
async function releaseHotspotLock(lockName = DEFAULT_LOCK_NAME, workerId) {
  try {
    if (mongoose.connection.readyState === 1) {
      await JobLock.findOneAndUpdate(
        {
          lockName,
          lockedBy: workerId
        },
        {
          $set: {
            isLocked: false,
            lockedAt: null,
            lockedBy: null,
            expiresAt: null
          }
        }
      );
    }
  } catch (err) {
    console.error(`[HotspotJob] Warning: Error releasing distributed lock: ${err.message}`);
  } finally {
    inProcessLocked = false;
  }
}

/**
 * Checks the current lock status without mutating state.
 *
 * @param {string} [lockName=DEFAULT_LOCK_NAME]
 * @returns {Promise<{ isLocked: boolean, inProcessLocked: boolean, lockedBy: string|null, expiresAt: Date|null }>}
 */
async function getHotspotJobLockStatus(lockName = DEFAULT_LOCK_NAME) {
  let isDistributedLocked = false;
  let lockedBy = null;
  let expiresAt = null;

  if (mongoose.connection.readyState === 1) {
    const lockDoc = await JobLock.findOne({ lockName });
    if (lockDoc && lockDoc.isLocked) {
      const now = new Date();
      if (!lockDoc.expiresAt || lockDoc.expiresAt > now) {
        isDistributedLocked = true;
        lockedBy = lockDoc.lockedBy;
        expiresAt = lockDoc.expiresAt;
      }
    }
  }

  return {
    isLocked: inProcessLocked || isDistributedLocked,
    inProcessLocked,
    isDistributedLocked,
    lockedBy,
    expiresAt
  };
}

/**
 * Safe Hotspot Job Execution Wrapper.
 *
 * Requirements:
 * - Enforces single-run execution model.
 * - Prevents overlapping runs within process and across instances.
 * - Always releases locks in a `finally` path.
 * - Failed runs fail cleanly and do NOT falsely mark hotspots resolved.
 * - Returns a concise summary of created, updated, resolving, and resolved hotspots.
 *
 * @param {object} [options={}]
 * @param {string} [options.workerId]
 * @param {number} [options.leaseDurationMs]
 * @param {string} [options.category]
 * @param {number} [options.epsMeters]
 * @param {number} [options.minSamples]
 * @param {number} [options.rollingWindowDays]
 * @param {Date} [options.now]
 * @returns {Promise<{ success: boolean, conflict?: boolean, reason?: string, message?: string, summary?: object, durationMs?: number }>}
 */
async function executeHotspotJob(options = {}) {
  const workerId =
    options.workerId ||
    `proc_${process.pid}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const leaseDurationMs = options.leaseDurationMs || DEFAULT_LEASE_DURATION_MS;
  const lockName = options.lockName || DEFAULT_LOCK_NAME;

  // 1. Acquire concurrency locks
  const lockResult = await acquireHotspotLock(lockName, workerId, leaseDurationMs);
  if (!lockResult.acquired) {
    return {
      success: false,
      conflict: true,
      reason: lockResult.reason,
      message: `Hotspot refresh job is currently running or locked (${lockResult.reason}).`
    };
  }

  const startTime = Date.now();

  try {
    // 2. Invoke DBSCAN detection & synchronization pipeline
    const syncResult = await detectAndSyncHotspots(options);
    const durationMs = Date.now() - startTime;

    return {
      success: true,
      conflict: false,
      summary: {
        createdCount: syncResult.createdCount,
        updatedCount: syncResult.updatedCount,
        resolvingCount: syncResult.resolvingCount,
        resolvedCount: syncResult.resolvedCount,
        processedCategories: syncResult.processedCategories,
        syncedHotspotCount: syncResult.syncedHotspotIds ? syncResult.syncedHotspotIds.length : 0
      },
      durationMs
    };
  } catch (err) {
    // Failure isolation: log and rethrow; existing hotspots remain untouched (no false resolution)
    console.error(`[HotspotJob] Refresh job failed with error: ${err.message}`);
    throw err;
  } finally {
    // 3. Guaranteed lock release
    await releaseHotspotLock(lockName, workerId);
  }
}

module.exports = {
  DEFAULT_LOCK_NAME,
  DEFAULT_LEASE_DURATION_MS,
  acquireHotspotLock,
  releaseHotspotLock,
  getHotspotJobLockStatus,
  executeHotspotJob
};
