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

const MAX_VIDEO_DURATION = 60;

const ROOT_DIR = __dirname;

const UPLOADS_DIR = path.join(ROOT_DIR, "uploads");

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

/* =========================================================
   CREATE DIRECTORIES
========================================================= */

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

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

if (ffprobeStatic && ffprobeStatic.path) {
  ffmpeg.setFfprobePath(ffprobeStatic.path);
}

/* =========================================================
   CORS
========================================================= */

const allowedOrigins = [
  "https://ai-video-studio-542c9.web.app",
  "https://ai-video-studio-542c9.firebaseapp.com",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.log("CORS blocked:", origin);

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
};

app.use(cors(corsOptions));

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
  express.static(UPLOADS_DIR)
);

/* =========================================================
   MULTER
========================================================= */

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const field = file.fieldname || "";

    if (
      field === "image" ||
      field === "character" ||
      field === "background"
    ) {
      cb(null, IMAGES_DIR);
      return;
    }

    if (field === "audio") {
      cb(null, AUDIO_DIR);
      return;
    }

    cb(null, TEMP_DIR);
  },

  filename: function (req, file, cb) {
    const extension =
      path.extname(file.originalname || "") ||
      ".bin";

    const filename =
      `${uuidv4()}${extension}`;

    cb(null, filename);
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

function getServerUrl(req) {
  if (SERVER_URL) {
    return SERVER_URL.replace(/\/$/, "");
  }

  const protocol =
    req.headers["x-forwarded-proto"] ||
    req.protocol ||
    "http";

  return `${protocol}://${req.get("host")}`;
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
      "Could not delete file:",
      filePath,
      error.message
    );
  }
}

function ensureFfmpegAvailable() {
  if (!ffmpegStatic) {
    throw new Error(
      "ffmpeg-static is not available"
    );
  }

  if (
    !ffprobeStatic ||
    !ffprobeStatic.path
  ) {
    throw new Error(
      "ffprobe-static is not available"
    );
  }
}

function getMediaDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(
      filePath,
      (error, metadata) => {
        if (error) {
          reject(error);
          return;
        }

        const duration = Number(
          metadata?.format?.duration
        );

        if (
          !Number.isFinite(duration) ||
          duration <= 0
        ) {
          reject(
            new Error(
              "Could not determine media duration"
            )
          );
          return;
        }

        resolve(duration);
      }
    );
  });
}

/* =========================================================
   DOWNLOAD FILE
========================================================= */

function downloadFile(url, destination) {
  return new Promise(
    (resolve, reject) => {
      if (!url) {
        reject(
          new Error(
            "Download URL is empty"
          )
        );
        return;
      }

      const protocol = url.startsWith(
        "https://"
      )
        ? https
        : http;

      const file = fs.createWriteStream(
        destination
      );

      const request = protocol.get(
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
            file.close();
            safeDelete(destination);

            downloadFile(
              response.headers.location,
              destination
            )
              .then(resolve)
              .catch(reject);

            return;
          }

          if (
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            file.close();
            safeDelete(destination);

            reject(
              new Error(
                `Download failed with HTTP ${response.statusCode}`
              )
            );

            return;
          }

          response.pipe(file);

          file.on(
            "finish",
            () => {
              file.close(() => {
                resolve(destination);
              });
            }
          );
        }
      );

      request.on(
        "error",
        (error) => {
          file.close();
          safeDelete(destination);
          reject(error);
        }
      );

      file.on(
        "error",
        (error) => {
          request.destroy();
          file.close();
          safeDelete(destination);
          reject(error);
        }
      );
    }
  );
}

/* =========================================================
   NORMALIZE MEDIA URL
========================================================= */

function normalizeMediaUrl(
  value,
  req
) {
  if (!value) {
    return "";
  }

  const text = String(value).trim();

  if (!text) {
    return "";
  }

  if (
    text.startsWith("http://") ||
    text.startsWith("https://")
  ) {
    return text;
  }

  if (text.startsWith("/uploads/")) {
    return `${getServerUrl(req)}${text}`;
  }

  if (text.startsWith("uploads/")) {
    return `${getServerUrl(req)}/${text}`;
  }

  return text;
}

/* =========================================================
   ELEVENLABS VOICES
========================================================= */

const VOICES = {
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
      serverUrl: getServerUrl(req),
      port: PORT,
      ffmpeg: Boolean(ffmpegStatic),
      ffprobe: Boolean(
        ffprobeStatic &&
          ffprobeStatic.path
      ),
      elevenLabs:
        Boolean(ELEVENLABS_API_KEY),
      directories: {
        uploads: UPLOADS_DIR,
        images: IMAGES_DIR,
        audio: AUDIO_DIR,
        videos: VIDEOS_DIR,
        temp: TEMP_DIR,
      },
      time: new Date().toISOString(),
    });
  }
);

/* =========================================================
   TEST
========================================================= */

