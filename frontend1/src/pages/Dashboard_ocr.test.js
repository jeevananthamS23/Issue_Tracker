import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import Dashboard from "./Dashboard";
import API from "../api/api";
import * as exifParser from "../utils/exifParser";

// Mock react-leaflet
jest.mock("react-leaflet", () => ({
  MapContainer: ({ children }) => <div data-testid="mock-map-container">{children}</div>,
  TileLayer: () => <div data-testid="mock-tile-layer" />,
  Marker: ({ children, position }) => (
    <div data-testid="mock-marker" data-lat={position[0]} data-lng={position[1]}>
      {children}
    </div>
  ),
  Popup: ({ children }) => <div data-testid="mock-popup">{children}</div>,
  useMapEvents: () => null,
  useMap: () => ({ flyTo: jest.fn() })
}));

// Mock Leaflet icon
jest.mock("leaflet", () => {
  const original = jest.requireActual("leaflet");
  return {
    ...original,
    icon: () => ({}),
    divIcon: () => ({}),
    Marker: {
      prototype: {
        options: {}
      }
    }
  };
});

// Mock react-toastify
jest.mock("react-toastify", () => ({
  toast: {
    info: jest.fn(),
    success: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }
}));

// Mock API module
jest.mock("../api/api", () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn()
  },
  getImageUrl: (url) => url
}));

