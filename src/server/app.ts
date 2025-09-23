import 'dotenv/config';
import express from "express";
import cors from "cors";
import multer from "multer";
import rateLimit from "express-rate-limit";
import path from "node:path";
import pdf from "pdf-parse";
import crypto from "node:crypto";
import NodeCache from "node-cache";
import sharp from "sharp";
import { makePhotosRouter } from "./photos.js";
import { logger, requestLogger, serializeError, getRequestId } from "./logger.js";
import type { Block } from "@aws-sdk/client-textract";
import { TextractClient, DetectDocumentTextCommand } from "@aws-sdk/client-textract";
import { fromEnv } from "@aws-sdk/credential-providers";

import { createDevStorage } from "./storage.js";
import type { PassportDraft, PassportSealed, ImageRole } from "../types/passport.js";
import { validateDraft, validateSealed } from "../schema/index.js";
import { mapToPassportDraft } from "../ingest/dekra/mapper.js";
import { preprocessImageForOdometer } from "./odometer/preprocess.js";

// ---------- Configuration & Environment ----------
const DATA_DIR = process.env.DATA_DIR || "data";
const PORT = Number(process.env.PORT || 3000);
const API_PREFIX = process.env.API_PREFIX || "/api/v1";
const API_KEY = process.env.API_KEY || ""; 
const PRIVATE_KEY_PEM = process.env.PRIVATE_KEY_PEM || "";
const PUBLIC_KEY_PEM = process.env.PUBLIC_KEY_PEM || "";
const AWS_REGION = process.env.AWS_REGION || "eu-west-1";
const TEXTRACT_MAX_FILE_SIZE = Number(process.env.TEXTRACT_MAX_FILE_SIZE);
const TEXTRACT_CACHE_TTL = Number(process.env.TEXTRACT_CACHE_TTL);


type OdometerCandidateSource = 'text_pattern' | 'line_extraction' | 'digit_grouping';
type OdometerCandidate = {
  value: number;
  raw: string;
  score: number;
  source: OdometerCandidateSource;
  confidence: number;
  bbox?: Block["Geometry"];
};



// ---------- AWS Configuration ----------
function validateAwsConfig(): boolean {
  const required = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    logger.warn('Missing AWS configuration', { missing });
    logger.warn('Textract OCR functionality disabled without AWS credentials');
    return false;
  }

  return true;
}

const hasAwsConfig = validateAwsConfig();

// Singleton Textract client with proper configuration
let textractClient: TextractClient | null = null;
const getTextractClient = () => {
  if (!textractClient && hasAwsConfig) {
    textractClient = new TextractClient({
      region: AWS_REGION,
      credentials: fromEnv(),
      maxAttempts: 3,
      retryMode: "adaptive",
    });
  }
  return textractClient;
};

// OCR result cache for cost optimization
const ocrCache = new NodeCache({ 
  stdTTL: TEXTRACT_CACHE_TTL,
  maxKeys: 1000 
});

// OCR metrics tracking
interface OcrMetrics {
  totalRequests: number;
  successfulRequests: number;
  averageProcessingTime: number;
  vinDetectionRate: number;
  cacheHits: number;
}

const metrics: OcrMetrics = {
  totalRequests: 0,
  successfulRequests: 0,
  averageProcessingTime: 0,
  vinDetectionRate: 0,
  cacheHits: 0
};

// ---------- Utility Functions ----------
function normalizeWhitespace(s: string): string {
  return (s || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\u00A0/g, " ")
    .replace(/\s+\n/g, "\n")
    .trim();
}

function canonicalize(input: any): any {
  if (Array.isArray(input)) return input.map(canonicalize);
  if (input && typeof input === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(input).sort()) out[k] = canonicalize((input as any)[k]);
    return out;
  }
  return input;
}

function canonicalBytes(obj: any): Buffer {
  const canon = canonicalize(obj);
  return Buffer.from(JSON.stringify(canon));
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function getImageHash(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function signBytesRS256(buf: Buffer): string | null {
  if (!PRIVATE_KEY_PEM) return null;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(buf);
  signer.end();
  return signer.sign(PRIVATE_KEY_PEM).toString("base64");
}

function verifyBytesRS256(buf: Buffer, b64sig: string): boolean | null {
  if (!PUBLIC_KEY_PEM) return null;
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(buf);
  verifier.end();
  try {
    return verifier.verify(PUBLIC_KEY_PEM, Buffer.from(b64sig, "base64"));
  } catch {
    return false;
  }
}


// ---- EV detection (VIN heuristic) ----
type EvDetectResult = {
  isElectric: boolean;
  make?: string;
  model?: string;
  smartcarCompatible: boolean;
  batteryEstimateKwh?: number;
  confidence: number;                 // 0..1, because WMI can be shared across ICE/EV
  source: 'vin_heuristic';
  notes?: string;
};

const EV_CAPABILITIES: Record<string, { make: string; smartcar: boolean; battery: number; note?: string }> = {
  WDD: { make: 'Mercedes-Benz', smartcar: true,  battery: 80 }, // EQ family
  WBA: { make: 'BMW',           smartcar: true,  battery: 85 }, // i4/iX
  JYJ: { make: 'Tesla',         smartcar: true,  battery: 75 }, // Model 3/Y
  WVW: { make: 'Volkswagen',    smartcar: true,  battery: 77 }, // ID.3/ID.4 (region dependent)
  // NOTE: BYD ZA imports often show "LGX" as WMI (not LYV; LYV is Volvo).
  // Add/adjust as you see real VINs on site:
  LGX: { make: 'BYD', smartcar: false, battery: 60, note: 'Confirm locally' },
};

function detectEVFromVin(vinRaw: string): EvDetectResult {
  const vin = (vinRaw || '').trim().toUpperCase();
  if (vin.length !== 17) {
    return { isElectric: false, smartcarCompatible: false, confidence: 0, source: 'vin_heuristic', notes: 'invalid_vin_length' };
  }
  const wmi = vin.substring(0, 3);
  const match = EV_CAPABILITIES[wmi];
  // Be conservative; increase to 0.9 for WMIs you verify as EV-only in SA.
  const confidence = match ? 0.7 : 0;
  return {
    isElectric: !!match,
    make: match?.make,
    model: undefined,
    smartcarCompatible: match?.smartcar ?? false,
    batteryEstimateKwh: match?.battery,
    confidence,
    source: 'vin_heuristic',
    notes: match?.note,
  };
}


// ---------- Enhanced VIN Functions ----------
function sanitizeVin(v?: string) {
  return (v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 17);
}

function normalizeVin(raw: string) {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/[IOQ]/g, "").slice(0, 17);
}

function isValidVin(vin: string): boolean {
  if (!vin || vin.length !== 17) return false;
  
  // Character set validation - VINs exclude I, O, Q to avoid confusion
  if (!/^[A-HJ-NPR-Z0-9]{17}$/i.test(vin)) return false;
  
  // VIN check digit validation (position 9)
  const weights = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
  const values: { [key: string]: number } = {
    '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    'A': 1, 'B': 2, 'C': 3, 'D': 4, 'E': 5, 'F': 6, 'G': 7, 'H': 8,
    'J': 1, 'K': 2, 'L': 3, 'M': 4, 'N': 5, 'P': 7, 'R': 9, 'S': 2,
    'T': 3, 'U': 4, 'V': 5, 'W': 6, 'X': 7, 'Y': 8, 'Z': 9
  };
  
  const upper = vin.toUpperCase();
  let sum = 0;
  
  for (let i = 0; i < 17; i++) {
    if (i === 8) continue;
    sum += (values[upper[i]] || 0) * weights[i];
  }
  
  const checkDigit = sum % 11;
  const expectedCheck = checkDigit === 10 ? 'X' : checkDigit.toString();
  return upper[8] === expectedCheck;
}

function findOdometerCandidates(text: string): OdometerCandidate[] {
  const candidates: OdometerCandidate[] = [];
  
  // Common odometer indicators
  const odometerKeywords = /\b(km|miles|mi|odometer|odo|total|mileage)\b/i;
  const speedKeywords = /\b(km\/h|mph|speed|kph)\b/i;
  
  // Look for numbers near odometer keywords
  const lines = text.split('\n');
  for (const line of lines) {
    if (speedKeywords.test(line)) continue; // Skip speed readings
    
    // Prioritize lines with odometer indicators
    const hasOdoKeyword = odometerKeywords.test(line);
    const priorityMultiplier = hasOdoKeyword ? 1.5 : 1.0;
    
    // Enhanced odometer number patterns
    const patterns = [
      /\b(\d{1,3}[,.\s]?\d{3}[,.\s]?\d{3})\b/g, // 123,456,789 or 123.456.789
      /\b(\d{4,7})\b/g, // 12345 to 1234567
      /(\d+)\s*km\b/gi, // "147895 km"
    ];
    
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(line)) !== null) {
        const raw = match[1];
        const cleaned = raw.replace(/[,.\s]/g, '');
        const value = parseInt(cleaned, 10);
        
        if (isValidOdometerReading(value)) {
          candidates.push({
            value,
            raw,
            score: calculateOdometerScore(value, raw, hasOdoKeyword) * priorityMultiplier,
            source: 'text_pattern',
            confidence: 0,
          });
        }
      }
    }
  }
  
  return candidates;
}


