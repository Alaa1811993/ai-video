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
   APP
========================================================= */

const app = express();

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

const BASE_URL =
  process.env.BASE_URL ||
  "https://ai-video.bonto.run";

/* =========================================================
   CORS
========================================================= */

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.options("*", cors());

/* =========================================================
   BODY
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
   DIRECTORIES
========================================================= */

const uploadsDir = path.join(
  __dirname,
  "uploads"
);

const imagesDir = path.join(
  uploadsDir,
  "images"
);

const audioDir = path.join(
  uploadsDir,
  "audio"
);

const videosDir = path.join(
  uploadsDir,
  "videos"
);

const tempDir = path.join(
  uploadsDir,
  "temp"
);

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
   STATIC
========================================================= */

app.use(
  "/uploads",
  express.static(uploadsDir, {
    maxAge: "1d",
  })
);

/* =========================================================
   FFMPEG
========================================================= */

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(
    ffmpegStatic
  );
}

if (
  ffprobeStatic &&
  ffprobeStatic.path
) {
  ffmpeg.setFfprobePath(
    ffprobeStatic.path
  );
}

/* =========================================================
   MULTER
========================================================= */

const storage =
  multer.diskStorage({
    destination: function (
      req,
      file,
      cb
    ) {
      cb(null, imagesDir);
    },

    filename: function (
      req,
      file,
      cb
    ) {
      let ext = path
        .extname(
          file.originalname || ".jpg"
        )
        .toLowerCase();

      if (!ext) {
        ext = ".jpg";
      }

      cb(
        null,
        `image_${uuidv4()}${ext}`
      );
    },
  });

const upload = multer({
  storage,

  limits: {
    fileSize:
      50 * 1024 * 1024,
  },

  fileFilter:
    function (
      req,
      file,
      cb
    ) {
      const allowed = [
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/webp",
      ];

      if (
        allowed.includes(
          file.mimetype
        )
      ) {
        cb(null, true);
      } else {
        cb(
          new Error(
            "Only JPG, PNG and WEBP images are allowed."
          )
        );
      }
    },
});

/* =========================================================
   HELPERS
========================================================= */

function cleanText(value) {
  return String(
    value || ""
  ).trim();
}

function absoluteUrl(value) {
  if (!value) {
    return "";
  }

  const url = String(value).trim();

  if (
    url.startsWith("http://") ||
    url.startsWith("https://")
  ) {
    return url;
  }

  if (url.startsWith("/")) {
    return `${BASE_URL}${url}`;
  }

  return `${BASE_URL}/${url}`;
}

function normalizeUrl(url) {
  if (!url) {
    return "";
  }

  let value =
    String(url).trim();

  value = value.replace(
    "http://localhost:3000",
    BASE_URL
  );

  value = value.replace(
    "http://localhost:5000",
    BASE_URL
  );

  value = value.replace(
    "https://localhost:3000",
    BASE_URL
  );

  value = value.replace(
    "https://localhost:5000",
    BASE_URL
  );

  return absoluteUrl(value);
}

function getDuration(scene) {
  let duration =
    Number(scene?.duration);

  if (
    !Number.isFinite(duration)
  ) {
    duration = 5;
  }

  duration = Math.max(
    1,
    Math.min(duration, 60)
  );

  return duration;
}

function safeFilename(ext) {
  return `${uuidv4()}${ext}`;
}

/* =========================================================
   DOWNLOAD FILE
========================================================= */

