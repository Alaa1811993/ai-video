
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

app.use(
  cors({
    origin: true,
    credentials: true,
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
   FFMPEG
========================================================= */

ffmpeg.setFfmpegPath(ffmpegStatic);

if (ffprobeStatic && ffprobeStatic.path) {
  ffmpeg.setFfprobePath(
    ffprobeStatic.path
  );
}

/* =========================================================
   DIRECTORIES
========================================================= */

const ROOT_DIR = __dirname;

const UPLOAD_DIR = path.join(
  ROOT_DIR,
  "uploads"
);

const IMAGE_DIR = path.join(
  UPLOAD_DIR,
  "images"
);

const AUDIO_DIR = path.join(
  UPLOAD_DIR,
  "audio"
);

const VIDEO_DIR = path.join(
  UPLOAD_DIR,
  "videos"
);

const TEMP_DIR = path.join(
  UPLOAD_DIR,
  "temp"
);

[
  UPLOAD_DIR,
  IMAGE_DIR,
  AUDIO_DIR,
  VIDEO_DIR,
  TEMP_DIR,
].forEach((dir) => {
  fs.mkdirSync(dir, {
    recursive: true,
  });
});

/* =========================================================
   STATIC FILES
========================================================= */

app.use(
  "/uploads",
  express.static(UPLOAD_DIR, {
    maxAge: "1h",
  })
);

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
      const type =
        req.body?.type || "";

      if (
        file.mimetype.startsWith(
          "audio/"
        ) ||
        type === "audio" ||
        type === "sound"
      ) {
        cb(null, AUDIO_DIR);
      } else {
        cb(null, IMAGE_DIR);
      }
    },

    filename: function (
      req,
      file,
      cb
    ) {
      const extension =
        path.extname(
          file.originalname
        ) || ".bin";

      cb(
        null,
        `${Date.now()}-${uuidv4()}${extension}`
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

function publicUrl(
  req,
  relativePath
) {
  const protocol =
    req.headers["x-forwarded-proto"] ||
    req.protocol ||
    "https";

  const host =
    req.get("host");

  return `${protocol}://${host}${relativePath}`;
}

function normalizeUrl(
  req,
  value
) {
  if (!value) return "";

  if (
    value.startsWith("http://") ||
    value.startsWith("https://")
  ) {
    return value;
  }

  if (
    value.startsWith("/uploads/")
  ) {
    return publicUrl(
      req,
      value
    );
  }

  return value;
}

/* =========================================================
   DOWNLOAD FILE
========================================================= */

function downloadFile(
  url,
  outputPath
) {
  return new Promise(
    (resolve, reject) => {
      if (!url) {
        return reject(
          new Error(
            "Missing download URL."
          )
        );
      }

      if (
        url.startsWith(
          "data:"
        )
      ) {
        try {
          const comma =
            url.indexOf(",");

          const encoded =
            url.substring(
              comma + 1
            );

          const buffer =
            url.includes(
              ";base64,"
            )
              ? Buffer.from(
                  encoded,
                  "base64"
                )
              : Buffer.from(
                  decodeURIComponent(
                    encoded
                  )
                );

          fs.writeFileSync(
            outputPath,
            buffer
          );

          return resolve(
            outputPath
          );
        } catch (err) {
          return reject(err);
        }
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
              response.headers.location
            ) {
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
                file.close(() =>
                  resolve(
                    outputPath
                  )
                );
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
   SAFE REMOVE
========================================================= */

function removeFile(
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
  } catch (err) {
    console.warn(
      "Could not remove file:",
      filePath,
      err.message
    );
  }
}

/* =========================================================
   GENERATE IMAGE WITH POLLINATIONS
========================================================= */

function buildPollinationsUrl(
  prompt,
  width = 1280,
  height = 720
) {
  const encoded =
    encodeURIComponent(
      prompt
    );

  return (
    `https://image.pollinations.ai/prompt/${encoded}` +
    `?width=${width}` +
    `&height=${height}` +
    `&nologo=true` +
    `&model=flux`
  );
}

/* =========================================================
   DOWNLOAD POLLINATIONS IMAGE
========================================================= */

async function generateAndSaveImage(
  prompt,
  outputPath,
  width = 1280,
  height = 720
) {
  const url =
    buildPollinationsUrl(
      prompt,
      width,
      height
    );

  await downloadFile(
    url,
    outputPath
  );

  return outputPath;
}

/* =========================================================
   SCRIPT GENERATOR
========================================================= */

function createFallbackScenes(
  idea,
  language,
  videoType
) {
  const text =
    idea ||
    "Create an interesting video.";

  if (
    language === "Arabic"
  ) {
    return [
      {
        description:
          `المشهد الأول: تقديم الفكرة. ${text}`,

        narration:
          `في هذا المشهد نقدم الفكرة الرئيسية: ${text}`,

        imagePrompt:
          `سينمائي واقعي، المشهد الافتتاحي للقصة التالية: ${text}. تكوين احترافي، إضاءة سينمائية، تفاصيل واقعية، 16:9، بدون نص.`,

        animation:
          "talk",

        animationDescription:
          "الشخصية تتحدث بشكل طبيعي مع حركة بسيطة للرأس والجسم.",

        duration: 5,

        voice: "Female",
      },

      {
        description:
          "المشهد الثاني: تطور الأحداث.",

        narration:
          "تبدأ الأحداث في التطور وتظهر الشخصية الرئيسية وهي تتفاعل مع الموقف.",

        imagePrompt:
          `مشهد واقعي سينمائي يوضح تطور الأحداث في القصة: ${text}. الشخصية الرئيسية واضحة، خلفية مفصلة، إضاءة سينمائية، 16:9، بدون نص.`,

        animation:
          "walk",

        animationDescription:
          "الشخصية تمشي بشكل واضح من اليسار إلى اليمين مع حركة الجسم.",

        duration: 5,

        voice: "Female",
      },

      {
        description:
          "المشهد الثالث: النهاية.",

        narration:
          "نصل الآن إلى نهاية القصة مع لقطة سينمائية قوية.",

        imagePrompt:
          `مشهد ختامي واقعي وسينمائي للقصة: ${text}. لقطة نهائية قوية، تفاصيل عالية، إضاءة جميلة، 16:9، بدون نص.`,

        animation:
          "talk",

        animationDescription:
          "الشخصية تتحدث وتتحرك بشكل طبيعي في اللقطة النهائية.",

        duration: 5,

        voice: "Female",
      },
    ];
  }

  return [
    {
      description:
        `Opening scene: ${text}`,

      narration:
        `In this scene we introduce the main idea: ${text}`,

      imagePrompt:
        `Realistic cinematic opening scene for: ${text}. Professional composition, realistic lighting, detailed environment, 16:9, no text.`,

      animation:
        "talk",

      animationDescription:
        "The character talks naturally with subtle head and body movement.",

      duration: 5,

      voice: "Female",
    },

    {
      description:
        "The story develops.",

      narration:
        "The story develops and the main character reacts to what is happening.",

      imagePrompt:
        `Realistic cinematic scene showing the story developing: ${text}. Main character clearly visible, detailed environment, cinematic lighting, 16:9, no text.`,

      animation:
        "walk",

      animationDescription:
        "The character walks clearly from left to right with visible body movement.",

      duration: 5,

      voice: "Female",
    },

    {
      description:
        "Final scene.",

      narration:
        "We reach the final moment with a strong cinematic shot.",

      imagePrompt:
        `Realistic cinematic final scene for: ${text}. Strong final composition, detailed environment, cinematic lighting, 16:9, no text.`,

      animation:
        "talk",

      animationDescription:
        "The character talks naturally with visible movement.",

      duration: 5,

      voice: "Female",
    },
  ];
}

/* =========================================================
   IMAGE GENERATION
========================================================= */

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
          error:
            "Image prompt is required.",
        });
      }

      const filename =
        `image-${uuidv4()}.jpg`;

      const outputPath =
        path.join(
          IMAGE_DIR,
          filename
        );

      await generateAndSaveImage(
        prompt,
        outputPath,
        Number(width),
        Number(height)
      );

      const url =
        publicUrl(
          req,
          `/uploads/images/${filename}`
        );

      res.json({
        success: true,
        imageUrl: url,
        url,
      });
    } catch (err) {
      console.error(
        "Generate image error:",
        err
      );

      res.status(500).json({
        error:
          err.message ||
          "Image generation failed.",
      });
    }
  }
);

/* =========================================================
   CHARACTER GENERATION
========================================================= */

app.post(
  "/api/generate-character",
  async (req, res) => {
    try {
      const {
        prompt,
      } = req.body;

      if (!prompt) {
        return res.status(400).json({
          error:
            "Character prompt is required.",
        });
      }

      const characterPrompt =
        `${prompt}. ` +
        `Full body character, centered, standing, entire body visible, ` +
        `front or three-quarter view, isolated character, ` +
        `solid bright green background (#00ff00), ` +
        `no text, no watermark, cinematic realistic style.`;

      const filename =
        `character-${uuidv4()}.jpg`;

      const outputPath =
        path.join(
          IMAGE_DIR,
          filename
        );

      await generateAndSaveImage(
        characterPrompt,
        outputPath,
        1024,
        1024
      );

      const url =
        publicUrl(
          req,
          `/uploads/images/${filename}`
        );

      res.json({
        success: true,
        characterUrl: url,
        imageUrl: url,
        url,
      });
    } catch (err) {
      console.error(
        "Character generation error:",
        err
      );

      res.status(500).json({
        error:
          err.message ||
          "Character generation failed.",
      });
    }
  }
);

/* =========================================================
   BACKGROUND GENERATION
========================================================= */

app.post(
  "/api/generate-background",
  async (req, res) => {
    try {
      const {
        prompt,
      } = req.body;

      if (!prompt) {
        return res.status(400).json({
          error:
            "Background prompt is required.",
        });
      }

      const filename =
        `background-${uuidv4()}.jpg`;

      const outputPath =
        path.join(
          IMAGE_DIR,
          filename
        );

      await generateAndSaveImage(
        `${prompt}. Realistic cinematic environment, no characters, no text, 16:9.`,
        outputPath,
        1280,
        720
      );

      const url =
        publicUrl(
          req,
          `/uploads/images/${filename}`
        );

      res.json({
        success: true,
        backgroundUrl: url,
        imageUrl: url,
        url,
      });
    } catch (err) {
      console.error(
        "Background generation error:",
        err
      );

      res.status(500).json({
        error:
          err.message ||
          "Background generation failed.",
      });
    }
  }
);

/* =========================================================
   SCRIPT
========================================================= */

app.post(
  "/api/generate-script",
  async (req, res) => {
    try {
      const {
        idea,
        language = "Arabic",
        videoType = "Advertisement",
      } = req.body;

      if (!idea) {
        return res.status(400).json({
          error:
            "Idea is required.",
        });
      }

      const scenes =
        createFallbackScenes(
          idea,
          language,
          videoType
        );

      res.json({
        success: true,
        scenes,
      });
    } catch (err) {
      console.error(
        "Script error:",
        err
      );

      res.status(500).json({
        error:
          err.message ||
          "Script generation failed.",
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
      let uploaded =
        req.file;

      /*
       * Accept older frontend field
       * named "image" as well.
       */

      if (!uploaded && req.files) {
        uploaded =
          req.files.image?.[0];
      }

      if (!uploaded) {
        return res.status(400).json({
          error:
            "No file uploaded.",
        });
      }

      const isAudio =
        uploaded.mimetype.startsWith(
          "audio/"
        );

      const folder =
        isAudio
          ? "audio"
          : "images";

      const url =
        publicUrl(
          req,
          `/uploads/${folder}/${uploaded.filename}`
        );

      res.json({
        success: true,

        url,

        fileUrl: url,

        imageUrl:
          isAudio ? "" : url,

        audioUrl:
          isAudio ? url : "",
      });
    } catch (err) {
      console.error(
        "Upload error:",
        err
      );

      res.status(500).json({
        error:
          err.message ||
          "Upload failed.",
      });
    }
  }
);

/* =========================================================
   VOICE
========================================================= */

const VOICE_IDS = {
  Female:
    process.env
      .ELEVENLABS_FEMALE_VOICE_ID,

  Male:
    process.env
      .ELEVENLABS_MALE_VOICE_ID,

  "Deep Male":
    process.env
      .ELEVENLABS_DEEP_VOICE_ID,

  Storyteller:
    process.env
      .ELEVENLABS_STORYTELLER_VOICE_ID,
};

/* =========================================================
   ELEVENLABS REQUEST
========================================================= */

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
            "ELEVENLABS_API_KEY is not configured on Bonto."
          )
        );
      }

      if (!voiceId) {
        return reject(
          new Error(
            "No ElevenLabs voice ID configured."
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
            similarity_boost: 0.8,
            style: 0.25,
            use_speaker_boost: true,
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
            Buffer.byteLength(
              body
            ),
        },
      };

      const request =
        https.request(
          options,
          (response) => {
            const chunks = [];

            response.on(
              "data",
              (chunk) =>
                chunks.push(chunk)
            );

            response.on(
              "end",
              () => {
                const buffer =
                  Buffer.concat(
                    chunks
                  );

                if (
                  response.statusCode >=
                  200 &&
                  response.statusCode <
                    300
                ) {
                  resolve(buffer);
                } else {
                  reject(
                    new Error(
                      `ElevenLabs returned HTTP ${response.statusCode}: ${buffer.toString(
                        "utf8"
                      )}`
                    )
                  );
                }
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
      const {
        text,
        voice = "Female",
      } = req.body;

      if (!text) {
        return res.status(400).json({
          error:
            "Text is required.",
        });
      }

      const voiceId =
        VOICE_IDS[voice] ||
        VOICE_IDS.Female;

      const audio =
        await elevenLabsRequest(
          voiceId,
          text
        );

      const filename =
        `voice-${uuidv4()}.mp3`;

      const outputPath =
        path.join(
          AUDIO_DIR,
          filename
        );

      fs.writeFileSync(
        outputPath,
        audio
      );

      const url =
        publicUrl(
          req,
          `/uploads/audio/${filename}`
        );

      res.json({
        success: true,

        audioUrl: url,

        url,

        audio: url,
      });
    } catch (err) {
      console.error(
        "Voice error:",
        err
      );

      res.status(500).json({
        error:
          err.message ||
          "Voice generation failed.",
      });
    }
  }
);

/* =========================================================
   FFMPEG PROMISE
========================================================= */

function runFfmpeg(
  command
) {
  return new Promise(
    (resolve, reject) => {
      command
        .on(
          "start",
          (cmd) => {
            console.log(
              "FFmpeg:",
              cmd
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
                `FFmpeg progress: ${progress.percent.toFixed(
                  1
                )}%`
              );
            }
          }
        )

        .on(
          "error",
          (err) => {
            console.error(
              "FFmpeg error:",
              err.message
            );

            reject(err);
          }
        )

        .on(
          "end",
          () => {
            resolve();
          }
        )

        .run();
    }
  );
}

/* =========================================================
   ESCAPE FILTER PATH
========================================================= */

function filterPath(
  value
) {
  return String(value)
    .replace(
      /\\/g,
      "\\\\"
    )
    .replace(
      /:/g,
      "\\:"
    )
    .replace(
      /'/g,
      "\\'"
    );
}

/* =========================================================
   CHARACTER FILTER
========================================================= */

/*
 * The character is generated on a
 * green background.
 *
 * chromakey removes green.
 *
 * Then the character is animated
 * with FFmpeg expressions.
 *
 * This is real visible movement,
 * not just camera zoom.
 */

function buildCharacterFilter(
  animation
) {
  const mode =
    String(
      animation || "talk"
    ).toLowerCase();

  let x =
    "(W-w)/2";

  let y =
    "H-h-35";

  let rotation =
    "0";

  let scale =
    "1";

  /* --------------------------------
     TALK
  -------------------------------- */

  if (
    mode === "talk" ||
    mode === "talking"
  ) {
    x =
      "(W-w)/2+sin(t*4)*8";

    y =
      "H-h-35+abs(sin(t*5))*5";

    scale =
      "1+sin(t*5)*0.015";
  }

  /* --------------------------------
     WALK
  -------------------------------- */

  else if (
    mode === "walk" ||
    mode === "walking"
  ) {
    x =
      "mod(t*100,W+w)-w";

    y =
      "H-h-35+abs(sin(t*7))*12";

    rotation =
      "sin(t*7)*0.04";
  }

  /* --------------------------------
     TALK + WALK
  -------------------------------- */

  else if (
    mode ===
      "talk_walk" ||
    mode ===
      "talking-walking" ||
    mode ===
      "talking_walking"
  ) {
    x =
      "mod(t*85,W+w)-w";

    y =
      "H-h-35+abs(sin(t*7))*10";

    scale =
      "1+sin(t*5)*0.012";

    rotation =
      "sin(t*7)*0.035";
  }

  /* --------------------------------
     RUN
  -------------------------------- */

  else if (
    mode === "run" ||
    mode === "running"
  ) {
    x =
      "mod(t*230,W+w)-w";

    y =
      "H-h-35+abs(sin(t*11))*20";

    rotation =
      "sin(t*11)*0.08";
  }

  /* --------------------------------
     JUMP
  -------------------------------- */

  else if (
    mode === "jump" ||
    mode === "jumping"
  ) {
    x =
      "(W-w)/2+sin(t*3)*20";

    y =
      "H-h-35-abs(sin(t*3))*170";

    scale =
      "1+abs(sin(t*3))*0.05";
  }

  /* --------------------------------
     DANCE
  -------------------------------- */

  else if (
    mode === "dance" ||
    mode === "dancing"
  ) {
    x =
      "(W-w)/2+sin(t*3)*100";

    y =
      "H-h-35+abs(sin(t*6))*40";

    rotation =
      "sin(t*6)*0.15";

    scale =
      "1+sin(t*6)*0.04";
  }

  /* --------------------------------
     ATTACK
  -------------------------------- */

  else if (
    mode === "attack" ||
    mode === "attacking"
  ) {
    x =
      "(W-w)/2+sin(t*8)*80";

    y =
      "H-h-35-abs(sin(t*8))*35";

    rotation =
      "sin(t*8)*0.12";
  }

  /* --------------------------------
     CUSTOM
  -------------------------------- */

  else {
    x =
      "(W-w)/2+sin(t*2.5)*50";

    y =
      "H-h-35+abs(sin(t*4))*15";

    rotation =
      "sin(t*3)*0.06";
  }

  return {
    x,
    y,
    rotation,
    scale,
  };
}

/* =========================================================
   BUILD CUSTOM ANIMATION MODE
========================================================= */

function detectAnimation(
  animation,
  description
) {
  const combined =
    `${animation || ""} ${
      description || ""
    }`.toLowerCase();

  if (
    combined.includes(
      "talk"
    ) ||
    combined.includes(
      "speak"
    ) ||
    combined.includes(
      "يتحدث"
    ) ||
    combined.includes(
      "يتكلم"
    )
  ) {
    if (
      combined.includes(
        "walk"
      ) ||
      combined.includes(
        "يمشي"
      )
    ) {
      return "talk_walk";
    }

    return "talk";
  }

  if (
    combined.includes(
      "run"
    ) ||
    combined.includes(
      "يركض"
    ) ||
    combined.includes(
      "يجري"
    )
  ) {
    return "run";
  }

  if (
    combined.includes(
      "jump"
    ) ||
    combined.includes(
      "يقفز"
    )
  ) {
    return "jump";
  }

  if (
    combined.includes(
      "dance"
    ) ||
    combined.includes(
      "يرقص"
    )
  ) {
    return "dance";
  }

  if (
    combined.includes(
      "attack"
    ) ||
    combined.includes(
      "يهجم"
    ) ||
    combined.includes(
      "يهاجم"
    )
  ) {
    return "attack";
  }

  if (
    combined.includes(
      "walk"
    ) ||
    combined.includes(
      "يمشي"
    )
  ) {
    return "walk";
  }

  return "talk";
}

/* =========================================================
   RENDER SCENE
========================================================= */

async function renderSceneVideo(
  req,
  scene,
  index
) {
  const duration = Math.max(
    1,
    Math.min(
      60,
      Number(
        scene.duration || 5
      )
    )
  );

  const sceneId =
    uuidv4();

  const backgroundPath =
    path.join(
      TEMP_DIR,
      `${sceneId}-background.jpg`
    );

  const characterPath =
    path.join(
      TEMP_DIR,
      `${sceneId}-character.png`
    );

  const voicePath =
    path.join(
      TEMP_DIR,
      `${sceneId}-voice.mp3`
    );

  const sfxPath =
    path.join(
      TEMP_DIR,
      `${sceneId}-sfx.mp3`
    );

  const outputPath =
    path.join(
      VIDEO_DIR,
      `scene-${uuidv4()}.mp4`
    );

  let hasCharacter =
    false;

  let hasVoice =
    false;

  let hasSfx =
    false;

  try {
    /* --------------------------------
       BACKGROUND
    -------------------------------- */

    const backgroundUrl =
      normalizeUrl(
        req,
        scene.imageUrl ||
          scene.backgroundUrl
      );

    if (!backgroundUrl) {
      throw new Error(
        `Scene ${index + 1}: imageUrl is required.`
      );
    }

    await downloadFile(
      backgroundUrl,
      backgroundPath
    );

    /* --------------------------------
       CHARACTER
    -------------------------------- */

    const characterUrl =
      normalizeUrl(
        req,
        scene.characterUrl
      );

    if (characterUrl) {
      try {
        await downloadFile(
          characterUrl,
          characterPath
        );

        hasCharacter = true;
      } catch (err) {
        console.warn(
          `Scene ${index + 1}: character could not be downloaded.`,
          err.message
        );

        hasCharacter = false;
      }
    }

    /* --------------------------------
       VOICE
    -------------------------------- */

    const audioUrl =
      normalizeUrl(
        req,
        scene.audioUrl
      );

    if (audioUrl) {
      try {
        await downloadFile(
          audioUrl,
          voicePath
        );

        hasVoice = true;
      } catch (err) {
        console.warn(
          `Scene ${index + 1}: voice could not be downloaded.`,
          err.message
        );
      }
    }

    /* --------------------------------
       SOUND EFFECT
    -------------------------------- */

    const soundEffectUrl =
      normalizeUrl(
        req,
        scene.soundEffectUrl
      );

    if (soundEffectUrl) {
      try {
        await downloadFile(
          soundEffectUrl,
          sfxPath
        );

        hasSfx = true;
      } catch (err) {
        console.warn(
          `Scene ${index + 1}: sound effect could not be downloaded.`,
          err.message
        );
      }
    }

    /* --------------------------------
       BACKGROUND INPUT
    -------------------------------- */

    let command =
      ffmpeg();

    command =
      command
        .input(
          backgroundPath
        )
        .inputOptions([
          "-loop 1",
        ]);

    /* --------------------------------
       CHARACTER INPUT
    -------------------------------- */

    if (hasCharacter) {
      command =
        command
          .input(
            characterPath
          )
          .inputOptions([
            "-loop 1",
          ]);
    }

    /* --------------------------------
       AUDIO INPUTS
    -------------------------------- */

    if (hasVoice) {
      command =
        command.input(
          voicePath
        );
    }

    if (hasSfx) {
      command =
        command.input(
          sfxPath
        );
    }

    /* --------------------------------
       VIDEO FILTER
    -------------------------------- */

    const filters = [];

    /*
     * Background:
     * fit into 1280x720.
     */

    filters.push(
      `[0:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1[bg]`
    );

    let videoLabel =
      "[bg]";

    /* --------------------------------
       CHARACTER OVERLAY
    -------------------------------- */

    if (hasCharacter) {
      const animation =
        detectAnimation(
          scene.animation,
          scene.animationDescription
        );

      const movement =
        buildCharacterFilter(
          animation
        );

      /*
       * Character:
       *
       * 1. scale
       * 2. chromakey green
       * 3. format rgba
       * 4. rotate
       * 5. overlay with movement
       */

      filters.push(
        `[1:v]scale=420:-1,chromakey=0x00ff00:0.22:0.08,format=rgba,rotate=${movement.rotation}:c=none:ow=rotw(iw):oh=roth(ih)[char]`
      );

      filters.push(
        `[bg][char]overlay=x=${movement.x}:y=${movement.y}:shortest=1:eval=frame[vchar]`
      );

      videoLabel =
        "[vchar]";
    }

    /* --------------------------------
       AUDIO
    -------------------------------- */

    let audioLabel =
      null;

    if (
      hasVoice &&
      hasSfx
    ) {
      /*
       * Input:
       *
       * 0 background
       * 1 character
       * 2 voice
       * 3 sfx
       */

      filters.push(
        `[2:a]aresample=44100,volume=1.0[voice]`
      );

      filters.push(
        `[3:a]aresample=44100,volume=0.35[sfx]`
      );

      filters.push(
        `[voice][sfx]amix=inputs=2:duration=longest:dropout_transition=2[aout]`
      );

      audioLabel =
        "[aout]";
    } else if (
      hasVoice
    ) {
      filters.push(
        `[1:a]aresample=44100,volume=1.0[aout]`
      );

      /*
       * When there is a character,
       * voice is input 2.
       *
       * Without character,
       * voice is input 1.
       */

      if (hasCharacter) {
        filters[
          filters.length - 1
        ] =
          `[2:a]aresample=44100,volume=1.0[aout]`;
      }

      audioLabel =
        "[aout]";
    } else if (
      hasSfx
    ) {
      let audioIndex =
        hasCharacter
          ? 3
          : 1;

      filters.push(
        `[${audioIndex}:a]aresample=44100,volume=1.0[aout]`
      );

      audioLabel =
        "[aout]";
    }

    /* --------------------------------
       OUTPUT
    -------------------------------- */

    command =
      command
        .complexFilter(
          filters
        )
        .outputOptions([
          "-map",
          videoLabel,

          ...(audioLabel
            ? [
                "-map",
                audioLabel,
              ]
            : []),

          "-t",
          String(duration),

          "-r",
          "30",

          "-c:v",
          "libx264",

          "-preset",
          "veryfast",

          "-crf",
          "23",

          "-pix_fmt",
          "yuv420p",

          ...(audioLabel
            ? [
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-ar",
                "44100",
              ]
            : []),

          "-movflags",
          "+faststart",

          "-shortest",
        ])
        .output(
          outputPath
        );

    await runFfmpeg(
      command
    );

    const relative =
      `/uploads/videos/${path.basename(
        outputPath
      )}`;

    return {
      videoUrl:
        publicUrl(
          req,
          relative
        ),
    };
  } finally {
    removeFile(
      backgroundPath
    );

    removeFile(
      characterPath
    );

    removeFile(
      voicePath
    );

    removeFile(
      sfxPath
    );
  }
}

/* =========================================================
   GENERATE SCENE VIDEO
========================================================= */

app.post(
  "/api/generate-scene-video",
  async (req, res) => {
    try {
      const scene =
        req.body;

      if (!scene.imageUrl) {
        return res.status(400).json({
          error:
            "imageUrl is required.",
        });
      }

      console.log(
        "Generating scene video:",
        {
          animation:
            scene.animation,

          description:
            scene.animationDescription,

          duration:
            scene.duration,
        }
      );

      const result =
        await renderSceneVideo(
          req,
          scene,
          0
        );

      res.json({
        success: true,

        videoUrl:
          result.videoUrl,

        url:
          result.videoUrl,
      });
    } catch (err) {
      console.error(
        "Scene video error:",
        err
      );

      res.status(500).json({
        error:
          err.message ||
          "Scene video generation failed.",
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
    const tempSceneVideos =
      [];

    const concatFile =
      path.join(
        TEMP_DIR,
        `concat-${uuidv4()}.txt`
      );

    const finalFilename =
      `video-${uuidv4()}.mp4`;

    const finalPath =
      path.join(
        VIDEO_DIR,
        finalFilename
      );

    try {
      const scenes =
        Array.isArray(
          req.body.scenes
        )
          ? req.body.scenes
          : [];

      if (!scenes.length) {
        return res.status(400).json({
          error:
            "At least one scene is required.",
        });
      }

      console.log(
        `Rendering ${scenes.length} scenes...`
      );

      /* --------------------------------
         RENDER EACH SCENE
      -------------------------------- */

      for (
        let i = 0;
        i < scenes.length;
        i++
      ) {
        console.log(
          `Rendering scene ${
            i + 1
          }/${scenes.length}`
        );

        const result =
          await renderSceneVideo(
            req,
            scenes[i],
            i
          );

        /*
         * Download the generated scene
         * video locally so we can concatenate.
         */

        const localScene =
          path.join(
            TEMP_DIR,
            `scene-${uuidv4()}.mp4`
          );

        await downloadFile(
          result.videoUrl,
          localScene
        );

        tempSceneVideos.push(
          localScene
        );
      }

      /* --------------------------------
         CONCAT FILE
      -------------------------------- */

      const concatText =
        tempSceneVideos
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
        concatText,
        "utf8"
      );

      /* --------------------------------
         CONCATENATE
      -------------------------------- */

      await runFfmpeg(
        ffmpeg()
          .input(
            concatFile
          )
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
          .output(
            finalPath
          )
      );

      const url =
        publicUrl(
          req,
          `/uploads/videos/${finalFilename}`
        );

      res.json({
        success: true,

        videoUrl: url,

        url,

        projectId:
          req.body.projectId ||
          null,
      });
    } catch (err) {
      console.error(
        "Final video error:",
        err
      );

      removeFile(
        finalPath
      );

      res.status(500).json({
        error:
          err.message ||
          "Final video generation failed.",
      });
    } finally {
      removeFile(
        concatFile
      );

      tempSceneVideos.forEach(
        removeFile
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

    return app._router.handle(
      req,
      res
    );
  }
);

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      success: true,

      status: "ok",

      server:
        "AI Video Server",

      port: PORT,

      ffmpeg:
        Boolean(ffmpegStatic),

      ffprobe:
        Boolean(
          ffprobeStatic &&
          ffprobeStatic.path
        ),

      elevenlabs:
        Boolean(
          process.env
            .ELEVENLABS_API_KEY
        ),

      uploads:
        UPLOAD_DIR,

      animation:
        true,
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
        "AI Video Server is working.",
      time:
        new Date().toISOString(),
    });
  }
);

/* =========================================================
   FFMPEG TEST
========================================================= */

app.get(
  "/api/test-ffmpeg",
  (req, res) => {
    ffmpeg()
      .input("color=c=black:s=320x240:d=1")
      .inputFormat("lavfi")
      .outputOptions([
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
      ])
      .format("mp4")
      .on(
        "end",
        () => {
          res.json({
            success: true,
            message:
              "FFmpeg is working.",
          });
        }
      )
      .on(
        "error",
        (err) => {
          res.status(500).json({
            success: false,
            error:
              err.message,
          });
        }
      )
      .output(
        path.join(
          TEMP_DIR,
          `ffmpeg-test-${Date.now()}.mp4`
        )
      )
      .run();
  }
);

/* =========================================================
   404
========================================================= */

app.use(
  (req, res) => {
    res.status(404).json({
      error:
        "Route not found.",
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
    err,
    req,
    res,
    next
  ) => {
    console.error(
      "Express error:",
      err
    );

    if (
      err instanceof
      multer.MulterError
    ) {
      return res.status(400).json({
        error:
          `Upload error: ${err.message}`,
      });
    }

    res.status(500).json({
      error:
        err.message ||
        "Internal server error.",
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
      "AI VIDEO SERVER STARTED"
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Uploads: ${UPLOAD_DIR}`
    );

    console.log(
      "Animation system: ENABLED"
    );

    console.log(
      "========================================"
    );
  }
);

