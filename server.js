
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

// =========================================================
// EXPRESS
// =========================================================

const app = express();

const PORT = Number(process.env.PORT) || 3000;

const SERVER_URL =
  process.env.SERVER_URL ||
  "https://ai-video.bonto.run";

const ELEVENLABS_API_KEY =
  process.env.ELEVENLABS_API_KEY || "";

// =========================================================
// DIRECTORIES
// =========================================================

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

// =========================================================
// FFMPEG
// =========================================================

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

// =========================================================
// CORS
// =========================================================

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

// =========================================================
// BODY PARSER
// =========================================================

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

// =========================================================
// STATIC FILES
// =========================================================

app.use(
  "/uploads",
  express.static(UPLOADS_DIR, {
    maxAge: "1d",
  })
);

// =========================================================
// MULTER
// =========================================================

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const mimetype = file.mimetype || "";

    if (mimetype.startsWith("image/")) {
      return cb(null, IMAGES_DIR);
    }

    if (mimetype.startsWith("audio/")) {
      return cb(null, AUDIO_DIR);
    }

    return cb(null, TEMP_DIR);
  },

  filename: (req, file, cb) => {
    const ext =
      path.extname(file.originalname || "") || "";

    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,

  limits: {
    fileSize: 100 * 1024 * 1024,
  },
});

// =========================================================
// SERVER URL
// =========================================================

function getServerUrl() {
  return SERVER_URL.replace(/\/+$/, "");
}

// =========================================================
// FFMPEG CHECK
// =========================================================

function ensureFfmpegAvailable() {
  if (!resolvedFfmpegPath) {
    throw new Error(
      "FFmpeg executable was not found."
    );
  }

  if (!fs.existsSync(resolvedFfmpegPath)) {
    throw new Error(
      `FFmpeg executable does not exist: ${resolvedFfmpegPath}`
    );
  }

  if (!resolvedFfprobePath) {
    throw new Error(
      "FFprobe executable was not found."
    );
  }

  if (!fs.existsSync(resolvedFfprobePath)) {
    throw new Error(
      `FFprobe executable does not exist: ${resolvedFfprobePath}`
    );
  }
}

// =========================================================
// SAFE DELETE
// =========================================================

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

// =========================================================
// MEDIA DURATION
// =========================================================

function getMediaDuration(filePath) {
  return new Promise((resolve, reject) => {
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
  });
}

// =========================================================
// DOWNLOAD FILE
// =========================================================

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

            return resolve(targetPath);
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
                  resolve(targetPath);
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

// =========================================================
// ELEVENLABS VOICES
// =========================================================

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

