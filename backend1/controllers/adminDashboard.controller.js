const mongoose = require("mongoose");
const Issue = require("../models/Issue");

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
    const issues = await Issue.find(filter)
      .populate("userId", SAFE_USER_FIELDS)
      .populate("duplicateOf", SAFE_DUPLICATE_OF_FIELDS)
      .populate("reviewedBy", SAFE_ADMIN_FIELDS)
      .sort({ createdAt: -1 });

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
    const issues = await Issue.find(filter)
      .populate("userId", SAFE_USER_FIELDS)
      .populate("duplicateOf", SAFE_DUPLICATE_OF_FIELDS)
      .populate("reviewedBy", SAFE_ADMIN_FIELDS)
      .sort({ createdAt: -1 });

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
  const { status, department, internalNotes, reviewResolution, action, reviewNotes } = req.body;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: true, message: "Invalid issue ID format" });
  }

  const updateFields = {};

  if (status !== undefined) {
    if (!["reported", "in-progress", "resolved"].includes(status)) {
      return res.status(400).json({ error: true, message: "Invalid status value. Must be reported, in-progress, or resolved." });
    }
    updateFields.status = status;
  }

  if (department !== undefined) {
    updateFields.department = department;
  }

  if (internalNotes !== undefined) {
    updateFields.internalNotes = internalNotes;
  }

  // Handle review resolution if submitted via updateIssueStatus
  if (action || reviewResolution) {
    const rawAction = action || reviewResolution;
    const adminId = req.admin ? req.admin.adminId : null;
    if (!adminId) {
      return res.status(403).json({ error: true, message: "Forbidden: Administrator identification missing" });
    }

    if (rawAction === "confirm_duplicate" || rawAction === "confirmed_duplicate") {
      updateFields.reviewResolution = "confirmed_duplicate";
      updateFields.needsReview = false;
      updateFields.reviewedBy = adminId;
      updateFields.reviewedAt = new Date();
    } else if (rawAction === "dismiss_duplicate" || rawAction === "mark_unique" || rawAction === "dismissed_unique") {
      updateFields.reviewResolution = "dismissed_unique";
      updateFields.needsReview = false;
      updateFields.reviewedBy = adminId;
      updateFields.reviewedAt = new Date();
    } else {
      return res.status(400).json({
        error: true,
        message: `Invalid review action '${rawAction}'. Allowed actions: 'confirm_duplicate' or 'dismiss_duplicate'.`
      });
    }

    if (reviewNotes !== undefined && typeof reviewNotes === "string") {
      updateFields.reviewNotes = reviewNotes.trim();
    }
  }

  try {
    const issue = await Issue.findById(id);
    if (!issue) return res.status(404).json({ error: true, message: "Issue not found" });

    if (status !== undefined) {
      if (!["reported", "in-progress", "resolved"].includes(status)) {
        return res.status(400).json({ error: true, message: "Invalid status value. Must be reported, in-progress, or resolved." });
      }
      issue.status = status;
    }

    if (department !== undefined) {
      issue.department = department;
    }

    if (internalNotes !== undefined) {
      issue.internalNotes = internalNotes;
    }

    // Handle review resolution if submitted via updateIssueStatus
    if (action || reviewResolution) {
      const rawAction = action || reviewResolution;
      const adminId = req.admin ? req.admin.adminId : null;
      if (!adminId) {
        return res.status(403).json({ error: true, message: "Forbidden: Administrator identification missing" });
      }

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

    // Handle classification review resolution if submitted via updateIssueStatus
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

    // Derive consolidated needsReview from all outstanding reasons
    issue.needsReview = Boolean(issue.needsDuplicateReview || issue.needsClassificationReview);

    await issue.save();

    const populatedIssue = await Issue.findById(issue._id)
      .populate("userId", SAFE_USER_FIELDS)
      .populate("duplicateOf", SAFE_DUPLICATE_OF_FIELDS)
      .populate("reviewedBy", SAFE_ADMIN_FIELDS);

    res.status(200).json(populatedIssue);
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
