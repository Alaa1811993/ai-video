require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { v4: uuidv4 } = require("uuid");

const ffmpeg = require("fluent-ffmpeg");
const ffmpegStatic = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");

/* =========================================================
   EXPRESS
========================================================= */

const app = express();

const PORT = Number(process.env.PORT) || 5000;

const SERVER_URL =
  process.env.SERVER_URL ||
  `http://localhost:${PORT}`;

const ELEVENLABS_API_KEY =
  process.env.ELEVENLABS_API_KEY || "";

/* =========================================================
   DIRECTORIES
========================================================= */

const UPLOADS_DIR = path.join(__dirname, "uploads");
const IMAGES_DIR = path.join(UPLOADS_DIR, "images");
const AUDIO_DIR = path.join(UPLOADS_DIR, "audio");
const VIDEOS_DIR = path.join(UPLOADS_DIR, "videos");
const TEMP_DIR = path.join(UPLOADS_DIR, "temp");

[
  UPLOADS_DIR,
  IMAGES_DIR,
  AUDIO_DIR,
  VIDEOS_DIR,
  TEMP_DIR,
].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, {
      recursive: true,
    });
  }
});

/* =========================================================
   FFMPEG
========================================================= */

const resolvedFfmpegPath = ffmpegStatic
  ? path.resolve(ffmpegStatic)
  : null;

const resolvedFfprobePath =
  ffprobeStatic && ffprobeStatic.path
    ? path.resolve(ffprobeStatic.path)
    : null;

console.log("");
console.log("========================================");
console.log("MEDIA CONFIGURATION");
console.log("========================================");
console.log("FFmpeg:", resolvedFfmpegPath);
console.log(
  "FFmpeg exists:",
  !!resolvedFfmpegPath &&
    fs.existsSync(resolvedFfmpegPath)
);
console.log("FFprobe:", resolvedFfprobePath);
console.log(
  "FFprobe exists:",
  !!resolvedFfprobePath &&
    fs.existsSync(resolvedFfprobePath)
);
console.log("Server URL:", SERVER_URL);
console.log("========================================");
console.log("");

if (
  resolvedFfmpegPath &&
  fs.existsSync(resolvedFfmpegPath)
) {
  ffmpeg.setFfmpegPath(resolvedFfmpegPath);
}

if (
  resolvedFfprobePath &&
  fs.existsSync(resolvedFfprobePath)
) {
  ffmpeg.setFfprobePath(resolvedFfprobePath);
}

/* =========================================================
   CORS
========================================================= */

const allowedOrigins = [
  "https://ai-video-studio-542c9.web.app",
  "https://ai-video-studio-542c9.firebaseapp.com",
  "http://localhost:5173",
  "http://localhost:5174",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.log("CORS blocked origin:", origin);

      return callback(null, false);
    },

    methods: [
      "GET",
      "POST",
      "PUT",
      "DELETE",
      "OPTIONS",
    ],

    allowedHeaders: [
      "Content-Type",
      "Authorization",
    ],

    credentials: false,
  })
);

app.options("*", cors());

/* =========================================================
   BODY PARSER
========================================================= */

app.use(
  express.json({
    limit: "100mb",
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "100mb",
  })
);

/* =========================================================
   STATIC FILES
========================================================= */

app.use(
  "/uploads",
  express.static(UPLOADS_DIR, {
    maxAge: "1d",
  })
);

/* =========================================================
   MULTER
========================================================= */

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const mimetype =
      file.mimetype || "";

    if (
      mimetype.startsWith("image/")
    ) {
      return cb(null, IMAGES_DIR);
    }

    if (
      mimetype.startsWith("audio/")
    ) {
      return cb(null, AUDIO_DIR);
    }

    return cb(null, TEMP_DIR);
  },

  filename: (req, file, cb) => {
    const ext =
      path.extname(
        file.originalname || ""
      ) || "";

    cb(
      null,
      `${uuidv4()}${ext}`
    );
  },
});

const upload = multer({
  storage,

  limits: {
    fileSize:
      100 * 1024 * 1024,
  },
});

/* =========================================================
   SERVER URL
========================================================= */

function getServerUrl() {
  return SERVER_URL.replace(/\/+$/, "");
}

/* =========================================================
   FFMPEG CHECK
========================================================= */

