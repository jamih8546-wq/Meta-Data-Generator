/**
 * High-Precision Universal JPEG Metadata Injector
 * Embeds synchronized EXIF (including Windows Explorer XP tags & 5-star rating),
 * Photoshop IPTC-NAA (stock photo platform standard), and Adobe XMP packets
 * directly into JPEG files without re-encoding or image quality degradation.
 */

import { VectorMetadata, generateAdobeXmpPacket } from './svgToEps';

/**
 * Encodes string to UTF-16LE / UCS-2 LE with double null terminator (0x00 0x00).
 * Required by Microsoft Windows File Explorer for XPTitle, XPComment, XPAuthor, XPKeywords, XPSubject.
 */
function encodeUcs2Le(str: string): Uint8Array {
  const bytes = new Uint8Array((str.length + 1) * 2);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = (code >> 8) & 0xff;
  }
  bytes[str.length * 2] = 0x00;
  bytes[str.length * 2 + 1] = 0x00;
  return bytes;
}

/**
 * Encodes string to ASCII byte array with trailing null
 */
function encodeAsciiNull(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length + 1);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i) & 0x7f;
  }
  bytes[str.length] = 0x00;
  return bytes;
}

/**
 * Encodes UTF-8 byte array
 */
function encodeUtf8(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/**
 * Constructs a fully compliant TIFF/EXIF APP1 segment containing standard EXIF
 * and Windows File Explorer Properties tags (XPTitle, XPKeywords, Rating, etc.)
 */
export function buildExifApp1Segment(metadata: VectorMetadata): Uint8Array {
  const title = (metadata.title || '').trim();
  const description = (metadata.description || title).trim();
  const author = 'Developed By Neimor Rahim';
  const copyright = 'Developed By Neimor Rahim';
  const software = 'Meta Data Generator';

  // Windows Explorer "Tags" expect semicolon-delimited keywords
  const rawKeywords = (metadata.keywords || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  const xpKeywordsStr = rawKeywords.join('; ');

  const ratingVal = Math.min(5, Math.max(1, metadata.rating || 5));
  const ratingPercentVal = ratingVal * 20 - 1; // 5 -> 99

  // Prepare variable buffers
  const bufImageDesc = encodeAsciiNull(title || description);
  const bufSoftware = encodeAsciiNull(software);
  const bufArtist = encodeAsciiNull(author);
  const bufCopyright = encodeAsciiNull(copyright);
  const bufXPTitle = encodeUcs2Le(title);
  const bufXPComment = encodeUcs2Le(description);
  const bufXPAuthor = encodeUcs2Le(author);
  const bufXPKeywords = encodeUcs2Le(xpKeywordsStr);
  const bufXPSubject = encodeUcs2Le(description || title);

  // Define IFD0 entries (MUST BE SORTED BY TAG ID IN STRICT ASCENDING ORDER)
  interface IfdEntryDef {
    tag: number;
    type: number; // 1=BYTE, 2=ASCII, 3=SHORT, 4=LONG
    count: number;
    valueOrBuf: number | Uint8Array;
  }

  const entries: IfdEntryDef[] = [
    { tag: 0x010e, type: 2, count: bufImageDesc.length, valueOrBuf: bufImageDesc },
    { tag: 0x0131, type: 2, count: bufSoftware.length, valueOrBuf: bufSoftware },
    { tag: 0x013b, type: 2, count: bufArtist.length, valueOrBuf: bufArtist },
    { tag: 0x4746, type: 3, count: 1, valueOrBuf: ratingVal },
    { tag: 0x4749, type: 3, count: 1, valueOrBuf: ratingPercentVal },
    { tag: 0x8298, type: 2, count: bufCopyright.length, valueOrBuf: bufCopyright },
    { tag: 0x9c9b, type: 1, count: bufXPTitle.length, valueOrBuf: bufXPTitle },
    { tag: 0x9c9c, type: 1, count: bufXPComment.length, valueOrBuf: bufXPComment },
    { tag: 0x9c9d, type: 1, count: bufXPAuthor.length, valueOrBuf: bufXPAuthor },
    { tag: 0x9c9e, type: 1, count: bufXPKeywords.length, valueOrBuf: bufXPKeywords },
    { tag: 0x9c9f, type: 1, count: bufXPSubject.length, valueOrBuf: bufXPSubject }
  ];

  // TIFF Header: 'II' (0x49 0x49), 42 (0x2A 0x00), offset to IFD0 (8)
  const tiffHeaderLen = 8;
  const numEntries = entries.length;
  const ifdTableLen = 2 + numEntries * 12 + 4; // count + entries + next IFD offset
  let dataOffset = tiffHeaderLen + ifdTableLen;

  // Calculate total data size
  let totalDataLen = 0;
  for (const e of entries) {
    if (e.valueOrBuf instanceof Uint8Array) {
      if (e.valueOrBuf.length > 4) {
        totalDataLen += e.valueOrBuf.length + (e.valueOrBuf.length % 2 !== 0 ? 1 : 0);
      }
    }
  }

  const tiffBuffer = new Uint8Array(tiffHeaderLen + ifdTableLen + totalDataLen);
  const view = new DataView(tiffBuffer.buffer);

  // 1. TIFF Header
  tiffBuffer[0] = 0x49; // 'I'
  tiffBuffer[1] = 0x49; // 'I' (Little Endian)
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true); // Offset of IFD0

  // 2. IFD0 Count
  view.setUint16(8, numEntries, true);

  // 3. IFD0 Entries
  let entryPos = 10;
  let currentDataPos = tiffHeaderLen + ifdTableLen;

  for (const e of entries) {
    view.setUint16(entryPos, e.tag, true);
    view.setUint16(entryPos + 2, e.type, true);
    view.setUint32(entryPos + 4, e.count, true);

    if (e.valueOrBuf instanceof Uint8Array) {
      if (e.valueOrBuf.length <= 4) {
        tiffBuffer.set(e.valueOrBuf, entryPos + 8);
      } else {
        view.setUint32(entryPos + 8, currentDataPos, true);
        tiffBuffer.set(e.valueOrBuf, currentDataPos);
        currentDataPos += e.valueOrBuf.length;
        if (e.valueOrBuf.length % 2 !== 0) {
          tiffBuffer[currentDataPos] = 0;
          currentDataPos++;
        }
      }
    } else {
      // Numerical value (e.g., SHORT)
      view.setUint16(entryPos + 8, e.valueOrBuf, true);
      view.setUint16(entryPos + 10, 0, true);
    }

    entryPos += 12;
  }

  // Next IFD offset = 0
  view.setUint32(entryPos, 0, true);

  // Wrap in JPEG APP1 segment: 0xFF, 0xE1, length (2 bytes), 'Exif\0\0' (6 bytes), tiffBuffer
  const exifHeader = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]); // 'Exif\0\0'
  const payloadLen = exifHeader.length + tiffBuffer.length;
  const markerLen = payloadLen + 2;

  const app1 = new Uint8Array(2 + 2 + payloadLen);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1[2] = (markerLen >> 8) & 0xff;
  app1[3] = markerLen & 0xff;
  app1.set(exifHeader, 4);
  app1.set(tiffBuffer, 4 + exifHeader.length);

  return app1;
}

