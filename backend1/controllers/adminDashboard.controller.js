const mongoose = require("mongoose");
const Issue = require("../models/Issue");
const Hotspot = require("../models/Hotspot");
const AdminNotification = require("../models/AdminNotification");
const { CANONICAL_CATEGORIES, normalizeCategory } = require("../services/routing.service");
const { executeHotspotJob } = require("../services/hotspotJob.service");
const { retryNotificationEmail } = require("../services/adminNotification.service");
const { getDashboardAnalytics } = require("../services/analytics.service");
const {
  parsePaginationParams,
  buildPaginationResponse,
  setPaginationHeaders
} = require("../utils/pagination");

const SAFE_DUPLICATE_OF_FIELDS = "type description imageUrl status location createdAt";
const SAFE_USER_FIELDS = "fullName email";
const SAFE_ADMIN_FIELDS = "fullName email";

/**
 * Validates and constructs MongoDB filter object from query parameters.
 * Supports status, type, needsReview, duplicateStatus, and reviewResolution.
 */
function buildAdminFilter(query = {}) {
  const filter = {};

  if (query.status) {
    if (!["reported", "in-progress", "resolved"].includes(query.status)) {
      throw new Error(`Invalid status filter '${query.status}'. Must be one of: reported, in-progress, resolved.`);
    }
    filter.status = query.status;
  }

  if (query.type && typeof query.type === "string" && query.type.trim()) {
    filter.type = query.type.trim();
  }

  if (query.needsReview !== undefined) {
    const nrStr = String(query.needsReview).toLowerCase().trim();
    if (nrStr === "true") {
      filter.needsReview = true;
    } else if (nrStr === "false") {
      filter.needsReview = false;
    } else {
      throw new Error(`Invalid needsReview filter '${query.needsReview}'. Must be 'true' or 'false'.`);
    }
  }

  if (query.duplicateStatus) {
    const validDuplicateStatuses = ["unique", "flagged_duplicate", "suspected_duplicate", "unverified"];
    if (!validDuplicateStatuses.includes(query.duplicateStatus)) {
      throw new Error(`Invalid duplicateStatus filter '${query.duplicateStatus}'. Must be one of: ${validDuplicateStatuses.join(", ")}.`);
    }
    filter.duplicateStatus = query.duplicateStatus;
  }

  if (query.reviewResolution) {
    const validResolutions = ["none", "confirmed_duplicate", "dismissed_unique"];
    if (!validResolutions.includes(query.reviewResolution)) {
      throw new Error(`Invalid reviewResolution filter '${query.reviewResolution}'. Must be one of: ${validResolutions.join(", ")}.`);
    }
    filter.reviewResolution = query.reviewResolution;
  }

  return filter;
}

exports.getAllIssues = async (req, res) => {
  try {
    const filter = buildAdminFilter(req.query);
    const { page, limit, skip, isPaginated } = parsePaginationParams(req.query);

    const baseQuery = Issue.find(filter)
      .populate("userId", SAFE_USER_FIELDS)
      .populate("duplicateOf", SAFE_DUPLICATE_OF_FIELDS)
      .populate("reviewedBy", SAFE_ADMIN_FIELDS)
      .populate("statusHistory.changedBy", SAFE_ADMIN_FIELDS)
      .sort({ createdAt: -1 });

    if (isPaginated) {
      const [issues, total] = await Promise.all([
        baseQuery.skip(skip).limit(limit),
        Issue.countDocuments(filter)
      ]);
      const totalPages = Math.ceil(total / limit) || (total === 0 ? 0 : 1);
      setPaginationHeaders(res, total, page, limit, totalPages);
      return res.status(200).json(buildPaginationResponse(issues, total, page, limit));
    }

    const issues = await baseQuery;
    setPaginationHeaders(res, issues.length, 1, issues.length || 1, 1);
    res.status(200).json(issues);
  } catch (err) {
    const isValidationError = err.message && (
      err.message.includes("Invalid status") ||
      err.message.includes("Invalid needsReview") ||
      err.message.includes("Invalid duplicateStatus") ||
      err.message.includes("Invalid reviewResolution")
    );
    if (isValidationError) {
      return res.status(400).json({ error: true, message: err.message });
    }
    res.status(500).json({ error: true, message: "Error fetching issues", details: err.message });
  }
};

