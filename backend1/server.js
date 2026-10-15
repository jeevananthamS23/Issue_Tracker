require("dotenv").config();
const dns = require("dns");
try {
  // Use public DNS to resolve MongoDB Atlas SRV records when local/ISP DNS blocks SRV lookups
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch {
  // Fall back to system DNS
}
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const multer = require("multer");

const userRoutes = require("./routes/userAuth.routes");
const adminRoutes = require("./routes/adminAuth.routes");
const issueRoutes = require("./routes/issue.routes");
const adminDashboardRoutes = require("./routes/adminDashboard.routes");
const voteRoutes = require("./routes/vote.routes");

const { createCorsOptions } = require("./config/cors");

const app = express();

app.use(cors(createCorsOptions()));

app.use(express.json());
app.use("/uploads", express.static("uploads")); // Static path for uploaded images

// ----- Database Connection -----
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch(err => console.log("Mongo Error", err));

// ----- Health Check -----
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    mongo: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  });
});

// ----- Routes -----
app.use("/api/user", userRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/issues", issueRoutes);
app.use("/api/admin-dashboard", adminDashboardRoutes);
app.use("/api/votes", voteRoutes);

// ----- Error Handler -----
app.use((err, req, res, next) => {
  // CORS origin rejection
  if (err.code === "CORS_NOT_ALLOWED" || (err.message && err.message.startsWith("CORS policy violation"))) {
    return res.status(403).json({ error: true, message: err.message });
  }

  // Multer file upload errors
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: true, message: "File size exceeds the 5MB limit." });
    }
    return res.status(400).json({ error: true, message: `Upload error: ${err.message}` });
  }

  // Custom MIME-type, extension, or binary signature validation error
  if (err.code === "INVALID_FILE_TYPE" || err.code === "INVALID_IMAGE_SIGNATURE") {
    return res.status(400).json({ error: true, message: err.message });
  }

  console.error("Unhandled error:", err);
  res.status(500).json({ error: true, message: err.message || "Internal server error" });
});

// ----- Start Server -----
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
