import { extractExifGps, parseExifFromBuffer, formatCoordinates } from "./exifParser";

/**
 * Helper to construct a synthetic JPEG buffer with custom TIFF/EXIF GPS data.
 */
function createSyntheticExifJpeg({
  byteOrder = 0x4D4D, // 0x4D4D (MM, Big Endian) or 0x4949 (II, Little Endian)
  latDms = [11, 20, 32.7],
  latRef = "N",
  lngDms = [77, 43, 41.4],
  lngRef = "E",
  corruptDenominator = false,
  omitGpsPointer = false,
  nonJpeg = false
} = {}) {
  if (nonJpeg) {
    const buf = new Uint8Array(64);
    buf.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    return buf.buffer;
  }

  const littleEndian = byteOrder === 0x4949;
  const buffer = new ArrayBuffer(512);
  const view = new DataView(buffer);

  // 1. JPEG SOI: 0xFFD8
  view.setUint16(0, 0xFFD8, false);

  // 2. APP1 Marker: 0xFFE1, length: placeholder
  view.setUint16(2, 0xFFE1, false);
  view.setUint16(4, 500, false); // Length

  // 3. Exif header: "Exif\0\0"
  view.setUint32(6, 0x45786966, false);
  view.setUint16(10, 0x0000, false);

  // 4. TIFF Header at offset 12
  const tiffOffset = 12;
  view.setUint16(tiffOffset, byteOrder, false); // Byte order
  view.setUint16(tiffOffset + 2, 0x002A, littleEndian); // Magic 42
  view.setUint32(tiffOffset + 4, 8, littleEndian); // Offset to IFD0 (relative to tiffOffset)

  // 5. IFD0 at tiffOffset + 8 = offset 20
  const ifd0Offset = tiffOffset + 8;
  const numIfd0Entries = omitGpsPointer ? 0 : 1;
  view.setUint16(ifd0Offset, numIfd0Entries, littleEndian);

  if (!omitGpsPointer) {
    // Tag 0x8825 (GPSInfo IFD pointer)
    const entryOffset = ifd0Offset + 2;
    view.setUint16(entryOffset, 0x8825, littleEndian);
    view.setUint16(entryOffset + 2, 4, littleEndian); // LONG type
    view.setUint32(entryOffset + 4, 1, littleEndian); // Count 1
    const gpsIfdOffsetRel = 32; // Relative to tiffOffset
    view.setUint32(entryOffset + 8, gpsIfdOffsetRel, littleEndian);

    // 6. GPS IFD at tiffOffset + 32 = offset 44
    const gpsIfdOffset = tiffOffset + gpsIfdOffsetRel;
    view.setUint16(gpsIfdOffset, 4, littleEndian); // 4 entries: latRef, lat, lngRef, lng

    // Entry 0: GPSLatitudeRef (0x0001)
    const e0 = gpsIfdOffset + 2;
    view.setUint16(e0, 0x0001, littleEndian);
    view.setUint16(e0 + 2, 2, littleEndian); // ASCII
    view.setUint32(e0 + 4, 2, littleEndian);
    view.setUint8(e0 + 8, latRef.charCodeAt(0));

    // Entry 1: GPSLatitude (0x0002) - 3 RATIONALs (24 bytes)
    const e1 = e0 + 12;
    view.setUint16(e1, 0x0002, littleEndian);
    view.setUint16(e1 + 2, 5, littleEndian); // RATIONAL
    view.setUint32(e1 + 4, 3, littleEndian);
    const latDataOffsetRel = 100;
    view.setUint32(e1 + 8, latDataOffsetRel, littleEndian);

    // Entry 2: GPSLongitudeRef (0x0003)
    const e2 = e1 + 12;
    view.setUint16(e2, 0x0003, littleEndian);
    view.setUint16(e2 + 2, 2, littleEndian); // ASCII
    view.setUint32(e2 + 4, 2, littleEndian);
    view.setUint8(e2 + 8, lngRef.charCodeAt(0));

    // Entry 3: GPSLongitude (0x0004) - 3 RATIONALs (24 bytes)
    const e3 = e2 + 12;
    view.setUint16(e3, 0x0004, littleEndian);
    view.setUint16(e3 + 2, 5, littleEndian); // RATIONAL
    view.setUint32(e3 + 4, 3, littleEndian);
    const lngDataOffsetRel = 124;
    view.setUint32(e3 + 8, lngDataOffsetRel, littleEndian);

    // Write Latitude Rationals at tiffOffset + 100
    const latDataAbs = tiffOffset + latDataOffsetRel;
    // Deg
    view.setUint32(latDataAbs, Math.round(latDms[0]), littleEndian);
    view.setUint32(latDataAbs + 4, 1, littleEndian);
    // Min
    view.setUint32(latDataAbs + 8, Math.round(latDms[1]), littleEndian);
    view.setUint32(latDataAbs + 12, 1, littleEndian);
    // Sec
    view.setUint32(latDataAbs + 16, Math.round(latDms[2] * 100), littleEndian);
    view.setUint32(latDataAbs + 20, corruptDenominator ? 0 : 100, littleEndian);

    // Write Longitude Rationals at tiffOffset + 124
    const lngDataAbs = tiffOffset + lngDataOffsetRel;
    // Deg
    view.setUint32(lngDataAbs, Math.round(lngDms[0]), littleEndian);
    view.setUint32(lngDataAbs + 4, 1, littleEndian);
    // Min
    view.setUint32(lngDataAbs + 8, Math.round(lngDms[1]), littleEndian);
    view.setUint32(lngDataAbs + 12, 1, littleEndian);
    // Sec
    view.setUint32(lngDataAbs + 16, Math.round(lngDms[2] * 100), littleEndian);
    view.setUint32(lngDataAbs + 20, 100, littleEndian);
  }

  return buffer;
}

