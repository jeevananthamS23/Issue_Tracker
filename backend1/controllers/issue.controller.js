const Issue = require("../models/Issue");
const {
  findNearbyIssues,
  retrieveSpatialDuplicateCandidates
} = require("../services/spatial.service");
const { assessIssueDuplicates, classifyIssueImage, extractOcrGpsFromBuffer } = require("../services/ai.service");
const { resolveIssueRouting, getDepartmentForCategory } = require("../services/routing.service");
const { validateImageSignature } = require("../middleware/multer");

const {
  parsePaginationParams,
  buildPaginationResponse,
  setPaginationHeaders
} = require("../utils/pagination");

exports.getAllIssues = async (req, res) => {
  try {
    const { page, limit, skip, isPaginated } = parsePaginationParams(req.query);
    const query = Issue.find().select("-internalNotes -aiDiagnostic -locationMetadata").sort({ createdAt: -1 });

    if (isPaginated) {
      const [issues, total] = await Promise.all([
        query.skip(skip).limit(limit),
        Issue.countDocuments()
      ]);
      const totalPages = Math.ceil(total / limit) || (total === 0 ? 0 : 1);
      setPaginationHeaders(res, total, page, limit, totalPages);
      return res.status(200).json(buildPaginationResponse(issues, total, page, limit));
    }

    const issues = await query;
    setPaginationHeaders(res, issues.length, 1, issues.length || 1, 1);
    res.status(200).json(issues);
  } catch (err) {
    res.status(500).json({ error: true, message: "Failed to fetch issues" });
  }
};