app.get(
  "/api/test",
  (req, res) => {
    res.json({
      success: true,
      message:
        "AI Video API is working",
    });
  }
);

/* =========================================================
   TEST FFMPEG
========================================================= */

app.get(
  "/api/test-ffmpeg",
  async (req, res) => {
    try {
      ensureFfmpegAvailable();

      const outputPath =
        path.join(
          TEMP_DIR,
          `ffmpeg-test-${uuidv4()}.mp4`
        );

      await new Promise(
        (resolve, reject) => {
          ffmpeg()
            .input(
              "color=c=blue:s=640x360"
            )
            .inputOptions([
              "-f",
              "lavfi",
              "-t",
              "2",
            ])
            .videoCodec("libx264")
            .outputOptions([
              "-pix_fmt",
              "yuv420p",
              "-movflags",
              "+faststart",
            ])
            .duration(2)
            .output(outputPath)
            .on(
              "start",
              (command) => {
                console.log(
                  "Test FFmpeg:",
                  command
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
            .run();
        }
      );

      const exists =
        fs.existsSync(outputPath);

      const size = exists
        ? fs.statSync(
            outputPath
          ).size
        : 0;

      safeDelete(outputPath);

      res.json({
        success: true,
        ffmpeg: true,
        outputExists: exists,
        size,
      });
    } catch (error) {
      console.error(
        "FFmpeg test failed:",
        error
      );

      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
);

/* =========================================================
   GENERATE IMAGE
   Pollinations Flux
========================================================= */

app.post(
  "/api/generate-image",
  async (req, res) => {
    try {
      const {
        prompt,
        width = 1280,
        height = 720,
      } = req.body || {};

      if (!prompt) {
        return res.status(400).json({
          success: false,
          error:
            "Prompt is required",
        });
      }

      const encodedPrompt =
        encodeURIComponent(prompt);

      const imageUrl =
        `https://image.pollinations.ai/prompt/${encodedPrompt}` +
        `?width=${width}` +
        `&height=${height}` +
        `&model=flux` +
        `&nologo=true`;

      const filename =
        `image_${uuidv4()}.jpg`;

      const outputPath =
        path.join(
          IMAGES_DIR,
          filename
        );

      console.log(
        "Generating image:",
        prompt
      );

      await downloadFile(
        imageUrl,
        outputPath
      );

      if (
        !fs.existsSync(outputPath)
      ) {
        throw new Error(
          "Generated image was not saved"
        );
      }

      const size =
        fs.statSync(
          outputPath
        ).size;

      if (size < 1000) {
        throw new Error(
          "Generated image is too small"
        );
      }

      const publicUrl =
        `${getServerUrl(req)}/uploads/images/${filename}`;

      res.json({
        success: true,
        imageUrl: publicUrl,
        url: publicUrl,
        fileUrl: publicUrl,
        prompt,
      });
    } catch (error) {
      console.error(
        "Image generation failed:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          error.message ||
          "Image generation failed",
      });
    }
  }
);

/* =========================================================
   UPLOAD IMAGE / CHARACTER / BACKGROUND
========================================================= */

app.post(
  "/api/upload",
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error:
            "No image uploaded",
        });
      }

      const filename =
        req.file.filename;

      const publicUrl =
        `${getServerUrl(req)}/uploads/images/${filename}`;

      console.log(
        "Image uploaded:",
        publicUrl
      );

      res.json({
        success: true,
        fileUrl: publicUrl,
        url: publicUrl,
        imageUrl: publicUrl,
        filename,
        size: req.file.size,
      });
    } catch (error) {
      console.error(
        "Upload failed:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          error.message ||
          "Upload failed",
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
        prompt,
        characterPrompt,
      } = req.body || {};

      const finalPrompt =
        characterPrompt ||
        prompt;

      if (!finalPrompt) {
        return res.status(400).json({
          success: false,
          error:
            "Character prompt is required",
        });
      }

      const enhancedPrompt =
        `${finalPrompt}, ` +
        `full body character, isolated character, ` +
        `front view, standing pose, ` +
        `green screen background, ` +
        `consistent character design, ` +
        `high quality, detailed, cinematic`;

      const encodedPrompt =
        encodeURIComponent(
          enhancedPrompt
        );

      const imageUrl =
        `https://image.pollinations.ai/prompt/${encodedPrompt}` +
        `?width=1024` +
        `&height=1024` +
        `&model=flux` +
        `&nologo=true`;

      const filename =
        `character_${uuidv4()}.jpg`;

      const outputPath =
        path.join(
          IMAGES_DIR,
          filename
        );

      console.log(
        "Generating character:",
        enhancedPrompt
      );

      await downloadFile(
        imageUrl,
        outputPath
      );

      const publicUrl =
        `${getServerUrl(req)}/uploads/images/${filename}`;

      res.json({
        success: true,
        characterUrl: publicUrl,
        imageUrl: publicUrl,
        url: publicUrl,
        prompt:
          enhancedPrompt,
      });
    } catch (error) {
      console.error(
        "Character generation failed:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          error.message ||
          "Character generation failed",
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
        prompt,
        backgroundPrompt,
      } = req.body || {};

      const finalPrompt =
        backgroundPrompt ||
        prompt;

      if (!finalPrompt) {
        return res.status(400).json({
          success: false,
          error:
            "Background prompt is required",
        });
      }

      const enhancedPrompt =
        `${finalPrompt}, ` +
        `cinematic environment, ` +
        `wide landscape, ` +
        `16:9 composition, ` +
        `high detail, realistic lighting`;

      const encodedPrompt =
        encodeURIComponent(
          enhancedPrompt
        );

      const imageUrl =
        `https://image.pollinations.ai/prompt/${encodedPrompt}` +
        `?width=1280` +
        `&height=720` +
        `&model=flux` +
        `&nologo=true`;

      const filename =
        `background_${uuidv4()}.jpg`;

      const outputPath =
        path.join(
          IMAGES_DIR,
          filename
        );

      console.log(
        "Generating background:",
        enhancedPrompt
      );

      await downloadFile(
        imageUrl,
        outputPath
      );

      const publicUrl =
        `${getServerUrl(req)}/uploads/images/${filename}`;

      res.json({
        success: true,
        backgroundUrl: publicUrl,
        imageUrl: publicUrl,
        url: publicUrl,
        prompt:
          enhancedPrompt,
      });
    } catch (error) {
      console.error(
        "Background generation failed:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          error.message ||
          "Background generation failed",
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
            "ELEVENLABS_API_KEY is not configured",
        });
      }

      const {
        text,
        voice = "Female",
        voiceId,
      } = req.body || {};

      if (!text) {
        return res.status(400).json({
          success: false,
          error:
            "Text is required",
        });
      }

      const selectedVoice =
        voiceId ||
        VOICES[voice] ||
        VOICES.Female;

      console.log(
        "Generating voice:",
        voice
      );

      const url =
        `https://api.elevenlabs.io/v1/text-to-speech/${selectedVoice}`;

      const response =
        await fetch(url, {
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
              "eleven_multilingual_v2",

            voice_settings: {
              stability: 0.45,
              similarity_boost: 0.8,
              style: 0.25,
              use_speaker_boost:
                true,
            },
          }),
        });

      if (!response.ok) {
        const errorText =
          await response.text();

        throw new Error(
          `ElevenLabs HTTP ${response.status}: ${errorText}`
        );
      }

      const audioBuffer =
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
        audioBuffer
      );

      const publicUrl =
        `${getServerUrl(req)}/uploads/audio/${filename}`;

      let duration = null;

      try {
        duration =
          await getMediaDuration(
            outputPath
          );
      } catch (durationError) {
        console.log(
          "Could not read audio duration:",
          durationError.message
        );
      }

      res.json({
        success: true,
        audioUrl: publicUrl,
        url: publicUrl,
        audio: publicUrl,
        duration,
        voice,
      });
    } catch (error) {
      console.error(
        "Voice generation failed:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          error.message ||
          "Voice generation failed",
      });
    }
  }
);

