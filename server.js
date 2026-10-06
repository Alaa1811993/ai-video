
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

const app = express();

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT) || 3000;

const SERVER_URL =
  process.env.SERVER_URL || "https://ai-video.bonto.run";

const ELEVENLABS_API_KEY =
  process.env.ELEVENLABS_API_KEY || "";

const MAX_BODY_SIZE = "100mb";

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

if (ffprobeStatic && ffprobeStatic.path) {
  ffmpeg.setFfprobePath(ffprobeStatic.path);
}

/* =========================================================
   DIRECTORIES
========================================================= */

const UPLOADS_DIR = path.join(__dirname, "uploads");

const IMAGES_DIR = path.join(
  UPLOADS_DIR,
  "images"
);

const AUDIO_DIR = path.join(
  UPLOADS_DIR,
  "audio"
);

const VIDEOS_DIR = path.join(
  UPLOADS_DIR,
  "videos"
);

const TEMP_DIR = path.join(
  UPLOADS_DIR,
  "temp"
);

[
  UPLOADS_DIR,
  IMAGES_DIR,
  AUDIO_DIR,
  VIDEOS_DIR,
  TEMP_DIR
].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, {
      recursive: true
    });
  }
});

/* =========================================================
   CORS
========================================================= */

const allowedOrigins = [
  "https://ai-video-studio-542c9.web.app",
  "https://ai-video-studio-542c9.firebaseapp.com",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175"
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

      console.log("CORS origin:", origin);

      return callback(null, true);
    },
    methods: [
      "GET",
      "POST",
      "PUT",
      "DELETE",
      "OPTIONS"
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization"
    ],
    credentials: false
  })
);

app.use(
  express.json({
    limit: MAX_BODY_SIZE
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: MAX_BODY_SIZE
  })
);

/* =========================================================
   STATIC FILES
========================================================= */

app.use(
  "/uploads",
  express.static(UPLOADS_DIR, {
    maxAge: "1h"
  })
);

/* =========================================================
   MULTER
========================================================= */

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, IMAGES_DIR);
  },

  filename: function (req, file, cb) {
    const ext =
      path.extname(file.originalname) || ".png";

    cb(
      null,
      `image_${uuidv4()}${ext}`
    );
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

/* =========================================================
   HELPERS
========================================================= */

function getServerUrl() {
  return SERVER_URL.replace(/\/$/, "");
}

function normalizeMediaUrl(url) {
  if (!url) {
    return null;
  }

  if (
    url.startsWith("http://localhost:5000") ||
    url.startsWith("http://localhost:3000")
  ) {
    return url
      .replace(
        "http://localhost:5000",
        getServerUrl()
      )
      .replace(
        "http://localhost:3000",
        getServerUrl()
      );
  }

  if (url.startsWith("/uploads/")) {
    return (
      getServerUrl() +
      url
    );
  }

  return url;
}

function safeDelete(filePath) {
  try {
    if (
      filePath &&
      fs.existsSync(filePath)
    ) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.log(
      "Delete warning:",
      error.message
    );
  }
}

function ensureFfmpegAvailable() {
  if (!ffmpegStatic) {
    throw new Error(
      "FFmpeg executable was not found."
    );
  }

  if (
    ffprobeStatic &&
    !ffprobeStatic.path
  ) {
    console.log(
      "Warning: ffprobe path is unavailable."
    );
  }
}

function isHttpUrl(value) {
  return (
    typeof value === "string" &&
    /^https?:\/\//i.test(value)
  );
}

/* =========================================================
   DOWNLOAD REMOTE FILE
========================================================= */

function downloadFile(url, destination) {
  return new Promise(
    (resolve, reject) => {
      if (!isHttpUrl(url)) {
        return reject(
          new Error(
            `Invalid remote URL: ${url}`
          )
        );
      }

      const client = url.startsWith(
        "https://"
      )
        ? https
        : http;

      const request =
        client.get(
          url,
          {
            headers: {
              "User-Agent":
                "AI-Video-Studio/1.0"
            }
          },
          (response) => {
            /*
             * Follow redirects.
             */
            if (
              response.statusCode >= 300 &&
              response.statusCode < 400 &&
              response.headers.location
            ) {
              response.resume();

              return downloadFile(
                response.headers.location,
                destination
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
                  `Download failed HTTP ${response.statusCode}`
                )
              );
            }

            const file =
              fs.createWriteStream(
                destination
              );

            response.pipe(file);

            file.on(
              "finish",
              () => {
                file.close(() => {
                  resolve(destination);
                });
              }
            );

            file.on(
              "error",
              (error) => {
                safeDelete(destination);
                reject(error);
              }
            );
          }
        );

      request.on(
        "error",
        (error) => {
          safeDelete(destination);
          reject(error);
        }
      );

      request.setTimeout(
        120000,
        () => {
          request.destroy(
            new Error(
              "Download timeout"
            )
          );
        }
      );
    }
  );
}