// =========================================================
// GENERATE VOICE
// =========================================================

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

      if (!ELEVENLABS_API_KEY) {
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

      const response = await fetch(
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
          .status(response.status)
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

// =========================================================
// UPLOAD
// =========================================================

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
        mimetype.startsWith(
          "image/"
        )
      ) {
        folder = "images";
      }

      if (
        mimetype.startsWith(
          "audio/"
        )
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

// =========================================================
// POLLINATIONS IMAGE
// =========================================================

async function generatePollinationsImage(
  prompt,
  prefix
) {
  const finalPrompt =
    String(prompt || "")
      .trim() ||
    "cinematic realistic scene";

  const imageUrl =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(
      finalPrompt
    )}?width=1280&height=720&model=flux&nologo=true`;

  console.log("");
  console.log(
    "Generating Pollinations image..."
  );
  console.log(
    finalPrompt
  );

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

  if (buffer.length < 1000) {
    throw new Error(
      "Image generation returned invalid data."
    );
  }

  const filename =
    `${prefix}_${uuidv4()}.jpg`;

  const outputPath =
    path.join(
      IMAGES_DIR,
      filename
    );

  fs.writeFileSync(
    outputPath,
    buffer
  );

  return {
    filename,

    url:
      `${getServerUrl()}/uploads/images/${filename}`,

    prompt: finalPrompt,
  };
}

// =========================================================
// GENERATE NORMAL IMAGE
// =========================================================

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

      const result =
        await generatePollinationsImage(
          finalPrompt,
          "image"
        );

      return res.json({
        success: true,

        imageUrl:
          result.url,

        url:
          result.url,

        filename:
          result.filename,

        prompt:
          result.prompt,
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

// =========================================================
// CHARACTER GENERATION
// =========================================================

app.post(
  "/api/generate-character",
  async (req, res) => {
    try {
      const {
        prompt,
        characterPrompt,
        description,
        characterDescription,
        name,
      } = req.body || {};

      const characterText =
        prompt ||
        characterPrompt ||
        description ||
        characterDescription ||
        name ||
        "friendly fantasy monster character";

      const finalPrompt = `
Full body character design of ${characterText}.

IMPORTANT:
- single character only
- full body visible from head to feet
- centered in the image
- standing upright
- arms and legs clearly separated from body
- front or slight 3/4 view
- no other people
- no objects covering the character
- bright solid green background
- studio lighting
- detailed realistic 3D character
- high quality
- animation-ready character reference
- 16:9 composition
`;

      const result =
        await generatePollinationsImage(
          finalPrompt,
          "character"
        );

      console.log(
        "Character saved:",
        result.url
      );

      return res.json({
        success: true,

        characterUrl:
          result.url,

        imageUrl:
          result.url,

        url:
          result.url,

        filename:
          result.filename,

        prompt:
          result.prompt,
      });
    } catch (error) {
      console.error(
        "CHARACTER GENERATION ERROR:",
        error
      );

      return res.status(500).json({
        success: false,

        error:
          error.message ||
          "Character generation failed.",
      });
    }
  }
);

// =========================================================
// BACKGROUND GENERATION
// =========================================================

app.post(
  "/api/generate-background",
  async (req, res) => {
    try {
      const {
        prompt,
        backgroundPrompt,
        description,
        sceneDescription,
      } = req.body || {};

      const backgroundText =
        prompt ||
        backgroundPrompt ||
        description ||
        sceneDescription ||
        "cinematic fantasy environment";

      const finalPrompt = `
Cinematic realistic environment background:

${backgroundText}

IMPORTANT:
- no people
- no characters
- no creatures
- no animals
- empty environment
- detailed cinematic lighting
- realistic
- wide 16:9 composition
- suitable as a background behind an animated character
`;

      const result =
        await generatePollinationsImage(
          finalPrompt,
          "background"
        );

      console.log(
        "Background saved:",
        result.url
      );

      return res.json({
        success: true,

        backgroundUrl:
          result.url,

        imageUrl:
          result.url,

        url:
          result.url,

        filename:
          result.filename,

        prompt:
          result.prompt,
      });
    } catch (error) {
      console.error(
        "BACKGROUND GENERATION ERROR:",
        error
      );

      return res.status(500).json({
        success: false,

        error:
          error.message ||
          "Background generation failed.",
      });
    }
  }
);

// =========================================================
// CHARACTER ANIMATION
// =========================================================

function normalizeAnimation(animation) {
  const value = String(
    animation || "idle"
  )
    .trim()
    .toLowerCase();

  const aliases = {
    talking: "talking",
    talk: "talking",

    walking: "walking",
    walk: "walking",

    running: "running",
    run: "running",

    jumping: "jumping",
    jump: "jumping",

    attacking: "attacking",
    attack: "attacking",

    dancing: "dancing",
    dance: "dancing",

    breathing: "breathing",

    idle: "idle",

    "talking-walking":
      "talking-walking",

    "talk-walking":
      "talking-walking",

    talkwalking:
      "talking-walking",
  };

  return (
    aliases[value] ||
    "idle"
  );
}

// =========================================================
// CHARACTER FILTER
// =========================================================

function buildCharacterFilter(
  animation,
  duration
) {
  const type =
    normalizeAnimation(
      animation
    );

  const d = Math.max(
    1,
    Number(duration) || 5
  );

  let xExpression =
    "W-w";

  let yExpression =
    "(H-h)/2";

  let scaleExpression =
    "1";

  switch (type) {
    case "talking":
      xExpression =
        "(W-w)/2+sin(t*7)*12";

      yExpression =
        "(H-h)/2+abs(sin(t*8))*8";

      scaleExpression =
        "1+0.015*sin(t*8)";

      break;

    case "walking":
      xExpression =
        "(W-w)/2+sin(t*2.8)*(W-w)*0.18";

      yExpression =
        "(H-h)/2+abs(sin(t*5.6))*18";

      scaleExpression =
        "1+0.01*sin(t*5.6)";

      break;

    case "running":
      xExpression =
        "(W-w)/2+sin(t*6)*(W-w)*0.30";

      yExpression =
        "(H-h)/2+abs(sin(t*12))*28";

      scaleExpression =
        "1+0.025*sin(t*12)";

      break;

    case "jumping":
      xExpression =
        "(W-w)/2+sin(t*2)*15";

      yExpression =
        "(H-h)/2-abs(sin(t*2.5))*100";

      scaleExpression =
        "1+0.025*sin(t*5)";

      break;

    case "attacking":
      xExpression =
        "(W-w)/2+sin(t*8)*45";

      yExpression =
        "(H-h)/2+abs(sin(t*8))*18";

      scaleExpression =
        "1+0.035*sin(t*8)";

      break;

    case "dancing":
      xExpression =
        "(W-w)/2+sin(t*3)*65";

      yExpression =
        "(H-h)/2+sin(t*6)*25";

      scaleExpression =
        "1+0.035*sin(t*6)";

      break;

    case "talking-walking":
      xExpression =
        "(W-w)/2+sin(t*2.8)*(W-w)*0.20";

      yExpression =
        "(H-h)/2+abs(sin(t*5.6))*20";

      scaleExpression =
        "1+0.02*sin(t*7)";

      break;

    case "breathing":
      xExpression =
        "(W-w)/2";

      yExpression =
        "(H-h)/2+sin(t*2)*5";

      scaleExpression =
        "1+0.012*sin(t*2)";

      break;

    case "idle":
    default:
      xExpression =
        "(W-w)/2+sin(t*1.5)*5";

      yExpression =
        "(H-h)/2+sin(t*2)*4";

      scaleExpression =
        "1+0.008*sin(t*2)";

      break;
  }

  return `
[1:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,fps=24[bg];

[2:v]
scale=640:-1,
fps=24,
format=rgba,
chromakey=0x00ff00:0.28:0.08,
scale=iw*${scaleExpression}:ih*${scaleExpression}:eval=frame[character];

[bg][character]
overlay=
x='${xExpression}':
y='${yExpression}':
eval=frame:
shortest=1
[out]
`;
}

// =========================================================
// RENDER CHARACTER VIDEO
// =========================================================

async function renderCharacterVideo({
  characterUrl,
  backgroundUrl,
  audioUrl,
  duration,
  animation,
}) {
  ensureFfmpegAvailable();

  const id =
    uuidv4();

  const backgroundPath =
    path.join(
      TEMP_DIR,
      `bg_${id}.jpg`
    );

  const characterPath =
    path.join(
      TEMP_DIR,
      `character_${id}.png`
    );

  const audioPath =
    path.join(
      TEMP_DIR,
      `audio_${id}.mp3`
    );

  const outputPath =
    path.join(
      VIDEOS_DIR,
      `character_${id}.mp4`
    );

  try {
    console.log("");
    console.log(
      "========================================"
    );
    console.log(
      "CHARACTER VIDEO"
    );
    console.log(
      "========================================"
    );
    console.log(
      "Animation:",
      animation
    );
    console.log(
      "Character:",
      characterUrl
    );
    console.log(
      "Background:",
      backgroundUrl
    );
    console.log(
      "Audio:",
      audioUrl
    );

    await downloadFile(
      backgroundUrl,
      backgroundPath
    );

    await downloadFile(
      characterUrl,
      characterPath
    );

    if (audioUrl) {
      await downloadFile(
        audioUrl,
        audioPath
      );
    }

    let actualDuration =
      Number(duration) || 5;

    if (
      audioUrl &&
      fs.existsSync(audioPath)
    ) {
      try {
        actualDuration =
          await getMediaDuration(
            audioPath
          );
      } catch (error) {
        console.warn(
          "Audio duration failed:",
          error.message
        );
      }
    }

    actualDuration =
      Math.max(
        1,
        Math.min(
          60,
          actualDuration
        )
      );

    const filter =
      buildCharacterFilter(
        animation,
        actualDuration
      );

    return await new Promise(
      (resolve, reject) => {
        let command =
          ffmpeg();

        command = command
          .input(backgroundPath)
          .inputOptions([
            "-loop 1",
          ])
          .input(characterPath)
          .inputOptions([
            "-loop 1",
          ]);

        if (
          audioUrl &&
          fs.existsSync(audioPath)
        ) {
          command = command
            .input(audioPath);
        }

        const inputsCount =
          audioUrl &&
          fs.existsSync(audioPath)
            ? 3
            : 2;

        const complexFilter =
          filter;

        let mapAudio =
          "";

        if (inputsCount === 3) {
          mapAudio =
            "[2:a]";
        }

        command
          .complexFilter(
            complexFilter
          )
          .outputOptions([
            "-map [out]",

            ...(mapAudio
              ? [
                  `-map ${mapAudio}`,
                ]
              : []),

            "-c:v libx264",

            "-preset ultrafast",

            "-crf 27",

            "-pix_fmt yuv420p",

            "-r 24",

            "-t",
            String(
              actualDuration
            ),

            ...(mapAudio
              ? [
                  "-c:a aac",
                  "-b:a 128k",
                ]
              : []),

            "-shortest",

            "-movflags +faststart",

            "-threads 1",
          ])
          .on(
            "start",
            (commandLine) => {
              console.log(
                "Character FFmpeg:",
                commandLine
              );
            }
          )
          .on(
            "progress",
            (progress) => {
              console.log(
                `Character progress: ${Math.round(
                  progress.percent || 0
                )}%`
              );
            }
          )
          .on(
            "error",
            (error) => {
              console.error(
                "Character FFmpeg error:",
                error
              );

              safeDelete(
                outputPath
              );

              reject(error);
            }
          )
          .on(
            "end",
            () => {
              console.log(
                "Character video complete:",
                outputPath
              );

              if (
                !fs.existsSync(
                  outputPath
                )
              ) {
                return reject(
                  new Error(
                    "Character video was not created."
                  )
                );
              }

              const videoUrl =
                `${getServerUrl()}/uploads/videos/${path.basename(
                  outputPath
                )}`;

              resolve({
                videoUrl,

                url:
                  videoUrl,

                filename:
                  path.basename(
                    outputPath
                  ),

                duration:
                  actualDuration,
              });
            }
          )
          .save(outputPath);
      }
    );
  } finally {
    safeDelete(backgroundPath);
    safeDelete(characterPath);
    safeDelete(audioPath);
  }
}

// =========================================================
// GENERATE CHARACTER VIDEO
// =========================================================

app.post(
  "/api/generate-character-video",
  async (req, res) => {
    try {
      const {
        characterUrl,
        characterImageUrl,
        backgroundUrl,
        backgroundImageUrl,
        audioUrl,
        duration,
        animation,
      } = req.body || {};

      const finalCharacterUrl =
        characterUrl ||
        characterImageUrl;

      const finalBackgroundUrl =
        backgroundUrl ||
        backgroundImageUrl;

      if (!finalCharacterUrl) {
        return res.status(400).json({
          success: false,
          error:
            "characterUrl is required.",
        });
      }

      if (!finalBackgroundUrl) {
        return res.status(400).json({
          success: false,
          error:
            "backgroundUrl is required.",
        });
      }

      const result =
        await renderCharacterVideo({
          characterUrl:
            finalCharacterUrl,

          backgroundUrl:
            finalBackgroundUrl,

          audioUrl,

          duration:
            Number(duration) || 5,

          animation:
            animation || "talking",
        });

      return res.json({
        success: true,

        videoUrl:
          result.videoUrl,

        url:
          result.url,

        filename:
          result.filename,

        duration:
          result.duration,

        animation:
          normalizeAnimation(
            animation
          ),
      });
    } catch (error) {
      console.error(
        "CHARACTER VIDEO ERROR:",
        error
      );

      return res.status(500).json({
        success: false,

        error:
          error.message ||
          "Character video generation failed.",
      });
    }
  }
);

// =========================================================
// NORMAL SCENE VIDEO
// =========================================================

async function renderSceneVideo({
  imageUrl,
  audioUrl,
  duration,
}) {
  ensureFfmpegAvailable();

  const id =
    uuidv4();

  const imagePath =
    path.join(
      TEMP_DIR,
      `scene_${id}.jpg`
    );

  const audioPath =
    path.join(
      TEMP_DIR,
      `scene_audio_${id}.mp3`
    );

  const outputPath =
    path.join(
      VIDEOS_DIR,
      `scene_${id}.mp4`
    );

  try {
    await downloadFile(
      imageUrl,
      imagePath
    );

    if (audioUrl) {
      await downloadFile(
        audioUrl,
        audioPath
      );
    }

    let actualDuration =
      Number(duration) || 5;

    if (
      audioUrl &&
      fs.existsSync(audioPath)
    ) {
      try {
        actualDuration =
          await getMediaDuration(
            audioPath
          );
      } catch (error) {
        console.warn(
          "Audio duration failed:",
          error.message
        );
      }
    }

    actualDuration =
      Math.max(
        1,
        Math.min(
          60,
          actualDuration
        )
      );

    return await new Promise(
      (resolve, reject) => {
        let command =
          ffmpeg(imagePath)
            .inputOptions([
              "-loop 1",
            ]);

        if (
          audioUrl &&
          fs.existsSync(audioPath)
        ) {
          command =
            command.input(
              audioPath
            );
        }

        const filter =
          [
            "[0:v]",
            "scale=1280:720:force_original_aspect_ratio=increase,",
            "crop=1280:720,",
            "zoompan=z='min(zoom+0.0008,1.15)':",
            "x='iw/2-(iw/zoom/2)+sin(on/20)*20':",
            "y='ih/2-(ih/zoom/2)':",
            "d=1:",
            "s=1280x720:",
            "fps=24",
            "[v]",
          ].join("");

        const options = [
          "-map [v]",
        ];

        if (
          audioUrl &&
          fs.existsSync(audioPath)
        ) {
          options.push(
            "-map 1:a",
            "-c:a aac",
            "-b:a 128k"
          );
        }

        options.push(
          "-c:v libx264",
          "-preset ultrafast",
          "-crf 28",
          "-pix_fmt yuv420p",
          "-r 24",
          "-t",
          String(actualDuration),
          "-shortest",
          "-movflags +faststart",
          "-threads 1"
        );

        command
          .complexFilter(filter)
          .outputOptions(options)
          .on(
            "start",
            (commandLine) => {
              console.log(
                "Scene FFmpeg:",
                commandLine
              );
            }
          )
          .on(
            "progress",
            (progress) => {
              console.log(
                `Scene progress: ${Math.round(
                  progress.percent || 0
                )}%`
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

              safeDelete(
                outputPath
              );

              reject(error);
            }
          )
          .on(
            "end",
            () => {
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

              const videoUrl =
                `${getServerUrl()}/uploads/videos/${path.basename(
                  outputPath
                )}`;

              resolve({
                videoUrl,

                url:
                  videoUrl,

                filename:
                  path.basename(
                    outputPath
                  ),

                duration:
                  actualDuration,
              });
            }
          )
          .save(outputPath);
      }
    );
  } finally {
    safeDelete(imagePath);
    safeDelete(audioPath);
  }
}

// =========================================================
// GENERATE SCENE VIDEO
// =========================================================

app.post(
  "/api/generate-scene-video",
  async (req, res) => {
    try {
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

      const result =
        await renderSceneVideo({
          imageUrl,

          audioUrl,

          duration:
            Number(duration) || 5,
        });

      return res.json({
        success: true,

        videoUrl:
          result.videoUrl,

        url:
          result.url,

        filename:
          result.filename,

        duration:
          result.duration,
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
    }
  }
);

// =========================================================
// CONCAT SCENE VIDEOS
// =========================================================

async function concatSceneVideos(
  videoPaths
) {
  ensureFfmpegAvailable();

  if (
    !Array.isArray(videoPaths) ||
    videoPaths.length === 0
  ) {
    throw new Error(
      "No scene videos provided."
    );
  }

  const id =
    uuidv4();

  const concatFile =
    path.join(
      TEMP_DIR,
      `concat_${id}.txt`
    );

  const outputPath =
    path.join(
      VIDEOS_DIR,
      `final_${id}.mp4`
    );

  try {
    const content =
      videoPaths
        .map(
          (file) =>
            `file '${file.replace(
              /'/g,
              "'\\''"
            )}'`
        )
        .join("\n");

    fs.writeFileSync(
      concatFile,
      content
    );

    await new Promise(
      (resolve, reject) => {
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
          .save(outputPath);
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

    return outputPath;
  } finally {
    safeDelete(
      concatFile
    );
  }
}