// Helper function to extract odometer readings from individual lines
function extractOdometerFromLine(text: string, confidence: number, bbox: any): Array<{
  value: number;
  raw: string; 
  score: number;
  confidence: number;
  source: string;
}> {
  const candidates: Array<{ value: number; raw: string; score: number; confidence: number; source: string; }> = [];
  
  // Skip obvious non-odometer lines
  if (looksLikeSpeedometer(text) || /trip|time|temp/i.test(text)) {
    return candidates;
  }

  // Enhanced patterns for dashboard displays
  const patterns = [
    /\b(\d{1,3}[,.\s]?\d{3}[,.\s]?\d{3})\b/g, // 123,456,789
    /\b(\d{4,7})\b/g, // 12345 to 1234567
    /(\d+)\s*km\b/gi, // "147895 km"
    /(\d{1,3}(?:[,.\s]\d{3})+)\b/g, // Various thousand separators
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const raw = match[1];
      const cleaned = raw.replace(/[,.\s]/g, '');
      const value = parseInt(cleaned, 10);
      
      if (isValidOdometerReading(value)) {
        const hasOdometerKeyword = looksLikeSpeedometer(text);
        const score = calculateOdometerScore(value, raw, hasOdometerKeyword);
        
        candidates.push({
          value,
          raw,
          score,
          confidence,
          source: 'line_extraction',
        });
      }
    }
  }

  return candidates;
}

// Helper function to group consecutive digit words (for separated displays)
function groupConsecutiveDigits(words: Array<{text: string; confidence: number; bbox: any}>): Array<{
  value: number;
  raw: string;
  score: number; 
  confidence: number;
  source: string;
}> {
  const candidates: Array<{ value: number; raw: string; score: number; confidence: number; source: string; }> = [];
  
  // Look for sequences of single digits that might be separated odometer readings
  const digitWords = words.filter(w => /^\d{1,3}$/.test(w.text) && w.confidence > 60);
  
  for (let i = 0; i < digitWords.length - 2; i++) {
    const sequence = [];
    let j = i;
    
    // Try to build a sequence of 4-7 digits
    while (j < digitWords.length && sequence.length < 7) {
      if (/^\d{1,3}$/.test(digitWords[j].text)) {
        sequence.push(digitWords[j]);
        j++;
      } else {
        break;
      }
    }
    
    if (sequence.length >= 4) {
      const combined = sequence.map(s => s.text).join('');
      const value = parseInt(combined, 10);
      const avgConfidence = sequence.reduce((sum, s) => sum + s.confidence, 0) / sequence.length;
      
      if (isValidOdometerReading(value)) {
        candidates.push({
          value,
          raw: sequence.map(s => s.text).join(' '),
          score: calculateOdometerScore(value, combined, false) + 2, // Bonus for grouped digits
          confidence: avgConfidence,
          source: 'digit_grouping',
        });
      }
    }
  }
  
  return candidates;
}

function removeDuplicateReadings(candidates: Array<{value: number; raw: string; score: number; confidence: number; source: string}>) {
  const seen = new Map();
  const unique = [];
  
  for (const candidate of candidates) {
    const key = candidate.value;
    if (!seen.has(key) || seen.get(key).score < candidate.score) {
      seen.set(key, candidate);
    }
  }
  
  return Array.from(seen.values());
}

// Helper function to detect speedometer readings
function looksLikeSpeedometer(text: string): boolean {
  return /\b(km\/h|mph|kph|speed)\b/i.test(text) || /\b[0-9]{1,3}\s*(km\/h|mph)\b/i.test(text);
}


function isValidOdometerReading(value: number): boolean {
  // Reasonable odometer ranges for different vehicle types
  const MIN_ODO = 5000; // Allow brand new vehicles
  const MAX_ODO = 300000; // 2M km is extremely high but possible for commercial vehicles
  
  if (value < MIN_ODO || value > MAX_ODO) return false;
  
  // Filter out obviously wrong readings
  if (value < 10 && value > 0) return false; // Too low for real odometer
  if (String(value).length === 1) return false; // Single digits unlikely
  
  return true;
}


function calculateOdometerScore(value: number, raw: string, hasKeyword: boolean): number {
  let score = 0;
  
  // Length scoring (odometers typically 4-7 digits)
  const digits = String(value).length;
  if (digits >= 4 && digits <= 6) score += 10;
  else if (digits === 3 || digits === 7) score += 5;
  else score += 1;
  
  // Keyword proximity bonus
  if (hasKeyword) score += 8;
  
  // Common odometer patterns
  if (value >= 5000 && value <= 500000) score += 5; // Most common range
  if (value % 1000 === 0) score -= 2; // Round thousands less likely
  if (raw.includes(',') || raw.includes('.')) score += 3; // Formatted numbers
  
  // Penalize time-like patterns
  if (raw.includes(':')) score -= 10;
  if (/^\d{1,2}:\d{2}/.test(raw)) score -= 15;
  
  return score;
}

