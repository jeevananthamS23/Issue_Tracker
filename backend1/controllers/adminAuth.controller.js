const Admin = require("../models/Admin");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

// Public admin registration is disabled
exports.registerAdmin = async (req, res) => {
  return res.status(403).json({
    error: true,
    message: "Public administrator registration is disabled. Administrator accounts must be provisioned internally."
  });
};

exports.loginAdmin = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: true, message: "Email and password required" });
    }

    const admin = await Admin.findOne({ email });
    if (!admin) {
      return res.status(401).json({ error: true, message: "Invalid credentials" });
    }

    const valid = await bcrypt.compare(password, admin.password);
    if (!valid) {
      return res.status(401).json({ error: true, message: "Invalid credentials" });
    }

    const accessToken = jwt.sign(
      { adminId: admin._id, role: "admin" },
      process.env.JWT_SECRET,
      { expiresIn: "72h" }
    );

    return res.status(200).json({
      error: false,
      message: "Login successful",
      admin: { id: admin._id, fullName: admin.fullName, email: admin.email },
      accessToken
    });
  } catch (err) {
    console.error("loginAdmin error:", err);
    return res.status(500).json({ error: true, message: "Server error during admin login" });
  }
};

exports.getAdminProfile = async (req, res) => {
  try {
    const admin = await Admin.findById(req.admin.adminId).select("-password");
    if (!admin) {
      return res.status(404).json({ error: true, message: "Admin not found" });
    }

    return res.status(200).json({
      error: false,
      admin: {
        _id: admin._id,
        fullName: admin.fullName,
        email: admin.email,
        createdAt: admin.createdAt,
      },
      isAdmin: true,
      role: "admin"
    });
  } catch (err) {
    console.error("getAdminProfile error:", err);
    return res.status(500).json({ error: true, message: "Failed to retrieve admin profile" });
  }
};
