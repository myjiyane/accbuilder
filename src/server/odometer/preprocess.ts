import sharp from "sharp";
import { logger, serializeError } from "../logger.js";

const MAX_DIMENSION = 960;
const HORIZONTAL_INSET_RATIO = 0.08;
const VERTICAL_INSET_RATIO = 0.12;

export async function preprocessImageForOdometer(buffer: Buffer): Promise<Buffer> {
  try {
    const metaProbe = sharp(buffer, { failOn: "none", limitInputPixels: 40_000_000 }).rotate();
    const metadata = await metaProbe.metadata();
    const rawWidth = metadata.width ?? 0;
    const rawHeight = metadata.height ?? 0;
    const effectiveWidth = metadata.autoOrient?.width ?? rawWidth;
    const effectiveHeight = metadata.autoOrient?.height ?? rawHeight;

    const insetX = Math.round(effectiveWidth * HORIZONTAL_INSET_RATIO);
    const insetY = Math.round(effectiveHeight * VERTICAL_INSET_RATIO);
    const left = Math.max(0, insetX);
    const top = Math.max(0, insetY);
    const croppedWidth = Math.max(1, effectiveWidth - insetX * 2);
    const croppedHeight = Math.max(1, effectiveHeight - insetY * 2);

    const canCrop =
      effectiveWidth > 0 &&
      effectiveHeight > 0 &&
      croppedWidth > 0 &&
      croppedHeight > 0 &&
      croppedWidth < effectiveWidth &&
      croppedHeight < effectiveHeight &&
      left + croppedWidth <= effectiveWidth &&
      top + croppedHeight <= effectiveHeight;

    const base = sharp(buffer, { failOn: "none", limitInputPixels: 40_000_000 }).rotate();
    const pipeline = canCrop
      ? base.extract({
          left,
          top,
          width: croppedWidth,
          height: croppedHeight,
        })
      : base;

    return await pipeline
      .resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
        fastShrinkOnLoad: true,
      })
      .greyscale()
      .linear(1.05, -8)
      .gamma(1.05)
      .toBuffer();
  } catch (error) {
    logger.warn('Odometer preprocessing failed, using original', { error: serializeError(error) });
    return buffer;
  }
}
