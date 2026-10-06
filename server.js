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

const PORT = process.env.PORT || 3000;

const SERVER_URL =
  process.env.SERVER_URL ||
  "https://ai-video.bonto.run";

const ELEVENLABS_API_KEY =
  process.env.ELEVENLABS_API_KEY || "";

const ELEVENLABS_VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID ||
  "21m00Tcm4TlvDq8ikWAM";

const ELEVENLABS_MODEL =
  process.env.ELEVENLABS_MODEL ||
  "eleven_multilingual_v2";

/* =========================================================
   FFMPEG
========================================================= */

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

if (ffprobeStatic?.path) {
  ffmpeg.setFfprobePath(ffprobeStatic.path);
}

/* =========================================================
   DIRECTORIES
========================================================= */

const uploadsDir = path.join(__dirname, "uploads");
const imagesDir = path.join(uploadsDir, "images");
const audioDir = path.join(uploadsDir, "audio");
const videosDir = path.join(uploadsDir, "videos");
const tempDir = path.join(uploadsDir, "temp");

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

/* =========================================================
   EXPRESS
========================================================= */

const allowedOrigins = [
  "https://ai-video-studio-542c9.web.app",
  "https://ai-video-studio-542c9.firebaseapp.com",

  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
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

      console.log("Blocked CORS:", origin);
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

/* =========================================================
   STATIC FILES
========================================================= */

app.use(
  "/uploads",
  express.static(uploadsDir, {
    maxAge: "1h",
  })
);

/* =========================================================
   MULTER
========================================================= */

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const folder =
      file.mimetype.startsWith("image/")
        ? imagesDir
        : file.mimetype.startsWith("audio/")
        ? audioDir
        : videosDir;

    cb(null, folder);
  },

  filename: function (req, file, cb) {
    const extension = path.extname(
      file.originalname || ".bin"
    );

    cb(
      null,
      `${uuidv4()}${extension}`
    );
  },
});

const upload = multer({
  storage,

  limits: {
    fileSize:
      200 * 1024 * 1024,
  },
});

/* =========================================================
   HELPERS
========================================================= */

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
  const number = Number(value);

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
            /*
             * Redirect
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
                  `Download failed HTTP ${response.statusCode}: ${url}`
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
                file.close(() =>
                  resolve(destination)
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
              "Download timeout"
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

  return (
    (Number(parts[0]) || 0) * 3600 +
    (Number(parts[1]) || 0) * 60 +
    (Number(parts[2]) || 0)
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

  if (!duration) {
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
            reject(error);
            return;
          }

          resolve(data);
        }
      );
    }
  );
}

/* =========================================================
   HEALTH
========================================================= */

app.get("/", (req, res) => {
  res.json({
    success: true,
    message:
      "AI Video Studio Server is running",

    server: SERVER_URL,

    characterGeneration: true,
    characterAnimation: true,

    endpoints: [
      "/api/health",
      "/api/test",
      "/api/generate-image",
      "/api/generate-character",
      "/api/generate-background",
      "/api/generate-voice",
      "/api/generate-character-video",
      "/api/generate-final-video",
      "/api/upload",
    ],

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
      server: SERVER_URL,
      timestamp:
        new Date().toISOString(),
    });
  }
);

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      success: true,
      status: "healthy",

      server: SERVER_URL,

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

      characterGeneration: true,
      characterAnimation: true,
    });
  }
);

/* =========================================================
   GENERATE NORMAL IMAGE
========================================================= */

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

      const encodedPrompt =
        encodeURIComponent(
          prompt
        );

      const sourceUrl =
        `https://image.pollinations.ai/prompt/${encodedPrompt}` +
        `?width=1280&height=720&model=flux&nologo=true`;

      const filename =
        `image_${uuidv4()}.jpg`;

      const outputPath =
        path.join(
          imagesDir,
          filename
        );

      console.log(
        "Generating image:",
        prompt
      );

      await downloadFile(
        sourceUrl,
        outputPath
      );

      const imageUrl =
        getPublicUrl(
          "images",
          filename
        );

      return res.json({
        success: true,
        imageUrl,
        url: imageUrl,
      });
    } catch (error) {
      console.error(
        "Image generation error:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          error.message,
      });
    }
  }
);

