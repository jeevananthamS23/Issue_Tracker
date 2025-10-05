require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const userRoutes = require("./routes/userAuth.routes");
const adminRoutes = require("./routes/adminAuth.routes");
const issueRoutes = require("./routes/issue.routes");
const adminDashboardRoutes = require("./routes/adminDashboard.routes");
const voteRoutes = require("./routes/vote.routes");

const app = express();

// Middleware
app.use(cors({
  origin: "https://issue-tracker-1-lwig.onrender.com",  // your frontend URL
  credentials: true
}));

app.use(express.json());
app.use("/uploads", express.static("uploads")); // Static path for uploaded images

// Database connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch(err => console.log("Mongo Error", err));

// Routes
app.use("/api/user", userRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/issues", issueRoutes);
app.use("/api/admin-dashboard", adminDashboardRoutes);
app.use("/api/votes", voteRoutes); 

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
