import React, { useState, useEffect } from "react";
import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import { ToastContainer } from "react-toastify";
import Auth from "./pages/Auth/AuthPage";
import HomePage from "./pages/HomePage";
import Dashboard from "./pages/Dashboard";
import Navbar from "./pages/Navbar";
import API from "./api/api";
import "react-toastify/dist/ReactToastify.css";
import "./App.css";

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [userRole, setUserRole] = useState(null); // 'user' or 'admin'
  const [loading, setLoading] = useState(true);
  
  // Check if token exists and get user role on component mount
  useEffect(() => {
    const checkAuthStatus = async () => {
      const token = localStorage.getItem("token");
      if (token) {
        try {
          // Attempt to fetch citizen profile
          const response = await API.get("/user/profile");
          setIsAuthenticated(true);
          setUserRole(response.data.isAdmin ? "admin" : "user");
        } catch (error) {
          // If citizen route returns 403 Forbidden, the token belongs to an administrator
          if (error.response && error.response.status === 403) {
            try {
              await API.get("/admin/profile");
              setIsAuthenticated(true);
              setUserRole("admin");
              setLoading(false);
              return;
            } catch (adminErr) {
              if (adminErr.response && (adminErr.response.status === 401 || adminErr.response.status === 403)) {
                localStorage.removeItem("token");
                setIsAuthenticated(false);
                setUserRole(null);
              }
            }
          } else if (error.response && error.response.status === 401) {
            // Invalid or expired credentials: clear session
            localStorage.removeItem("token");
            setIsAuthenticated(false);
            setUserRole(null);
          } else {
            // Server outage or network error: preserve token so user isn't logged out
            console.warn("Could not verify session due to a network error:", error.message);
          }
        }
      }
      setLoading(false);
    };

    checkAuthStatus();
  }, []);

  // Function to handle logout
  const handleLogout = () => {
    localStorage.removeItem("token");
    setIsAuthenticated(false);
    setUserRole(null);
  };

  // Function to update auth state after login
  const handleAuthentication = (isAdmin) => {
    setIsAuthenticated(true);
    setUserRole(isAdmin ? "admin" : "user");
  };

  if (loading) {
    return <div className="loading">Loading...</div>;
  }

  return (
    <Router>
      <div className="app-container">
        <ToastContainer
          position="top-right"
          autoClose={3500}
          hideProgressBar={false}
          newestOnTop
          closeOnClick
          pauseOnHover
          theme="colored"
        />
        <Navbar
          isAuthenticated={isAuthenticated}
          userRole={userRole}
          onLogout={handleLogout}
        />
        <div className="content">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route 
              path="/auth" 
              element={
                isAuthenticated ? 
                  <Navigate to="/dashboard" /> : 
                  <Auth setIsAuthenticated={handleAuthentication} />
              } 
            />
            <Route 
              path="/dashboard" 
              element={
                isAuthenticated ? 
                  <Dashboard /> : 
                  <Navigate to="/auth" />
              } 
            />
            {/* Legacy admin route redirects to dashboard in citizen app */}
            <Route path="/admin" element={<Navigate to="/dashboard" />} />
          </Routes>
        </div>
      </div>
    </Router>
  );
}

export default App;