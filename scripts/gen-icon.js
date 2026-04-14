/**
 * gen-icon.js
 * Converts public/icon.png → public/icon.ico for the Windows NSIS installer.
 * Requires: jimp, png-to-ico  (already in devDependencies)
 * Run: node scripts/gen-icon.js
 */
const path = require('path');
const fs = require('fs');

const srcPng = path.join(__dirname, '..', 'public', 'icon.png');
const destIco = path.join(__dirname, '..', 'public', 'icon.ico');

if (!fs.existsSync(srcPng)) {
  console.error('ERROR: public/icon.png not found. Place a 256×256 PNG there first.');
  process.exit(1);
}

async function run() {
  let pngBuffer;

  // Resize to exactly 256×256 using Jimp (pure-JS, no native deps)
  try {
    const Jimp = require('jimp');
    const img = await Jimp.read(srcPng);
    img.resize(256, 256);
    pngBuffer = await img.getBufferAsync(Jimp.MIME_PNG);
    console.log('Resized icon.png to 256×256');
  } catch (err) {
    console.warn('jimp not available, using icon.png as-is:', err.message);
    pngBuffer = fs.readFileSync(srcPng);
  }

  // Convert PNG buffer → ICO
  const pngToIco = require('png-to-ico');
  const icoBuffer = await pngToIco(pngBuffer);
  fs.writeFileSync(destIco, icoBuffer);
  console.log('Generated public/icon.ico ✓');
}

run().catch((err) => {
  console.error('Icon generation failed:', err.message);
  process.exit(1);
});
