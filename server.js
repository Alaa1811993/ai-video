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

const PORT = process.env.PORT || 3000;

const SERVER_URL =
  process.env.SERVER_URL ||
  "https://ai-video.bonto.run";

const ELEVENLABS_API_KEY =
  process.env.ELEVENLABS_API_KEY;

const ELEVENLABS_VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID ||
  "21m00Tcm4TlvDq8ikWAM";

const ELEVENLABS_MODEL =
  process.env.ELEVENLABS_MODEL ||
  "eleven_multilingual_v2";

// ============================================================
// FFMPEG
// ============================================================

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

if (ffprobeStatic && ffprobeStatic.path) {
  ffmpeg.setFfprobePath(ffprobeStatic.path);
}

console.log("========================================");
console.log("AI VIDEO STUDIO SERVER");
console.log("========================================");
console.log("FFmpeg:", ffmpegStatic);
console.log(
  "FFmpeg exists:",
  ffmpegStatic
    ? fs.existsSync(ffmpegStatic)
    : false
);
console.log("FFprobe:", ffprobeStatic?.path);
console.log(
  "FFprobe exists:",
  ffprobeStatic?.path
    ? fs.existsSync(ffprobeStatic.path)
    : false
);
console.log("Server URL:", SERVER_URL);
console.log("========================================");

// ============================================================
// DIRECTORIES
// ============================================================

const uploadsDir =
  path.join(__dirname, "uploads");

const imagesDir =
  path.join(uploadsDir, "images");

const audioDir =
  path.join(uploadsDir, "audio");

const videosDir =
  path.join(uploadsDir, "videos");

const tempDir =
  path.join(uploadsDir, "temp");

[
  uploadsDir,
  imagesDir,
  audioDir,
  videosDir,
  tempDir,
].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, {
      recursive: true,
    });
  }
});

// ============================================================
// EXPRESS
// ============================================================

app.use(
  cors({
    origin: function (origin, callback) {
      const allowedOrigins = [
        "https://ai-video-studio-542c9.web.app",
        "https://ai-video-studio-542c9.firebaseapp.com",

        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:5175",
      ];

      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.log(
        "CORS request from:",
        origin
      );

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

// ============================================================
// STATIC FILES
// ============================================================

app.use(
  "/uploads",
  express.static(uploadsDir, {
    maxAge: "1h",
  })
);

// ============================================================
// MULTER
// ============================================================

const storage =
  multer.diskStorage({
    destination: function (
      req,
      file,
      cb
    ) {
      const folder =
        file.mimetype.startsWith("image/")
          ? imagesDir
          : file.mimetype.startsWith("audio/")
          ? audioDir
          : videosDir;

      cb(null, folder);
    },

    filename: function (
      req,
      file,
      cb
    ) {
      const extension =
        path.extname(
          file.originalname ||
            ".bin"
        );

      cb(
        null,
        `${uuidv4()}${extension}`
      );
    },
  });

const upload =
  multer({
    storage,

    limits: {
      fileSize:
        200 * 1024 * 1024,
    },
  });

// ============================================================
// HELPERS
// ============================================================

function safeUnlink(filePath) {
  try {
    if (
      filePath &&
      fs.existsSync(filePath)
    ) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.log(
      "Cleanup error:",
      error.message
    );
  }
}

function parseDuration(
  value,
  fallback = 5
) {
  const number =
    Number(value);

  if (
    !Number.isFinite(number) ||
    number <= 0
  ) {
    return fallback;
  }

  return Math.min(
    number,
    60
  );
}

function getPublicUrl(
  folder,
  filename
) {
  return `${SERVER_URL}/uploads/${folder}/${filename}`;
}

function getExtensionFromUrl(
  url,
  fallback = ".bin"
) {
  try {
    const pathname =
      new URL(url).pathname;

    const ext =
      path.extname(pathname);

    if (ext) {
      return ext;
    }
  } catch (error) {}

  return fallback;
}

function downloadFile(
  url,
  destination
) {
  return new Promise(
    (resolve, reject) => {
      if (!url) {
        return reject(
          new Error(
            "Missing download URL"
          )
        );
      }

      const protocol =
        url.startsWith("https://")
          ? https
          : http;

      const request =
        protocol.get(
          url,
          {
            timeout: 120000,
          },
          (response) => {
            if (
              response.statusCode >=
                300 &&
              response.statusCode <
                400 &&
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
              response.statusCode !==
              200
            ) {
              response.resume();

              return reject(
                new Error(
                  `Download failed with HTTP ${response.statusCode}: ${url}`
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
                file.close(
                  () =>
                    resolve(
                      destination
                    )
                );
              }
            );

            file.on(
              "error",
              (error) => {
                safeUnlink(
                  destination
                );

                reject(error);
              }
            );
          }
        );

      request.on(
        "timeout",
        () => {
          request.destroy(
            new Error(
              `Download timeout: ${url}`
            )
          );
        }
      );

      request.on(
        "error",
        reject
      );
    }
  );
}

function secondsFromTimemark(
  timemark
) {
  if (!timemark) {
    return 0;
  }

  const parts =
    String(timemark).split(":");

  if (parts.length !== 3) {
    return 0;
  }

  const hours =
    Number(parts[0]) || 0;

  const minutes =
    Number(parts[1]) || 0;

  const seconds =
    Number(parts[2]) || 0;

  return (
    hours * 3600 +
    minutes * 60 +
    seconds
  );
}

function calculateProgress(
  timemark,
  duration
) {
  const seconds =
    secondsFromTimemark(
      timemark
    );

  if (
    !duration ||
    duration <= 0
  ) {
    return 0;
  }

  return Math.min(
    100,
    Math.max(
      0,
      Math.round(
        (seconds / duration) *
          100
      )
    )
  );
}

function probeVideo(
  filePath
) {
  return new Promise(
    (resolve, reject) => {
      ffmpeg.ffprobe(
        filePath,
        (error, data) => {
          if (error) {
            return reject(error);
          }

          resolve(data);
        }
      );
    }
  );
}

// ============================================================
// CHARACTER DETECTION
// ============================================================

function hasCharacterAnimation(
  scene
) {
  if (!scene) {
    return false;
  }

  const animation =
    String(
      scene.animation ||
        scene.animationType ||
        ""
    ).toLowerCase();

  const hasCharacterParts =
    Boolean(
      scene.bodyUrl ||
        scene.characterUrl ||
        scene.headUrl ||
        scene.leftArmUrl ||
        scene.rightArmUrl ||
        scene.leftLegUrl ||
        scene.rightLegUrl
    );

  return Boolean(
    animation &&
      hasCharacterParts
  );
}

// ============================================================
// HEALTH
// ============================================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message:
      "AI Video Studio Server is running",

    server:
      SERVER_URL,

    characterAnimation:
      true,

    timestamp:
      new Date().toISOString(),
  });
});

app.get(
  "/api/test",
  (req, res) => {
    res.json({
      success: true,

      message:
        "AI Video API is working",

      server:
        SERVER_URL,

      characterAnimation:
        true,
    });
  }
);

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      success: true,

      status:
        "healthy",

      server:
        SERVER_URL,

      ffmpeg:
        Boolean(ffmpegStatic),

      ffprobe:
        Boolean(
          ffprobeStatic?.path
        ),

      elevenlabs:
        Boolean(
          ELEVENLABS_API_KEY
        ),

      characterAnimation:
        true,
    });
  }
);