function ensureFfmpegAvailable() {
  if (!resolvedFfmpegPath) {
    throw new Error(
      "FFmpeg executable was not found."
    );
  }

  if (
    !fs.existsSync(
      resolvedFfmpegPath
    )
  ) {
    throw new Error(
      `FFmpeg executable does not exist: ${resolvedFfmpegPath}`
    );
  }

  if (!resolvedFfprobePath) {
    throw new Error(
      "FFprobe executable was not found."
    );
  }

  if (
    !fs.existsSync(
      resolvedFfprobePath
    )
  ) {
    throw new Error(
      `FFprobe executable does not exist: ${resolvedFfprobePath}`
    );
  }
}

/* =========================================================
   SAFE DELETE
========================================================= */

function safeDelete(filePath) {
  try {
    if (
      filePath &&
      fs.existsSync(filePath)
    ) {
      fs.rmSync(filePath, {
        recursive: true,
        force: true,
      });
    }
  } catch (error) {
    console.warn(
      "Cleanup error:",
      error.message
    );
  }
}

/* =========================================================
   MEDIA DURATION
========================================================= */

function getMediaDuration(filePath) {
  return new Promise(
    (resolve, reject) => {
      if (
        !filePath ||
        !fs.existsSync(filePath)
      ) {
        return reject(
          new Error(
            `Media file does not exist: ${filePath}`
          )
        );
      }

      ffmpeg.ffprobe(
        filePath,
        (error, metadata) => {
          if (error) {
            return reject(error);
          }

          const duration = Number(
            metadata?.format?.duration
          );

          if (
            !Number.isFinite(duration) ||
            duration <= 0
          ) {
            return reject(
              new Error(
                `Invalid media duration for ${filePath}`
              )
            );
          }

          resolve(duration);
        }
      );
    }
  );
}

/* =========================================================
   DOWNLOAD FILE
========================================================= */

function downloadFile(
  url,
  targetPath,
  redirects = 0
) {
  return new Promise(
    (resolve, reject) => {
      if (!url) {
        return reject(
          new Error("URL is empty.")
        );
      }

      if (redirects > 10) {
        return reject(
          new Error(
            "Too many redirects."
          )
        );
      }

      if (
        !url.startsWith("http://") &&
        !url.startsWith("https://")
      ) {
        if (fs.existsSync(url)) {
          try {
            fs.copyFileSync(
              url,
              targetPath
            );

            return resolve(
              targetPath
            );
          } catch (error) {
            return reject(error);
          }
        }

        return reject(
          new Error(
            `Local file not found: ${url}`
          )
        );
      }

      const client =
        url.startsWith("https://")
          ? https
          : http;

      let request;

      try {
        request = client.get(
          url,
          {
            headers: {
              "User-Agent":
                "AI-Video-Studio/1.0",
            },
          },
          (response) => {
            if (
              response.statusCode >= 300 &&
              response.statusCode < 400 &&
              response.headers.location
            ) {
              response.resume();

              const redirectUrl =
                new URL(
                  response.headers.location,
                  url
                ).toString();

              return downloadFile(
                redirectUrl,
                targetPath,
                redirects + 1
              )
                .then(resolve)
                .catch(reject);
            }

            if (
              response.statusCode !== 200
            ) {
              response.resume();

              return reject(
                new Error(
                  `Download failed. HTTP ${response.statusCode}`
                )
              );
            }

            const file =
              fs.createWriteStream(
                targetPath
              );

            response.pipe(file);

            file.on(
              "finish",
              () => {
                file.close(() => {
                  resolve(
                    targetPath
                  );
                });
              }
            );

            file.on(
              "error",
              (error) => {
                safeDelete(targetPath);
                reject(error);
              }
            );
          }
        );

        request.setTimeout(
          120000,
          () => {
            request.destroy();

            reject(
              new Error(
                "Download timeout."
              )
            );
          }
        );

        request.on(
          "error",
          (error) => {
            reject(error);
          }
        );
      } catch (error) {
        reject(error);
      }
    }
  );
}

/* =========================================================
   ELEVENLABS VOICES
========================================================= */

const VOICE_IDS = {
  Female:
    "EXAVITQu4vr4xnSDxMaL",

  Male:
    "ErXwobaYiN019PkySvjV",

  "Deep Male":
    "VR6AewLTigWG4xSOukaG",

  Professional:
    "TxGEqnHWrfWFTfGW9XjX",

  Storyteller:
    "pNInz6obpgDQGcFmaJgB",
};

function getVoiceId(voice) {
  return (
    VOICE_IDS[voice] ||
    VOICE_IDS.Female
  );
}

/* =========================================================
   GENERATE VOICE
========================================================= */

