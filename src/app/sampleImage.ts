import { createRandom } from '../lib/image/pixelMath';

/**
 * A built-in practice photo, drawn rather than shipped as a file: a few flat
 * colour shapes, a grey card and a glossy highlight, tinted warm and given
 * sensor-like noise. It lets someone try pins, the loupe and white balance
 * before uploading anything of their own.
 */
export function createSampleImage(): ImageData {
  const width = 900;
  const height = 600;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
  if (context === null) throw new Error('2D canvas is not available');

  context.fillStyle = '#31506b';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#5c7a52';
  context.fillRect(0, 430, width, 170);

  // Cloak
  context.fillStyle = '#8f1d21';
  context.beginPath();
  context.moveTo(250, 120);
  context.lineTo(520, 120);
  context.lineTo(610, 470);
  context.lineTo(170, 470);
  context.closePath();
  context.fill();
  // Cloak highlight
  context.fillStyle = '#c4473a';
  context.beginPath();
  context.moveTo(330, 150);
  context.lineTo(420, 150);
  context.lineTo(440, 440);
  context.lineTo(300, 440);
  context.closePath();
  context.fill();
  // Skin
  context.fillStyle = '#d9a37e';
  context.beginPath();
  context.arc(385, 95, 62, 0, Math.PI * 2);
  context.fill();
  // Shield
  context.fillStyle = '#d2a23a';
  context.beginPath();
  context.arc(690, 300, 95, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#e9e2cf';
  context.beginPath();
  context.arc(690, 300, 42, 0, Math.PI * 2);
  context.fill();
  // Specular glint on the shield
  context.fillStyle = '#ffffff';
  context.beginPath();
  context.ellipse(650, 250, 16, 7, -0.6, 0, Math.PI * 2);
  context.fill();
  // Grey card
  context.fillStyle = '#808080';
  context.fillRect(40, 470, 150, 100);

  // Warm indoor light.
  context.globalCompositeOperation = 'multiply';
  context.fillStyle = 'rgb(255, 222, 184)';
  context.fillRect(0, 0, width, height);
  context.globalCompositeOperation = 'source-over';

  const image = context.getImageData(0, 0, width, height, { colorSpace: 'srgb' });
  const random = createRandom(2024);
  const { data } = image;
  for (let offset = 0; offset < data.length; offset += 4) {
    const noise = (random() - 0.5) * 10;
    data[offset] = (data[offset] as number) + noise;
    data[offset + 1] = (data[offset + 1] as number) + noise;
    data[offset + 2] = (data[offset + 2] as number) + noise;
  }
  return image;
}