// ============================================================
// GENERATE IMAGE
// ============================================================

app.post(
  "/api/generate-image",
  async (req, res) => {
    try {
      const {
        prompt,
      } = req.body;

      if (!prompt) {
        return res.status(400).json({
          success: false,
          error:
            "Prompt is required",
        });
      }

      console.log(
        "========================================"
      );

      console.log(
        "IMAGE GENERATION STARTED"
      );

      console.log(
        "Prompt:",
        prompt
      );

      console.log(
        "========================================"
      );

      const encodedPrompt =
        encodeURIComponent(
          prompt
        );

      const imageUrl =
        `https://image.pollinations.ai/prompt/${encodedPrompt}` +
        `?width=1280&height=720&model=flux&nologo=true`;

      const filename =
        `image_${uuidv4()}.jpg`;

      const outputPath =
        path.join(
          imagesDir,
          filename
        );

      await downloadFile(
        imageUrl,
        outputPath
      );

      const finalUrl =
        getPublicUrl(
          "images",
          filename
        );

      console.log(
        "Image generated:",
        finalUrl
      );

      res.json({
        success: true,

        imageUrl:
          finalUrl,

        url:
          finalUrl,
      });
    } catch (error) {
      console.error(
        "Image generation error:",
        error
      );

      res.status(500).json({
        success: false,

        error:
          error.message,
      });
    }
  }
);

// ============================================================
// ELEVENLABS VOICE
// ============================================================