app.post(
  "/api/generate-voice",
  async (req, res) => {
    try {
      const {
        text,
        narration,
        voice,
      } = req.body || {};

      const voiceText =
        text ||
        narration ||
        "";

      if (
        !voiceText ||
        !voiceText.trim()
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Narration text is required.",
        });
      }

      if (
        !ELEVENLABS_API_KEY
      ) {
        return res.status(500).json({
          success: false,
          error:
            "ELEVENLABS_API_KEY is missing.",
        });
      }

      const voiceId =
        getVoiceId(voice);

      console.log("");
      console.log(
        "========================================"
      );
      console.log(
        "GENERATING ELEVENLABS VOICE"
      );
      console.log(
        "========================================"
      );
      console.log(
        "Voice:",
        voice || "Female"
      );
      console.log(
        "Voice ID:",
        voiceId
      );
      console.log(
        "Text:",
        voiceText
      );
      console.log(
        "========================================"
      );

      const url =
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

      const response =
        await fetch(
          url,
          {
            method: "POST",

            headers: {
              "xi-api-key":
                ELEVENLABS_API_KEY,

              "Content-Type":
                "application/json",

              Accept:
                "audio/mpeg",
            },

            body: JSON.stringify({
              text: voiceText,

              model_id:
                "eleven_multilingual_v2",

              voice_settings: {
                stability: 0.5,

                similarity_boost:
                  0.75,

                style: 0.3,

                use_speaker_boost:
                  true,
              },
            }),
          }
        );

      if (!response.ok) {
        const errorText =
          await response.text();

        console.error(
          "ElevenLabs error:",
          response.status,
          errorText
        );

        return res
          .status(
            response.status
          )
          .json({
            success: false,
            error:
              `ElevenLabs error: ${errorText}`,
          });
      }

      const audioBuffer =
        Buffer.from(
          await response.arrayBuffer()
        );

      if (
        audioBuffer.length < 1000
      ) {
        throw new Error(
          "ElevenLabs returned invalid audio."
        );
      }

      const filename =
        `voice_${uuidv4()}.mp3`;

      const outputPath =
        path.join(
          AUDIO_DIR,
          filename
        );

      fs.writeFileSync(
        outputPath,
        audioBuffer
      );

      const duration =
        await getMediaDuration(
          outputPath
        );

      const audioUrl =
        `${getServerUrl()}/uploads/audio/${filename}`;

      console.log(
        "Audio saved:",
        audioUrl
      );

      console.log(
        "Audio duration:",
        duration
      );

      return res.json({
        success: true,

        audioUrl,

        url: audioUrl,

        audio: audioUrl,

        filename,

        duration,
      });
    } catch (error) {
      console.error(
        "VOICE GENERATION ERROR:",
        error
      );

      return res.status(500).json({
        success: false,

        error:
          error.message ||
          "Voice generation failed.",
      });
    }
  }
);

/* =========================================================
   UPLOAD
========================================================= */

app.post(
  "/api/upload",
  upload.single("file"),
  (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error:
            "No file provided.",
        });
      }

      const mimetype =
        req.file.mimetype || "";

      let folder = "temp";

      if (
        mimetype.startsWith("image/")
      ) {
        folder = "images";
      }

      if (
        mimetype.startsWith("audio/")
      ) {
        folder = "audio";
      }

      const fileUrl =
        `${getServerUrl()}/uploads/${folder}/${req.file.filename}`;

      return res.json({
        success: true,

        fileUrl,

        url: fileUrl,

        filename:
          req.file.filename,
      });
    } catch (error) {
      console.error(
        "UPLOAD ERROR:",
        error
      );

      return res.status(500).json({
        success: false,

        error:
          error.message ||
          "Upload failed.",
      });
    }
  }
);

/* =========================================================
   GENERATE IMAGE
========================================================= */

app.post(
  "/api/generate-image",
  async (req, res) => {
    try {
      const {
        prompt,
        sceneDescription,
        imagePrompt,
      } = req.body || {};

      const finalPrompt =
        prompt ||
        imagePrompt ||
        sceneDescription ||
        "cinematic realistic scene";

      console.log("");
      console.log(
        "========================================"
      );
      console.log(
        "GENERATING AI IMAGE"
      );
      console.log(
        "========================================"
      );
      console.log(
        finalPrompt
      );

      const imageUrl =
        `https://image.pollinations.ai/prompt/${encodeURIComponent(
          finalPrompt
        )}?width=1280&height=720&model=flux&nologo=true`;

      const response =
        await fetch(imageUrl);

      if (!response.ok) {
        throw new Error(
          `Image generation failed. HTTP ${response.status}`
        );
      }

      const buffer =
        Buffer.from(
          await response.arrayBuffer()
        );

      if (
        buffer.length < 1000
      ) {
        throw new Error(
          "Image generation returned invalid data."
        );
      }

      const filename =
        `image_${uuidv4()}.jpg`;

      const outputPath =
        path.join(
          IMAGES_DIR,
          filename
        );

      fs.writeFileSync(
        outputPath,
        buffer
      );

      const localUrl =
        `${getServerUrl()}/uploads/images/${filename}`;

      console.log(
        "Image saved:",
        localUrl
      );

      return res.json({
        success: true,

        imageUrl: localUrl,

        url: localUrl,

        filename,
      });
    } catch (error) {
      console.error(
        "IMAGE GENERATION ERROR:",
        error
      );

      return res.status(500).json({
        success: false,

        error:
          error.message ||
          "Image generation failed.",
      });
    }
  }
);