/* =========================================================
   GENERATE CHARACTER IMAGE
========================================================= */

app.post(
  "/api/generate-character",
  async (req, res) => {
    try {
      const {
        idea,
        description,
        characterDescription,
        language,
      } = req.body || {};

      const characterText =
        characterDescription ||
        description ||
        idea ||
        "a cinematic fantasy character";

      const prompt =
        `Full body character design for ${characterText}. ` +
        `One single character only. ` +
        `The complete character must be visible from head to feet. ` +
        `Centered composition. ` +
        `Standing neutral pose. ` +
        `Clear face. ` +
        `Clear arms and legs. ` +
        `Simple solid bright green background. ` +
        `No other people. ` +
        `No animals. ` +
        `No text. ` +
        `No watermark. ` +
        `Photorealistic cinematic character. ` +
        `Detailed face. ` +
        `Detailed clothing. ` +
        `Consistent single character. ` +
        `Full body. ` +
        `16:9.`;

      console.log(
        "========================================"
      );

      console.log(
        "GENERATE CHARACTER"
      );

      console.log(
        "Character description:",
        characterText
      );

      console.log(
        "Language:",
        language || "not specified"
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

      const sourceUrl =
        `https://image.pollinations.ai/prompt/${encodedPrompt}` +
        `?width=1024&height=1024&model=flux&nologo=true&seed=${Math.floor(
          Math.random() * 1000000
        )}`;

      const filename =
        `character_${uuidv4()}.jpg`;

      const outputPath =
        path.join(
          imagesDir,
          filename
        );

      await downloadFile(
        sourceUrl,
        outputPath
      );

      const characterUrl =
        getPublicUrl(
          "images",
          filename
        );

      console.log(
        "Character created:",
        characterUrl
      );

      return res.json({
        success: true,

        characterUrl,

        url: characterUrl,

        imageUrl: characterUrl,

        prompt,

        type: "character",
      });
    } catch (error) {
      console.error(
        "Character generation error:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          error.message,
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
        idea,
        description,
        backgroundDescription,
      } = req.body || {};

      const backgroundText =
        backgroundDescription ||
        description ||
        idea ||
        "cinematic environment";

      const prompt =
        `Ultra realistic cinematic background environment for ${backgroundText}. ` +
        `No people. ` +
        `No characters. ` +
        `No animals. ` +
        `Wide cinematic composition. ` +
        `Natural lighting. ` +
        `Detailed environment. ` +
        `Photorealistic. ` +
        `16:9. ` +
        `No text. ` +
        `No watermark.`;

      console.log(
        "GENERATE BACKGROUND:",
        prompt
      );

      const encodedPrompt =
        encodeURIComponent(
          prompt
        );

      const sourceUrl =
        `https://image.pollinations.ai/prompt/${encodedPrompt}` +
        `?width=1280&height=720&model=flux&nologo=true&seed=${Math.floor(
          Math.random() * 1000000
        )}`;

      const filename =
        `background_${uuidv4()}.jpg`;

      const outputPath =
        path.join(
          imagesDir,
          filename
        );

      await downloadFile(
        sourceUrl,
        outputPath
      );

      const backgroundUrl =
        getPublicUrl(
          "images",
          filename
        );

      return res.json({
        success: true,
        backgroundUrl,
        url: backgroundUrl,
        imageUrl: backgroundUrl,
        prompt,
        type: "background",
      });
    } catch (error) {
      console.error(
        "Background generation error:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          error.message,
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
      const {
        text,
        voiceId,
        modelId,
      } = req.body || {};

      if (!text) {
        return res.status(400).json({
          success: false,
          error:
            "Text is required",
        });
      }

      if (!ELEVENLABS_API_KEY) {
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

      const response =
        await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${selectedVoice}`,
          {
            method: "POST",

            headers: {
              Accept:
                "audio/mpeg",

              "Content-Type":
                "application/json",

              "xi-api-key":
                ELEVENLABS_API_KEY,
            },

            body: JSON.stringify({
              text,

              model_id:
                selectedModel,

              voice_settings: {
                stability: 0.5,

                similarity_boost:
                  0.75,

                style: 0.2,

                use_speaker_boost:
                  true,
              },
            }),
          }
        );

      if (!response.ok) {
        const errorText =
          await response.text();

        return res.status(
          response.status
        ).json({
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

      return res.json({
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

      return res.status(500).json({
        success: false,
        error:
          error.message,
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
            "No file uploaded",
        });
      }

      const folder =
        req.file.mimetype.startsWith(
          "image/"
        )
          ? "images"
          : req.file.mimetype.startsWith(
              "audio/"
            )
          ? "audio"
          : "videos";

      const fileUrl =
        getPublicUrl(
          folder,
          req.file.filename
        );

      return res.json({
        success: true,

        fileUrl,

        url: fileUrl,

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

      return res.status(500).json({
        success: false,
        error:
          error.message,
      });
    }
  }
);

/* =========================================================
   NORMAL CINEMATIC VIDEO
========================================================= */

function renderSceneVideo(
  imagePath,
  audioPath,
  outputPath,
  duration
) {
  return new Promise(
    (resolve, reject) => {
      let command =
        ffmpeg()
          .input(imagePath)
          .inputOptions([
            "-loop",
            "1",
          ]);

      if (audioPath) {
        command =
          command.input(
            audioPath
          );
      }

      const frames =
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
        `d=${frames}:` +
        `s=1280x720:` +
        `fps=24`;

      command =
        command
          .complexFilter(filter)
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

            "-threads",
            "1",

            "-t",
            String(duration),
          ]);

      if (audioPath) {
        command =
          command
            .audioCodec("aac")
            .audioBitrate("128k")
            .outputOptions([
              "-af",
              "apad",

              "-t",
              String(duration),
            ]);
      } else {
        command =
          command.outputOptions([
            "-an",
          ]);
      }

      command
        .on(
          "start",
          (cmd) => {
            console.log(
              "Scene FFmpeg:",
              cmd
            );
          }
        )

        .on(
          "progress",
          (progress) => {
            console.log(
              `Scene progress: ${calculateProgress(
                progress.timemark,
                duration
              )}%`
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
            resolve(
              outputPath
            );
          }
        )

        .on(
          "error",
          reject
        )

        .save(outputPath);
    }
  );
}

/* =========================================================
   CHARACTER ANIMATION CHECK
========================================================= */

function hasCharacterAnimation(
  scene
) {
  if (!scene) {
    return false;
  }

  return Boolean(
    scene.characterUrl &&
    scene.backgroundUrl
  );
}

/* =========================================================
   CHARACTER ANIMATION FILTER
========================================================= */

function buildCharacterFilter(
  animation,
  duration
) {
  const mode =
    String(
      animation || "idle"
    )
      .toLowerCase()
      .trim();

  /*
   * BACKGROUND
   */

  const filters = [];

  filters.push(
    `[0:v]` +
      `scale=1280:720:force_original_aspect_ratio=decrease,` +
      `pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,` +
      `setsar=1[bg]`
  );

  /*
   * CHARACTER
   *
   * The character is one image.
   *
   * Green background is removed.
   */

  filters.push(
    `[1:v]` +
      `format=rgba,` +
      `scale=420:-1:force_original_aspect_ratio=decrease,` +
      `chromakey=0x00ff00:0.22:0.08,` +
      `setsar=1[character]`
  );

  let x =
    "(W-w)/2";

  let y =
    "H-h-20";

  /* =======================================================
     IDLE
  ======================================================= */

  if (
    mode === "idle" ||
    mode === "breathing"
  ) {
    x =
      "(W-w)/2+10*sin(2*PI*t*0.55)";

    y =
      "H-h-20+5*sin(2*PI*t*0.9)";
  }

  /* =======================================================
     TALKING
  ======================================================= */

  else if (
    mode === "talking" ||
    mode === "talk"
  ) {
    x =
      "(W-w)/2+8*sin(2*PI*t*1.8)";

    y =
      "H-h-20+8*sin(2*PI*t*3.0)";
  }

  /* =======================================================
     WALKING
  ======================================================= */

  else if (
    mode === "walking" ||
    mode === "walk"
  ) {
    x =
      `-w-40+(W+w+80)*(t/${duration})`;

    y =
      "H-h-20-14*abs(sin(2*PI*t*2.2))";
  }

  /* =======================================================
     RUNNING
  ======================================================= */

  else if (
    mode === "running" ||
    mode === "run"
  ) {
    x =
      `-w-40+(W+w+80)*(t/${duration})`;

    y =
      "H-h-20-22*abs(sin(2*PI*t*3.5))";
  }

  /* =======================================================
     JUMPING
  ======================================================= */

  else if (
    mode === "jumping" ||
    mode === "jump"
  ) {
    x =
      "(W-w)/2+30*sin(2*PI*t*0.9)";

    y =
      "H-h-20-260*abs(sin(2*PI*t*0.8))";
  }

  /* =======================================================
     ATTACK
  ======================================================= */

  else if (
    mode === "attacking" ||
    mode === "attack"
  ) {
    x =
      "(W-w)/2+180*pow(abs(sin(2*PI*t*0.8)),3)";

    y =
      "H-h-20-45*pow(abs(sin(2*PI*t*0.8)),3)";
  }

  /* =======================================================
     DANCING
  ======================================================= */

  else if (
    mode === "dancing" ||
    mode === "dance"
  ) {
    x =
      "(W-w)/2+55*sin(2*PI*t*1.3)";

    y =
      "H-h-20-35*abs(sin(2*PI*t*2.6))";
  }

  /* =======================================================
     TALKING + WALKING
  ======================================================= */

  else if (
    mode === "talking-walking" ||
    mode === "talk-walk" ||
    mode === "talk_walk"
  ) {
    x =
      `-w-40+(W+w+80)*(t/${duration})+8*sin(2*PI*t*2.3)`;

    y =
      "H-h-20-14*abs(sin(2*PI*t*2.3))";
  }

  /* =======================================================
     FALLBACK
  ======================================================= */

  else {
    x =
      "(W-w)/2+12*sin(2*PI*t*0.6)";

    y =
      "H-h-20+6*sin(2*PI*t*0.8)";
  }

  filters.push(
    `[bg][character]` +
      `overlay=` +
      `x='${x}':` +
      `y='${y}':` +
      `eval=frame:` +
      `eof_action=repeat,` +
      `format=yuv420p[final]`
  );

  return filters.join(";");
}

/* =========================================================
   RENDER CHARACTER VIDEO
========================================================= */

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
      scene.animation ||
      scene.animationType ||
      "idle";

    if (!scene.characterUrl) {
      throw new Error(
        "characterUrl is required"
      );
    }

    if (!scene.backgroundUrl) {
      throw new Error(
        "backgroundUrl is required"
      );
    }

    /*
     * BACKGROUND
     */

    const backgroundPath =
      path.join(
        tempDir,
        `character_background_${uuidv4()}${getExtensionFromUrl(
          scene.backgroundUrl,
          ".jpg"
        )}`
      );

    tempFiles.push(
      backgroundPath
    );

    await downloadFile(
      scene.backgroundUrl,
      backgroundPath
    );

    /*
     * CHARACTER
     */

    const characterPath =
      path.join(
        tempDir,
        `character_image_${uuidv4()}${getExtensionFromUrl(
          scene.characterUrl,
          ".jpg"
        )}`
      );

    tempFiles.push(
      characterPath
    );

    await downloadFile(
      scene.characterUrl,
      characterPath
    );

    /*
     * AUDIO
     */

    let audioPath = null;

    const audioUrl =
      scene.audioUrl ||
      scene.voiceUrl ||
      scene.audio;

    if (audioUrl) {
      audioPath =
        path.join(
          tempDir,
          `character_audio_${uuidv4()}.mp3`
        );

      tempFiles.push(
        audioPath
      );

      await downloadFile(
        audioUrl,
        audioPath
      );
    }

    /*
     * FFMPEG INPUTS
     *
     * Input 0 = background
     * Input 1 = character
     * Input 2 = audio
     */

    let command =
      ffmpeg()
        .input(backgroundPath)
        .inputOptions([
          "-loop",
          "1",
        ])

        .input(characterPath)
        .inputOptions([
          "-loop",
          "1",
        ]);

    if (audioPath) {
      command =
        command.input(
          audioPath
        );
    }

    const filter =
      buildCharacterFilter(
        animation,
        duration
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
      duration
    );

    console.log(
      "Character:",
      scene.characterUrl
    );

    console.log(
      "Background:",
      scene.backgroundUrl
    );

    console.log(
      "Audio:",
      audioUrl || "none"
    );

    console.log(
      "Filter:",
      filter
    );

    console.log(
      "========================================"
    );

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
          "veryfast",

          "-crf",
          "23",

          "-r",
          "24",

          "-threads",
          "1",

          "-movflags",
          "+faststart",

          "-t",
          String(duration),
        ]);

    if (audioPath) {
      command =
        command
          .audioCodec("aac")
          .audioBitrate("128k")

          .outputOptions([
            "-af",
            "apad",

            "-t",
            String(duration),
          ]);
    } else {
      command =
        command.outputOptions([
          "-an",
        ]);
    }

    await new Promise(
      (resolve, reject) => {
        command

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
                `Character progress: ${calculateProgress(
                  progress.timemark,
                  duration
                )}%`
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
                "Character FFmpeg completed."
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

          .save(outputPath);
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

    console.log(
      "Character video created:",
      outputPath
    );

    return outputPath;
  } finally {
    tempFiles.forEach(
      safeUnlink
    );
  }
}

/* =========================================================
   GENERATE CHARACTER VIDEO
========================================================= */

app.post(
  "/api/generate-character-video",
  async (req, res) => {
    try {
      const scene =
        req.body || {};

      if (
        !scene.characterUrl ||
        !scene.backgroundUrl
      ) {
        return res.status(400).json({
          success: false,

          error:
            "characterUrl and backgroundUrl are required",
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

      return res.json({
        success: true,

        videoUrl,

        url: videoUrl,

        animation:
          scene.animation ||
          scene.animationType ||
          "idle",
      });
    } catch (error) {
      console.error(
        "Character video error:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          error.message,
      });
    }
  }
);

/* =========================================================
   ALIAS
   /api/generate-character
   NOTE:
   This endpoint generates the CHARACTER IMAGE.
========================================================= */

/*
 * The route /api/generate-character above is intentional.
 *
 * Your frontend previously called:
 *
 * POST /api/generate-character
 *
 * It must therefore exist on Bonto after deployment.
 */

/* =========================================================
   CONCAT SCENE VIDEOS
========================================================= */

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
          (filePath) =>
            `file '${filePath.replace(
              /'/g,
              "'\\''"
            )}'`
        )
        .join("\n");

    fs.writeFileSync(
      concatFile,
      lines
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
            "progress",
            (progress) => {
              console.log(
                "Concat progress:",
                calculateProgress(
                  progress.timemark,
                  1
                ),
                "%"
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
            reject
          )

          .save(outputPath);
      }
    );
  } finally {
    safeUnlink(
      concatFile
    );
  }
}

/* =========================================================
   FINAL VIDEO
========================================================= */

app.post(
  "/api/generate-final-video",
  async (req, res) => {
    const sceneVideoPaths =
      [];

    try {
      const {
        scenes,
      } = req.body || {};

      if (
        !Array.isArray(scenes) ||
        scenes.length === 0
      ) {
        return res.status(400).json({
          success: false,
          error:
            "scenes array is required",
        });
      }

      console.log(
        "========================================"
      );

      console.log(
        "FINAL VIDEO GENERATION"
      );

      console.log(
        "Scenes:",
        scenes.length
      );

      console.log(
        "========================================"
      );

      for (
        let i = 0;
        i < scenes.length;
        i++
      ) {
        const scene =
          scenes[i] || {};

        const duration =
          parseDuration(
            scene.duration,
            5
          );

        let outputPath;

        /*
         * =====================================================
         * CHARACTER SCENE
         *
         * IMPORTANT:
         * We no longer require animation !== "idle".
         *
         * Any scene containing:
         *
         * characterUrl
         * backgroundUrl
         *
         * uses the character renderer.
         * =====================================================
         */

        if (
          hasCharacterAnimation(
            scene
          )
        ) {
          const filename =
            `character_scene_${uuidv4()}.mp4`;

          outputPath =
            path.join(
              tempDir,
              filename
            );

          console.log(
            `Scene ${i + 1}: CHARACTER`
          );

          console.log(
            "Animation:",
            scene.animation ||
              scene.animationType ||
              "idle"
          );

          await renderCharacterVideo(
            {
              ...scene,

              animation:
                scene.animation ||
                scene.animationType ||
                "idle",

              duration,
            },
            outputPath
          );
        }

        /*
         * =====================================================
         * NORMAL CINEMATIC SCENE
         * =====================================================
         */

        else {
          if (!scene.imageUrl) {
            throw new Error(
              `Scene ${i + 1} has no imageUrl`
            );
          }

          console.log(
            `Scene ${i + 1}: CINEMATIC`
          );

          const imagePath =
            path.join(
              tempDir,
              `scene_${uuidv4()}${getExtensionFromUrl(
                scene.imageUrl,
                ".jpg"
              )}`
            );

          let audioPath = null;

          try {
            await downloadFile(
              scene.imageUrl,
              imagePath
            );

            const audioUrl =
              scene.audioUrl ||
              scene.voiceUrl ||
              scene.audio;

            if (audioUrl) {
              audioPath =
                path.join(
                  tempDir,
                  `audio_${uuidv4()}.mp3`
                );

              await downloadFile(
                audioUrl,
                audioPath
              );
            }

            outputPath =
              path.join(
                tempDir,
                `scene_video_${uuidv4()}.mp4`
              );

            await renderSceneVideo(
              imagePath,
              audioPath,
              outputPath,
              duration
            );
          } finally {
            safeUnlink(
              imagePath
            );

            safeUnlink(
              audioPath
            );
          }
        }

        if (
          !fs.existsSync(
            outputPath
          )
        ) {
          throw new Error(
            `Scene ${i + 1} video was not created`
          );
        }

        sceneVideoPaths.push(
          outputPath
        );

        console.log(
          `Scene ${i + 1} completed`
        );
      }

      /*
       * =====================================================
       * FINAL FILE
       * =====================================================
       */

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

      /*
       * =====================================================
       * VERIFY
       * =====================================================
       */

      if (
        !fs.existsSync(
          finalPath
        )
      ) {
        throw new Error(
          "Final video was not created"
        );
      }

      const stats =
        fs.statSync(
          finalPath
        );

      const probe =
        await probeVideo(
          finalPath
        );

      const videoStreams =
        probe.streams.filter(
          (stream) =>
            stream.codec_type ===
            "video"
        );

      const audioStreams =
        probe.streams.filter(
          (stream) =>
            stream.codec_type ===
            "audio"
        );

      const videoUrl =
        getPublicUrl(
          "videos",
          finalFilename
        );

      console.log(
        "========================================"
      );

      console.log(
        "FINAL VIDEO READY"
      );

      console.log(
        "Video URL:",
        videoUrl
      );

      console.log(
        "File size:",
        stats.size
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

        finalVideo:
          videoUrl,

        fileSize:
          stats.size,

        videoStreams:
          videoStreams.length,

        audioStreams:
          audioStreams.length,

        characterAnimation:
          scenes.some(
            hasCharacterAnimation
          ),
      });
    } catch (error) {
      console.error(
        "========================================"
      );

      console.error(
        "FINAL VIDEO ERROR:"
      );

      console.error(
        error
      );

      console.error(
        "========================================"
      );

      return res.status(500).json({
        success: false,
        error:
          error.message,
      });
    } finally {
      sceneVideoPaths.forEach(
        safeUnlink
      );
    }
  }
);

/* =========================================================
   LEGACY GENERATE VIDEO
========================================================= */

app.post(
  "/api/generate-video",
  async (req, res) => {
    return res.status(410).json({
      success: false,

      error:
        "Use /api/generate-final-video instead.",
    });
  }
);

/* =========================================================
   DOWNLOAD VIDEO
========================================================= */

app.get(
  "/api/download-video/:filename",
  (req, res) => {
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
          success: false,
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
        success: false,
        error:
          error.message,
      });
    }
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

      method:
        req.method,

      path:
        req.originalUrl,
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

    res.status(500).json({
      success: false,

      error:
        error.message ||
        "Internal server error",
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
      "AI VIDEO STUDIO SERVER STARTED"
    );

    console.log(
      "PORT:",
      PORT
    );

    console.log(
      "SERVER:",
      SERVER_URL
    );

    console.log(
      "CHARACTER GENERATION: READY"
    );

    console.log(
      "CHARACTER ANIMATION: READY"
    );

    console.log(
      "========================================"
    );
  }
);