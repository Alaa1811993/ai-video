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

const ROOT = __dirname;
const UPLOADS = path.join(ROOT, "uploads");
const IMAGES = path.join(UPLOADS, "images");
const AUDIO = path.join(UPLOADS, "audio");
const VIDEOS = path.join(UPLOADS, "videos");
const TEMP = path.join(UPLOADS, "temp");

[UPLOADS, IMAGES, AUDIO, VIDEOS, TEMP].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

if (ffprobeStatic && ffprobeStatic.path) {
  ffmpeg.setFfprobePath(ffprobeStatic.path);
}

const FRONTEND_URL =
  process.env.FRONTEND_URL || "https://ai-video-studio-542c9.web.app";

const ALLOWED_ORIGINS = [
  FRONTEND_URL,
  "https://ai-video-studio-542c9.web.app",
  "https://ai-video-studio-542c9.firebaseapp.com",
  "http://localhost:5173",
  "http://localhost:5174",
];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }

      return callback(null, true);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true, limit: "100mb" }));

app.use("/uploads", express.static(UPLOADS));

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, TEMP);
  },
  filename(req, file, cb) {
    cb(null, `${uuidv4()}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024,
  },
});

/* =========================================================
   HELPERS
========================================================= */

function publicUrl(filePath) {
  const base =
    process.env.PUBLIC_URL ||
    `http://localhost:${PORT}`;

  const relative = path
    .relative(UPLOADS, filePath)
    .split(path.sep)
    .join("/");

  return `${base}/uploads/${relative}`;
}

function remoteUrlFromPath(filePath) {
  const base =
    process.env.PUBLIC_URL ||
    `https://ai-video.bonto.run`;

  const relative = path
    .relative(UPLOADS, filePath)
    .split(path.sep)
    .join("/");

  return `${base}/uploads/${relative}`;
}

function safeFilename(name) {
  return String(name || "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 150);
}

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    if (!url) {
      return reject(new Error("Missing URL"));
    }

    const protocol = url.startsWith("https") ? https : http;

    const request = protocol.get(
      url,
      {
        headers: {
          "User-Agent": "AI-Video-Studio/1.0",
        },
      },
      (response) => {
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.destroy();

          return downloadFile(response.headers.location, destination)
            .then(resolve)
            .catch(reject);
        }

        if (response.statusCode !== 200) {
          response.resume();
          return reject(
            new Error(
              `Download failed ${response.statusCode}: ${url}`
            )
          );
        }

        const file = fs.createWriteStream(destination);

        response.pipe(file);

        file.on("finish", () => {
          file.close(() => resolve(destination));
        });

        file.on("error", reject);
      }
    );

    request.on("error", reject);
  });
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeFilterColor(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

/* =========================================================
   HEALTH
========================================================= */

app.get("/", (req, res) => {
  res.json({
    success: true,
    name: "AI Video Server",
    version: "character-animation-2.0",
    port: PORT,
    ffmpeg: Boolean(ffmpegStatic),
    ffprobe: Boolean(ffprobeStatic),
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "healthy",
    server: "AI Video Server",
    port: PORT,
    ffmpeg: Boolean(ffmpegStatic),
    ffprobe: Boolean(ffprobeStatic),
    directories: {
      uploads: UPLOADS,
      images: IMAGES,
      audio: AUDIO,
      videos: VIDEOS,
      temp: TEMP,
    },
  });
});

/* =========================================================
   GENERATE IMAGE
========================================================= */

app.post("/api/generate-image", async (req, res) => {
  try {
    const prompt = cleanText(req.body.prompt);

    if (!prompt) {
      return res.status(400).json({
        success: false,
        error: "Prompt is required",
      });
    }

    const imageUrl =
      `https://image.pollinations.ai/prompt/` +
      `${encodeURIComponent(prompt)}` +
      `?width=1280&height=720&model=flux&nologo=true`;

    const filename = `image_${uuidv4()}.jpg`;
    const output = path.join(IMAGES, filename);

    await downloadFile(imageUrl, output);

    return res.json({
      success: true,
      imageUrl: remoteUrlFromPath(output),
      url: remoteUrlFromPath(output),
      prompt,
    });
  } catch (error) {
    console.error("generate-image:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* =========================================================
   GENERATE CHARACTER
========================================================= */

app.post("/api/generate-character", async (req, res) => {
  try {
    const prompt = cleanText(req.body.prompt);

    if (!prompt) {
      return res.status(400).json({
        success: false,
        error: "Character prompt is required",
      });
    }

    const finalPrompt = `
Create a high quality fictional 3D animated character for a video production.

${prompt}

Requirements:
- full body
- character completely visible
- standing upright
- front-facing or slight 3/4 view
- arms and legs clearly visible
- feet completely visible
- one character only
- no text
- no watermark
- bright solid green chroma key background
- consistent character design
- cinematic lighting
- detailed face
- detailed clothing
- 16:9 composition
`;

    const imageUrl =
      `https://image.pollinations.ai/prompt/` +
      `${encodeURIComponent(finalPrompt)}` +
      `?width=1024&height=1024&model=flux&nologo=true`;

    const filename = `character_${uuidv4()}.jpg`;
    const output = path.join(IMAGES, filename);

    await downloadFile(imageUrl, output);

    return res.json({
      success: true,
      characterUrl: remoteUrlFromPath(output),
      imageUrl: remoteUrlFromPath(output),
      url: remoteUrlFromPath(output),
      prompt: finalPrompt,
    });
  } catch (error) {
    console.error("generate-character:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* =========================================================
   GENERATE BACKGROUND
========================================================= */

app.post("/api/generate-background", async (req, res) => {
  try {
    const prompt = cleanText(req.body.prompt);

    if (!prompt) {
      return res.status(400).json({
        success: false,
        error: "Background prompt is required",
      });
    }

    const finalPrompt = `
Create a realistic cinematic environment for a video scene.

${prompt}

Requirements:
- no people
- no characters
- no text
- no watermark
- realistic lighting
- cinematic composition
- empty central area for character compositing
- detailed environment
- 16:9 landscape
`;

    const imageUrl =
      `https://image.pollinations.ai/prompt/` +
      `${encodeURIComponent(finalPrompt)}` +
      `?width=1280&height=720&model=flux&nologo=true`;

    const filename = `background_${uuidv4()}.jpg`;
    const output = path.join(IMAGES, filename);

    await downloadFile(imageUrl, output);

    return res.json({
      success: true,
      backgroundUrl: remoteUrlFromPath(output),
      imageUrl: remoteUrlFromPath(output),
      url: remoteUrlFromPath(output),
      prompt: finalPrompt,
    });
  } catch (error) {
    console.error("generate-background:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* =========================================================
   GENERATE VOICE
========================================================= */

app.post("/api/generate-voice", async (req, res) => {
  try {
    const text = cleanText(req.body.text);
    const voice = req.body.voice || "Female";

    if (!text) {
      return res.status(400).json({
        success: false,
        error: "Text is required",
      });
    }

    const apiKey = process.env.ELEVENLABS_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        success: false,
        error: "ELEVENLABS_API_KEY is not configured",
      });
    }

    const voiceMap = {
      Female:
        process.env.ELEVENLABS_FEMALE_VOICE_ID ||
        "EXAVITQu4vr4xnSDxMaL",

      Male:
        process.env.ELEVENLABS_MALE_VOICE_ID ||
        "TxGEqnHWrfWFTfGW9XjX",

      "Deep Male":
        process.env.ELEVENLABS_DEEP_MALE_VOICE_ID ||
        "VR6AewLTigWG4xSOukaG",

      Storyteller:
        process.env.ELEVENLABS_STORYTELLER_VOICE_ID ||
        "pNInz6obpgDQGcFmaJgB",
    };

    const voiceId =
      voiceMap[voice] ||
      voiceMap.Female;

    const body = JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.8,
        style: 0.35,
        use_speaker_boost: true,
      },
    });

    const audioBuffer = await new Promise(
      (resolve, reject) => {
        const request = https.request(
          {
            hostname: "api.elevenlabs.io",
            path: `/v1/text-to-speech/${voiceId}`,
            method: "POST",
            headers: {
              Accept: "audio/mpeg",
              "Content-Type": "application/json",
              "xi-api-key": apiKey,
              "Content-Length": Buffer.byteLength(body),
            },
          },
          (response) => {
            const chunks = [];

            response.on("data", (chunk) => {
              chunks.push(chunk);
            });

            response.on("end", () => {
              const buffer = Buffer.concat(chunks);

              if (response.statusCode < 200 || response.statusCode >= 300) {
                return reject(
                  new Error(
                    `ElevenLabs ${response.statusCode}: ${buffer.toString(
                      "utf8"
                    )}`
                  )
                );
              }

              resolve(buffer);
            });
          }
        );

        request.on("error", reject);

        request.write(body);
        request.end();
      }
    );

    const filename = `voice_${uuidv4()}.mp3`;
    const output = path.join(AUDIO, filename);

    fs.writeFileSync(output, audioBuffer);

    return res.json({
      success: true,
      audioUrl: remoteUrlFromPath(output),
      url: remoteUrlFromPath(output),
      audio: remoteUrlFromPath(output),
      voice,
    });
  } catch (error) {
    console.error("generate-voice:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/* =========================================================
   DOWNLOAD REMOTE MEDIA
========================================================= */

async function prepareMedia(url, folder, prefix) {
  if (!url) {
    throw new Error(`Missing ${prefix} URL`);
  }

  const ext =
    path.extname(new URL(url).pathname) ||
    ".jpg";

  const filename =
    `${prefix}_${uuidv4()}${ext}`;

  const destination =
    path.join(folder, filename);

  await downloadFile(url, destination);

  return destination;
}

/* =========================================================
   CREATE CHARACTER MOTION
========================================================= */

function buildCharacterFilter(animation, duration) {
  const d = Number(duration) || 5;

  /*
    IMPORTANT:

    The character itself moves.

    This is not camera zoom only.

    We:
    - scale the character
    - translate X/Y
    - slightly rotate
    - create breathing/bobbing motion
    - create walking movement
  */

  if (animation === "talking-walking") {
    return [
      "chromakey=0x00ff00:0.18:0.08",

      `scale=iw*0.72:ih*0.72`,

      `rotate=0.025*sin(2*PI*t*1.8):fillcolor=none`,

      `scale=1+0.025*sin(2*PI*t*2):` +
        `1+0.025*sin(2*PI*t*2)`,

      `overlay=` +
        `W-w-80-(W-w-160)*sin(PI*t/${Math.max(d, 1)})` +
        `:` +
        `H-h-35-10*sin(2*PI*t*1.8)`,

      "format=yuv420p",
    ].join(",");
  }

  return [
    "chromakey=0x00ff00:0.18:0.08",

    `scale=iw*0.72:ih*0.72`,

    `rotate=0.018*sin(2*PI*t*2):fillcolor=none`,

    `scale=1+0.035*sin(2*PI*t*2.2):` +
      `1+0.035*sin(2*PI*t*2.2)`,

    `overlay=` +
      `(W-w)/2+10*sin(2*PI*t*1.1)` +
      `:` +
      `H-h-35-8*sin(2*PI*t*2.2)`,

    "format=yuv420p",
  ].join(",");
}

/* =========================================================
   RENDER ONE SCENE
========================================================= */

async function renderScene(scene, sceneIndex) {
  const duration = clamp(
    Number(scene.duration) || 5,
    2,
    60
  );

  const animation =
    scene.animation || "talking";

  const backgroundPath =
    await prepareMedia(
      scene.backgroundUrl,
      TEMP,
      `bg_${sceneIndex}`
    );

  const characterPath =
    await prepareMedia(
      scene.characterUrl,
      TEMP,
      `char_${sceneIndex}`
    );

  let audioPath = null;

  if (scene.audioUrl) {
    audioPath = await prepareMedia(
      scene.audioUrl,
      TEMP,
      `audio_${sceneIndex}`
    );
  }

  const output =
    path.join(
      VIDEOS,
      `scene_${uuidv4()}.mp4`
    );

  return new Promise((resolve, reject) => {
    let command = ffmpeg();

    command = command
      .input(backgroundPath)
      .inputOptions([
        "-loop 1",
        `-t ${duration}`,
      ])
      .input(characterPath)
      .inputOptions([
        "-loop 1",
      ]);

    if (audioPath) {
      command = command.input(audioPath);
    }

    const characterFilter =
      buildCharacterFilter(
        animation,
        duration
      );

    const filters = [
      `[0:v]scale=1280:720:force_original_aspect_ratio=increase,` +
        `crop=1280:720,setsar=1[bg]`,

      `[1:v]scale=iw:ih,${characterFilter}[char]`,

      `[bg][char]overlay=0:0:shortest=1[v]`,
    ];

    command = command
      .complexFilter(filters)
      .outputOptions([
        "-map [v]",

        ...(audioPath
          ? ["-map 2:a:0"]
          : []),

        "-c:v libx264",
        "-preset veryfast",
        "-crf 25",

        "-pix_fmt yuv420p",

        "-r 30",

        ...(audioPath
          ? [
              "-c:a aac",
              "-b:a 128k",
              "-shortest",
            ]
          : []),

        "-movflags +faststart",
        "-threads 1",
      ])
      .duration(duration)
      .on("start", (cmd) => {
        console.log(
          `Scene ${sceneIndex + 1} FFmpeg:`,
          cmd
        );
      })
      .on("progress", (progress) => {
        console.log(
          `Scene ${sceneIndex + 1}:`,
          progress.percent || 0,
          "%"
        );
      })
      .on("error", (error) => {
        console.error(
          `Scene ${sceneIndex + 1} error:`,
          error
        );

        reject(error);
      })
      .on("end", () => {
        console.log(
          `Scene ${sceneIndex + 1} completed`
        );

        resolve(output);
      });

    command.save(output);
  });
}

/* =========================================================
   CONCAT SCENES
========================================================= */

async function concatVideos(sceneFiles) {
  const concatFile =
    path.join(
      TEMP,
      `concat_${uuidv4()}.txt`
    );

  const finalFile =
    path.join(
      VIDEOS,
      `final_${uuidv4()}.mp4`
    );

  const lines = sceneFiles
    .map(
      (file) =>
        `file '${file.replace(/'/g, "'\\''")}'`
    )
    .join("\n");

  fs.writeFileSync(
    concatFile,
    lines,
    "utf8"
  );

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(concatFile)
      .inputOptions([
        "-f concat",
        "-safe 0",
      ])
      .outputOptions([
        "-c copy",
        "-movflags +faststart",
      ])
      .on("start", (cmd) => {
        console.log(
          "Concat FFmpeg:",
          cmd
        );
      })
      .on("error", (error) => {
        console.error(
          "Concat error:",
          error
        );

        reject(error);
      })
      .on("end", () => {
        console.log(
          "Final video created:",
          finalFile
        );

        resolve(finalFile);
      })
      .save(finalFile);
  });
}

/* =========================================================
   FINAL VIDEO
========================================================= */

app.post(
  "/api/generate-final-video",
  async (req, res) => {
    const createdScenes = [];

    try {
      const scenes =
        Array.isArray(req.body.scenes)
          ? req.body.scenes
          : [];

      if (!scenes.length) {
        return res.status(400).json({
          success: false,
          error: "No scenes supplied",
        });
      }

      console.log(
        `Rendering ${scenes.length} scenes`
      );

      for (
        let i = 0;
        i < scenes.length;
        i++
      ) {
        const scene = scenes[i];

        if (!scene.characterUrl) {
          throw new Error(
            `Scene ${i + 1} is missing characterUrl`
          );
        }

        if (!scene.backgroundUrl) {
          throw new Error(
            `Scene ${i + 1} is missing backgroundUrl`
          );
        }

        console.log(
          `Rendering scene ${i + 1}`,
          {
            duration: scene.duration,
            animation: scene.animation,
            hasVoice: Boolean(
              scene.audioUrl
            ),
          }
        );

        const file =
          await renderScene(
            scene,
            i
          );

        createdScenes.push(file);
      }

      const finalFile =
        createdScenes.length === 1
          ? createdScenes[0]
          : await concatVideos(
              createdScenes
            );

      const finalUrl =
        remoteUrlFromPath(
          finalFile
        );

      return res.json({
        success: true,
        videoUrl: finalUrl,
        finalVideo: finalUrl,
        url: finalUrl,
        scenes: scenes.length,
      });
    } catch (error) {
      console.error(
        "generate-final-video:",
        error
      );

      return res.status(500).json({
        success: false,
        error: error.message,
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
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: "No file uploaded",
        });
      }

      const ext =
        path.extname(
          req.file.originalname
        ) || ".bin";

      const targetName =
        `${uuidv4()}${ext}`;

      const target =
        path.join(
          UPLOADS,
          targetName
        );

      fs.renameSync(
        req.file.path,
        target
      );

      return res.json({
        success: true,
        url: remoteUrlFromPath(
          target
        ),
        fileUrl: remoteUrlFromPath(
          target
        ),
      });
    } catch (error) {
      console.error(
        "upload:",
        error
      );

      return res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (req, res) => {
    res.status(404).json({
      success: false,
      error: "Route not found.",
      path: req.path,
    });
  }
);

app.use(
  (error, req, res, next) => {
    console.error(
      "Unhandled error:",
      error
    );

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
);

/* =========================================================
   START
========================================================= */

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `AI Video Server running on port ${PORT}`
  );

  console.log(
    `Uploads: ${UPLOADS}`
  );

  console.log(
    `FFmpeg: ${ffmpegStatic}`
  );

  console.log(
    `FFprobe: ${
      ffprobeStatic
        ? ffprobeStatic.path
        : "not found"
    }`
  );
});