exports.getFilteredIssues = async (req, res) => {
  try {
    const filter = buildAdminFilter(req.query);
    const { page, limit, skip, isPaginated } = parsePaginationParams(req.query);

    const baseQuery = Issue.find(filter)
      .populate("userId", SAFE_USER_FIELDS)
      .populate("duplicateOf", SAFE_DUPLICATE_OF_FIELDS)
      .populate("reviewedBy", SAFE_ADMIN_FIELDS)
      .populate("statusHistory.changedBy", SAFE_ADMIN_FIELDS)
      .sort({ createdAt: -1 });

    if (isPaginated) {
      const [issues, total] = await Promise.all([
        baseQuery.skip(skip).limit(limit),
        Issue.countDocuments(filter)
      ]);
      const totalPages = Math.ceil(total / limit) || (total === 0 ? 0 : 1);
      setPaginationHeaders(res, total, page, limit, totalPages);
      return res.status(200).json(buildPaginationResponse(issues, total, page, limit));
    }

    const issues = await baseQuery;
    setPaginationHeaders(res, issues.length, 1, issues.length || 1, 1);
    res.status(200).json(issues);
  } catch (err) {
    const isValidationError = err.message && (
      err.message.includes("Invalid status") ||
      err.message.includes("Invalid needsReview") ||
      err.message.includes("Invalid duplicateStatus") ||
      err.message.includes("Invalid reviewResolution")
    );
    if (isValidationError) {
      return res.status(400).json({ error: true, message: err.message });
    }
    res.status(500).json({ error: true, message: "Error filtering issues", details: err.message });
  }
};

