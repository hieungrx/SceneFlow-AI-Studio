import type { RenderManifest, Scene } from "./types";

export function buildRenderManifest(
  projectId: string,
  sceneList: Scene[],
  targetDurationSeconds = 30,
): RenderManifest {
  const ordered = [...sceneList].sort((a, b) => a.sceneIndex - b.sceneIndex);
  if (ordered.length === 0) throw new Error("Không có cảnh để ghép.");
  if (ordered.some((scene) => !scene.outputVideoUri)) {
    throw new Error("Tất cả cảnh phải có video trước khi render.");
  }

  const rawDuration = ordered.reduce((total, scene) => total + scene.durationSeconds, 0);
  const boundaries = Math.max(ordered.length - 1, 1);
  const overlap = Math.max(0, Math.min(0.8, (rawDuration - targetDurationSeconds) / boundaries));
  let cursor = 0;

  const scenes = ordered.map((scene, index) => {
    const transitionDurationSeconds = index === 0 ? 0 : overlap;
    const timelineStartSeconds = Math.max(0, cursor - transitionDurationSeconds);
    cursor = timelineStartSeconds + scene.durationSeconds;
    return {
      sceneId: scene.id,
      sceneIndex: scene.sceneIndex,
      sourceUri: scene.outputVideoUri as string,
      trimInSeconds: 0,
      trimOutSeconds: 0,
      transition: index === 0 ? ("hard_cut" as const) : scene.transition,
      transitionDurationSeconds,
      timelineStartSeconds: round3(timelineStartSeconds),
    };
  });

  return {
    projectId,
    targetDurationSeconds,
    output: {
      width: 1080,
      height: 1920,
      fps: 24,
      videoCodec: "h264",
      audioSampleRate: 48000,
    },
    scenes,
    voiceoverUri: null,
    musicUri: null,
    subtitlesUri: null,
    calculatedDurationSeconds: round3(cursor),
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
