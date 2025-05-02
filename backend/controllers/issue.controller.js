const Issue = require("../models/Issue");
const path = require("path");

exports.getAllIssues = async (req, res) => {
  try {
    const issues = await Issue.find().sort({ createdAt: -1 });
    res.status(200).json(issues);
  } catch (err) {
    res.status(500).json({ error: true, message: "Failed to fetch issues" });
  }
};

exports.getUserIssues = async (req, res) => {
  try {
    const issues = await Issue.find({ userId: req.user.userId });
    res.status(200).json(issues);
  } catch (err) {
    res.status(500).json({ error: true, message: "Failed to fetch user issues" });
  }
};

exports.reportIssue = async (req, res) => {
  try {
    const { type, description, lat, lng } = req.body;

    if (!type || !description || !lat || !lng) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;

    const newIssue = new Issue({
      userId: req.user.userId,
      type,
      description,
      imageUrl,
      location: { lat, lng },
    });

    await newIssue.save();
    res.status(201).json({ message: "Issue reported successfully", issue: newIssue });
  } catch (err) {
    res.status(500).json({ message: "Failed to report issue" });
  }
};
