import React, { useState, useEffect, useRef } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMapEvents } from "react-leaflet";
import API from "../api/api";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import icon from "leaflet/dist/images/marker-icon.png";
import iconShadow from "leaflet/dist/images/marker-shadow.png";
import "./Dashboard.css";

// Fix Leaflet default icon issue
let defaultIcon = L.icon({
  iconUrl: icon,
  shadowUrl: iconShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
});

L.Marker.prototype.options.icon = defaultIcon;

// Map click handler component
const AddMarkerOnClick = ({ setMarkerPosition }) => {
  useMapEvents({
    click: (e) => {
      setMarkerPosition([e.latlng.lat, e.latlng.lng]);
    },
  });
  return null;
};

const Dashboard = () => {
  // State for user's reported issues
  const [userIssues, setUserIssues] = useState([]);
  const [loading, setLoading] = useState(true);
  
  // State for creating new issue
  const [markerPosition, setMarkerPosition] = useState(null);
  const [isReporting, setIsReporting] = useState(false);
  const [newIssue, setNewIssue] = useState({
    type: "pothole",
    description: "",
    image: null,
  });
  
  // State for form submission
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  
  // Default map center (can be adjusted to user's location)
  const defaultCenter = [11.342423,77.728165 ]; // erode City coordinates
  
  // Ref for file input
  const fileInputRef = useRef(null);
  
  // Fetch user's issues
  useEffect(() => {
    const fetchUserIssues = async () => {
      try {
        const token = localStorage.getItem("token");
        const response = await API.get("/issues/user", {
          headers: { Authorization: `Bearer ${token}` }
        });
        setUserIssues(response.data);
        setLoading(false);
      } catch (err) {
        console.error("Failed to fetch user issues:", err);
        setLoading(false);
      }
    };
    fetchUserIssues();
  }, []);
  
  
  // Handle form input changes
  const handleChange = (e) => {
    const { name, value } = e.target;
    setNewIssue({ ...newIssue, [name]: value });
  };
  
  // Handle image upload
  const handleImageChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      setNewIssue({ ...newIssue, image: e.target.files[0] });
    }
  };
  
  // Handle form submission
  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!markerPosition) {
      setMessage("Please select a location on the map.");
      return;
    }
    
    setSubmitting(true);
    setMessage("");
    
    try {
      const formData = new FormData();
      formData.append("type", newIssue.type);
      formData.append("description", newIssue.description);
      formData.append("lat", markerPosition[0]);
      formData.append("lng", markerPosition[1]);
      
      if (newIssue.image) {
        formData.append("image", newIssue.image);
      }
      
      const token = localStorage.getItem("token");
      console.log("Submitting issue with token:", token);

      await API.post("/issues", formData, {
        headers: {
          "Content-Type": "multipart/form-data",
          Authorization: `Bearer ${token}`
        }
      });
      
      // Reset form
      setNewIssue({
        type: "pothole",
        description: "",
        image: null,
      });
      setMarkerPosition(null);
      setIsReporting(false);
      
      // Refresh user issues
      const response = await API.get("/issues/user", {
        headers: { Authorization: `Bearer ${token}` }
      });
      setUserIssues(response.data);
      
      setMessage("Issue reported successfully!");
    } catch (err) {
      setMessage(err.response?.data?.message || "Failed to report issue. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };
  
  // Status styles for issue list
  const getStatusStyle = (status) => {
    const colors = {
      "reported": "#ff0000",
      "in-progress": "#ffa500",
      "resolved": "#008000",
    };
    
    return {
      backgroundColor: colors[status] || "#ff0000",
    };
  };
  
  // Status icon for map markers
  const getStatusIcon = (status) => {
    const colors = {
      "reported": "#ff0000",
      "in-progress": "#ffa500",
      "resolved": "#008000",
    };

    return L.divIcon({
      className: "custom-marker",
      html: `<div style="background-color: ${colors[status] || '#ff0000'}; width: 15px; height: 15px; border-radius: 50%; border: 2px solid white;"></div>`,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
      popupAnchor: [0, -10],
    });
  };
  
  return (
    <div className="dashboard-container">
      <div className="dashboard-header">
        <h1>Your Dashboard</h1>
        {!isReporting ? (
          <button 
            className="report-btn"
            onClick={() => setIsReporting(true)}
          >
            Report New Issue
          </button>
        ) : (
          <button 
            className="cancel-btn"
            onClick={() => {
              setIsReporting(false);
              setMarkerPosition(null);
            }}
          >
            Cancel Report
          </button>
        )}
      </div>
      
      {message && (
        <div className={`message ${message.includes("success") ? "success" : "error"}`}>
          {message}
        </div>
      )}
      
      {isReporting && (
        <div className="report-form-container">
          <div className="map-instructions">
            <p>Click on the map to select the issue location:</p>
          </div>
          
          <div className="map-container">
            <MapContainer 
              center={defaultCenter} 
              zoom={13} 
              style={{ height: "400px", width: "100%" }}
            >
              <TileLayer
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              />
              
              <AddMarkerOnClick setMarkerPosition={setMarkerPosition} />
              
              {markerPosition && (
                <Marker position={markerPosition}>
                  <Popup>New issue location</Popup>
                </Marker>
              )}
            </MapContainer>
          </div>
          
          <form onSubmit={handleSubmit} className="report-form">
            <div className="form-group">
              <label htmlFor="type">Issue Type:</label>
            <select
  id="type"
  name="type"
  value={newIssue.type}
  onChange={handleChange}
  required
>
  <option value="">-- Select Issue Type --</option>

  <optgroup label="Village Issues">
    <option value="unpaved-road">Unpaved Road</option>
    <option value="no-drainage">No Drainage System</option>
    <option value="electricity-outage">Electricity Outage</option>
    <option value="low-voltage">Low Voltage</option>
    <option value="water-scarcity">Water Scarcity</option>
    <option value="open-defecation">Open Defecation</option>
    <option value="animal-problem">Stray Animals</option>
    <option value="damaged-borewell">Damaged Borewell</option>
    <option value="lack-of-toilets">Lack of Toilets</option>
    <option value="unclean-handpumps">Unclean Hand Pumps</option>
    <option value="school-infra">Poor School Infrastructure</option>
    <option value="no-medical-center">No Primary Medical Center</option>
    <option value="poor-connectivity">Poor Mobile Network</option>
  </optgroup>

  <optgroup label="City Issues">
    <option value="pothole">Pothole</option>
    <option value="street-light">Street Light Out</option>
    <option value="graffiti">Graffiti</option>
    <option value="trash">Trash/Debris</option>
    <option value="water-leak">Water Leak</option>
    <option value="road-damage">Road Damage</option>
    <option value="sewage">Sewage Overflow</option>
    <option value="illegal-dumping">Illegal Dumping</option>
    <option value="abandoned-vehicle">Abandoned Vehicle</option>
    <option value="noise">Noise Complaint</option>
    <option value="construction-waste">Construction Waste</option>
    <option value="traffic-signal">Broken Traffic Signal</option>
    <option value="encroachment">Footpath Encroachment</option>
    <option value="overflowing-dustbin">Overflowing Dustbin</option>
  </optgroup>

  <optgroup label="Shared/Common Issues">
    <option value="blocked-drain">Blocked Drainage</option>
    <option value="sanitation">Poor Sanitation</option>
    <option value="foul-smell">Foul Smell/Dead Animal</option>
    <option value="drinking-water">Contaminated Drinking Water</option>
    <option value="school-issues">School Facility Issue</option>
    <option value="healthcare">Lack of Healthcare Access</option>
    <option value="other">Other</option>
  </optgroup>
</select>

            </div>
            
            <div className="form-group">
              <label htmlFor="description">Description:</label>
              <textarea
                id="description"
                name="description"
                value={newIssue.description}
                onChange={handleChange}
                placeholder="Describe the issue..."
                required
              ></textarea>
            </div>
            
            <div className="form-group">
              <label htmlFor="image">Upload Image (optional):</label>
              <input
                type="file"
                id="image"
                name="image"
                accept="image/*"
                ref={fileInputRef}
                onChange={handleImageChange}
              />
              <button 
                type="button" 
                className="upload-btn"
                onClick={() => fileInputRef.current.click()}
              >
                Choose File
              </button>
              <span className="file-name">
                {newIssue.image ? newIssue.image.name : "No file chosen"}
              </span>
            </div>
            
            <button 
              type="submit" 
              className="submit-btn"
              disabled={!markerPosition || submitting}
            >
              {submitting ? "Submitting..." : "Submit Report"}
            </button>
          </form>
        </div>
      )}
      
      <div className="issues-section">
        <h2>Your Reported Issues</h2>
        
        {loading ? (
          <p>Loading your issues...</p>
        ) : userIssues.length === 0 ? (
          <p>You haven't reported any issues yet.</p>
        ) : (
          <div className="issues-list">
            {userIssues.map((issue) => (
              <div key={issue._id} className="issue-card">
                <div className="issue-header">
                  <h3>{issue.type}</h3>
                  <span 
                    className="status-indicator" 
                    style={getStatusStyle(issue.status)}
                    title={issue.status}
                  ></span>
                </div>
                
                <p className="description">{issue.description}</p>
                
                {issue.imageUrl && (
                  <img 
                     src={`http://localhost:5000${issue.imageUrl}`} 
                     alt={issue.type} 
                     className="issue-image"
                     />
                )}
                
                <div className="issue-footer">
                  <span className="votes">Votes: {issue.votes}</span>
                  <span className="date">
                    {new Date(issue.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      
      {userIssues.length > 0 && (
        <div className="issues-map-container">
          <h2>Map of Your Issues</h2>
          <div className="map-container">
            <MapContainer 
              center={defaultCenter} 
              zoom={12} 
              style={{ height: "400px", width: "100%" }}
            >
              <TileLayer
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              />
              
              {userIssues.map((issue) => (
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
                        <span className="votes">Votes: {issue.votes}</span>
                      </div>
                      <p className="date">Reported on: {new Date(issue.createdAt).toLocaleDateString()}</p>
                    </div>
                  </Popup>
                </Marker>
              ))}
            </MapContainer>
          </div>
        </div>
      )}
    </div>
  );
};

export default Dashboard;