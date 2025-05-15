import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import API from "../../api/api";
import "../AuthCss/AuthPage.css";

const AuthPage = ({ setIsAuthenticated }) => {
  const navigate = useNavigate();
  
  // State to track if user is on login or signup view
  const [isLogin, setIsLogin] = useState(true);
  // State to track if user is admin or regular user
  const [isAdmin, setIsAdmin] = useState(false);
  
  // Form state with all possible fields
  const [form, setForm] = useState({
    fullName: "",
    email: "",
    password: "",
    adminKey: ""
  });
  
  // Response message state
  const [message, setMessage] = useState("");

  // Handle form input changes
  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  // Handle form submission
  const handleSubmit = async (e) => {
    e.preventDefault();
    
    try {
      // Determine the endpoint based on user type and action
      const endpoint = `/${isAdmin ? 'admin' : 'user'}/${isLogin ? 'login' : 'signup'}`;
      
      // Create payload object based on form type
      const payload = isAdmin 
        ? { email: form.email, password: form.password, ...(isLogin ? {} : { fullName: form.fullName }), adminKey: form.adminKey }
        : { email: form.email, password: form.password, ...(isLogin ? {} : { fullName: form.fullName }) };
      
      const res = await API.post(endpoint, payload);
      
      // Store token and show success message
      localStorage.setItem("token", res.data.accessToken);
      setIsAuthenticated(isAdmin); // Pass isAdmin flag to the parent component
      setMessage(`${isAdmin ? 'Admin' : 'User'} ${isLogin ? 'login' : 'signup'} successful!`);
      
      // Redirect to dashboard after successful login/signup
      setTimeout(() => {
        navigate(isAdmin ? "/admin" : "/dashboard");
      }, 1000);
    } catch (err) {
      setMessage(err.response?.data?.message || `${isLogin ? 'Login' : 'Signup'} failed`);
    }
  };

  // Toggle between login and signup modes
  const toggleMode = () => {
    setIsLogin(!isLogin);
    setMessage(""); // Clear any existing messages
  };
  
  // Toggle between user and admin modes
  const toggleUserType = () => {
    setIsAdmin(!isAdmin);
    setMessage(""); // Clear any existing messages
  };

  return (
    <div className="auth-container">
      <div className="auth-tabs">
        <button 
          className={`tab ${isLogin ? 'active' : ''}`} 
          onClick={() => setIsLogin(true)}
        >
          Login
        </button>
        <button 
          className={`tab ${!isLogin ? 'active' : ''}`} 
          onClick={() => setIsLogin(false)}
        >
          Sign Up
        </button>
      </div>
      
      <div className="user-type-toggle">
        <input
          type="checkbox"
          id="adminToggle"
          checked={isAdmin}
          onChange={toggleUserType}
        />
        <label htmlFor="adminToggle">Admin Mode</label>
      </div>
      
      <form onSubmit={handleSubmit}>
        <h2>{isAdmin ? 'Admin' : 'User'} {isLogin ? 'Login' : 'Signup'}</h2>
        
        {/* Full Name field (only for signup) */}
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
        <div className="form-group">
          <input
            type="password"
            name="password"
            placeholder="Password"
            value={form.password}
            onChange={handleChange}
            required
          />
        </div>
        
        {/* Admin Key field (only for admin) */}
        {isAdmin && (
          <div className="form-group">
            <input
              type="password"
              name="adminKey"
              placeholder="Admin Key"
              value={form.adminKey}
              onChange={handleChange}
              required
            />
          </div>
        )}
        
        {/* Submit button */}
        <button type="submit" className="submit-btn">
          {isLogin ? 'Login' : 'Sign Up'}
        </button>
        
        {/* Message display */}
        {message && <p className="message">{message}</p>}
        
        {/* Switch between login/signup */}
        <p className="toggle-prompt">
          {isLogin ? "Don't have an account? " : "Already have an account? "}
          <button 
            type="button" 
            className="toggle-btn" 
            onClick={toggleMode}
          >
            {isLogin ? 'Sign Up' : 'Login'}
          </button>
        </p>
      </form>
    </div>
  );
};

export default AuthPage;