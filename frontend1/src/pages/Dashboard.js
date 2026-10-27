import React, { useState, useEffect, useRef, useCallback } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMapEvents, useMap } from "react-leaflet";
import { toast } from "react-toastify";
import API, { getImageUrl } from "../api/api";
import {
  extractExifGps,
  formatCoordinates,
  calculateHaversineDistance,
  formatDistance
} from "../utils/exifParser";
import {
  FileText,
  Clock,
  CheckCircle2,
  ThumbsUp,
  Camera,
  AlertTriangle,
  Plus,
  X,
  ShieldCheck,
  Layers,
  ChevronRight,
  ChevronLeft,
  MapPin
} from "lucide-react";
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

const INITIAL_ISSUE_STATE = Object.freeze({
  type: "pothole",
  description: "",
  image: null,
});

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
  const [fetchError, setFetchError] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 10;
  
  // State for creating new issue
  const [markerPosition, setMarkerPosition] = useState(null);
  const [locationSource, setLocationSource] = useState(null); // 'exif' | 'ocr' | 'manual' | null
  const [locationFeedback, setLocationFeedback] = useState(null);
  const [exifExtracting, setExifExtracting] = useState(false);
  const [ocrExtracting, setOcrExtracting] = useState(false);
  const [exifCandidate, setExifCandidate] = useState(null);
  const [ocrCandidate, setOcrCandidate] = useState(null);
  const [candidateConflict, setCandidateConflict] = useState(null); // { exif, ocr, distanceMeters }
  const [isReporting, setIsReporting] = useState(false);
  const [newIssue, setNewIssue] = useState({ ...INITIAL_ISSUE_STATE });
  const [imagePreview, setImagePreview] = useState(null);
  const imagePreviewRef = useRef(null);

  // Three-Step Citizen Reporting Wizard State (Task 2.2)
  const [wizardStep, setWizardStep] = useState(1); // 1: Describe | 2: Photo & Location | 3: Review & Submit
  const [stepValidationError, setStepValidationError] = useState("");

  const updateImagePreview = useCallback((url) => {
    if (imagePreviewRef.current && typeof window !== "undefined" && window.URL && typeof window.URL.revokeObjectURL === "function") {
      try {
        window.URL.revokeObjectURL(imagePreviewRef.current);
      } catch (_) {}
    }
    imagePreviewRef.current = url;
    setImagePreview(url);
  }, []);

  const [fileInputKey, setFileInputKey] = useState(Date.now());
  
  // Request sequence ref to discard stale async responses
  const imageRequestIdRef = useRef(0);

  // State for form submission
  const [submitting, setSubmitting] = useState(false);

  // Default map center (initial viewport view only, NEVER used as default incident location)
  const defaultCenter = [11.342423, 77.728165]; // Erode City coordinates
  
  // Ref for file input
  const fileInputRef = useRef(null);
  
  // Fetch user's issues
  const fetchUserIssues = useCallback(async () => {
    try {
      setFetchError(null);
      const token = localStorage.getItem("token");
      const response = await API.get("/issues/user", {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = response.data;
      if (Array.isArray(data)) {
        setUserIssues(data);
      } else if (data && Array.isArray(data.issues)) {
        setUserIssues(data.issues);
      } else {
        setUserIssues([]);
      }
      setLoading(false);
    } catch (err) {
      console.error("Failed to fetch user issues:", err);
      setFetchError("Failed to load your reported issues. Please try again.");
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUserIssues();
  }, [fetchUserIssues]);

  useEffect(() => {
    if (typeof window !== "undefined" && window.location && window.location.search && window.location.search.includes("report=true")) {
      setIsReporting(true);
    }
  }, []);
  
  // Reset all temporary report form data cleanly (Task 1.2 & Task 2.2)
  const resetReportForm = useCallback(() => {
    // 1. Invalidate any in-flight EXIF or OCR async callbacks
    imageRequestIdRef.current++;

    // 2. Revoke and clear image preview
    updateImagePreview(null);

    // 3. Clear file input element and cycle key to force clean input remount
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    setFileInputKey(Date.now());

    // 4. Reset newIssue object to clean initial state (description, image, default category)
    setNewIssue({ ...INITIAL_ISSUE_STATE });

    // 5. Reset all location and extraction states
    setMarkerPosition(null);
    setLocationSource(null);
    setLocationFeedback(null);
    setExifCandidate(null);
    setOcrCandidate(null);
    setCandidateConflict(null);
    setExifExtracting(false);
    setOcrExtracting(false);
    setSubmitting(false);

    // 6. Reset wizard step and validation errors (Task 2.2)
    setWizardStep(1);
    setStepValidationError("");

    // 7. Dismiss any temporary toast notifications from previous attempts
    if (toast && typeof toast.dismiss === "function") {
      toast.dismiss();
    }
  }, [updateImagePreview]);

  const handleCancelReport = () => {
    resetReportForm();
    setIsReporting(false);
  };

  const handleOpenReport = () => {
    resetReportForm();
    setIsReporting(true);
  };

  // Wizard navigation & validation handlers (Task 2.2)
  const validateStep1 = useCallback(() => {
    if (!newIssue.type) {
      setStepValidationError("Please select an issue type.");
      return false;
    }
    if (!newIssue.description || !newIssue.description.trim()) {
      setStepValidationError("Please provide a description of the issue.");
      return false;
    }
    setStepValidationError("");
    return true;
  }, [newIssue.type, newIssue.description]);

  const handleNextFromStep1 = () => {
    if (validateStep1()) {
      setWizardStep(2);
    }
  };

  const validateStep2 = useCallback(() => {
    if (!markerPosition) {
      setStepValidationError("Please select an incident location on the map or upload a geotagged photo.");
      return false;
    }
    setStepValidationError("");
    return true;
  }, [markerPosition]);

  const handleNextFromStep2 = () => {
    if (validateStep2()) {
      setWizardStep(3);
    }
  };

  const handleStepClick = (targetStep) => {
    if (targetStep === 1) {
      setStepValidationError("");
      setWizardStep(1);
    } else if (targetStep === 2) {
      if (validateStep1()) {
        setWizardStep(2);
      }
    } else if (targetStep === 3) {
      if (validateStep1() && validateStep2()) {
        setWizardStep(3);
      }
    }
  };

  // Handle form input changes
  const handleChange = (e) => {
    const { name, value } = e.target;
    setNewIssue((prev) => ({ ...prev, [name]: value }));
    if (stepValidationError) {
      setStepValidationError("");
    }
  };

  // Handle location selection from map click
  const handleLocationSelect = (coords, source = "manual") => {
    setMarkerPosition(coords);
    setLocationSource(source);
    setCandidateConflict(null);
    if (stepValidationError) {
      setStepValidationError("");
    }
    setLocationFeedback({
      type: "manual",
      message: `📍 Location placed manually on map: ${coords[0].toFixed(5)}, ${coords[1].toFixed(5)}. Click anywhere on the map to adjust.`
    });
  };
  
  // Handle image upload and safe local EXIF extraction
  const handleImageChange = async (e) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      const currentReqId = ++imageRequestIdRef.current;

      setNewIssue((prev) => ({ ...prev, image: file }));

      // Create preview safely outside updater
      let nextUrl = "mock-blob-url";
      try {
        if (typeof window !== "undefined" && window.URL && typeof window.URL.createObjectURL === "function") {
          const generated = window.URL.createObjectURL(file);
          if (generated) {
            nextUrl = generated;
          }
        }
      } catch (_) {
        nextUrl = "mock-blob-url";
      }
      updateImagePreview(nextUrl);

      // Reset OCR and conflict states when image changes
      setOcrExtracting(false);
      setOcrCandidate(null);
      setCandidateConflict(null);
      if (locationSource === "ocr" || locationSource === "exif") {
        setLocationSource("manual");
        setMarkerPosition(null);
        setLocationFeedback(null);
      }

      // Perform local client-side EXIF GPS extraction
      setExifExtracting(true);
      try {
        const gpsResult = await extractExifGps(file);

        // Discard result if user has already selected a newer image
        if (currentReqId !== imageRequestIdRef.current) return;

        if (gpsResult.success && typeof gpsResult.latitude === "number" && typeof gpsResult.longitude === "number") {
          const candidate = {
            lat: gpsResult.latitude,
            lng: gpsResult.longitude,
            source: "exif"
          };
          setExifCandidate(candidate);
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
          setExifCandidate(null);
          // Preserve any existing manual pin if user already placed one
          if (!markerPosition) {
            setLocationFeedback({
              type: "no_exif",
              message: "ℹ️ No GPS coordinates found in image metadata. Click 'Detect coordinates from photo' to scan for watermark text, or click the map to place a pin manually."
            });
          }
        }
      } catch (err) {
        console.warn("EXIF extraction notice:", err);
      } finally {
        if (currentReqId === imageRequestIdRef.current) {
          setExifExtracting(false);
        }
      }
    }
  };

  // Handle OCR coordinate detection via backend proxy
  const handleDetectOcr = async () => {
    if (!newIssue.image) {
      toast.warn("Please select an image first.");
      return;
    }
    if (ocrExtracting) return;

    const currentReqId = imageRequestIdRef.current;
    setOcrExtracting(true);
    setCandidateConflict(null);

    try {
      const formData = new FormData();
      formData.append("image", newIssue.image);

      const token = localStorage.getItem("token");
      const response = await API.post("/issues/extract-ocr", formData, {
        headers: {
          "Content-Type": "multipart/form-data",
          Authorization: `Bearer ${token}`
        }
      });

      // Discard response if a newer image was selected while OCR was processing
      if (currentReqId !== imageRequestIdRef.current) return;

      const data = response.data;

      if (data.found && typeof data.latitude === "number" && typeof data.longitude === "number") {
        const candidate = {
          lat: data.latitude,
          lng: data.longitude,
          source: "ocr",
          confidence: data.confidence,
          format: data.format
        };
        setOcrCandidate(candidate);

        // Check against EXIF candidate if one exists
        if (exifCandidate) {
          const dist = calculateHaversineDistance(
            exifCandidate.lat,
            exifCandidate.lng,
            candidate.lat,
            candidate.lng
          );

          const CONFLICT_THRESHOLD_METERS = 50.0;
          if (dist !== null && dist > CONFLICT_THRESHOLD_METERS) {
            // Material discrepancy: prompt citizen to choose
            setCandidateConflict({
              exif: exifCandidate,
              ocr: candidate,
              distanceMeters: dist
            });
            toast.warn(
              `⚠️ Location discrepancy: Photo EXIF and Watermark OCR differ by ${formatDistance(dist)}. Please choose which coordinates to use.`
            );
            return;
          } else {
            // Close agreement (<= 50m): apply OCR coordinates with verification notice
            setMarkerPosition([candidate.lat, candidate.lng]);
            setLocationSource("ocr");
            setLocationFeedback({
              type: "ocr",
              message: `📍 Watermark OCR coordinates detected: [${candidate.lat}, ${candidate.lng}] (${dist !== null ? formatDistance(dist) + ' from EXIF' : 'verified'}). Map pin updated.`
            });
            toast.success(
              `📍 Watermark GPS detected: ${formatCoordinates(candidate.lat, candidate.lng)}.`
            );
          }
        } else {
          // No EXIF was detected: apply OCR coordinates directly
          setMarkerPosition([candidate.lat, candidate.lng]);
          setLocationSource("ocr");
          setLocationFeedback({
            type: "ocr",
            message: `📍 Watermark OCR coordinates detected: [${candidate.lat}, ${candidate.lng}]. Map pin placed.`
          });
          toast.success(
            `📍 Photo watermark GPS detected: ${formatCoordinates(candidate.lat, candidate.lng)}. Placed pin on map.`
          );
        }
      } else {
        toast.info(data.message || "No GPS coordinates detected in photo watermark text. You can place the pin manually.");
        setLocationFeedback({
          type: "no_ocr",
          message: `ℹ️ ${data.message || "No GPS coordinates detected in photo text. Please click on the map to place the issue pin manually."}`
        });
      }
    } catch (err) {
      if (currentReqId !== imageRequestIdRef.current) return;
      const errMsg = err.response?.data?.message || "Could not detect coordinates from photo. Please place the pin manually.";
      toast.error(errMsg);
      setLocationFeedback({
        type: "no_ocr",
        message: `⚠️ OCR detection notice: ${errMsg}`
      });
    } finally {
      if (currentReqId === imageRequestIdRef.current) {
        setOcrExtracting(false);
      }
    }
  };

  // Handle conflict choice selection
  const handleSelectCandidate = (source) => {
    if (!candidateConflict) return;

    if (source === "exif" && candidateConflict.exif) {
      setMarkerPosition([candidateConflict.exif.lat, candidateConflict.exif.lng]);
      setLocationSource("exif");
      setLocationFeedback({
        type: "exif",
        message: `📍 Selected Photo EXIF GPS: [${candidateConflict.exif.lat}, ${candidateConflict.exif.lng}]. Click map to adjust if needed.`
      });
      toast.info("Selected Photo EXIF coordinates.");
    } else if (source === "ocr" && candidateConflict.ocr) {
      setMarkerPosition([candidateConflict.ocr.lat, candidateConflict.ocr.lng]);
      setLocationSource("ocr");
      setLocationFeedback({
        type: "ocr",
        message: `📍 Selected Photo Watermark OCR: [${candidateConflict.ocr.lat}, ${candidateConflict.ocr.lng}]. Click map to adjust if needed.`
      });
      toast.info("Selected Watermark OCR coordinates.");
    } else if (source === "manual") {
      setLocationSource("manual");
      setLocationFeedback({
        type: "manual",
        message: "📍 Manual placement chosen. Click anywhere on the map to position the pin."
      });
      toast.info("Please click on the map to set the location pin manually.");
    }
    setCandidateConflict(null);
  };
  
  // Handle form submission
  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!newIssue.description || !newIssue.description.trim()) {
      setStepValidationError("Please provide an issue description.");
      setWizardStep(1);
      toast.warn("Please enter a description.");
      return;
    }

    if (!markerPosition) {
      setStepValidationError("Please select an incident location on the map.");
      setWizardStep(2);
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
      formData.append("geoSource", locationSource || "manual");
      
      if (newIssue.image) {
        formData.append("image", newIssue.image);
      }

      // Build safe audit metadata if extraction occurred
      const locationMetadata = {};
      if (exifCandidate) {
        locationMetadata.exifCoordinates = [exifCandidate.lng, exifCandidate.lat];
      }
      if (ocrCandidate) {
        locationMetadata.ocrCoordinates = [ocrCandidate.lng, ocrCandidate.lat];
        if (ocrCandidate.confidence !== undefined && ocrCandidate.confidence !== null) {
          locationMetadata.ocrConfidence = ocrCandidate.confidence;
        }
      }
      if (exifCandidate && ocrCandidate) {
        const dist = calculateHaversineDistance(exifCandidate.lat, exifCandidate.lng, ocrCandidate.lat, ocrCandidate.lng);
        if (dist !== null) {
          locationMetadata.discrepancyMeters = dist;
        }
      }
      if (Object.keys(locationMetadata).length > 0) {
        formData.append("locationMetadata", JSON.stringify(locationMetadata));
      }
      
      const token = localStorage.getItem("token");
      await API.post("/issues", formData, {
        headers: {
          "Content-Type": "multipart/form-data",
          Authorization: `Bearer ${token}`
        }
      });
      
      // Reset form and extraction states cleanly
      resetReportForm();
      setIsReporting(false);
      
      // Refresh user issues and reset to page 1
      await fetchUserIssues();
      setCurrentPage(1);

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
  
  // Citizen overview metrics calculation
  const metrics = {
    total: userIssues.length,
    inProgress: userIssues.filter((i) => i.status === "in-progress").length,
    resolved: userIssues.filter((i) => i.status === "resolved").length,
    votes: userIssues.reduce((acc, curr) => acc + (curr.votes || 0), 0)
  };
  
  return (
    <div className="dashboard-container">
      <div className="dashboard-header">
        <div className="dashboard-header-text">
          <div className="portal-badge">
            <ShieldCheck size={14} className="portal-badge-icon" />
            <span>Civic Incident Management</span>
          </div>
          <h1>Your Dashboard</h1>
          <p className="dashboard-header-subtitle">
            Report public infrastructure defects, monitor municipal resolution, and track community improvements.
          </p>
        </div>
        <div className="dashboard-header-actions">
          {!isReporting ? (
            <button 
              className="report-btn"
              onClick={handleOpenReport}
              data-testid="report-new-issue-btn"
            >
              <Plus size={18} />
              <span>Report New Issue</span>
            </button>
          ) : (
            <button 
              className="cancel-btn"
              onClick={handleCancelReport}
              data-testid="cancel-report-btn"
            >
              <X size={18} />
              <span>Cancel Report</span>
            </button>
          )}
        </div>
      </div>

      {/* Institutional Citizen Metrics Summary Grid */}
      <div className="citizen-metrics-grid">
        <div className="metric-card">
          <div className="metric-icon total">
            <FileText size={20} />
          </div>
          <div className="metric-content">
            <span className="metric-value">{metrics.total}</span>
            <span className="metric-label">Total Reported</span>
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-icon in-progress">
            <Clock size={20} />
          </div>
          <div className="metric-content">
            <span className="metric-value">{metrics.inProgress}</span>
            <span className="metric-label">In Progress</span>
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-icon resolved">
            <CheckCircle2 size={20} />
          </div>
          <div className="metric-content">
            <span className="metric-value">{metrics.resolved}</span>
            <span className="metric-label">Resolved</span>
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-icon votes">
            <ThumbsUp size={20} />
          </div>
          <div className="metric-content">
            <span className="metric-value">{metrics.votes}</span>
            <span className="metric-label">Community Votes</span>
          </div>
        </div>
      </div>
      
      {isReporting && (
        <div className="report-form-container">
          <div className="report-form-header">
            <div className="report-form-title-group">
              <span className="form-step-tag">Step {wizardStep} of 3</span>
              <h2>Report a Community Issue</h2>
              <p className="report-form-subtitle">
                Complete the three steps below to verify and dispatch this incident to municipal response teams.
              </p>
            </div>
          </div>

          {/* Wizard Step Progress Indicator (Task 2.2) */}
          <div className="wizard-stepper" data-testid="wizard-step-indicator" role="navigation" aria-label="Issue Reporting Progress">
            <button
              type="button"
              className={`step-node ${wizardStep === 1 ? "active" : wizardStep > 1 ? "completed" : ""}`}
              onClick={() => handleStepClick(1)}
              aria-current={wizardStep === 1 ? "step" : undefined}
              aria-label="Step 1: Describe"
              data-testid="wizard-step-1-indicator"
            >
              <span className="step-number">{wizardStep > 1 ? "✓" : "1"}</span>
              <span className="step-label">Describe</span>
            </button>
            <div className={`step-connector ${wizardStep >= 2 ? "active" : ""}`} />
            <button
              type="button"
              className={`step-node ${wizardStep === 2 ? "active" : wizardStep > 2 ? "completed" : ""}`}
              onClick={() => handleStepClick(2)}
              aria-current={wizardStep === 2 ? "step" : undefined}
              aria-label="Step 2: Photo and Location"
              data-testid="wizard-step-2-indicator"
            >
              <span className="step-number">{wizardStep > 2 ? "✓" : "2"}</span>
              <span className="step-label">Photo & Location</span>
            </button>
            <div className={`step-connector ${wizardStep >= 3 ? "active" : ""}`} />
            <button
              type="button"
              className={`step-node ${wizardStep === 3 ? "active" : ""}`}
              onClick={() => handleStepClick(3)}
              aria-current={wizardStep === 3 ? "step" : undefined}
              aria-label="Step 3: Review and Submit"
              data-testid="wizard-step-3-indicator"
            >
              <span className="step-number">3</span>
              <span className="step-label">Review & Submit</span>
            </button>
          </div>

          <form onSubmit={handleSubmit} className="report-form" data-testid="report-form">
            {/* STEP 1: Describe the Issue */}
            <div 
              className={`wizard-step-panel step-1 ${wizardStep === 1 ? "active" : "step-hidden"}`}
              data-testid="wizard-step-1"
            >
              <div className="step-panel-header">
                <h3>Step 1: Describe the Issue</h3>
                <p>Select the municipal issue category and describe the defect in detail.</p>
              </div>

              {stepValidationError && wizardStep === 1 && (
                <div className="step-validation-error" data-testid="step-1-validation-error" role="alert">
                  <AlertTriangle size={16} />
                  <span>{stepValidationError}</span>
                </div>
              )}

              <div className="form-group">
                <label htmlFor="type">
                  Issue Type:
                </label>
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
                <span className="field-hint">Select the closest municipal category for proper department assignment.</span>
              </div>
              
              <div className="form-group">
                <label htmlFor="description">
                  Description:
                </label>
                <textarea
                  id="description"
                  name="description"
                  value={newIssue.description}
                  onChange={handleChange}
                  placeholder="Describe the issue, landmarks, and severity in detail..."
                  required
                ></textarea>
                <div className="textarea-footer">
                  <span className="field-hint">Provide exact location cues and hazards for repair crews.</span>
                  <span className="char-count">{newIssue.description.length} characters</span>
                </div>
              </div>

              <div className="wizard-actions-row">
                <button
                  type="button"
                  className="cancel-btn form-inline-cancel-btn"
                  onClick={handleCancelReport}
                  data-testid="form-inline-cancel-btn"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="wizard-next-btn primary-btn"
                  onClick={handleNextFromStep1}
                  data-testid="step-1-next-btn"
                >
                  <span>Next: Photo & Location</span>
                  <ChevronRight size={18} />
                </button>
              </div>
            </div>

            {/* STEP 2: Add Photo & Location */}
            <div 
              className={`wizard-step-panel step-2 ${wizardStep === 2 ? "active" : "step-hidden"}`}
              data-testid="wizard-step-2"
            >
              <div className="step-panel-header">
                <h3>Step 2: Add a Photo & Location</h3>
                <p>Attach photo evidence and pin the incident on the interactive map.</p>
              </div>

              {stepValidationError && wizardStep === 2 && (
                <div className="step-validation-error" data-testid="step-2-validation-error" role="alert">
                  <AlertTriangle size={16} />
                  <span>{stepValidationError}</span>
                </div>
              )}

              <div className="form-group image-upload-group">
                <label htmlFor="image">Upload Image (optional):</label>
                <div className="upload-controls">
                  <input
                    key={fileInputKey}
                    type="file"
                    id="image"
                    name="image"
                    accept="image/*"
                    ref={fileInputRef}
                    onChange={handleImageChange}
                    data-testid="image-file-input"
                  />
                  <button 
                    type="button" 
                    className="upload-btn"
                    onClick={() => fileInputRef.current && fileInputRef.current.click()}
                    data-testid="choose-file-btn"
                  >
                    <Camera size={16} /> Choose File
                  </button>
                  <span className="file-name" data-testid="file-name">
                    {newIssue.image ? newIssue.image.name : "No file chosen"}
                  </span>

                  {newIssue.image && (
                    <button
                      type="button"
                      className="detect-ocr-btn"
                      onClick={handleDetectOcr}
                      disabled={ocrExtracting}
                      data-testid="detect-ocr-btn"
                    >
                      {ocrExtracting ? (
                        <>
                          <span className="btn-spinner mini"></span>
                          Scanning photo text...
                        </>
                      ) : (
                        "🔍 Detect coordinates from photo"
                      )}
                    </button>
                  )}
                </div>

                {/* Instant Image Preview Thumbnail */}
                {imagePreview && (
                  <div className="image-preview-container" data-testid="image-preview-container">
                    <img
                      src={imagePreview}
                      alt="Defect Preview"
                      className="image-preview-thumb"
                      data-testid="image-preview-thumb"
                    />
                    <div className="preview-meta">
                      <span className="preview-file-name">{newIssue.image?.name}</span>
                      <button
                        type="button"
                        className="btn-remove-preview"
                        data-testid="btn-remove-preview"
                        onClick={() => {
                          updateImagePreview(null);
                          setNewIssue((prev) => ({ ...prev, image: null }));
                          if (fileInputRef.current) fileInputRef.current.value = "";
                          setFileInputKey(Date.now());
                          setExifCandidate(null);
                          setOcrCandidate(null);
                          setCandidateConflict(null);
                          if (locationSource === "exif" || locationSource === "ocr") {
                            setLocationSource(null);
                            setMarkerPosition(null);
                            setLocationFeedback(null);
                          }
                        }}
                        aria-label="Remove photo"
                      >
                        ✕ Remove Photo
                      </button>
                    </div>
                  </div>
                )}

                <div className="detection-badges">
                  {locationSource === "exif" && (
                    <span className="exif-badge success" data-testid="exif-success-badge">
                      📍 EXIF GPS Coordinates Detected
                    </span>
                  )}
                  {locationSource === "ocr" && (
                    <span className="exif-badge ocr-badge" data-testid="ocr-success-badge">
                      🔍 Photo Watermark GPS Detected
                    </span>
                  )}
                </div>
              </div>

              {/* Selected Location Summary Pill */}
              {markerPosition && (
                <div className="selected-location-summary" data-testid="selected-location-summary">
                  <div className="summary-pin-icon">
                    <MapPin size={18} />
                  </div>
                  <div className="summary-coords-text">
                    <strong>Incident Coordinates:</strong> {markerPosition[0].toFixed(5)}, {markerPosition[1].toFixed(5)}
                    <span className="summary-source-label">
                      ({locationSource === "exif" ? "Photo EXIF GPS" : locationSource === "ocr" ? "Photo Watermark OCR" : "Manual Map Pin"})
                    </span>
                  </div>
                </div>
              )}

              <div className="map-instructions">
                <p>Select the issue location on the map (or upload a geotagged photo):</p>
                {exifExtracting && (
                  <div className="location-banner analyzing" data-testid="exif-analyzing">
                    <span>🔍 Reading photo metadata for EXIF GPS coordinates...</span>
                  </div>
                )}
                {ocrExtracting && (
                  <div className="location-banner analyzing" data-testid="ocr-analyzing">
                    <span>🔍 Scanning photo watermark text for GPS coordinates (OCR)...</span>
                  </div>
                )}
                {locationFeedback && (
                  <div className={`location-banner ${locationFeedback.type}`} data-testid="location-feedback-banner">
                    <span className="feedback-text">{locationFeedback.message}</span>
                    {locationSource === "exif" && (
                      <span className="source-tag exif-tag">Photo EXIF GPS</span>
                    )}
                    {locationSource === "ocr" && (
                      <span className="source-tag ocr-tag">Photo Watermark OCR</span>
                    )}
                    {locationSource === "manual" && (
                      <span className="source-tag manual-tag">Manual Pin</span>
                    )}
                  </div>
                )}
                {!markerPosition && !locationFeedback && !exifExtracting && !ocrExtracting && (
                  <div className="location-banner empty" data-testid="location-empty-banner">
                    <span>⚠️ No location selected yet. Click on the map to place a pin, or upload a photo containing EXIF GPS or watermark.</span>
                  </div>
                )}
              </div>
              
              <div className="map-container">
                <MapContainer 
                  center={defaultCenter} 
                  zoom={13} 
                  style={{ height: "380px", width: "100%" }}
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
                          <em>Source: {
                            locationSource === "exif" ? "Photo EXIF GPS" :
                            locationSource === "ocr" ? "Photo Watermark OCR" :
                            "Manual Pin"
                          }</em>
                        </div>
                      </Popup>
                    </Marker>
                  )}
                </MapContainer>
              </div>

              {candidateConflict && (
                <div className="conflict-card" data-testid="coordinate-conflict-card">
                  <div className="conflict-header">
                    <span className="conflict-icon">⚠️</span>
                    <h4>Location Discrepancy Detected</h4>
                  </div>
                  <p className="conflict-desc">
                    Photo EXIF metadata and visible watermark text indicate different locations ({formatDistance(candidateConflict.distanceMeters)} apart). Please select the authoritative incident coordinates:
                  </p>
                  <div className="conflict-options">
                    <button
                      type="button"
                      className={`candidate-btn ${locationSource === "exif" ? "active" : ""}`}
                      onClick={() => handleSelectCandidate("exif")}
                      data-testid="choose-exif-btn"
                    >
                      <span className="candidate-title">📷 Photo EXIF GPS</span>
                      <span className="candidate-coords">
                        {formatCoordinates(candidateConflict.exif.lat, candidateConflict.exif.lng)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`candidate-btn ${locationSource === "ocr" ? "active" : ""}`}
                      onClick={() => handleSelectCandidate("ocr")}
                      data-testid="choose-ocr-btn"
                    >
                      <span className="candidate-title">🔍 Watermark OCR</span>
                      <span className="candidate-coords">
                        {formatCoordinates(candidateConflict.ocr.lat, candidateConflict.ocr.lng)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`candidate-btn manual ${locationSource === "manual" ? "active" : ""}`}
                      onClick={() => handleSelectCandidate("manual")}
                      data-testid="choose-manual-btn"
                    >
                      <span className="candidate-title">📍 Pin on Map Manually</span>
                      <span className="candidate-coords">Click anywhere on the map</span>
                    </button>
                  </div>
                </div>
              )}

              <div className="wizard-actions-row">
                <button
                  type="button"
                  className="cancel-btn wizard-back-btn"
                  onClick={() => {
                    setStepValidationError("");
                    setWizardStep(1);
                  }}
                  data-testid="step-2-back-btn"
                >
                  <ChevronLeft size={18} />
                  <span>Back: Describe</span>
                </button>
                <button
                  type="button"
                  className="cancel-btn form-inline-cancel-btn"
                  onClick={handleCancelReport}
                  data-testid="step-2-cancel-btn"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="wizard-next-btn primary-btn"
                  onClick={handleNextFromStep2}
                  data-testid="step-2-next-btn"
                >
                  <span>Next: Review & Submit</span>
                  <ChevronRight size={18} />
                </button>
              </div>
            </div>

            {/* STEP 3: Review and Submit */}
            <div 
              className={`wizard-step-panel step-3 ${wizardStep === 3 ? "active" : "step-hidden"}`}
              data-testid="wizard-step-3"
            >
              <div className="step-panel-header">
                <h3>Step 3: Review and Submit</h3>
                <p>Review the details of your issue before final submission.</p>
              </div>

              <div className="review-summary-card" data-testid="wizard-review-summary">
                <div className="review-row">
                  <span className="review-label">Issue Type:</span>
                  <span className="review-value" data-testid="review-category-value">
                    {newIssue.type ? newIssue.type.replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()) : "Not selected"}
                  </span>
                </div>
                <div className="review-row">
                  <span className="review-label">Description:</span>
                  <span className="review-value" data-testid="review-description-value">
                    {newIssue.description || "None provided"}
                  </span>
                </div>
                <div className="review-row">
                  <span className="review-label">Location:</span>
                  <span className="review-value" data-testid="review-location-value">
                    {markerPosition ? (
                      <>
                        <span>Lat: {markerPosition[0].toFixed(5)}, Lng: {markerPosition[1].toFixed(5)}</span>
                        <span className="source-tag mini">
                          {locationSource === "exif" ? "Photo EXIF" : locationSource === "ocr" ? "Watermark OCR" : "Manual Pin"}
                        </span>
                      </>
                    ) : (
                      "No location selected"
                    )}
                  </span>
                </div>
                <div className="review-row">
                  <span className="review-label">Photo Evidence:</span>
                  <span className="review-value" data-testid="review-photo-value">
                    {imagePreview ? (
                      <div className="review-photo-container">
                        <img src={imagePreview} alt="Review Preview" className="review-photo-thumb" />
                        <span className="review-photo-name">{newIssue.image?.name}</span>
                      </div>
                    ) : (
                      "No photo attached (optional)"
                    )}
                  </span>
                </div>
              </div>

              <div className="review-notice">
                <CheckCircle2 size={16} />
                <span>By submitting, this report will be prioritized in the municipal dispatch triage queue.</span>
              </div>

              <div className="wizard-actions-row">
                <button
                  type="button"
                  className="cancel-btn wizard-back-btn"
                  onClick={() => {
                    setStepValidationError("");
                    setWizardStep(2);
                  }}
                  data-testid="step-3-back-btn"
                >
                  <ChevronLeft size={18} />
                  <span>Back: Location</span>
                </button>
                <button
                  type="button"
                  className="cancel-btn form-inline-cancel-btn"
                  onClick={handleCancelReport}
                  data-testid="step-3-cancel-btn"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="submit-btn primary-btn"
                  disabled={!markerPosition || submitting}
                  data-testid="submit-report-btn"
                >
                  {submitting && <span className="btn-spinner"></span>}
                  {submitting ? "Submitting..." : "Submit Report"}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
      
      <div className="issues-section">
        <div className="section-header-row">
          <div>
            <h2>Your Reported Issues</h2>
            <p className="section-subtitle">Real-time status tracking for issues submitted by your account</p>
          </div>
          {userIssues.length > 0 && (
            <span className="issues-count-badge">
              {userIssues.length} {userIssues.length === 1 ? "Issue" : "Issues"}
            </span>
          )}
        </div>
        
        {loading ? (
          <div className="page-loading" data-testid="issues-loading">Loading your issues...</div>
        ) : fetchError ? (
          <div className="issues-error-state" data-testid="issues-error">
            <AlertTriangle size={32} className="error-icon" />
            <p>{fetchError}</p>
            <button
              type="button"
              className="btn-retry"
              onClick={() => fetchUserIssues()}
              data-testid="issues-retry-btn"
            >
              Retry
            </button>
          </div>
        ) : userIssues.length === 0 ? (
          <div className="issues-empty-state" data-testid="issues-empty">
            <div className="empty-state-icon">
              <Layers size={36} />
            </div>
            <p className="no-issues-msg">You haven't reported any issues yet.</p>
            <p className="empty-subtext">
              Spot a pothole, street light outage, or municipal problem? Click "Report New Issue" above to submit your report.
            </p>
            {!isReporting && (
              <button
                type="button"
                className="report-btn empty-action-btn"
                onClick={handleOpenReport}
              >
                <Plus size={16} /> Report Your First Issue
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="issues-list">
              {(() => {
                const totalPages = Math.ceil(userIssues.length / PAGE_SIZE) || 1;
                const safePage = Math.min(Math.max(1, currentPage), totalPages);
                const startIndex = (safePage - 1) * PAGE_SIZE;
                const endIndex = safePage * PAGE_SIZE;
                const paginatedIssues = userIssues.slice(startIndex, endIndex);

                return paginatedIssues.map((issue) => (
                  <div key={issue._id} className="issue-card" data-testid="issue-card">
                    <div className="issue-card-meta-bar">
                      <span className="issue-ref-id">
                        {issue._id ? `#${issue._id.slice(-6).toUpperCase()}` : "ISSUE"}
                      </span>
                      <span className={`status-pill status-${issue.status}`}>
                        <span 
                          className="status-indicator" 
                          style={getStatusStyle(issue.status)}
                          title={issue.status}
                        ></span>
                        <span className="status-pill-text">
                          {issue.status ? issue.status.replace(/-/g, " ").replace(/\b\w/g, l => l.toUpperCase()) : "Reported"}
                        </span>
                      </span>
                    </div>

                    <div className="issue-header">
                      <h3>{issue.type}</h3>
                    </div>
                    
                    <p className="description">{issue.description}</p>
                    
                    {issue.imageUrl && (
                      <div className="issue-image-container">
                        <img 
                          src={getImageUrl(issue.imageUrl)}
                          alt={issue.type} 
                          className="issue-image"
                          loading="lazy"
                        />
                      </div>
                    )}
                    
                    <div className="issue-footer">
                      <span className="votes">Votes: {issue.votes}</span>
                      <span className="date">
                        {new Date(issue.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                ));
              })()}
            </div>

            {userIssues.length > PAGE_SIZE && (() => {
              const totalPages = Math.ceil(userIssues.length / PAGE_SIZE) || 1;
              const safePage = Math.min(Math.max(1, currentPage), totalPages);
              const startIndex = (safePage - 1) * PAGE_SIZE;
              const endIndex = safePage * PAGE_SIZE;

              return (
                <div className="pagination-bar" data-testid="citizen-pagination">
                  <span className="pagination-info">
                    Showing {startIndex + 1}–{Math.min(endIndex, userIssues.length)} of {userIssues.length} issues
                  </span>
                  <div className="pagination-controls">
                    <button
                      type="button"
                      className="pagination-btn"
                      disabled={safePage === 1}
                      onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                      data-testid="pagination-prev"
                      aria-label="Previous page"
                    >
                      Previous
                    </button>
                    <span className="pagination-page-label">
                      Page {safePage} of {totalPages}
                    </span>
                    <button
                      type="button"
                      className="pagination-btn"
                      disabled={safePage >= totalPages}
                      onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                      data-testid="pagination-next"
                      aria-label="Next page"
                    >
                      Next
                    </button>
                  </div>
                </div>
              );
            })()}
          </>
        )}
      </div>
      
      {userIssues.length > 0 && (
        <div className="issues-map-container">
          <div className="section-header-row">
            <div>
              <h2>Map of Your Issues</h2>
              <p className="section-subtitle">Geographic visualization of your reported incidents and current status</p>
            </div>
          </div>
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