exports.updateIssueStatus = async (req, res) => {
  const { id } = req.params;
  const {
    status: rawStatus,
    department,
    internalNotes,
    reviewResolution,
    action: rawAction,
    reviewNotes,
    reason,
    reopenReason,
    notes
  } = req.body;

  const status = typeof rawStatus === "string" ? rawStatus.trim() : rawStatus;
  const action = typeof rawAction === "string" ? rawAction.trim().toLowerCase() : rawAction;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: true, message: "Invalid issue ID format" });
  }

  const adminId = req.admin ? req.admin.adminId : null;
  if (!adminId) {
    return res.status(403).json({ error: true, message: "Forbidden: Administrator identification missing" });
  }

  try {
    const issue = await Issue.findById(id);
    if (!issue) return res.status(404).json({ error: true, message: "Issue not found" });

    const prevStatus = issue.status;
    const isExplicitReopen = action === "reopen" || action === "reopened";
    const changeReason = (reason || reopenReason || reviewNotes || notes || internalNotes || "").trim();
    const changeNotes = (notes || internalNotes || "").trim();

    let targetStatus = undefined;

    // 1. Determine target status
    if (isExplicitReopen) {
      if (prevStatus !== "resolved") {
        return res.status(400).json({
          error: true,
          message: `Cannot reopen an issue with status '${prevStatus}'. Only 'resolved' issues can be reopened.`
        });
      }
      if (!changeReason || changeReason.length < 3) {
        return res.status(400).json({
          error: true,
          message: "Reopening a resolved issue requires an explicit reason (minimum 3 characters)."
        });
      }
      targetStatus = status || "in-progress";
      if (targetStatus === "resolved") {
        return res.status(400).json({
          error: true,
          message: "Cannot reopen an issue to 'resolved' status."
        });
      }
      if (!["reported", "in-progress"].includes(targetStatus)) {
        return res.status(400).json({
          error: true,
          message: `Invalid reopen target status '${targetStatus}'. Must be 'in-progress' or 'reported'.`
        });
      }
    } else if (status !== undefined) {
      if (!["reported", "in-progress", "resolved"].includes(status)) {
        return res.status(400).json({
          error: true,
          message: "Invalid status value. Must be reported, in-progress, or resolved."
        });
      }
      targetStatus = status;
    }

    // 2. Validate and execute state transition if a status change is requested
    let statusChanged = false;
    if (targetStatus !== undefined && targetStatus !== prevStatus) {
      // Validate FSM transitions: reported -> in-progress -> resolved, and explicit reopen from resolved
      if (prevStatus === "reported") {
        if (targetStatus === "resolved") {
          return res.status(400).json({
            error: true,
            message: "Invalid status transition from 'reported' to 'resolved'. Issues must transition to 'in-progress' before being resolved."
          });
        }
      } else if (prevStatus === "in-progress") {
        if (targetStatus === "reported") {
          return res.status(400).json({
            error: true,
            message: "Invalid status transition from 'in-progress' to 'reported'."
          });
        }
      } else if (prevStatus === "resolved") {
        // Must be explicit reopen with reason
        if (!changeReason || changeReason.length < 3) {
          return res.status(400).json({
            error: true,
            message: "Reopening a resolved issue requires an explicit reopen action or reason (minimum 3 characters)."
          });
        }
      }

      // Concurrency guard: verify current document status in database before mutation
      let freshQuery = Issue.findById(issue._id);
      if (freshQuery && typeof freshQuery.select === "function") {
        freshQuery = freshQuery.select("status");
      }
      const freshCheck = await freshQuery;
      if (!freshCheck || freshCheck.status !== prevStatus) {
        return res.status(409).json({
          error: true,
          message: "Concurrent modification detected. The issue status was changed by another request. Please refresh."
        });
      }

      // Record in statusHistory
      if (!Array.isArray(issue.statusHistory)) {
        issue.statusHistory = [];
      }
      issue.statusHistory.push({
        from: prevStatus,
        to: targetStatus,
        changedBy: adminId,
        changedAt: new Date(),
        reason: changeReason || null,
        notes: changeNotes || null
      });

      issue.status = targetStatus;
      statusChanged = true;

      // Handle resolvedAt timestamp
      if (targetStatus === "resolved") {
        issue.resolvedAt = new Date();
      } else if (prevStatus === "resolved") {
        issue.resolvedAt = null;
      }
    }

    // 3. Update department if provided
    if (department !== undefined) {
      issue.department = department;
    }

    // 4. Update internalNotes if provided
    if (internalNotes !== undefined) {
      issue.internalNotes = internalNotes;
    }

    // 5. Handle review resolution if submitted via updateIssueStatus (non-reopen actions)
    if ((action && !isExplicitReopen) || reviewResolution) {
      const rawAction = action || reviewResolution;

      if (rawAction === "confirm_duplicate" || rawAction === "confirmed_duplicate") {
        issue.reviewResolution = "confirmed_duplicate";
        issue.needsDuplicateReview = false;
        issue.reviewedBy = adminId;
        issue.reviewedAt = new Date();
      } else if (rawAction === "dismiss_duplicate" || rawAction === "mark_unique" || rawAction === "dismissed_unique") {
        issue.reviewResolution = "dismissed_unique";
        issue.needsDuplicateReview = false;
        issue.reviewedBy = adminId;
        issue.reviewedAt = new Date();
      } else {
        return res.status(400).json({
          error: true,
          message: `Invalid review action '${rawAction}'. Allowed actions: 'confirm_duplicate' or 'dismiss_duplicate'.`
        });
      }

      if (reviewNotes !== undefined && typeof reviewNotes === "string") {
        issue.reviewNotes = reviewNotes.trim();
      }
    }

    // 6. Handle classification review resolution if submitted via updateIssueStatus
    if (req.body.classificationReviewResolution || req.body.resolveClassification) {
      const classRes = req.body.classificationReviewResolution || "confirmed_category";
      if (!["none", "confirmed_category", "reclassified"].includes(classRes)) {
        return res.status(400).json({
          error: true,
          message: `Invalid classification review resolution '${classRes}'. Must be 'confirmed_category' or 'reclassified'.`
        });
      }
      issue.classificationReviewResolution = classRes;
      issue.needsClassificationReview = false;
    }

    // 7. Derive consolidated needsReview from all outstanding reasons
    issue.needsReview = Boolean(issue.needsDuplicateReview || issue.needsClassificationReview);

    await issue.save();

    // 8. Return populated document safely (supporting both real Mongoose queries and test stubs)
    let query = Issue.findById(issue._id);
    if (query && typeof query.populate === "function") {
      query = query
        .populate("userId", SAFE_USER_FIELDS)
        .populate("duplicateOf", SAFE_DUPLICATE_OF_FIELDS)
        .populate("reviewedBy", SAFE_ADMIN_FIELDS)
        .populate("statusHistory.changedBy", SAFE_ADMIN_FIELDS);
    }
    const populatedIssue = await query;

    res.status(200).json(populatedIssue || issue);
  } catch (err) {
    res.status(500).json({ error: true, message: "Error updating issue", details: err.message });
  }
};