describe("CivicVision AI - Pure Client-side EXIF GPS Parser", () => {
  test("1. Successfully extracts coordinates from Big-Endian (Motorola) EXIF JPEG", async () => {
    const buffer = createSyntheticExifJpeg({
      byteOrder: 0x4D4D,
      latDms: [11, 20, 32.7],
      latRef: "N",
      lngDms: [77, 43, 41.4],
      lngRef: "E"
    });

    const result = await extractExifGps(buffer);
    expect(result.success).toBe(true);
    expect(result.latitude).toBeCloseTo(11.342417, 4);
    expect(result.longitude).toBeCloseTo(77.728167, 4);
    expect(result.source).toBe("exif");
  });

  test("2. Successfully extracts coordinates from Little-Endian (Intel) EXIF JPEG", async () => {
    const buffer = createSyntheticExifJpeg({
      byteOrder: 0x4949,
      latDms: [11, 20, 32.7],
      latRef: "N",
      lngDms: [77, 43, 41.4],
      lngRef: "E"
    });

    const result = await extractExifGps(buffer);
    expect(result.success).toBe(true);
    expect(result.latitude).toBeCloseTo(11.342417, 4);
    expect(result.longitude).toBeCloseTo(77.728167, 4);
  });

  test("3. Accurately handles Southern and Western coordinates with negative signs", async () => {
    const buffer = createSyntheticExifJpeg({
      latDms: [33, 51, 0],
      latRef: "S",
      lngDms: [151, 12, 0],
      lngRef: "W"
    });

    const result = await extractExifGps(buffer);
    expect(result.success).toBe(true);
    expect(result.latitude).toBeCloseTo(-33.85, 2);
    expect(result.longitude).toBeCloseTo(-151.20, 2);
  });

  test("4. Gracefully rejects missing EXIF metadata without throwing", async () => {
    const buffer = createSyntheticExifJpeg({ omitGpsPointer: true });
    const result = await extractExifGps(buffer);
    expect(result.success).toBe(false);
    expect(result.latitude).toBeNull();
    expect(result.longitude).toBeNull();
    expect(result.error).toMatch(/No GPS/i);
  });

  test("5. Rejects non-JPEG files safely", async () => {
    const buffer = createSyntheticExifJpeg({ nonJpeg: true });
    const result = await extractExifGps(buffer);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Not a valid JPEG/i);
  });

  test("6. Rejects division by zero in rational GPS metadata", async () => {
    const buffer = createSyntheticExifJpeg({ corruptDenominator: true });
    const result = await extractExifGps(buffer);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Incomplete GPS/i);
  });

  test("7. Rejects out-of-bounds GPS coordinates (e.g., latitude > 90)", async () => {
    const buffer = createSyntheticExifJpeg({
      latDms: [95, 0, 0],
      latRef: "N"
    });
    const result = await extractExifGps(buffer);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/out of bounds/i);
  });

  test("8. Gracefully handles null, undefined, or empty file input", async () => {
    const resNull = await extractExifGps(null);
    expect(resNull.success).toBe(false);

    const resEmpty = await extractExifGps(new ArrayBuffer(10));
    expect(resEmpty.success).toBe(false);
  });

  test("9. Formats coordinate strings into clear human-readable presentation", () => {
    expect(formatCoordinates(11.3424, 77.7282)).toBe("11.3424° N, 77.7282° E");
    expect(formatCoordinates(-33.85, -151.2)).toBe("33.8500° S, 151.2000° W");
    expect(formatCoordinates(null, null)).toBe("Unavailable");
  });
});
