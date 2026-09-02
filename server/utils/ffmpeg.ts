import { spawn, execFile, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import config from "../config.ts";

// Resolve the ffmpeg/ffprobe binaries: prefer an explicit config path, then the
// binaries bundled by ffmpeg-static/ffprobe-static, then a PATH lookup.
export const ffmpegPath: string =
  config.FFMPEG_PATH || ffmpegStatic || "ffmpeg";
export const ffprobePath: string =
  config.FFPROBE_PATH || ffprobeStatic?.path || "ffprobe";

// Whether we have a usable ffmpeg binary on disk (bundled binaries are real
// files; a bare "ffmpeg" from PATH we optimistically assume exists).
export function hasFfmpeg(): boolean {
  if (!ffmpegPath) {
    return false;
  }
  if (ffmpegPath === "ffmpeg") {
    return true;
  }
  try {
    return fs.existsSync(ffmpegPath);
  } catch {
    return false;
  }
}

type Codecs = { video?: string; audio?: string };

// Probe the first video and audio stream codec names so we can copy streams
// that browsers already play and only transcode the ones that need it.
export async function probeCodecs(input: string): Promise<Codecs> {
  return new Promise((resolve) => {
    execFile(
      ffprobePath,
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name",
        "-of",
        "json",
        input,
      ],
      { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve({});
          return;
        }
        try {
          const data = JSON.parse(stdout);
          let video: string | undefined;
          let audio: string | undefined;
          for (const s of data.streams ?? []) {
            if (s.codec_type === "video" && !video) {
              video = s.codec_name;
            }
            if (s.codec_type === "audio" && !audio) {
              audio = s.codec_name;
            }
          }
          resolve({ video, audio });
        } catch {
          resolve({});
        }
      },
    );
  });
}

// Build the ffmpeg args to produce a growing HLS playlist. We copy H.264 video
// and AAC audio (fast, lossless) and transcode anything else (HEVC, VP9, AC3,
// DTS, ...) to a browser-friendly H.264/AAC so every viewer can play it.
export function buildHlsArgs(
  input: string,
  outDir: string,
  codecs: Codecs,
): { args: string[]; playlist: string } {
  const playlist = path.join(outDir, "index.m3u8");
  const segments = path.join(outDir, "seg_%05d.ts");
  const args = ["-y", "-i", input];
  // Map the first video and first audio stream (ignore extra subtitle/data
  // streams that can't be muxed into a plain TS/HLS output).
  args.push("-map", "0:v:0", "-map", "0:a:0?");
  if (codecs.video === "h264") {
    args.push("-c:v", "copy");
  } else {
    args.push(
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      // Force 8-bit 4:2:0 so 10-bit HEVC sources stay browser-playable
      "-pix_fmt",
      "yuv420p",
    );
  }
  if (codecs.audio === "aac") {
    args.push("-c:a", "copy");
  } else {
    args.push("-c:a", "aac", "-b:a", "160k", "-ac", "2");
  }
  args.push(
    "-f",
    "hls",
    "-hls_time",
    "6",
    "-hls_playlist_type",
    "event",
    "-hls_flags",
    "independent_segments",
    "-hls_segment_filename",
    segments,
    playlist,
  );
  return { args, playlist };
}

// Start transcoding in the background. Playback can begin as soon as the first
// segments and playlist are written; ffmpeg keeps appending until done.
export function startHlsTranscode(
  input: string,
  outDir: string,
  codecs: Codecs,
): { proc: ChildProcess; playlist: string } {
  const { args, playlist } = buildHlsArgs(input, outDir, codecs);
  const proc = spawn(ffmpegPath, args, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderrTail = "";
  proc.stderr?.on("data", (d: Buffer) => {
    stderrTail += d.toString();
    if (stderrTail.length > 20000) {
      stderrTail = stderrTail.slice(-20000);
    }
  });
  proc.on("error", (e) => {
    console.error("ffmpeg failed to start: %s", e);
  });
  proc.on("close", (code) => {
    if (code !== 0) {
      console.error(
        "ffmpeg exited with code %s: %s",
        code,
        stderrTail.slice(-2000),
      );
    }
  });
  return { proc, playlist };
}
