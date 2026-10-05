require("dotenv").config();

const express = require("express");
const cors = require("cors");
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

const PORT =
  process.env.PORT || 3000;

const SERVER_URL =
  process.env.SERVER_URL ||
  "https://ai-video.bonto.run";

const ELEVENLABS_API_KEY =
  process.env.ELEVENLABS_API_KEY;

const ELEVENLABS_MODEL =
  process.env.ELEVENLABS_MODEL ||
  "eleven_multilingual_v2";

/*
 * Voice IDs.
 *
 * You can replace these later with your preferred
 * ElevenLabs voices.
 */
const VOICES = {
  Female:
    process.env.ELEVENLABS_FEMALE_VOICE_ID ||
    "21m00Tcm4TlvDq8ikWAM",

  Male:
    process.env.ELEVENLABS_MALE_VOICE_ID ||
    "pNInz6obpgDQGcFmaJgB",

  "Deep Male":
    process.env.ELEVENLABS_DEEP_MALE_VOICE_ID ||
    "TxGEqnHWrfWFTfGW9XjX",

  Storyteller:
    process.env.ELEVENLABS_STORYTELLER_VOICE_ID ||
    "ErXwobaYiN019PkySvjV",
};

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
   DIRECTORIES
========================================================= */

const uploadsDir =
  path.join(
    __dirname,
    "uploads"
  );

const imagesDir =
  path.join(
    uploadsDir,
    "images"
  );

const audioDir =
  path.join(
    uploadsDir,
    "audio"
  );

const videosDir =
  path.join(
    uploadsDir,
    "videos"
  );

const tempDir =
  path.join(
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
    origin: function (
      origin,
      callback
    ) {
      if (!origin) {
        return callback(
          null,
          true
        );
      }

      if (
        allowedOrigins.includes(
          origin
        )
      ) {
        return callback(
          null,
          true
        );
      }

      console.log(
        "Blocked CORS:",
        origin
      );

      return callback(
        null,
        false
      );
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
  express.static(
    uploadsDir,
    {
      maxAge: "1h",
    }
  )
);

/* =========================================================
   HELPERS
========================================================= */

function safeUnlink(
  filePath
) {
  try {
    if (
      filePath &&
      fs.existsSync(filePath)
    ) {
      fs.unlinkSync(
        filePath
      );
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
    !Number.isFinite(
      number
    ) ||
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
      new URL(url)
        .pathname;

    const ext =
      path.extname(
        pathname
      );

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
        url.startsWith(
          "https://"
        )
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
              response.headers
                .location
            ) {
              response.resume();

              return downloadFile(
                response
                  .headers
                  .location,
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
    String(
      timemark
    ).split(":");

  if (
    parts.length !== 3
  ) {
    return 0;
  }

  return (
    (Number(parts[0]) || 0) *
      3600 +
    (Number(parts[1]) || 0) *
      60 +
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
        (seconds /
          duration) *
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
        (
          error,
          data
        ) => {
          if (error) {
            return reject(
              error
            );
          }

          resolve(data);
        }
      );
    }
  );
}

/* =========================================================
   POLLINATIONS
========================================================= */

async function generatePollinationsImage(
  prompt,
  options = {}
) {
  const width =
    options.width ||
    1280;

  const height =
    options.height ||
    720;

  const model =
    options.model ||
    "flux";

  const encodedPrompt =
    encodeURIComponent(
      prompt
    );

  const sourceUrl =
    `https://image.pollinations.ai/prompt/${encodedPrompt}` +
    `?width=${width}` +
    `&height=${height}` +
    `&model=${model}` +
    `&nologo=true`;

  const extension =
    options.extension ||
    ".jpg";

  const folder =
    options.folder ||
    "images";

  const filename =
    `generated_${uuidv4()}${extension}`;

  const outputDir =
    folder === "images"
      ? imagesDir
      : uploadsDir;

  const outputPath =
    path.join(
      outputDir,
      filename
    );

  await downloadFile(
    sourceUrl,
    outputPath
  );

  return {
    sourceUrl,
    filename,
    outputPath,
    publicUrl:
      getPublicUrl(
        folder,
        filename
      ),
  };
}

/* =========================================================
   CHARACTER DETECTION
========================================================= */

function hasCharacterAnimation(
  scene
) {
  if (!scene) {
    return false;
  }

  const animation =
    String(
      scene.animation ||
        ""
    )
      .toLowerCase()
      .trim();

  return Boolean(
    scene.characterUrl &&
      scene.backgroundUrl &&
      animation
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

      message:
        "AI Video Studio Server is running",

      server:
        SERVER_URL,

      characterAnimation:
        true,

      characterSystem:
        "automatic-generated-character",

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

      server:
        SERVER_URL,

      ffmpeg:
        Boolean(
          ffmpegStatic
        ),

      ffprobe:
        Boolean(
          ffprobeStatic?.path
        ),

      elevenlabs:
        Boolean(
          ELEVENLABS_API_KEY
        ),

      pollinations: true,

      characterAnimation:
        true,

      characterSystem:
        "automatic-generated-character",
    });
  }
);

