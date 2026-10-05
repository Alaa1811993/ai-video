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

const PORT = process.env.PORT || 5000;

const BASE_URL =
  process.env.BASE_URL ||
  `http://localhost:${PORT}`;

// ----------------------------------------------------
// FFmpeg
// ----------------------------------------------------

ffmpeg.setFfmpegPath(ffmpegStatic);

if (ffprobeStatic && ffprobeStatic.path) {
  ffmpeg.setFfprobePath(ffprobeStatic.path);
}

// ----------------------------------------------------
// Directories
// ----------------------------------------------------

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

// ----------------------------------------------------
// CORS
// ----------------------------------------------------

const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",

  "https://ai-video-studio-542c9.web.app",
  "https://ai-video-studio-542c9.firebaseapp.com",
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
      "OPTIONS",
    ],

    allowedHeaders: [
      "Content-Type",
      "Authorization",
    ],

    credentials: false,
  })
);

app.use(express.json({
  limit: "100mb",
}));

app.use(express.urlencoded({
  extended: true,
  limit: "100mb",
}));

// ----------------------------------------------------
// Static files
// ----------------------------------------------------

app.use(
  "/uploads",
  express.static(UPLOADS_DIR)
);

// ----------------------------------------------------
// Multer
// ----------------------------------------------------

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, IMAGES_DIR);
  },

  filename: function (req, file, cb) {
    const ext =
      path.extname(file.originalname || "") ||
      ".png";

    cb(
      null,
      `${Date.now()}-${uuidv4()}${ext}`
    );
  },
});

const upload = multer({
  storage,

  limits: {
    fileSize: 100 * 1024 * 1024,
  },

  fileFilter: function (req, file, cb) {
    const allowed = [
      "image/png",
      "image/jpeg",
      "image/jpg",
      "image/webp",
    ];

    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Only PNG, JPG, JPEG and WEBP images are allowed."
        )
      );
    }
  },
});

// ----------------------------------------------------
// Helpers
// ----------------------------------------------------

function fixUrl(url) {
  if (!url) {
    return null;
  }

  if (
    url.startsWith("http://") ||
    url.startsWith("https://")
  ) {
    return url;
  }

  if (url.startsWith("/uploads/")) {
    return `${BASE_URL}${url}`;
  }

  return url;
}

function safeUnlink(file) {
  try {
    if (file && fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch (error) {
    console.log(
      "Could not delete:",
      file,
      error.message
    );
  }
}

function sanitizeFilename(name) {
  return String(name || "file")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

// ----------------------------------------------------
// Download remote file
// ----------------------------------------------------

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    if (!url) {
      return reject(
        new Error("Missing download URL")
      );
    }

    const protocol = url.startsWith("https://")
      ? https
      : http;

    const request = protocol.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 AI-Video-Studio",
        },
      },
      (response) => {

        // Redirect
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

        if (response.statusCode !== 200) {
          response.resume();

          return reject(
            new Error(
              `Download failed HTTP ${response.statusCode}: ${url}`
            )
          );
        }

        const file = fs.createWriteStream(
          destination
        );

        response.pipe(file);

        file.on("finish", () => {
          file.close(() => {
            resolve(destination);
          });
        });

        file.on("error", (error) => {
          safeUnlink(destination);
          reject(error);
        });
      }
    );

    request.on("error", (error) => {
      safeUnlink(destination);
      reject(error);
    });

    request.setTimeout(120000, () => {
      request.destroy(
        new Error("Download timeout")
      );
    });
  });
}

// ----------------------------------------------------
// Download media
// ----------------------------------------------------

async function downloadMedia(url, folder, prefix) {
  if (!url) {
    return null;
  }

  const extension =
    path.extname(
      new URL(
        url,
        BASE_URL
      ).pathname
    ) || ".png";

  const filename =
    `${prefix}_${uuidv4()}${extension}`;

  const destination =
    path.join(folder, filename);

  await downloadFile(
    url,
    destination
  );

  return destination;
}

