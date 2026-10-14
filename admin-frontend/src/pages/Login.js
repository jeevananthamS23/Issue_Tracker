import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAdminAuth } from "../context/AdminAuthContext";
import { ShieldCheck, Eye, EyeOff, Lock, Mail, AlertCircle } from "lucide-react";
import "./Login.css";

const Login = () => {
  const navigate = useNavigate();
  const { login, isAuthenticated } = useAdminAuth();

  const [formData, setFormData] = useState({
    email: "",
    password: "",
  });
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});

  // If already authenticated, redirect immediately
  React.useEffect(() => {
    if (isAuthenticated) {
      navigate("/dashboard", { replace: true });
    }
  }, [isAuthenticated, navigate]);

  const validate = () => {
    const errors = {};
    if (!formData.email.trim()) {
      errors.email = "Administrator email is required.";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email.trim())) {
      errors.email = "Please enter a valid email address.";
    }

    if (!formData.password) {
      errors.password = "Password is required.";
    }
    return errors;
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    if (fieldErrors[name]) {
      setFieldErrors((prev) => ({ ...prev, [name]: "" }));
    }
    if (errorMessage) {
      setErrorMessage("");
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const errors = validate();
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setSubmitting(true);
    setErrorMessage("");

    try {
      const result = await login(formData.email.trim(), formData.password);
      if (result.success) {
        navigate("/dashboard", { replace: true });
      } else {
        setErrorMessage(result.error || "Authentication failed. Please verify your credentials.");
      }
    } catch {
      setErrorMessage("An unexpected network error occurred. Please verify backend connectivity.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="admin-login-container">
      <div className="admin-login-card">
        <div className="admin-login-header">
          <div className="brand-badge">
            <ShieldCheck size={28} className="shield-icon" />
            <span className="brand-name">CivicVision AI</span>
          </div>
          <h1 className="portal-title">Administrator Portal</h1>
          <p className="portal-subtitle">
            Secure access for authorized municipal staff and city managers.
          </p>
        </div>

        {errorMessage && (
          <div className="alert-banner error" role="alert" data-testid="login-error-alert">
            <AlertCircle size={18} className="alert-icon" />
            <span>{errorMessage}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="admin-login-form" noValidate>
          <div className="form-group">
            <label htmlFor="admin-email">Admin Email Address</label>
            <div className={`input-wrapper ${fieldErrors.email ? "input-error" : ""}`}>
              <Mail size={18} className="input-icon" />
              <input
                id="admin-email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="admin@civicvision.gov"
                value={formData.email}
                onChange={handleChange}
                disabled={submitting}
                aria-invalid={!!fieldErrors.email}
                aria-describedby={fieldErrors.email ? "admin-email-error" : undefined}
                required
              />
            </div>
            {fieldErrors.email && (
              <span id="admin-email-error" className="error-text">
                {fieldErrors.email}
              </span>
            )}
          </div>

          <div className="form-group">
            <label htmlFor="admin-password">Password</label>
            <div className={`input-wrapper ${fieldErrors.password ? "input-error" : ""}`}>
              <Lock size={18} className="input-icon" />
              <input
                id="admin-password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                placeholder="Enter admin password"
                value={formData.password}
                onChange={handleChange}
                disabled={submitting}
                aria-invalid={!!fieldErrors.password}
                aria-describedby={fieldErrors.password ? "admin-password-error" : undefined}
                required
              />
              <button
                type="button"
                className="toggle-password-btn"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                tabIndex={0}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            {fieldErrors.password && (
              <span id="admin-password-error" className="error-text">
                {fieldErrors.password}
              </span>
            )}
          </div>

          <button
            type="submit"
            className="btn-submit-login"
            disabled={submitting}
            data-testid="login-submit-button"
          >
            {submitting ? (
              <span className="btn-loading">
                <span className="spinner-sm"></span> Authenticating...
              </span>
            ) : (
              "Sign In to Admin Portal"
            )}
          </button>
        </form>

        <div className="security-notice-panel">
          <p className="security-notice-title">Private Administrative Console</p>
          <p className="security-notice-body">
            Public registration is strictly disabled. New administrator accounts must be provisioned internally by an authorized system administrator via the backend CLI tool.
          </p>
        </div>
      </div>
    </div>
  );
};

export default Login;