/* =========================================================
   NORMAL IMAGE
========================================================= */

app.post(
  "/api/generate-image",
  async (req, res) => {
    try {
      const {
        prompt,
      } = req.body;

      if (!prompt) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "Prompt is required",
          });
      }

      console.log(
        "Generating normal image..."
      );

      const result =
        await generatePollinationsImage(
          prompt,
          {
            width: 1280,
            height: 720,
          }
        );

      res.json({
        success: true,

        imageUrl:
          result.publicUrl,

        url:
          result.publicUrl,
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
   AUTOMATIC CHARACTER GENERATION
========================================================= */

app.post(
  "/api/generate-character",
  async (req, res) => {
    try {
      const {
        prompt,
      } = req.body;

      if (!prompt) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "Character prompt is required",
          });
      }

      const characterPrompt =
        `${prompt} ` +
        `Full body visible from head to feet. ` +
        `Character centered. ` +
        `Pure solid bright green background. ` +
        `Uniform green screen. ` +
        `No text. No watermark. ` +
        `No other people.`;

      console.log(
        "GENERATING CHARACTER"
      );

      console.log(
        characterPrompt
      );

      const result =
        await generatePollinationsImage(
          characterPrompt,
          {
            width: 768,
            height: 1024,
          }
        );

      res.json({
        success: true,

        characterUrl:
          result.publicUrl,

        imageUrl:
          result.publicUrl,

        url:
          result.publicUrl,
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
   AUTOMATIC BACKGROUND GENERATION
========================================================= */

app.post(
  "/api/generate-background",
  async (req, res) => {
    try {
      const {
        prompt,
      } = req.body;

      if (!prompt) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "Background prompt is required",
          });
      }

      const backgroundPrompt =
        `${prompt} ` +
        `Wide cinematic environment. ` +
        `Leave open foreground space for a full-body character. ` +
        `No people. No characters. No text. No watermark.`;

      console.log(
        "GENERATING BACKGROUND"
      );

      console.log(
        backgroundPrompt
      );

      const result =
        await generatePollinationsImage(
          backgroundPrompt,
          {
            width: 1280,
            height: 720,
          }
        );

      res.json({
        success: true,

        backgroundUrl:
          result.publicUrl,

        imageUrl:
          result.publicUrl,

        url:
          result.publicUrl,
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
   ELEVENLABS
========================================================= */

app.post(
  "/api/generate-voice",
  async (req, res) => {
    try {
      const {
        text,
        voice,
        voiceId,
        modelId,
      } = req.body;

      if (!text) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "Text is required",
          });
      }

      if (
        !ELEVENLABS_API_KEY
      ) {
        return res
          .status(500)
          .json({
            success: false,
            error:
              "ElevenLabs API key is not configured",
          });
      }

      const selectedVoice =
        voiceId ||
        VOICES[
          voice || "Female"
        ] ||
        VOICES.Female;

      const selectedModel =
        modelId ||
        ELEVENLABS_MODEL;

      console.log(
        "Generating voice:",
        voice,
        selectedVoice
      );

      const url =
        `https://api.elevenlabs.io/v1/text-to-speech/${selectedVoice}`;

      const response =
        await fetch(
          url,
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

      res.json({
        success: true,

        audioUrl,

        url:
          audioUrl,
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
   NORMAL CINEMATIC RENDER
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

            "-threads",
            "1",

            "-t",
            String(
              duration
            ),
          ]);

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
              "-shortest",
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
          (line) =>
            console.log(
              "Scene FFmpeg:",
              line
            )
        )

        .on(
          "progress",
          (progress) =>
            console.log(
              `Scene progress: ${calculateProgress(
                progress.timemark,
                duration
              )}%`
            )
        )

        .on(
          "stderr",
          (line) => {
            if (
              line?.trim()
            ) {
              console.log(
                "Scene:",
                line
              );
            }
          }
        )

        .on(
          "end",
          () =>
            resolve(
              outputPath
            )
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
}

/* =========================================================
   CHARACTER MOTION FILTER
========================================================= */

/*
 * Character image:
 *
 * [1:v]
 *
 * Background:
 *
 * [0:v]
 *
 * We chroma-key the green background from
 * the generated character.
 *
 * Then we move the character.
 *
 * TALK:
 * - body bob
 * - horizontal micro movement
 * - slight size pulse
 *
 * TALK + WALK:
 * - character travels left -> right
 * - stronger body bob
 * - size pulse
 *
 * This is intentionally built without requiring
 * separate body/head/arm/leg uploads.
 */

function buildCharacterFilter(
  animation,
  duration
) {
  const mode =
    String(
      animation ||
        "talking"
    )
      .toLowerCase()
      .trim();

  const filters = [];

  /* -------------------------------------------------------
     BACKGROUND
  ------------------------------------------------------- */

  filters.push(
    `[0:v]` +
      `scale=1280:720:force_original_aspect_ratio=increase,` +
      `crop=1280:720,` +
      `setsar=1` +
      `[bg]`
  );

  /* -------------------------------------------------------
     CHARACTER
  ------------------------------------------------------- */

  /*
   * Green screen removal.
   *
   * chromakey color:
   * 0x00ff00
   *
   * similarity / blend values can be tuned.
   */

  filters.push(
    `[1:v]` +
      `scale=420:-1:force_original_aspect_ratio=decrease,` +
      `format=rgba,` +
      `chromakey=0x00ff00:0.28:0.08,` +
      `setsar=1` +
      `[char]`
  );

  let x;
  let y;

  /* -------------------------------------------------------
     TALK
  ------------------------------------------------------- */

  if (
    mode === "talking" ||
    mode === "talk"
  ) {
    x =
      `(W-w)/2` +
      `+14*sin(2*PI*t*1.25)`;

    y =
      `H-h-25` +
      `+8*sin(2*PI*t*2.0)`;

    filters.push(
      `[char]` +
        `scale=` +
        `w='iw*(1+0.015*sin(2*PI*t*2.4))':` +
        `h='ih*(1+0.015*sin(2*PI*t*2.4))':` +
        `eval=frame` +
        `[moving]`
    );
  }

  /* -------------------------------------------------------
     TALK + WALK
  ------------------------------------------------------- */

  else if (
    mode ===
      "talking-walking" ||
    mode === "talk_walk" ||
    mode === "walking"
  ) {
    x =
      `-w+((W+w+120)*(t/${duration}))`;

    y =
      `H-h-25` +
      `-16*abs(sin(2*PI*t*2.6))`;

    filters.push(
      `[char]` +
        `scale=` +
        `w='iw*(1+0.02*sin(2*PI*t*2.6))':` +
        `h='ih*(1+0.02*sin(2*PI*t*2.6))':` +
        `eval=frame` +
        `[moving]`
    );
  }

  /* -------------------------------------------------------
     FALLBACK
  ------------------------------------------------------- */

  else {
    x =
      `(W-w)/2` +
      `+8*sin(2*PI*t*.7)`;

    y =
      `H-h-25` +
      `+5*sin(2*PI*t*.8)`;

    filters.push(
      `[char]` +
        `scale=` +
        `w='iw*(1+0.01*sin(2*PI*t*1.2))':` +
        `h='ih*(1+0.01*sin(2*PI*t*1.2))':` +
        `eval=frame` +
        `[moving]`
    );
  }

  /* -------------------------------------------------------
     COMPOSITE
  ------------------------------------------------------- */

  filters.push(
    `[bg][moving]` +
      `overlay=` +
      `x='${x}':` +
      `y='${y}':` +
      `eval=frame:` +
      `eof_action=repeat` +
      `[final]`
  );

  return filters.join(
    ";"
  );
}

/* =========================================================
   CHARACTER VIDEO
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
      String(
        scene.animation ||
          "talking"
      )
        .toLowerCase()
        .trim();

    if (
      !scene.characterUrl
    ) {
      throw new Error(
        "Character URL is missing."
      );
    }

    if (
      !scene.backgroundUrl
    ) {
      throw new Error(
        "Background URL is missing."
      );
    }

    /* -------------------------------------------------------
       DOWNLOAD BACKGROUND
    ------------------------------------------------------- */

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

    /* -------------------------------------------------------
       DOWNLOAD CHARACTER
    ------------------------------------------------------- */

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

    /* -------------------------------------------------------
       AUDIO
    ------------------------------------------------------- */

    let audioPath =
      null;

    if (
      scene.audioUrl
    ) {
      audioPath =
        path.join(
          tempDir,
          `audio_${uuidv4()}.mp3`
        );

      tempFiles.push(
        audioPath
      );

      await downloadFile(
        scene.audioUrl,
        audioPath
      );
    }

    /* -------------------------------------------------------
       FFMPEG
    ------------------------------------------------------- */

    let command =
      ffmpeg()
        .input(
          backgroundPath
        )
        .inputOptions([
          "-loop 1",
        ])
        .input(
          characterPath
        )
        .inputOptions([
          "-loop 1",
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
          "-map",
          "[final]",

          "-pix_fmt",
          "yuv420p",

          "-preset",
          "veryfast",

          "-crf",
          "23",

          "-r",
          "24",

          "-t",
          String(
            duration
          ),

          "-movflags",
          "+faststart",

          "-threads",
          "1",
        ]);

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
            "-map",
            "2:a?",

            "-af",
            "apad",

            "-t",
            String(
              duration
            ),
          ]);
    } else {
      command =
        command.outputOptions([
          "-an",
        ]);
    }

    await new Promise(
      (
        resolve,
        reject
      ) => {
        command
          .on(
            "start",
            (line) => {
              console.log(
                "CHARACTER FFMPEG:"
              );

              console.log(
                line
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
                line?.trim()
              ) {
                console.log(
                  "Character:",
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
        "Character video was not created."
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
   CONCAT
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
    const content =
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
      content
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
            (line) =>
              console.log(
                "CONCAT:",
                line
              )
          )
          .on(
            "stderr",
            (line) => {
              if (
                line?.trim()
              ) {
                console.log(
                  "CONCAT:",
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

/* =========================================================
   CHARACTER VIDEO ENDPOINT
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
        return res
          .status(400)
          .json({
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

        url:
          videoUrl,

        animation:
          scene.animation ||
          "talking",
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

app.post(
  "/api/generate-final-video",
  async (req, res) => {
    const tempFiles = [];

    try {
      const {
        scenes,
      } = req.body;

      if (
        !Array.isArray(
          scenes
        ) ||
        !scenes.length
      ) {
        return res
          .status(400)
          .json({
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

      const sceneVideoPaths =
        [];

      /* -----------------------------------------------------
         RENDER EVERY SCENE
      ----------------------------------------------------- */

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

        let scenePath;

        console.log(
          `Rendering scene ${
            i + 1
          }/${scenes.length}`
        );

        /* ---------------------------------------------------
           CHARACTER MODE
        --------------------------------------------------- */

        if (
          hasCharacterAnimation(
            scene
          )
        ) {
          console.log(
            "MODE: CHARACTER"
          );

          console.log(
            "Animation:",
            scene.animation
          );

          scenePath =
            path.join(
              tempDir,
              `character_scene_${uuidv4()}.mp4`
            );

          await renderCharacterVideo(
            {
              ...scene,
              duration,
            },
            scenePath
          );

          tempFiles.push(
            scenePath
          );
        }

        /* ---------------------------------------------------
           NORMAL MODE
        --------------------------------------------------- */

        else {
          if (
            !scene.imageUrl
          ) {
            throw new Error(
              `Scene ${
                i + 1
              } is missing imageUrl`
            );
          }

          console.log(
            "MODE: CINEMATIC"
          );

          const imagePath =
            path.join(
              tempDir,
              `image_${uuidv4()}${getExtensionFromUrl(
                scene.imageUrl,
                ".jpg"
              )}`
            );

          tempFiles.push(
            imagePath
          );

          await downloadFile(
            scene.imageUrl,
            imagePath
          );

          let audioPath =
            null;

          if (
            scene.audioUrl
          ) {
            audioPath =
              path.join(
                tempDir,
                `audio_${uuidv4()}.mp3`
              );

            tempFiles.push(
              audioPath
            );

            await downloadFile(
              scene.audioUrl,
              audioPath
            );
          }

          scenePath =
            path.join(
              tempDir,
              `scene_${uuidv4()}.mp4`
            );

          await renderSceneVideo(
            imagePath,
            audioPath,
            scenePath,
            duration
          );

          tempFiles.push(
            scenePath
          );
        }

        if (
          !fs.existsSync(
            scenePath
          )
        ) {
          throw new Error(
            `Scene ${
              i + 1
            } video was not created`
          );
        }

        const probe =
          await probeVideo(
            scenePath
          );

        const videoStreams =
          probe.streams.filter(
            (stream) =>
              stream.codec_type ===
              "video"
          );

        if (
          !videoStreams.length
        ) {
          throw new Error(
            `Scene ${
              i + 1
            } contains no video stream`
          );
        }

        sceneVideoPaths.push(
          scenePath
        );
      }

      /* -----------------------------------------------------
         CONCAT
      ----------------------------------------------------- */

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

      if (
        !fs.existsSync(
          finalPath
        )
      ) {
        throw new Error(
          "Final video was not created."
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
        "URL:",
        videoUrl
      );

      console.log(
        "SIZE:",
        stats.size
      );

      console.log(
        "VIDEO STREAMS:",
        videoStreams.length
      );

      console.log(
        "AUDIO STREAMS:",
        audioStreams.length
      );

      console.log(
        "========================================"
      );

      res.json({
        success: true,

        videoUrl,

        url:
          videoUrl,

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
        "FINAL VIDEO ERROR:",
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

/* =========================================================
   LEGACY ENDPOINT
========================================================= */

app.post(
  "/api/generate-video",
  async (req, res) => {
    try {
      const {
        scenes,
      } = req.body;

      if (
        !Array.isArray(
          scenes
        ) ||
        !scenes.length
      ) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "scenes array is required",
          });
      }

      /*
       * Keep old frontend compatible.
       */

      const fakeReq = {
        body: {
          scenes,
        },
      };

      req.body =
        fakeReq.body;

      /*
       * We cannot internally invoke the
       * Express handler easily here without
       * duplication, so redirect.
       */

      res.redirect(
        307,
        "/api/generate-final-video"
      );
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
   OPTIONAL UPLOAD
========================================================= */

app.post(
  "/api/upload",
  async (
    req,
    res
  ) => {
    res.status(400).json({
      success: false,

      error:
        "Manual uploads are disabled in the new AI workflow. Generate assets automatically from the editor.",
    });
  }
);

/* =========================================================
   404
========================================================= */

app.use(
  (
    req,
    res
  ) => {
    res.status(404).json({
      success: false,

      error:
        "Route not found",

      method:
        req.method,

      path:
        req.path,
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
      res.headersSent
    ) {
      return next(
        error
      );
    }

    res.status(
      error.status || 500
    ).json({
      success: false,

      error:
        error.message ||
        "Internal server error",
    });
  }
);

/* =========================================================
   SERVER
========================================================= */

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
        "PORT:",
        PORT
      );

      console.log(
        "SERVER:",
        SERVER_URL
      );

      console.log(
        "FFmpeg:",
        ffmpegStatic
          ? "OK"
          : "MISSING"
      );

      console.log(
        "FFprobe:",
        ffprobeStatic?.path
          ? "OK"
          : "MISSING"
      );

      console.log(
        "ElevenLabs:",
        ELEVENLABS_API_KEY
          ? "OK"
          : "MISSING"
      );

      console.log(
        "Pollinations:",
        "OK"
      );

      console.log(
        "Character generation:",
        "AUTOMATIC"
      );

      console.log(
        "Background generation:",
        "AUTOMATIC"
      );

      console.log(
        "Animation:",
        "TALK / TALK + WALK"
      );

      console.log(
        "========================================"
      );
    }
  );

/* =========================================================
   SHUTDOWN
========================================================= */

function shutdown(
  signal
) {
  console.log(
    `${signal} received.`
  );

  server.close(
    () => {
      console.log(
        "Server closed."
      );

      process.exit(0);
    }
  );

  setTimeout(
    () => {
      process.exit(1);
    },
    10000
  );
}

process.on(
  "SIGTERM",
  () =>
    shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () =>
    shutdown("SIGINT")
);