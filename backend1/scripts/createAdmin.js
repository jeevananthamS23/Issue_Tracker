/**
 * CivicVision AI — Private Administrator Provisioning CLI Script
 * 
 * Securely provisions administrator accounts directly on the backend.
 * Never exposes credentials over HTTP or in committed repositories.
 * 
 * Usage:
 *   cd backend1
 *   node scripts/createAdmin.js
 *   or: npm run admin:create
 */

require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const readline = require("readline");
const { Writable } = require("stream");
const Admin = require("../models/Admin");

/**
 * Validates email and password against project security requirements.
 */
function validateCredentials(fullName, email, password) {
  if (!fullName || typeof fullName !== "string" || fullName.trim().length === 0) {
    throw new Error("Full name is required.");
  }

  if (!email || typeof email !== "string") {
    throw new Error("Email is required.");
  }

  const normalizedEmail = email.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(normalizedEmail)) {
    throw new Error("Invalid email format.");
  }

  if (!password || typeof password !== "string") {
    throw new Error("Password is required.");
  }

  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters long.");
  }

  const hasLetter = /[a-zA-Z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  if (!hasLetter || !hasNumber) {
    throw new Error("Password must contain at least one letter and at least one number.");
  }

  return { fullName: fullName.trim(), email: normalizedEmail, password };
}

/**
 * Core admin provisioning logic.
 * Usable both via CLI and programmatically in automated test suites.
 */
async function provisionAdmin({ fullName, email, password, mongoUri = process.env.MONGO_URI, closeConnection = true }) {
  const validated = validateCredentials(fullName, email, password);

  if (!mongoUri) {
    throw new Error("Database connection URI (MONGO_URI) is not configured.");
  }

  const shouldConnect = mongoose.connection.readyState === 0;
  if (shouldConnect) {
    await mongoose.connect(mongoUri);
  }

  try {
    // Check if admin already exists
    const existing = await Admin.findOne({ email: validated.email });
    if (existing) {
      throw new Error(`An administrator account with email '${validated.email}' already exists. Implicit overwrites or password resets are not permitted.`);
    }

    // Hash password using the same cost factor (10) as authentication controllers
    const hashedPassword = await bcrypt.hash(validated.password, 10);

    const newAdmin = new Admin({
      fullName: validated.fullName,
      email: validated.email,
      password: hashedPassword,
    });

    await newAdmin.save();

    return {
      success: true,
      adminId: newAdmin._id.toString(),
      fullName: newAdmin.fullName,
      email: newAdmin.email,
    };
  } finally {
    if (shouldConnect && closeConnection) {
      await mongoose.disconnect();
    }
  }
}

/**
 * Prompts user on the terminal while muting echo for sensitive input.
 */
function promptHidden(query) {
  let muted = false;
  const mutableStdout = new Writable({
    write: function(chunk, encoding, callback) {
      if (!muted) {
        process.stdout.write(chunk, encoding);
      }
      callback();
    }
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: mutableStdout,
    terminal: true
  });

  return new Promise((resolve) => {
    rl.question(query, (value) => {
      rl.close();
      process.stdout.write("\n");
      resolve(value);
    });
    muted = true;
  });
}

function promptVisible(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(query, (value) => {
      rl.close();
      resolve(value);
    });
  });
}

/**
 * Interactive CLI runner
 */
async function runCli() {
  console.log("\n=============================================");
  console.log(" CIVICVISION AI — ADMIN PROVISIONING CLI");
  console.log("=============================================\n");

  try {
    const fullName = await promptVisible("Enter administrator full name: ");
    const email = await promptVisible("Enter administrator email: ");
    const password = await promptHidden("Enter administrator password: ");
    const confirmPassword = await promptHidden("Confirm administrator password: ");

    if (password !== confirmPassword) {
      console.error("\n[ERROR] Passwords do not match.");
      process.exit(1);
    }

    console.log("\nConnecting to database and provisioning account...");
    const result = await provisionAdmin({ fullName, email, password });

    console.log("\n[SUCCESS] Administrator account provisioned successfully!");
    console.log(`- ID: ${result.adminId}`);
    console.log(`- Name: ${result.fullName}`);
    console.log(`- Email: ${result.email}\n`);
    process.exit(0);
  } catch (err) {
    console.error(`\n[ERROR] ${err.message}\n`);
    process.exit(1);
  }
}

// Execute when called directly from terminal
if (require.main === module) {
  runCli();
}

module.exports = {
  validateCredentials,
  provisionAdmin,
};
