import React, { useState, useEffect } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { Shield, PlusCircle, LayoutDashboard, LogIn, LogOut, Menu, X } from "lucide-react";
import "./Navbar.css";

const Navbar = ({ isAuthenticated, userRole, onLogout }) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const navigate = useNavigate();

  // Close mobile menu on Escape key press
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape" && mobileMenuOpen) {
        setMobileMenuOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mobileMenuOpen]);

  // Close menu on resize above mobile breakpoint
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth > 768 && mobileMenuOpen) {
        setMobileMenuOpen(false);
      }
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [mobileMenuOpen]);

  const handleNavClick = () => {
    setMobileMenuOpen(false);
  };

  const handleReportClick = (e) => {
    e.preventDefault();
    setMobileMenuOpen(false);
    if (isAuthenticated) {
      navigate("/dashboard?report=true");
    } else {
      navigate("/auth");
    }
  };

  const handleLogoutClick = () => {
    setMobileMenuOpen(false);
    if (onLogout) {
      onLogout();
    }
  };

  return (
    <header className="navbar-wrapper">
      <nav className="navbar" role="navigation" aria-label="Main Navigation">
        {/* Brand identity: CivicVision AI */}
        <div className="navbar-brand">
          <Link to="/" className="brand-link" onClick={handleNavClick} aria-label="CivicVision AI - Community Issue Reporter">
            <div className="brand-icon-wrapper" aria-hidden="true">
              <Shield size={20} className="brand-shield" />
            </div>
            <div className="brand-text-group">
              <span className="brand-name">
                CivicVision <span className="brand-badge-ai">AI</span>
              </span>
              <span className="brand-subtext">Community Issue Reporter</span>
            </div>
          </Link>
        </div>

        {/* Mobile Hamburger Button */}
        <button
          type="button"
          className="mobile-menu-toggle"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          aria-expanded={mobileMenuOpen}
          aria-controls="primary-nav-links"
          aria-label={mobileMenuOpen ? "Close navigation menu" : "Open navigation menu"}
          data-testid="mobile-nav-toggle"
        >
          {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
        </button>

        {/* Navigation Links */}
        <div
          id="primary-nav-links"
          className={`navbar-links ${mobileMenuOpen ? "mobile-open" : ""}`}
        >
          <NavLink
            to="/"
            end
            className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
            onClick={handleNavClick}
            aria-current={({ isActive }) => (isActive ? "page" : undefined)}
          >
            Home
          </NavLink>

          <button
            type="button"
            className="nav-link report-action-link"
            onClick={handleReportClick}
            data-testid="navbar-report-issue-btn"
          >
            <PlusCircle size={16} aria-hidden="true" />
            <span>Report an Issue</span>
          </button>

          {isAuthenticated ? (
            <>
              <NavLink
                to="/dashboard"
                className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
                onClick={handleNavClick}
                aria-current={({ isActive }) => (isActive ? "page" : undefined)}
              >
                <LayoutDashboard size={16} aria-hidden="true" />
                <span>Dashboard</span>
              </NavLink>
              <button
                type="button"
                onClick={handleLogoutClick}
                className="nav-button logout-btn"
                data-testid="navbar-logout-btn"
              >
                <LogOut size={16} aria-hidden="true" />
                <span>Logout</span>
              </button>
            </>
          ) : (
            <NavLink
              to="/auth"
              className="nav-button login-btn"
              onClick={handleNavClick}
              data-testid="navbar-login-btn"
            >
              <LogIn size={16} aria-hidden="true" />
              <span>Login / Register</span>
            </NavLink>
          )}
        </div>
      </nav>
    </header>
  );
};

export default Navbar;