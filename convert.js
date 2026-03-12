import sharp from 'sharp';
import fs from 'fs';

const svgBuffer = fs.readFileSync('./public/icon.svg');

sharp(svgBuffer)
  .resize(192, 192)
  .png()
  .toFile('./public/icon-192x192.png')
  .then(() => console.log('Created 192x192 PNG'))
  .catch(err => console.error(err));

sharp(svgBuffer)
  .resize(512, 512)
  .png()
  .toFile('./public/icon-512x512.png')
  .then(() => console.log('Created 512x512 PNG'))
  .catch(err => console.error(err));