function findVinCandidates(text: string): string[] {
  const U = text.toUpperCase();
  const CHUNKY = /(?:[A-Z0-9][ -]?){11,25}/g;
  const lines = U.split(/\r?\n/);
  const near = lines.filter(l => /\bVIN\b/.test(l));
  const rawHits = [
    ...(U.match(CHUNKY) || []),
    ...near.flatMap(l => l.match(CHUNKY) || []),
  ];
  const uniq = new Set<string>();
  for (const h of rawHits) {
    const n = normalizeVin(h);
    if (n.length >= 11) uniq.add(n);
  }
  const all = [...uniq];
  all.sort((a, b) => {
    const a17 = a.length === 17 ? 1 : 0;
    const b17 = b.length === 17 ? 1 : 0;
    if (b17 !== a17) return b17 - a17;
    if (b.length !== a.length) return b.length - a.length;
    return 0;
  });
  return all;
}

function findBestVinCandidate(candidates: string[]): string | null {
  // First priority: valid VINs with correct check digits
  const validVins = candidates.filter(isValidVin);
  if (validVins.length > 0) return validVins[0];
  
  // Second priority: 17-character candidates (may have invalid check digits)
  const seventeenChar = candidates.filter(c => c.length === 17);
  if (seventeenChar.length > 0) return seventeenChar[0];
  
  // Last resort: longest candidate
  return candidates.length > 0 ? candidates[0] : null;
}


async function preprocessImageForLicenceDisc(buffer: Buffer): Promise<Buffer> {
  try {
    return await sharp(buffer)
      // Higher resolution for tiny licence disc text
      .resize(2800, 2100, { 
        fit: 'inside', 
        withoutEnlargement: true 
      })
      // Multi-step glare reduction for windshield reflections
      .modulate({ brightness: 0.85, saturation: 1.3, hue: 0 })
      // Gaussian blur then sharpen to reduce noise while preserving text
      .blur(0.3)
      .sharpen({ sigma: 2.0, m1: 1.5, m2: 0.4, x1: 4, y2: 20, y3: 30 })
      // Stronger contrast for small text
      .normalize({ lower: 1, upper: 99 })
      // Adaptive gamma for reflective surfaces
      .gamma(1.35)
      // Convert to grayscale to eliminate color distractions
      .grayscale()
      // Morphological operations to clean up character edges
      .threshold(128) // Binarize
      .negate() // Invert for better character definition
      .dilate() // Slightly thicken characters
      .erode() // Then thin them back to original width
      .negate() // Invert back
      // Final enhancement
      .normalize()
      .sharpen({ sigma: 1.0, m1: 2.0 })
      .jpeg({ quality: 99, progressive: true })
      .toBuffer();
  } catch (error) {
    logger.warn('Enhanced licence disc preprocessing failed, using original', { error: serializeError(error) });
    return buffer;
  }
}


function findVinFromLicenceDisc(text: string, lines: any[], words: any[]): Array<{
  vin: string;
  raw: string;
  score: number;
  confidence: number;
  position: string;
}> {
  const candidates = [];
  const allText = text.toUpperCase();
  
  // Method 1: Enhanced keyword matching that excludes VIN/VN prefix
  const vinKeywords = [
    /(?:CHASSIS\s*NO?[:.]?\s*)([A-HJ-NPR-Z0-9]{17})\b/gi,
    /(?:VIN[:.]?\s*)([A-HJ-NPR-Z0-9]{17})\b/gi,
    /(?:VN[:.]?\s*)([A-HJ-NPR-Z0-9]{17})\b/gi, // Handle OCR error where "VIN" becomes "VN"
    /(?:VEHICLE\s*ID[:.]?\s*)([A-HJ-NPR-Z0-9]{17})\b/gi,
  ];

  for (const pattern of vinKeywords) {
    let match;
    while ((match = pattern.exec(allText)) !== null) {
      const extractedVin = match[1]; // Only the 17-character VIN
      
      // Verify it's exactly 17 characters and doesn't include any prefix contamination
      if (extractedVin.length === 17 && 
          !extractedVin.startsWith('VIN') && 
          !extractedVin.startsWith('VN') &&
          !extractedVin.startsWith('CHASSIS') &&
          isValidVin(extractedVin)) {
        
        candidates.push({
          vin: extractedVin,
          raw: match[0],
          score: 25, 
          confidence: 95,
          position: 'keyword_match'
        });
      }
    }
  }

  // Method 2: Positional analysis for SA licence discs
  const vinPositionCandidates = findVinByPosition(lines, words);
  candidates.push(...vinPositionCandidates);

  // Method 3: Clean 17-character pattern extraction (fallback)
  const cleanVinPattern = /\b([A-HJ-NPR-Z0-9]{17})\b/g;
  let match;
  while ((match = cleanVinPattern.exec(allText)) !== null) {
    const vin = match[1];
    
    // Ensure it's exactly 17 characters, valid, and not contaminated
    if (vin.length === 17 && 
        !vin.startsWith('VIN') && 
        !vin.startsWith('VN') &&
        isValidVin(vin)) {
      
      // Check if already found by keyword method
      const alreadyFound = candidates.some(c => c.vin === vin);
      if (!alreadyFound) {
        candidates.push({
          vin,
          raw: match[0],
          score: 20,
          confidence: 85,
          position: 'pattern_match'
        });
      }
    }
  }

  // Method 4: Line-by-line extraction with space removal for curved text
  for (const line of lines) {
    const lineText = line.text.replace(/\s/g, ''); // Remove all spaces
    
    // Skip lines that contain VIN keywords to avoid double-processing
    if (/VIN\s*ID/i.test(line.text)) {
      const vinAfterKeyword = lineText.match(/(?:VIN)([A-HJ-NPR-Z0-9]{17})/i);
      if (vinAfterKeyword && vinAfterKeyword[1].length === 17 && isValidVin(vinAfterKeyword[1])) {
        const vin = vinAfterKeyword[1];
        const alreadyFound = candidates.some(c => c.vin === vin);
        if (!alreadyFound) {
          candidates.push({
            vin,
            raw: line.text,
            score: 22, // High score for keyword lines
            confidence: line.confidence || 80,
            position: 'keyword_line_extraction'
          });
        }
      }
    } else {
      // For non-keyword lines, look for standalone 17-character VINs
      const vinInLine = lineText.match(/([A-HJ-NPR-Z0-9]{17})/g);
      if (vinInLine) {
        for (const vin of vinInLine) {
          if (vin.length === 17 && isValidVin(vin)) {
            const alreadyFound = candidates.some(c => c.vin === vin);
            if (!alreadyFound) {
              // Calculate position score
              const bbox = line.bbox?.BoundingBox;
              const centerY = bbox ? bbox.Top + (bbox.Height / 2) : 0.6;
              const centerX = bbox ? bbox.Left + (bbox.Width / 2) : 0.5;
              const positionScore = calculateLicenceDiscPositionScore(centerX, centerY);
              
              candidates.push({
                vin,
                raw: line.text,
                score: 18 + positionScore,
                confidence: line.confidence || 80,
                position: `line_${centerX.toFixed(2)}_${centerY.toFixed(2)}`
              });
            }
          }
        }
      }
    }
  }

  // Method 5: Handle broken VINs with exact 17-character validation
  const reconstructedVins = reconstructBrokenVinExact(lines);
  candidates.push(...reconstructedVins);

  // Remove any remaining contaminated VINs and sort by score
  const cleanCandidates = candidates.filter(c => 
    c.vin.length === 17 && 
    !c.vin.startsWith('VIN') && 
    !c.vin.startsWith('VN') &&
    isValidVin(c.vin)
  );

  return cleanCandidates.sort((a, b) => b.score - a.score);
}


