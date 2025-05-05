import React from "react";
import { Link } from "react-router-dom";
import "./Navbar.css";

const Navbar = ({ isAuthenticated, onLogout }) => {
  return (
    <nav className="navbar">
      <div className="navbar-logo">
        <Link to="/">Community Issue Reporter</Link>
      </div>
      <div className="navbar-links">
        <Link to="/" className="nav-link">Home</Link>
        {isAuthenticated ? (
          <>
            <Link to="/dashboard" className="nav-link">Dashboard</Link>
            <button onClick={onLogout} className="nav-button">Logout</button>
          </>
        ) : (
          <Link to="/auth" className="nav-button">Login/Register</Link>
        )}
      </div>
    </nav>
  );
};

export default Navbar;