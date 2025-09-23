import sharp from "sharp";
import { logger, serializeError } from "../logger.js";

const MAX_DIMENSION = 1400;
const HORIZONTAL_INSET_RATIO = 0.1;
const VERTICAL_INSET_RATIO = 0.1;

export async function preprocessImageForLicenceDisc(buffer: Buffer): Promise<Buffer> {
  try {
    const meta = await sharp(buffer, { failOn: "none", limitInputPixels: 40_000_000 })
      .rotate()
      .metadata();

    const rawWidth = meta.width ?? 0;
    const rawHeight = meta.height ?? 0;
    const width = meta.autoOrient?.width ?? rawWidth;
    const height = meta.autoOrient?.height ?? rawHeight;

    const insetX = Math.round(width * HORIZONTAL_INSET_RATIO);
    const insetY = Math.round(height * VERTICAL_INSET_RATIO);
    const left = Math.max(0, insetX);
    const top = Math.max(0, insetY);
    const cropWidth = Math.max(1, width - insetX * 2);
    const cropHeight = Math.max(1, height - insetY * 2);

    const canCrop =
      width > 0 &&
      height > 0 &&
      cropWidth > 0 &&
      cropHeight > 0 &&
      cropWidth < width &&
      cropHeight < height &&
      left + cropWidth <= width &&
      top + cropHeight <= height;

    const pipeline = sharp(buffer, { failOn: "none", limitInputPixels: 40_000_000 }).rotate();

    const processed = (canCrop ? pipeline.extract({ left, top, width: cropWidth, height: cropHeight }) : pipeline)
      .resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
        fastShrinkOnLoad: true,
      })
      .greyscale()
      .linear(1.08, -10)
      .gamma(1.08)
      .median(1)
      .sharpen({ sigma: 1.0, m1: 1.2 })
      .toBuffer();

    return await processed;
  } catch (error) {
    logger.warn('Enhanced licence disc preprocessing failed, using original', { error: serializeError(error) });
    return buffer;
  }
}