/**
 * Dedicated administrative review resolution endpoint (Phase 3.4A & 4.2A).
 * Resolves flagged/unverified duplicate status without clearing independent classification review.
 * Records administrator ID and timestamp while keeping AI assessment intact.
 */
exports.resolveDuplicateReview = async (req, res) => {
  const { id } = req.params;
  const { action, reviewResolution, reviewNotes, internalNotes } = req.body;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: true, message: "Invalid issue ID format" });
  }

  const rawAction = action || reviewResolution;
  if (!rawAction) {
    return res.status(400).json({
      error: true,
      message: "Review resolution action required: 'confirm_duplicate' or 'dismiss_duplicate'."
    });
  }

  let finalResolution;
  if (rawAction === "confirm_duplicate" || rawAction === "confirmed_duplicate") {
    finalResolution = "confirmed_duplicate";
  } else if (rawAction === "dismiss_duplicate" || rawAction === "mark_unique" || rawAction === "dismissed_unique") {
    finalResolution = "dismissed_unique";
  } else {
    return res.status(400).json({
      error: true,
      message: `Unsupported review action '${rawAction}'. Supported actions: 'confirm_duplicate' or 'dismiss_duplicate'.`
    });
  }

  const adminId = req.admin ? req.admin.adminId : null;
  if (!adminId) {
    return res.status(403).json({ error: true, message: "Forbidden: Administrator identification missing" });
  }

  try {
    const issue = await Issue.findById(id);
    if (!issue) {
      return res.status(404).json({ error: true, message: "Issue not found" });
    }

    // Record duplicate review resolution and audit trail
    issue.reviewResolution = finalResolution;
    issue.needsDuplicateReview = false;
    // Derive consolidated needsReview from remaining reasons (e.g. classification review)
    issue.needsReview = Boolean(issue.needsClassificationReview);
    issue.reviewedBy = adminId;
    issue.reviewedAt = new Date();

    if (reviewNotes !== undefined && typeof reviewNotes === "string") {
      issue.reviewNotes = reviewNotes.trim();
    }
    if (internalNotes !== undefined && typeof internalNotes === "string") {
      issue.internalNotes = internalNotes.trim();
    }

    await issue.save();

    const populatedIssue = await Issue.findById(issue._id)
      .populate("userId", SAFE_USER_FIELDS)
      .populate("duplicateOf", SAFE_DUPLICATE_OF_FIELDS)
      .populate("reviewedBy", SAFE_ADMIN_FIELDS);

    return res.status(200).json({
      error: false,
      message: `Duplicate review successfully resolved as '${finalResolution}'.`,
      issue: populatedIssue
    });
  } catch (err) {
    return res.status(500).json({ error: true, message: "Error resolving duplicate review", details: err.message });
  }
};

/**
 * Dedicated administrative classification / triage review resolution endpoint (Phase 4.2A).
 * Resolves classification review flag without clearing independent duplicate review.
 */
exports.resolveClassificationReview = async (req, res) => {
  const { id } = req.params;
  const { action, classificationReviewResolution, reviewNotes, department, type } = req.body;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: true, message: "Invalid issue ID format" });
  }

  const rawAction = action || classificationReviewResolution || "confirmed_category";
  if (!["confirmed_category", "reclassified"].includes(rawAction)) {
    return res.status(400).json({
      error: true,
      message: `Unsupported classification review action '${rawAction}'. Allowed: 'confirmed_category' or 'reclassified'.`
    });
  }

  const adminId = req.admin ? req.admin.adminId : null;
  if (!adminId) {
    return res.status(403).json({ error: true, message: "Forbidden: Administrator identification missing" });
  }

  try {
    const issue = await Issue.findById(id);
    if (!issue) {
      return res.status(404).json({ error: true, message: "Issue not found" });
    }

    issue.classificationReviewResolution = rawAction;
    issue.needsClassificationReview = false;
    if (department) issue.department = department;
    if (type) issue.type = type;
    if (reviewNotes !== undefined && typeof reviewNotes === "string") {
      issue.reviewNotes = reviewNotes.trim();
    }

    // Derive consolidated needsReview from remaining reasons (e.g. duplicate review)
    issue.needsReview = Boolean(issue.needsDuplicateReview);

    await issue.save();

    const populatedIssue = await Issue.findById(issue._id)
      .populate("userId", SAFE_USER_FIELDS)
      .populate("duplicateOf", SAFE_DUPLICATE_OF_FIELDS)
      .populate("reviewedBy", SAFE_ADMIN_FIELDS);

    return res.status(200).json({
      error: false,
      message: `Classification review successfully resolved as '${rawAction}'.`,
      issue: populatedIssue
    });
  } catch (err) {
    return res.status(500).json({ error: true, message: "Error resolving classification review", details: err.message });
  }
};