exports.getUserIssues = async (req, res) => {
  try {
    const { page, limit, skip, isPaginated } = parsePaginationParams(req.query);
    const filter = { userId: req.user.userId };
    const query = Issue.find(filter).select("-internalNotes -aiDiagnostic -locationMetadata").sort({ createdAt: -1 });

    if (isPaginated) {
      const [issues, total] = await Promise.all([
        query.skip(skip).limit(limit),
        Issue.countDocuments(filter)
      ]);
      const totalPages = Math.ceil(total / limit) || (total === 0 ? 0 : 1);
      setPaginationHeaders(res, total, page, limit, totalPages);
      return res.status(200).json(buildPaginationResponse(issues, total, page, limit));
    }

    const issues = await query;
    setPaginationHeaders(res, issues.length, 1, issues.length || 1, 1);
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

    // Validate that coordinates were provided as finite numbers
    if (lat === undefined || lng === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ message: "Valid latitude and longitude coordinates are required" });
    }

    // Validate coordinate range: longitude in [-180, 180], latitude in [-90, 90]
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({
        message: "Invalid coordinates range. Latitude must be between -90 and 90, and longitude between -180 and 180."
      });
    }

    // Validate geoSource (Phase F5-C)
    const ALLOWED_GEO_SOURCES = ["exif", "ocr", "device", "manual"];
    let geoSource = req.body.geoSource;

    if (geoSource !== undefined && geoSource !== null && String(geoSource).trim() !== "") {
      const normalizedSource = typeof geoSource === "string" ? geoSource.trim().toLowerCase() : "";
      if (!ALLOWED_GEO_SOURCES.includes(normalizedSource)) {
        return res.status(400).json({
          message: `Invalid geoSource '${geoSource}'. Allowed values: ${ALLOWED_GEO_SOURCES.join(", ")}.`
        });
      }
      geoSource = normalizedSource;
    } else {
      // Backward-compatible default for older callers omitting geoSource
      // Only applied because caller's location was explicitly supplied and validated above
      geoSource = "manual";
    }

    // Sanitize optional location audit metadata if supplied (never trusted for authoritative location)
    let sanitizedLocationMetadata = undefined;
    let rawLocationMetadata = req.body.locationMetadata;
    if (rawLocationMetadata) {
      if (typeof rawLocationMetadata === "string") {
        try {
          rawLocationMetadata = JSON.parse(rawLocationMetadata);
        } catch {
          rawLocationMetadata = null;
        }
      }

      if (typeof rawLocationMetadata === "object" && rawLocationMetadata !== null) {
        sanitizedLocationMetadata = {};

        // exifCoordinates: validate canonical [lng, lat]
        if (rawLocationMetadata.exifCoordinates) {
          let exif = rawLocationMetadata.exifCoordinates;
          if (Array.isArray(exif) && exif.length === 2) {
            const eLng = Number(exif[0]);
            const eLat = Number(exif[1]);
            if (Number.isFinite(eLng) && Number.isFinite(eLat) && eLng >= -180 && eLng <= 180 && eLat >= -90 && eLat <= 90) {
              sanitizedLocationMetadata.exifCoordinates = [eLng, eLat];
            }
          }
        }

        // ocrCoordinates: validate canonical [lng, lat]
        if (rawLocationMetadata.ocrCoordinates) {
          let ocr = rawLocationMetadata.ocrCoordinates;
          if (Array.isArray(ocr) && ocr.length === 2) {
            const oLng = Number(ocr[0]);
            const oLat = Number(ocr[1]);
            if (Number.isFinite(oLng) && Number.isFinite(oLat) && oLng >= -180 && oLng <= 180 && oLat >= -90 && oLat <= 90) {
              sanitizedLocationMetadata.ocrCoordinates = [oLng, oLat];
            }
          }
        }

        // ocrConfidence: bounded [0, 1]
        if (rawLocationMetadata.ocrConfidence !== undefined && rawLocationMetadata.ocrConfidence !== null) {
          const conf = Number(rawLocationMetadata.ocrConfidence);
          if (Number.isFinite(conf) && conf >= 0 && conf <= 1) {
            sanitizedLocationMetadata.ocrConfidence = Math.round(conf * 1000) / 1000;
          }
        }

        // discrepancyMeters: bounded >= 0
        if (rawLocationMetadata.discrepancyMeters !== undefined && rawLocationMetadata.discrepancyMeters !== null) {
          const disc = Number(rawLocationMetadata.discrepancyMeters);
          if (Number.isFinite(disc) && disc >= 0) {
            sanitizedLocationMetadata.discrepancyMeters = Math.round(disc * 10) / 10;
          }
        }

        // rawOcrText: bounded, sanitized string
        if (typeof rawLocationMetadata.rawOcrText === "string" && rawLocationMetadata.rawOcrText.trim()) {
          sanitizedLocationMetadata.rawOcrText = rawLocationMetadata.rawOcrText
            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
            .trim()
            .slice(0, 500);
        }

        // geoReviewedAt
        if (rawLocationMetadata.geoReviewedAt) {
          const parsedDate = new Date(rawLocationMetadata.geoReviewedAt);
          if (!isNaN(parsedDate.getTime())) {
            sanitizedLocationMetadata.geoReviewedAt = parsedDate;
          }
        }

        // If no valid fields were populated, discard empty object
        if (Object.keys(sanitizedLocationMetadata).length === 0) {
          sanitizedLocationMetadata = undefined;
        }
      }
    }

    const imageUrl = req.file ? req.file.path : (req.body?.imageUrl || null);

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

    // AI Classification & Severity Estimation (Phase 4.1B)
    let classificationResult = null;
    if (imageUrl) {
      try {
        const classRes = await classifyIssueImage(imageUrl, {
          candidateCategory: type,
          timeoutMs: 2500
        });
        if (classRes && classRes.success) {
          classificationResult = classRes;
        } else {
          classificationResult = {
            status: "unavailable",
            error: classRes ? classRes.error : "Classification returned empty"
          };
        }
      } catch (classErr) {
        classificationResult = {
          status: "exception",
          error: classErr.message
        };
      }
    }

    // Deterministic Municipal Routing
    const routingDecision = resolveIssueRouting({
      citizenCategory: type,
      aiResult: classificationResult
    });

    const assignedDepartment = routingDecision.department;

    // Preserve all review flags: If AI inference failed on an uploaded image, set manual review requirement
    const aiInferenceFailed = Boolean(
      imageUrl && (
        !classificationResult ||
        classificationResult.status === "exception" ||
        classificationResult.status === "error" ||
        Boolean(classificationResult.error)
      )
    );

    const finalNeedsReview = Boolean(
      duplicateAssessment.needsReview ||
      routingDecision.classificationNeedsReview ||
      aiInferenceFailed
    );

    const combinedAiDiagnostic = {
      serviceStatus: duplicateAssessment.aiDiagnostic?.serviceStatus || "ok",
      message: duplicateAssessment.aiDiagnostic?.message,
      model: duplicateAssessment.embeddingModel,
      classificationStatus: classificationResult?.status || "unavailable",
      classificationModel: classificationResult?.model || "none"
    };

    const newIssue = new Issue({
      userId: req.user.userId,
      type,
      description,
      imageUrl,
      department: assignedDepartment,
      severity: classificationResult?.severity || null,
      classificationConfidence: classificationResult?.confidence || null,
      location: {
        type: "Point",
        coordinates: [lng, lat]
      },
      geoSource,
      locationMetadata: sanitizedLocationMetadata,
      embedding: duplicateAssessment.embedding,
      embeddingModel: duplicateAssessment.embeddingModel,
      duplicateStatus: duplicateAssessment.duplicateStatus,
      duplicateOf: duplicateAssessment.duplicateOf,
      similarityScore: duplicateAssessment.similarityScore,
      needsDuplicateReview: Boolean(duplicateAssessment.needsReview),
      needsClassificationReview: Boolean(routingDecision.classificationNeedsReview || aiInferenceFailed),
      needsReview: finalNeedsReview,
      needsManualReview: finalNeedsReview,
      aiDiagnostic: combinedAiDiagnostic
    });

    await newIssue.save();

    // Prepare response without leaking internalNotes, embedding, embeddingModel, aiDiagnostic, classificationConfidence, or locationMetadata
    const responseIssue = newIssue.toJSON();
    delete responseIssue.internalNotes;
    delete responseIssue.embedding;
    delete responseIssue.embeddingModel;
    delete responseIssue.aiDiagnostic;
    delete responseIssue.classificationConfidence;
    delete responseIssue.locationMetadata;
    responseIssue.needsManualReview = Boolean(responseIssue.needsReview);

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
      delete copy.aiDiagnostic;
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