function downloadFile(
  fileUrl,
  outputPath
) {
  return new Promise(
    (resolve, reject) => {
      if (!fileUrl) {
        return reject(
          new Error(
            "Missing file URL."
          )
        );
      }

      const url =
        normalizeUrl(fileUrl);

      const protocol =
        url.startsWith(
          "https://"
        )
          ? https
          : http;

      const request =
        protocol.get(
          url,
          {
            headers: {
              "User-Agent":
                "AI-Video-Studio/1.0",
            },
          },
          (response) => {
            if (
              response.statusCode >=
                300 &&
              response.statusCode <
                400 &&
              response.headers
                .location
            ) {
              response.resume();

              return downloadFile(
                response.headers
                  .location,
                outputPath
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
                  `Download failed: HTTP ${response.statusCode}`
                )
              );
            }

            const file =
              fs.createWriteStream(
                outputPath
              );

            response.pipe(file);

            file.on(
              "finish",
              () => {
                file.close(resolve);
              }
            );

            file.on(
              "error",
              reject
            );
          }
        );

      request.on(
        "error",
        reject
      );

      request.setTimeout(
        120000,
        () => {
          request.destroy(
            new Error(
              "Download timeout."
            )
          );
        }
      );
    }
  );
}

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/",
  (req, res) => {
    res.json({
      success: true,
      name: "AI Video Server",
      status: "running",
      url: BASE_URL,
    });
  }
);

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      success: true,
      status: "ok",
      ffmpeg: !!ffmpegStatic,
      ffprobe:
        !!ffprobeStatic,
      elevenlabs:
        !!process.env
          .ELEVENLABS_API_KEY,
      baseUrl: BASE_URL,
    });
  }
);

app.get(
  "/api/test",
  (req, res) => {
    res.json({
      success: true,
      message:
        "AI Video Server is working.",
    });
  }
);

/* =========================================================
   UPLOAD IMAGE
========================================================= */