function findVinByPosition(lines: any[], words: any[]): Array<{
  vin: string;
  raw: string;
  score: number;
  confidence: number;
  position: string;
}> {
  const candidates = [];
  
  // SA licence disc layout: VIN usually in middle-to-lower area
  // Filter lines by vertical position (0.4 to 0.8 of image height)
  const middleLowerLines = lines.filter(line => {
    if (!line.bbox?.BoundingBox) return true; 
    const y = line.bbox.BoundingBox.Top + (line.bbox.BoundingBox.Height / 2);
    return y >= 0.4 && y <= 0.8;
  });

  for (const line of middleLowerLines) {
    const text = line.text.replace(/\s/g, ''); // Remove spaces from curved text
    
    // Look for 17-character sequences
    const vinMatches = text.match(/[A-HJ-NPR-Z0-9]{17}/g);
    if (vinMatches) {
      for (const vin of vinMatches) {
        if (isValidVin(vin)) {
          // Calculate position score
          const bbox = line.bbox?.BoundingBox;
          const centerY = bbox ? bbox.Top + (bbox.Height / 2) : 0.6;
          const centerX = bbox ? bbox.Left + (bbox.Width / 2) : 0.5;
          
          // Prefer center-middle positions (typical VIN location)
          const positionScore = calculateLicenceDiscPositionScore(centerX, centerY);
          
          candidates.push({
            vin,
            raw: line.text,
            score: 20 + positionScore,
            confidence: line.confidence || 80,
            position: `center_${centerX.toFixed(2)}_${centerY.toFixed(2)}`
          });
        }
      }
    }
  }

  return candidates;
}


function calculateLicenceDiscPositionScore(x: number, y: number): number {
  // Optimal VIN position on SA licence disc (center-middle to lower-center)
  const optimalX = 0.5; // Center horizontally
  const optimalY = 0.65; // Slightly below center vertically
  
  const distanceFromOptimal = Math.sqrt(
    Math.pow(x - optimalX, 2) + Math.pow(y - optimalY, 2)
  );
  
  // Score decreases with distance from optimal position
  return Math.max(0, 10 - (distanceFromOptimal * 15));
}

function reconstructBrokenVinExact(lines: any[]): Array<{
  vin: string;
  raw: string;
  score: number;
  confidence: number;
  position: string;
}> {
  const candidates = [];
  
  for (let i = 0; i < lines.length - 1; i++) {
    const line1 = lines[i];
    const line2 = lines[i + 1];
    
    // Combine and clean text
    const combined = (line1.text + line2.text).replace(/\s/g, '');
    
    // Extract exactly 17 characters
    const vinMatch = combined.match(/([A-HJ-NPR-Z0-9]{17})/);
    
    if (vinMatch && vinMatch[1].length === 17 && isValidVin(vinMatch[1])) {
      const avgConfidence = (line1.confidence + line2.confidence) / 2;
      
      candidates.push({
        vin: vinMatch[1],
        raw: `${line1.text} + ${line2.text}`,
        score: 18,
        confidence: avgConfidence,
        position: 'reconstructed_exact'
      });
    }
  }
  
  return candidates;
}

// ---------- VIN Image Processing ----------
async function preprocessImageForOcr(buffer: Buffer): Promise<Buffer> {
  try {
    // Enhance image for better OCR results
    return await sharp(buffer)
      .resize(1920, 1080, { 
        fit: 'inside', 
        withoutEnlargement: true 
      })
      .sharpen()
      .normalize()
      .jpeg({ quality: 95 })
      .toBuffer();
  } catch (error) {
    logger.warn('Image preprocessing failed, using original', { error: serializeError(error) });
    return buffer;
  }
}

// ---------- App Setup ----------
const app = express();
const storage = await createDevStorage(DATA_DIR);

app.use(requestLogger);

const photosRouter = makePhotosRouter(storage);
app.use(`${API_PREFIX}/intake/photos`, photosRouter);
app.use("/intake/photos", photosRouter); 

// middlewares
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// static assets
app.use(express.static(path.resolve("public")));
app.use("/uploads", express.static(path.resolve("uploads")));

