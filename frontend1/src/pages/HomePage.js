import React, { useState, useEffect } from "react";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import API from "../api/api";
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
  
  // Default map center (can be adjusted to user's location)
  const defaultCenter = [11.342423,77.728165 ]; // erode City coordinates
  
  useEffect(() => {
    const fetchIssues = async () => {
      try {
        const response = await API.get("/issues");
        setIssues(response.data);
        setLoading(false);
      } catch (err) {
        setError("Failed to fetch issues. Please try again later.");
        setLoading(false);
      }
    };
    
    fetchIssues();
  }, []);
  
  return (
    <div className="home-container">
      <div className="home-header">
        <h1>Community Issue Reporter</h1>
        <p>View reported issues in your community. Login to report new issues.</p>
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
                        src={issue.imageUrl} 
                        alt={issue.type} 
                        className="issue-image"
                      />
                    )}
                    <div className="issue-details">
                      <span className={`status-badge ${issue.status}`}>
                        {issue.status.charAt(0).toUpperCase() + issue.status.slice(1)}
                      </span>
                      <span className="votes">Votes: {issue.votes}</span>
                    </div>
                    <p className="date">Reported on: {new Date(issue.createdAt).toLocaleDateString()}</p>
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