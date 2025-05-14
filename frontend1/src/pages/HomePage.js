import React, { useState, useEffect } from "react";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import API, { Auth, VoteService } from "../api/api";
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

// Custom marker icons based on issue status
const getStatusIcon = (status) => {
  const colors = {
    "reported": "#ff0000", // Red
    "in-progress": "#ffa500", // Orange
    "resolved": "#008000", // Green
  };

  return L.divIcon({
    className: "custom-marker",
    html: `<div style="background-color: ${colors[status] || '#ff0000'}; width: 15px; height: 15px; border-radius: 50%; border: 2px solid white;"></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
    popupAnchor: [0, -10],
  });
};

const HomePage = () => {
  const [issues, setIssues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [votedIssues, setVotedIssues] = useState(new Set());
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  
  // Default map center (can be adjusted to user's location)
  const defaultCenter = [11.342423, 77.728165]; // Erode City coordinates
  
  useEffect(() => {
    // Check authentication status
    setIsAuthenticated(Auth.isAuthenticated());
    
    const fetchIssues = async () => {
      try {
        const response = await API.get("/issues");
        setIssues(response.data);
        setLoading(false);
      } catch (err) {
        setError("Failed to fetch issues. Please try again later.");
        setLoading(false);
        console.error("Error fetching issues:", err);
      }
    };
    
    const fetchUserVotes = async () => {
      if (Auth.isAuthenticated()) {
        try {
          const response = await VoteService.getUserVotedIssues();
          if (response.data.success && response.data.votedIssueIds) {
            setVotedIssues(new Set(response.data.votedIssueIds));
          }
        } catch (err) {
          console.error("Failed to fetch user votes:", err);
        }
      }
    };
    
    fetchIssues();
    fetchUserVotes();
  }, []);
  
  const handleVote = async (issueId) => {
    if (!isAuthenticated) {
      alert("Please log in to vote on issues.");
      return;
    }
    
    try {
      const response = await VoteService.voteForIssue(issueId);
      
      if (response.data.success) {
        // Update vote count in the UI
        setIssues(issues.map(issue => 
          issue._id === issueId 
            ? { ...issue, votes: response.data.votes } 
            : issue
        ));
        
        // Mark issue as voted by this user
        setVotedIssues(new Set([...votedIssues, issueId]));
      } else {
        alert(response.data.message || "Error voting for issue.");
      }
    } catch (err) {
      console.error("Error voting:", err);
      if (err.response && err.response.data && err.response.data.message) {
        alert(err.response.data.message);
      } else {
        alert("Failed to submit your vote. Please try again.");
      }
    }
  };
  
  const hasVoted = (issueId) => {
    return votedIssues.has(issueId);
  };
  
  return (
    <div className="home-container">
      <div className="home-header">
        <h1>Community Issue Reporter</h1>
        <p>View reported issues in your community. Login to report new issues and vote.</p>
        {!isAuthenticated && (
          <div className="auth-message">
            <p>Please <a href="/auth">log in</a> to vote on issues.</p>
          </div>
        )}
      </div>
      
      {loading ? (
        <div className="loading">Loading map data...</div>
      ) : error ? (
        <div className="error">{error}</div>
      ) : (
        <div className="map-container">
          <MapContainer 
            center={defaultCenter} 
            zoom={13} 
            style={{ height: "600px", width: "100%" }}
          >
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            />
            
            {issues.map((issue) => (
              <Marker 
                key={issue._id} 
                position={[issue.location.lat, issue.location.lng]}
                icon={getStatusIcon(issue.status)}
              >
                <Popup>
                  <div className="issue-popup">
                    <h3>{issue.type}</h3>
                    <p>{issue.description}</p>
                    {issue.imageUrl && (
                      <img 
                        src={`http://localhost:5000${issue.imageUrl}`} 
                        alt={issue.type} 
                        className="issue-image"
                      />
                    )}
                    <div className="issue-details">
                      <span className={`status-badge ${issue.status}`}>
                        {issue.status.charAt(0).toUpperCase() + issue.status.slice(1)}
                      </span>
                      <span className="votes">
                        <i className="fas fa-thumbs-up"></i> {issue.votes}
                      </span>
                    </div>
                    <p className="date">Reported on: {new Date(issue.createdAt).toLocaleDateString()}</p>
                    
                    {/* Vote Button */}
                    <div className="vote-container">
                      {isAuthenticated ? (
                        hasVoted(issue._id) ? (
                          <button className="voted-button" disabled>
                            <i className="fas fa-check"></i> Voted
                          </button>
                        ) : (
                          <button 
                            className="vote-button"
                            onClick={() => handleVote(issue._id)}
                          >
                            <i className="fas fa-thumbs-up"></i> Vote
                          </button>
                        )
                      ) : (
                        <button 
                          className="login-to-vote-button"
                          onClick={() => window.location.href = "/auth"}
                        >
                          Login to Vote
                        </button>
                      )}
                    </div>
                  </div>
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>
      )}
      
      <div className="legend">
        <h3>Status Legend</h3>
        <div className="legend-item">
          <div className="legend-color" style={{ backgroundColor: "#ff0000" }}></div>
          <span>Reported</span>
        </div>
        <div className="legend-item">
          <div className="legend-color" style={{ backgroundColor: "#ffa500" }}></div>
          <span>In Progress</span>
        </div>
        <div className="legend-item">
          <div className="legend-color" style={{ backgroundColor: "#008000" }}></div>
          <span>Resolved</span>
        </div>
      </div>
    </div>
  );
};

export default HomePage;