/* =========================================================
   CHARACTER ANIMATION
========================================================= */

function normalizeAnimation(
  animation
) {
  const value =
    String(
      animation || "idle"
    )
      .toLowerCase()
      .trim();

  const aliases = {
    talk: "talking",
    speak: "talking",
    speaking: "talking",

    walk: "walking",

    run: "running",

    jump: "jumping",

    attack: "attacking",

    dance: "dancing",

    breathe: "breathing",

    rest: "idle",
  };

  return (
    aliases[value] ||
    value
  );
}

/* =========================================================
   BUILD CHARACTER MOVEMENT
========================================================= */

function buildCharacterFilter(
  animation
) {
  const type =
    normalizeAnimation(
      animation
    );

  let x =
    "(W-w)/2";

  let y =
    "(H-h)/2";

  let rotation =
    "0";

  let scale =
    "min(520/iw\\,520/ih)";

  switch (type) {
    case "talking":
      y =
        "(H-h)/2 + 8*sin(2*PI*t*2.5)";
      scale =
        "min(520/iw\\,520/ih)*(1+0.025*sin(2*PI*t*3))";
      rotation =
        "0.018*sin(2*PI*t*2)";
      break;

    case "walking":
      x =
        "(W-w)/2 + 90*sin(2*PI*t*0.8)";
      y =
        "(H-h)/2 + 12*abs(sin(2*PI*t*1.6))";
      rotation =
        "0.035*sin(2*PI*t*0.8)";
      break;

    case "running":
      x =
        "(W-w)/2 + 160*sin(2*PI*t*1.2)";
      y =
        "(H-h)/2 + 22*abs(sin(2*PI*t*2.4))";
      rotation =
        "0.055*sin(2*PI*t*1.2)";
      scale =
        "min(520/iw\\,520/ih)*(1+0.035*sin(2*PI*t*2.4))";
      break;

    case "jumping":
      y =
        "(H-h)/2 - 110*abs(sin(PI*t*0.9))";
      rotation =
        "0.025*sin(2*PI*t*0.9)";
      break;

    case "attacking":
      x =
        "(W-w)/2 + 70*sin(2*PI*t*1.8)";
      y =
        "(H-h)/2 + 10*sin(2*PI*t*3.6)";
      rotation =
        "0.12*sin(2*PI*t*1.8)";
      scale =
        "min(520/iw\\,520/ih)*(1+0.06*sin(2*PI*t*1.8))";
      break;

    case "dancing":
      x =
        "(W-w)/2 + 85*sin(2*PI*t*1.1)";
      y =
        "(H-h)/2 + 35*sin(2*PI*t*2.2)";
      rotation =
        "0.12*sin(2*PI*t*1.1)";
      scale =
        "min(520/iw\\,520/ih)*(1+0.04*sin(2*PI*t*2.2))";
      break;

    case "breathing":
      y =
        "(H-h)/2 + 5*sin(2*PI*t*1.2)";
      scale =
        "min(520/iw\\,520/ih)*(1+0.035*sin(2*PI*t*1.2))";
      break;

    case "talking-walking":
      x =
        "(W-w)/2 + 100*sin(2*PI*t*0.8)";
      y =
        "(H-h)/2 + 12*abs(sin(2*PI*t*1.6)) + 7*sin(2*PI*t*2.5)";
      rotation =
        "0.04*sin(2*PI*t*0.8)";
      scale =
        "min(520/iw\\,520/ih)*(1+0.025*sin(2*PI*t*3))";
      break;

    case "idle":
    default:
      y =
        "(H-h)/2 + 5*sin(2*PI*t*0.7)";
      scale =
        "min(520/iw\\,520/ih)*(1+0.015*sin(2*PI*t*0.7))";
      break;
  }

  return {
    x,
    y,
    rotation,
    scale,
  };
}

