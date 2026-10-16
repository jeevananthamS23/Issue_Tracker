/**
 * CivicVision AI — Pure Client-Side EXIF GPS Metadata Extractor
 *
 * Privacy & Security Guarantees:
 * - Runs 100% locally in browser memory via ArrayBuffer & DataView.
 * - Zero network requests, zero telemetry, zero external OCR/API calls.
 * - Zero external npm dependencies.
 * - Strict coordinate validation: latitude [-90, +90], longitude [-180, +180].
 * - Graceful fallback on missing EXIF, non-JPEG, or corrupted headers.
 */

/**
 * Parses GPS coordinates from an image File or ArrayBuffer.
 *
 * @param {File|Blob|ArrayBuffer} fileOrBuffer
 * @returns {Promise<{success: boolean, latitude: number|null, longitude: number|null, source?: string, error?: string}>}
 */
export async function extractExifGps(fileOrBuffer) {
  if (!fileOrBuffer) {
    return { success: false, latitude: null, longitude: null, error: "No file provided" };
  }

  let buffer;
  try {
    if (fileOrBuffer instanceof ArrayBuffer) {
      buffer = fileOrBuffer;
    } else if (fileOrBuffer.arrayBuffer) {
      buffer = await fileOrBuffer.arrayBuffer();
    } else {
      // Fallback for FileReader if arrayBuffer() is unavailable
      buffer = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Failed to read file"));
        reader.readAsArrayBuffer(fileOrBuffer);
      });
    }
  } catch (err) {
    return { success: false, latitude: null, longitude: null, error: "Unable to read image data: " + err.message };
  }

  return parseExifFromBuffer(buffer);
}

/**
 * Synchronous buffer parser for EXIF GPS data.
 *
 * @param {ArrayBuffer} buffer
 * @returns {{success: boolean, latitude: number|null, longitude: number|null, source?: string, error?: string}}
 */
export function parseExifFromBuffer(buffer) {
  if (!buffer || buffer.byteLength < 16) {
    return { success: false, latitude: null, longitude: null, error: "File buffer too small for EXIF" };
  }

  const view = new DataView(buffer);

  // Check JPEG SOI marker: 0xFFD8
  if (view.getUint16(0, false) !== 0xFFD8) {
    return { success: false, latitude: null, longitude: null, error: "Not a valid JPEG image" };
  }

  let offset = 2;
  const length = view.byteLength;

  while (offset + 4 < length) {
    const marker = view.getUint16(offset, false);

    // Stop at Start Of Scan (0xFFDA) or End Of Image (0xFFD9)
    if (marker === 0xFFDA || marker === 0xFFD9) {
      break;
    }

    const sectionLength = view.getUint16(offset + 2, false);
    if (sectionLength < 2 || offset + 2 + sectionLength > length) {
      break; // Malformed section
    }

    // Look for APP1 marker (0xFFE1)
    if (marker === 0xFFE1) {
      // Check for Exif header "Exif\0\0" (0x457869660000)
      if (
        view.getUint32(offset + 4, false) === 0x45786966 &&
        view.getUint16(offset + 8, false) === 0x0000
      ) {
        const tiffOffset = offset + 10;
        return parseTiffGps(view, tiffOffset);
      }
    }

    offset += 2 + sectionLength;
  }

  return { success: false, latitude: null, longitude: null, error: "No EXIF GPS metadata found" };
}

/**
 * Parses TIFF header and GPS IFD entries.
 */
