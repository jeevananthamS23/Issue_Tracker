import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import Dashboard from "./Dashboard";
import API from "../api/api";
import { toast } from "react-toastify";
import * as exifParser from "../utils/exifParser";

let mapClickHandler = null;

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
  useMapEvents: (handlers) => {
    mapClickHandler = handlers?.click || null;
    return null;
  },
  useMap: () => ({ flyTo: jest.fn() })
}));

// Mock Leaflet
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

// Mock API
jest.mock("../api/api", () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn()
  },
  getImageUrl: (url) => url
}));

describe("CivicVision AI - Three-Step Citizen Reporting Wizard (Task 2.2)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mapClickHandler = null;
    if (typeof window !== "undefined") {
      window.URL.createObjectURL = jest.fn(() => "mock-blob-preview-url");
      window.URL.revokeObjectURL = jest.fn();
    }
    localStorage.setItem("token", "mock-citizen-token");
    API.get.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    localStorage.clear();
  });

  test("1. Initial wizard step and step indicator on opening form", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(API.get).toHaveBeenCalledWith("/issues/user", expect.any(Object)));

    // Open form
    fireEvent.click(screen.getByRole("button", { name: /Report New Issue/i }));

    // Stepper is rendered
    expect(screen.getByTestId("wizard-step-indicator")).toBeInTheDocument();

    // Step 1 indicator is active
    const step1Indicator = screen.getByTestId("wizard-step-1-indicator");
    expect(step1Indicator).toHaveAttribute("aria-current", "step");

    // Step 1 panel is visible
    expect(screen.getByTestId("wizard-step-1")).toBeInTheDocument();
    expect(screen.getByText(/Step 1: Describe the Issue/i)).toBeInTheDocument();

    // Description and Type inputs are ready
    expect(screen.getByLabelText(/Issue Type:/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Description:/i)).toBeInTheDocument();
  });

  test("2. Required-field validation prevents continuing from Step 1", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(API.get).toHaveBeenCalledWith("/issues/user", expect.any(Object)));

    fireEvent.click(screen.getByRole("button", { name: /Report New Issue/i }));

    // Attempt to proceed without entering description
    const nextBtn = screen.getByTestId("step-1-next-btn");
    fireEvent.click(nextBtn);

    // Validation error banner should be displayed
    const errorBanner = screen.getByTestId("step-1-validation-error");
    expect(errorBanner).toBeInTheDocument();
    expect(errorBanner).toHaveTextContent(/Please provide a description of the issue/i);

    // Still on Step 1
    expect(screen.getByTestId("wizard-step-1-indicator")).toHaveAttribute("aria-current", "step");
  });

  test("3. Forward navigation to Step 2 and backward navigation to Step 1 with data preservation", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(API.get).toHaveBeenCalledWith("/issues/user", expect.any(Object)));

    fireEvent.click(screen.getByRole("button", { name: /Report New Issue/i }));

    // Fill valid details
    fireEvent.change(screen.getByLabelText(/Issue Type:/i), { target: { value: "street-light" } });
    fireEvent.change(screen.getByLabelText(/Description:/i), {
      target: { value: "Street light flickering repeatedly on 4th street" }
    });

    // Advance to Step 2
    fireEvent.click(screen.getByTestId("step-1-next-btn"));

    // Step 2 is now active
    expect(screen.getByTestId("wizard-step-2-indicator")).toHaveAttribute("aria-current", "step");
    expect(screen.getByText(/Step 2: Add a Photo & Location/i)).toBeInTheDocument();

    // Click back to Step 1
    const backBtn = screen.getByTestId("step-2-back-btn");
    expect(backBtn).toHaveTextContent(/Back: Describe/i);
    fireEvent.click(backBtn);

    // Verified back on Step 1 with preserved values
    expect(screen.getByTestId("wizard-step-1-indicator")).toHaveAttribute("aria-current", "step");
    expect(screen.getByLabelText(/Issue Type:/i).value).toBe("street-light");
    expect(screen.getByLabelText(/Description:/i).value).toBe(
      "Street light flickering repeatedly on 4th street"
    );
  });

  test("4. Step 2 validation prevents proceeding to Step 3 without an incident location", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(API.get).toHaveBeenCalledWith("/issues/user", expect.any(Object)));

    fireEvent.click(screen.getByRole("button", { name: /Report New Issue/i }));

    // Provide description and move to Step 2
    fireEvent.change(screen.getByLabelText(/Description:/i), { target: { value: "Damaged sidewalk" } });
    fireEvent.click(screen.getByTestId("step-1-next-btn"));

    expect(screen.getByTestId("wizard-step-2-indicator")).toHaveAttribute("aria-current", "step");

    // Click Next on Step 2 without location
    const step2NextBtn = screen.getByTestId("step-2-next-btn");
    fireEvent.click(step2NextBtn);

    // Validation error shown on Step 2
    const errorBanner = screen.getByTestId("step-2-validation-error");
    expect(errorBanner).toBeInTheDocument();
    expect(errorBanner).toHaveTextContent(/Please select an incident location on the map/i);

    // Still on Step 2
    expect(screen.getByTestId("wizard-step-2-indicator")).toHaveAttribute("aria-current", "step");
  });

  test("5. Review summary accurately reflects issue details, photo, and location in Step 3", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(API.get).toHaveBeenCalledWith("/issues/user", expect.any(Object)));

    fireEvent.click(screen.getByRole("button", { name: /Report New Issue/i }));

    // Step 1: Issue details
    fireEvent.change(screen.getByLabelText(/Issue Type:/i), { target: { value: "pothole" } });
    fireEvent.change(screen.getByLabelText(/Description:/i), {
      target: { value: "Deep hazardous pothole in front of library" }
    });
    fireEvent.click(screen.getByTestId("step-1-next-btn"));

    // Step 2: Attach photo
    const file = new File(["dummy"], "pothole_photo.jpg", { type: "image/jpeg" });
    const fileInput = screen.getByTestId("image-file-input");
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });

    expect(screen.getByTestId("file-name")).toHaveTextContent("pothole_photo.jpg");
    expect(screen.getByTestId("image-preview-container")).toBeInTheDocument();

    // Place marker on map manually via mapClickHandler
    expect(typeof mapClickHandler).toBe("function");
    act(() => {
      mapClickHandler({ latlng: { lat: 11.3415, lng: 77.728 } });
    });

    // Advance to Step 3
    fireEvent.click(screen.getByTestId("step-2-next-btn"));

    // Step 3 is now active
    expect(screen.getByTestId("wizard-step-3-indicator")).toHaveAttribute("aria-current", "step");
    expect(screen.getByTestId("wizard-review-summary")).toBeInTheDocument();

    // Verify review summary values
    expect(screen.getByTestId("review-category-value")).toHaveTextContent("Pothole");
    expect(screen.getByTestId("review-description-value")).toHaveTextContent("Deep hazardous pothole in front of library");
    expect(screen.getByTestId("review-location-value")).toHaveTextContent("Lat: 11.34150, Lng: 77.72800");
    expect(screen.getByTestId("review-photo-value")).toHaveTextContent("pothole_photo.jpg");

    // Can go back to Step 2
    fireEvent.click(screen.getByTestId("step-3-back-btn"));
    expect(screen.getByTestId("wizard-step-2-indicator")).toHaveAttribute("aria-current", "step");
  });

  test("6. Duplicate-submit prevention and submission handling", async () => {
    let resolvePost;
    const pendingPromise = new Promise((resolve) => {
      resolvePost = resolve;
    });
    API.post.mockReturnValue(pendingPromise);

    render(<Dashboard />);
    await waitFor(() => expect(API.get).toHaveBeenCalledWith("/issues/user", expect.any(Object)));

    fireEvent.click(screen.getByRole("button", { name: /Report New Issue/i }));

    // Fill Step 1
    fireEvent.change(screen.getByLabelText(/Description:/i), {
      target: { value: "Flooding on main road" }
    });
    fireEvent.click(screen.getByTestId("step-1-next-btn"));

    // Step 2: Set location
    expect(typeof mapClickHandler).toBe("function");
    act(() => {
      mapClickHandler({ latlng: { lat: 11.3415, lng: 77.728 } });
    });
    fireEvent.click(screen.getByTestId("step-2-next-btn"));

    // Step 3: Submit report
    const submitBtn = screen.getByTestId("submit-report-btn");
    expect(submitBtn).toBeEnabled();

    // Submit form
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    // Submitting state activated - button is disabled
    expect(submitBtn).toBeDisabled();
    expect(screen.getByText("Submitting...")).toBeInTheDocument();

    // Second click does nothing because disabled
    fireEvent.click(submitBtn);
    expect(API.post).toHaveBeenCalledTimes(1);

    // Resolve post
    await act(async () => {
      resolvePost({ data: { message: "Created" } });
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Issue reported successfully!");
    });
  });

  test("7. API failure displays error toast and re-enables submission", async () => {
    API.post.mockRejectedValueOnce({
      response: { data: { message: "Database connection timeout during triage dispatch" } }
    });

    render(<Dashboard />);
    await waitFor(() => expect(API.get).toHaveBeenCalledWith("/issues/user", expect.any(Object)));

    fireEvent.click(screen.getByRole("button", { name: /Report New Issue/i }));

    // Step 1
    fireEvent.change(screen.getByLabelText(/Description:/i), {
      target: { value: "Clogged drainage channel" }
    });
    fireEvent.click(screen.getByTestId("step-1-next-btn"));

    // Step 2
    expect(typeof mapClickHandler).toBe("function");
    act(() => {
      mapClickHandler({ latlng: { lat: 11.3415, lng: 77.728 } });
    });
    fireEvent.click(screen.getByTestId("step-2-next-btn"));

    // Step 3: Submit
    const submitBtn = screen.getByTestId("submit-report-btn");
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    // Toast error shown with server message
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Database connection timeout during triage dispatch");
    });

    // Button re-enabled after failure
    expect(submitBtn).not.toBeDisabled();
    expect(screen.getByText("Submit Report")).toBeInTheDocument();
  });

  test("8. Form cancellation resets wizard back to Step 1 cleanly", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(API.get).toHaveBeenCalledWith("/issues/user", expect.any(Object)));

    fireEvent.click(screen.getByRole("button", { name: /Report New Issue/i }));

    // Fill Step 1 and proceed to Step 2
    fireEvent.change(screen.getByLabelText(/Description:/i), { target: { value: "Broken pipe" } });
    fireEvent.click(screen.getByTestId("step-1-next-btn"));

    expect(screen.getByTestId("wizard-step-2-indicator")).toHaveAttribute("aria-current", "step");

    // Click Cancel in Step 2
    const step2CancelBtn = screen.getByTestId("step-2-cancel-btn");
    fireEvent.click(step2CancelBtn);

    // Form should be closed
    expect(screen.queryByTestId("wizard-step-indicator")).not.toBeInTheDocument();

    // Reopen form: wizardStep is reset to 1
    fireEvent.click(screen.getByRole("button", { name: /Report New Issue/i }));
    expect(screen.getByTestId("wizard-step-1-indicator")).toHaveAttribute("aria-current", "step");
    expect(screen.getByLabelText(/Description:/i).value).toBe("");
  });
});
