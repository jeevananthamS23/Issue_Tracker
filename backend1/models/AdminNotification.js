/**
 * CivicVision AI — Admin Notification Model (Phase 4.2C-A)
 *
 * Mongoose model for persistent administrative in-app notifications
 * and email dispatch bookkeeping for DBSCAN hotspot alerts.
 *
 * Requirements:
 * - Type: 'hotspot_detected' or 'hotspot_escalated'
 * - Reference to Hotspot document
 * - Stable event-specific deduplication key (dedupeKey) with unique index
 * - Read state tracking (readAt nullable timestamp)
 * - Email delivery status: 'pending', 'sent', 'failed', 'unconfigured'
 * - Email attempt count, last attempt timestamp, sanitized error
 * - Zero storage of credentials, passwords, JWTs, embeddings, or AI diagnostics
 * - Never auto-delete notifications
 */

const mongoose = require("mongoose");

const adminNotificationSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      enum: ["hotspot_detected", "hotspot_escalated"],
      index: true
    },
    hotspotId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hotspot",
      required: true,
      index: true
    },
    title: {
      type: String,
      required: true,
      trim: true
    },
    message: {
      type: String,
      required: true,
      trim: true
    },
    severity: {
      type: Number,
      min: 1,
      max: 10,
      default: null
    },
    dedupeKey: {
      type: String,
      required: true,
      unique: true,
      trim: true
    },
    readAt: {
      type: Date,
      default: null,
      index: true
    },
    emailStatus: {
      type: String,
      enum: ["pending", "sent", "failed", "unconfigured"],
      default: "pending",
      index: true
    },
    emailSentAt: {
      type: Date,
      default: null
    },
    emailAttemptCount: {
      type: Number,
      default: 0,
      min: 0
    },
    emailLastAttemptAt: {
      type: Date,
      default: null
    },
    emailLastError: {
      type: String,
      default: null,
      maxlength: 1000
    }
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// Compound indexes for administrative querying, unread counts, and filtering
adminNotificationSchema.index({ readAt: 1, createdAt: -1 });
adminNotificationSchema.index({ type: 1, createdAt: -1 });
adminNotificationSchema.index({ emailStatus: 1, createdAt: -1 });

module.exports = mongoose.model("AdminNotification", adminNotificationSchema);
