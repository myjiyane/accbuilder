import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { describe, it, expect } from "vitest";
import { preprocessImageForOdometer } from "../src/server/odometer/preprocess.js";

type SampleExpectation = {
  name: string;
};

const samples: SampleExpectation[] = [
  { name: "actual_odo_1.jpg" },
  { name: "actual_odo_2.jpg" },
];

const samplesDir = path.resolve("samples", "odometer");

describe("preprocessImageForOdometer", () => {
  for (const sample of samples) {
    it(`downscales and normalises ${sample.name}`, async () => {
      const inputPath = path.join(samplesDir, sample.name);
      const original = await fs.readFile(inputPath);

      const processed = await preprocessImageForOdometer(original);

      const originalMeta = await sharp(original).metadata();
      const processedMeta = await sharp(processed).metadata();

      expect(processed.length).toBeLessThan(original.length);
      expect(processedMeta.width ?? 0).toBeLessThanOrEqual(1280);
      expect(processedMeta.height ?? 0).toBeLessThanOrEqual(1280);

      // Processed frame should not introduce colour variance
      const stats = await sharp(processed).stats();
      if (stats.channels.length >= 3) {
        const means = stats.channels.slice(0, 3).map((c) => c.mean);
        const spread = Math.max(...means) - Math.min(...means);
        expect(spread).toBeLessThan(1);
      } else {
        expect(processedMeta.channels).toBeLessThanOrEqual(2);
      }

      expect((processedMeta.width ?? 0)).toBeLessThanOrEqual(originalMeta.width ?? 0);
      expect((processedMeta.height ?? 0)).toBeLessThanOrEqual(originalMeta.height ?? 0);
    });
  }
});
