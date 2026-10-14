const User = require("../models/User");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

exports.registerUser = async (req, res) => {
  try {
    const { fullName, email, password } = req.body;
    if (!fullName || !email || !password) {
      return res.status(400).json({ error: true, message: "All fields are required" });
    }

    const isUser = await User.findOne({ email });
    if (isUser) {
      return res.status(400).json({ error: true, message: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ fullName, email, password: hashedPassword });
    await user.save();

    const accessToken = jwt.sign(
      { userId: user._id, role: "citizen" },
      process.env.JWT_SECRET,
      { expiresIn: "72h" }
    );

    return res.status(201).json({
      error: false,
      message: "User registered",
      user: { id: user._id, fullName: user.fullName, email: user.email },
      accessToken
    });
  } catch (err) {
    console.error("registerUser error:", err);
    return res.status(500).json({ error: true, message: "Server error during registration" });
  }
};

exports.loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: true, message: "Email and password required" });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: true, message: "Invalid credentials" });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: true, message: "Invalid credentials" });
    }

    const accessToken = jwt.sign(
      { userId: user._id, role: "citizen" },
      process.env.JWT_SECRET,
      { expiresIn: "72h" }
    );

    return res.status(200).json({
      error: false,
      message: "Login successful",
      user: { id: user._id, fullName: user.fullName, email: user.email },
      accessToken
    });
  } catch (err) {
    console.error("loginUser error:", err);
    return res.status(500).json({ error: true, message: "Server error during login" });
  }
};

exports.getUserProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select("-password");
    if (!user) {
      return res.status(404).json({ error: true, message: "User not found" });
    }

    return res.status(200).json({
      error: false,
      user: {
        _id: user._id,
        fullName: user.fullName,
        email: user.email,
        createdAt: user.createdAt,
      },
      isAdmin: false,
      role: "citizen"
    });
  } catch (err) {
    console.error("getUserProfile error:", err);
    return res.status(500).json({ error: true, message: "Failed to retrieve user profile" });
  }
};
