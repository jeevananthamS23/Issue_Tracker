import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "react-toastify";
import API from "../../api/api";
import { Eye, EyeOff } from 'lucide-react';
import "../AuthCss/AuthPage.css";

const AuthPage = ({ setIsAuthenticated }) => {
  const navigate = useNavigate();
  
  // State to track if user is on login or signup view
  const [isLogin, setIsLogin] = useState(true);
  // State to track if user is admin or regular user (admin mode only allowed for login)
  const [isAdmin, setIsAdmin] = useState(false);
  
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

    if (isAdmin && !isLogin) {
      toast.error("Public administrator registration is disabled.");
      return;
    }

    setSubmitting(true);
    try {
      // Determine the endpoint based on user type and action
      const endpoint = `/${isAdmin ? 'admin' : 'user'}/${isLogin ? 'login' : 'signup'}`;

      // Create payload object based on form type (email & password for login/admin, fullName added for citizen signup)
      const payload = isLogin
        ? { email: form.email, password: form.password }
        : { fullName: form.fullName, email: form.email, password: form.password };

      const res = await API.post(endpoint, payload);

      // Store token and show success message
      localStorage.setItem("token", res.data.accessToken);
      setIsAuthenticated(isAdmin); // Pass isAdmin flag to the parent component
      toast.success(`${isAdmin ? 'Admin' : 'User'} ${isLogin ? 'login' : 'signup'} successful!`);

      // Redirect to dashboard after successful login/signup
      setTimeout(() => {
        navigate(isAdmin ? "/admin" : "/dashboard");
      }, 1000);
    } catch (err) {
      toast.error(err.response?.data?.message || `${isLogin ? 'Login' : 'Signup'} failed`);
      setSubmitting(false);
    }
  };

  // Toggle between login and signup modes
  const toggleMode = (loginMode) => {
    setIsLogin(loginMode);
    if (!loginMode) {
      // Admin accounts cannot be created publicly; automatically turn off admin mode on signup
      setIsAdmin(false);
    }
  };

  // Toggle between user and admin modes (only available in login mode)
  const toggleUserType = () => {
    setIsAdmin(!isAdmin);
  };

  return (
    <div className="auth-container">
      <div className="auth-tabs">
        <button 
          className={`tab ${isLogin ? 'active' : ''}`} 
          onClick={() => toggleMode(true)}
        >
          Login
        </button>
        <button 
          className={`tab ${!isLogin ? 'active' : ''}`} 
          onClick={() => toggleMode(false)}
        >
          Sign Up
        </button>
      </div>
      
      {isLogin && (
        <div className="user-type-toggle">
          <input
            type="checkbox"
            id="adminToggle"
            checked={isAdmin}
            onChange={toggleUserType}
          />
          <label htmlFor="adminToggle">Admin Mode</label>
        </div>
      )}
      
      <form onSubmit={handleSubmit}>
        <h2>{isAdmin ? 'Admin Login' : (isLogin ? 'Citizen Login' : 'Citizen Sign Up')}</h2>
        
        {/* Full Name field (only for citizen signup) */}
        {!isLogin && (
          <div className="form-group">
            <input
              type="text"
              name="fullName"
              placeholder="Full Name"
              value={form.fullName}
              onChange={handleChange}
              required
            />
          </div>
        )}
        
        {/* Email field (for all forms) */}
        <div className="form-group">
          <input
            type="email"
            name="email"
            placeholder="Email"
            value={form.email}
            onChange={handleChange}
            required
          />
        </div>
        
        {/* Password field (for all forms) */}
        <div className="form-group password-field">
          <input
            type={showPassword ? "text" : "password"}
            name="password"
            placeholder="Password"
            value={form.password}
            onChange={handleChange}
            required
          />
          <button
            type="button"
            className="password-toggle"
            onClick={() => setShowPassword(!showPassword)}
          >
            {showPassword ? <Eye size={18} /> : <EyeOff size={18} />}
          </button>
        </div>
        
        {/* Submit button */}
        <button type="submit" className="submit-btn" disabled={submitting}>
          {submitting && <span className="btn-spinner"></span>}
          {submitting ? "Please wait..." : (isLogin ? 'Login' : 'Sign Up')}
        </button>

        {/* Switch between login/signup */}
        <p className="toggle-prompt">
          {isLogin ? "Don't have an account? " : "Already have an account? "}
          <button 
            type="button" 
            className="toggle-btn" 
            onClick={() => toggleMode(!isLogin)}
          >
            {isLogin ? 'Sign Up' : 'Login'}
          </button>
        </p>
      </form>
    </div>
  );
};

export default AuthPage;