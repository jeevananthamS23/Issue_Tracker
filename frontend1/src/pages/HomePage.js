import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import { toast } from "react-toastify";
import {
  Shield,
  PlusCircle,
  MapPin,
  Camera,
  CheckCircle2,
  AlertCircle,
  ThumbsUp,
  Check,
  Layers,
  Sparkles,
  ArrowRight,
  RefreshCw,
  AlertTriangle,
  CameraOff,
  Droplets
} from "lucide-react";
import API, { Auth, VoteService, getImageUrl } from "../api/api";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import icon from "leaflet/dist/images/marker-icon.png";
import iconShadow from "leaflet/dist/images/marker-shadow.png";
import "./HomePage.css";

// Fix Leaflet default icon issue
let defaultIcon = L.icon({
  iconUrl: icon,
  shadowUrl: iconShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
});

L.Marker.prototype.options.icon = defaultIcon;

// Custom marker icons based on issue status (WCAG-aligned colors)
const getStatusIcon = (status) => {
  const colors = {
    reported: "#1d4ed8",   // Civic Navy/Blue
    "in-progress": "#b45309", // Amber/Gold
    resolved: "#15803d",   // Forest Green
  };

  const bg = colors[status] || "#1d4ed8";

  return L.divIcon({
    className: "custom-civic-marker",
    html: `<div style="background-color: ${bg}; width: 16px; height: 16px; border-radius: 50%; border: 2.5px solid #ffffff; box-shadow: 0 1px 4px rgba(0,0,0,0.35);"></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
    popupAnchor: [0, -12],
  });
};

const HomePage = () => {
  const navigate = useNavigate();
  const [issues, setIssues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [votedIssues, setVotedIssues] = useState(new Set());
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all"); // 'all' | 'reported' | 'in-progress' | 'resolved'
  const [failedImages, setFailedImages] = useState(new Set());

  // Category Icon helper for issue cards and map popups
  const getCategoryIcon = (type) => {
    const t = (type || "").toLowerCase();
    if (t.includes("pothole") || t.includes("road")) {
      return <AlertTriangle size={24} className="fallback-icon" aria-hidden="true" />;
    }
    if (t.includes("light")) {
      return <Sparkles size={24} className="fallback-icon" aria-hidden="true" />;
    }
    if (t.includes("water") || t.includes("drain") || t.includes("leak") || t.includes("pump")) {
      return <Droplets size={24} className="fallback-icon" aria-hidden="true" />;
    }
    if (t.includes("garbage") || t.includes("waste") || t.includes("sanitat")) {
      return <Layers size={24} className="fallback-icon" aria-hidden="true" />;
    }
    return <CameraOff size={24} className="fallback-icon" aria-hidden="true" />;
  };

  const getCategoryLabel = (type) => {
    const t = (type || "").toLowerCase();
    if (t.includes("pothole") || t.includes("road")) return "Road Hazard";
    if (t.includes("light")) return "Streetlight Malfunction";
    if (t.includes("water") || t.includes("drain") || t.includes("leak") || t.includes("pump")) return "Water & Drainage";
    if (t.includes("garbage") || t.includes("waste") || t.includes("sanitat")) return "Sanitation Defect";
    return type || "Civic Defect";
  };

  // Default map center (Erode City reference coordinates)
  const defaultCenter = [11.342423, 77.728165];

  const fetchIssues = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await API.get("/issues");
      const data = Array.isArray(response.data)
        ? response.data
        : response.data?.issues || [];
      setIssues(data);
    } catch (err) {
      console.error("Error fetching community issues:", err);
      setError("Failed to load community issues. Please check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchUserVotes = useCallback(async () => {
    if (Auth.isAuthenticated()) {
      try {
        const response = await VoteService.getUserVotedIssues();
        if (response.data && response.data.success && response.data.votedIssueIds) {
          setVotedIssues(new Set(response.data.votedIssueIds));
        }
      } catch (err) {
        console.warn("Could not fetch user votes:", err.message);
      }
    }
  }, []);

  useEffect(() => {
    setIsAuthenticated(Auth.isAuthenticated());
    fetchIssues();
    fetchUserVotes();
  }, [fetchIssues, fetchUserVotes]);

  const handleReportNavigation = () => {
    if (isAuthenticated) {
      navigate("/dashboard?report=true");
    } else {
      navigate("/auth");
    }
  };

  const handleVote = async (issueId) => {
    if (!isAuthenticated) {
      toast.info("Please log in to vote on community issues.");
      navigate("/auth");
      return;
    }

    try {
      const response = await VoteService.voteForIssue(issueId);
      if (response.data && response.data.success) {
        setIssues((prevIssues) =>
          prevIssues.map((issue) =>
            issue._id === issueId ? { ...issue, votes: response.data.votes } : issue
          )
        );
        setVotedIssues((prev) => new Set([...prev, issueId]));
        toast.success("Vote recorded! Thank you for validating this incident.");
      } else {
        toast.error(response.data?.message || "Could not record vote.");
      }
    } catch (err) {
      console.error("Error voting:", err);
      const msg = err.response?.data?.message || "Failed to submit your vote. Please try again.";
      toast.error(msg);
    }
  };

  // Filter issues based on active status filter
  const filteredIssues = useMemo(() => {
    if (statusFilter === "all") return issues;
    return issues.filter((issue) => issue.status === statusFilter);
  }, [issues, statusFilter]);

  // Aggregate community statistics from real data
  const stats = useMemo(() => {
    return {
      total: issues.length,
      reported: issues.filter((i) => i.status === "reported").length,
      inProgress: issues.filter((i) => i.status === "in-progress").length,
      resolved: issues.filter((i) => i.status === "resolved").length,
    };
  }, [issues]);

  return (
    <div className="home-container">
      {/* --------------------------------------------------------------------
          SECTION 1: HERO & PRODUCT INTRODUCTION
          -------------------------------------------------------------------- */}
      <section className="hero-section" aria-labelledby="hero-heading">
        <div className="hero-content">
          <div className="portal-badge" data-testid="portal-badge">
            <Shield size={14} className="portal-badge-icon" aria-hidden="true" />
            <span>CivicVision AI • Municipal Public Infrastructure Portal</span>
          </div>

          <h1 id="hero-heading" className="hero-title">
            Report Local Issues.<br />
            <span className="hero-highlight">Help Improve Your Community.</span>
          </h1>

          <p className="hero-subtitle">
            Report road damage, sanitation defects, and utility outages. Follow reported incidents,
            validate priority through community votes, and track municipal repair progress in one transparent place.
          </p>

          <div className="hero-actions">
            <button
              type="button"
              className="primary-action-btn"
              onClick={handleReportNavigation}
              data-testid="hero-report-btn"
            >
              <PlusCircle size={18} aria-hidden="true" />
              <span>Report an Issue</span>
            </button>

            <a href="#community-map" className="secondary-action-btn">
              <MapPin size={18} aria-hidden="true" />
              <span>View Community Map</span>
            </a>
          </div>

          {/* Quick Metrics Strip based on real backend data */}
          <div className="hero-metrics-strip" aria-label="Real-time Community Status Snapshot">
            <div className="metric-pill">
              <span className="metric-num">{stats.total}</span>
              <span className="metric-txt">Total Reported</span>
            </div>
            <div className="metric-divider" />
            <div className="metric-pill">
              <span className="metric-num in-progress-num">{stats.inProgress}</span>
              <span className="metric-txt">Under Investigation</span>
            </div>
            <div className="metric-divider" />
            <div className="metric-pill">
              <span className="metric-num resolved-num">{stats.resolved}</span>
              <span className="metric-txt">Resolved</span>
            </div>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------------------
          SECTION 2: HOW THE PLATFORM WORKS
          -------------------------------------------------------------------- */}
      <section className="how-it-works-section" aria-labelledby="workflow-heading">
        <div className="section-header-centered">
          <span className="section-eyebrow">Public Service Workflow</span>
          <h2 id="workflow-heading" className="section-title">How CivicVision AI Works</h2>
          <p className="section-description">
            Three simple steps to connect community observations directly with municipal public works departments.
          </p>
        </div>

        <div className="workflow-grid">
          <div className="workflow-card">
            <div className="step-badge">1</div>
            <div className="workflow-icon-box">
              <AlertCircle size={24} />
            </div>
            <h3>Report an Incident</h3>
            <p>
              Select the defect category—such as potholes, blocked drainage, or streetlight outages—and describe
              the issue and local landmarks.
            </p>
          </div>

          <div className="workflow-card">
            <div className="step-badge">2</div>
            <div className="workflow-icon-box">
              <Camera size={24} />
            </div>
            <h3>Geotag & Photo Evidence</h3>
            <p>
              Attach a photo. Location coordinates can be read automatically from photo GPS or watermarks, or adjusted
              manually on the map.
            </p>
          </div>

          <div className="workflow-card">
            <div className="step-badge">3</div>
            <div className="workflow-icon-box">
              <CheckCircle2 size={24} />
            </div>
            <h3>Track Municipal Progress</h3>
            <p>
              Follow real-time status updates as municipal crews triage, review duplicates, and complete field repairs.
            </p>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------------------
          SECTION 3: PUBLIC ISSUE MAP
          -------------------------------------------------------------------- */}
      <section id="community-map" className="map-section" aria-labelledby="map-heading">
        <div className="map-section-header">
          <div>
            <span className="section-eyebrow">Geographic Incident Overview</span>
            <h2 id="map-heading" className="section-title">Active Community Issue Map</h2>
            <p className="section-description">
              Explore reported public infrastructure defects across your municipal ward. Click any pin to view details and vote.
            </p>
          </div>

          <div className="map-header-actions">
            <button
              type="button"
              className="btn-refresh"
              onClick={fetchIssues}
              disabled={loading}
              title="Refresh Map Data"
              aria-label="Refresh Map Data"
            >
              <RefreshCw size={16} className={loading ? "spin" : ""} />
              <span>Refresh Map</span>
            </button>
          </div>
        </div>

        {/* Status Legend */}
        <div className="map-legend" role="region" aria-label="Issue Status Legend">
          <div className="legend-item">
            <span className="legend-dot reported-dot" aria-hidden="true" />
            <span className="legend-label">Reported ({stats.reported})</span>
          </div>
          <div className="legend-item">
            <span className="legend-dot in-progress-dot" aria-hidden="true" />
            <span className="legend-label">In Progress ({stats.inProgress})</span>
          </div>
          <div className="legend-item">
            <span className="legend-dot resolved-dot" aria-hidden="true" />
            <span className="legend-label">Resolved ({stats.resolved})</span>
          </div>
          <span className="legend-hint">Scroll down to inspect recent issue list</span>
        </div>

        {loading ? (
          <div className="map-state-container loading-state">
            <div className="spinner" />
            <p>Loading community incident map...</p>
          </div>
        ) : error ? (
          <div className="map-state-container error-state">
            <AlertCircle size={32} className="error-icon" />
            <p>{error}</p>
            <button type="button" className="retry-btn" onClick={fetchIssues}>
              Retry Loading Map
            </button>
          </div>
        ) : (
          <div className="map-frame">
            <MapContainer
              center={defaultCenter}
              zoom={13}
              scrollWheelZoom={false}
              style={{ height: "460px", width: "100%" }}
            >
              <TileLayer
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              />

              {issues
                .filter((issue) => issue.location && typeof issue.location.lat === "number" && typeof issue.location.lng === "number")
                .map((issue) => (
                  <Marker
                    key={issue._id}
                    position={[issue.location.lat, issue.location.lng]}
                    icon={getStatusIcon(issue.status)}
                  >
                    <Popup>
                      <div className="civic-popup">
                        <div className="popup-header">
                          <span className={`status-pill status-${issue.status}`}>
                            {issue.status === "in-progress" ? "In Progress" : issue.status}
                          </span>
                          <span className="popup-type">{issue.type}</span>
                        </div>

                        <p className="popup-description">{issue.description}</p>

                        {issue.imageUrl && !failedImages.has(issue._id) ? (
                          <img
                            src={getImageUrl(issue.imageUrl)}
                            alt={issue.type}
                            className="popup-image"
                            loading="lazy"
                            onError={() => setFailedImages((prev) => new Set([...prev, issue._id]))}
                          />
                        ) : (
                          <div className="popup-image-fallback" aria-label={`No photo for ${issue.type}`}>
                            {getCategoryIcon(issue.type)}
                            <span>{getCategoryLabel(issue.type)}</span>
                          </div>
                        )}

                        <div className="popup-footer">
                          <span className="popup-date">
                            {new Date(issue.createdAt).toLocaleDateString()}
                          </span>

                          <div className="popup-vote-action">
                            {isAuthenticated && votedIssues.has(issue._id) ? (
                              <span className="voted-tag">
                                <Check size={12} /> Voted ({issue.votes || 0})
                              </span>
                            ) : (
                              <button
                                type="button"
                                className="popup-vote-btn"
                                onClick={() => handleVote(issue._id)}
                              >
                                <ThumbsUp size={12} /> Vote ({issue.votes || 0})
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </Popup>
                  </Marker>
                ))}
            </MapContainer>
          </div>
        )}
      </section>

      {/* --------------------------------------------------------------------
          SECTION 4: RECENT COMMUNITY ISSUES FEED
          -------------------------------------------------------------------- */}
      <section className="feed-section" aria-labelledby="feed-heading">
        <div className="feed-header-row">
          <div>
            <span className="section-eyebrow">Real-Time Community Reports</span>
            <h2 id="feed-heading" className="section-title">Recent Community Reports</h2>
            <p className="section-description">
              Browse public infrastructure defect reports submitted by citizens across the municipality.
            </p>
          </div>

          {/* Filter Pills */}
          <div className="filter-pill-group" role="tablist" aria-label="Filter by Status">
            <button
              type="button"
              className={`filter-pill ${statusFilter === "all" ? "active" : ""}`}
              onClick={() => setStatusFilter("all")}
            >
              All ({issues.length})
            </button>
            <button
              type="button"
              className={`filter-pill ${statusFilter === "reported" ? "active" : ""}`}
              onClick={() => setStatusFilter("reported")}
            >
              Reported ({stats.reported})
            </button>
            <button
              type="button"
              className={`filter-pill ${statusFilter === "in-progress" ? "active" : ""}`}
              onClick={() => setStatusFilter("in-progress")}
            >
              In Progress ({stats.inProgress})
            </button>
            <button
              type="button"
              className={`filter-pill ${statusFilter === "resolved" ? "active" : ""}`}
              onClick={() => setStatusFilter("resolved")}
            >
              Resolved ({stats.resolved})
            </button>
          </div>
        </div>

        {loading ? (
          <>
            <div className="sr-only" role="status" aria-live="polite">
              Loading recent community reports...
            </div>
            <div className="issue-feed-grid skeleton-grid" aria-hidden="true">
              {[1, 2, 3].map((n) => (
                <div key={n} className="feed-card skeleton-card">
                  <div className="feed-card-header">
                    <div className="skeleton-pill shimmer" />
                    <div className="skeleton-date shimmer" />
                  </div>
                  <div className="skeleton-title shimmer" />
                  <div className="skeleton-desc shimmer" />
                  <div className="skeleton-desc-short shimmer" />
                  <div className="skeleton-image shimmer" />
                  <div className="feed-card-footer">
                    <div className="skeleton-coords shimmer" />
                    <div className="skeleton-btn shimmer" />
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : error ? (
          <div className="feed-error-state" role="alert">
            <AlertCircle size={32} className="error-icon" aria-hidden="true" />
            <p className="error-title">Unable to Load Community Reports</p>
            <p className="error-subtext">{error}</p>
            <button type="button" className="retry-btn" onClick={fetchIssues}>
              <RefreshCw size={14} aria-hidden="true" />
              <span>Retry Loading</span>
            </button>
          </div>
        ) : filteredIssues.length === 0 ? (
          <div className="feed-empty-state">
            <Layers size={36} className="empty-icon" />
            <p className="empty-title">No issues found matching this filter.</p>
            <p className="empty-subtext">Be the first in your area to report an infrastructure defect.</p>
            <button type="button" className="primary-action-btn" onClick={handleReportNavigation}>
              Report an Issue
            </button>
          </div>
        ) : (
          <div className="issue-feed-grid">
            {filteredIssues.slice(0, 6).map((issue) => (
              <article key={issue._id} className="feed-card" data-testid="feed-issue-card">
                <div className="feed-card-header">
                  <span className={`status-pill status-${issue.status}`}>
                    {issue.status === "in-progress" ? "In Progress" : issue.status}
                  </span>
                  <span className="feed-card-date">
                    {new Date(issue.createdAt).toLocaleDateString()}
                  </span>
                </div>

                <h3 className="feed-card-type">{issue.type}</h3>
                <p className="feed-card-desc">{issue.description}</p>

                {issue.imageUrl && !failedImages.has(issue._id) ? (
                  <div className="feed-card-img-wrap">
                    <img
                      src={getImageUrl(issue.imageUrl)}
                      alt={issue.type}
                      className="feed-card-img"
                      loading="lazy"
                      onError={() => setFailedImages((prev) => new Set([...prev, issue._id]))}
                    />
                  </div>
                ) : (
                  <div className="feed-card-img-wrap fallback-wrap" aria-label={`No photo attached for ${issue.type}`}>
                    <div className="fallback-content">
                      {getCategoryIcon(issue.type)}
                      <span className="fallback-text">{getCategoryLabel(issue.type)}</span>
                      <span className="fallback-subtext">No field photo attached</span>
                    </div>
                  </div>
                )}

                <div className="feed-card-footer">
                  <span className="feed-card-coords">
                    {issue.location && typeof issue.location.lat === "number" ? (
                      <>
                        <MapPin size={13} />
                        {issue.location.lat.toFixed(4)}, {issue.location.lng.toFixed(4)}
                      </>
                    ) : (
                      "Location pinned"
                    )}
                  </span>

                  <div className="feed-vote-wrap">
                    {isAuthenticated && votedIssues.has(issue._id) ? (
                      <span className="voted-indicator" title="You voted for this issue">
                        <Check size={14} /> Voted ({issue.votes || 0})
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="feed-vote-btn"
                        onClick={() => handleVote(issue._id)}
                        aria-label={`Vote for ${issue.type} issue`}
                      >
                        <ThumbsUp size={14} />
                        <span>Vote ({issue.votes || 0})</span>
                      </button>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}

        {filteredIssues.length > 6 && (
          <div className="feed-view-more">
            <button
              type="button"
              className="view-dashboard-btn"
              onClick={() => navigate(isAuthenticated ? "/dashboard" : "/auth")}
            >
              <span>View all reported incidents on Dashboard</span>
              <ArrowRight size={16} />
            </button>
          </div>
        )}
      </section>

      {/* --------------------------------------------------------------------
          SECTION 5: FEATURE HIGHLIGHTS (Truthful, Verified Capabilities)
          -------------------------------------------------------------------- */}
      <section className="features-section" aria-labelledby="features-heading">
        <div className="section-header-centered">
          <span className="section-eyebrow">Smart Municipal Technology</span>
          <h2 id="features-heading" className="section-title">AI-Assisted Incident Processing</h2>
          <p className="section-description">
            CivicVision AI accelerates municipal response by automating location extraction, issue categorization,
            and duplicate suppression.
          </p>
        </div>

        <div className="features-grid">
          <div className="feature-item">
            <div className="feature-icon-box">
              <Camera size={22} />
            </div>
            <h4>Photo OCR Geolocation</h4>
            <p>
              Extracts coordinate watermarks stamped into photos by geo-camera apps, falling back to EXIF and map pins
              so poor connectivity never blocks a report.
            </p>
          </div>

          <div className="feature-item">
            <div className="feature-icon-box">
              <Sparkles size={22} />
            </div>
            <h4>Intelligent Defect Triage</h4>
            <p>
              Uses lightweight neural classification to evaluate road defects and route incidents directly to municipal
              departments for prompt inspection.
            </p>
          </div>

          <div className="feature-item">
            <div className="feature-icon-box">
              <Layers size={22} />
            </div>
            <h4>Two-Stage Duplicate Screening</h4>
            <p>
              Combines a 50m spatial proximity query with visual semantic comparison to group repeat reports of the same defect,
              preventing backlog duplication.
            </p>
          </div>

          <div className="feature-item">
            <div className="feature-icon-box">
              <Shield size={22} />
            </div>
            <h4>Spatial Hotspot Detection</h4>
            <p>
              Employs density-based spatial clustering (DBSCAN) over rolling 14-day windows to detect recurring problem corridors
              for municipal proactive maintenance.
            </p>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------------------
          SECTION 6: PUBLIC SERVICE FOOTER
          -------------------------------------------------------------------- */}
      <footer className="civic-footer" role="contentinfo">
        <div className="footer-top">
          <div className="footer-brand">
            <div className="footer-logo">
              <Shield size={20} className="footer-shield" aria-hidden="true" />
              <span>CivicVision AI</span>
            </div>
            <p className="footer-desc">
              An AI-assisted community issue tracker designed for municipal public infrastructure reporting,
              triage transparency, and community-driven verification.
            </p>
          </div>

          <div className="footer-nav">
            <h4>Quick Links</h4>
            <ul>
              <li><a href="#hero-heading">Home</a></li>
              <li><button type="button" className="footer-link-btn" onClick={handleReportNavigation}>Report an Issue</button></li>
              <li><a href="#community-map">Community Map</a></li>
              <li><a href="/auth">Citizen Portal</a></li>
            </ul>
          </div>

          <div className="footer-transparency">
            <h4>Public Service Notice</h4>
            <p>
              CivicVision AI is an educational and municipal infrastructure management platform.
              All reported records are subject to administrative verification and department dispatch policies.
            </p>
          </div>
        </div>

        <div className="footer-bottom">
          <p>© {new Date().getFullYear()} CivicVision AI • Community Issue Reporter. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
};

export default HomePage;