/**
 * Constructs an IPTC-NAA APP13 Photoshop segment (0xFFED)
 * Stock photo platforms (Shutterstock, Adobe Stock, Freepik) rely directly on this for metadata extraction.
 */
export function buildIptcApp13Segment(metadata: VectorMetadata): Uint8Array {
  const title = (metadata.title || '').trim();
  const description = (metadata.description || title).trim();
  const category = (metadata.category || 'Arts, Objects').trim();
  const author = 'Developed By Neimor Rahim';
  const copyright = 'Developed By Neimor Rahim';

  const rawKeywords = (metadata.keywords || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

  // Build IPTC records (Tag Marker 0x1C, Record 0x02, Dataset ID, Data Length 2-bytes big-endian, Data)
  const iptcChunks: Uint8Array[] = [];

  function addIptcTag(dataset: number, text: string | Uint8Array) {
    const bytes = typeof text === 'string' ? encodeUtf8(text) : text;
    if (bytes.length === 0) return;
    const chunk = new Uint8Array(5 + bytes.length);
    chunk[0] = 0x1c;
    chunk[1] = 0x02;
    chunk[2] = dataset & 0xff;
    chunk[3] = (bytes.length >> 8) & 0xff;
    chunk[4] = bytes.length & 0xff;
    chunk.set(bytes, 5);
    iptcChunks.push(chunk);
  }

  // 2:00 Record Version
  addIptcTag(0x00, new Uint8Array([0x00, 0x04]));
  // 2:05 Object Name / Title
  addIptcTag(0x05, title);
  // 2:15 Category
  addIptcTag(0x0f, category);
  // 2:25 Keywords (EACH keyword as a separate tag!)
  for (const kw of rawKeywords) {
    addIptcTag(0x19, kw);
  }
  // 2:80 By-line (Author)
  addIptcTag(0x50, author);
  // 2:116 Copyright Notice
  addIptcTag(0x74, copyright);
  // 2:120 Caption / Abstract (Description)
  addIptcTag(0x78, description);

  let totalIptcLen = 0;
  for (const c of iptcChunks) totalIptcLen += c.length;

  const iptcData = new Uint8Array(totalIptcLen);
  let iptcPos = 0;
  for (const c of iptcChunks) {
    iptcData.set(c, iptcPos);
    iptcPos += c.length;
  }

  // Photoshop 3.0 8BIM structure:
  // Signature: 'Photoshop 3.0\0' (14 bytes)
  // 8BIM Block: '8BIM' (4 bytes), 0x0404 (2 bytes), 0x0000 (2 bytes), Resource size (4 bytes), iptcData, pad if odd
  const psHeader = encodeUtf8('Photoshop 3.0\0');
  const padByte = iptcData.length % 2 !== 0 ? 1 : 0;
  const bimBlockLen = 4 + 2 + 2 + 4 + iptcData.length + padByte;

  const bimBlock = new Uint8Array(bimBlockLen);
  const bimView = new DataView(bimBlock.buffer);
  bimBlock.set(encodeUtf8('8BIM'), 0);
  bimView.setUint16(4, 0x0404, false); // IPTC-NAA resource ID (big-endian)
  bimView.setUint16(6, 0x0000, false); // Pascal string empty
  bimView.setUint32(8, iptcData.length, false); // IPTC data size
  bimBlock.set(iptcData, 12);
  if (padByte) bimBlock[12 + iptcData.length] = 0x00;

  const payloadLen = psHeader.length + bimBlock.length;
  const markerLen = payloadLen + 2;

  const app13 = new Uint8Array(2 + 2 + payloadLen);
  app13[0] = 0xff;
  app13[1] = 0xed;
  app13[2] = (markerLen >> 8) & 0xff;
  app13[3] = markerLen & 0xff;
  app13.set(psHeader, 4);
  app13.set(bimBlock, 4 + psHeader.length);

  return app13;
}

/**
 * Constructs an Adobe XMP APP1 segment (0xFFE1) with namespace http://ns.adobe.com/xap/1.0/
 */
export function buildXmpApp1Segment(metadata: VectorMetadata): Uint8Array {
  const xmpString = generateAdobeXmpPacket(metadata);
  const header = encodeUtf8('http://ns.adobe.com/xap/1.0/\0');
  const xmpBytes = encodeUtf8(xmpString);

  const payloadLen = header.length + xmpBytes.length;
  const markerLen = payloadLen + 2;

  const app1 = new Uint8Array(2 + 2 + payloadLen);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1[2] = (markerLen >> 8) & 0xff;
  app1[3] = markerLen & 0xff;
  app1.set(header, 4);
  app1.set(xmpBytes, 4 + header.length);

  return app1;
}

/**
 * Embeds synchronized EXIF + IPTC + XMP metadata directly into a JPEG ArrayBuffer.
 * Lossless, instantaneous, with zero recompression.
 */
export function embedXmpIntoJpegBuffer(jpegBuffer: ArrayBuffer, metadata: VectorMetadata): ArrayBuffer {
  const bytes = new Uint8Array(jpegBuffer);

  // Validate SOI marker (0xFFD8)
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('Invalid JPEG format: Missing SOI marker (0xFFD8)');
  }

  const exifSegment = buildExifApp1Segment(metadata);
  const xmpSegment = buildXmpApp1Segment(metadata);
  const iptcSegment = buildIptcApp13Segment(metadata);

  // Scan and parse existing JPEG markers before Start Of Scan (SOS: 0xFFDA)
  let pos = 2;
  const preservedSegments: Uint8Array[] = [];

  while (pos < bytes.length - 1) {
    if (bytes[pos] !== 0xff) {
      pos++;
      continue;
    }

    const marker = bytes[pos + 1];

    // Reached start of scan or end of image
    if (marker === 0xda || marker === 0xd9) {
      break;
    }

    // Standalone 2-byte markers (RST0-RST7, TEM)
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      preservedSegments.push(bytes.subarray(pos, pos + 2));
      pos += 2;
      continue;
    }

    const segLen = (bytes[pos + 2] << 8) | bytes[pos + 3];
    const totalSegLen = 2 + segLen;

    // Filter out old EXIF (APP1), XMP (APP1), and Photoshop (APP13) markers to prevent collision/stale data
    const isApp1 = marker === 0xe1;
    const isApp13 = marker === 0xed;

    if (!isApp1 && !isApp13) {
      preservedSegments.push(bytes.subarray(pos, pos + totalSegLen));
    }

    pos += totalSegLen;
  }

  // The remaining slice is the image entropy scan data to EOI
  const remainingScanData = bytes.subarray(pos);

  // If there's an APP0 (JFIF) preserved, place it first right after SOI
  const jfifSegments: Uint8Array[] = [];
  const otherSegments: Uint8Array[] = [];

  for (const seg of preservedSegments) {
    if (seg[0] === 0xff && seg[1] === 0xe0) {
      jfifSegments.push(seg);
    } else {
      otherSegments.push(seg);
    }
  }

  // Compute total output size
  let outputSize = 2; // SOI
  for (const s of jfifSegments) outputSize += s.length;
  outputSize += exifSegment.length;
  outputSize += xmpSegment.length;
  outputSize += iptcSegment.length;
  for (const s of otherSegments) outputSize += s.length;
  outputSize += remainingScanData.length;

  const out = new Uint8Array(outputSize);
  out[0] = 0xff;
  out[1] = 0xd8;

  let outPos = 2;

  // 1. APP0 JFIF (if any)
  for (const s of jfifSegments) {
    out.set(s, outPos);
    outPos += s.length;
  }

  // 2. Comprehensive APP1 EXIF (Windows XPTitle, XPKeywords, Rating)
  out.set(exifSegment, outPos);
  outPos += exifSegment.length;

  // 3. APP1 Adobe XMP
  out.set(xmpSegment, outPos);
  outPos += xmpSegment.length;

  // 4. APP13 Photoshop IPTC
  out.set(iptcSegment, outPos);
  outPos += iptcSegment.length;

  // 5. Preserved DQT, SOF, DHT, etc.
  for (const s of otherSegments) {
    out.set(s, outPos);
    outPos += s.length;
  }

  // 6. SOS scan data and EOI
  out.set(remainingScanData, outPos);

  return out.buffer;
}

/**
 * High-performance, memory-safe conversion from Uint8Array to base64.
 * Uses native Buffer in Electron/Node, or 32KB chunking in browser.
 * NEVER creates millions of individual character strings that cause OOM/black screen crashes.
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  // Check global Buffer or Electron window.Buffer
  const NodeBuffer =
    typeof Buffer !== 'undefined'
      ? Buffer
      : (typeof window !== 'undefined' && (window as any).Buffer)
      ? (window as any).Buffer
      : null;

  if (NodeBuffer && typeof NodeBuffer.from === 'function') {
    return NodeBuffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }

  // Safe chunked conversion (32KB chunks) for browser
  let binary = '';
  const len = bytes.byteLength;
  const chunkSize = 32768;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * High-performance, memory-safe conversion from base64 to Uint8Array.
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const NodeBuffer =
    typeof Buffer !== 'undefined'
      ? Buffer
      : (typeof window !== 'undefined' && (window as any).Buffer)
      ? (window as any).Buffer
      : null;

  if (NodeBuffer && typeof NodeBuffer.from === 'function') {
    const buf = NodeBuffer.from(base64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
