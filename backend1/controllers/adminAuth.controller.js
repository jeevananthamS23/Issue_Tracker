const Admin = require("../models/Admin");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken"); 

exports.registerAdmin = async (req, res) => {
  const { fullName, email, password, adminKey } = req.body;

  if (!fullName || !email || !password || !adminKey) {
    return res.status(400).json({ error: true, message: "All fields including admin key are required" });
  }

  if (adminKey !== process.env.ADMIN_SECRET_KEY) {
    return res.status(403).json({ error: true, message: "Invalid Admin Key" });
  }

  const isAdmin = await Admin.findOne({ email });
  if (isAdmin) {
    return res.status(400).json({ error: true, message: "Admin already exists" });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const admin = new Admin({ fullName, email, password: hashedPassword });
  await admin.save();

  const accessToken = jwt.sign({ adminId: admin._id }, process.env.JWT_SECRET, { expiresIn: "72h" });

  return res.status(201).json({ error: false, message: "Admin registered", admin: { fullName, email }, accessToken });
};

exports.loginAdmin = async (req, res) => {
  const { email, password, adminKey } = req.body;

  if (!email || !password || !adminKey) {
    return res.status(400).json({ message: "Email, password, and admin key required" });
  }

  if (adminKey !== process.env.ADMIN_SECRET_KEY) {
    return res.status(403).json({ message: "Invalid Admin Key" });
  }

  const admin = await Admin.findOne({ email });
  if (!admin) return res.status(400).json({ message: "Admin not found" });

  const valid = await bcrypt.compare(password, admin.password);
  if (!valid) return res.status(400).json({ message: "Invalid credentials" });

  const accessToken = jwt.sign({ adminId: admin._id }, process.env.JWT_SECRET, { expiresIn: "72h" });

  return res.status(200).json({ message: "Login successful", admin: { fullName: admin.fullName, email: admin.email }, accessToken });
};