describe("CivicVision AI - Citizen OCR GPS Extraction & Conflict Handling", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.setItem("token", "mock-citizen-jwt-token");
    API.get.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    localStorage.clear();
  });

  test("1. Opens report form and initially shows empty location warning banner", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(API.get).toHaveBeenCalledWith("/issues/user", expect.any(Object)));

    const reportBtn = screen.getByRole("button", { name: /Report New Issue/i });
    fireEvent.click(reportBtn);

    expect(screen.getByTestId("location-empty-banner")).toBeInTheDocument();
    expect(screen.queryByTestId("detect-ocr-btn")).not.toBeInTheDocument();
  });

  test("2. Selecting an image without EXIF exposes the 'Detect coordinates from photo' button", async () => {
    jest.spyOn(exifParser, "extractExifGps").mockResolvedValue({
      success: false,
      latitude: null,
      longitude: null
    });

    render(<Dashboard />);
    fireEvent.click(screen.getByRole("button", { name: /Report New Issue/i }));

    const file = new File(["dummy content"], "plain_photo.jpg", { type: "image/jpeg" });
    const fileInput = document.querySelector('input[type="file"]');

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });

    // Detect OCR button should now be visible
    const ocrBtn = await screen.findByTestId("detect-ocr-btn");
    expect(ocrBtn).toBeInTheDocument();
    expect(ocrBtn).toHaveTextContent(/Detect coordinates from photo/i);
  });

  test("3. Clicking OCR button triggers API call and places pin on successful detection", async () => {
    jest.spyOn(exifParser, "extractExifGps").mockResolvedValue({
      success: false,
      latitude: null,
      longitude: null
    });

    API.post.mockResolvedValueOnce({
      data: {
        success: true,
        found: true,
        latitude: 11.341234,
        longitude: 77.721456,
        confidence: 0.95,
        format: "degrees_minutes_seconds",
        message: "GPS coordinates detected successfully from photo."
      }
    });

    render(<Dashboard />);
    fireEvent.click(screen.getByRole("button", { name: /Report New Issue/i }));

    const file = new File(["dummy content"], "watermarked_gps.jpg", { type: "image/jpeg" });
    const fileInput = document.querySelector('input[type="file"]');

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });

    const ocrBtn = await screen.findByTestId("detect-ocr-btn");

    await act(async () => {
      fireEvent.click(ocrBtn);
    });

    expect(API.post).toHaveBeenCalledWith(
      "/issues/extract-ocr",
      expect.any(FormData),
      expect.objectContaining({
        headers: expect.objectContaining({ "Content-Type": "multipart/form-data" })
      })
    );

    // Marker should now be placed at OCR coordinates
    const marker = await screen.findByTestId("mock-marker");
    expect(marker).toHaveAttribute("data-lat", "11.341234");
    expect(marker).toHaveAttribute("data-lng", "77.721456");

    // OCR success badge should be displayed
    expect(screen.getByTestId("ocr-success-badge")).toBeInTheDocument();
  });

  test("4. Conflicting EXIF and OCR coordinates (> 50m) trigger location discrepancy card", async () => {
    // 1. Photo has EXIF at 11.3412, 77.7214
    jest.spyOn(exifParser, "extractExifGps").mockResolvedValue({
      success: true,
      latitude: 11.3412,
      longitude: 77.7214,
      source: "exif"
    });

    // 2. OCR returns coordinates ~142m away at 11.3425, 77.7214
    API.post.mockResolvedValueOnce({
      data: {
        success: true,
        found: true,
        latitude: 11.3425,
        longitude: 77.7214,
        confidence: 0.92,
        format: "degrees_minutes_seconds",
        message: "GPS coordinates detected successfully."
      }
    });

    render(<Dashboard />);
    fireEvent.click(screen.getByRole("button", { name: /Report New Issue/i }));

    const file = new File(["exif+watermark content"], "conflicting.jpg", { type: "image/jpeg" });
    const fileInput = document.querySelector('input[type="file"]');

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });

    // EXIF placed pin first
    expect(await screen.findByTestId("exif-success-badge")).toBeInTheDocument();

    const ocrBtn = await screen.findByTestId("detect-ocr-btn");
    await act(async () => {
      fireEvent.click(ocrBtn);
    });

    // Location discrepancy conflict card should be rendered
    const conflictCard = await screen.findByTestId("coordinate-conflict-card");
    expect(conflictCard).toBeInTheDocument();
    expect(conflictCard).toHaveTextContent(/Location Discrepancy Detected/i);
    expect(screen.getByTestId("choose-exif-btn")).toBeInTheDocument();
    expect(screen.getByTestId("choose-ocr-btn")).toBeInTheDocument();
    expect(screen.getByTestId("choose-manual-btn")).toBeInTheDocument();
  });

  test("5. Citizen can choose EXIF or OCR candidate from conflict card to resolve location", async () => {
    jest.spyOn(exifParser, "extractExifGps").mockResolvedValue({
      success: true,
      latitude: 11.3412,
      longitude: 77.7214,
      source: "exif"
    });

    API.post.mockResolvedValueOnce({
      data: {
        success: true,
        found: true,
        latitude: 11.3425,
        longitude: 77.7214,
        confidence: 0.92,
        format: "degrees_minutes_seconds"
      }
    });

    render(<Dashboard />);
    fireEvent.click(screen.getByRole("button", { name: /Report New Issue/i }));

    const fileInput = document.querySelector('input[type="file"]');
    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [new File([""], "conflict.jpg", { type: "image/jpeg" })] }
      });
    });

    const ocrBtn = await screen.findByTestId("detect-ocr-btn");
    await act(async () => {
      fireEvent.click(ocrBtn);
    });

    // Citizen chooses Watermark OCR
    const chooseOcrBtn = await screen.findByTestId("choose-ocr-btn");
    await act(async () => {
      fireEvent.click(chooseOcrBtn);
    });

    // Conflict card should dismiss
    expect(screen.queryByTestId("coordinate-conflict-card")).not.toBeInTheDocument();

    // Marker should update to chosen OCR coordinates
    const marker = screen.getByTestId("mock-marker");
    expect(marker).toHaveAttribute("data-lat", "11.3425");
    expect(marker).toHaveAttribute("data-lng", "77.7214");
  });

  test("6. Changing the image file resets prior OCR results and conflict states", async () => {
    jest.spyOn(exifParser, "extractExifGps").mockResolvedValue({
      success: false,
      latitude: null,
      longitude: null
    });

    API.post.mockResolvedValueOnce({
      data: {
        success: true,
        found: true,
        latitude: 11.3412,
        longitude: 77.7214
      }
    });

    render(<Dashboard />);
    fireEvent.click(screen.getByRole("button", { name: /Report New Issue/i }));

    const fileInput = document.querySelector('input[type="file"]');
    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [new File(["1"], "photo1.jpg", { type: "image/jpeg" })] }
      });
    });

    const ocrBtn = await screen.findByTestId("detect-ocr-btn");
    await act(async () => {
      fireEvent.click(ocrBtn);
    });

    expect(await screen.findByTestId("ocr-success-badge")).toBeInTheDocument();

    // Select a second, different image file
    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [new File(["2"], "photo2.jpg", { type: "image/jpeg" })] }
      });
    });

    // Previous OCR badge and result must be cleared
    expect(screen.queryByTestId("ocr-success-badge")).not.toBeInTheDocument();
  });

  test("7. Submitting issue includes truthful geoSource and locationMetadata in FormData", async () => {
    jest.spyOn(exifParser, "extractExifGps").mockResolvedValue({
      success: false,
      latitude: null,
      longitude: null
    });

    API.post.mockImplementation((url, data) => {
      if (url === "/issues/extract-ocr") {
        return Promise.resolve({
          data: {
            success: true,
            found: true,
            latitude: 11.3456,
            longitude: 77.7234,
            confidence: 0.96,
            format: "degrees_minutes_seconds"
          }
        });
      }
      if (url === "/issues") {
        return Promise.resolve({ data: { message: "Created" } });
      }
      return Promise.resolve({ data: {} });
    });

    render(<Dashboard />);
    fireEvent.click(screen.getByRole("button", { name: /Report New Issue/i }));

    const fileInput = document.querySelector('input[type="file"]');
    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [new File(["abc"], "damage.jpg", { type: "image/jpeg" })] }
      });
    });

    const ocrBtn = await screen.findByTestId("detect-ocr-btn");
    await act(async () => {
      fireEvent.click(ocrBtn);
    });

    // Fill form fields
    fireEvent.change(screen.getByLabelText(/Description:/i), {
      target: { value: "Water leak near community center" }
    });

    // Submit form
    const submitBtn = screen.getByRole("button", { name: /Submit Report/i });
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    expect(API.post).toHaveBeenCalledWith(
      "/issues",
      expect.any(FormData),
      expect.any(Object)
    );

    // Verify submitted FormData fields
    const submitCall = API.post.mock.calls.find(call => call[0] === "/issues");
    const submittedFormData = submitCall[1];
    expect(submittedFormData.get("geoSource")).toBe("ocr");
    expect(submittedFormData.get("lat")).toBe("11.3456");
    expect(submittedFormData.get("lng")).toBe("77.7234");

    const metadataStr = submittedFormData.get("locationMetadata");
    expect(metadataStr).toBeTruthy();
    const metadata = JSON.parse(metadataStr);
    expect(metadata.ocrCoordinates).toEqual([77.7234, 11.3456]);
    expect(metadata.ocrConfidence).toBe(0.96);
  });
});
