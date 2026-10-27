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
    <div data-testid="mock-marker" data-lat={position?.[0]} data-lng={position?.[1]}>
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
    error: jest.fn(),
    dismiss: jest.fn()
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

describe("CivicVision AI - Citizen Form Cancellation & Clean Reset (Task 1.2)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    if (typeof window !== "undefined") {
      window.URL.createObjectURL = jest.fn(() => "mock-blob-url");
      window.URL.revokeObjectURL = jest.fn();
    }
    localStorage.setItem("token", "mock-citizen-jwt-token");
    API.get.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    localStorage.clear();
  });

  test("1. Clicking Cancel clears description, category, and closes the report form", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(API.get).toHaveBeenCalledWith("/issues/user", expect.any(Object)));

    // Open report form
    fireEvent.click(screen.getByRole("button", { name: /Report New Issue/i }));
    expect(screen.getByRole("button", { name: /Cancel Report/i })).toBeInTheDocument();

    // Type a description and change category
    const descInput = screen.getByLabelText(/Description:/i);
    fireEvent.change(descInput, { target: { value: "Broken water main flooding road" } });
    expect(descInput.value).toBe("Broken water main flooding road");

    const categorySelect = screen.getByLabelText(/Issue Type:/i);
    fireEvent.change(categorySelect, { target: { value: "water-leak" } });
    expect(categorySelect.value).toBe("water-leak");

    // Click Cancel Report in header
    fireEvent.click(screen.getByRole("button", { name: /Cancel Report/i }));

    // Form should be closed
    expect(screen.queryByLabelText(/Description:/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Report New Issue/i })).toBeInTheDocument();

    // Reopen the form: verify description is cleared and category is back to default
    fireEvent.click(screen.getByRole("button", { name: /Report New Issue/i }));
    const reopenedDesc = screen.getByLabelText(/Description:/i);
    expect(reopenedDesc.value).toBe("");

    const reopenedCategory = screen.getByLabelText(/Issue Type:/i);
    expect(reopenedCategory.value).toBe("pothole");
  });

  test("2. Clicking Cancel clears selected image, image preview, and file input value", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(API.get).toHaveBeenCalledWith("/issues/user", expect.any(Object)));

    fireEvent.click(screen.getByRole("button", { name: /Report New Issue/i }));

    const file = new File(["dummy image bytes"], "pothole_evidence.jpg", { type: "image/jpeg" });
    const fileInput = screen.getByTestId("image-file-input");

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });

    // Verify file name and preview are visible
    expect(screen.getByTestId("file-name")).toHaveTextContent("pothole_evidence.jpg");
    expect(screen.getByTestId("image-preview-container")).toBeInTheDocument();
    expect(screen.getByTestId("image-preview-thumb")).toBeInTheDocument();

    // Click Cancel
    fireEvent.click(screen.getByTestId("cancel-report-btn"));

    // Reopen form
    fireEvent.click(screen.getByTestId("report-new-issue-btn"));

    // File name should be 'No file chosen', preview should be gone
    expect(screen.getByTestId("file-name")).toHaveTextContent("No file chosen");
    expect(screen.queryByTestId("image-preview-container")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detect-ocr-btn")).not.toBeInTheDocument();
  });

  test("3. Removing image preview directly resets file selection", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(API.get).toHaveBeenCalledWith("/issues/user", expect.any(Object)));

    fireEvent.click(screen.getByRole("button", { name: /Report New Issue/i }));

    const file = new File(["dummy image bytes"], "temporary_trash.jpg", { type: "image/jpeg" });
    const fileInput = screen.getByTestId("image-file-input");

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });

    expect(screen.getByTestId("image-preview-container")).toBeInTheDocument();

    // Click remove photo button
    const removeBtn = screen.getByTestId("btn-remove-preview");
    fireEvent.click(removeBtn);

    expect(screen.queryByTestId("image-preview-container")).not.toBeInTheDocument();
    expect(screen.getByTestId("file-name")).toHaveTextContent("No file chosen");
  });

  test("4. Clicking Cancel clears temporary location, markers, and conflict banners", async () => {
    jest.spyOn(exifParser, "extractExifGps").mockResolvedValue({
      success: true,
      latitude: 11.345,
      longitude: 77.725
    });

    render(<Dashboard />);
    await waitFor(() => expect(API.get).toHaveBeenCalledWith("/issues/user", expect.any(Object)));

    fireEvent.click(screen.getByRole("button", { name: /Report New Issue/i }));

    const file = new File(["geotagged bytes"], "geotagged.jpg", { type: "image/jpeg" });
    const fileInput = screen.getByTestId("image-file-input");

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });

    // Marker should be placed from EXIF
    expect(await screen.findByTestId("mock-marker")).toBeInTheDocument();
    expect(screen.getByTestId("exif-success-badge")).toBeInTheDocument();

    // Cancel report
    fireEvent.click(screen.getByTestId("cancel-report-btn"));

    // Reopen form
    fireEvent.click(screen.getByTestId("report-new-issue-btn"));

    // Marker, EXIF badge, and location feedback should be gone
    expect(screen.queryByTestId("mock-marker")).not.toBeInTheDocument();
    expect(screen.queryByTestId("exif-success-badge")).not.toBeInTheDocument();
    expect(screen.getByTestId("location-empty-banner")).toBeInTheDocument();
  });

  test("5. Inline form Cancel button behaves identically to header Cancel button", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(API.get).toHaveBeenCalledWith("/issues/user", expect.any(Object)));

    fireEvent.click(screen.getByRole("button", { name: /Report New Issue/i }));

    const descInput = screen.getByLabelText(/Description:/i);
    fireEvent.change(descInput, { target: { value: "Draft that citizen decides to abandon" } });

    // Click the bottom form inline cancel button
    const formCancelBtn = screen.getByTestId("form-inline-cancel-btn");
    expect(formCancelBtn).toBeInTheDocument();
    fireEvent.click(formCancelBtn);

    // Form should close
    expect(screen.queryByLabelText(/Description:/i)).not.toBeInTheDocument();

    // Reopen form: state is clean
    fireEvent.click(screen.getByRole("button", { name: /Report New Issue/i }));
    expect(screen.getByLabelText(/Description:/i).value).toBe("");
  });

  test("6. Form cancellation never clears already submitted user issues", async () => {
    const mockExisting = [
      {
        _id: "issue-prev-001",
        type: "pothole",
        description: "Previously reported crater on 2nd avenue",
        status: "reported",
        location: { coordinates: [77.7281, 11.3424] },
        createdAt: new Date().toISOString()
      }
    ];
    API.get.mockResolvedValueOnce({ data: mockExisting });

    render(<Dashboard />);
    await waitFor(() => expect(API.get).toHaveBeenCalledWith("/issues/user", expect.any(Object)));

    // Verify pre-existing issue description is rendered
    expect(screen.getAllByText("Previously reported crater on 2nd avenue").length).toBeGreaterThan(0);

    // Open form, type a draft, and cancel
    fireEvent.click(screen.getByRole("button", { name: /Report New Issue/i }));
    fireEvent.change(screen.getByLabelText(/Description:/i), { target: { value: "Abandoned draft" } });
    fireEvent.click(screen.getByTestId("cancel-report-btn"));

    // Pre-existing issue must still be in the document
    expect(screen.getAllByText("Previously reported crater on 2nd avenue").length).toBeGreaterThan(0);
  });
});
