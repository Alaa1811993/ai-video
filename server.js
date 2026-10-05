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

const storage =
  multer.diskStorage({
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
      const extension =
        path.extname(
          file.originalname || ".bin"
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
    timestamp:
      new Date().toISOString(),
  });
});

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
      characterGeneration:
        true,
      characterAnimation:
        true,
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

      res.json({
        success: true,
        imageUrl,
        url: imageUrl,
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

/* =========================================================
   GENERATE CHARACTER
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
      } = req.body;

      const characterText =
        characterDescription ||
        description ||
        idea ||
        "a cinematic fantasy character";

      const prompt =
        `Full body character design for ${characterText}. ` +
        `The character must be completely visible from head to feet. ` +
        `Centered composition. ` +
        `Standing pose. ` +
        `Clear face. ` +
        `Clear arms and legs. ` +
        `Clean simple solid green background. ` +
        `No text. No watermark. ` +
        `Photorealistic cinematic character. ` +
        `Detailed face. Detailed clothing. ` +
        `Consistent single character. ` +
        `16:9.`;

      console.log(
        "========================================"
      );

      console.log(
        "AUTO CHARACTER GENERATION"
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

      res.json({
        success: true,
        characterUrl,
        url: characterUrl,
        prompt,
        type: "character",
      });
    } catch (error) {
      console.error(
        "Character generation error:",
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
      } = req.body;

      const backgroundText =
        backgroundDescription ||
        description ||
        idea ||
        "cinematic environment";

      const prompt =
        `Ultra realistic cinematic background environment for ${backgroundText}. ` +
        `No people. No characters. No animals. ` +
        `Wide cinematic composition. ` +
        `Natural lighting. ` +
        `Detailed environment. ` +
        `Photorealistic. ` +
        `16:9. ` +
        `No text. No watermark.`;

      console.log(
        "========================================"
      );

      console.log(
        "AUTO BACKGROUND GENERATION"
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

      res.json({
        success: true,
        backgroundUrl,
        url: backgroundUrl,
        prompt,
        type: "background",
      });
    } catch (error) {
      console.error(
        "Background generation error:",
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
      } = req.body;

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

      res.json({
        success: true,
        audioUrl,
        url: audioUrl,
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

      res.json({
        success: true,
        fileUrl,
        url: fileUrl,
      });
    } catch (error) {
      res.status(500).json({
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
            "-loop 1",
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
            `-t ${duration}`,
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
        .on("start", (cmd) => {
          console.log(
            "Scene FFmpeg:",
            cmd
          );
        })

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

        .on("end", () => {
          resolve(outputPath);
        })

        .on("error", reject)

        .save(outputPath);
    }
  );
}

/* =========================================================
   CHARACTER ANIMATION
========================================================= */

function buildCharacterFilter(
  animation,
  duration
) {
  const mode =
    String(
      animation || "talking"
    )
      .toLowerCase()
      .trim();

  const filters = [];

  /*
   * Background
   */

  filters.push(
    `[0:v]scale=1280:720:force_original_aspect_ratio=decrease,` +
      `pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,` +
      `setsar=1[bg]`
  );

  /*
   * Character.
   *
   * We remove green background.
   */

  filters.push(
    `[1:v]scale=520:-1:force_original_aspect_ratio=decrease,` +
      `format=rgba,` +
      `chromakey=0x00ff00:0.22:0.08,` +
      `setsar=1[character]`
  );

  let x =
    "(W-w)/2";

  let y =
    "H-h-20";

  /* =======================================================
     TALK
  ======================================================= */

  if (
    mode === "talking" ||
    mode === "talk"
  ) {
    x =
      "(W-w)/2 + 10*sin(2*PI*t*1.3)";

    y =
      "H-h-20 + 5*sin(2*PI*t*2.8)";

    /*
     * Stronger talking movement.
     *
     * The whole character slightly moves,
     * simulating speaking/body reaction.
     */
  }

  /* =======================================================
     TALK + WALK
  ======================================================= */

  else if (
    mode === "talking-walking" ||
    mode === "talk-walk" ||
    mode === "talk_walk"
  ) {
    const travel =
      `(-w-50)+((W+w+100)*(${duration > 0 ? "t/" + duration : "0"}))`;

    const bob =
      `12*abs(sin(2*PI*t*2.3))`;

    const sway =
      `8*sin(2*PI*t*2.3)`;

    x =
      `${travel}+${sway}`;

    y =
      `H-h-20-${bob}`;
  }

  /* =======================================================
     WALK
  ======================================================= */

  else if (
    mode === "walking" ||
    mode === "walk"
  ) {
    const travel =
      `(-w-50)+((W+w+100)*(t/${duration}))`;

    const bob =
      `12*abs(sin(2*PI*t*2.3))`;

    x =
      travel;

    y =
      `H-h-20-${bob}`;
  }

  /* =======================================================
     IDLE
  ======================================================= */

  else {
    x =
      "(W-w)/2 + 5*sin(2*PI*t*0.6)";

    y =
      "H-h-20 + 3*sin(2*PI*t*0.8)";
  }

  filters.push(
    `[bg][character]overlay=` +
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
      "talking";

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
     * Background
     */

    const backgroundPath =
      path.join(
        tempDir,
        `bg_${uuidv4()}${getExtensionFromUrl(
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
     * Character
     */

    const characterPath =
      path.join(
        tempDir,
        `character_${uuidv4()}${getExtensionFromUrl(
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
     * Voice
     */

    let audioPath = null;

    if (scene.audioUrl) {
      audioPath =
        path.join(
          tempDir,
          `character_audio_${uuidv4()}.mp3`
        );

      tempFiles.push(
        audioPath
      );

      await downloadFile(
        scene.audioUrl,
        audioPath
      );
    }

    /*
     * FFmpeg
     */

    let command =
      ffmpeg();

    command =
      command
        .input(backgroundPath)
        .inputOptions([
          "-loop",
          "1",
        ]);

    command =
      command
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
      "Character animation:",
      animation
    );

    console.log(
      "Character filter:",
      filter
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
            resolve
          )

          .on(
            "error",
            reject
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

    return outputPath;
  } finally {
    tempFiles.forEach(
      safeUnlink
    );
  }
}

/* =========================================================
   CHARACTER VIDEO
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

      res.json({
        success: true,
        videoUrl,
        url: videoUrl,
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

/* =========================================================
   FINAL VIDEO
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
            "end",
            resolve
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

app.post(
  "/api/generate-final-video",
  async (req, res) => {
    const sceneVideoPaths =
      [];

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
          scenes[i];

        const duration =
          parseDuration(
            scene.duration,
            5
          );

        let outputPath;

        /*
         * CHARACTER
         */

        if (
          scene.characterUrl &&
          scene.backgroundUrl &&
          scene.animation &&
          scene.animation !==
            "idle"
        ) {
          const filename =
            `character_scene_${uuidv4()}.mp4`;

          outputPath =
            path.join(
              tempDir,
              filename
            );

          await renderCharacterVideo(
            scene,
            outputPath
          );
        }

        /*
         * NORMAL CINEMATIC
         */

        else {
          if (!scene.imageUrl) {
            throw new Error(
              `Scene ${i + 1} has no imageUrl`
            );
          }

          const imagePath =
            path.join(
              tempDir,
              `scene_${uuidv4()}${getExtensionFromUrl(
                scene.imageUrl,
                ".jpg"
              )}`
            );

          await downloadFile(
            scene.imageUrl,
            imagePath
          );

          let audioPath = null;

          if (scene.audioUrl) {
            audioPath =
              path.join(
                tempDir,
                `audio_${uuidv4()}.mp3`
              );

            await downloadFile(
              scene.audioUrl,
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

          safeUnlink(
            imagePath
          );

          safeUnlink(
            audioPath
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
       * FINAL FILE
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
       * VERIFY
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
          (s) =>
            s.codec_type ===
            "video"
        );

      const audioStreams =
        probe.streams.filter(
          (s) =>
            s.codec_type ===
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
        videoUrl
      );

      console.log(
        "Size:",
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

      res.json({
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
            (scene) =>
              scene.characterUrl &&
              scene.backgroundUrl &&
              scene.animation
          ),
      });
    } catch (error) {
      console.error(
        "FINAL VIDEO ERROR:",
        error
      );

      res.status(500).json({
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
    try {
      const result =
        req.body;

      if (
        result?.scenes
      ) {
        req.body.scenes =
          result.scenes;
      }

      /*
       * This route is kept for
       * compatibility.
       */

      res.status(410).json({
        success: false,
        error:
          "Use /api/generate-final-video instead.",
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error:
          error.message,
      });
    }
  }
);

/* =========================================================
   404 HANDLER
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
   START
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
      "CHARACTER GENERATION:",
      "READY"
    );

    console.log(
      "CHARACTER ANIMATION:",
      "READY"
    );

    console.log(
      "========================================"
    );
  }
);