exports.deleteIssue = async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: true, message: "Invalid issue ID format" });
  }

  try {
    const deleted = await Issue.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ error: true, message: "Issue not found" });

    res.status(200).json({ message: "Issue deleted" });
  } catch (err) {
    res.status(500).json({ message: "Error deleting issue", error: err.message });
  }
};

/**
 * Phase 4.2B-C: List hotspots with validated pagination, filtering, and sorting.
 * Endpoint: GET /api/admin-dashboard/hotspots
 */
exports.getHotspots = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      category,
      status,
      department,
      sortBy = "lastDetectedAt",
      order = "desc"
    } = req.query;

    // Validate page
    const parsedPage = parseInt(page, 10);
    if (isNaN(parsedPage) || parsedPage < 1) {
      return res.status(400).json({
        error: true,
        message: "Invalid page parameter. Must be an integer greater than or equal to 1."
      });
    }

    // Validate limit
    const parsedLimit = parseInt(limit, 10);
    if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      return res.status(400).json({
        error: true,
        message: "Invalid limit parameter. Must be an integer between 1 and 100."
      });
    }

    // Build filter
    const filter = {};

    if (category) {
      const cleaned = String(category).trim().toLowerCase().replace(/[\s-]+/g, "_");
      const normalizedCat = normalizeCategory(category);
      if (normalizedCat === "other" && cleaned !== "other" && !CANONICAL_CATEGORIES.includes(cleaned)) {
        return res.status(400).json({
          error: true,
          message: `Invalid category filter '${category}'. Must be one of: ${CANONICAL_CATEGORIES.join(", ")}.`
        });
      }
      filter.category = normalizedCat;
    }

    if (status) {
      const validStatuses = ["active", "escalating", "resolving", "resolved", "dismissed"];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          error: true,
          message: `Invalid status filter '${status}'. Must be one of: ${validStatuses.join(", ")}.`
        });
      }
      filter.status = status;
    }

    if (department && typeof department === "string" && department.trim()) {
      filter.department = department.trim();
    }

    // Sort validation
    const allowedSortFields = [
      "lastDetectedAt",
      "firstDetectedAt",
      "distinctDefectCount",
      "totalReportCount",
      "totalVotes",
      "meanSeverity",
      "createdAt"
    ];
    const sortField = allowedSortFields.includes(sortBy) ? sortBy : "lastDetectedAt";
    const sortOrder = order === "asc" ? 1 : -1;

    const total = await Hotspot.countDocuments(filter);
    const totalPages = Math.ceil(total / parsedLimit) || 1;

    const hotspots = await Hotspot.find(filter)
      .sort({ [sortField]: sortOrder })
      .skip((parsedPage - 1) * parsedLimit)
      .limit(parsedLimit)
      .lean();

    return res.status(200).json({
      error: false,
      total,
      page: parsedPage,
      totalPages,
      limit: parsedLimit,
      hotspots
    });
  } catch (err) {
    return res.status(500).json({
      error: true,
      message: "Error fetching hotspots",
      details: err.message
    });
  }
};

/**
 * Phase 4.2B-C: Retrieve a hotspot by ID along with safe constituent issue summaries.
 * Endpoint: GET /api/admin-dashboard/hotspots/:id
 * Strictly deselects internalNotes, embeddings, and sensitive AI diagnostics.
 */