/**
 * Protected citizen endpoint to extract GPS coordinates from an uploaded photo buffer.
 *
 * Privacy & Security Controls:
 * 1. Requires valid citizen JWT authentication.
 * 2. Rate-limited by ocrRateLimiter.
 * 3. Validates file presence, size (5MB), and genuine binary magic bytes (JPEG, PNG, WebP).
 * 4. Operates strictly on in-memory buffer without creating permanent Cloudinary assets or Issues.
 * 5. Returns structured GPS coordinates or safe failure message without leaking internal URLs or keys.
 */
exports.extractOcrCoordinates = async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: true, success: false, message: "No image file uploaded" });
    }

    const detectedMime = validateImageSignature(req.file.buffer);
    if (!detectedMime) {
      return res.status(400).json({
        error: true,
        success: false,
        message: "Invalid image content. File binary signature does not match JPEG, PNG, or WebP."
      });
    }

    const result = await extractOcrGpsFromBuffer(req.file.buffer, {
      mimetype: req.file.mimetype || detectedMime,
      filename: req.file.originalname || "upload.jpg",
      timeoutMs: 2500
    });

    if (!result.success) {
      // Safe non-blocking degradation: return 200 with found=false and error explanation
      return res.status(200).json({
        success: false,
        found: false,
        latitude: null,
        longitude: null,
        confidence: null,
        format: null,
        message: result.error || "OCR extraction is currently unavailable. Please place your pin manually."
      });
    }

    if (!result.found) {
      return res.status(200).json({
        success: true,
        found: false,
        latitude: null,
        longitude: null,
        confidence: null,
        format: null,
        message: result.error || "No GPS coordinates detected in photo watermark text."
      });
    }

    // Coordinates were detected: double check bounds on Express layer
    const lat = Number(result.latitude);
    const lng = Number(result.longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(200).json({
        success: false,
        found: false,
        latitude: null,
        longitude: null,
        confidence: null,
        format: null,
        message: "Extracted coordinates were outside valid geographic bounds."
      });
    }

    return res.status(200).json({
      success: true,
      found: true,
      latitude: lat,
      longitude: lng,
      confidence: result.confidence,
      format: result.format,
      message: "GPS coordinates detected successfully from photo."
    });
  } catch (err) {
    console.error("extractOcrCoordinates error:", err.message);
    return res.status(500).json({
      error: true,
      message: "Internal error during OCR processing. Please place your pin manually."
    });
  }
};