function parseTiffGps(view, tiffOffset) {
  if (tiffOffset + 8 > view.byteLength) {
    return { success: false, latitude: null, longitude: null, error: "Truncated TIFF header" };
  }

  // Determine byte alignment: 0x4949 ('II' Little-Endian), 0x4D4D ('MM' Big-Endian)
  const byteOrder = view.getUint16(tiffOffset, false);
  let littleEndian;
  if (byteOrder === 0x4949) {
    littleEndian = true;
  } else if (byteOrder === 0x4D4D) {
    littleEndian = false;
  } else {
    return { success: false, latitude: null, longitude: null, error: "Invalid TIFF byte alignment" };
  }

  // TIFF magic number: 0x002A (42)
  if (view.getUint16(tiffOffset + 2, littleEndian) !== 0x002A) {
    return { success: false, latitude: null, longitude: null, error: "Invalid TIFF magic number" };
  }

  // Offset to 0th IFD
  const ifd0OffsetRel = view.getUint32(tiffOffset + 4, littleEndian);
  const ifd0Offset = tiffOffset + ifd0OffsetRel;

  if (ifd0Offset + 2 > view.byteLength) {
    return { success: false, latitude: null, longitude: null, error: "Truncated IFD0 offset" };
  }

  const numEntries = view.getUint16(ifd0Offset, littleEndian);
  let gpsInfoOffsetRel = null;

  for (let i = 0; i < numEntries; i++) {
    const entryOffset = ifd0Offset + 2 + i * 12;
    if (entryOffset + 12 > view.byteLength) break;

    const tag = view.getUint16(entryOffset, littleEndian);
    // GPSInfo IFD pointer tag: 0x8825 (34853)
    if (tag === 0x8825) {
      gpsInfoOffsetRel = view.getUint32(entryOffset + 8, littleEndian);
      break;
    }
  }

  if (gpsInfoOffsetRel === null) {
    return { success: false, latitude: null, longitude: null, error: "No GPS sub-IFD pointer present" };
  }

  const gpsOffset = tiffOffset + gpsInfoOffsetRel;
  if (gpsOffset + 2 > view.byteLength) {
    return { success: false, latitude: null, longitude: null, error: "Truncated GPS IFD" };
  }

  const numGpsEntries = view.getUint16(gpsOffset, littleEndian);
  let latRef = null;
  let latCoords = null;
  let lngRef = null;
  let lngCoords = null;

  for (let j = 0; j < numGpsEntries; j++) {
    const entryOffset = gpsOffset + 2 + j * 12;
    if (entryOffset + 12 > view.byteLength) break;

    const tag = view.getUint16(entryOffset, littleEndian);
    const valueOffsetRel = view.getUint32(entryOffset + 8, littleEndian);

    if (tag === 0x0001) {
      // GPSLatitudeRef (1 byte ASCII)
      latRef = String.fromCharCode(view.getUint8(entryOffset + 8));
    } else if (tag === 0x0002) {
      // GPSLatitude (3 RATIONALs = 24 bytes)
      latCoords = readRationals(view, tiffOffset + valueOffsetRel, 3, littleEndian);
    } else if (tag === 0x0003) {
      // GPSLongitudeRef (1 byte ASCII)
      lngRef = String.fromCharCode(view.getUint8(entryOffset + 8));
    } else if (tag === 0x0004) {
      // GPSLongitude (3 RATIONALs = 24 bytes)
      lngCoords = readRationals(view, tiffOffset + valueOffsetRel, 3, littleEndian);
    }
  }

  if (!latCoords || !lngCoords) {
    return { success: false, latitude: null, longitude: null, error: "Incomplete GPS coordinates in EXIF" };
  }

  const latitude = convertDmsToDecimal(latCoords, latRef || "N");
  const longitude = convertDmsToDecimal(lngCoords, lngRef || "E");

  // Validate numeric sanity and geographic bounds
  if (
    typeof latitude !== "number" ||
    isNaN(latitude) ||
    typeof longitude !== "number" ||
    isNaN(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return {
      success: false,
      latitude: null,
      longitude: null,
      error: `Malformed GPS coordinates out of bounds: lat=${latitude}, lng=${longitude}`
    };
  }

  return {
    success: true,
    latitude: Number(latitude.toFixed(6)),
    longitude: Number(longitude.toFixed(6)),
    source: "exif"
  };
}

/**
 * Reads array of rational numbers (numerator/denominator pairs).
 */
function readRationals(view, offset, count, littleEndian) {
  if (offset + count * 8 > view.byteLength) return null;

  const rationals = [];
  for (let i = 0; i < count; i++) {
    const num = view.getUint32(offset + i * 8, littleEndian);
    const den = view.getUint32(offset + i * 8 + 4, littleEndian);
    if (den === 0) return null; // Reject division by zero
    rationals.push(num / den);
  }
  return rationals;
}

/**
 * Converts Degrees, Minutes, Seconds to Decimal Degrees with hemisphere sign.
 */
function convertDmsToDecimal([degrees, minutes, seconds], hemisphere) {
  const decimal = degrees + minutes / 60 + seconds / 3600;
  const upperRef = hemisphere.toUpperCase().trim();
  if (upperRef === "S" || upperRef === "W") {
    return -decimal;
  }
  return decimal;
}

/**
 * Formats decimal coordinates into human-readable representation.
 */
export function formatCoordinates(lat, lng) {
  if (typeof lat !== "number" || typeof lng !== "number" || isNaN(lat) || isNaN(lng)) {
    return "Unavailable";
  }
  const latCard = lat >= 0 ? "N" : "S";
  const lngCard = lng >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(4)}° ${latCard}, ${Math.abs(lng).toFixed(4)}° ${lngCard}`;
}

const EARTH_RADIUS_METERS = 6371000;

/**
 * Calculates great-circle distance between two GPS points in meters using the Haversine formula.
 * @param {number} lat1 - Latitude of point 1 (degrees)
 * @param {number} lon1 - Longitude of point 1 (degrees)
 * @param {number} lat2 - Latitude of point 2 (degrees)
 * @param {number} lon2 - Longitude of point 2 (degrees)
 * @returns {number|null} Distance in meters rounded to 1 decimal place, or null if invalid inputs.
 */
export function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  if (
    typeof lat1 !== "number" || typeof lon1 !== "number" ||
    typeof lat2 !== "number" || typeof lon2 !== "number" ||
    isNaN(lat1) || isNaN(lon1) || isNaN(lat2) || isNaN(lon2)
  ) {
    return null;
  }
  const toRad = deg => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(EARTH_RADIUS_METERS * c * 10) / 10;
}

/**
 * Formats distance in meters into human-readable format (meters or kilometers).
 * @param {number} meters - Distance in meters
 * @returns {string} Formatted string, e.g. "45 m" or "1.25 km"
 */
export function formatDistance(meters) {
  if (typeof meters !== "number" || isNaN(meters) || meters === null || meters === undefined) {
    return "";
  }
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  return `${(meters / 1000).toFixed(2)} km`;
}