/* =========================================================
   RENDER CHARACTER VIDEO
   IMPORTANT FIXED VERSION
========================================================= */

async function renderCharacterVideo({
  backgroundPath,
  characterPath,
  audioPath,
  outputPath,
  animation = "idle",
  requestedDuration,
}) {
  ensureFfmpegAvailable();

  console.log(
    "======================================"
  );

  console.log(
    "CHARACTER VIDEO RENDER"
  );

  console.log(
    "Background:",
    backgroundPath
  );

  console.log(
    "Character:",
    characterPath
  );

  console.log(
    "Audio:",
    audioPath
  );

  console.log(
    "Animation:",
    animation
  );

  console.log(
    "======================================"
  );

  if (
    !fs.existsSync(backgroundPath)
  ) {
    throw new Error(
      `Background file does not exist: ${backgroundPath}`
    );
  }

  if (
    !fs.existsSync(characterPath)
  ) {
    throw new Error(
      `Character file does not exist: ${characterPath}`
    );
  }

  if (
    !fs.existsSync(audioPath)
  ) {
    throw new Error(
      `Audio file does not exist: ${audioPath}`
    );
  }

  const backgroundSize =
    fs.statSync(
      backgroundPath
    ).size;

  const characterSize =
    fs.statSync(
      characterPath
    ).size;

  const audioSize =
    fs.statSync(
      audioPath
    ).size;

  console.log(
    "Background size:",
    backgroundSize
  );

  console.log(
    "Character size:",
    characterSize
  );

  console.log(
    "Audio size:",
    audioSize
  );

  if (
    backgroundSize < 100
  ) {
    throw new Error(
      "Background file is invalid"
    );
  }

  if (
    characterSize < 100
  ) {
    throw new Error(
      "Character file is invalid"
    );
  }

  if (
    audioSize < 100
  ) {
    throw new Error(
      "Audio file is invalid"
    );
  }

  const audioDuration =
    await getMediaDuration(
      audioPath
    );

  console.log(
    "Audio duration:",
    audioDuration
  );

  let duration =
    Number(
      requestedDuration
    );

  if (
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    duration =
      audioDuration;
  }

  duration = Math.max(
    duration,
    audioDuration
  );

  duration = Math.min(
    duration,
    MAX_VIDEO_DURATION
  );

  duration =
    Math.ceil(duration * 100) /
    100;

  console.log(
    "Final character duration:",
    duration
  );

  const movement =
    buildCharacterFilter(
      animation
    );

  const filterComplex = `
[0:v]
scale=1280:720:force_original_aspect_ratio=increase,
crop=1280:720,
setsar=1,
fps=24,
format=yuv420p
[bg];

[1:v]
scale=520:520:force_original_aspect_ratio=decrease,
format=rgba,
chromakey=0x00ff00:0.25:0.08,
fps=24,
setpts=PTS-STARTPTS
[char];

[char]
scale=
'520*${movement.scale}':
'520*${movement.scale}':
force_original_aspect_ratio=decrease
[char2];

[char2]
rotate=${movement.rotation}:c=none:ow=rotw(iw):oh=roth(ih):fillcolor=0x00000000
[rotated];

[bg][rotated]
overlay=
x=${movement.x}:
y=${movement.y}:
eval=frame
[video]
`;

  console.log(
    "Animation filter:",
    filterComplex
  );

  await new Promise(
    (resolve, reject) => {
      const command =
        ffmpeg()
          /*
             IMPORTANT:
             Explicitly loop the image inputs
             and explicitly set their frame rate.
          */
          .input(
            backgroundPath
          )
          .inputOptions([
            "-loop",
            "1",
            "-framerate",
            "24",
          ])

          .input(
            characterPath
          )
          .inputOptions([
            "-loop",
            "1",
            "-framerate",
            "24",
          ])

          .input(audioPath)

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
            "27",

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
            String(duration),

            "-movflags",
            "+faststart",

            "-threads",
            "1",
          ])

          /*
             DO NOT use -shortest here.
             Audio/image looping is controlled
             by explicit duration.
          */
          .output(outputPath)

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
              const percent =
                Number(
                  progress.percent
                );

              if (
                Number.isFinite(
                  percent
                )
              ) {
                console.log(
                  `Character progress: ${percent.toFixed(
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
                "Character FFmpeg:",
                line
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

              reject(error);
            }
          )

          .on(
            "end",
            () => {
              console.log(
                "Character FFmpeg finished"
              );

              resolve();
            }
          );

      command.run();
    }
  );

  if (
    !fs.existsSync(outputPath)
  ) {
    throw new Error(
      "Character video was not created"
    );
  }

  const outputSize =
    fs.statSync(
      outputPath
    ).size;

  console.log(
    "Character output size:",
    outputSize
  );

  if (outputSize < 1000) {
    throw new Error(
      "Character video output is too small"
    );
  }

  /* =====================================================
     VALIDATE VIDEO STREAMS
  ===================================================== */

  const metadata =
    await new Promise(
      (resolve, reject) => {
        ffmpeg.ffprobe(
          outputPath,
          (
            error,
            data
          ) => {
            if (error) {
              reject(error);
              return;
            }

            resolve(data);
          }
        );
      }
    );

  const streams =
    metadata.streams || [];

  const videoStream =
    streams.find(
      (stream) =>
        stream.codec_type ===
        "video"
    );

  const audioStream =
    streams.find(
      (stream) =>
        stream.codec_type ===
        "audio"
    );

  console.log(
    "Character video stream:",
    Boolean(videoStream)
  );

  console.log(
    "Character audio stream:",
    Boolean(audioStream)
  );

  if (!videoStream) {
    throw new Error(
      "Generated character video has no video stream"
    );
  }

  if (!audioStream) {
    throw new Error(
      "Generated character video has no audio stream"
    );
  }

  console.log(
    "Character video successfully created"
  );

  return {
    duration,
    size: outputSize,
    video: true,
    audio: true,
  };
}

/* =========================================================
   GENERATE CHARACTER VIDEO
========================================================= */

app.post(
  "/api/generate-character-video",
  async (req, res) => {
    const jobId =
      uuidv4();

    const tempFiles = [];

    try {
      const {
        characterUrl,
        backgroundUrl,
        audioUrl,
        animation = "idle",
        duration,
      } = req.body || {};

      if (!characterUrl) {
        return res.status(400).json({
          success: false,
          error:
            "characterUrl is required",
        });
      }

      if (!backgroundUrl) {
        return res.status(400).json({
          success: false,
          error:
            "backgroundUrl is required",
        });
      }

      if (!audioUrl) {
        return res.status(400).json({
          success: false,
          error:
            "audioUrl is required",
        });
      }

      const characterPath =
        path.join(
          TEMP_DIR,
          `${jobId}-character.jpg`
        );

      const backgroundPath =
        path.join(
          TEMP_DIR,
          `${jobId}-background.jpg`
        );

      const audioPath =
        path.join(
          TEMP_DIR,
          `${jobId}-audio.mp3`
        );

      const outputPath =
        path.join(
          VIDEOS_DIR,
          `character_${jobId}.mp4`
        );

      tempFiles.push(
        characterPath,
        backgroundPath,
        audioPath
      );

      console.log(
        "Downloading character..."
      );

      await downloadFile(
        normalizeMediaUrl(
          characterUrl,
          req
        ),
        characterPath
      );

      console.log(
        "Downloading background..."
      );

      await downloadFile(
        normalizeMediaUrl(
          backgroundUrl,
          req
        ),
        backgroundPath
      );

      console.log(
        "Downloading audio..."
      );

      await downloadFile(
        normalizeMediaUrl(
          audioUrl,
          req
        ),
        audioPath
      );

      await renderCharacterVideo({
        backgroundPath,
        characterPath,
        audioPath,
        outputPath,
        animation,
        requestedDuration:
          duration,
      });

      const videoUrl =
        `${getServerUrl(req)}/uploads/videos/${path.basename(
          outputPath
        )}`;

      res.json({
        success: true,
        videoUrl,
        url: videoUrl,
        video: videoUrl,
        duration,
        animation:
          normalizeAnimation(
            animation
          ),
      });
    } catch (error) {
      console.error(
        "Character video generation failed:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          error.message ||
          "Character video generation failed",
      });
    } finally {
      tempFiles.forEach(
        safeDelete
      );
    }
  }
);

/* =========================================================
   NORMAL SCENE VIDEO
   IMAGE + AUDIO
========================================================= */

async function renderSceneVideo({
  imagePath,
  audioPath,
  outputPath,
  duration,
  animationIndex = 0,
}) {
  ensureFfmpegAvailable();

  if (
    !fs.existsSync(imagePath)
  ) {
    throw new Error(
      "Scene image does not exist"
    );
  }

  if (
    !fs.existsSync(audioPath)
  ) {
    throw new Error(
      "Scene audio does not exist"
    );
  }

  const audioDuration =
    await getMediaDuration(
      audioPath
    );

  let finalDuration =
    Number(duration);

  if (
    !Number.isFinite(
      finalDuration
    ) ||
    finalDuration <= 0
  ) {
    finalDuration =
      audioDuration;
  }

  finalDuration =
    Math.max(
      finalDuration,
      audioDuration
    );

  finalDuration =
    Math.min(
      finalDuration,
      MAX_VIDEO_DURATION
    );

  let zoom =
    "1.0";

  let x =
    "(iw-iw/zoom)/2";

  let y =
    "(ih-ih/zoom)/2";

  switch (
    Number(animationIndex) % 7
  ) {
    case 0:
      zoom =
        "min(zoom+0.0008,1.12)";
      x =
        "(iw-iw/zoom)/2";
      y =
        "(ih-ih/zoom)/2";
      break;

    case 1:
      zoom =
        "min(zoom+0.0007,1.10)";
      x =
        "0";
      y =
        "(ih-ih/zoom)/2";
      break;

    case 2:
      zoom =
        "min(zoom+0.0007,1.10)";
      x =
        "iw-iw/zoom";
      y =
        "(ih-ih/zoom)/2";
      break;

    case 3:
      zoom =
        "min(zoom+0.0007,1.10)";
      x =
        "(iw-iw/zoom)/2";
      y =
        "0";
      break;

    case 4:
      zoom =
        "min(zoom+0.0007,1.10)";
      x =
        "(iw-iw/zoom)/2";
      y =
        "ih-ih/zoom";
      break;

    case 5:
      zoom =
        "min(zoom+0.0007,1.10)";
      x =
        "0";
      y =
        "0";
      break;

    case 6:
      zoom =
        "min(zoom+0.0007,1.10)";
      x =
        "iw-iw/zoom";
      y =
        "ih-ih/zoom";
      break;
  }

  const filter = [
    `scale=1280:720:force_original_aspect_ratio=increase`,
    `crop=1280:720`,
    `zoompan=z='${zoom}':x='${x}':y='${y}':d=1:s=1280x720:fps=24`,
    "setsar=1",
    "format=yuv420p",
  ].join(",");

  await new Promise(
    (resolve, reject) => {
      ffmpeg()
        .input(imagePath)
        .inputOptions([
          "-loop",
          "1",
          "-framerate",
          "24",
        ])
        .input(audioPath)
        .complexFilter(filter)
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
          "-pix_fmt",
          "yuv420p",
          "-r",
          "24",
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          "-t",
          String(finalDuration),
          "-movflags",
          "+faststart",
          "-threads",
          "1",
        ])
        .output(outputPath)
        .on(
          "start",
          (command) => {
            console.log(
              "Scene FFmpeg:",
              command
            );
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
          "progress",
          (progress) => {
            const percent =
              Number(
                progress.percent
              );

            if (
              Number.isFinite(
                percent
              )
            ) {
              console.log(
                `Scene progress: ${percent.toFixed(
                  1
                )}%`
              );
            }
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
        .run();
    }
  );

  if (
    !fs.existsSync(outputPath)
  ) {
    throw new Error(
      "Scene video was not created"
    );
  }

  const size =
    fs.statSync(
      outputPath
    ).size;

  if (size < 1000) {
    throw new Error(
      "Scene video is too small"
    );
  }

  return {
    duration: finalDuration,
    size,
  };
}

/* =========================================================
   GENERATE SCENE VIDEO
========================================================= */

app.post(
  "/api/generate-scene-video",
  async (req, res) => {
    const jobId =
      uuidv4();

    const tempFiles = [];

    try {
      const {
        imageUrl,
        audioUrl,
        duration,
        animationIndex = 0,
      } = req.body || {};

      if (!imageUrl) {
        return res.status(400).json({
          success: false,
          error:
            "imageUrl is required",
        });
      }

      if (!audioUrl) {
        return res.status(400).json({
          success: false,
          error:
            "audioUrl is required",
        });
      }

      const imagePath =
        path.join(
          TEMP_DIR,
          `${jobId}-image.jpg`
        );

      const audioPath =
        path.join(
          TEMP_DIR,
          `${jobId}-audio.mp3`
        );

      const outputPath =
        path.join(
          VIDEOS_DIR,
          `scene_${jobId}.mp4`
        );

      tempFiles.push(
        imagePath,
        audioPath
      );

      await downloadFile(
        normalizeMediaUrl(
          imageUrl,
          req
        ),
        imagePath
      );

      await downloadFile(
        normalizeMediaUrl(
          audioUrl,
          req
        ),
        audioPath
      );

      const result =
        await renderSceneVideo({
          imagePath,
          audioPath,
          outputPath,
          duration,
          animationIndex,
        });

      const videoUrl =
        `${getServerUrl(req)}/uploads/videos/${path.basename(
          outputPath
        )}`;

      res.json({
        success: true,
        videoUrl,
        url: videoUrl,
        video: videoUrl,
        duration:
          result.duration,
      });
    } catch (error) {
      console.error(
        "Scene video generation failed:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          error.message ||
          "Scene video generation failed",
      });
    } finally {
      tempFiles.forEach(
        safeDelete
      );
    }
  }
);

/* =========================================================
   CONCAT SCENE VIDEOS
========================================================= */

async function concatSceneVideos(
  sceneVideos,
  outputPath
) {
  ensureFfmpegAvailable();

  if (
    !Array.isArray(
      sceneVideos
    ) ||
    sceneVideos.length === 0
  ) {
    throw new Error(
      "No scene videos to concatenate"
    );
  }

  const concatFile =
    path.join(
      TEMP_DIR,
      `concat_${uuidv4()}.txt`
    );

  const lines =
    sceneVideos.map(
      (filePath) => {
        const escaped =
          filePath.replace(
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

  try {
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
          .output(outputPath)
          .on(
            "start",
            (command) => {
              console.log(
                "Concat FFmpeg:",
                command
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
          .run();
      }
    );
  } finally {
    safeDelete(
      concatFile
    );
  }

  if (
    !fs.existsSync(outputPath)
  ) {
    throw new Error(
      "Final concatenated video was not created"
    );
  }

  const size =
    fs.statSync(
      outputPath
    ).size;

  if (size < 1000) {
    throw new Error(
      "Final video is too small"
    );
  }

  return {
    size,
  };
}

/* =========================================================
   GENERATE FINAL VIDEO
   NORMAL + CHARACTER PIPELINE
========================================================= */

app.post(
  "/api/generate-final-video",
  async (req, res) => {
    const projectId =
      uuidv4();

    const tempFiles = [];

    try {
      const {
        scenes,
        duration,
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
        "======================================"
      );

      console.log(
        "FINAL VIDEO GENERATION"
      );

      console.log(
        "Scenes:",
        scenes.length
      );

      console.log(
        "======================================"
      );

      const sceneVideos = [];

      for (
        let i = 0;
        i < scenes.length;
        i++
      ) {
        const scene =
          scenes[i] || {};

        console.log(
          `Processing scene ${
            i + 1
          }/${scenes.length}`
        );

        /*
          CHARACTER MODE

          If characterUrl AND backgroundUrl
          exist, this scene uses the
          character animation renderer.
        */

        const hasCharacter =
          Boolean(
            scene.characterUrl &&
              scene.backgroundUrl
          );

        if (hasCharacter) {
          console.log(
            "Character animation mode enabled"
          );

          const characterPath =
            path.join(
              TEMP_DIR,
              `${projectId}-scene-${i}-character.jpg`
            );

          const backgroundPath =
            path.join(
              TEMP_DIR,
              `${projectId}-scene-${i}-background.jpg`
            );

          const audioPath =
            path.join(
              TEMP_DIR,
              `${projectId}-scene-${i}-audio.mp3`
            );

          const sceneOutput =
            path.join(
              VIDEOS_DIR,
              `final_scene_${projectId}_${i}.mp4`
            );

          tempFiles.push(
            characterPath,
            backgroundPath,
            audioPath
          );

          if (
            !scene.audioUrl
          ) {
            throw new Error(
              `Scene ${
                i + 1
              } has character/background but no audioUrl`
            );
          }

          await downloadFile(
            normalizeMediaUrl(
              scene.characterUrl,
              req
            ),
            characterPath
          );

          await downloadFile(
            normalizeMediaUrl(
              scene.backgroundUrl,
              req
            ),
            backgroundPath
          );

          await downloadFile(
            normalizeMediaUrl(
              scene.audioUrl,
              req
            ),
            audioPath
          );

          await renderCharacterVideo({
            backgroundPath,
            characterPath,
            audioPath,
            outputPath:
              sceneOutput,
            animation:
              scene.animation ||
              scene.characterAnimation ||
              "idle",
            requestedDuration:
              scene.duration ||
              duration,
          });

          sceneVideos.push(
            sceneOutput
          );

          continue;
        }

        /*
          NORMAL IMAGE MODE
        */

        if (!scene.imageUrl) {
          throw new Error(
            `Scene ${
              i + 1
            } has no imageUrl`
          );
        }

        if (!scene.audioUrl) {
          throw new Error(
            `Scene ${
              i + 1
            } has no audioUrl`
          );
        }

        const imagePath =
          path.join(
            TEMP_DIR,
            `${projectId}-scene-${i}-image.jpg`
          );

        const audioPath =
          path.join(
            TEMP_DIR,
            `${projectId}-scene-${i}-audio.mp3`
          );

        const sceneOutput =
          path.join(
            VIDEOS_DIR,
            `final_scene_${projectId}_${i}.mp4`
          );

        tempFiles.push(
          imagePath,
          audioPath
        );

        await downloadFile(
          normalizeMediaUrl(
            scene.imageUrl,
            req
          ),
          imagePath
        );

        await downloadFile(
          normalizeMediaUrl(
            scene.audioUrl,
            req
          ),
          audioPath
        );

        await renderSceneVideo({
          imagePath,
          audioPath,
          outputPath:
            sceneOutput,
          duration:
            scene.duration ||
            duration,
          animationIndex:
            scene.animationIndex ||
            i,
        });

        sceneVideos.push(
          sceneOutput
        );
      }

      /* ===================================================
         CONCAT ALL SCENES
      =================================================== */

      const finalOutput =
        path.join(
          VIDEOS_DIR,
          `video_${projectId}.mp4`
        );

      console.log(
        "Concatenating scenes..."
      );

      await concatSceneVideos(
        sceneVideos,
        finalOutput
      );

      /* ===================================================
         FINAL VALIDATION
      =================================================== */

      const metadata =
        await new Promise(
          (resolve, reject) => {
            ffmpeg.ffprobe(
              finalOutput,
              (
                error,
                data
              ) => {
                if (error) {
                  reject(error);
                  return;
                }

                resolve(data);
              }
            );
          }
        );

      const streams =
        metadata.streams ||
        [];

      const videoStream =
        streams.find(
          (stream) =>
            stream.codec_type ===
            "video"
        );

      const audioStream =
        streams.find(
          (stream) =>
            stream.codec_type ===
            "audio"
        );

      if (!videoStream) {
        throw new Error(
          "Final video has no video stream"
        );
      }

      if (!audioStream) {
        throw new Error(
          "Final video has no audio stream"
        );
      }

      const finalSize =
        fs.statSync(
          finalOutput
        ).size;

      console.log(
        "Final video size:",
        finalSize
      );

      const videoUrl =
        `${getServerUrl(req)}/uploads/videos/${path.basename(
          finalOutput
        )}`;

      console.log(
        "FINAL VIDEO URL:",
        videoUrl
      );

      res.json({
        success: true,

        videoUrl,

        url: videoUrl,

        video: videoUrl,

        duration:
          metadata.format?.duration ||
          null,

        size: finalSize,

        scenes:
          scenes.length,
      });
    } catch (error) {
      console.error(
        "======================================"
      );

      console.error(
        "FINAL VIDEO GENERATION FAILED"
      );

      console.error(
        error
      );

      console.error(
        "======================================"
      );

      res.status(500).json({
        success: false,
        error:
          error.message ||
          "Final video generation failed",
      });
    } finally {
      tempFiles.forEach(
        safeDelete
      );
    }
  }
);

/* =========================================================
   ALIAS
========================================================= */

app.post(
  "/api/generate-video",
  async (req, res) => {
    req.url =
      "/api/generate-final-video";

    app.handle(
      req,
      res
    );
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
        "AI Video Studio Server",
      version:
        "character-animation-2.0",
      status:
        "running",
      serverUrl:
        getServerUrl(req),

      endpoints: {
        health:
          "/api/health",

        generateImage:
          "/api/generate-image",

        upload:
          "/api/upload",

        generateVoice:
          "/api/generate-voice",

        generateCharacter:
          "/api/generate-character",

        generateBackground:
          "/api/generate-background",

        generateCharacterVideo:
          "/api/generate-character-video",

        generateSceneVideo:
          "/api/generate-scene-video",

        generateFinalVideo:
          "/api/generate-final-video",

        generateVideo:
          "/api/generate-video",
      },
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

    if (
      error instanceof
      multer.MulterError
    ) {
      return res.status(400).json({
        success: false,
        error:
          error.message,
      });
    }

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
      "======================================"
    );

    console.log(
      "AI VIDEO SERVER STARTED"
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
      "FFmpeg:",
      ffmpegStatic
    );

    console.log(
      "FFprobe:",
      ffprobeStatic?.path
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
      "======================================"
    );
  }
);