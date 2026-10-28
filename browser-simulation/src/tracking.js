import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const WASM_URL = '/mediapipe/wasm';
const MODEL_URL = '/mediapipe/hand_landmarker.task';

export async function createTracker(video) {
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  const landmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' }, // bei Fehlern: 'CPU'
    runningMode: 'VIDEO',
    numHands: 1,
  });

  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
  video.srcObject = stream;
  await video.play();

  let lastTime = -1;
  return {
    // null = kein neues Bild; sonst { world, image } (beide null, wenn keine Hand erkannt wurde)
    poll() {
      if (video.currentTime === lastTime) return null;
      lastTime = video.currentTime;
      const result = landmarker.detectForVideo(video, performance.now());
      if (!result.worldLandmarks || !result.worldLandmarks[0]) return { world: null, image: null };
      return { world: result.worldLandmarks[0], image: result.landmarks[0] };
    },
  };
}