/* =========================================================
   GET MEDIA DURATION
========================================================= */

function getMediaDuration(filePath) {
  return new Promise(
    (resolve, reject) => {
      ffmpeg.ffprobe(
        filePath,
        (error, metadata) => {
          if (error) {
            return reject(error);
          }

          const duration =
            Number(
              metadata?.format?.duration
            ) || 0;

          resolve(duration);
        }
      );
    }
  );
}

/* =========================================================
   DOWNLOAD MEDIA TO TEMP
========================================================= */

async function prepareMedia(
  url,
  prefix
) {
  if (!url) {
    throw new Error(
      `${prefix} URL is missing`
    );
  }

  /*
   * Local uploads URL
   */
  if (
    url.startsWith(
      getServerUrl() + "/uploads/"
    )
  ) {
    const relative =
      url.substring(
        (
          getServerUrl() +
          "/uploads/"
        ).length
      );

    const localPath = path.join(
      UPLOADS_DIR,
      relative
    );

    if (fs.existsSync(localPath)) {
      return {
        path: localPath,
        temporary: false
      };
    }
  }

  /*
   * Relative upload URL
   */
  if (
    url.startsWith("/uploads/")
  ) {
    const relative =
      url.substring(
        "/uploads/".length
      );

    const localPath = path.join(
      UPLOADS_DIR,
      relative
    );

    if (fs.existsSync(localPath)) {
      return {
        path: localPath,
        temporary: false
      };
    }
  }

  /*
   * Remote URL
   */
  const ext =
    path.extname(
      new URL(url).pathname
    ) || ".dat";

  const destination =
    path.join(
      TEMP_DIR,
      `${prefix}_${uuidv4()}${ext}`
    );

  await downloadFile(
    url,
    destination
  );

  return {
    path: destination,
    temporary: true
  };
}

/* =========================================================
   VOICES
========================================================= */

const VOICES = {
  Female: "EXAVITQu4vr4xnSDxMaL",
  Male: "ErXwobaYiN019PkySvjV",
  "Deep Male":
    "VR6AewLTigWG4xSOukaG",
  Professional:
    "TxGEqnHWrfWFTfGW9XjX",
  Storyteller:
    "pNInz6obpgDQGcFmaJgB"
};

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      success: true,
      message:
        "AI Video Server is running",
      serverUrl: getServerUrl(),
      port: PORT,
      ffmpeg: Boolean(ffmpegStatic),
      ffprobe: Boolean(
        ffprobeStatic?.path
      ),
      elevenlabs:
        Boolean(ELEVENLABS_API_KEY),
      directories: {
        uploads: UPLOADS_DIR,
        images: IMAGES_DIR,
        audio: AUDIO_DIR,
        videos: VIDEOS_DIR
      }
    });
  }
);

app.get(
  "/api/test",
  (req, res) => {
    res.json({
      success: true,
      message:
        "API test successful"
    });
  }
);

/* =========================================================
   TEST FFMPEG
========================================================= */

