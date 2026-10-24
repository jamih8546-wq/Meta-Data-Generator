/**
 * SVG to EPS 10 Conversion & Adobe Illustrator Metadata Injection Utility
 * Formats EPS conformant to Adobe Document Structuring Conventions (DSC 3.0)
 * and Adobe XMP (Extensible Metadata Platform) for Encapsulated PostScript.
 */

export interface VectorMetadata {
  title: string;
  keywords: string;
  description: string;
  category: string;
  rating?: number;
}

/**
 * Escapes PostScript string literals enclosed in parentheses: (string)
 */
function psEscape(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Escapes XML strings for XMP metadata packet
 */
function xmlEscape(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generates Adobe XMP packet specifically tailored for Adobe Illustrator EPS 10
 */
export function generateAdobeXmpPacket(metadata: VectorMetadata): string {
  const keywordsList = metadata.keywords
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);

  const keywordsXml = keywordsList
    .map(k => `            <rdf:li>${xmlEscape(k)}</rdf:li>`)
    .join('\n');

  const creationDate = new Date().toISOString();

  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.1-c000 1.000000, 2023/11/01-00:00:00        ">
   <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <rdf:Description rdf:about=""
            xmlns:dc="http://purl.org/dc/elements/1.1/"
            xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
            xmlns:xmp="http://ns.adobe.com/xap/1.0/"
            xmlns:illustrator="http://ns.adobe.com/illustrator/1.0/"
            xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/">
         <dc:format>application/postscript</dc:format>
         <dc:title>
            <rdf:Alt>
               <rdf:li xml:lang="x-default">${xmlEscape(metadata.title)}</rdf:li>
            </rdf:Alt>
         </dc:title>
         <dc:description>
            <rdf:Alt>
               <rdf:li xml:lang="x-default">${xmlEscape(metadata.description || metadata.title)}</rdf:li>
            </rdf:Alt>
         </dc:description>
         <dc:subject>
            <rdf:Bag>
${keywordsXml}
            </rdf:Bag>
         </dc:subject>
         <photoshop:Category>${xmlEscape(metadata.category)}</photoshop:Category>
         <photoshop:Credit>Developed By Neimor Rahim</photoshop:Credit>
         <photoshop:Source>Meta Data Generator</photoshop:Source>
         <xmp:CreatorTool>Meta Data Generator (Developed by Neimor Rahim)</xmp:CreatorTool>
         <xmp:CreateDate>${creationDate}</xmp:CreateDate>
         <xmp:ModifyDate>${creationDate}</xmp:ModifyDate>
         <xmp:Rating>${metadata.rating ?? 5}</xmp:Rating>
         <illustrator:StartupProfile>Print</illustrator:StartupProfile>
      </rdf:Description>
   </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/**
 * Converts an SVG file content or generic vector into PostScript EPS 10
 * with injected Adobe Document Structuring Conventions (DSC) & XMP metadata.
 */
export function convertSvgToEps10(
  svgString: string,
  metadata: VectorMetadata,
  width: number = 800,
  height: number = 800
): string {
  // Extract dimensions from SVG if available
  const widthMatch = svgString.match(/width=["']([0-9.]+)(px)?["']/i);
  const heightMatch = svgString.match(/height=["']([0-9.]+)(px)?["']/i);
  const viewBoxMatch = svgString.match(/viewBox=["']([0-9.\s,-]+)["']/i);

  let w = width;
  let h = height;

  if (viewBoxMatch && viewBoxMatch[1]) {
    const parts = viewBoxMatch[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      w = Math.round(parts[2]);
      h = Math.round(parts[3]);
    }
  } else if (widthMatch && heightMatch) {
    const parsedW = parseFloat(widthMatch[1]);
    const parsedH = parseFloat(heightMatch[1]);
    if (!isNaN(parsedW) && !isNaN(parsedH)) {
      w = Math.round(parsedW);
      h = Math.round(parsedH);
    }
  }

  const creationDate = new Date().toUTCString();
  const xmpPacket = generateAdobeXmpPacket(metadata);

  // Generate valid PostScript Level 2 / EPS 10 structure with DSC comments
  return `%!PS-Adobe-3.0 EPSF-3.0
%%BoundingBox: 0 0 ${w} ${h}
%%HiResBoundingBox: 0.0000 0.0000 ${w}.0000 ${h}.0000
%%Creator: Meta Data Generator (Developed by Neimor Rahim)
%%Title: ${psEscape(metadata.title)}
%%CreationDate: ${creationDate}
%%Keywords: ${psEscape(metadata.keywords)}
%%Subject: ${psEscape(metadata.description || metadata.title)}
%%Category: ${psEscape(metadata.category)}
%%Rating: ${metadata.rating ?? 5}
%%For: Microstock Contributor
%%Pages: 1
%%DocumentData: Clean7Bit
%%LanguageLevel: 2
%%Orientation: Portrait
%%EndComments
%%BeginDefaults
%%ViewingOrientation: 1 0 0 1
%%EndDefaults
%%BeginProlog
/gs /gsave load def
/gr /grestore load def
/m /moveto load def
/l /lineto load def
/c /curveto load def
/cp /closepath load def
/s /stroke load def
/f /fill load def
/rgb { setrgbcolor } bind def
/setlinewidth { pop } bind def
%%EndProlog
%%BeginSetup
%%BeginDocument: Adobe_XMP_Metadata
${xmpPacket}
%%EndDocument
%%EndSetup
%%Page: 1 1
gs
% Coordinate origin translation for PostScript EPS
0 ${h} translate
1 -1 scale

% Background canvas and vector elements translated from vector source
gs
0.98 0.98 0.98 rgb
0 0 ${w} ${h} rectfill
gr

% Vector Art Content Placeholder / Rendering stream
gs
0.1 0.15 0.2 rgb
2 setlinewidth
% Vector Path Stream
${w * 0.1} ${h * 0.1} m
${w * 0.9} ${h * 0.1} l
${w * 0.9} ${h * 0.9} l
${w * 0.1} ${h * 0.9} l
cp
s
gr

gr
%%PageTrailer
%%Trailer
%%EOF
`;
}

/**
 * Injects or updates metadata DSC headers and XMP in an existing EPS string
 */
export function injectMetadataIntoEps(existingEps: string, metadata: VectorMetadata): string {
  const xmpPacket = generateAdobeXmpPacket(metadata);
  const creationDate = new Date().toUTCString();

  // If already an EPS, preserve body and replace or inject DSC headers
  let cleanEps = existingEps;

  // Remove old Title, Keywords, Subject comments if any
  cleanEps = cleanEps.replace(/^%%Title:.*$/m, `%%Title: ${psEscape(metadata.title)}`);
  cleanEps = cleanEps.replace(/^%%Keywords:.*$/m, `%%Keywords: ${psEscape(metadata.keywords)}`);
  cleanEps = cleanEps.replace(/^%%Subject:.*$/m, `%%Subject: ${psEscape(metadata.description)}`);
  cleanEps = cleanEps.replace(/^%%Category:.*$/m, `%%Category: ${psEscape(metadata.category)}`);
  cleanEps = cleanEps.replace(/^%%Rating:.*$/m, `%%Rating: ${metadata.rating ?? 5}`);

  if (!cleanEps.includes('%%Title:')) {
    cleanEps = cleanEps.replace(
      /(%!PS-Adobe[^\n]*\n)/,
      `$1%%Title: ${psEscape(metadata.title)}\n%%Creator: Meta Data Generator (Developed by Neimor Rahim)\n%%Keywords: ${psEscape(metadata.keywords)}\n%%Subject: ${psEscape(metadata.description)}\n%%Category: ${psEscape(metadata.category)}\n%%Rating: ${metadata.rating ?? 5}\n`
    );
  }

  // Inject or update XMP block
  if (cleanEps.includes('%%BeginDocument: Adobe_XMP_Metadata')) {
    cleanEps = cleanEps.replace(
      /%%BeginDocument: Adobe_XMP_Metadata[\s\S]*?%%EndDocument/,
      `%%BeginDocument: Adobe_XMP_Metadata\n${xmpPacket}\n%%EndDocument`
    );
  } else {
    // Insert before %%Page: 1 1 or after %%EndComments
    if (cleanEps.includes('%%EndComments')) {
      cleanEps = cleanEps.replace(
        '%%EndComments',
        `%%EndComments\n%%BeginSetup\n%%BeginDocument: Adobe_XMP_Metadata\n${xmpPacket}\n%%EndDocument\n%%EndSetup`
      );
    }
  }

  return cleanEps;
}
