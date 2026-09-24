import sharp from "sharp";
for (const size of [192, 512])
  await sharp(`apps/web/public/icon-${size}.svg`)
    .resize(size, size)
    .png()
    .toFile(`apps/web/public/icon-${size}.png`);
