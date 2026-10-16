import React, { useState, useEffect, useRef } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMapEvents, useMap } from "react-leaflet";
import { toast } from "react-toastify";
import API, { getImageUrl } from "../api/api";
import { extractExifGps, formatCoordinates } from "../utils/exifParser";
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
const AddMarkerOnClick = ({ onLocationSelect }) => {
  useMapEvents({
    click: (e) => {
      onLocationSelect([e.latlng.lat, e.latlng.lng], "manual");
    },
  });
  return null;
};

// Map view updater when marker is placed programmatically or manually
const MapViewUpdater = ({ position }) => {
  const map = useMap();
  useEffect(() => {
    if (position && typeof position[0] === "number" && typeof position[1] === "number") {
      map.flyTo(position, 15, { animate: true, duration: 1.2 });
    }
  }, [position, map]);
  return null;
};

const Dashboard = () => {
  // State for user's reported issues
  const [userIssues, setUserIssues] = useState([]);
  const [loading, setLoading] = useState(true);
  
  // State for creating new issue
  const [markerPosition, setMarkerPosition] = useState(null);
  const [locationSource, setLocationSource] = useState(null); // 'exif' | 'manual' | null
  const [locationFeedback, setLocationFeedback] = useState(null);
  const [exifExtracting, setExifExtracting] = useState(false);
  const [isReporting, setIsReporting] = useState(false);
  const [newIssue, setNewIssue] = useState({
    type: "pothole",
    description: "",
    image: null,
  });
  
  // State for form submission
  const [submitting, setSubmitting] = useState(false);

  // Default map center (initial viewport view only, NEVER used as default incident location)
  const defaultCenter = [11.342423, 77.728165]; // Erode City coordinates
  
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

  // Handle location selection from map click
  const handleLocationSelect = (coords, source = "manual") => {
    setMarkerPosition(coords);
    setLocationSource(source);
    setLocationFeedback({
      type: "manual",
      message: `📍 Location placed manually on map: ${coords[0].toFixed(5)}, ${coords[1].toFixed(5)}. Click anywhere on the map to adjust.`
    });
  };
  
  // Handle image upload and safe local EXIF extraction
  const handleImageChange = async (e) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setNewIssue(prev => ({ ...prev, image: file }));

      setExifExtracting(true);
      try {
        const gpsResult = await extractExifGps(file);
        if (gpsResult.success && typeof gpsResult.latitude === "number" && typeof gpsResult.longitude === "number") {
          setMarkerPosition([gpsResult.latitude, gpsResult.longitude]);
          setLocationSource("exif");
          setLocationFeedback({
            type: "exif",
            message: `📍 GPS coordinates extracted from photo EXIF metadata: [${gpsResult.latitude}, ${gpsResult.longitude}]. You can confirm or click anywhere on the map to adjust.`
          });
          toast.info(
            `📍 Photo GPS detected: ${formatCoordinates(gpsResult.latitude, gpsResult.longitude)}. Placed pin on map.`
          );
        } else {
          // Do NOT substitute default coordinates if no EXIF is found!
          // Preserve any existing manual pin if user already placed one
          if (!markerPosition) {
            setLocationFeedback({
              type: "no_exif",
              message: "ℹ️ No GPS coordinates found in image metadata. Please click on the map to place the issue pin manually."
            });
          }
        }
      } catch (err) {
        console.warn("EXIF extraction notice:", err);
      } finally {
        setExifExtracting(false);
      }
    }
  };
  
  // Handle form submission
  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!markerPosition) {
      toast.warn("Please select a location on the map.");
      return;
    }

    setSubmitting(true);

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
      setLocationSource(null);
      setLocationFeedback(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setIsReporting(false);
      
      // Refresh user issues
      const response = await API.get("/issues/user", {
        headers: { Authorization: `Bearer ${token}` }
      });
      setUserIssues(response.data);

      toast.success("Issue reported successfully!");
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to report issue. Please try again.");
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
              setLocationSource(null);
              setLocationFeedback(null);
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
          >
            Cancel Report
          </button>
        )}
      </div>
      
      {isReporting && (
        <div className="report-form-container">
          <div className="map-instructions">
            <p>Select the issue location on the map (or upload a geotagged photo):</p>
            {exifExtracting && (
              <div className="location-banner analyzing" data-testid="exif-analyzing">
                <span>🔍 Reading photo metadata for EXIF GPS coordinates...</span>
              </div>
            )}
            {locationFeedback && (
              <div className={`location-banner ${locationFeedback.type}`} data-testid="location-feedback-banner">
                <span className="feedback-text">{locationFeedback.message}</span>
                {locationSource === "exif" && (
                  <span className="source-tag exif-tag">Photo EXIF GPS</span>
                )}
                {locationSource === "manual" && (
                  <span className="source-tag manual-tag">Manual Pin</span>
                )}
              </div>
            )}
            {!markerPosition && !locationFeedback && !exifExtracting && (
              <div className="location-banner empty" data-testid="location-empty-banner">
                <span>⚠️ No location selected yet. Click on the map to place a pin, or upload a photo containing EXIF GPS.</span>
              </div>
            )}
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
              
              <AddMarkerOnClick onLocationSelect={handleLocationSelect} />
              <MapViewUpdater position={markerPosition} />
              
              {markerPosition && (
                <Marker position={markerPosition}>
                  <Popup>
                    <div>
                      <strong>Incident Location</strong><br />
                      Lat: {markerPosition[0].toFixed(5)}, Lng: {markerPosition[1].toFixed(5)}<br />
                      <em>Source: {locationSource === "exif" ? "Photo EXIF GPS" : "Manual Pin"}</em>
                    </div>
                  </Popup>
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
              {locationSource === "exif" && (
                <span className="exif-badge success" data-testid="exif-success-badge">
                  📍 EXIF GPS Coordinates Detected
                </span>
              )}
            </div>
            
            <button
              type="submit"
              className="submit-btn"
              disabled={!markerPosition || submitting}
            >
              {submitting && <span className="btn-spinner"></span>}
              {submitting ? "Submitting..." : "Submit Report"}
            </button>
          </form>
        </div>
      )}
      
      <div className="issues-section">
        <h2>Your Reported Issues</h2>
        
        {loading ? (
          <div className="page-loading">Loading your issues...</div>
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
                     src={getImageUrl(issue.imageUrl)}
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
                     src={getImageUrl(issue.imageUrl)}
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