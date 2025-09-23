import sharp from "sharp";
import { logger, serializeError } from "../logger.js";

export async function preprocessImageForOdometer(buffer: Buffer): Promise<Buffer> {
  try {
    return await sharp(buffer, { failOn: 'none', limitInputPixels: 40_000_000 })
      .rotate()
      .resize({
        width: 1280,
        height: 1280,
        fit: 'inside',
        withoutEnlargement: true,
        fastShrinkOnLoad: true,
      })
      .greyscale()
      .linear(1.1, -10)
      .gamma(1.05)
      .toBuffer();
  } catch (error) {
    logger.warn('Odometer preprocessing failed, using original', { error: serializeError(error) });
    return buffer;
  }
}
