const User = require("../models/User");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

exports.registerUser = async (req, res) => {
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

  const accessToken = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: "72h" });

  return res.status(201).json({ error: false, message: "User registered", user: { fullName, email }, accessToken });
};

exports.loginUser = async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: "Email and password required" });

  const user = await User.findOne({ email });
  if (!user) return res.status(400).json({ message: "User not found" });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(400).json({ message: "Invalid credentials" });

  const accessToken = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: "72h" });
  return res.status(200).json({ message: "Login successful", user: { fullName: user.fullName, email: user.email }, accessToken });
};
