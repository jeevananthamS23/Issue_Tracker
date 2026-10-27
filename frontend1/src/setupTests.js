import '@testing-library/jest-dom';
import React from 'react';
import { TextEncoder, TextDecoder } from 'util';

global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

// Mock react-leaflet because it is a pure ESM package and requires browser canvas APIs
jest.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div data-testid="map-container">{children}</div>,
  TileLayer: () => <div data-testid="tile-layer" />,
  Marker: ({ children }) => <div data-testid="marker">{children}</div>,
  Popup: ({ children }) => <div data-testid="popup">{children}</div>,
  useMap: () => ({ setView: jest.fn() }),
  useMapEvents: () => null,
}));

// Safe URL mocks for file previews in test environment
if (typeof window !== "undefined") {
  window.URL.createObjectURL = jest.fn(() => "mock-blob-url");
  window.URL.revokeObjectURL = jest.fn();
}
if (typeof global !== "undefined" && global.URL) {
  global.URL.createObjectURL = jest.fn(() => "mock-blob-url");
  global.URL.revokeObjectURL = jest.fn();
}
