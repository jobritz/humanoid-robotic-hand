const CHAINS = [
  { ids: [0, 1, 2, 3, 4], color: '#ff9f43' },      // Daumen
  { ids: [0, 5, 6, 7, 8], color: '#54a0ff' },      // Zeigefinger
  { ids: [0, 9, 10, 11, 12], color: '#1dd1a1' },   // Mittelfinger
  { ids: [0, 13, 14, 15, 16], color: '#feca57' },  // Ringfinger
  { ids: [0, 17, 18, 19, 20], color: '#c56cf0' },  // kleiner Finger
];

// lm = normalisierte Bild-Landmarken; das Video ist per CSS gespiegelt, daher x spiegeln
export function drawOverlay(canvas, lm) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.font = '13px monospace';
  if (!lm) {
    ctx.fillStyle = '#ff6b6b';
    ctx.fillText('keine Hand erkannt', 10, 20);
    return;
  }
  const px = (i) => (1 - lm[i].x) * w;
  const py = (i) => lm[i].y * h;
  for (const { ids, color } of CHAINS) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ids.forEach((id, k) => (k ? ctx.lineTo(px(id), py(id)) : ctx.moveTo(px(id), py(id))));
    ctx.stroke();
    ctx.fillStyle = color;
    for (const id of ids) {
      ctx.beginPath();
      ctx.arc(px(id), py(id), 6, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
  ctx.fillStyle = '#fff';
  for (let i = 0; i < 21; i++) ctx.fillText(String(i), px(i) + 8, py(i) - 6);
}