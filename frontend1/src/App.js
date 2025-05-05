import React, { useState, useEffect } from "react";
import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import Auth from "./pages/Auth/AuthPage";
import HomePage from "./pages/HomePage";
import Dashboard from "./pages/Dashboard";
import Navbar from "./pages/Navbar";
import "./App.css";

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  
  // Check if token exists on component mount
  useEffect(() => {
    const token = localStorage.getItem("token");
    if (token) {
      setIsAuthenticated(true);
    }
  }, []);

  // Function to handle logout
  const handleLogout = () => {
    localStorage.removeItem("token");
    setIsAuthenticated(false);
  };

  return (
    <Router>
      <div className="app-container">
        <Navbar isAuthenticated={isAuthenticated} onLogout={handleLogout} />
        <div className="content">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route 
              path="/auth" 
              element={isAuthenticated ? <Navigate to="/dashboard" /> : <Auth setIsAuthenticated={setIsAuthenticated} />} 
            />
            <Route 
              path="/dashboard" 
              element={isAuthenticated ? <Dashboard /> : <Navigate to="/auth" />} 
            />
          </Routes>
        </div>
      </div>
    </Router>
  );
}

export default App;