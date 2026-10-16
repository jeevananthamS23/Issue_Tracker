const mongoose = require("mongoose");

/**
 * Normalizer setter for the Issue location field.
 * Handles:
 * - Legacy format: { lat: 11.34, lng: 77.72 } -> converts to GeoJSON Point [lng, lat]
 * - GeoJSON format: { type: "Point", coordinates: [lng, lat] }
 * - Array format: [lng, lat]
 */
function normalizeLocation(val) {
  if (!val) return val;

  // Case 1: Legacy format { lat, lng }
  if (typeof val === "object" && val.lat !== undefined && val.lng !== undefined) {
    const lat = Number(val.lat);
    const lng = Number(val.lng);
    return {
      type: "Point",
      coordinates: [lng, lat]
    };
  }

  // Case 2: Array [lng, lat]
  if (Array.isArray(val) && val.length === 2) {
    return {
      type: "Point",
      coordinates: [Number(val[0]), Number(val[1])]
    };
  }

  // Case 3: Standard GeoJSON { type: 'Point', coordinates: [lng, lat] }
  if (typeof val === "object" && val.type === "Point" && Array.isArray(val.coordinates)) {
    return {
      type: "Point",
      coordinates: [Number(val.coordinates[0]), Number(val.coordinates[1])]
    };
  }

  return val;
}

/**
 * GeoJSON 2D Point sub-schema adhering to RFC 7946 and MongoDB geospatial standards.
 * Coordinates are canonically stored as [longitude, latitude].
 */
const pointSchema = new mongoose.Schema(
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

// Post-init hook: if loaded from legacy database document with raw { lat, lng } in MongoDB
pointSchema.post("init", function () {
  if (
    (!this.coordinates || this.coordinates.length < 2) &&
    this._doc &&
    this._doc.lat !== undefined &&
    this._doc.lng !== undefined
  ) {
    const lng = Number(this._doc.lng);
    const lat = Number(this._doc.lat);
    if (!isNaN(lng) && !isNaN(lat)) {
      this.coordinates = [lng, lat];
    }
  }
});

// Virtual getter and setter for backward-compatible `location.lng`
pointSchema.virtual("lng")
  .get(function () {
    if (this.coordinates && this.coordinates.length >= 2) {
      return this.coordinates[0];
    }
    if (this._doc && this._doc.lng !== undefined) {
      return Number(this._doc.lng);
    }
    return undefined;
  })
  .set(function (val) {
    if (!this.coordinates) this.coordinates = [0, 0];
    this.coordinates[0] = Number(val);
  });

// Virtual getter and setter for backward-compatible `location.lat`
pointSchema.virtual("lat")
  .get(function () {
    if (this.coordinates && this.coordinates.length >= 2) {
      return this.coordinates[1];
    }
    if (this._doc && this._doc.lat !== undefined) {
      return Number(this._doc.lat);
    }
    return undefined;
  })
  .set(function (val) {
    if (!this.coordinates) this.coordinates = [0, 0];
    this.coordinates[1] = Number(val);
  });

const issueSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, required: true },
    description: { type: String, required: true },
    imageUrl: { type: String }, // URL for uploaded image
    department: { type: String },
    internalNotes: { type: String }, // Admin-only confidential internal notes
    location: {
      type: pointSchema,
      required: true,
      set: normalizeLocation
    },
    status: {
      type: String,
      enum: ["reported", "in-progress", "resolved"],
      default: "reported"
    },
    votes: { type: Number, default: 0 },
    // AI-derived fields (Research Paper Table 1: CLIP embedding & duplicate suppression)
    embedding: {
      type: [Number],
      select: false // Excluded from default queries to avoid payload overhead
    },
    embeddingModel: {
      type: String,
      select: false // Truthful embedding engine/model metadata (e.g., openai/clip-vit-base-patch32 or deterministic_engine_v1)
    },
    duplicateStatus: {
      type: String,
      enum: ["unique", "flagged_duplicate", "suspected_duplicate", "unverified"],
      default: "unique"
    },
    duplicateOf: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Issue"
    },
    similarityScore: {
      type: Number
    },
    needsDuplicateReview: {
      type: Boolean,
      default: false
    },
    needsClassificationReview: {
      type: Boolean,
      default: false
    },
    classificationReviewResolution: {
      type: String,
      enum: ["none", "confirmed_category", "reclassified"],
      default: "none"
    },
    needsReview: {
      type: Boolean,
      default: false
    },
    severity: {
      type: Number,
      min: 1,
      max: 10
    },
    classificationConfidence: {
      type: Number,
      min: 0,
      max: 1,
      select: false // Admin/internal only: excluded from public queries and citizen responses
    },
    aiDiagnostic: {
      type: new mongoose.Schema(
        {
          serviceStatus: { type: String },
          message: { type: String },
          model: { type: String },
          classificationStatus: { type: String },
          classificationModel: { type: String }
        },
        { _id: false }
      ),
      select: false // Admin/internal only: excluded from public queries and citizen responses
    },
    // Administrative duplicate review & resolution audit fields (Phase 3.4A)
    reviewResolution: {
      type: String,
      enum: ["none", "confirmed_duplicate", "dismissed_unique"],
      default: "none"
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin"
    },
    reviewedAt: {
      type: Date
    },
    reviewNotes: {
      type: String
    },
    // Hotspot cluster linkage (Phase 4.2B)
    clusterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hotspot",
      default: null,
      index: true
    }
  },
  {
    autoIndex: false, // Prevent unsequenced index builds on unmigrated collections
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// Virtual getter and setter for backward-compatible cluster_id
issueSchema.virtual("cluster_id")
  .get(function () {
    return this.clusterId;
  })
  .set(function (val) {
    this.clusterId = val;
  });

// Pre-save hook: derive consolidated needsReview from outstanding review reasons
issueSchema.pre("save", function (next) {
  if (this.isModified("needsDuplicateReview") || this.isModified("needsClassificationReview")) {
    this.needsReview = Boolean(this.needsDuplicateReview || this.needsClassificationReview);
  }
  next();
});

// Geospatial 2dsphere index for spherical geometry queries ($near, $geoWithin, DBSCAN clustering)
issueSchema.index({ location: "2dsphere" });

module.exports = mongoose.model("Issue", issueSchema);