/* =========================================================
   RENDER ONE SCENE
   LIGHTWEIGHT BONTO VERSION
========================================================= */

function renderSceneVideo(
  imagePath,
  audioPath,
  requestedDuration,
  outputPath
) {
  return new Promise(
    async (resolve, reject) => {
      try {
        ensureFfmpegAvailable();

        if (
          !fs.existsSync(imagePath)
        ) {
          throw new Error(
            `Image does not exist: ${imagePath}`
          );
        }

        if (
          !fs.existsSync(audioPath)
        ) {
          throw new Error(
            `Audio does not exist: ${audioPath}`
          );
        }

        const audioDuration =
          await getMediaDuration(
            audioPath
          );

        const requested =
          Number(
            requestedDuration
          ) || 5;

        /*
          Use the audio duration.

          This avoids creating unnecessarily long
          video streams.
        */

        const duration =
          Math.max(
            0.5,
            Math.min(
              Math.max(
                requested,
                audioDuration
              ),
              60
            )
          );

        console.log("");
        console.log(
          "========================================"
        );
        console.log(
          "LIGHTWEIGHT SCENE RENDER"
        );
        console.log(
          "========================================"
        );
        console.log(
          "Image:",
          imagePath
        );
        console.log(
          "Audio:",
          audioPath
        );
        console.log(
          "Audio duration:",
          audioDuration
        );
        console.log(
          "Video duration:",
          duration
        );
        console.log(
          "Output:",
          outputPath
        );

        /*
          IMPORTANT:

          No zoompan.
          No 30 FPS.
          No medium preset.

          This is intentionally lightweight for Bonto.
        */

        ffmpeg()
          .input(imagePath)

          .inputOptions([
            "-loop",
            "1",
          ])

          .input(audioPath)

          .videoFilters([
            "scale=1280:720:force_original_aspect_ratio=decrease",
            "pad=1280:720:(ow-iw)/2:(oh-ih)/2",
            "setsar=1",
            "format=yuv420p",
          ])

          .outputOptions([
            "-map",
            "0:v:0",

            "-map",
            "1:a:0",

            "-c:v",
            "libx264",

            "-preset",
            "ultrafast",

            "-crf",
            "28",

            "-r",
            "24",

            "-pix_fmt",
            "yuv420p",

            "-c:a",
            "aac",

            "-b:a",
            "128k",

            "-ar",
            "44100",

            "-ac",
            "2",

            "-t",
            String(duration),

            "-shortest",

            "-movflags",
            "+faststart",

            "-threads",
            "1",
          ])

          .on(
            "start",
            (commandLine) => {
              console.log("");
              console.log(
                "SCENE FFMPEG COMMAND:"
              );
              console.log(
                commandLine
              );
              console.log("");
            }
          )

          .on(
            "progress",
            (progress) => {
              if (
                progress.percent !==
                undefined
              ) {
                console.log(
                  `Scene progress: ${progress.percent.toFixed(
                    1
                  )}%`
                );
              }
            }
          )

          .on(
            "stderr",
            (line) => {
              console.log(
                "Scene FFmpeg:",
                line
              );
            }
          )

          .on(
            "end",
            async () => {
              try {
                console.log(
                  "Scene FFmpeg finished."
                );

                if (
                  !fs.existsSync(
                    outputPath
                  )
                ) {
                  return reject(
                    new Error(
                      "Scene video was not created."
                    )
                  );
                }

                const stats =
                  fs.statSync(
                    outputPath
                  );

                console.log(
                  "Scene video size:",
                  stats.size,
                  "bytes"
                );

                if (
                  stats.size < 1000
                ) {
                  return reject(
                    new Error(
                      "Scene video is empty."
                    )
                  );
                }

                /*
                  Verify the output.
                */

                ffmpeg.ffprobe(
                  outputPath,
                  (probeError, metadata) => {
                    if (probeError) {
                      return reject(
                        probeError
                      );
                    }

                    const videoStreams =
                      (
                        metadata.streams ||
                        []
                      ).filter(
                        (stream) =>
                          stream.codec_type ===
                          "video"
                      );

                    const audioStreams =
                      (
                        metadata.streams ||
                        []
                      ).filter(
                        (stream) =>
                          stream.codec_type ===
                          "audio"
                      );

                    console.log(
                      "Scene video streams:",
                      videoStreams.length
                    );

                    console.log(
                      "Scene audio streams:",
                      audioStreams.length
                    );

                    if (
                      videoStreams.length ===
                      0
                    ) {
                      return reject(
                        new Error(
                          "Scene has no video stream."
                        )
                      );
                    }

                    if (
                      audioStreams.length ===
                      0
                    ) {
                      return reject(
                        new Error(
                          "Scene has no audio stream."
                        )
                      );
                    }

                    console.log(
                      "Scene verified successfully."
                    );

                    resolve(
                      outputPath
                    );
                  }
                );
              } catch (error) {
                reject(error);
              }
            }
          )

          .on(
            "error",
            (error) => {
              console.error("");
              console.error(
                "========== SCENE FFMPEG ERROR =========="
              );
              console.error(
                error.message
              );
              console.error(
                "========================================"
              );

              reject(error);
            }
          )

          .save(outputPath);
      } catch (error) {
        reject(error);
      }
    }
  );
}

