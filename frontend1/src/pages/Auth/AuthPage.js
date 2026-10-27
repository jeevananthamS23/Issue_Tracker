import React, { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { toast } from "react-toastify";
import API from "../../api/api";
import { Eye, EyeOff, Shield, ArrowLeft } from 'lucide-react';
import "../AuthCss/AuthPage.css";

const AuthPage = ({ setIsAuthenticated }) => {
  const navigate = useNavigate();
  
  // State to track if user is on login or signup view
  const [isLogin, setIsLogin] = useState(true);
  
  // Form state
  const [form, setForm] = useState({
    fullName: "",
    email: "",
    password: ""
  });
  
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // Handle form input changes
  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  // Handle form submission
  const handleSubmit = async (e) => {
    e.preventDefault();

    setSubmitting(true);
    try {
      const endpoint = `/user/${isLogin ? 'login' : 'signup'}`;

      // Create payload (fullName added for citizen signup)
      const payload = isLogin
        ? { email: form.email, password: form.password }
        : { fullName: form.fullName, email: form.email, password: form.password };

      const res = await API.post(endpoint, payload);

      // Store token and show success message
      localStorage.setItem("token", res.data.accessToken);
      setIsAuthenticated(false); // Citizen user
      toast.success(isLogin ? "Citizen login successful!" : "Citizen registration successful!");

      // Redirect to dashboard after successful login/signup
      setTimeout(() => {
        navigate("/dashboard");
      }, 500);
    } catch (err) {
      toast.error(err.response?.data?.message || `${isLogin ? 'Login' : 'Signup'} failed`);
      setSubmitting(false);
    }
  };

  // Toggle between login and signup modes
  const toggleMode = (loginMode) => {
    setIsLogin(loginMode);
  };

  return (
    <div className="auth-page-wrapper">
      <div className="auth-card" role="region" aria-labelledby="auth-heading">
        {/* Top Brand Header */}
        <div className="auth-brand-header">
          <div className="auth-logo-badge" aria-hidden="true">
            <Shield size={24} className="auth-shield-icon" />
          </div>
          <span className="auth-app-title">CivicVision AI</span>
          <span className="auth-app-subtitle">Citizen Infrastructure Reporting Portal</span>
        </div>

        {/* Mode Switcher Tabs */}
        <div className="auth-tabs" role="tablist" aria-label="Authentication Type">
          <button 
            type="button"
            role="tab"
            aria-selected={isLogin}
            aria-controls="auth-form-panel"
            className={`tab ${isLogin ? 'active' : ''}`} 
            onClick={() => toggleMode(true)}
            data-testid="tab-login"
          >
            Citizen Login
          </button>
          <button 
            type="button"
            role="tab"
            aria-selected={!isLogin}
            aria-controls="auth-form-panel"
            className={`tab ${!isLogin ? 'active' : ''}`} 
            onClick={() => toggleMode(false)}
            data-testid="tab-signup"
          >
            Create Account
          </button>
        </div>
        
        <form id="auth-form-panel" onSubmit={handleSubmit} className="auth-form" noValidate={false}>
          <h2 id="auth-heading" className="auth-form-heading">
            {isLogin ? 'Sign In to Your Account' : 'Register as a Community Member'}
          </h2>
          <p className="auth-form-subheading">
            {isLogin 
              ? 'Access your reported issues, vote on local hazards, and track municipal repairs.' 
              : 'Join fellow citizens to report and verify infrastructure defects in your area.'}
          </p>
          
          {/* Full Name field (only for citizen signup) */}
          {!isLogin && (
            <div className="form-group">
              <label htmlFor="auth-fullName" className="field-label">
                Full Name <span className="required-mark" aria-hidden="true">*</span>
              </label>
              <input
                type="text"
                id="auth-fullName"
                name="fullName"
                placeholder="e.g., Aravind Kumar"
                value={form.fullName}
                onChange={handleChange}
                autoComplete="name"
                required
                className="civic-input"
              />
            </div>
          )}
          
          {/* Email field (for all forms) */}
          <div className="form-group">
            <label htmlFor="auth-email" className="field-label">
              Email Address <span className="required-mark" aria-hidden="true">*</span>
            </label>
            <input
              type="email"
              id="auth-email"
              name="email"
              placeholder="e.g., citizen@example.com"
              value={form.email}
              onChange={handleChange}
              autoComplete="email"
              required
              className="civic-input"
            />
          </div>
          
          {/* Password field (for all forms) */}
          <div className="form-group password-field">
            <div className="label-row">
              <label htmlFor="auth-password" className="field-label">
                Password <span className="required-mark" aria-hidden="true">*</span>
              </label>
            </div>
            <div className="input-with-button">
              <input
                type={showPassword ? "text" : "password"}
                id="auth-password"
                name="password"
                placeholder="Enter your password"
                value={form.password}
                onChange={handleChange}
                autoComplete={isLogin ? "current-password" : "new-password"}
                required
                className="civic-input"
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? "Hide password text" : "Show password text"}
              >
                {showPassword ? <Eye size={18} aria-hidden="true" /> : <EyeOff size={18} aria-hidden="true" />}
              </button>
            </div>
          </div>
          
          {/* Submit button */}
          <button 
            type="submit" 
            className="auth-submit-btn" 
            disabled={submitting}
            data-testid="auth-submit-btn"
          >
            {submitting && <span className="btn-spinner" aria-hidden="true"></span>}
            <span>{submitting ? "Processing..." : (isLogin ? 'Sign In' : 'Create Citizen Account')}</span>
          </button>

          {/* Switch between login/signup */}
          <div className="toggle-prompt">
            <span>{isLogin ? "New to CivicVision AI? " : "Already registered? "}</span>
            <button 
              type="button" 
              className="toggle-btn" 
              onClick={() => toggleMode(!isLogin)}
            >
              {isLogin ? 'Create an account' : 'Sign in here'}
            </button>
          </div>
        </form>

        <div className="auth-footer-link">
          <Link to="/" className="back-home-link">
            <ArrowLeft size={16} />
            <span>Return to Public Home</span>
          </Link>
        </div>
      </div>
    </div>
  );
};

export default AuthPage;