exports.getHotspotById = async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: true, message: "Invalid hotspot ID format" });
  }

  try {
    const hotspot = await Hotspot.findById(id).lean();
    if (!hotspot) {
      return res.status(404).json({ error: true, message: "Hotspot not found" });
    }

    // Safely project constituent issues (Deselect internalNotes, embedding, embeddingModel, aiDiagnostic)
    const issues = await Issue.find({ _id: { $in: hotspot.issueIds } })
      .select("type description location status votes severity imageUrl createdAt duplicateStatus duplicateOf needsReview needsDuplicateReview needsClassificationReview")
      .populate("userId", SAFE_USER_FIELDS)
      .populate("duplicateOf", SAFE_DUPLICATE_OF_FIELDS)
      .lean();

    return res.status(200).json({
      error: false,
      hotspot: {
        ...hotspot,
        issues
      }
    });
  } catch (err) {
    return res.status(500).json({
      error: true,
      message: "Error retrieving hotspot details",
      details: err.message
    });
  }
};

/**
 * Phase 4.2B-C: Manually trigger a hotspot refresh job with concurrency guard.
 * Endpoint: POST /api/admin-dashboard/hotspots/run
 */
exports.runHotspotRefresh = async (req, res) => {
  try {
    const { category, epsMeters, minSamples, rollingWindowDays } = req.body || {};

    const options = {};
    if (category) {
      const cleaned = String(category).trim().toLowerCase().replace(/[\s-]+/g, "_");
      const normalizedCat = normalizeCategory(category);
      if (normalizedCat === "other" && cleaned !== "other" && !CANONICAL_CATEGORIES.includes(cleaned)) {
        return res.status(400).json({
          error: true,
          message: `Invalid category option '${category}'. Must be one of: ${CANONICAL_CATEGORIES.join(", ")}.`
        });
      }
      options.category = normalizedCat;
    }
    if (epsMeters !== undefined) {
      const eps = Number(epsMeters);
      if (isNaN(eps) || eps <= 0) {
        return res.status(400).json({ error: true, message: "epsMeters must be a positive number" });
      }
      options.epsMeters = eps;
    }
    if (minSamples !== undefined) {
      const minS = parseInt(minSamples, 10);
      if (isNaN(minS) || minS < 1) {
        return res.status(400).json({ error: true, message: "minSamples must be an integer >= 1" });
      }
      options.minSamples = minS;
    }
    if (rollingWindowDays !== undefined) {
      const rwd = Number(rollingWindowDays);
      if (isNaN(rwd) || rwd <= 0) {
        return res.status(400).json({ error: true, message: "rollingWindowDays must be a positive number" });
      }
      options.rollingWindowDays = rwd;
    }

    const result = await executeHotspotJob(options);

    if (!result.success && result.conflict) {
      return res.status(409).json({
        error: true,
        message: "Hotspot refresh job is already running. Please wait for the current run to complete.",
        reason: result.reason
      });
    }

    return res.status(200).json({
      error: false,
      message: "Hotspot refresh job completed successfully",
      summary: result.summary,
      durationMs: result.durationMs
    });
  } catch (err) {
    return res.status(500).json({
      error: true,
      message: "Failed to execute hotspot refresh",
      details: err.message
    });
  }
};

/**
 * Phase 4.2C-A: Retrieve paginated administrative notifications with unread count and filters.
 * Endpoint: GET /api/admin-dashboard/notifications
 */