app.post(
  "/api/generate-voice",
  async (req, res) => {
    try {
      const {
        text,
        voiceId,
        modelId,
      } = req.body;

      if (!text) {
        return res.status(400).json({
          success: false,

          error:
            "Text is required",
        });
      }

      if (
        !ELEVENLABS_API_KEY
      ) {
        return res.status(500).json({
          success: false,

          error:
            "ElevenLabs API key is not configured",
        });
      }

      const selectedVoice =
        voiceId ||
        ELEVENLABS_VOICE_ID;

      const selectedModel =
        modelId ||
        ELEVENLABS_MODEL;

      console.log(
        "========================================"
      );

      console.log(
        "VOICE GENERATION STARTED"
      );

      console.log(
        "Voice:",
        selectedVoice
      );

      console.log(
        "Model:",
        selectedModel
      );

      console.log(
        "========================================"
      );

      const url =
        `https://api.elevenlabs.io/v1/text-to-speech/${selectedVoice}`;

      const response =
        await fetch(
          url,
          {
            method:
              "POST",

            headers: {
              Accept:
                "audio/mpeg",

              "Content-Type":
                "application/json",

              "xi-api-key":
                ELEVENLABS_API_KEY,
            },

            body:
              JSON.stringify({
                text,

                model_id:
                  selectedModel,

                voice_settings: {
                  stability:
                    0.5,

                  similarity_boost:
                    0.75,

                  style:
                    0.2,

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
              `ElevenLabs HTTP ${response.status}`,

            details:
              errorText,
          });
      }

      const buffer =
        Buffer.from(
          await response.arrayBuffer()
        );

      const filename =
        `voice_${uuidv4()}.mp3`;

      const outputPath =
        path.join(
          audioDir,
          filename
        );

      fs.writeFileSync(
        outputPath,
        buffer
      );

      const audioUrl =
        getPublicUrl(
          "audio",
          filename
        );

      console.log(
        "Voice generated:",
        audioUrl
      );

      res.json({
        success: true,

        audioUrl,

        url:
          audioUrl,
      });
    } catch (error) {
      console.error(
        "Voice generation error:",
        error
      );

      res.status(500).json({
        success: false,

        error:
          error.message,
      });
    }
  }
);

// ============================================================
// CINEMATIC SCENE VIDEO
// ============================================================

function renderSceneVideo(
  imagePath,
  audioPath,
  outputPath,
  duration
) {
  return new Promise(
    (resolve, reject) => {
      console.log(
        "========================================"
      );

      console.log(
        "RENDERING CINEMATIC SCENE"
      );

      console.log(
        "Duration:",
        duration
      );

      console.log(
        "========================================"
      );

      let command =
        ffmpeg()
          .input(imagePath)
          .inputOptions([
            "-loop 1",
          ]);

      if (audioPath) {
        command =
          command.input(
            audioPath
          );
      }

      const zoomFrames =
        Math.max(
          1,
          Math.ceil(
            duration * 24
          )
        );

      const filter =
        `zoompan=` +
        `z='min(zoom+0.0008,1.12)':` +
        `x='iw/2-(iw/zoom/2)':` +
        `y='ih/2-(ih/zoom/2)':` +
        `d=${zoomFrames}:` +
        `s=1280x720:` +
        `fps=24`;

      command
        .complexFilter(
          filter
        )

        .videoCodec(
          "libx264"
        )

        .outputOptions([
          "-pix_fmt",
          "yuv420p",

          "-preset",
          "veryfast",

          "-crf",
          "23",

          "-r",
          "24",

          "-movflags",
          "+faststart",

          `-t ${duration}`,
        ]);

      if (audioPath) {
        command
          .audioCodec(
            "aac"
          )

          .audioBitrate(
            "128k"
          )

          .outputOptions([
            "-shortest",
          ]);
      }

      command
        .on(
          "start",
          (
            commandLine
          ) => {
            console.log(
              "Scene FFmpeg command:",
              commandLine
            );
          }
        )

        .on(
          "progress",
          (
            progress
          ) => {
            const percent =
              calculateProgress(
                progress.timemark,
                duration
              );

            console.log(
              `Scene progress: ${percent}%`
            );
          }
        )

        .on(
          "stderr",
          (line) => {
            if (
              line &&
              line.trim()
            ) {
              console.log(
                "Scene FFmpeg:",
                line
              );
            }
          }
        )

        .on(
          "end",
          () => {
            console.log(
              "Scene FFmpeg finished."
            );

            resolve(
              outputPath
            );
          }
        )

        .on(
          "error",
          (error) => {
            console.error(
              "Scene FFmpeg error:",
              error
            );

            reject(error);
          }
        )

        .save(
          outputPath
        );
    }
  );
}

// ============================================================
// CHARACTER ANIMATION FILTER
// ============================================================

function buildCharacterFilter(
  layerTypes,
  animation,
  duration
) {
  const mode =
    String(
      animation || "idle"
    ).toLowerCase();

  const filters = [];

  console.log(
    "========================================"
  );

  console.log(
    "BUILDING STRONG CHARACTER ANIMATION"
  );

  console.log(
    "Animation:",
    mode
  );

  console.log(
    "Duration:",
    duration
  );

  console.log(
    "Layers:",
    layerTypes
  );

  console.log(
    "========================================"
  );

  // ==========================================================
  // BACKGROUND
  // ==========================================================

  filters.push(
    `[0:v]scale=1280:720:force_original_aspect_ratio=decrease,` +
      `pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,` +
      `setsar=1[bg]`
  );

  let previous = "bg";

  // ==========================================================
  // ESCAPE FFmpeg EXPRESSIONS
  // ==========================================================

  function clean(value) {
    return String(value)
      .replace(/'/g, "\\'");
  }

  // ==========================================================
  // CHARACTER MOTION
  // ==========================================================

  function motion(type) {

    let x = "0";
    let y = "0";
    let angle = "0";
    let scale = "1";

    // ========================================================
    // WALKING
    // ========================================================

    if (mode === "walking") {

      const f =
        "2*PI*t*1.8";

      const step =
        `sin(${f})`;

      const stepAbs =
        `abs(sin(${f}))`;

      // BODY
      if (type === "body") {

        x =
          `18*sin(${f})`;

        y =
          `-10*abs(sin(${f}))`;

        scale =
          `1+0.025*sin(${f})`;

        angle =
          `0.035*sin(${f})`;
      }

      // HEAD
      else if (type === "head") {

        x =
          `10*sin(${f}+0.25)`;

        y =
          `-18*abs(sin(${f}+0.25))`;

        angle =
          `0.08*sin(${f}+0.25)`;

        scale =
          `1+0.015*sin(${f})`;
      }

      // LEFT ARM
      else if (type === "leftArm") {

        x =
          `22*sin(${f})`;

        y =
          `10*cos(${f})`;

        angle =
          `0.65*sin(${f})`;
      }

      // RIGHT ARM
      else if (type === "rightArm") {

        x =
          `-22*sin(${f})`;

        y =
          `-10*cos(${f})`;

        angle =
          `-0.65*sin(${f})`;
      }

      // LEFT LEG
      else if (type === "leftLeg") {

        x =
          `-24*sin(${f})`;

        y =
          `12*abs(sin(${f}))`;

        angle =
          `-0.50*sin(${f})`;
      }

      // RIGHT LEG
      else if (type === "rightLeg") {

        x =
          `24*sin(${f})`;

        y =
          `12*abs(sin(${f}+PI))`;

        angle =
          `0.50*sin(${f})`;
      }
    }

    // ========================================================
    // TALKING
    // ========================================================

    else if (mode === "talking") {

      const f =
        "2*PI*t*2.2";

      if (type === "body") {

        y =
          `5*sin(${f})`;

        x =
          `3*sin(${f}*0.5)`;

        scale =
          `1+0.015*sin(${f})`;
      }

      else if (type === "head") {

        x =
          `8*sin(${f}*0.55)`;

        y =
          `5*sin(${f})`;

        angle =
          `0.10*sin(${f}*0.55)`;
      }

      else if (type === "leftArm") {

        x =
          `12*sin(${f}*0.8)`;

        y =
          `8*cos(${f}*0.8)`;

        angle =
          `0.30*sin(${f}*0.8)`;
      }

      else if (type === "rightArm") {

        x =
          `-12*sin(${f}*0.8)`;

        y =
          `-8*cos(${f}*0.8)`;

        angle =
          `-0.30*sin(${f}*0.8)`;
      }

      else if (type === "leftLeg") {

        y =
          `3*sin(${f})`;

        angle =
          `0.08*sin(${f})`;
      }

      else if (type === "rightLeg") {

        y =
          `3*sin(${f}+PI)`;

        angle =
          `-0.08*sin(${f})`;
      }
    }

    // ========================================================
    // ATTACKING
    // ========================================================

    else if (mode === "attacking") {

      const f =
        "2*PI*t*0.9";

      const strike =
        `pow(abs(sin(${f})),3)`;

      const recoil =
        `pow(abs(sin(${f}+PI)),2)`;

      if (type === "body") {

        x =
          `55*${strike}-20*${recoil}`;

        y =
          `-18*${strike}`;

        angle =
          `-0.12*${strike}`;

        scale =
          `1+0.06*${strike}`;
      }

      else if (type === "head") {

        x =
          `75*${strike}`;

        y =
          `-28*${strike}`;

        angle =
          `-0.18*${strike}`;

        scale =
          `1+0.04*${strike}`;
      }

      else if (type === "leftArm") {

        x =
          `100*${strike}`;

        y =
          `-35*${strike}`;

        angle =
          `-1.25*${strike}`;
      }

      else if (type === "rightArm") {

        x =
          `-35*${strike}`;

        y =
          `15*${strike}`;

        angle =
          `0.75*${strike}`;
      }

      else if (type === "leftLeg") {

        x =
          `30*${strike}`;

        y =
          `15*${strike}`;

        angle =
          `-0.35*${strike}`;
      }

      else if (type === "rightLeg") {

        x =
          `20*${strike}`;

        y =
          `-5*${strike}`;

        angle =
          `0.30*${strike}`;
      }
    }

    // ========================================================
    // JUMPING
    // ========================================================

    else if (mode === "jumping") {

      const f =
        "2*PI*t*0.8";

      const jump =
        `abs(sin(${f}))`;

      if (type === "body") {

        x =
          `15*sin(${f})`;

        y =
          `-100*${jump}`;

        scale =
          `1+0.05*${jump}`;
      }

      else if (type === "head") {

        x =
          `12*sin(${f})`;

        y =
          `-120*${jump}`;

        angle =
          `0.12*sin(${f})`;
      }

      else if (type === "leftArm") {

        x =
          `-25*sin(${f})`;

        y =
          `-105*${jump}`;

        angle =
          `-0.9*${jump}`;
      }

      else if (type === "rightArm") {

        x =
          `25*sin(${f})`;

        y =
          `-105*${jump}`;

        angle =
          `0.9*${jump}`;
      }

      else if (type === "leftLeg") {

        x =
          `-20*sin(${f})`;

        y =
          `-90*${jump}`;

        angle =
          `0.55*sin(${f})`;
      }

      else if (type === "rightLeg") {

        x =
          `20*sin(${f})`;

        y =
          `-90*${jump}`;

        angle =
          `-0.55*sin(${f})`;
      }
    }

    // ========================================================
    // RUNNING
    // ========================================================

    else if (mode === "running") {

      const f =
        "2*PI*t*3.0";

      const step =
        `sin(${f})`;

      const stepAbs =
        `abs(sin(${f}))`;

      if (type === "body") {

        x =
          `35*sin(${f})`;

        y =
          `-20*${stepAbs}`;

        angle =
          `0.08*sin(${f})`;

        scale =
          `1+0.04*${stepAbs}`;
      }

      else if (type === "head") {

        x =
          `20*sin(${f})`;

        y =
          `-25*${stepAbs}`;

        angle =
          `0.12*sin(${f})`;
      }

      else if (type === "leftArm") {

        x =
          `35*sin(${f})`;

        y =
          `15*cos(${f})`;

        angle =
          `0.95*sin(${f})`;
      }

      else if (type === "rightArm") {

        x =
          `-35*sin(${f})`;

        y =
          `-15*cos(${f})`;

        angle =
          `-0.95*sin(${f})`;
      }

      else if (type === "leftLeg") {

        x =
          `-35*sin(${f})`;

        y =
          `20*${stepAbs}`;

        angle =
          `-0.75*sin(${f})`;
      }

      else if (type === "rightLeg") {

        x =
          `35*sin(${f})`;

        y =
          `20*${stepAbs}`;

        angle =
          `0.75*sin(${f})`;
      }
    }

    // ========================================================
    // DANCING
    // ========================================================

    else if (mode === "dancing") {

      const f =
        "2*PI*t*1.4";

      if (type === "body") {

        x =
          `45*sin(${f})`;

        y =
          `20*cos(${f})`;

        angle =
          `0.14*sin(${f})`;

        scale =
          `1+0.06*sin(${f})`;
      }

      else if (type === "head") {

        x =
          `35*sin(${f}+0.4)`;

        y =
          `15*cos(${f})`;

        angle =
          `0.18*sin(${f})`;
      }

      else if (type === "leftArm") {

        x =
          `55*sin(${f})`;

        y =
          `-25*cos(${f})`;

        angle =
          `1.0*sin(${f})`;
      }

      else if (type === "rightArm") {

        x =
          `-55*sin(${f})`;

        y =
          `25*cos(${f})`;

        angle =
          `-1.0*sin(${f})`;
      }

      else if (type === "leftLeg") {

        x =
          `30*sin(${f})`;

        y =
          `20*cos(${f})`;

        angle =
          `0.45*sin(${f})`;
      }

      else if (type === "rightLeg") {

        x =
          `-30*sin(${f})`;

        y =
          `-20*cos(${f})`;

        angle =
          `-0.45*sin(${f})`;
      }
    }

    // ========================================================
    // BREATHING
    // ========================================================

    else if (mode === "breathing") {

      const f =
        "2*PI*t*0.8";

      if (type === "body") {

        y =
          `5*sin(${f})`;

        scale =
          `1+0.04*sin(${f})`;
      }

      else if (type === "head") {

        y =
          `-5*sin(${f})`;

        angle =
          `0.04*sin(${f})`;
      }

      else if (type === "leftArm") {

        y =
          `4*sin(${f})`;

        angle =
          `0.10*sin(${f})`;
      }

      else if (type === "rightArm") {

        y =
          `4*sin(${f})`;

        angle =
          `-0.10*sin(${f})`;
      }
    }

    // ========================================================
    // IDLE
    // ========================================================

    else {

      const f =
        "2*PI*t*0.75";

      if (type === "body") {

        y =
          `5*sin(${f})`;

        x =
          `3*sin(${f})`;

        scale =
          `1+0.025*sin(${f})`;
      }

      else if (type === "head") {

        y =
          `-8*sin(${f})`;

        x =
          `6*sin(${f}*0.8)`;

        angle =
          `0.08*sin(${f}*0.8)`;
      }

      else if (type === "leftArm") {

        y =
          `5*sin(${f})`;

        x =
          `8*sin(${f})`;

        angle =
          `0.18*sin(${f})`;
      }

      else if (type === "rightArm") {

        y =
          `5*sin(${f})`;

        x =
          `-8*sin(${f})`;

        angle =
          `-0.18*sin(${f})`;
      }

      else if (type === "leftLeg") {

        y =
          `3*sin(${f})`;

        angle =
          `0.08*sin(${f})`;
      }

      else if (type === "rightLeg") {

        y =
          `3*sin(${f}+PI)`;

        angle =
          `-0.08*sin(${f})`;
      }
    }

    return {
      x: clean(x),
      y: clean(y),
      angle: clean(angle),
      scale: clean(scale),
    };
  }

  // ==========================================================
  // BUILD CHARACTER LAYERS
  // ==========================================================

  for (
    let i = 1;
    i < layerTypes.length;
    i++
  ) {

    const type =
      layerTypes[i];

    if (!type) {
      continue;
    }

    const motionData =
      motion(type);

    const layer =
      `layer_${i}`;

    // --------------------------------------------------------
    // SCALE + ROTATE + MOVE
    // --------------------------------------------------------

    filters.push(
      `[${i}:v]` +
        `format=rgba,` +

        `scale=` +
        `iw*(${motionData.scale})` +
        `:` +
        `ih*(${motionData.scale})` +
        `:eval=frame,` +

        `rotate=` +
        `'${motionData.angle}'` +
        `:` +
        `ow=iw` +
        `:` +
        `oh=ih` +
        `:` +
        `fillcolor=0x00000000` +
        `:cubic=1` +

        `[${layer}]`
    );

    // --------------------------------------------------------
    // MOVE CHARACTER PART
    // --------------------------------------------------------

    filters.push(
      `[${previous}][${layer}]` +
        `overlay=` +
        `x='` +
        `(W-w)/2+${motionData.x}` +
        `'` +
        `:` +
        `y='` +
        `(H-h)/2+${motionData.y}` +
        `'` +
        `:eval=frame` +
        `[composite_${i}]`
    );

    previous =
      `composite_${i}`;
  }

  // ==========================================================
  // FINAL VIDEO
  // ==========================================================

  filters.push(
    `[${previous}]` +
      `format=yuv420p,` +
      `fps=24` +
      `[final]`
  );

  return filters.join(";");
}

// ============================================================
// CHARACTER ANIMATION RENDERER
// ============================================================

async function renderCharacterVideo(
  scene,
  outputPath
) {
  const tempFiles = [];

  try {
    const duration =
      parseDuration(
        scene.duration,
        5
      );

    const animation =
      String(
        scene.animation ||
          scene.animationType ||
          "idle"
      ).toLowerCase();

    console.log(
      "========================================"
    );

    console.log(
      "CHARACTER ANIMATION STARTED"
    );

    console.log(
      "Animation:",
      animation
    );

    console.log(
      "Duration:",
      duration
    );

    console.log(
      "========================================"
    );

    // ========================================================
    // VALIDATION
    // ========================================================

    if (
      !scene.backgroundUrl
    ) {
      throw new Error(
        "Character animation requires backgroundUrl"
      );
    }

    const bodyUrl =
      scene.bodyUrl ||
      scene.characterUrl;

    if (!bodyUrl) {
      throw new Error(
        "Character animation requires bodyUrl or characterUrl"
      );
    }

    // ========================================================
    // FIXED SEMANTIC LAYERS
    // ========================================================
    //
    // IMPORTANT:
    //
    // We do NOT use:
    //
    // .filter(Boolean)
    //
    // because that changes the index of the remaining
    // layers and can make a head receive arm animation.
    //
    // ========================================================

    const layerDefinitions = [
      {
        type:
          "background",

        url:
          scene.backgroundUrl,
      },

      {
        type:
          "body",

        url:
          bodyUrl,
      },

      {
        type:
          "head",

        url:
          scene.headUrl,
      },

      {
        type:
          "leftArm",

        url:
          scene.leftArmUrl,
      },

      {
        type:
          "rightArm",

        url:
          scene.rightArmUrl,
      },

      {
        type:
          "leftLeg",

        url:
          scene.leftLegUrl,
      },

      {
        type:
          "rightLeg",

        url:
          scene.rightLegUrl,
      },
    ];

    const inputPaths = [];

    const layerTypes = [];

    // ========================================================
    // DOWNLOAD LAYERS
    // ========================================================

    for (
      const layer of
        layerDefinitions
    ) {
      if (!layer.url) {
        continue;
      }

      const ext =
        getExtensionFromUrl(
          layer.url,
          ".png"
        );

      const filename =
        `character_${layer.type}_${uuidv4()}${ext}`;

      const filePath =
        path.join(
          tempDir,
          filename
        );

      console.log(
        `Character layer: ${layer.type}`
      );

      console.log(
        `Character URL: ${layer.url}`
      );

      await downloadFile(
        layer.url,
        filePath
      );

      inputPaths.push(
        filePath
      );

      layerTypes.push(
        layer.type
      );

      tempFiles.push(
        filePath
      );
    }

    console.log(
      "Character input types:",
      layerTypes
    );

    if (
      inputPaths.length <
      2
    ) {
      throw new Error(
        "At least background and body layers are required"
      );
    }

    // ========================================================
    // AUDIO
    // ========================================================

    let audioPath =
      null;

    if (
      scene.audioUrl ||
      scene.voiceUrl
    ) {
      const audioUrl =
        scene.audioUrl ||
        scene.voiceUrl;

      const audioFile =
        path.join(
          tempDir,
          `character_audio_${uuidv4()}.mp3`
        );

      console.log(
        "Downloading character audio:",
        audioUrl
      );

      await downloadFile(
        audioUrl,
        audioFile
      );

      audioPath =
        audioFile;

      tempFiles.push(
        audioFile
      );
    }

    // ========================================================
    // FFMPEG INPUTS
    // ========================================================

    let command =
      ffmpeg();

    inputPaths.forEach(
      (filePath) => {
        command =
          command
            .input(filePath)
            .inputOptions([
              "-loop 1",
            ]);
      }
    );

    if (audioPath) {
      command =
        command.input(
          audioPath
        );
    }

    // ========================================================
    // FILTER
    // ========================================================

    const filter =
      buildCharacterFilter(
        layerTypes,
        animation,
        duration
      );

    console.log(
      "Character filter:",
      filter
    );

    // ========================================================
    // VIDEO
    // ========================================================

    command =
      command
        .complexFilter(
          filter,
          "final"
        )

        .videoCodec(
          "libx264"
        )

        .outputOptions([
          "-pix_fmt",
          "yuv420p",

          "-preset",
          "ultrafast",

          "-crf",
          "26",

          "-r",
          "24",

          "-t",
          String(
            duration
          ),

          "-movflags",
          "+faststart",
        ]);

    // ========================================================
    // AUDIO
    // ========================================================

    if (audioPath) {
      command =
        command
          .audioCodec(
            "aac"
          )

          .audioBitrate(
            "128k"
          )

          .outputOptions([
            "-af",
            "apad",

            "-t",
            String(
              duration
            ),
          ]);
    }

    // ========================================================
    // RUN FFMPEG
    // ========================================================

    await new Promise(
      (
        resolve,
        reject
      ) => {
        command

          .on(
            "start",
            (
              commandLine
            ) => {
              console.log(
                "Character FFmpeg:",
                commandLine
              );
            }
          )

          .on(
            "progress",
            (
              progress
            ) => {
              const percent =
                calculateProgress(
                  progress.timemark,
                  duration
                );

              console.log(
                `Character progress: ${percent}%`
              );
            }
          )

          .on(
            "stderr",
            (line) => {
              if (
                line &&
                line.trim()
              ) {
                console.log(
                  "Character FFmpeg:",
                  line
                );
              }
            }
          )

          .on(
            "end",
            () => {
              console.log(
                "CHARACTER ANIMATION COMPLETED"
              );

              resolve();
            }
          )

          .on(
            "error",
            (error) => {
              console.error(
                "Character FFmpeg error:",
                error
              );

              reject(error);
            }
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
        "Character video was not created"
      );
    }

    const stats =
      fs.statSync(
        outputPath
      );

    console.log(
      "Character video size:",
      stats.size
    );

    return outputPath;
  } finally {
    tempFiles.forEach(
      safeUnlink
    );
  }
}

// ============================================================
// GENERATE SCENE VIDEO
// ============================================================

app.post(
  "/api/generate-scene-video",
  async (
    req,
    res
  ) => {
    const tempFiles = [];

    try {
      const {
        imageUrl,
        audioUrl,
        duration,
      } = req.body;

      if (!imageUrl) {
        return res.status(400).json({
          success: false,

          error:
            "imageUrl is required",
        });
      }

      const sceneDuration =
        parseDuration(
          duration,
          5
        );

      const imagePath =
        path.join(
          tempDir,
          `scene_image_${uuidv4()}${getExtensionFromUrl(
            imageUrl,
            ".jpg"
          )}`
        );

      tempFiles.push(
        imagePath
      );

      await downloadFile(
        imageUrl,
        imagePath
      );

      let audioPath =
        null;

      if (audioUrl) {
        audioPath =
          path.join(
            tempDir,
            `scene_audio_${uuidv4()}.mp3`
          );

        tempFiles.push(
          audioPath
        );

        await downloadFile(
          audioUrl,
          audioPath
        );
      }

      const filename =
        `scene_${uuidv4()}.mp4`;

      const outputPath =
        path.join(
          videosDir,
          filename
        );

      await renderSceneVideo(
        imagePath,
        audioPath,
        outputPath,
        sceneDuration
      );

      const videoUrl =
        getPublicUrl(
          "videos",
          filename
        );

      res.json({
        success: true,

        videoUrl,

        url:
          videoUrl,

        duration:
          sceneDuration,
      });
    } catch (error) {
      console.error(
        "Scene generation error:",
        error
      );

      res.status(500).json({
        success: false,

        error:
          error.message,
      });
    } finally {
      tempFiles.forEach(
        safeUnlink
      );
    }
  }
);

// ============================================================
// CHARACTER VIDEO ENDPOINT
// ============================================================

app.post(
  "/api/generate-character-video",
  async (
    req,
    res
  ) => {
    try {
      const scene =
        req.body || {};

      if (
        !scene.backgroundUrl ||
        !(
          scene.bodyUrl ||
          scene.characterUrl
        )
      ) {
        return res.status(400).json({
          success: false,

          error:
            "backgroundUrl and bodyUrl/characterUrl are required",
        });
      }

      const filename =
        `character_${uuidv4()}.mp4`;

      const outputPath =
        path.join(
          videosDir,
          filename
        );

      await renderCharacterVideo(
        scene,
        outputPath
      );

      const videoUrl =
        getPublicUrl(
          "videos",
          filename
        );

      res.json({
        success: true,

        videoUrl,

        url:
          videoUrl,

        animation:
          scene.animation ||
          "idle",
      });
    } catch (error) {
      console.error(
        "Character video error:",
        error
      );

      res.status(500).json({
        success: false,

        error:
          error.message,
      });
    }
  }
);

// ============================================================
// CONCAT SCENE VIDEOS
// ============================================================

async function concatSceneVideos(
  scenePaths,
  outputPath
) {
  const concatFile =
    path.join(
      tempDir,
      `concat_${uuidv4()}.txt`
    );

  try {
    const lines =
      scenePaths
        .map(
          (
            filePath
          ) =>
            `file '${filePath.replace(
              /'/g,
              "'\\''"
            )}'`
        )
        .join(
          "\n"
        );

    fs.writeFileSync(
      concatFile,
      lines
    );

    console.log(
      "========================================"
    );

    console.log(
      "CONCATENATING SCENES"
    );

    console.log(
      "Scenes:",
      scenePaths.length
    );

    console.log(
      "========================================"
    );

    await new Promise(
      (
        resolve,
        reject
      ) => {
        ffmpeg()
          .input(
            concatFile
          )

          .inputOptions([
            "-f concat",
            "-safe 0",
          ])

          .outputOptions([
            "-c copy",
            "-movflags +faststart",
          ])

          .on(
            "start",
            (
              commandLine
            ) => {
              console.log(
                "Concat FFmpeg:",
                commandLine
              );
            }
          )

          .on(
            "progress",
            (
              progress
            ) => {
              if (
                progress.timemark
              ) {
                console.log(
                  "Concat time:",
                  progress.timemark
                );
              }
            }
          )

          .on(
            "stderr",
            (line) => {
              if (
                line &&
                line.trim()
              ) {
                console.log(
                  "Concat FFmpeg:",
                  line
                );
              }
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
                "Concat FFmpeg error:",
                error
              );

              reject(error);
            }
          )

          .save(
            outputPath
          );
      }
    );
  } finally {
    safeUnlink(
      concatFile
    );
  }
}

// ============================================================
// NORMAL FINAL VIDEO
// ============================================================

app.post(
  "/api/generate-final-video",
  async (
    req,
    res
  ) => {
    const tempFiles = [];

    const sceneVideoPaths =
      [];

    try {
      const {
        scenes,
      } = req.body;

      if (
        !Array.isArray(
          scenes
        ) ||
        scenes.length ===
          0
      ) {
        return res.status(400).json({
          success: false,

          error:
            "scenes array is required",
        });
      }

      console.log("");

      console.log(
        "========================================"
      );

      console.log(
        "FINAL VIDEO GENERATION STARTED"
      );

      console.log(
        "Total scenes:",
        scenes.length
      );

      console.log(
        "========================================"
      );

      // ========================================================
      // RENDER EACH SCENE
      // ========================================================

      for (
        let i = 0;
        i < scenes.length;
        i++
      ) {
        const scene =
          scenes[i];

        console.log("");

        console.log(
          `========== SCENE ${i + 1} / ${scenes.length} ==========`
        );

        const duration =
          parseDuration(
            scene.duration,
            5
          );

        let sceneVideoPath;

        // ======================================================
        // CHARACTER
        // ======================================================

        if (
          hasCharacterAnimation(
            scene
          )
        ) {
          console.log(
            "Animation mode: CHARACTER"
          );

          const filename =
            `character_scene_${uuidv4()}.mp4`;

          sceneVideoPath =
            path.join(
              tempDir,
              filename
            );

          await renderCharacterVideo(
            {
              ...scene,

              duration,
            },
            sceneVideoPath
          );

          tempFiles.push(
            sceneVideoPath
          );
        }

        // ======================================================
        // CINEMATIC
        // ======================================================

        else {
          console.log(
            "Animation mode: CINEMATIC"
          );

          if (!scene.imageUrl) {
            throw new Error(
              `Scene ${i + 1} is missing imageUrl`
            );
          }

          const imagePath =
            path.join(
              tempDir,
              `final_image_${uuidv4()}${getExtensionFromUrl(
                scene.imageUrl,
                ".jpg"
              )}`
            );

          tempFiles.push(
            imagePath
          );

          console.log(
            "Image URL:",
            scene.imageUrl
          );

          await downloadFile(
            scene.imageUrl,
            imagePath
          );

          let audioPath =
            null;

          const audioUrl =
            scene.audioUrl ||
            scene.voiceUrl;

          if (audioUrl) {
            audioPath =
              path.join(
                tempDir,
                `final_audio_${uuidv4()}.mp3`
              );

            tempFiles.push(
              audioPath
            );

            console.log(
              "Audio URL:",
              audioUrl
            );

            await downloadFile(
              audioUrl,
              audioPath
            );
          }

          sceneVideoPath =
            path.join(
              tempDir,
              `scene_${uuidv4()}.mp4`
            );

          await renderSceneVideo(
            imagePath,
            audioPath,
            sceneVideoPath,
            duration
          );

          tempFiles.push(
            sceneVideoPath
          );
        }

        // ======================================================
        // VERIFY SCENE
        // ======================================================

        if (
          !fs.existsSync(
            sceneVideoPath
          )
        ) {
          throw new Error(
            `Scene ${i + 1} video was not created`
          );
        }

        const stats =
          fs.statSync(
            sceneVideoPath
          );

        console.log(
          "Scene video size:",
          stats.size,
          "bytes"
        );

        const probe =
          await probeVideo(
            sceneVideoPath
          );

        const videoStreams =
          probe.streams.filter(
            (
              stream
            ) =>
              stream.codec_type ===
              "video"
          );

        const audioStreams =
          probe.streams.filter(
            (
              stream
            ) =>
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
          throw new Error(
            `Scene ${i + 1} has no video stream`
          );
        }

        sceneVideoPaths.push(
          sceneVideoPath
        );

        console.log("");

        console.log(
          `SCENE ${i + 1} COMPLETED`
        );

        console.log(
          "========================================"
        );
      }

      // ========================================================
      // CONCAT
      // ========================================================

      const finalFilename =
        `video_${uuidv4()}.mp4`;

      const finalPath =
        path.join(
          videosDir,
          finalFilename
        );

      await concatSceneVideos(
        sceneVideoPaths,
        finalPath
      );

      // ========================================================
      // VERIFY FINAL VIDEO
      // ========================================================

      if (
        !fs.existsSync(
          finalPath
        )
      ) {
        throw new Error(
          "Final video was not created"
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

      const finalProbe =
        await probeVideo(
          finalPath
        );

      const finalVideoStreams =
        finalProbe.streams.filter(
          (
            stream
          ) =>
            stream.codec_type ===
            "video"
        );

      const finalAudioStreams =
        finalProbe.streams.filter(
          (
            stream
          ) =>
            stream.codec_type ===
            "audio"
        );

      console.log(
        "Final video streams:",
        finalVideoStreams.length
      );

      console.log(
        "Final audio streams:",
        finalAudioStreams.length
      );

      if (
        finalVideoStreams.length ===
        0
      ) {
        throw new Error(
          "Final video contains no video stream"
        );
      }

      const videoUrl =
        getPublicUrl(
          "videos",
          finalFilename
        );

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
        finalVideoStreams.length
      );

      console.log(
        "Audio streams:",
        finalAudioStreams.length
      );

      console.log(
        "========================================"
      );

      res.json({
        success:
          true,

        videoUrl,

        url:
          videoUrl,

        fileSize:
          finalStats.size,

        videoStreams:
          finalVideoStreams.length,

        audioStreams:
          finalAudioStreams.length,

        characterAnimation:
          scenes.some(
            hasCharacterAnimation
          ),
      });
    } catch (error) {
      console.error("");

      console.error(
        "========================================"
      );

      console.error(
        "FINAL VIDEO GENERATION ERROR"
      );

      console.error(
        error
      );

      console.error(
        "========================================"
      );

      res.status(500).json({
        success:
          false,

        error:
          error.message,
      });
    } finally {
      tempFiles.forEach(
        safeUnlink
      );
    }
  }
);

// ============================================================
// LEGACY GENERATE VIDEO
// ============================================================

app.post(
  "/api/generate-video",
  async (
    req,
    res
  ) => {
    try {
      const {
        scenes,
      } = req.body;

      if (
        !Array.isArray(
          scenes
        ) ||
        scenes.length ===
          0
      ) {
        return res.status(400).json({
          success: false,

          error:
            "scenes array is required",
        });
      }

      req.body.scenes =
        scenes;

      res.status(307).set(
        "Location",
        "/api/generate-final-video"
      );

      res.end();
    } catch (error) {
      console.error(
        "Legacy video error:",
        error
      );

      res.status(500).json({
        success:
          false,

        error:
          error.message,
      });
    }
  }
);

// ============================================================
// UPLOAD
// ============================================================

app.post(
  "/api/upload",
  upload.single("file"),
  async (
    req,
    res
  ) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success:
            false,

          error:
            "No file uploaded",
        });
      }

      let folder =
        "videos";

      if (
        req.file.mimetype.startsWith(
          "image/"
        )
      ) {
        folder =
          "images";
      }

      else if (
        req.file.mimetype.startsWith(
          "audio/"
        )
      ) {
        folder =
          "audio";
      }

      const fileUrl =
        getPublicUrl(
          folder,
          req.file.filename
        );

      console.log(
        "File uploaded:",
        fileUrl
      );

      res.json({
        success:
          true,

        url:
          fileUrl,

        fileUrl,

        filename:
          req.file.filename,

        mimetype:
          req.file.mimetype,

        size:
          req.file.size,
      });
    } catch (error) {
      console.error(
        "Upload error:",
        error
      );

      res.status(500).json({
        success:
          false,

        error:
          error.message,
      });
    }
  }
);