// =========================================================
// GENERATE FINAL VIDEO
// =========================================================

app.post(
  "/api/generate-final-video",
  async (req, res) => {
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
            "scenes array is required.",
        });
      }

      console.log("");
      console.log(
        "========================================"
      );
      console.log(
        "GENERATING FINAL VIDEO"
      );
      console.log(
        "Scenes:",
        scenes.length
      );
      console.log(
        "========================================"
      );

      const sceneVideos = [];

      for (
        let i = 0;
        i < scenes.length;
        i++
      ) {
        const scene =
          scenes[i];

        console.log("");
        console.log(
          `Processing scene ${i + 1}/${scenes.length}`
        );

        let result;

        if (
          scene.characterUrl &&
          scene.backgroundUrl
        ) {
          console.log(
            "Using CHARACTER ANIMATION"
          );

          result =
            await renderCharacterVideo({
              characterUrl:
                scene.characterUrl,

              backgroundUrl:
                scene.backgroundUrl,

              audioUrl:
                scene.audioUrl ||
                scene.voiceUrl ||
                scene.audio,

              duration:
                Number(
                  scene.duration
                ) || 5,

              animation:
                scene.animation ||
                "talking",
            });
        } else if (
          scene.imageUrl
        ) {
          console.log(
            "Using NORMAL SCENE ANIMATION"
          );

          result =
            await renderSceneVideo({
              imageUrl:
                scene.imageUrl,

              audioUrl:
                scene.audioUrl ||
                scene.voiceUrl ||
                scene.audio,

              duration:
                Number(
                  scene.duration
                ) || 5,
            });
        } else {
          throw new Error(
            `Scene ${
              i + 1
            } has no imageUrl or characterUrl/backgroundUrl.`
          );
        }

        const filename =
          path.basename(
            result.videoUrl
          );

        const videoPath =
          path.join(
            VIDEOS_DIR,
            filename
          );

        sceneVideos.push(
          videoPath
        );
      }

      const finalPath =
        await concatSceneVideos(
          sceneVideos
        );

      const finalUrl =
        `${getServerUrl()}/uploads/videos/${path.basename(
          finalPath
        )}`;

      console.log("");
      console.log(
        "========================================"
      );
      console.log(
        "FINAL VIDEO READY"
      );
      console.log(
        finalUrl
      );
      console.log(
        "========================================"
      );

      return res.json({
        success: true,

        videoUrl:
          finalUrl,

        url:
          finalUrl,

        filename:
          path.basename(
            finalPath
          ),
      });
    } catch (error) {
      console.error(
        "FINAL VIDEO ERROR:",
        error
      );

      return res.status(500).json({
        success: false,

        error:
          error.message ||
          "Final video generation failed.",
      });
    }
  }
);