app.post(
  "/api/upload",
  upload.fields([
    {
      name: "file",
      maxCount: 1,
    },
    {
      name: "image",
      maxCount: 1,
    },
  ]),
  async (req, res) => {
    try {
      const uploaded =
        req.files?.file?.[0] ||
        req.files?.image?.[0];

      if (!uploaded) {
        return res.status(400).json({
          success: false,
          error:
            "No image file was uploaded.",
        });
      }

      const imageUrl =
        absoluteUrl(
          `/uploads/images/${uploaded.filename}`
        );

      res.json({
        success: true,
        imageUrl,
        url: imageUrl,
        filename:
          uploaded.filename,
      });
    } catch (error) {
      console.error(
        "Upload error:",
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
   POLLINATIONS IMAGE
========================================================= */

async function generatePollinationsImage(
  prompt,
  width,
  height,
  prefix
) {
  const finalPrompt =
    `${prompt}, realistic cinematic high quality, detailed, 16:9`;

  const remoteUrl =
    "https://image.pollinations.ai/prompt/" +
    encodeURIComponent(
      finalPrompt
    ) +
    `?width=${width}` +
    `&height=${height}` +
    `&model=flux` +
    `&nologo=true`;

  const filename =
    `${prefix}_${uuidv4()}.jpg`;

  const outputPath =
    path.join(
      imagesDir,
      filename
    );

  await downloadFile(
    remoteUrl,
    outputPath
  );

  return absoluteUrl(
    `/uploads/images/${filename}`
  );
}

/* =========================================================
   GENERATE IMAGE
========================================================= */

app.post(
  "/api/generate-image",
  async (req, res) => {
    try {
      const prompt =
        cleanText(
          req.body.prompt
        );

      if (!prompt) {
        return res.status(400).json({
          success: false,
          error:
            "Image prompt is required.",
        });
      }

      const imageUrl =
        await generatePollinationsImage(
          prompt,
          1280,
          720,
          "scene"
        );

      res.json({
        success: true,
        imageUrl,
        url: imageUrl,
      });
    } catch (error) {
      console.error(
        "Generate image error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          "Image generation failed. You can upload your own image.",
        details:
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
      const prompt =
        cleanText(
          req.body.prompt ||
            req.body.description
        );

      if (!prompt) {
        return res.status(400).json({
          success: false,
          error:
            "Background prompt is required.",
        });
      }

      const backgroundPrompt =
        `${prompt}, cinematic realistic environment, ` +
        `wide 16:9 composition, empty center area ` +
        `for a full body character`;

      const backgroundUrl =
        await generatePollinationsImage(
          backgroundPrompt,
          1280,
          720,
          "background"
        );

      res.json({
        success: true,
        backgroundUrl,
        imageUrl:
          backgroundUrl,
        url: backgroundUrl,
      });
    } catch (error) {
      console.error(
        "Background error:",
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
      const prompt =
        cleanText(
          req.body.prompt ||
            req.body.characterPrompt
        );

      if (!prompt) {
        return res.status(400).json({
          success: false,
          error:
            "Character prompt is required.",
        });
      }

      /*
       IMPORTANT:
       We request GREEN SCREEN because
       FFmpeg will remove the green color
       and place the character over the
       scene background.
      */

      const characterPrompt =
        `${prompt}. ` +
        `FULL BODY CHARACTER. ` +
        `Front view. ` +
        `Standing. ` +
        `Entire body visible from head to feet. ` +
        `Character centered. ` +
        `PURE SOLID BRIGHT GREEN SCREEN BACKGROUND. ` +
        `No scenery. No objects. ` +
        `No shadows outside character. ` +
        `Character designed for animation.`;

      const characterUrl =
        await generatePollinationsImage(
          characterPrompt,
          1024,
          1024,
          "character"
        );

      res.json({
        success: true,
        characterUrl,
        imageUrl:
          characterUrl,
        url: characterUrl,
      });
    } catch (error) {
      console.error(
        "Character error:",
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
   ELEVENLABS
========================================================= */

const VOICES = {
  Female:
    process.env
      .ELEVENLABS_FEMALE_VOICE_ID,

  Male:
    process.env
      .ELEVENLABS_MALE_VOICE_ID,

  "Deep Male":
    process.env
      .ELEVENLABS_DEEP_MALE_VOICE_ID,

  Professional:
    process.env
      .ELEVENLABS_PROFESSIONAL_VOICE_ID,

  Storyteller:
    process.env
      .ELEVENLABS_STORYTELLER_VOICE_ID,

  Default:
    process.env
      .ELEVENLABS_VOICE_ID,
};

function elevenLabsRequest(
  voiceId,
  text
) {
  return new Promise(
    (resolve, reject) => {
      const apiKey =
        process.env
          .ELEVENLABS_API_KEY;

      if (!apiKey) {
        return reject(
          new Error(
            "ELEVENLABS_API_KEY is missing in Bonto environment variables."
          )
        );
      }

      const body =
        JSON.stringify({
          text,
          model_id:
            "eleven_multilingual_v2",
          voice_settings: {
            stability: 0.45,
            similarity_boost:
              0.8,
            style: 0.2,
            use_speaker_boost:
              true,
          },
        });

      const options = {
        hostname:
          "api.elevenlabs.io",
        path:
          `/v1/text-to-speech/${voiceId}`,
        method: "POST",

        headers: {
          "xi-api-key":
            apiKey,

          "Content-Type":
            "application/json",

          Accept:
            "audio/mpeg",

          "Content-Length":
            Buffer.byteLength(body),
        },
      };

      const request =
        https.request(
          options,
          (response) => {
            if (
              response.statusCode !==
              200
            ) {
              let errorData = "";

              response.on(
                "data",
                (chunk) => {
                  errorData +=
                    chunk.toString();
                }
              );

              response.on(
                "end",
                () => {
                  reject(
                    new Error(
                      `ElevenLabs error ${response.statusCode}: ${errorData}`
                    )
                  );
                }
              );

              return;
            }

            const chunks = [];

            response.on(
              "data",
              (chunk) => {
                chunks.push(chunk);
              }
            );

            response.on(
              "end",
              () => {
                resolve(
                  Buffer.concat(
                    chunks
                  )
                );
              }
            );
          }
        );

      request.on(
        "error",
        reject
      );

      request.write(body);
      request.end();
    }
  );
}

/* =========================================================
   GENERATE VOICE
========================================================= */

app.post(
  "/api/generate-voice",
  async (req, res) => {
    try {
      const text =
        cleanText(
          req.body.text
        );

      const voiceName =
        cleanText(
          req.body.voice ||
            "Female"
        );

      if (!text) {
        return res.status(400).json({
          success: false,
          error:
            "Text is required.",
        });
      }

      const voiceId =
        VOICES[voiceName] ||
        VOICES.Default;

      if (!voiceId) {
        return res.status(500).json({
          success: false,
          error:
            `No ElevenLabs voice ID configured for ${voiceName}.`,
        });
      }

      const audio =
        await elevenLabsRequest(
          voiceId,
          text
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
        audio
      );

      const audioUrl =
        absoluteUrl(
          `/uploads/audio/${filename}`
        );

      res.json({
        success: true,
        audioUrl,
        url: audioUrl,
        voice:
          voiceName,
      });
    } catch (error) {
      console.error(
        "Voice error:",
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
   CHARACTER ANIMATION
========================================================= */

/*
  These expressions create actual movement
  of the character layer.

  Talking:
    small vertical/scale movement

  Walking:
    character moves left/right
    with body bobbing

  Talking + Walking:
    combines both

  Running:
    faster movement

  Jumping:
    vertical movement

  Dancing:
    side-to-side movement

  Breathing:
    subtle scale movement

  Attacking:
    quick movement
*/

function getCharacterPosition(
  animation
) {
  const mode =
    String(
      animation || "talking"
    ).toLowerCase();

  let x =
    "W-w";

  let y =
    "(H-h)/2";

  let scale =
    "1";

  if (
    mode === "walking"
  ) {
    x =
      "W/2-w/2 + sin(t*2)*220";

    y =
      "(H-h)/2 + abs(sin(t*6))*12";
  } else if (
    mode ===
    "talking-walking"
  ) {
    x =
      "W/2-w/2 + sin(t*2)*220";

    y =
      "(H-h)/2 + abs(sin(t*6))*12";

    scale =
      "1 + sin(t*8)*0.015";
  } else if (
    mode === "running"
  ) {
    x =
      "W/2-w/2 + sin(t*5)*350";

    y =
      "(H-h)/2 + abs(sin(t*12))*22";
  } else if (
    mode === "jumping"
  ) {
    x =
      "W/2-w/2 + sin(t*2)*180";

    y =
      "(H-h)/2 - abs(sin(t*2))*180";
  } else if (
    mode === "dancing"
  ) {
    x =
      "W/2-w/2 + sin(t*3)*160";

    y =
      "(H-h)/2 + sin(t*6)*30";

    scale =
      "1 + sin(t*6)*0.04";
  } else if (
    mode === "breathing"
  ) {
    x =
      "W/2-w/2";

    y =
      "(H-h)/2";

    scale =
      "1 + sin(t*2)*0.025";
  } else if (
    mode === "attacking"
  ) {
    x =
      "W/2-w/2 + sin(t*7)*100";

    y =
      "(H-h)/2 + sin(t*7)*15";
  } else {
    /*
      TALKING
    */

    x =
      "W/2-w/2";

    y =
      "(H-h)/2 + sin(t*7)*7";

    scale =
      "1 + sin(t*8)*0.02";
  }

  return {
    x,
    y,
    scale,
  };
}

/* =========================================================
   RENDER SCENE
========================================================= */

function renderAnimatedScene({
  backgroundPath,
  characterPath,
  outputPath,
  duration,
  animation,
  audioPath,
}) {
  return new Promise(
    (resolve, reject) => {
      const command =
        ffmpeg();

      /*
        Background
      */

      command
        .input(backgroundPath)
        .inputOptions([
          "-loop 1",
        ]);

      /*
        Character
      */

      if (characterPath) {
        command
          .input(characterPath)
          .inputOptions([
            "-loop 1",
          ]);
      }

      /*
        Audio
      */

      if (audioPath) {
        command.input(
          audioPath
        );
      }

      const filters = [];

      /*
        Background:
        Fill 1280x720
      */

      filters.push(
        "[0:v]" +
          "scale=1280:720:force_original_aspect_ratio=increase," +
          "crop=1280:720," +
          "setsar=1," +
          "format=rgba" +
          "[bg]"
      );

      if (characterPath) {
        const pos =
          getCharacterPosition(
            animation
          );

        /*
          Character:

          Scale down.
          Remove green screen.
          Make transparent.
          Move according to animation.
        */

        filters.push(
          "[1:v]" +
            `scale=360:-1,` +
            "format=rgba," +
            "chromakey=0x00ff00:0.18:0.08," +
            `scale=iw*${pos.scale}:ih*${pos.scale},` +
            `setpts=PTS-STARTPTS` +
            "[char]"
        );

        filters.push(
          `[bg][char]overlay=x='${pos.x}':y='${pos.y}':format=auto,` +
            "format=yuv420p" +
            "[video]"
        );
      } else {
        filters.push(
          "[bg]" +
            "format=yuv420p" +
            "[video]"
        );
      }

      command.complexFilter(
        filters
      );

      command
        .outputOptions([
          "-map [video]",
        ]);

      if (audioPath) {
        command.outputOptions([
          "-map 2:a:0?",
          "-c:a aac",
          "-b:a 128k",
          "-shortest",
        ]);
      } else {
        command.outputOptions([
          "-an",
        ]);
      }

      command
        .videoCodec("libx264")
        .outputOptions([
          "-t",
          String(duration),

          "-preset",
          "veryfast",

          "-crf",
          "25",

          "-pix_fmt",
          "yuv420p",

          "-movflags",
          "+faststart",
        ])
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
              "Scene progress:",
              progress.percent
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
        .on(
          "end",
          () => {
            resolve();
          }
        )
        .save(outputPath);
    }
  );
}

/* =========================================================
   GENERATE SCENE VIDEO
========================================================= */

app.post(
  "/api/generate-scene-video",
  async (req, res) => {
    const tempFiles = [];

    try {
      const scene =
        req.body || {};

      const imageUrl =
        normalizeUrl(
          scene.backgroundUrl ||
            scene.imageUrl
        );

      const characterUrl =
        normalizeUrl(
          scene.characterUrl
        );

      const audioUrl =
        normalizeUrl(
          scene.audioUrl
        );

      const duration =
        getDuration(scene);

      const animation =
        cleanText(
          scene.animation ||
            "talking"
        );

      if (!imageUrl) {
        return res.status(400).json({
          success: false,
          error:
            "Scene image is required.",
        });
      }

      const backgroundPath =
        path.join(
          tempDir,
          `bg_${uuidv4()}.jpg`
        );

      tempFiles.push(
        backgroundPath
      );

      await downloadFile(
        imageUrl,
        backgroundPath
      );

      let characterPath =
        null;

      if (characterUrl) {
        characterPath =
          path.join(
            tempDir,
            `char_${uuidv4()}.jpg`
          );

        tempFiles.push(
          characterPath
        );

        await downloadFile(
          characterUrl,
          characterPath
        );
      }

      let audioPath = null;

      if (audioUrl) {
        audioPath =
          path.join(
            tempDir,
            `audio_${uuidv4()}.mp3`
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

      await renderAnimatedScene({
        backgroundPath,
        characterPath,
        outputPath,
        duration,
        animation,
        audioPath,
      });

      const videoUrl =
        absoluteUrl(
          `/uploads/videos/${filename}`
        );

      res.json({
        success: true,
        videoUrl,
        url: videoUrl,
        duration,
        animation,
      });
    } catch (error) {
      console.error(
        "Scene video error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          error.message,
      });
    } finally {
      for (
        const file of tempFiles
      ) {
        try {
          if (
            fs.existsSync(file)
          ) {
            fs.unlinkSync(file);
          }
        } catch {}
      }
    }
  }
);

/* =========================================================
   CONCAT VIDEOS
========================================================= */

function concatVideos(
  videoPaths,
  outputPath
) {
  return new Promise(
    (resolve, reject) => {
      if (
        !videoPaths.length
      ) {
        return reject(
          new Error(
            "No scene videos."
          )
        );
      }

      const listPath =
        path.join(
          tempDir,
          `concat_${uuidv4()}.txt`
        );

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
        listPath,
        content
      );

      ffmpeg()
        .input(listPath)
        .inputOptions([
          "-f concat",
          "-safe 0",
        ])
        .outputOptions([
          "-c copy",
          "-movflags +faststart",
        ])
        .on(
          "error",
          (error) => {
            try {
              fs.unlinkSync(
                listPath
              );
            } catch {}

            reject(error);
          }
        )
        .on(
          "end",
          () => {
            try {
              fs.unlinkSync(
                listPath
              );
            } catch {}

            resolve();
          }
        )
        .save(outputPath);
    }
  );
}

/* =========================================================
   FINAL VIDEO
========================================================= */

app.post(
  "/api/generate-final-video",
  async (req, res) => {
    const sceneFiles = [];

    try {
      const scenes =
        Array.isArray(
          req.body.scenes
        )
          ? req.body.scenes
          : [];

      if (!scenes.length) {
        return res.status(400).json({
          success: false,
          error:
            "At least one scene is required.",
        });
      }

      console.log(
        `Rendering ${scenes.length} scenes`
      );

      /*
        Every scene uses:
        image/background
        character
        animation
        duration
        audio
      */

      for (
        let i = 0;
        i < scenes.length;
        i++
      ) {
        const scene =
          scenes[i];

        const imageUrl =
          normalizeUrl(
            scene.backgroundUrl ||
              scene.imageUrl
          );

        const characterUrl =
          normalizeUrl(
            scene.characterUrl
          );

        const audioUrl =
          normalizeUrl(
            scene.audioUrl
          );

        const duration =
          getDuration(scene);

        const animation =
          cleanText(
            scene.animation ||
              "talking"
          );

        if (!imageUrl) {
          throw new Error(
            `Scene ${i + 1} has no image.`
          );
        }

        const backgroundPath =
          path.join(
            tempDir,
            `final_bg_${uuidv4()}.jpg`
          );

        await downloadFile(
          imageUrl,
          backgroundPath
        );

        let characterPath =
          null;

        if (characterUrl) {
          characterPath =
            path.join(
              tempDir,
              `final_char_${uuidv4()}.jpg`
            );

          await downloadFile(
            characterUrl,
            characterPath
          );
        }

        let audioPath = null;

        if (audioUrl) {
          audioPath =
            path.join(
              tempDir,
              `final_audio_${uuidv4()}.mp3`
            );

          await downloadFile(
            audioUrl,
            audioPath
          );
        }

        const sceneFilename =
          `final_scene_${i + 1}_${uuidv4()}.mp4`;

        const sceneOutput =
          path.join(
            tempDir,
            sceneFilename
          );

        await renderAnimatedScene({
          backgroundPath,
          characterPath,
          outputPath:
            sceneOutput,
          duration,
          animation,
          audioPath,
        });

        sceneFiles.push(
          sceneOutput
        );

        /*
          Delete downloaded
          temporary media.
        */

        try {
          fs.unlinkSync(
            backgroundPath
          );
        } catch {}

        if (characterPath) {
          try {
            fs.unlinkSync(
              characterPath
            );
          } catch {}
        }

        if (audioPath) {
          try {
            fs.unlinkSync(
              audioPath
            );
          } catch {}
        }
      }

      const finalFilename =
        `video_${uuidv4()}.mp4`;

      const finalPath =
        path.join(
          videosDir,
          finalFilename
        );

      await concatVideos(
        sceneFiles,
        finalPath
      );

      const finalVideoUrl =
        absoluteUrl(
          `/uploads/videos/${finalFilename}`
        );

      res.json({
        success: true,
        videoUrl:
          finalVideoUrl,
        url:
          finalVideoUrl,
        duration:
          scenes.reduce(
            (total, scene) =>
              total +
              getDuration(
                scene
              ),
            0
          ),
      });
    } catch (error) {
      console.error(
        "Final video error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          error.message,
      });
    } finally {
      /*
        Remove scene videos.
      */

      for (
        const file of sceneFiles
      ) {
        try {
          if (
            fs.existsSync(file)
          ) {
            fs.unlinkSync(file);
          }
        } catch {}
      }
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

    app.handle(req, res);
  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (error, req, res, next) => {
    console.error(
      "Server error:",
      error
    );

    res.status(500).json({
      success: false,
      error:
        error.message ||
        "Server error.",
    });
  }
);

/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  HOST,
  () => {
    console.log(
      "===================================="
    );

    console.log(
      "AI VIDEO SERVER RUNNING"
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Base URL: ${BASE_URL}`
    );

    console.log(
      "===================================="
    );
  }
);