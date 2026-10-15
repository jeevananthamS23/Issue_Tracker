const Issue = require("../models/Issue");
const {
  findNearbyIssues,
  retrieveSpatialDuplicateCandidates
} = require("../services/spatial.service");
const { assessIssueDuplicates } = require("../services/ai.service");

exports.getAllIssues = async (req, res) => {
  try {
    const issues = await Issue.find().select("-internalNotes").sort({ createdAt: -1 });
    res.status(200).json(issues);
  } catch (err) {
    res.status(500).json({ error: true, message: "Failed to fetch issues" });
  }
};

exports.getUserIssues = async (req, res) => {
  try {
    const issues = await Issue.find({ userId: req.user.userId }).select("-internalNotes");
    res.status(200).json(issues);
  } catch (err) {
    res.status(500).json({ error: true, message: "Failed to fetch user issues" });
  }
};

exports.reportIssue = async (req, res) => {
  try {
    const { type, description } = req.body;

    if (!type || !description) {
      return res.status(400).json({ message: "Type and description are required" });
    }

    // Resolve location from either top-level lat/lng, location object, or GeoJSON coordinates
    let locationInput = req.body.location;
    let lat = req.body.lat !== undefined ? Number(req.body.lat) : undefined;
    let lng = req.body.lng !== undefined ? Number(req.body.lng) : undefined;

    if (locationInput) {
      if (typeof locationInput === "string") {
        try {
          locationInput = JSON.parse(locationInput);
        } catch {
          // Keep as string if parsing fails
        }
      }

      if (typeof locationInput === "object" && locationInput !== null) {
        if (locationInput.lat !== undefined && locationInput.lng !== undefined) {
          lat = Number(locationInput.lat);
          lng = Number(locationInput.lng);
        } else if (Array.isArray(locationInput.coordinates) && locationInput.coordinates.length === 2) {
          lng = Number(locationInput.coordinates[0]);
          lat = Number(locationInput.coordinates[1]);
        }
      }
    }

    // Validate that coordinates were provided
    if (lat === undefined || lng === undefined || isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ message: "Valid latitude and longitude coordinates are required" });
    }

    // Validate coordinate range: longitude in [-180, 180], latitude in [-90, 90]
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({
        message: "Invalid coordinates range. Latitude must be between -90 and 90, and longitude between -180 and 180."
      });
    }

    const imageUrl = req.file ? req.file.path : null;

    // Two-Stage Duplicate Suppression Assessment (Research Paper Section VI-C)
    // Stage 1 (Geospatial shortlist) + Stage 2 (CLIP embedding comparison)
    let duplicateAssessment = {
      duplicateStatus: "unique",
      needsReview: false,
      similarityScore: 0.0
    };

    try {
      duplicateAssessment = await assessIssueDuplicates({
        lat,
        lng,
        type,
        imageUrl
      });
    } catch (assessErr) {
      // Soft failure guarantee: AI layer never blocks issue creation
      duplicateAssessment = {
        duplicateStatus: "unverified",
        needsReview: true,
        similarityScore: 0.0,
        aiDiagnostic: { serviceStatus: "assessment_exception", message: assessErr.message }
      };
    }

    const newIssue = new Issue({
      userId: req.user.userId,
      type,
      description,
      imageUrl,
      location: {
        type: "Point",
        coordinates: [lng, lat]
      },
      embedding: duplicateAssessment.embedding,
      embeddingModel: duplicateAssessment.embeddingModel,
      duplicateStatus: duplicateAssessment.duplicateStatus,
      duplicateOf: duplicateAssessment.duplicateOf,
      similarityScore: duplicateAssessment.similarityScore,
      needsReview: duplicateAssessment.needsReview,
      aiDiagnostic: duplicateAssessment.aiDiagnostic
    });

    await newIssue.save();

    // Prepare response without leaking internalNotes, embedding, or embeddingModel
    const responseIssue = newIssue.toJSON();
    delete responseIssue.internalNotes;
    delete responseIssue.embedding;
    delete responseIssue.embeddingModel;

    res.status(201).json({
      message: "Issue reported successfully",
      issue: responseIssue,
      duplicateCheck: {
        status: duplicateAssessment.duplicateStatus,
        similarityScore: duplicateAssessment.similarityScore,
        needsReview: duplicateAssessment.needsReview
      }
    });
  } catch (err) {
    if (err.name === "ValidationError") {
      return res.status(400).json({ message: err.message });
    }
    console.error("reportIssue error:", err);
    res.status(500).json({ message: "Failed to report issue" });
  }
};

/**
 * Spatial proximity query endpoint:
 * Finds nearby issues around [lng, lat] with category, status, and radius filtering.
 * Strictly strips confidential `internalNotes` from all output.
 */
exports.getNearbyIssues = async (req, res) => {
  try {
    const lat = req.query.lat !== undefined ? Number(req.query.lat) : undefined;
    const lng = req.query.lng !== undefined ? Number(req.query.lng) : undefined;
    const radiusMeters = req.query.radius || req.query.radiusMeters || 500;
    const type = req.query.type || req.query.category;
    const status = req.query.status;
    const limit = req.query.limit;

    const issues = await findNearbyIssues({
      lat,
      lng,
      radiusMeters,
      type,
      status,
      limit
    });

    res.status(200).json(issues);
  } catch (err) {
    const isValidationError =
      err.message.includes("Latitude") ||
      err.message.includes("Longitude") ||
      err.message.includes("numerical") ||
      err.message.includes("radius") ||
      err.message.includes("positive number");

    if (isValidationError) {
      return res.status(400).json({ error: true, message: err.message });
    }

    console.error("getNearbyIssues error:", err);
    res.status(500).json({ error: true, message: "Failed to perform spatial proximity query" });
  }
};

/**
 * Spatial duplicate candidate retrieval endpoint (Stage 1 of Duplicate Suppression):
 * Shortlists nearby open issues of the same defect category within a search radius (default 50m).
 * Prepares bounded candidate sets for the Stage 2 image similarity comparison.
 */
exports.getDuplicateCandidates = async (req, res) => {
  try {
    const lat = req.query.lat !== undefined ? Number(req.query.lat) : undefined;
    const lng = req.query.lng !== undefined ? Number(req.query.lng) : undefined;
    const type = req.query.type || req.query.category;
    const radiusMeters = req.query.radius || req.query.radiusMeters || 50;
    const excludeIssueId = req.query.excludeIssueId;
    const limit = req.query.limit || 10;

    const candidates = await retrieveSpatialDuplicateCandidates({
      lat,
      lng,
      type,
      radiusMeters,
      excludeIssueId,
      limit
    });

    const sanitizedCandidates = candidates.map(cand => {
      const copy = { ...cand };
      delete copy.embedding;
      delete copy.embeddingModel;
      delete copy.internalNotes;
      return copy;
    });

    res.status(200).json({
      count: sanitizedCandidates.length,
      thresholdMeters: Number(radiusMeters) || 50,
      candidates: sanitizedCandidates
    });
  } catch (err) {
    const isValidationError =
      err.message.includes("Latitude") ||
      err.message.includes("Longitude") ||
      err.message.includes("numerical") ||
      err.message.includes("Defect type") ||
      err.message.includes("radius") ||
      err.message.includes("positive number");

    if (isValidationError) {
      return res.status(400).json({ error: true, message: err.message });
    }

    console.error("getDuplicateCandidates error:", err);
    res.status(500).json({ error: true, message: "Failed to retrieve duplicate candidates" });
  }
};