exports.getNotifications = async (req, res) => {
  try {
    let page = parseInt(req.query.page, 10);
    let limit = parseInt(req.query.limit, 10);

    if (isNaN(page) || page < 1) {
      if (req.query.page !== undefined) {
        return res.status(400).json({ error: true, message: "Page must be an integer >= 1" });
      }
      page = 1;
    }

    if (isNaN(limit) || limit < 1 || limit > 100) {
      if (req.query.limit !== undefined) {
        return res.status(400).json({ error: true, message: "Limit must be an integer between 1 and 100" });
      }
      limit = 20;
    }

    const filter = {};

    if (req.query.read !== undefined) {
      const readStr = String(req.query.read).toLowerCase().trim();
      if (readStr === "true") {
        filter.readAt = { $ne: null };
      } else if (readStr === "false") {
        filter.readAt = null;
      } else {
        return res.status(400).json({ error: true, message: "Invalid read filter. Must be 'true' or 'false'." });
      }
    }

    if (req.query.type) {
      const typeStr = String(req.query.type).trim();
      if (!["hotspot_detected", "hotspot_escalated"].includes(typeStr)) {
        return res.status(400).json({
          error: true,
          message: `Invalid type filter '${typeStr}'. Must be 'hotspot_detected' or 'hotspot_escalated'.`
        });
      }
      filter.type = typeStr;
    }

    const skip = (page - 1) * limit;

    const [total, unreadCount, notifications] = await Promise.all([
      AdminNotification.countDocuments(filter),
      AdminNotification.countDocuments({ readAt: null }),
      AdminNotification.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
    ]);

    return res.status(200).json({
      error: false,
      total,
      unreadCount,
      page,
      totalPages: Math.ceil(total / limit) || 1,
      limit,
      notifications
    });
  } catch (err) {
    return res.status(500).json({
      error: true,
      message: "Failed to retrieve notifications",
      details: err.message
    });
  }
};

/**
 * Phase 4.2C-A: Retrieve unread notification count.
 * Endpoint: GET /api/admin-dashboard/notifications/unread-count
 */
exports.getUnreadNotificationCount = async (req, res) => {
  try {
    const unreadCount = await AdminNotification.countDocuments({ readAt: null });
    return res.status(200).json({
      error: false,
      unreadCount
    });
  } catch (err) {
    return res.status(500).json({
      error: true,
      message: "Failed to retrieve unread notification count",
      details: err.message
    });
  }
};

/**
 * Phase 4.2C-A: Mark a single notification as read.
 * Endpoint: PATCH /api/admin-dashboard/notifications/:id/read
 */
exports.markNotificationAsRead = async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: true, message: "Invalid notification ID format" });
  }

  try {
    const notification = await AdminNotification.findById(id);
    if (!notification) {
      return res.status(404).json({ error: true, message: "Notification not found" });
    }

    if (!notification.readAt) {
      notification.readAt = new Date();
      await notification.save();
    }

    return res.status(200).json({
      error: false,
      message: "Notification marked as read",
      notification
    });
  } catch (err) {
    return res.status(500).json({
      error: true,
      message: "Failed to update notification read state",
      details: err.message
    });
  }
};

/**
 * Phase 4.2C-A: Mark all unread notifications as read.
 * Endpoint: PATCH /api/admin-dashboard/notifications/read-all
 */
exports.markAllNotificationsAsRead = async (req, res) => {
  try {
    const now = new Date();
    const result = await AdminNotification.updateMany(
      { readAt: null },
      { $set: { readAt: now } }
    );

    return res.status(200).json({
      error: false,
      message: "All notifications marked as read",
      markedCount: result.modifiedCount || 0
    });
  } catch (err) {
    return res.status(500).json({
      error: true,
      message: "Failed to mark all notifications as read",
      details: err.message
    });
  }
};

/**
 * Phase 4.2C-A: Admin-only bounded retry for failed email notification.
 * Endpoint: POST /api/admin-dashboard/notifications/:id/retry-email
 */
exports.retryNotificationEmail = async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: true, message: "Invalid notification ID format" });
  }

  try {
    const result = await retryNotificationEmail(id);

    if (!result.success) {
      return res.status(400).json({
        error: true,
        message: result.message,
        notification: result.notification
      });
    }

    return res.status(200).json({
      error: false,
      message: result.message,
      notification: result.notification
    });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: true, message: err.message });
    }
    return res.status(500).json({
      error: true,
      message: "Failed to retry notification email",
      details: err.message
    });
  }
};

/**
 * Sprint Block 2: Performance Analytics & Aggregation
 * Endpoint: GET /api/admin-dashboard/analytics
 * Returns database-backed aggregation metrics (totals, open, resolved, MTTR, breakdowns, hotspots, daily trend).
 */
exports.getAnalytics = async (req, res) => {
  try {
    const { days } = req.query;
    const analytics = await getDashboardAnalytics({ days });
    return res.status(200).json({
      error: false,
      data: analytics
    });
  } catch (err) {
    return res.status(500).json({
      error: true,
      message: "Failed to generate dashboard analytics",
      details: err.message
    });
  }
};