// ============================================================
// DOWNLOAD VIDEO
// ============================================================

app.get(
  "/api/download-video/:filename",
  (
    req,
    res
  ) => {
    try {
      const filename =
        path.basename(
          req.params.filename
        );

      const filePath =
        path.join(
          videosDir,
          filename
        );

      if (
        !fs.existsSync(
          filePath
        )
      ) {
        return res.status(404).json({
          success:
            false,

          error:
            "Video not found",
        });
      }

      res.download(
        filePath,
        filename
      );
    } catch (error) {
      console.error(
        "Download error:",
        error
      );

      res.status(500).json({
        success:
          false,

        error:
          error.message,
      });
    }
  }
);

// ============================================================
// 404
// ============================================================

app.use(
  (
    req,
    res
  ) => {
    res.status(404).json({
      success:
        false,

      error:
        "Route not found",

      method:
        req.method,

      path:
        req.path,
    });
  }
);

// ============================================================
// ERROR HANDLER
// ============================================================

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
      res.headersSent
    ) {
      return next(
        error
      );
    }

    res.status(
      error.status ||
        500
    ).json({
      success:
        false,

      error:
        error.message ||
        "Internal server error",
    });
  }
);

// ============================================================
// SERVER
// ============================================================

const server =
  app.listen(
    PORT,
    "0.0.0.0",
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
        "Port:",
        PORT
      );

      console.log(
        "Server URL:",
        SERVER_URL
      );

      console.log(
        "Images:",
        `${SERVER_URL}/uploads/images`
      );

      console.log(
        "Audio:",
        `${SERVER_URL}/uploads/audio`
      );

      console.log(
        "Videos:",
        `${SERVER_URL}/uploads/videos`
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
        ffmpegStatic
          ? "Configured ✓"
          : "NOT CONFIGURED ✗"
      );

      console.log(
        "FFprobe:",
        ffprobeStatic?.path
          ? "Configured ✓"
          : "NOT CONFIGURED ✗"
      );

      console.log(
        "Character Animation: ENABLED ✓"
      );

      console.log(
        "========================================"
      );

      console.log("");
    }
  );

// ============================================================
// SHUTDOWN
// ============================================================

function shutdown(
  signal
) {
  console.log(
    `${signal} received. Shutting down...`
  );

  server.close(
    () => {
      console.log(
        "Server closed."
      );

      process.exit(
        0
      );
    }
  );

  setTimeout(
    () => {
      process.exit(
        1
      );
    },
    10000
  );
}

process.on(
  "SIGTERM",
  () =>
    shutdown(
      "SIGTERM"
    )
);

process.on(
  "SIGINT",
  () =>
    shutdown(
      "SIGINT"
    )
);