// =========================================================
// GENERATE VIDEO ALIAS
// =========================================================

app.post(
  "/api/generate-video",
  async (req, res) => {
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
            "scenes array is required.",
        });
      }

      req.body.scenes =
        scenes;

      return generateFinalVideoHandler(
        req,
        res
      );
    } catch (error) {
      console.error(
        "GENERATE VIDEO ERROR:",
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

// =========================================================
// SHARED FINAL VIDEO HANDLER
// =========================================================

async function generateFinalVideoHandler(
  req,
  res
) {
  try {
    const {
      scenes,
    } = req.body || {};

    const sceneVideos = [];

    for (
      let i = 0;
      i < scenes.length;
      i++
    ) {
      const scene =
        scenes[i];

      let result;

      if (
        scene.characterUrl &&
        scene.backgroundUrl
      ) {
        result =
          await renderCharacterVideo({
            characterUrl:
              scene.characterUrl,

            backgroundUrl:
              scene.backgroundUrl,

            audioUrl:
              scene.audioUrl ||
              scene.voiceUrl ||
              scene.audio,

            duration:
              Number(
                scene.duration
              ) || 5,

            animation:
              scene.animation ||
              "talking",
          });
      } else if (
        scene.imageUrl
      ) {
        result =
          await renderSceneVideo({
            imageUrl:
              scene.imageUrl,

            audioUrl:
              scene.audioUrl ||
              scene.voiceUrl ||
              scene.audio,

            duration:
              Number(
                scene.duration
              ) || 5,
          });
      } else {
        throw new Error(
          `Scene ${
            i + 1
          } has no valid media.`
        );
      }

      sceneVideos.push(
        path.join(
          VIDEOS_DIR,
          path.basename(
            result.videoUrl
          )
        )
      );
    }

    const finalPath =
      await concatSceneVideos(
        sceneVideos
      );

    const finalUrl =
      `${getServerUrl()}/uploads/videos/${path.basename(
        finalPath
      )}`;

    return res.json({
      success: true,

      videoUrl:
        finalUrl,

      url:
        finalUrl,

      filename:
        path.basename(
          finalPath
        ),
    });
  } catch (error) {
    console.error(
      "FINAL VIDEO HANDLER ERROR:",
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

// =========================================================
// FFMPEG TEST
// =========================================================

app.get(
  "/api/test-ffmpeg",
  (req, res) => {
    try {
      ensureFfmpegAvailable();

      return res.json({
        success: true,

        ffmpeg:
          resolvedFfmpegPath,

        ffprobe:
          resolvedFfprobePath,
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

// =========================================================
// HEALTH
// =========================================================

app.get(
  "/api/health",
  (req, res) => {
    return res.json({
      success: true,

      status: "healthy",

      server:
        getServerUrl(),

      port: PORT,

      ffmpeg:
        !!resolvedFfmpegPath &&
        fs.existsSync(
          resolvedFfmpegPath
        ),

      ffprobe:
        !!resolvedFfprobePath &&
        fs.existsSync(
          resolvedFfprobePath
        ),

      elevenlabs:
        !!ELEVENLABS_API_KEY,

      characterGeneration:
        true,

      characterAnimation:
        true,

      routes: {
        character:
          "/api/generate-character",

        background:
          "/api/generate-background",

        characterVideo:
          "/api/generate-character-video",

        sceneVideo:
          "/api/generate-scene-video",

        finalVideo:
          "/api/generate-final-video",

        generateVideo:
          "/api/generate-video",

        voice:
          "/api/generate-voice",

        image:
          "/api/generate-image",
      },
    });
  }
);

// =========================================================
// TEST
// =========================================================

app.get(
  "/api/test",
  (req, res) => {
    res.json({
      success: true,

      message:
        "AI Video Studio API is working.",

      server:
        getServerUrl(),

      time:
        new Date().toISOString(),
    });
  }
);

// =========================================================
// ROOT
// =========================================================

app.get(
  "/",
  (req, res) => {
    res.json({
      success: true,

      message:
        "AI Video Studio Server",

      server:
        getServerUrl(),

      health:
        "/api/health",

      test:
        "/api/test",
    });
  }
);

// =========================================================
// 404
// =========================================================

app.use(
  (req, res) => {
    return res.status(404).json({
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

// =========================================================
// ERROR HANDLER
// =========================================================

app.use(
  (error, req, res, next) => {
    console.error(
      "SERVER ERROR:",
      error
    );

    return res.status(500).json({
      success: false,

      error:
        error.message ||
        "Internal server error.",
    });
  }
);

// =========================================================
// START SERVER
// =========================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log("");
    console.log(
      "========================================"
    );
    console.log(
      "      AI VIDEO STUDIO SERVER"
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
      "Images:",
      `${getServerUrl()}/uploads/images`
    );

    console.log(
      "Audio:",
      `${getServerUrl()}/uploads/audio`
    );

    console.log(
      "Videos:",
      `${getServerUrl()}/uploads/videos`
    );

    console.log(
      "ElevenLabs:",
      ELEVENLABS_API_KEY
        ? "Configured ✓"
        : "NOT CONFIGURED ✗"
    );

    console.log(
      "FFmpeg:",
      resolvedFfmpegPath
        ? "Configured ✓"
        : "NOT CONFIGURED ✗"
    );

    console.log(
      "FFprobe:",
      resolvedFfprobePath
        ? "Configured ✓"
        : "NOT CONFIGURED ✗"
    );

    console.log(
      "Character Generation: READY ✓"
    );

    console.log(
      "Character Animation: READY ✓"
    );

    console.log(
      "Health:",
      `${getServerUrl()}/api/health`
    );

    console.log(
      "========================================"
    );
    console.log("");
  }
);

