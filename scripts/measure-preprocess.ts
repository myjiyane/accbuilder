import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { preprocessImageForOdometer } from "../src/server/odometer/preprocess.js";

const samples = [
  "actual_odo_1.jpg",
  "actual_odo_2.jpg",
];

const samplesDir = path.resolve("samples", "odometer");

for (const name of samples) {
  const inputPath = path.join(samplesDir, name);
  const original = await fs.readFile(inputPath);

  const rotatedMeta = await sharp(original, { failOn: "none" }).rotate().metadata();

  const preprocessStart = Date.now();
  const processed = await preprocessImageForOdometer(original);
  const preprocessMs = Date.now() - preprocessStart;

  const originalMeta = await sharp(original).metadata();
  const processedMeta = await sharp(processed).metadata();

  console.log(JSON.stringify({
    sample: name,
    preprocessMs,
    rawSize: original.length,
    processedSize: processed.length,
    rawDimensions: {
      width: originalMeta.width,
      height: originalMeta.height,
    },
    rotatedDimensions: {
      width: rotatedMeta.autoOrient?.width ?? rotatedMeta.width,
      height: rotatedMeta.autoOrient?.height ?? rotatedMeta.height,
    },
    processedDimensions: {
      width: processedMeta.width,
      height: processedMeta.height,
      channels: processedMeta.channels,
    },
  }, null, 2));
}
