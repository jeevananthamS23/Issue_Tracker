const Issue = require("../models/Issue");

exports.getAllIssues = async (req, res) => {
  try {
    const issues = await Issue.find().populate("userId", "fullName email").sort({ createdAt: -1 });
    res.status(200).json(issues);
  } catch (err) {
    res.status(500).json({ message: "Error fetching issues", error: err.message });
  }
};

// Optional: Filter by status/type via query params
exports.getFilteredIssues = async (req, res) => {
  const { status, type } = req.query;
  const filter = {};
  if (status) filter.status = status;
  if (type) filter.type = type;

  try {
    const issues = await Issue.find(filter).populate("userId", "fullName email").sort({ createdAt: -1 });
    res.status(200).json(issues);
  } catch (err) {
    res.status(500).json({ message: "Error filtering issues", error: err.message });
  }
};

exports.updateIssueStatus = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!["reported", "in-progress", "resolved"].includes(status)) {
    return res.status(400).json({ message: "Invalid status value" });
  }

  try {
    const issue = await Issue.findByIdAndUpdate(id, { status }, { new: true });
    if (!issue) return res.status(404).json({ message: "Issue not found" });

    res.status(200).json({ message: "Status updated", issue });
  } catch (err) {
    res.status(500).json({ message: "Error updating status", error: err.message });
  }
};

exports.deleteIssue = async (req, res) => {
  const { id } = req.params;

  try {
    const deleted = await Issue.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ message: "Issue not found" });

    res.status(200).json({ message: "Issue deleted" });
  } catch (err) {
    res.status(500).json({ message: "Error deleting issue", error: err.message });
  }
};