// file upload configuration
const upload = multer({ 
  storage: multer.memoryStorage(), 
  limits: { fileSize: Math.max(15 * 1024 * 1024, TEXTRACT_MAX_FILE_SIZE) },
  fileFilter: (req, file, cb) => {
    // Allow document and image formats
    const allowedTypes = [
      'application/pdf',
      'image/jpeg', 'image/jpg', 'image/png', 'image/tiff', 'image/webp'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}. Allowed: ${allowedTypes.join(', ')}`));
    }
  }
});

// API gateway with rate limiting
const api = express.Router();
const limiter = rateLimit({ windowMs: 60_000, max: 60 });
api.use(limiter);
api.use((req, res, next) => {
  if (!API_KEY) return next();
  const got = req.header("X-Api-Key");
  if (got === API_KEY) return next();
  return res.status(401).json({ error: "unauthorized" });
});

attachRoutes(app);
attachRoutes(api);

app.use(API_PREFIX, api);

// ---------- Routes ----------
function attachRoutes(r: express.Router) {
  // Enhanced health check with AWS status
  r.get("/healthz", async (_req, res) => {
    const health = {
      ok: true,
      dataDir: path.resolve(DATA_DIR),
      hasPrivateKey: !!PRIVATE_KEY_PEM,
      hasPublicKey: !!PUBLIC_KEY_PEM,
      aws: {
        configured: hasAwsConfig,
        region: AWS_REGION,
        textractAvailable: false
      },
      cache: {
        keys: ocrCache.keys().length,
        stats: ocrCache.getStats()
      }
    };

    // Test AWS connection if configured
    if (hasAwsConfig) {
      try {
        const client = getTextractClient();
        if (client) {
          // Make a minimal test call to verify connectivity
          await client.send(new DetectDocumentTextCommand({ 
            Document: { Bytes: Buffer.from([0x89, 0x50, 0x4E, 0x47]) } // Invalid PNG header
          }));
        }
      } catch (error: any) {
        // We expect this to fail with InvalidParameterException, but it confirms AWS connectivity
        health.aws.textractAvailable = error.name !== 'UnauthorizedOperation' && error.name !== 'AccessDenied';
      }
    }

    res.json(health);
  });

  // OCR metrics endpoint
  r.get("/metrics/ocr", (_req, res) => {
    res.json({
      ...metrics,
      successRate: metrics.totalRequests > 0 ? (metrics.successfulRequests / metrics.totalRequests * 100).toFixed(2) + '%' : '0%',
      cacheHitRate: metrics.totalRequests > 0 ? (metrics.cacheHits / metrics.totalRequests * 100).toFixed(2) + '%' : '0%'
    });
  });

  
  r.post("/ocr/vin", upload.single("file"), async (req, res) => {
    const startTime = Date.now();
    const requestId = getRequestId(res);
    metrics.totalRequests++;
    
    try {
      // Input validation
      const buf = req.file?.buffer;
      if (!buf || !buf.length) {
        return res.status(400).json({ 
          error: "no_file", 
          message: "No image file provided" 
        });
      }

      // AWS configuration check
      if (!hasAwsConfig) {
        return res.status(503).json({ 
          error: "aws_not_configured", 
          message: "AWS Textract is not properly configured" 
        });
      }

      // File size validation
      if (buf.length > TEXTRACT_MAX_FILE_SIZE) {
        return res.status(400).json({ 
          error: "file_too_large", 
          message: `File size exceeds ${TEXTRACT_MAX_FILE_SIZE / 1024 / 1024}MB limit` 
        });
      }

      // File type validation
      const fileType = req.file?.mimetype;
      
      const allowedTypes = ['image/jpeg', 'image/png', 'image/tiff', 'image/webp'];
      if (!fileType || !allowedTypes.includes(fileType)) {
        return res.status(400).json({ 
          error: "invalid_file_type", 
          message: "Only JPEG, PNG, TIFF, and WebP images are supported" 
        });
      }

      logger.info('Processing VIN OCR request', { requestId, fileType, sizeBytes: buf.length });

      // Check cache first
      const imageHash = getImageHash(buf);
      const cached = ocrCache.get(imageHash);

      if (cached) {
        metrics.cacheHits++;
        logger.info('VIN OCR cache hit', { requestId, cacheKey: imageHash });
        return res.json({ 
          ...(cached as any), 
          fromCache: true,
          processingTime: Date.now() - startTime
        });
      }
     
      // Preprocess image for VIN displays
      const processedBuffer = await preprocessImageForLicenceDisc(buf)
      
      const client = getTextractClient();
      if (!client) {
        throw new Error('Textract client not available');
      }

      const command = new DetectDocumentTextCommand({ 
        Document: { Bytes: processedBuffer } 
      });
      
      const textractResult = await client.send(command);
      const processingTime = Date.now() - startTime;

      // Extract text with confidence scores
      const blocks = textractResult.Blocks || [];
      
      const lines = blocks
        .filter(b => b.BlockType === "LINE" && b.Text && b.Confidence)
        .map(b => ({
          text: b.Text as string,
          confidence: b.Confidence as number,
          bbox: b.Geometry
        }));

      
      const words = blocks
        .filter(b => b.BlockType === "WORD" && b.Text && b.Confidence)
        .map(b => ({
          text: b.Text as string,
          confidence: b.Confidence as number,
          bbox: b.Geometry // Add this for position analysis
        }));  

      // Filter high-confidence results for VIN detection
      const highConfidenceLines = lines
        .filter(l => l.confidence > 80)
        .map(l => l.text);

      const allText = lines.map(l => l.text).join("\n");
      const highConfidenceText = highConfidenceLines.join("\n");

      // Method 1: Try licence disc-specific extraction first
      let bestVin = null;
      let extractionMethod = 'none';
      let candidates: string[] = [];

      try {
        const licenceDiscCandidates = findVinFromLicenceDisc(allText, lines, words);
        if (licenceDiscCandidates.length > 0) {
          bestVin = licenceDiscCandidates[0].vin;
          extractionMethod = 'licence_disc';
          candidates = licenceDiscCandidates.slice(0, 5).map(c => c.vin); 
          logger.debug('VIN found via licence disc extraction', { requestId, vin: bestVin });
        }
      } catch (error) {
        logger.warn('Licence disc extraction failed', { requestId, error: serializeError(error) });
      }

      // Method 2: Fallback to generic VIN extraction if licence disc method fails
      if (!bestVin) {
        try {
          let genericCandidates = findVinCandidates(highConfidenceText);
          if (genericCandidates.length === 0) {
            genericCandidates = findVinCandidates(allText);
          }
          bestVin = findBestVinCandidate(genericCandidates);
          if (bestVin) {
            extractionMethod = 'generic_fallback';
            candidates = genericCandidates.slice(0, 5);
            logger.debug('VIN found via generic extraction', { requestId, vin: bestVin });
          }
        } catch (error) {
          logger.warn('Generic VIN extraction failed', { requestId, error: serializeError(error) });
        }
      }

      const avgConfidence = lines.length > 0 
        ? lines.reduce((sum, l) => sum + l.confidence, 0) / lines.length 
        : 0;

      // Update metrics
      metrics.successfulRequests++;
      if (bestVin) {
        metrics.vinDetectionRate = (metrics.vinDetectionRate * (metrics.successfulRequests - 1) + 1) / metrics.successfulRequests;
      } else {
        metrics.vinDetectionRate = (metrics.vinDetectionRate * (metrics.successfulRequests - 1)) / metrics.successfulRequests;
      }
      metrics.averageProcessingTime = (metrics.averageProcessingTime * (metrics.successfulRequests - 1) + processingTime) / metrics.successfulRequests;

      // Create result object
      const result = { 
        ok: true, 
        vin: bestVin,
        vinValid: bestVin ? isValidVin(bestVin) : false,
        candidates: candidates.slice(0, 5),
        confidence: Math.round(avgConfidence * 100) / 100,
        processingTime,
        textExtracted: allText.length > 0,
        totalBlocks: blocks.length,
        lineCount: lines.length,
        fromCache: false
      };

      // Cache the result
      ocrCache.set(imageHash, result);

      res.json(result);

    } catch (error: any) {
      const processingTime = Date.now() - startTime;
      
      logger.error('Textract OCR error', {
        requestId,
        awsRequestId: error.$metadata?.requestId,
        error: serializeError(error),
        processingTime
      });

      // Handle specific AWS errors
      if (error.name === 'InvalidParameterException') {
        return res.status(400).json({ 
          error: "invalid_image", 
          message: "Image format is not supported or corrupted",
          processingTime
        });
      }
      
      if (error.name === 'ProvisionedThroughputExceededException') {
        return res.status(429).json({ 
          error: "rate_limit_exceeded", 
          message: "Too many requests, please try again later",
          processingTime
        });
      }

      if (error.code === 'UnauthorizedOperation' || error.code === 'AccessDenied') {
        return res.status(500).json({ 
          error: "aws_auth_error", 
          message: "AWS credentials not configured properly",
          processingTime
        });
      }

      res.status(500).json({ 
        error: "textract_failed", 
        message: "OCR processing failed",
        processingTime,
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });

  // list all passports (dev)
  r.get("/passports", async (_req, res) => {
    const list = await storage.list();
    res.json(list);
  });

  // get single passport
  r.get("/passports/:vin", async (req, res) => {
    const vin = sanitizeVin(req.params.vin);
    const rec = await storage.get(vin);
    if (!rec) return res.status(404).json({ error: "not_found" });
    res.json(rec);
  });

  // delete a record
  r.delete("/passports/:vin", async (req, res) => {
    const vin = sanitizeVin(req.params.vin);
    await storage.remove(vin);
    res.json({ ok: true });
  });

  // ingest DEKRA PDF → Draft
  r.post("/ingest/dekra", upload.single("pdf"), async (req, res) => {
    const requestId = getRequestId(res);
    try {
      const lotId = (req.body.lot_id as string) || "N/A";
      const dekraUrl = (req.body.dekra_url as string) || undefined;
      const siteHint = (req.body.site_hint as string) || undefined;
      const capturedBy = (req.body.captured_by as string) || "system";
      const expectedVin = sanitizeVin(req.body.expected_vin as string | undefined);

      let text: string | undefined;
      if (req.file?.buffer) {
        const out = await pdf(req.file.buffer);
        text = normalizeWhitespace(String(out.text || ""));
      } else if (typeof req.body.text === "string" && req.body.text.trim().length > 0) {
        text = normalizeWhitespace(req.body.text);
      }

      if (!text || text.length < 10) {
        return res.status(400).json({ error: "no_pdf_or_text" });
      }

      const draft: PassportDraft = mapToPassportDraft(text, {
        lotId,
        dekraUrl,
        siteHint,
        capturedBy,
      });

      if (expectedVin && sanitizeVin(draft.vin) !== expectedVin) {
        return res.status(409).json({
          error: "vin_mismatch",
          expectedVin,
          parsedVin: sanitizeVin(draft.vin),
        });
      }

      const ok = validateDraft(draft);
      if (!ok) {
        return res.status(422).json({
          error: "schema_invalid",
          details: validateDraft.errors,
          draft,
        });
      }

      const rec = await storage.upsertDraft(draft);

      const fields = [
        "vin",
        "dekra.inspection_ts",
        "dekra.site",
        "odometer.km",
        "tyres_mm.fl",
        "tyres_mm.fr",
        "tyres_mm.rl",
        "tyres_mm.rr",
      ] as const;
      const coverage = fields.reduce((acc, p) => {
        const v = p.split(".").reduce<any>((cur, k) => (cur ? cur[k] : undefined), draft as any);
        return acc + (v !== undefined && v !== null && v !== "" ? 1 : 0);
      }, 0);

      res.json({
        ok: true,
        coverage: `${coverage}/${fields.length}`,
        record: rec,
      });
    } catch (e: any) {
      logger.error('DEKRA ingest failed', { requestId, error: serializeError(e) });
      res.status(500).json({ error: "ingest_failed", message: e?.message || String(e) });
    }
  });

  // seal a draft → sealed passport
  r.post("/passports/seal", async (req, res) => {
    const requestId = getRequestId(res);
    try {
      const vin = sanitizeVin(req.body?.vin);
      if (!vin) return res.status(400).json({ error: "vin_required" });
      const rec = await storage.get(vin);
      if (!rec?.draft) return res.status(404).json({ error: "draft_not_found" });

      const payload = { ...rec.draft };
      // @ts-ignore
      delete payload.seal;

      const bytes = canonicalBytes(payload);
      const hash = sha256Hex(bytes);
      const sig = signBytesRS256(bytes);
      const sealed: PassportSealed = {
        ...(rec.draft as PassportDraft),
        seal: {
          hash,
          sig: sig || "", 
          key_id: process.env.KEY_ID || "local-dev",
          sealed_ts: new Date().toISOString(),
        },
      };

      const ok = validateSealed(sealed);
      if (!ok) {
        return res.status(422).json({ error: "sealed_schema_invalid", details: validateSealed.errors });
      }

      const updated = await storage.upsertSealed(sealed);
      res.json({ ok: true, record: updated });
    } catch (e: any) {
      logger.error('Failed to seal passport', { requestId, error: serializeError(e) });
      res.status(500).json({ error: "seal_failed", message: e?.message || String(e) });
    }
  });

  r.get("/verify", async (req, res) => {
    const vin = sanitizeVin(String(req.query.vin || ""));
    if (!vin) return res.status(400).json({ error: "vin_required" });
    const rec = await storage.get(vin);
    if (!rec?.sealed) return res.status(404).json({ error: "sealed_not_found" });

    const sealed = rec.sealed;
    const payload = { ...sealed } as any;
    delete payload.seal;

    const bytes = canonicalBytes(payload);
    const hashExpected = sha256Hex(bytes);
    const reasons: string[] = [];

    const hashOk = (sealed.seal?.hash || "") === hashExpected;
    if (!hashOk) reasons.push("hash_mismatch");

    let sigOk: boolean | null = null;
    if (sealed.seal?.sig) {
      sigOk = verifyBytesRS256(bytes, sealed.seal.sig);
      if (sigOk === false) reasons.push("signature_invalid");
      if (sigOk === null) reasons.push("no_public_key_configured");
    } else {
      reasons.push("no_signature_present");
    }

    const valid = hashOk && (sigOk !== false); 
    res.json({ valid, reasons, hash: hashExpected, key_id: sealed.seal?.key_id || null });
  });


  r.post("/intake/init", async (req, res) => {
    const requestId = getRequestId(res);
    try {
      const vin = sanitizeVin(req.body?.vin);
      const evInfo = detectEVFromVin(vin);

      const lotId = String(req.body?.lot_id || "WB-POC-001");
      if (!vin) return res.status(400).json({ error: "vin_required" });

      const rec = await storage.get(vin);
      const draft = rec?.draft ? { ...rec.draft } : { vin, lot_id: lotId };

      if (Array.isArray(req.body?.required_photos)) {
        draft.images = draft.images || { items: [] };
        draft.images.required = req.body.required_photos as any;
      }

      if (typeof req.body?.dekra_url === "string") {
        draft.dekra = draft.dekra || {};
        draft.dekra.url = req.body.dekra_url;
      }
      if (req.body?.odometer_km != null) {
        draft.odometer = draft.odometer || {};
        draft.odometer.km = Number(req.body.odometer_km);
        if (typeof req.body?.odometer_source === "string") {
          draft.odometer.source = req.body.odometer_source;
        }
      }

      (draft as any).ev = (draft as any).ev || {};
      if (evInfo.isElectric) {
        (draft as any).ev.isElectric = true;
        (draft as any).ev.batteryCapacityKwh = evInfo.batteryEstimateKwh;
        (draft as any).ev.capabilities = {
          obd_ev_pids: true,                         // we’ll refine per-model later
          smartcar_oauth: evInfo.smartcarCompatible, // we won’t use without consent
          manual: true,
        };
        (draft as any).ev.provenance = {
          detection: evInfo.source,                  
          detectionConfidence: evInfo.confidence,    
        };
      } else {
        // keep ev undefined or minimal; don’t add checklist noise for ICE
      }

      const updated = await storage.upsertDraft(draft);
      res.json({ 
        ok: true, 
        record: updated,
        evReadiness: {
          isElectricLikely: evInfo.isElectric,
          confidence: evInfo.confidence,
          smartcarCompatible: evInfo.smartcarCompatible,
          estimatedCapacityKwh: evInfo.batteryEstimateKwh ?? null,
          source: evInfo.source,
          checkedAt: new Date().toISOString(),
        } 
      });
    } catch (e: any) {
      logger.error('Failed to initialise intake draft', { requestId, error: serializeError(e) });
      res.status(500).json({ error: "init_failed", message: e?.message || String(e) });
    }
  });
  
  
  // ---------- Route ----------
  r.post("/ocr/odometer", upload.single("file"), async (req, res) => {
      const startTime = Date.now();
      const requestId = getRequestId(res);
      metrics.totalRequests++;

      try {
        const buf = req.file?.buffer;
        if (!buf?.length) return res.status(400).json({ error: "no_file", message: "No image file provided" });
        if (!hasAwsConfig) return res.status(503).json({ error: "aws_not_configured", message: "AWS Textract not configured" });
        if (buf.length > TEXTRACT_MAX_FILE_SIZE) {
          return res.status(400).json({
            error: "file_too_large",
            message: `File size exceeds ${TEXTRACT_MAX_FILE_SIZE / 1024 / 1024}MB limit`,
          });
        }
        const allowed = ["image/jpeg", "image/png", "image/tiff", "image/webp"];
        if (!req.file?.mimetype || !allowed.includes(req.file.mimetype)) {
          return res.status(400).json({ error: "invalid_file_type", message: "Only JPEG, PNG, TIFF, WebP supported" });
        }

        logger.info('Processing odometer OCR request', { requestId, mimetype: req.file?.mimetype, sizeBytes: buf.length });

        const originalHash = getImageHash(buf);
        const rawCacheKey = `odo:v3:raw:${originalHash}`;
        const cachedRaw = ocrCache.get(rawCacheKey);
        if (cachedRaw) {
          const processingTime = Date.now() - startTime;
          metrics.cacheHits++;
          logger.info('Odometer OCR cache hit', { requestId, cacheKey: rawCacheKey, stage: 'raw' });
          return res.json({ ...(cachedRaw as any), fromCache: true, processingTime });
        }

        const preprocessStart = Date.now();
        const processed = await preprocessImageForOdometer(buf);
        const preprocessMs = Date.now() - preprocessStart;

        const processedHash = getImageHash(processed);
        const processedCacheKey = `odo:v3:proc:${processedHash}`;
        const cachedProcessed = ocrCache.get(processedCacheKey);
        if (cachedProcessed) {
          const processingTime = Date.now() - startTime;
          metrics.cacheHits++;
          logger.info('Odometer OCR cache hit', { requestId, cacheKey: processedCacheKey, stage: 'processed' });
          return res.json({ ...(cachedProcessed as any), fromCache: true, processingTime });
        }

        const client = getTextractClient();
        if (!client) throw new Error("Textract client not available");

        const textractStart = Date.now();
        const tex = await client.send(new DetectDocumentTextCommand({ Document: { Bytes: processed } }));
        const textractMs = Date.now() - textractStart;
        const blocks = tex.Blocks || [];

        const lines = blocks
          .filter(b => b.BlockType === "LINE" && b.Text && b.Confidence)
          .map(b => ({
            text: b.Text as string,
            confidence: b.Confidence as number,
            bbox: b.Geometry
          }));

        const words = blocks
          .filter(b => b.BlockType === "WORD" && b.Text && b.Confidence)
          .map(b => ({
            text: b.Text as string,
            confidence: b.Confidence as number,
            bbox: b.Geometry
          }));

        const allText = lines.map(l => l.text).join('\n').trim();
        const lineCount = lines.length;

        logger.debug('Extracted odometer OCR lines', { requestId, lineCount });
        logger.debug('Odometer OCR text sample', { requestId, sample: allText.substring(0, 100) });

        const heuristicsStart = Date.now();
        const candidates: Array<{
          value: number;
          raw: string;
          score: number;
          confidence: number;
          source: string;
        }> = [];

        const textCandidates = findOdometerCandidates(allText);
        candidates.push(...textCandidates);
        const textBest = textCandidates.reduce<OdometerCandidate | null>((best, cand) => {
          if (!best || cand.score > best.score) return cand;
          return best;
        }, null);

        let advancedHeuristicsRan = false;
        if (!textBest || textBest.score < 28) {
          advancedHeuristicsRan = true;

          for (const line of lines.filter(l => l.confidence > 70)) {
            if (looksLikeSpeedometer(line.text)) continue;
            const lineCandidates = extractOdometerFromLine(line.text, line.confidence, line.bbox);
            candidates.push(...lineCandidates);
          }

          const groupedCandidates = groupConsecutiveDigits(words);
          candidates.push(...groupedCandidates);
        } else {
          logger.debug('Skipping advanced odometer heuristics', { requestId, topScore: textBest.score });
        }

        const heuristicsMs = Date.now() - heuristicsStart;

        const uniqueCandidates = removeDuplicateReadings(candidates);
        const sortedCandidates = uniqueCandidates.sort((a, b) => b.score - a.score);
        const bestCandidate = sortedCandidates.length > 0 ? sortedCandidates[0] : null;

        logger.debug('Odometer OCR candidates evaluated', { requestId, candidateCount: sortedCandidates.length });
        if (bestCandidate) {
          logger.info('Odometer OCR best candidate', { requestId, value: bestCandidate.value, score: Number(bestCandidate.score.toFixed(1)) });
        }

        metrics.successfulRequests++;
        if (!(metrics as any).odoDetectionRate) (metrics as any).odoDetectionRate = 0;
        (metrics as any).odoDetectionRate =
          ((metrics as any).odoDetectionRate * (metrics.successfulRequests - 1) + (bestCandidate ? 1 : 0)) /
          metrics.successfulRequests;
        const processingTime = Date.now() - startTime;
        metrics.averageProcessingTime =
          (metrics.averageProcessingTime * (metrics.successfulRequests - 1) + processingTime) /
          metrics.successfulRequests;

        const response = {
          ok: true,
          km: bestCandidate ? bestCandidate.value : null,
          unit: "km" as const,
          candidates: sortedCandidates
            .slice(0, 5)
            .map(c => ({ 
              value: c.value, 
              raw: c.raw,
              score: Math.round(c.score * 10) / 10,
              source: c.source 
            })),
          confidence: bestCandidate 
            ? Math.round(Math.min(100, (bestCandidate.confidence * 0.7) + (bestCandidate.score * 0.3))) / 100
            : 0,
          processingTime,
          textExtracted: allText.length > 0,
          totalBlocks: blocks.length,
          lineCount,
          fromCache: false,
          timings: { preprocessMs, textractMs, heuristicsMs },
          debugInfo: process.env.NODE_ENV === 'development' ? {
            allText: allText.substring(0, 200),
            topCandidates: sortedCandidates.slice(0, 3)
          } : undefined
        };

        logger.debug('Odometer OCR timings', { requestId, preprocessMs, textractMs, heuristicsMs, totalMs: processingTime, advancedHeuristicsRan });
        ocrCache.set(rawCacheKey, response);
        ocrCache.set(processedCacheKey, response);


        return res.json(response);

      } catch (error: any) {
        const processingTime = Date.now() - startTime;
        logger.error('Odometer Textract error', {
          requestId,
          awsRequestId: error.$metadata?.requestId,
          error: serializeError(error),
          processingTime,
        });

        // Handle specific AWS errors
        if (error.name === "InvalidParameterException") {
          return res.status(400).json({ 
            error: "invalid_image", 
            message: "Image format not supported or corrupted", 
            processingTime,
            suggestions: [
              "Ensure image is in JPEG, PNG, TIFF, or WebP format",
              "Check that the image file is not corrupted"
            ]
          });
        }
        
        if (error.name === "ProvisionedThroughputExceededException") {
          return res.status(429).json({ 
            error: "rate_limit_exceeded", 
            message: "Too many OCR requests. Please try again in a moment.", 
            processingTime 
          });
        }
        
        if (error.code === "UnauthorizedOperation" || error.code === "AccessDenied") {
          return res.status(500).json({ 
            error: "aws_auth_error", 
            message: "AWS credentials configuration error", 
            processingTime 
          });
        }

        // Generic OCR failure with odometer-specific guidance
        return res.status(500).json({
          error: "odometer_ocr_failed",
          message: "Failed to read odometer from image",
          processingTime,
          suggestions: [
            "Take photo straight-on to minimize reflections",
            "Ensure odometer display is fully illuminated",
            "Get closer so numbers fill most of the frame",
            "Avoid glare from dashboard glass",
            "Try manual entry if OCR continues to fail"
          ],
          details: process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    });


  // Intake seed: set required photos for a VIN/lot
  r.post("/intake/seed", async (req, res) => {
    try {
      const vin = sanitizeVin(req.body?.vin);
      const lotId = String(req.body?.lot_id || "").trim();
      const required = Array.isArray(req.body?.required_photos) ? req.body.required_photos : [];
      if (!vin || !lotId || required.length === 0) {
        return res.status(400).json({ error: "vin_lot_and_required_photos_required" });
      }
      const rec = await storage.get(vin);
      const draft = (rec?.draft || { vin, lot_id: lotId }) as PassportDraft;
      draft.lot_id = lotId;
      draft.images = draft.images || { items: [] };
      draft.images.required = required as any;
      const updated = await storage.upsertDraft(draft);
      res.json({ ok: true, record: updated });
    } catch (e: any) {
      res.status(500).json({ error: "seed_failed", message: e?.message || String(e) });
    }
  });

  // Intake checklist/readiness for a VIN
  r.get("/intake/checklist/:vin", async (req, res) => {
    const vin = sanitizeVin(req.params.vin);
    const rec = await storage.get(vin);

    if (!rec?.draft && !rec?.sealed) {
      return res.json({
        vin,
        lot_id: null,
        checklist: {
          hasDekra: false,
          hasOdo: false,
          photosOk: false,
          dtcStatus: "n/a",
          requiredCount: 0,
          presentCount: 0,
          missing: [] as ImageRole[],
        },
        ready: false
      });
    }

    const draft = rec.draft;
    const sealed = rec.sealed;

    const required: ImageRole[] =
      (draft?.images?.required?.length ? draft.images.required : sealed?.images?.required) ?? ([] as ImageRole[]);

    const items = [
      ...(sealed?.images?.items || []),
      ...(draft?.images?.items || []),
    ];
    
    const presentRoles = new Set(items.map((i) => i.role));
    const missing = required.filter((role) => !presentRoles.has(role));

    const hasDekra = !!(draft?.dekra?.url || sealed?.dekra?.url);
    const odoKm = draft?.odometer?.km ?? sealed?.odometer?.km;
    const hasOdo = odoKm !== undefined && odoKm !== null;
    const dtcStatus = (draft?.dtc?.status || sealed?.dtc?.status || "n/a") as "green"|"amber"|"red"|"n/a";

    const photosOk = required.length > 0 && missing.length === 0;
    const ready = hasDekra && hasOdo && (required.length === 0 ? false : photosOk);

    res.json({
      vin,
      lot_id: draft?.lot_id || sealed?.lot_id || null,
      checklist: {
        hasDekra,
        hasOdo,
        photosOk,
        dtcStatus,
        requiredCount: required.length,
        presentCount: presentRoles.size,
        missing,
      },
      ready,
    });
  });


  r.post("/intake/tyres", async (req, res) => {
    try {
      const vin = sanitizeVin(req.body?.vin);
      const tyres = req.body?.tyres_mm;
      
      if (!vin) return res.status(400).json({ error: "vin_required" });
      if (!tyres || typeof tyres !== 'object') {
        return res.status(400).json({ error: "tyres_mm_required" });
      }

      // Validate tyre measurements
      const validTyre = (val: unknown) => val === null || (typeof val === 'number' && val >= 0 && val <= 12);
      if (!validTyre(tyres.fl) || !validTyre(tyres.fr) || !validTyre(tyres.rl) || !validTyre(tyres.rr)) {
        return res.status(400).json({ error: "invalid_tyre_measurements" });
      }

      const rec = await storage.get(vin);
      const draft = rec?.draft ? { ...rec.draft } : { vin, lot_id: "N/A" };
      
      draft.tyres_mm = {
        fl: tyres.fl,
        fr: tyres.fr, 
        rl: tyres.rl,
        rr: tyres.rr
      };

      const updated = await storage.upsertDraft(draft);
      res.json({ ok: true, record: updated });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: "save_tyres_failed", message });
    }
  });

  // Seal with readiness enforcement (override with ?force=1)
  r.post("/passports/seal/strict", async (req, res) => {
    const vin = sanitizeVin(req.body?.vin);
    const force = String(req.query.force || "") === "1";
    if (!vin) return res.status(400).json({ error: "vin_required" });

    // compute readiness
    const rec0 = await storage.get(vin);
    if (!rec0?.draft) return res.status(404).json({ error: "draft_not_found" });
    const model = rec0.draft;
    const required = model.images?.required || [];
    const present = new Set((model.images?.items || []).map(i => i.role));
    const missing = required.filter(r => !present.has(r));
    const hasDekra = !!model.dekra?.url;
    const hasOdo = model.odometer?.km != null;

    const reasons: string[] = [];
    if (!hasDekra) reasons.push("missing_dekra_url");
    if (!hasOdo) reasons.push("missing_odometer_km");
    if (missing.length > 0) reasons.push(`missing_photos:${missing.join(",")}`);

    if (reasons.length && !force) {
      return res.status(412).json({ error: "not_ready", reasons });
    }

    // delegate to existing seal logic
    try {
      const payload = { ...rec0.draft } as any;
      delete payload.seal;
      const bytes = canonicalBytes(payload);
      const hash = sha256Hex(bytes);
      const sig = signBytesRS256(bytes) || "";
      const sealed: PassportSealed = { 
        ...(rec0.draft as PassportDraft), 
        seal: {
          hash, 
          sig, 
          key_id: process.env.KEY_ID || "local-dev", 
          sealed_ts: new Date().toISOString()
        }
      };
      const ok = validateSealed(sealed);
      if (!ok) {
        return res.status(422).json({ 
          error: "sealed_schema_invalid", 
          details: validateSealed.errors 
        });
      }
      const updated = await storage.upsertSealed(sealed);
      res.json({ 
        ok: true, 
        record: updated, 
        forced: reasons.length > 0 && force ? reasons : undefined 
      });
    } catch (e: any) {
      res.status(500).json({ 
        error: "seal_failed", 
        message: e?.message || String(e) 
      });
    }
  });
}

// Mount photo routes
app.use(`${API_PREFIX}/intake/photos`, photosRouter);
app.use("/intake/photos", photosRouter); 

// ---------- Server Startup ----------
if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    logger.info('WB Passport API listening', {
      port: PORT,
      apiUrl: `http://localhost:${PORT}`,
      apiPrefix: API_PREFIX,
    });
    logger.info('OCR configuration', {
      hasAwsConfig,
      cacheTtlSeconds: TEXTRACT_CACHE_TTL,
      maxFileSizeMb: TEXTRACT_MAX_FILE_SIZE / 1024 / 1024,
    });

    if (!hasAwsConfig) {
      logger.warn('AWS credentials missing; Textract OCR endpoints will respond with 503');
    }
  });
}

export default app;