app.get(
  "/api/test-ffmpeg",
  (req, res) => {
    try {
      ensureFfmpegAvailable();

      res.json({
        success: true,
        ffmpeg: ffmpegStatic,
        ffprobe:
          ffprobeStatic?.path || null
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* =========================================================
   UPLOAD IMAGE
========================================================= */

app.post(
  "/api/upload",
  upload.single("image"),
  (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error:
            "No image file uploaded"
        });
      }

      const fileUrl =
        `${getServerUrl()}/uploads/images/${req.file.filename}`;

      console.log(
        "Uploaded image:",
        fileUrl
      );

      res.json({
        success: true,
        fileUrl,
        url: fileUrl,
        imageUrl: fileUrl,
        filename:
          req.file.filename
      });
    } catch (error) {
      console.error(
        "Upload error:",
        error
      );

      res.status(500).json({
        success: false,
        error: error.message
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
        width = 1280,
        height = 720
      } = req.body;

      if (!prompt) {
        return res.status(400).json({
          success: false,
          error:
            "Prompt is required"
        });
      }

      const encodedPrompt =
        encodeURIComponent(
          prompt
        );

      const imageUrl =
        `https://image.pollinations.ai/prompt/${encodedPrompt}` +
        `?width=${width}` +
        `&height=${height}` +
        `&model=flux` +
        `&nologo=true`;

      console.log(
        "Generated image URL:",
        imageUrl
      );

      res.json({
        success: true,
        imageUrl,
        url: imageUrl
      });
    } catch (error) {
      console.error(
        "Generate image error:",
        error
      );

      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* =========================================================
   GENERATE CHARACTER
========================================================= */

app.post(
  "/api/generate-character",
  async (req, res) => {
    try {
      const {
        prompt
      } = req.body;

      if (!prompt) {
        return res.status(400).json({
          success: false,
          error:
            "Character prompt is required"
        });
      }

      const finalPrompt =
        `${prompt}, ` +
        `full body character, ` +
        `isolated character, ` +
        `front view, ` +
        `standing pose, ` +
        `green screen background, ` +
        `bright solid green background, ` +
        `consistent character design, ` +
        `high quality, ` +
        `detailed, ` +
        `cinematic`;

      const encodedPrompt =
        encodeURIComponent(
          finalPrompt
        );

      const imageUrl =
        `https://image.pollinations.ai/prompt/${encodedPrompt}` +
        `?width=1024` +
        `&height=1024` +
        `&model=flux` +
        `&nologo=true`;

      res.json({
        success: true,
        imageUrl,
        url: imageUrl
      });
    } catch (error) {
      console.error(
        "Generate character error:",
        error
      );

      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* =========================================================
   GENERATE BACKGROUND
========================================================= */

app.post(
  "/api/generate-background",
  async (req, res) => {
    try {
      const {
        prompt
      } = req.body;

      if (!prompt) {
        return res.status(400).json({
          success: false,
          error:
            "Background prompt is required"
        });
      }

      const finalPrompt =
        `${prompt}, ` +
        `cinematic environment, ` +
        `wide shot, ` +
        `16:9 composition, ` +
        `no people, ` +
        `no characters, ` +
        `high detail, ` +
        `realistic lighting`;

      const encodedPrompt =
        encodeURIComponent(
          finalPrompt
        );

      const imageUrl =
        `https://image.pollinations.ai/prompt/${encodedPrompt}` +
        `?width=1280` +
        `&height=720` +
        `&model=flux` +
        `&nologo=true`;

      res.json({
        success: true,
        imageUrl,
        url: imageUrl
      });
    } catch (error) {
      console.error(
        "Generate background error:",
        error
      );

      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* =========================================================
   GENERATE VOICE
========================================================= */

app.post(
  "/api/generate-voice",
  async (req, res) => {
    try {
      if (!ELEVENLABS_API_KEY) {
        return res.status(500).json({
          success: false,
          error:
            "ELEVENLABS_API_KEY is not configured"
        });
      }

      const {
        text,
        voice = "Female"
      } = req.body;

      if (!text) {
        return res.status(400).json({
          success: false,
          error:
            "Text is required"
        });
      }

      const voiceId =
        VOICES[voice] ||
        VOICES.Female;

      const response =
        await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
          {
            method: "POST",

            headers: {
              "xi-api-key":
                ELEVENLABS_API_KEY,

              "Content-Type":
                "application/json",

              Accept:
                "audio/mpeg"
            },

            body: JSON.stringify({
              text,

              model_id:
                "eleven_multilingual_v2",

              voice_settings: {
                stability: 0.5,
                similarity_boost: 0.75
              }
            })
          }
        );

      if (!response.ok) {
        const errorText =
          await response.text();

        throw new Error(
          `ElevenLabs HTTP ${response.status}: ${errorText}`
        );
      }

      const buffer =
        Buffer.from(
          await response.arrayBuffer()
        );

      const filename =
        `voice_${uuidv4()}.mp3`;

      const outputPath =
        path.join(
          AUDIO_DIR,
          filename
        );

      fs.writeFileSync(
        outputPath,
        buffer
      );

      const audioUrl =
        `${getServerUrl()}/uploads/audio/${filename}`;

      let duration = 0;

      try {
        duration =
          await getMediaDuration(
            outputPath
          );
      } catch (durationError) {
        console.log(
          "Voice duration warning:",
          durationError.message
        );
      }

      res.json({
        success: true,
        audioUrl,
        url: audioUrl,
        audio: audioUrl,
        duration,
        voice
      });
    } catch (error) {
      console.error(
        "Generate voice error:",
        error
      );

      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* =========================================================
   NORMALIZE ANIMATION NAME
========================================================= */

function normalizeAnimation(
  animation
) {
  if (!animation) {
    return "talking";
  }

  return String(animation)
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/\s+/g, "-");
}

/* =========================================================
   SAFE CHARACTER MOVEMENT
=========================================================

   IMPORTANT:

   FFmpeg overlay expressions use lowercase `t`.

   We intentionally DO NOT use:
      T

   We also DO NOT dynamically scale or rotate the
   character inside the overlay expression.

   This keeps the filter graph much more reliable.
========================================================= */

function buildCharacterMovement(
  animation
) {
  const type =
    normalizeAnimation(
      animation
    );

  let x = "(W-w)/2";
  let y = "(H-h)/2";

  switch (type) {
    case "talking":
      y =
        "(H-h)/2+8*sin(2*PI*t*2.5)";
      break;

    case "walking":
      x =
        "(W-w)/2+100*sin(2*PI*t*0.8)";

      y =
        "(H-h)/2+15*abs(sin(2*PI*t*1.6))";
      break;

    case "running":
      x =
        "(W-w)/2+160*sin(2*PI*t*1.2)";

      y =
        "(H-h)/2+22*abs(sin(2*PI*t*2.4))";
      break;

    case "jumping":
      y =
        "(H-h)/2-110*abs(sin(PI*t*0.9))";
      break;

    case "attacking":
      x =
        "(W-w)/2+80*sin(2*PI*t*1.8)";

      y =
        "(H-h)/2+10*sin(2*PI*t*3.6)";
      break;

    case "dancing":
      x =
        "(W-w)/2+90*sin(2*PI*t*1.1)";

      y =
        "(H-h)/2+35*sin(2*PI*t*2.2)";
      break;

    case "breathing":
      y =
        "(H-h)/2+6*sin(2*PI*t*1.2)";
      break;

    case "talking-walking":
      x =
        "(W-w)/2+100*sin(2*PI*t*0.8)";

      y =
        "(H-h)/2+15*abs(sin(2*PI*t*1.6))+7*sin(2*PI*t*2.5)";
      break;

    default:
      y =
        "(H-h)/2+5*sin(2*PI*t*0.7)";
      break;
  }

  return {
    x,
    y
  };
}

/* =========================================================
   CHARACTER VIDEO RENDERER
========================================================= */

async function renderCharacterVideo({
  backgroundUrl,
  characterUrl,
  audioUrl,
  animation = "talking",
  duration
}) {
  ensureFfmpegAvailable();

  if (!backgroundUrl) {
    throw new Error(
      "backgroundUrl is required"
    );
  }

  if (!characterUrl) {
    throw new Error(
      "characterUrl is required"
    );
  }

  if (!audioUrl) {
    throw new Error(
      "audioUrl is required"
    );
  }

  /*
   * Prepare all media.
   */

  const background =
    await prepareMedia(
      normalizeMediaUrl(
        backgroundUrl
      ),
      "background"
    );

  const character =
    await prepareMedia(
      normalizeMediaUrl(
        characterUrl
      ),
      "character"
    );

  const audio =
    await prepareMedia(
      normalizeMediaUrl(
        audioUrl
      ),
      "audio"
    );

  /*
   * Determine duration.
   */

  let finalDuration =
    Number(duration) || 0;

  if (
    !finalDuration ||
    finalDuration <= 0
  ) {
    try {
      finalDuration =
        await getMediaDuration(
          audio.path
        );
    } catch (error) {
      console.log(
        "Could not detect audio duration:",
        error.message
      );
    }
  }

  if (
    !finalDuration ||
    finalDuration <= 0
  ) {
    finalDuration = 5;
  }

  /*
   * Safety limit.
   */

  finalDuration =
    Math.min(
      Math.max(
        finalDuration,
        1
      ),
      300
    );

  const movement =
    buildCharacterMovement(
      animation
    );

  console.log(
    "========================================"
  );

  console.log(
    "CHARACTER VIDEO"
  );

  console.log(
    "Animation:",
    animation
  );

  console.log(
    "Duration:",
    finalDuration
  );

  console.log(
    "Movement X:",
    movement.x
  );

  console.log(
    "Movement Y:",
    movement.y
  );

  console.log(
    "========================================"
  );

  const outputFilename =
    `character_${uuidv4()}.mp4`;

  const outputPath =
    path.join(
      VIDEOS_DIR,
      outputFilename
    );

  /*
   * SAFE FILTER GRAPH
   *
   * Background:
   *   1280x720
   *
   * Character:
   *   fixed width 520
   *
   * Animation:
   *   overlay x/y only
   *
   * This avoids the previous broken:
   *
   *   scale='520*min(...)'
   *   rotate=dynamic
   *
   * and avoids uppercase T.
   */

  const filterComplex = [
    /*
     * Background
     */
    "[0:v]" +
      "scale=1280:720:" +
      "force_original_aspect_ratio=increase," +
      "crop=1280:720," +
      "setsar=1," +
      "fps=24," +
      "setpts=PTS-STARTPTS" +
      "[bg]",

    /*
     * Character
     */
    "[1:v]" +
      "scale=520:-1," +
      "format=rgba," +
      "chromakey=0x00ff00:0.25:0.08," +
      "fps=24," +
      "setpts=PTS-STARTPTS" +
      "[char]",

    /*
     * Character movement
     *
     * IMPORTANT:
     * lowercase t
     */
    "[bg][char]" +
      `overlay=x='${movement.x}':y='${movement.y}':eval=frame:format=auto` +
      "," +
      "format=yuv420p" +
      "[video]"
  ].join(";");

  console.log(
    "Character filter:",
    filterComplex
  );

  return new Promise(
    (resolve, reject) => {
      const command =
        ffmpeg();

      /*
       * Loop images forever.
       */

      command
        .input(background.path)
        .inputOptions([
          "-loop",
          "1",
          "-framerate",
          "24"
        ])

        .input(character.path)
        .inputOptions([
          "-loop",
          "1",
          "-framerate",
          "24"
        ])

        .input(audio.path)

        .complexFilter(
          filterComplex
        )

        .outputOptions([
          "-map",
          "[video]",

          "-map",
          "2:a:0",

          "-c:v",
          "libx264",

          "-preset",
          "ultrafast",

          "-crf",
          "28",

          "-pix_fmt",
          "yuv420p",

          "-r",
          "24",

          "-c:a",
          "aac",

          "-b:a",
          "128k",

          "-ar",
          "44100",

          "-ac",
          "2",

          "-t",
          String(finalDuration),

          "-movflags",
          "+faststart",

          "-threads",
          "1"
        ])

        .on(
          "start",
          (commandLine) => {
            console.log(
              "Character FFmpeg command:"
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
                "Character progress:",
                progress.percent.toFixed(
                  1
                ) + "%"
              );
            }
          }
        )

        .on(
          "stderr",
          (line) => {
            console.log(
              "Character FFmpeg:",
              line
            );
          }
        )

        .on(
          "error",
          (error) => {
            console.error(
              "========================================"
            );

            console.error(
              "CHARACTER FFMPEG ERROR"
            );

            console.error(
              "========================================"
            );

            console.error(
              error.message
            );

            console.error(
              "========================================"
            );

            safeDelete(
              outputPath
            );

            if (
              background.temporary
            ) {
              safeDelete(
                background.path
              );
            }

            if (
              character.temporary
            ) {
              safeDelete(
                character.path
              );
            }

            if (
              audio.temporary
            ) {
              safeDelete(
                audio.path
              );
            }

            reject(error);
          }
        )

        .on(
          "end",
          async () => {
            try {
              console.log(
                "Character video FFmpeg finished."
              );

              if (
                !fs.existsSync(
                  outputPath
                )
              ) {
                throw new Error(
                  "Character video output was not created."
                );
              }

              const stats =
                fs.statSync(
                  outputPath
                );

              if (
                stats.size < 1000
              ) {
                throw new Error(
                  "Character video output is too small."
                );
              }

              /*
               * Verify video and audio
               */

              await new Promise(
                (
                  resolveProbe,
                  rejectProbe
                ) => {
                  ffmpeg.ffprobe(
                    outputPath,
                    (
                      probeError,
                      metadata
                    ) => {
                      if (
                        probeError
                      ) {
                        return rejectProbe(
                          probeError
                        );
                      }

                      const streams =
                        metadata.streams ||
                        [];

                      const hasVideo =
                        streams.some(
                          (stream) =>
                            stream.codec_type ===
                            "video"
                        );

                      const hasAudio =
                        streams.some(
                          (stream) =>
                            stream.codec_type ===
                            "audio"
                        );

                      console.log(
                        "Character video streams:",
                        {
                          hasVideo,
                          hasAudio
                        }
                      );

                      if (
                        !hasVideo
                      ) {
                        return rejectProbe(
                          new Error(
                            "Character video has no video stream."
                          )
                        );
                      }

                      if (
                        !hasAudio
                      ) {
                        return rejectProbe(
                          new Error(
                            "Character video has no audio stream."
                          )
                        );
                      }

                      resolveProbe();
                    }
                  );
                }
              );

              const videoUrl =
                `${getServerUrl()}/uploads/videos/${outputFilename}`;

              console.log(
                "Character video URL:",
                videoUrl
              );

              /*
               * Clean temporary files.
               */

              if (
                background.temporary
              ) {
                safeDelete(
                  background.path
                );
              }

              if (
                character.temporary
              ) {
                safeDelete(
                  character.path
                );
              }

              if (
                audio.temporary
              ) {
                safeDelete(
                  audio.path
                );
              }

              resolve({
                path: outputPath,
                url: videoUrl,
                videoUrl,
                duration:
                  finalDuration
              });
            } catch (error) {
              safeDelete(
                outputPath
              );

              if (
                background.temporary
              ) {
                safeDelete(
                  background.path
                );
              }

              if (
                character.temporary
              ) {
                safeDelete(
                  character.path
                );
              }

              if (
                audio.temporary
              ) {
                safeDelete(
                  audio.path
                );
              }

              reject(error);
            }
          }
        )

        .save(
          outputPath
        );
    }
  );
}

/* =========================================================
   GENERATE CHARACTER VIDEO
========================================================= */

app.post(
  "/api/generate-character-video",
  async (req, res) => {
    try {
      const {
        backgroundUrl,
        characterUrl,
        audioUrl,
        animation,
        duration
      } = req.body;

      const result =
        await renderCharacterVideo({
          backgroundUrl,
          characterUrl,
          audioUrl,
          animation,
          duration
        });

      res.json({
        success: true,
        videoUrl:
          result.videoUrl,
        url:
          result.videoUrl,
        duration:
          result.duration
      });
    } catch (error) {
      console.error(
        "Generate character video error:",
        error
      );

      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* =========================================================
   NORMAL SCENE VIDEO
========================================================= */

async function renderSceneVideo({
  imageUrl,
  audioUrl,
  duration,
  animation
}) {
  ensureFfmpegAvailable();

  const image =
    await prepareMedia(
      normalizeMediaUrl(
        imageUrl
      ),
      "scene-image"
    );

  const audio =
    await prepareMedia(
      normalizeMediaUrl(
        audioUrl
      ),
      "scene-audio"
    );

  let finalDuration =
    Number(duration) || 0;

  if (
    !finalDuration ||
    finalDuration <= 0
  ) {
    finalDuration =
      await getMediaDuration(
        audio.path
      );
  }

  if (
    !finalDuration ||
    finalDuration <= 0
  ) {
    finalDuration = 5;
  }

  finalDuration =
    Math.min(
      Math.max(
        finalDuration,
        1
      ),
      300
    );

  /*
   * Normal image animation.
   *
   * This is only used when there is
   * NO separate character.
   */

  let x =
    "(W-w)/2";

  let y =
    "(H-h)/2";

  const type =
    normalizeAnimation(
      animation
    );

  if (
    type === "pan-left"
  ) {
    x =
      "(W-w)/2-40*sin(PI*t/" +
      finalDuration +
      ")";
  } else if (
    type === "pan-right"
  ) {
    x =
      "(W-w)/2+40*sin(PI*t/" +
      finalDuration +
      ")";
  } else if (
    type === "floating"
  ) {
    y =
      "(H-h)/2+10*sin(2*PI*t*0.7)";
  }

  const outputFilename =
    `scene_${uuidv4()}.mp4`;

  const outputPath =
    path.join(
      VIDEOS_DIR,
      outputFilename
    );

  const filterComplex = [
    "[0:v]" +
      "scale=1280:720:" +
      "force_original_aspect_ratio=decrease," +
      "pad=1280:720:(ow-iw)/2:(oh-ih)/2," +
      "setsar=1," +
      "fps=24," +
      "setpts=PTS-STARTPTS" +
      "[img]",

    `[img]` +
      `overlay=x='${x}':y='${y}':eval=frame` +
      "," +
      "format=yuv420p" +
      "[video]"
  ].join(";");

  return new Promise(
    (resolve, reject) => {
      ffmpeg()

        .input(image.path)
        .inputOptions([
          "-loop",
          "1",
          "-framerate",
          "24"
        ])

        .input(audio.path)

        .complexFilter(
          filterComplex
        )

        .outputOptions([
          "-map",
          "[video]",

          "-map",
          "1:a:0",

          "-c:v",
          "libx264",

          "-preset",
          "ultrafast",

          "-crf",
          "28",

          "-pix_fmt",
          "yuv420p",

          "-r",
          "24",

          "-c:a",
          "aac",

          "-b:a",
          "128k",

          "-ar",
          "44100",

          "-ac",
          "2",

          "-t",
          String(finalDuration),

          "-movflags",
          "+faststart",

          "-threads",
          "1"
        ])

        .on(
          "start",
          (commandLine) => {
            console.log(
              "Scene FFmpeg command:",
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
                "Scene progress:",
                progress.percent.toFixed(
                  1
                ) + "%"
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
          "error",
          (error) => {
            safeDelete(
              outputPath
            );

            if (
              image.temporary
            ) {
              safeDelete(
                image.path
              );
            }

            if (
              audio.temporary
            ) {
              safeDelete(
                audio.path
              );
            }

            reject(error);
          }
        )

        .on(
          "end",
          () => {
            try {
              if (
                !fs.existsSync(
                  outputPath
                )
              ) {
                throw new Error(
                  "Scene video was not created."
                );
              }

              const stats =
                fs.statSync(
                  outputPath
                );

              if (
                stats.size < 1000
              ) {
                throw new Error(
                  "Scene video is too small."
                );
              }

              const videoUrl =
                `${getServerUrl()}/uploads/videos/${outputFilename}`;

              if (
                image.temporary
              ) {
                safeDelete(
                  image.path
                );
              }

              if (
                audio.temporary
              ) {
                safeDelete(
                  audio.path
                );
              }

              resolve({
                path: outputPath,
                url: videoUrl,
                videoUrl,
                duration:
                  finalDuration
              });
            } catch (error) {
              safeDelete(
                outputPath
              );

              reject(error);
            }
          }
        )

        .save(
          outputPath
        );
    }
  );
}

/* =========================================================
   GENERATE SCENE VIDEO
========================================================= */

app.post(
  "/api/generate-scene-video",
  async (req, res) => {
    try {
      const result =
        await renderSceneVideo(
          req.body
        );

      res.json({
        success: true,
        videoUrl:
          result.videoUrl,
        url:
          result.videoUrl,
        duration:
          result.duration
      });
    } catch (error) {
      console.error(
        "Generate scene video error:",
        error
      );

      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* =========================================================
   CONCAT SCENE VIDEOS
========================================================= */

async function concatSceneVideos(
  sceneVideos
) {
  if (
    !Array.isArray(
      sceneVideos
    ) ||
    sceneVideos.length === 0
  ) {
    throw new Error(
      "No scene videos provided."
    );
  }

  const concatFile =
    path.join(
      TEMP_DIR,
      `concat_${uuidv4()}.txt`
    );

  const outputFilename =
    `video_${uuidv4()}.mp4`;

  const outputPath =
    path.join(
      VIDEOS_DIR,
      outputFilename
    );

  try {
    const lines =
      sceneVideos.map(
        (scenePath) => {
          const escaped =
            scenePath
              .replace(
                /\\/g,
                "/"
              )
              .replace(
                /'/g,
                "'\\''"
              );

          return `file '${escaped}'`;
        }
      );

    fs.writeFileSync(
      concatFile,
      lines.join("\n"),
      "utf8"
    );

    await new Promise(
      (resolve, reject) => {
        ffmpeg()
          .input(
            concatFile
          )
          .inputOptions([
            "-f",
            "concat",
            "-safe",
            "0"
          ])
          .outputOptions([
            "-c",
            "copy",

            "-movflags",
            "+faststart"
          ])
          .on(
            "start",
            (commandLine) => {
              console.log(
                "Concat FFmpeg:",
                commandLine
              );
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
            "error",
            reject
          )
          .on(
            "end",
            resolve
          )
          .save(
            outputPath
          );
      }
    );

    if (
      !fs.existsSync(
        outputPath
      )
    ) {
      throw new Error(
        "Final video was not created."
      );
    }

    const stats =
      fs.statSync(
        outputPath
      );

    if (
      stats.size < 1000
    ) {
      throw new Error(
        "Final video is too small."
      );
    }

    const videoUrl =
      `${getServerUrl()}/uploads/videos/${outputFilename}`;

    return {
      path: outputPath,
      url: videoUrl,
      videoUrl
    };
  } finally {
    safeDelete(
      concatFile
    );
  }
}

/* =========================================================
   GENERATE FINAL VIDEO
========================================================= */

app.post(
  "/api/generate-final-video",
  async (req, res) => {
    const scenePaths = [];

    try {
      const {
        scenes = [],
        imageUrl,
        audioUrl,
        duration,
        animation,
        characterUrl,
        backgroundUrl
      } = req.body;

      /*
       * Support single scene payload.
       */

      let sceneList =
        Array.isArray(scenes)
          ? scenes
          : [];

      if (
        sceneList.length === 0 &&
        (imageUrl ||
          characterUrl)
      ) {
        sceneList = [
          {
            imageUrl,
            audioUrl,
            duration,
            animation,
            characterUrl,
            backgroundUrl
          }
        ];
      }

      if (
        sceneList.length === 0
      ) {
        throw new Error(
          "No scenes provided."
        );
      }

      console.log(
        "========================================"
      );

      console.log(
        "FINAL VIDEO GENERATION"
      );

      console.log(
        "Scenes:",
        sceneList.length
      );

      console.log(
        "========================================"
      );

      /*
       * Render every scene.
       *
       * IMPORTANT:
       * Character animation happens HERE,
       * before concat.
       */

      for (
        let i = 0;
        i < sceneList.length;
        i++
      ) {
        const scene =
          sceneList[i];

        console.log(
          `Rendering scene ${i + 1}/${sceneList.length}`
        );

        /*
         * Resolve media.
         */

        const sceneCharacterUrl =
          scene.characterUrl ||
          characterUrl;

        const sceneBackgroundUrl =
          scene.backgroundUrl ||
          backgroundUrl;

        const sceneImageUrl =
          scene.imageUrl ||
          imageUrl;

        const sceneAudioUrl =
          scene.audioUrl ||
          audioUrl;

        const sceneDuration =
          scene.duration ||
          duration;

        const sceneAnimation =
          scene.animation ||
          animation ||
          "talking";

        let result;

        /*
         * CHARACTER MODE
         *
         * If a character exists and a background
         * exists, use the character renderer.
         */

        if (
          sceneCharacterUrl &&
          sceneBackgroundUrl &&
          sceneAudioUrl
        ) {
          console.log(
            "Scene mode: CHARACTER ANIMATION"
          );

          result =
            await renderCharacterVideo({
              backgroundUrl:
                sceneBackgroundUrl,

              characterUrl:
                sceneCharacterUrl,

              audioUrl:
                sceneAudioUrl,

              animation:
                sceneAnimation,

              duration:
                sceneDuration
            });
        } else {
          /*
           * NORMAL IMAGE MODE
           */

          if (
            !sceneImageUrl ||
            !sceneAudioUrl
          ) {
            throw new Error(
              `Scene ${i + 1} is missing imageUrl or audioUrl.`
            );
          }

          console.log(
            "Scene mode: NORMAL IMAGE"
          );

          result =
            await renderSceneVideo({
              imageUrl:
                sceneImageUrl,

              audioUrl:
                sceneAudioUrl,

              duration:
                sceneDuration,

              animation:
                sceneAnimation
            });
        }

        scenePaths.push(
          result.path
        );

        console.log(
          `Scene ${i + 1} complete:`,
          result.videoUrl
        );
      }

      /*
       * One scene = return it directly.
       *
       * Multiple scenes = concat.
       */

      let finalResult;

      if (
        scenePaths.length === 1
      ) {
        finalResult = {
          path:
            scenePaths[0],
          videoUrl:
            `${getServerUrl()}/uploads/videos/${path.basename(scenePaths[0])}`,
          url:
            `${getServerUrl()}/uploads/videos/${path.basename(scenePaths[0])}`
        };
      } else {
        finalResult =
          await concatSceneVideos(
            scenePaths
          );
      }

      /*
       * Do not delete the final video.
       *
       * It must remain available for the website.
       */

      console.log(
        "========================================"
      );

      console.log(
        "FINAL VIDEO READY"
      );

      console.log(
        finalResult.videoUrl
      );

      console.log(
        "========================================"
      );

      res.json({
        success: true,

        videoUrl:
          finalResult.videoUrl,

        url:
          finalResult.videoUrl,

        video:
          finalResult.videoUrl
      });

      /*
       * For multiple scene videos:
       * they are temporary intermediate files.
       *
       * For one scene, don't delete it because
       * it IS the final video.
       */

      if (
        scenePaths.length > 1
      ) {
        for (
          const scenePath
          of scenePaths
        ) {
          safeDelete(
            scenePath
          );
        }
      }
    } catch (error) {
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

      /*
       * Delete intermediate files.
       */

      for (
        const scenePath
        of scenePaths
      ) {
        safeDelete(
          scenePath
        );
      }

      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   LEGACY GENERATE VIDEO
========================================================= */

app.post(
  "/api/generate-video",
  async (req, res) => {
    try {
      /*
       * Keep compatibility with older frontend code.
       */

      const result =
        await renderSceneVideo(
          req.body
        );

      res.json({
        success: true,

        videoUrl:
          result.videoUrl,

        url:
          result.videoUrl,

        video:
          result.videoUrl
      });
    } catch (error) {
      console.error(
        "Generate video error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
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
      name:
        "AI Video Server",
      version:
        "character-animation-safe-2.0",
      serverUrl:
        getServerUrl(),

      endpoints: [
        "/api/health",
        "/api/test",
        "/api/test-ffmpeg",
        "/api/upload",
        "/api/generate-image",
        "/api/generate-character",
        "/api/generate-background",
        "/api/generate-voice",
        "/api/generate-character-video",
        "/api/generate-scene-video",
        "/api/generate-final-video",
        "/api/generate-video"
      ]
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
      path:
        req.originalUrl
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
      "Express error:",
      error
    );

    if (
      error instanceof
      multer.MulterError
    ) {
      return res.status(400).json({
        success: false,
        error:
          error.message
      });
    }

    res.status(500).json({
      success: false,
      error:
        error.message ||
        "Internal server error"
    });
  }
);

/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "========================================"
    );

    console.log(
      "AI VIDEO SERVER STARTED"
    );

    console.log(
      "========================================"
    );

    console.log(
      "Port:",
      PORT
    );

    console.log(
      "Server URL:",
      getServerUrl()
    );

    console.log(
      "FFmpeg:",
      ffmpegStatic
    );

    console.log(
      "FFprobe:",
      ffprobeStatic?.path ||
        "not found"
    );

    console.log(
      "ElevenLabs configured:",
      Boolean(
        ELEVENLABS_API_KEY
      )
    );

    console.log(
      "Uploads:",
      UPLOADS_DIR
    );

    console.log(
      "Character animation:",
      "SAFE MODE"
    );

    console.log(
      "========================================"
    );
  }
);