// ----------------------------------------------------
// Health
// ----------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "AI Video Server is running",
    server: BASE_URL,
    port: PORT,
    ffmpeg: !!ffmpegStatic,
    ffprobe: !!ffprobeStatic,
    directories: {
      uploads: UPLOADS_DIR,
      images: IMAGES_DIR,
      audio: AUDIO_DIR,
      videos: VIDEOS_DIR,
      temp: TEMP_DIR,
    },
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "AI Video Server is healthy",
    port: PORT,
    baseUrl: BASE_URL,
  });
});

// ====================================================
// UPLOAD IMAGE
// ====================================================

app.post(
  "/api/upload",
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: "No image uploaded",
        });
      }

      const url =
        `${BASE_URL}/uploads/images/${req.file.filename}`;

      console.log(
        "Uploaded image:",
        url
      );

      res.json({
        success: true,

        url,

        imageUrl: url,

        fileUrl: url,

        path:
          `/uploads/images/${req.file.filename}`,

        filename:
          req.file.filename,
      });

    } catch (error) {
      console.error(
        "Upload error:",
        error
      );

      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
);

// ====================================================
// GENERATE IMAGE
// ====================================================

app.post(
  "/api/generate-image",
  async (req, res) => {
    try {
      const {
        prompt,
        width = 1280,
        height = 720,
      } = req.body;

      if (!prompt) {
        return res.status(400).json({
          success: false,
          error: "Prompt is required",
        });
      }

      const encodedPrompt =
        encodeURIComponent(prompt);

      const imageUrl =
        `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${width}&height=${height}&model=flux&nologo=true`;

      const filename =
        `image_${uuidv4()}.jpg`;

      const destination =
        path.join(
          IMAGES_DIR,
          filename
        );

      await downloadFile(
        imageUrl,
        destination
      );

      const finalUrl =
        `${BASE_URL}/uploads/images/${filename}`;

      res.json({
        success: true,
        imageUrl: finalUrl,
        url: finalUrl,
      });

    } catch (error) {
      console.error(
        "Generate image error:",
        error
      );

      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
);

// ====================================================
// GENERATE VOICE
// ====================================================

app.post(
  "/api/generate-voice",
  async (req, res) => {
    try {
      const {
        text,
        voice = "Female",
      } = req.body;

      if (!text) {
        return res.status(400).json({
          success: false,
          error: "Text is required",
        });
      }

      const apiKey =
        process.env.ELEVENLABS_API_KEY;

      if (!apiKey) {
        return res.status(500).json({
          success: false,
          error:
            "ELEVENLABS_API_KEY is missing",
        });
      }

      const voiceMap = {
        Female:
          process.env.ELEVENLABS_FEMALE_VOICE_ID,

        Male:
          process.env.ELEVENLABS_MALE_VOICE_ID,

        "Deep Male":
          process.env.ELEVENLABS_DEEP_MALE_VOICE_ID,

        Professional:
          process.env.ELEVENLABS_PROFESSIONAL_VOICE_ID,

        Storyteller:
          process.env.ELEVENLABS_STORYTELLER_VOICE_ID,
      };

      const voiceId =
        voiceMap[voice] ||
        process.env.ELEVENLABS_VOICE_ID;

      if (!voiceId) {
        return res.status(500).json({
          success: false,
          error:
            "ElevenLabs voice ID is missing",
        });
      }

      const response =
        await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
          {
            method: "POST",

            headers: {
              "xi-api-key": apiKey,
              "Content-Type":
                "application/json",
              Accept:
                "audio/mpeg",
            },

            body: JSON.stringify({
              text,

              model_id:
                "eleven_multilingual_v2",

              voice_settings: {
                stability: 0.5,
                similarity_boost: 0.75,
                style: 0.3,
                use_speaker_boost: true,
              },
            }),
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

      const destination =
        path.join(
          AUDIO_DIR,
          filename
        );

      fs.writeFileSync(
        destination,
        buffer
      );

      const audioUrl =
        `${BASE_URL}/uploads/audio/${filename}`;

      res.json({
        success: true,

        audioUrl,

        url: audioUrl,

        audio: audioUrl,
      });

    } catch (error) {
      console.error(
        "Voice generation error:",
        error
      );

      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
);

// ====================================================
// ANIMATION POSITION
// ====================================================

function getAnimationExpression(
  animation,
  duration
) {
  const d =
    Math.max(
      Number(duration) || 5,
      1
    );

  switch (
    String(animation || "idle").toLowerCase()
  ) {

    case "jumping":

      return {
        x:
          "main_w-overlay_w-120",

        y:
          `main_h-overlay_h-90-180*abs(sin(PI*t/${d}))`,
      };

    case "walking":

      return {
        x:
          `-overlay_w+(main_w+overlay_w)*(t/${d})`,

        y:
          "main_h-overlay_h-90",
      };

    case "talking":

      return {
        x:
          "main_w-overlay_w-120",

        y:
          `main_h-overlay_h-90-10*abs(sin(8*t))`,
      };

    case "breathing":

      return {
        x:
          "main_w-overlay_w-120",

        y:
          `main_h-overlay_h-90-6*abs(sin(2*t))`,
      };

    case "attacking":

      return {
        x:
          `main_w-overlay_w-120-100*abs(sin(PI*t/${d}))`,

        y:
          `main_h-overlay_h-90-20*abs(sin(PI*t/${d}))`,
      };

    case "idle":

    default:

      return {
        x:
          "main_w-overlay_w-120",

        y:
          `main_h-overlay_h-90-4*abs(sin(2*t))`,
      };
  }
}

// ====================================================
// STRONG STATIC IMAGE ANIMATION
// FALLBACK WHEN CHARACTER IS NOT SEPARATED
// ====================================================

function getCameraExpression(
  animationIndex,
  duration
) {
  const d =
    Math.max(
      Number(duration) || 5,
      1
    );

  const index =
    Number(animationIndex || 0) % 7;

  const animations = [

    {
      zoom:
        `1+0.10*t/${d}`,
      x:
        "iw/2-(iw/zoom/2)",
      y:
        "ih/2-(ih/zoom/2)",
    },

    {
      zoom:
        `1+0.12*t/${d}`,
      x:
        "0",
      y:
        "ih/2-(ih/zoom/2)",
    },

    {
      zoom:
        `1+0.12*t/${d}`,
      x:
        "iw-iw/zoom",
      y:
        "ih/2-(ih/zoom/2)",
    },

    {
      zoom:
        `1+0.12*t/${d}`,
      x:
        "iw/2-(iw/zoom/2)",
      y:
        "0",
    },

    {
      zoom:
        `1+0.12*t/${d}`,
      x:
        "iw/2-(iw/zoom/2)",
      y:
        "ih-ih/zoom",
    },

    {
      zoom:
        `1+0.10*t/${d}`,
      x:
        "iw-iw/zoom",
      y:
        "ih-ih/zoom",
    },

    {
      zoom:
        `1+0.10*t/${d}`,
      x:
        "0",
      y:
        "0",
    },
  ];

  return animations[index];
}

// ====================================================
// RENDER SEPARATED CHARACTER SCENE
// ====================================================

async function renderCharacterScene({
  backgroundPath,
  characterPath,
  audioPath,
  outputPath,
  duration,
  animation,
}) {
  return new Promise(
    (resolve, reject) => {

      const durationNumber =
        Math.max(
          Number(duration) || 5,
          1
        );

      const position =
        getAnimationExpression(
          animation,
          durationNumber
        );

      console.log(
        "Character animation:",
        animation
      );

      console.log(
        "Character position:",
        position
      );

      let command =
        ffmpeg();

      // Background
      command = command
        .input(backgroundPath)
        .inputOptions([
          "-loop",
          "1",
        ]);

      // Character
      command = command
        .input(characterPath)
        .inputOptions([
          "-loop",
          "1",
        ]);

      // Audio
      if (audioPath) {
        command = command
          .input(audioPath);
      }

      const filters = [];

      filters.push(
        `[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,format=rgba[bg]`
      );

      filters.push(
        `[1:v]scale=420:-1:force_original_aspect_ratio=decrease,format=rgba[char]`
      );

      filters.push(
        `[bg][char]overlay=x='${position.x}':y='${position.y}':eval=frame:format=auto,format=yuv420p[outv]`
      );

      command =
        command
          .complexFilter(
            filters
          )
          .outputOptions([
            "-map",
            "[outv]",

            ...(audioPath
              ? [
                  "-map",
                  "2:a:0",
                ]
              : []),

            "-c:v",
            "libx264",

            "-preset",
            "ultrafast",

            "-crf",
            "23",

            "-pix_fmt",
            "yuv420p",

            "-r",
            "24",

            "-threads",
            "1",

            ...(audioPath
              ? [
                  "-c:a",
                  "aac",
                  "-b:a",
                  "128k",
                  "-ar",
                  "44100",
                ]
              : []),

            "-t",
            String(durationNumber),

            "-movflags",
            "+faststart",
          ])
          .on(
            "start",
            (cmd) => {
              console.log(
                "Character FFmpeg:",
                cmd
              );
            }
          )
          .on(
            "progress",
            (progress) => {
              console.log(
                "Character progress:",
                Math.min(
                  100,
                  Math.max(
                    0,
                    Number(
                      progress.percent || 0
                    )
                  )
                ).toFixed(1) + "%"
              );
            }
          )
          .on(
            "stderr",
            (line) => {
              if (
                line.includes("error") ||
                line.includes("Error")
              ) {
                console.log(
                  "Character FFmpeg:",
                  line
                );
              }
            }
          )
          .on(
            "error",
            (error) => {
              console.error(
                "Character render error:",
                error
              );

              reject(error);
            }
          )
          .on(
            "end",
            () => {
              console.log(
                "Character scene completed:",
                outputPath
              );

              resolve(outputPath);
            }
          )
          .save(outputPath);
    }
  );
}

// ====================================================
// FALLBACK SCENE
// ====================================================

async function renderStaticScene({
  imagePath,
  audioPath,
  outputPath,
  duration,
  animationIndex,
}) {
  return new Promise(
    (resolve, reject) => {

      const durationNumber =
        Math.max(
          Number(duration) || 5,
          1
        );

      const camera =
        getCameraExpression(
          animationIndex,
          durationNumber
        );

      let command =
        ffmpeg()
          .input(imagePath)
          .inputOptions([
            "-loop",
            "1",
          ]);

      if (audioPath) {
        command =
          command.input(audioPath);
      }

      const filters = [

        `[0:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,zoompan=z='${camera.zoom}':x='${camera.x}':y='${camera.y}':d=1:s=1280x720:fps=24,format=yuv420p[outv]`,
      ];

      command =
        command
          .complexFilter(filters)
          .outputOptions([
            "-map",
            "[outv]",

            ...(audioPath
              ? [
                  "-map",
                  "1:a:0",
                ]
              : []),

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

            "-threads",
            "1",

            ...(audioPath
              ? [
                  "-c:a",
                  "aac",
                  "-b:a",
                  "128k",
                  "-ar",
                  "44100",
                ]
              : []),

            "-t",
            String(durationNumber),

            "-movflags",
            "+faststart",
          ])
          .on(
            "start",
            (cmd) => {
              console.log(
                "Static FFmpeg:",
                cmd
              );
            }
          )
          .on(
            "error",
            (error) => {
              console.error(
                "Static scene error:",
                error
              );

              reject(error);
            }
          )
          .on(
            "end",
            () => {
              resolve(outputPath);
            }
          )
          .save(outputPath);
    }
  );
}

// ====================================================
// GENERATE SCENE VIDEO
// ====================================================

app.post(
  "/api/generate-scene-video",
  async (req, res) => {

    const tempFiles = [];

    try {

      const {
        imageUrl,
        audioUrl,
        backgroundUrl,
        characterUrl,
        animation = "idle",
        duration = 5,
        animationIndex = 0,
      } = req.body;

      if (
        !imageUrl &&
        !(
          backgroundUrl &&
          characterUrl
        )
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Scene requires imageUrl or backgroundUrl + characterUrl",
        });
      }

      const sceneId =
        uuidv4();

      const outputPath =
        path.join(
          VIDEOS_DIR,
          `scene_${sceneId}.mp4`
        );

      let audioPath = null;

      if (audioUrl) {
        audioPath =
          await downloadMedia(
            audioUrl,
            TEMP_DIR,
            "audio"
          );

        tempFiles.push(
          audioPath
        );
      }

      // ============================================
      // TRUE CHARACTER ANIMATION
      // ============================================

      if (
        backgroundUrl &&
        characterUrl
      ) {

        const backgroundPath =
          await downloadMedia(
            backgroundUrl,
            TEMP_DIR,
            "background"
          );

        const characterPath =
          await downloadMedia(
            characterUrl,
            TEMP_DIR,
            "character"
          );

        tempFiles.push(
          backgroundPath,
          characterPath
        );

        await renderCharacterScene({
          backgroundPath,
          characterPath,
          audioPath,
          outputPath,
          duration,
          animation,
        });

      } else {

        // ==========================================
        // FALLBACK
        // ==========================================

        const imagePath =
          await downloadMedia(
            imageUrl,
            TEMP_DIR,
            "scene"
          );

        tempFiles.push(
          imagePath
        );

        await renderStaticScene({
          imagePath,
          audioPath,
          outputPath,
          duration,
          animationIndex,
        });
      }

      const videoUrl =
        `${BASE_URL}/uploads/videos/${path.basename(outputPath)}`;

      console.log(
        "Scene video:",
        videoUrl
      );

      res.json({
        success: true,
        videoUrl,
        url: videoUrl,
      });

    } catch (error) {

      console.error(
        "Generate scene video error:",
        error
      );

      res.status(500).json({
        success: false,
        error: error.message,
      });

    } finally {

      for (
        const file of tempFiles
      ) {
        safeUnlink(file);
      }
    }
  }
);

// ====================================================
// GENERATE FINAL VIDEO
// ====================================================

app.post(
  "/api/generate-final-video",
  async (req, res) => {

    const tempFiles = [];
    const sceneVideos = [];

    try {

      const {
        scenes,
      } = req.body;

      if (
        !Array.isArray(scenes) ||
        scenes.length === 0
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Scenes array is required",
        });
      }

      console.log(
        `Generating final video with ${scenes.length} scenes`
      );

      // --------------------------------------------
      // Render every scene
      // --------------------------------------------

      for (
        let i = 0;
        i < scenes.length;
        i++
      ) {

        const scene =
          scenes[i];

        console.log(
          `Rendering scene ${i + 1}/${scenes.length}`
        );

        const sceneId =
          uuidv4();

        const sceneOutput =
          path.join(
            VIDEOS_DIR,
            `scene_${sceneId}.mp4`
          );

        let audioPath = null;

        if (
          scene.audioUrl
        ) {

          audioPath =
            await downloadMedia(
              scene.audioUrl,
              TEMP_DIR,
              `scene_audio_${i}`
            );

          tempFiles.push(
            audioPath
          );
        }

        // ------------------------------------------
        // TRUE CHARACTER ANIMATION
        // ------------------------------------------

        if (
          scene.backgroundUrl &&
          scene.characterUrl
        ) {

          console.log(
            `Scene ${i + 1}: TRUE CHARACTER ANIMATION`
          );

          console.log(
            "Background:",
            scene.backgroundUrl
          );

          console.log(
            "Character:",
            scene.characterUrl
          );

          console.log(
            "Animation:",
            scene.animation
          );

          const backgroundPath =
            await downloadMedia(
              scene.backgroundUrl,
              TEMP_DIR,
              `background_${i}`
            );

          const characterPath =
            await downloadMedia(
              scene.characterUrl,
              TEMP_DIR,
              `character_${i}`
            );

          tempFiles.push(
            backgroundPath,
            characterPath
          );

          await renderCharacterScene({
            backgroundPath,
            characterPath,
            audioPath,
            outputPath:
              sceneOutput,
            duration:
              scene.duration || 5,
            animation:
              scene.animation || "idle",
          });

        } else {

          // ----------------------------------------
          // FALLBACK STATIC IMAGE
          // ----------------------------------------

          if (!scene.imageUrl) {
            throw new Error(
              `Scene ${i + 1} has no image`
            );
          }

          console.log(
            `Scene ${i + 1}: fallback image animation`
          );

          const imagePath =
            await downloadMedia(
              scene.imageUrl,
              TEMP_DIR,
              `scene_image_${i}`
            );

          tempFiles.push(
            imagePath
          );

          await renderStaticScene({
            imagePath,
            audioPath,
            outputPath:
              sceneOutput,
            duration:
              scene.duration || 5,
            animationIndex:
              i,
          });
        }

        if (
          !fs.existsSync(sceneOutput)
        ) {
          throw new Error(
            `Scene ${i + 1} video was not created`
          );
        }

        sceneVideos.push(
          sceneOutput
        );

        console.log(
          `Scene ${i + 1} completed`
        );
      }

      // --------------------------------------------
      // CONCAT
      // --------------------------------------------

      const concatFile =
        path.join(
          TEMP_DIR,
          `concat_${uuidv4()}.txt`
        );

      tempFiles.push(
        concatFile
      );

      const concatContent =
        sceneVideos
          .map(
            (file) =>
              `file '${file.replace(/'/g, "'\\''")}'`
          )
          .join("\n");

      fs.writeFileSync(
        concatFile,
        concatContent
      );

      const finalFilename =
        `video_${uuidv4()}.mp4`;

      const finalPath =
        path.join(
          VIDEOS_DIR,
          finalFilename
        );

      await new Promise(
        (resolve, reject) => {

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
              (cmd) => {
                console.log(
                  "Concat FFmpeg:",
                  cmd
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
              (error) => {
                console.error(
                  "Concat error:",
                  error
                );

                reject(error);
              }
            )
            .on(
              "end",
              () => {
                resolve();
              }
            )
            .save(finalPath);
        }
      );

      if (
        !fs.existsSync(finalPath)
      ) {
        throw new Error(
          "Final video was not created"
        );
      }

      const finalUrl =
        `${BASE_URL}/uploads/videos/${finalFilename}`;

      console.log(
        "FINAL VIDEO:",
        finalUrl
      );

      res.json({
        success: true,

        videoUrl:
          finalUrl,

        url:
          finalUrl,

        finalVideo:
          finalUrl,
      });

    } catch (error) {

      console.error(
        "FINAL VIDEO ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        error: error.message,
      });

    } finally {

      for (
        const file of tempFiles
      ) {
        safeUnlink(file);
      }

      for (
        const file of sceneVideos
      ) {
        safeUnlink(file);
      }
    }
  }
);

// ====================================================
// ALIAS
// ====================================================

app.post(
  "/api/generate-video",
  async (req, res) => {

    req.url =
      "/api/generate-final-video";

    return app._router.handle(
      req,
      res
    );
  }
);

// ====================================================
// ERROR HANDLER
// ====================================================

app.use(
  (error, req, res, next) => {

    console.error(
      "SERVER ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      error:
        error.message ||
        "Internal server error",
    });
  }
);

// ====================================================
// START
// ====================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "===================================="
    );

    console.log(
      "AI VIDEO SERVER STARTED"
    );

    console.log(
      "===================================="
    );

    console.log(
      "PORT:",
      PORT
    );

    console.log(
      "BASE URL:",
      BASE_URL
    );

    console.log(
      "FFmpeg:",
      ffmpegStatic
    );

    console.log(
      "FFprobe:",
      ffprobeStatic?.path
    );

    console.log(
      "Uploads:",
      UPLOADS_DIR
    );

    console.log(
      "===================================="
    );
  }
);