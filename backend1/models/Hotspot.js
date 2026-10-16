/**
 * CivicVision AI — Hotspot Model (Phase 4.2B-B)
 *
 * Mongoose model for spatial civic defect clusters detected via DBSCAN.
 * Adheres to RFC 7946 GeoJSON Point standard for centroid storage [longitude, latitude]
 * with a 2dsphere index for spatial queries.
 *
 * Scope A Specifications:
 * - Canonical category and department
 * - GeoJSON Point centroid with [longitude, latitude]
 * - Distinct defect count, total citizen report count, total votes, mean heuristic severity
 * - Constituent issue references (issueIds)
 * - Status: active, escalating, resolving, resolved, dismissed
 * - First and last detection timestamps
 * - Alert deduplication metadata
 * - Internal administrative notes
 */

const mongoose = require("mongoose");
const { CANONICAL_CATEGORIES, CANONICAL_DEPARTMENTS } = require("../services/routing.service");

/**
 * GeoJSON 2D Point sub-schema for Hotspot centroid.
 * Follows identical RFC 7946 standards as Issue.js location.
 */
const centroidSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["Point"],
      default: "Point",
      required: true
    },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: function (coords) {
          if (!Array.isArray(coords) || coords.length !== 2) return false;
          const [lng, lat] = coords;
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
        },
        message: props =>
          `Invalid GeoJSON coordinates [${props.value}]. Longitude must be between -180 and 180, and latitude between -90 and 90.`
      }
    }
  },
  {
    _id: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// Virtual getter and setter for centroid.lng
centroidSchema.virtual("lng")
  .get(function () {
    if (this.coordinates && this.coordinates.length >= 2) {
      return this.coordinates[0];
    }
    return undefined;
  })
  .set(function (val) {
    if (!this.coordinates) this.coordinates = [0, 0];
    this.coordinates[0] = Number(val);
  });

// Virtual getter and setter for centroid.lat
centroidSchema.virtual("lat")
  .get(function () {
    if (this.coordinates && this.coordinates.length >= 2) {
      return this.coordinates[1];
    }
    return undefined;
  })
  .set(function (val) {
    if (!this.coordinates) this.coordinates = [0, 0];
    this.coordinates[1] = Number(val);
  });

const hotspotSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      trim: true
    },
    category: {
      type: String,
      required: true,
      enum: CANONICAL_CATEGORIES,
      index: true
    },
    department: {
      type: String,
      required: true
    },
    centroid: {
      type: centroidSchema,
      required: true
    },
    radiusMeters: {
      type: Number,
      default: 0,
      min: 0
    },
    // Metrics
    distinctDefectCount: {
      type: Number,
      required: true,
      min: 1,
      default: 1
    },
    totalReportCount: {
      type: Number,
      required: true,
      min: 1,
      default: 1
    },
    totalVotes: {
      type: Number,
      default: 0,
      min: 0
    },
    meanSeverity: {
      type: Number,
      min: 1,
      max: 10,
      default: null
    },
    // Constituent issue references
    issueIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Issue",
        required: true
      }
    ],
    // Hotspot lifecycle status
    status: {
      type: String,
      enum: ["active", "escalating", "resolving", "resolved", "dismissed"],
      default: "active",
      index: true
    },
    // Detection timestamps
    firstDetectedAt: {
      type: Date,
      default: Date.now,
      required: true
    },
    lastDetectedAt: {
      type: Date,
      default: Date.now,
      required: true
    },
    // Alert deduplication bookkeeping (Scope F)
    alertSent: {
      type: Boolean,
      default: false
    },
    alertSentAt: {
      type: Date,
      default: null
    },
    escalatedAlertSentAt: {
      type: Date,
      default: null
    },
    lastAlertIssueCount: {
      type: Number,
      default: 0
    },
    lastAlertDefectCount: {
      type: Number,
      default: 0
    },
    // Admin internal notes
    internalNotes: {
      type: String,
      default: ""
    }
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// 2dsphere index for spherical proximity and geographic queries on centroid
hotspotSchema.index({ centroid: "2dsphere" });

// Compound indexes for administrative querying and refresh lookups
hotspotSchema.index({ category: 1, status: 1 });
hotspotSchema.index({ status: 1, lastDetectedAt: -1 });

module.exports = mongoose.model("Hotspot", hotspotSchema);