/* =========================================================
   GENERATE SINGLE SCENE VIDEO
========================================================= */

app.post(
  "/api/generate-scene-video",
  async (req, res) => {
    const {
      imageUrl,
      audioUrl,
      duration,
    } = req.body || {};

    if (!imageUrl) {
      return res.status(400).json({
        success: false,
        error:
          "imageUrl is required.",
      });
    }

    if (!audioUrl) {
      return res.status(400).json({
        success: false,
        error:
          "audioUrl is required.",
      });
    }

    const jobId = uuidv4();

    const jobDir =
      path.join(
        TEMP_DIR,
        jobId
      );

    fs.mkdirSync(jobDir, {
      recursive: true,
    });

    try {
      const imagePath =
        path.join(
          jobDir,
          "image.jpg"
        );

      const audioPath =
        path.join(
          jobDir,
          "audio.mp3"
        );

      const outputPath =
        path.join(
          VIDEOS_DIR,
          `scene_${jobId}.mp4`
        );

      await downloadFile(
        imageUrl,
        imagePath
      );

      await downloadFile(
        audioUrl,
        audioPath
      );

      await renderSceneVideo(
        imagePath,
        audioPath,
        duration || 5,
        outputPath
      );

      const videoUrl =
        `${getServerUrl()}/uploads/videos/${path.basename(
          outputPath
        )}`;

      return res.json({
        success: true,

        videoUrl,

        url: videoUrl,
      });
    } catch (error) {
      console.error(
        "SCENE VIDEO ERROR:",
        error
      );

      return res.status(500).json({
        success: false,

        error:
          error.message ||
          "Scene video generation failed.",
      });
    } finally {
      setTimeout(() => {
        safeDelete(jobDir);
      }, 1000);
    }
  }
);

/* =========================================================
   CONCAT SCENE VIDEOS
   IMPORTANT:
   USE STREAM COPY
   DO NOT RE-ENCODE FINAL VIDEO
========================================================= */

