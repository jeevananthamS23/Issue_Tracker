import React, { useState, useEffect } from "react";
import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import Auth from "./pages/Auth/AuthPage";
import HomePage from "./pages/HomePage";
import Dashboard from "./pages/Dashboard";
import AdminDashboard from "./pages/AdminDashboard";
import Navbar from "./pages/Navbar";
import API from "./api/api";
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
          // Fetch user profile to determine role
          const response = await API.get("/user/profile");
          setIsAuthenticated(true);
          setUserRole(response.data.isAdmin ? "admin" : "user");
        } catch (error) {
          // Handle invalid token
          localStorage.removeItem("token");
          setIsAuthenticated(false);
          setUserRole(null);
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
                  (userRole === "admin" ? <Navigate to="/admin" /> : <Navigate to="/dashboard" />) : 
                  <Auth setIsAuthenticated={handleAuthentication} />
              } 
            />
            <Route 
              path="/dashboard" 
              element={
                isAuthenticated ? 
                  (userRole === "admin" ? <Navigate to="/admin" /> : <Dashboard />) : 
                  <Navigate to="/auth" />
              } 
            />
            <Route 
              path="/admin" 
              element={
                isAuthenticated && userRole === "admin" ? 
                  <AdminDashboard /> : 
                  (isAuthenticated ? <Navigate to="/dashboard" /> : <Navigate to="/auth" />)
              } 
            />
          </Routes>
        </div>
      </div>
    </Router>
  );
}

export default App;