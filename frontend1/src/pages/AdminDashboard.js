import React, { useState, useEffect } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import API from "../api/api";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import icon from "leaflet/dist/images/marker-icon.png";
import iconShadow from "leaflet/dist/images/marker-shadow.png";
import "./AdminDashboard.css";

const adminToken = localStorage.getItem("adminToken");
// Fix Leaflet default icon issue
let defaultIcon = L.icon({
  iconUrl: icon,
  shadowUrl: iconShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
});

L.Marker.prototype.options.icon = defaultIcon;

// Map component that centers on a selected issue
const MapView = ({ center, issues, selectedIssue, setSelectedIssue, getStatusIcon }) => {
  const map = useMap();
  
  // Center map on selected issue
  useEffect(() => {
    if (selectedIssue) {
      map.setView(
        [selectedIssue.location.lat, selectedIssue.location.lng],
        16
      );
    }
  }, [selectedIssue, map]);

  return (
    <>
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      />
      
      {issues.map((issue) => (
        <Marker 
          key={issue._id} 
          position={[issue.location.lat, issue.location.lng]}
          icon={getStatusIcon(issue.status)}
          eventHandlers={{
            click: () => setSelectedIssue(issue),
          }}
        >
          <Popup>
            <div className="issue-popup">
              <h3>{issue.type}</h3>
              <p>{issue.description}</p>
              {issue.imageUrl && (
                <img 
                  src={`http://localhost:5000${issue.imageUrl}`} 
                  alt={issue.type} 
                  className="issue-thumbnail"
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
    </>
  );
};

const AdminDashboard = () => {
  // State for all issues
  const [issues, setIssues] = useState([]);
  const [filteredIssues, setFilteredIssues] = useState([]);
  const [selectedIssue, setSelectedIssue] = useState(null);
  const [loading, setLoading] = useState(true);
  
  // State for filters
  const [filters, setFilters] = useState({
    status: "all",
    type: "all",
    department: "all",
    dateRange: "all",
    searchQuery: "",
  });
  
  // State for departments (could be fetched from API)
  const [departments, setDepartments] = useState([
    "Roads & Infrastructure",
    "Public Works",
    "Waste Management",
    "Street Lighting",
    "Parks & Recreation",
    "Water Services"
  ]);
  
  // State for issue update
  const [updateData, setUpdateData] = useState({
    status: "",
    department: "",
    internalNotes: "",
  });
  
  // State for form submission
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  
  // Default map center
  const defaultCenter = [11.342423, 77.728165]; // Erode City coordinates
  
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
  
  // Fetch all issues
  useEffect(() => {
    const fetchIssues = async () => {
      try {
        const response = await API.get("/issues");
        setIssues(response.data);
        setFilteredIssues(response.data);
        setLoading(false);
      } catch (err) {
        console.error("Failed to fetch issues:", err);
        setLoading(false);
      }
    };
    
    fetchIssues();
  }, []);
  
  // Apply filters when filters change
  useEffect(() => {
    applyFilters();
  }, [filters, issues]);
  
  // Apply filters to issues
  const applyFilters = () => {
    let result = [...issues];
    
    // Filter by status
    if (filters.status !== "all") {
      result = result.filter(issue => issue.status === filters.status);
    }
    
    // Filter by type
    if (filters.type !== "all") {
      result = result.filter(issue => issue.type === filters.type);
    }
    
    // Filter by department
    if (filters.department !== "all" && filters.department !== "") {
      result = result.filter(issue => issue.department === filters.department);
    }
    
    // Filter by date range
    if (filters.dateRange !== "all") {
      const now = new Date();
      let startDate;
      
      switch (filters.dateRange) {
        case "today":
          startDate = new Date(now.setHours(0, 0, 0, 0));
          break;
        case "week":
          startDate = new Date(now.setDate(now.getDate() - 7));
          break;
        case "month":
          startDate = new Date(now.setMonth(now.getMonth() - 1));
          break;
        default:
          startDate = null;
      }
      
      if (startDate) {
        result = result.filter(issue => new Date(issue.createdAt) >= startDate);
      }
    }
    
    // Filter by search query
    if (filters.searchQuery.trim() !== "") {
      const query = filters.searchQuery.toLowerCase();
      result = result.filter(issue => 
        issue.description.toLowerCase().includes(query) ||
        issue.type.toLowerCase().includes(query) ||
        issue._id.toLowerCase().includes(query)
      );
    }
    
    setFilteredIssues(result);
  };
  
  // Handle filter changes
  const handleFilterChange = (e) => {
    const { name, value } = e.target;
    setFilters({ ...filters, [name]: value });
  };
  
  // Reset filters
  const resetFilters = () => {
    setFilters({
      status: "all",
      type: "all",
      department: "all",
      dateRange: "all",
      searchQuery: "",
    });
  };
  
  // Handle update form changes
  const handleUpdateChange = (e) => {
    const { name, value } = e.target;
    setUpdateData({ ...updateData, [name]: value });
  };
  
  // Handle issue selection
  const handleIssueSelect = (issue) => {
    setSelectedIssue(issue);
    setUpdateData({
      status: issue.status || "",
      department: issue.department || "",
      internalNotes: issue.internalNotes || "",
    });
  };
  
  // Handle issue update form submission
  const handleUpdateSubmit = async (e) => {
    e.preventDefault();
    
    if (!selectedIssue) return;
    
    setSubmitting(true);
    setMessage("");
    console.log(updateData.status);
    try {
 const response = await API.patch(`/issues/${selectedIssue._id}`, {
  status: updateData.status,
  department: updateData.department,
});


      
      
      // Update issues in state
      const updatedIssues = issues.map(issue => 
        issue._id === selectedIssue._id ? { ...issue, ...response.data } : issue
      );
      
      setIssues(updatedIssues);
      setSelectedIssue({ ...selectedIssue, ...response.data });
      setMessage("Issue updated successfully!");
    } catch (err) {
      setMessage(err.response?.data?.message || "Failed to update issue. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };
  
  return (
    <div className="admin-dashboard-container">
      <div className="admin-header">
        <h1>Admin Dashboard</h1>
        <p>Manage community reported issues</p>
      </div>
      
      {message && (
        <div className={`message ${message.includes("success") ? "success" : "error"}`}>
          {message}
        </div>
      )}
      
      <div className="admin-content">
        <div className="filters-panel">
          <h2>Filters</h2>
          
          <div className="filter-group">
            <label htmlFor="searchQuery">Search:</label>
            <input
              type="text"
              id="searchQuery"
              name="searchQuery"
              value={filters.searchQuery}
              onChange={handleFilterChange}
              placeholder="Search by description, type, ID..."
            />
          </div>
          
          <div className="filter-group">
            <label htmlFor="status">Status:</label>
            <select
              id="status"
              name="status"
              value={filters.status}
              onChange={handleFilterChange}
            >
              <option value="all">All Statuses</option>
              <option value="reported">Reported</option>
              <option value="in-progress">In Progress</option>
              <option value="resolved">Resolved</option>
            </select>
          </div>
          
          <div className="filter-group">
            <label htmlFor="type">Issue Type:</label>
            <select
              id="type"
              name="type"
              value={filters.type}
              onChange={handleFilterChange}
            >
              <option value="all">All Types</option>
              <option value="pothole">Pothole</option>
              <option value="street-light">Street Light Out</option>
              <option value="graffiti">Graffiti</option>
              <option value="trash">Trash/Debris</option>
              <option value="water-leak">Water Leak</option>
              <option value="other">Other</option>
            </select>
          </div>
          
          <div className="filter-group">
            <label htmlFor="department">Department:</label>
            <select
              id="department"
              name="department"
              value={filters.department}
              onChange={handleFilterChange}
            >
              <option value="all">All Departments</option>
              {departments.map((dept) => (
                <option key={dept} value={dept}>{dept}</option>
              ))}
            </select>
          </div>
          
          <div className="filter-group">
            <label htmlFor="dateRange">Date Range:</label>
            <select
              id="dateRange"
              name="dateRange"
              value={filters.dateRange}
              onChange={handleFilterChange}
            >
              <option value="all">All Time</option>
              <option value="today">Today</option>
              <option value="week">Last 7 Days</option>
              <option value="month">Last 30 Days</option>
            </select>
          </div>
          
          <button className="reset-filters-btn" onClick={resetFilters}>
            Reset Filters
          </button>
        </div>
        
        <div className="issues-panel">
          <h2>Issues List ({filteredIssues.length})</h2>
          
          {loading ? (
            <p className="loading">Loading issues...</p>
          ) : filteredIssues.length === 0 ? (
            <p className="no-issues">No issues match your filters.</p>
          ) : (
            <div className="issues-table-container">
              <table className="issues-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Department</th>
                    <th>Reported On</th>
                    <th>Votes</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredIssues.map((issue) => (
                    <tr 
                      key={issue._id} 
                      className={selectedIssue && selectedIssue._id === issue._id ? "selected" : ""}
                    >
                      <td>{issue._id.substring(0, 8)}...</td>
                      <td>{issue.type}</td>
                      <td>
                        <span className={`status-badge ${issue.status}`}>
                          {issue.status}
                        </span>
                      </td>
                      <td>{issue.department || "Unassigned"}</td>
                      <td>{new Date(issue.createdAt).toLocaleDateString()}</td>
                      <td>{issue.votes}</td>
                      <td>
                        <button 
                          className="view-btn"
                          onClick={() => handleIssueSelect(issue)}
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        
        <div className="details-panel">
          {selectedIssue ? (
            <>
              <h2>Issue Details</h2>
              
              <div className="issue-details-container">
                <div className="issue-info">
                  <h3>{selectedIssue.type}</h3>
                  <p className="issue-description">{selectedIssue.description}</p>
                  
                  {selectedIssue.imageUrl && (
                    <div className="issue-image-container">
                      <img 
                        src={`http://localhost:5000${selectedIssue.imageUrl}`}
                        alt={selectedIssue.type} 
                        className="issue-image"
                      />
                    </div>
                  )}
                  
                  <div className="issue-metadata">
                    <p><strong>Reported by:</strong> {selectedIssue.userId?.fullName || "Anonymous"}</p>
                    <p><strong>Email:</strong> {selectedIssue.userId?.email || "N/A"}</p>
                    <p><strong>Location:</strong> Lat: {selectedIssue.location.lat.toFixed(6)}, Lng: {selectedIssue.location.lng.toFixed(6)}</p>
                    <p><strong>Reported on:</strong> {new Date(selectedIssue.createdAt).toLocaleString()}</p>
                    <p><strong>Votes:</strong> {selectedIssue.votes}</p>
                    <p><strong>Status:</strong> {selectedIssue.status}</p>
                    <p><strong>Department:</strong> {selectedIssue.department || "Unassigned"}</p>
                  </div>
                </div>

                <div className="issue-update-form">
                  <h3>Update Issue</h3>
                  
                  <form onSubmit={handleUpdateSubmit}>
                    <div className="form-group">
                      <label htmlFor="updateStatus">Status:</label>
                      <select
                        id="updateStatus"
                        name="status"
                        value={updateData.status}
                        onChange={handleUpdateChange}
                        required
                      >
                        <option value="">Select Status</option>
                        <option value="reported">Reported</option>
                        <option value="in-progress">In Progress</option>
                        <option value="resolved">Resolved</option>
                      </select>
                    </div>
                    
                    <div className="form-group">
                      <label htmlFor="updateDepartment">Assign to Department:</label>
                      <select
                        id="updateDepartment"
                        name="department"
                        value={updateData.department}
                        onChange={handleUpdateChange}
                      >
                        <option value="">Unassigned</option>
                        {departments.map((dept) => (
                          <option key={dept} value={dept}>{dept}</option>
                        ))}
                      </select>
                    </div>
                    
                    <div className="form-group">
                      <label htmlFor="internalNotes">Internal Notes:</label>
                      <textarea
                        id="internalNotes"
                        name="internalNotes"
                        value={updateData.internalNotes}
                        onChange={handleUpdateChange}
                        placeholder="Add notes visible only to admin staff..."
                        rows="4"
                      ></textarea>
                    </div>
                    
                    <button 
                      type="submit" 
                      className="update-btn"
                      disabled={submitting}
                    >
                      {submitting ? "Updating..." : "Update Issue"}
                    </button>
                  </form>
                </div>
              </div>
            </>
          ) : (
            <div className="no-selection">
              <p>Select an issue from the list to view details and make updates.</p>
            </div>
          )}
        </div>
      </div>
      
      <div className="admin-map-container">
        <h2>Issues Map</h2>
        <div className="map-wrapper">
          <MapContainer 
            center={defaultCenter} 
            zoom={13} 
            style={{ height: "500px", width: "100%" }}
          >
           <MapView 
              center={defaultCenter}
              issues={filteredIssues}
              selectedIssue={selectedIssue}
              setSelectedIssue={handleIssueSelect}
              getStatusIcon={getStatusIcon}
            /> 
          </MapContainer>
        </div>
        
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
    </div>
  );
};

export default AdminDashboard;