function concatSceneVideos(
  sceneVideos,
  concatFile,
  finalPath
) {
  return new Promise(
    (resolve, reject) => {
      const content =
        sceneVideos
          .map((file) => {
            const absolutePath =
              path.resolve(file)
                .replace(/\\/g, "/")
                .replace(/'/g, "'\\''");

            return `file '${absolutePath}'`;
          })
          .join("\n");

      fs.writeFileSync(
        concatFile,
        content,
        "utf8"
      );

      console.log("");
      console.log(
        "========================================"
      );
      console.log(
        "CONCATENATING SCENES"
      );
      console.log(
        "========================================"
      );
      console.log(content);
      console.log(
        "========================================"
      );

      /*
        CRITICAL:

        -c copy means FFmpeg does NOT encode
        the entire final video again.

        This is much lighter on Bonto.
      */

      ffmpeg()
        .input(concatFile)

        .inputOptions([
          "-f",
          "concat",

          "-safe",
          "0",
        ])

        .outputOptions([
          "-c",
          "copy",

          "-movflags",
          "+faststart",
        ])

        .on(
          "start",
          (commandLine) => {
            console.log(
              "FINAL CONCAT COMMAND:"
            );

            console.log(
              commandLine
            );
          }
        )

        .on(
          "progress",
          (progress) => {
            if (
              progress.percent !==
              undefined
            ) {
              console.log(
                `Concat progress: ${progress.percent.toFixed(
                  1
                )}%`
              );
            }
          }
        )

        .on(
          "stderr",
          (line) => {
            console.log(
              "Concat FFmpeg:",
              line
            );
          }
        )

        .on(
          "end",
          () => {
            console.log(
              "Final concat completed."
            );

            resolve();
          }
        )

        .on(
          "error",
          (error) => {
            console.error(
              "FINAL CONCAT ERROR:",
              error
            );

            reject(error);
          }
        )

        .save(finalPath);
    }
  );
}

/* =========================================================
   GENERATE FINAL VIDEO
========================================================= */

app.post(
  "/api/generate-final-video",
  async (req, res) => {
    const { scenes } =
      req.body || {};

    if (
      !Array.isArray(scenes) ||
      scenes.length === 0
    ) {
      return res.status(400).json({
        success: false,
        error:
          "No scenes provided.",
      });
    }

    if (scenes.length > 20) {
      return res.status(400).json({
        success: false,
        error:
          "Maximum 20 scenes allowed.",
      });
    }

    const jobId = uuidv4();

    const jobDir =
      path.join(
        TEMP_DIR,
        jobId
      );

    fs.mkdirSync(jobDir, {
      recursive: true,
    });

    console.log("");
    console.log(
      "========================================"
    );
    console.log(
      "GENERATING FINAL VIDEO"
    );
    console.log(
      "========================================"
    );
    console.log(
      "Job ID:",
      jobId
    );
    console.log(
      "Scenes:",
      scenes.length
    );
    console.log(
      "========================================"
    );

    try {
      ensureFfmpegAvailable();

      const sceneVideos = [];

      /*
        PROCESS SCENES ONE BY ONE.

        Never process them simultaneously.
      */

      for (
        let i = 0;
        i < scenes.length;
        i++
      ) {
        const scene =
          scenes[i];

        console.log("");
        console.log(
          `========== SCENE ${
            i + 1
          } / ${
            scenes.length
          } ==========`
        );

        if (
          !scene ||
          !scene.imageUrl
        ) {
          throw new Error(
            `Scene ${
              i + 1
            } has no imageUrl.`
          );
        }

        if (
          !scene.audioUrl
        ) {
          throw new Error(
            `Scene ${
              i + 1
            } has no audioUrl.`
          );
        }

        const imagePath =
          path.join(
            jobDir,
            `image_${i}.jpg`
          );

        const audioPath =
          path.join(
            jobDir,
            `audio_${i}.mp3`
          );

        const sceneVideo =
          path.join(
            jobDir,
            `scene_${i}.mp4`
          );

        console.log(
          "Image URL:",
          scene.imageUrl
        );

        console.log(
          "Audio URL:",
          scene.audioUrl
        );

        /*
          DOWNLOAD IMAGE
        */

        console.log(
          "Downloading image..."
        );

        await downloadFile(
          scene.imageUrl,
          imagePath
        );

        if (
          !fs.existsSync(
            imagePath
          )
        ) {
          throw new Error(
            `Scene ${
              i + 1
            } image download failed.`
          );
        }

        /*
          DOWNLOAD AUDIO
        */

        console.log(
          "Downloading audio..."
        );

        await downloadFile(
          scene.audioUrl,
          audioPath
        );

        if (
          !fs.existsSync(
            audioPath
          )
        ) {
          throw new Error(
            `Scene ${
              i + 1
            } audio download failed.`
          );
        }

        const audioStats =
          fs.statSync(
            audioPath
          );

        console.log(
          "Audio size:",
          audioStats.size,
          "bytes"
        );

        if (
          audioStats.size < 1000
        ) {
          throw new Error(
            `Scene ${
              i + 1
            } audio is invalid.`
          );
        }

        const audioDuration =
          await getMediaDuration(
            audioPath
          );

        console.log(
          "Audio duration:",
          audioDuration,
          "seconds"
        );

        /*
          RENDER SCENE
        */

        await renderSceneVideo(
          imagePath,
          audioPath,
          Number(
            scene.duration
          ) || 5,
          sceneVideo
        );

        if (
          !fs.existsSync(
            sceneVideo
          )
        ) {
          throw new Error(
            `Scene ${
              i + 1
            } video was not created.`
          );
        }

        sceneVideos.push(
          sceneVideo
        );

        /*
          Free image/audio memory/files
          before processing next scene.
        */

        safeDelete(
          imagePath
        );

        safeDelete(
          audioPath
        );

        console.log("");
        console.log(
          `SCENE ${
            i + 1
          } COMPLETED`
        );
        console.log(
          "========================================"
        );
      }

      /*
        FINAL VIDEO
      */

      const concatFile =
        path.join(
          jobDir,
          "concat.txt"
        );

      const finalFilename =
        `video_${jobId}.mp4`;

      const finalPath =
        path.join(
          VIDEOS_DIR,
          finalFilename
        );

      await concatSceneVideos(
        sceneVideos,
        concatFile,
        finalPath
      );

      /*
        VERIFY FINAL FILE
      */

      if (
        !fs.existsSync(
          finalPath
        )
      ) {
        throw new Error(
          "Final video was not created."
        );
      }

      const finalStats =
        fs.statSync(
          finalPath
        );

      console.log(
        "Final video size:",
        finalStats.size,
        "bytes"
      );

      if (
        finalStats.size < 1000
      ) {
        throw new Error(
          "Final video is empty."
        );
      }

      /*
        FINAL FFPROBE
      */

      const metadata =
        await new Promise(
          (
            resolve,
            reject
          ) => {
            ffmpeg.ffprobe(
              finalPath,
              (
                error,
                data
              ) => {
                if (error) {
                  reject(error);
                } else {
                  resolve(
                    data
                  );
                }
              }
            );
          }
        );

      const videoStreams =
        (
          metadata.streams ||
          []
        ).filter(
          (stream) =>
            stream.codec_type ===
            "video"
        );

      const audioStreams =
        (
          metadata.streams ||
          []
        ).filter(
          (stream) =>
            stream.codec_type ===
            "audio"
        );

      console.log(
        "Final video streams:",
        videoStreams.length
      );

      console.log(
        "Final audio streams:",
        audioStreams.length
      );

      if (
        videoStreams.length === 0
      ) {
        throw new Error(
          "Final video has no video stream."
        );
      }

      if (
        audioStreams.length === 0
      ) {
        throw new Error(
          "Final video has no audio stream."
        );
      }

      const videoUrl =
        `${getServerUrl()}/uploads/videos/${finalFilename}`;

      console.log("");
      console.log(
        "========================================"
      );
      console.log(
        "FINAL VIDEO READY"
      );
      console.log(
        "========================================"
      );
      console.log(
        "Video URL:",
        videoUrl
      );
      console.log(
        "File size:",
        finalStats.size
      );
      console.log(
        "Video streams:",
        videoStreams.length
      );
      console.log(
        "Audio streams:",
        audioStreams.length
      );
      console.log(
        "========================================"
      );

      return res.json({
        success: true,

        videoUrl,

        url: videoUrl,

        filename:
          finalFilename,

        scenes:
          scenes.length,

        hasAudio:
          audioStreams.length > 0,

        hasVideo:
          videoStreams.length > 0,
      });
    } catch (error) {
      console.error("");
      console.error(
        "========================================"
      );
      console.error(
        "FINAL VIDEO GENERATION FAILED"
      );
      console.error(
        "========================================"
      );
      console.error(
        error.message
      );
      console.error(
        error.stack
      );
      console.error(
        "========================================"
      );

      /*
        Important:
        Return JSON instead of allowing Bonto
        to turn the request into a generic 502.
      */

      if (
        !res.headersSent
      ) {
        return res.status(500).json({
          success: false,

          error:
            error.message ||
            "Final video generation failed.",
        });
      }
    } finally {
      /*
        Clean temporary files after response.

        Do NOT delete the final video because
        it lives in /uploads/videos.
      */

      setTimeout(() => {
        safeDelete(jobDir);
      }, 2000);
    }
  }
);

/* =========================================================
   GENERATE VIDEO ALIAS
========================================================= */

app.post(
  "/api/generate-video",
  async (req, res) => {
    try {
      const {
        scenes,
      } = req.body || {};

      if (
        Array.isArray(scenes)
      ) {
        req.url =
          "/api/generate-final-video";

        return app.handle(
          req,
          res
        );
      }

      req.url =
        "/api/generate-scene-video";

      return app.handle(
        req,
        res
      );
    } catch (error) {
      console.error(
        "Generate video alias error:",
        error
      );

      return res.status(500).json({
        success: false,

        error:
          error.message ||
          "Video generation failed.",
      });
    }
  }
);

/* =========================================================
   TEST FFMPEG
========================================================= */

app.get(
  "/api/test-ffmpeg",
  async (req, res) => {
    const filename =
      `ffmpeg_test_${uuidv4()}.mp4`;

    const outputPath =
      path.join(
        VIDEOS_DIR,
        filename
      );

    try {
      ensureFfmpegAvailable();

      await new Promise(
        (
          resolve,
          reject
        ) => {
          ffmpeg()
            .input(
              "color=c=black:s=1280x720:r=24"
            )

            .inputFormat(
              "lavfi"
            )

            .input(
              "anullsrc=channel_layout=stereo:sample_rate=44100"
            )

            .inputFormat(
              "lavfi"
            )

            .outputOptions([
              "-map",
              "0:v:0",

              "-map",
              "1:a:0",

              "-c:v",
              "libx264",

              "-preset",
              "ultrafast",

              "-crf",
              "28",

              "-r",
              "24",

              "-c:a",
              "aac",

              "-b:a",
              "128k",

              "-t",
              "2",

              "-pix_fmt",
              "yuv420p",

              "-shortest",

              "-threads",
              "1",
            ])

            .on(
              "start",
              (commandLine) => {
                console.log(
                  "FFmpeg test:",
                  commandLine
                );
              }
            )

            .on(
              "stderr",
              (line) => {
                console.log(
                  "FFmpeg test:",
                  line
                );
              }
            )

            .on(
              "end",
              resolve
            )

            .on(
              "error",
              reject
            )

            .save(
              outputPath
            );
        }
      );

      return res.json({
        success: true,

        videoUrl:
          `${getServerUrl()}/uploads/videos/${filename}`,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,

        error:
          error.message,
      });
    }
  }
);

/* =========================================================
   SERVER TEST
========================================================= */

app.get(
  "/api/test",
  (req, res) => {
    res.json({
      success: true,

      server:
        "AI Video Studio Server",

      port:
        PORT,

      serverUrl:
        getServerUrl(),

      elevenlabs:
        ELEVENLABS_API_KEY
          ? "Configured"
          : "NOT CONFIGURED",

      ffmpeg:
        resolvedFfmpegPath &&
        fs.existsSync(
          resolvedFfmpegPath
        )
          ? "Configured"
          : "NOT CONFIGURED",

      ffprobe:
        resolvedFfprobePath &&
        fs.existsSync(
          resolvedFfprobePath
        )
          ? "Configured"
          : "NOT CONFIGURED",

      directories: {
        images:
          IMAGES_DIR,

        audio:
          AUDIO_DIR,

        videos:
          VIDEOS_DIR,

        temp:
          TEMP_DIR,
      },
    });
  }
);

/* =========================================================
   ROOT
========================================================= */

app.get(
  "/",
  (req, res) => {
    res.json({
      success: true,

      message:
        "AI Video Studio Server is running.",

      server:
        "AI Video Studio",

      api:
        "/api/test",
    });
  }
);

/* =========================================================
   404
========================================================= */

app.use(
  (req, res) => {
    res.status(404).json({
      success: false,

      error:
        "Route not found.",

      route:
        `${req.method} ${req.originalUrl}`,
    });
  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "Server error:",
      error
    );

    if (
      res.headersSent
    ) {
      return next(error);
    }

    res.status(500).json({
      success: false,

      error:
        error.message ||
        "Internal server error.",
    });
  }
);

/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  () => {
    console.log("");
    console.log(
      "========================================"
    );
    console.log(
      "       AI VIDEO STUDIO SERVER"
    );
    console.log(
      "========================================"
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Server URL: ${getServerUrl()}`
    );

    console.log(
      `Images: ${getServerUrl()}/uploads/images`
    );

    console.log(
      `Audio: ${getServerUrl()}/uploads/audio`
    );

    console.log(
      `Videos: ${getServerUrl()}/uploads/videos`
    );

    console.log(
      "----------------------------------------"
    );

    console.log(
      "ElevenLabs:",
      ELEVENLABS_API_KEY
        ? "Configured ✓"
        : "NOT CONFIGURED ✗"
    );

    console.log(
      "FFmpeg:",
      resolvedFfmpegPath &&
      fs.existsSync(
        resolvedFfmpegPath
      )
        ? "Configured ✓"
        : "NOT CONFIGURED ✗"
    );

    console.log(
      "FFprobe:",
      resolvedFfprobePath &&
      fs.existsSync(
        resolvedFfprobePath
      )
        ? "Configured ✓"
        : "NOT CONFIGURED ✗"
    );

    console.log(
      "========================================"
    );

    console.log("");
  }
);