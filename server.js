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

// ============================================================
// APP CONFIG
// ============================================================

const app = express();

const PORT = Number(process.env.PORT) || 5000;

const SERVER_URL =
  process.env.SERVER_URL || `http://localhost:${PORT}`;

const ELEVENLABS_API_KEY =
  process.env.ELEVENLABS_API_KEY || "";

const ELEVENLABS_VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID || "";

const ELEVENLABS_MODEL =
  process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2";

const MAX_VIDEO_SECONDS = 60;

// ============================================================
// DIRECTORIES
// ============================================================

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

// ============================================================
// FFMPEG
// ============================================================

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

if (ffprobeStatic && ffprobeStatic.path) {
  ffmpeg.setFfprobePath(ffprobeStatic.path);
}

// ============================================================
// CORS
// ============================================================

const allowedOrigins = [
  "https://ai-video-studio-542c9.web.app",
  "https://ai-video-studio-542c9.firebaseapp.com",
  "http://localhost:5173",
  "http://localhost:5174",
];

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests without an Origin header
    // such as Postman/curl/server-to-server.
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.log("CORS blocked origin:", origin);

    return callback(
      new Error("Not allowed by CORS")
    );
  },

  methods: [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
  ],

  allowedHeaders: [
    "Content-Type",
    "Authorization",
  ],

  credentials: true,
};

// IMPORTANT:
// Do NOT use:
// app.options("*", cors());
// It can cause PathError with some Express/path-to-regexp versions.

app.use(cors(corsOptions));

// ============================================================
// BODY PARSING
// ============================================================

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
  express.static(UPLOADS_DIR, {
    maxAge: "1h",
  })
);

// ============================================================
// MULTER
// ============================================================

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, TEMP_DIR);
  },

  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname || "");

    cb(
      null,
      `${uuidv4()}${ext}`
    );
  },
});

const upload = multer({
  storage,

  limits: {
    fileSize: 100 * 1024 * 1024,
  },
});

// ============================================================
// HELPERS
// ============================================================

function getServerUrl() {
  return SERVER_URL.replace(/\/+$/, "");
}

function safeFilename(filename) {
  return String(filename || "")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

function deleteFile(filePath) {
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

function getPublicUrl(relativePath) {
  const cleanPath = relativePath
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");

  return `${getServerUrl()}/${cleanPath}`;
}

// ============================================================
// DOWNLOAD FILE
// ============================================================

function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    if (!url) {
      return reject(
        new Error("Missing URL")
      );
    }

    const protocol = url.startsWith("https")
      ? https
      : http;

    const request = protocol.get(
      url,
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
            outputPath
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
              `Download failed with HTTP ${response.statusCode}: ${url}`
            )
          );
        }

        const file = fs.createWriteStream(
          outputPath
        );

        response.pipe(file);

        file.on("finish", () => {
          file.close(() => {
            resolve(outputPath);
          });
        });

        file.on("error", (error) => {
          file.close(() => {});
          deleteFile(outputPath);
          reject(error);
        });
      }
    );

    request.setTimeout(
      120000,
      () => {
        request.destroy(
          new Error(
            "Download timeout"
          )
        );
      }
    );

    request.on("error", (error) => {
      deleteFile(outputPath);
      reject(error);
    });
  });
}

// ============================================================
// PROBE MEDIA
// ============================================================

function probeMedia(filePath) {
  return new Promise(
    (resolve, reject) => {
      ffmpeg.ffprobe(
        filePath,
        (error, metadata) => {
          if (error) {
            return reject(error);
          }

          resolve(metadata);
        }
      );
    }
  );
}

// ============================================================
// GENERATE IMAGE
// ============================================================

async function generatePollinationsImage(
  prompt
) {
  if (!prompt) {
    throw new Error(
      "Image prompt is required"
    );
  }

  const encodedPrompt =
    encodeURIComponent(prompt);

  const imageUrl =
    `https://image.pollinations.ai/prompt/${encodedPrompt}` +
    `?model=flux` +
    `&width=1280` +
    `&height=720` +
    `&nologo=true`;

  const filename =
    `image_${uuidv4()}.png`;

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
      "Generated image file does not exist"
    );
  }

  const stats =
    fs.statSync(outputPath);

  if (stats.size === 0) {
    throw new Error(
      "Generated image is empty"
    );
  }

  return {
    filename,
    path: outputPath,
    url: getPublicUrl(
      `uploads/images/${filename}`
    ),
  };
}

// ============================================================
// ELEVENLABS VOICE
// ============================================================

async function generateElevenLabsVoice(
  text
) {
  if (!ELEVENLABS_API_KEY) {
    throw new Error(
      "ELEVENLABS_API_KEY is not configured"
    );
  }

  if (!ELEVENLABS_VOICE_ID) {
    throw new Error(
      "ELEVENLABS_VOICE_ID is not configured"
    );
  }

  if (!text || !String(text).trim()) {
    throw new Error(
      "Voice text is required"
    );
  }

  const apiUrl =
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`;

  console.log(
    "Generating ElevenLabs voice using configured voice ID"
  );

  const response = await fetch(
    apiUrl,
    {
      method: "POST",

      headers: {
        "xi-api-key":
          ELEVENLABS_API_KEY,

        "Content-Type":
          "application/json",

        "Accept":
          "audio/mpeg",
      },

      body: JSON.stringify({
        text: String(text),

        model_id:
          ELEVENLABS_MODEL,

        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    }
  );

  if (!response.ok) {
    let errorText = "";

    try {
      errorText =
        await response.text();
    } catch (error) {
      errorText =
        "Unable to read ElevenLabs error";
    }

    throw new Error(
      `ElevenLabs HTTP ${response.status}: ${errorText}`
    );
  }

  const audioBuffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  if (!audioBuffer.length) {
    throw new Error(
      "ElevenLabs returned empty audio"
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

  return {
    filename,
    path: outputPath,
    url: getPublicUrl(
      `uploads/audio/${filename}`
    ),
  };
}

// ============================================================
// RENDER ONE SCENE VIDEO
// ============================================================

/*function renderSceneVideo({
  imagePath,
  audioPath,
  outputPath,
  requestedDuration = 5,
}) {
  return new Promise(
    async (resolve, reject) => {
      try {
        const audioMetadata =
          await probeMedia(
            audioPath
          );

        const audioStream =
          audioMetadata.streams.find(
            (stream) =>
              stream.codec_type ===
              "audio"
          );

        const audioDuration =
          Number(
            audioStream?.duration ||
              audioMetadata.format?.duration ||
              0
          );

        const requested =
          Number(
            requestedDuration
          ) || 5;

        const duration =
          Math.max(
            0.5,
            Math.min(
              Math.max(
                requested,
                audioDuration
              ),
              MAX_VIDEO_SECONDS
            )
          );

        console.log(
          `Rendering scene video. Duration: ${duration}s`
        );

        ffmpeg()
          .input(imagePath)
          .inputOptions([
            "-loop 1",
          ])

          .input(audioPath)

          .videoFilters([
            "scale=1280:720:force_original_aspect_ratio=decrease",
            "pad=1280:720:(ow-iw)/2:(oh-ih)/2",
            "setsar=1",
          ])

          .videoCodec("libx264")

          .outputOptions([
            "-preset ultrafast",
            "-crf 28",
            "-r 24",
            "-pix_fmt yuv420p",

            "-c:a aac",
            "-b:a 128k",

            "-shortest",

            "-movflags +faststart",

            "-threads 1",
          ])

          .duration(duration)

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
                `Scene progress: ${progress.percent || 0}%`
              );
            }
          )

          .on(
            "stderr",
            (stderrLine) => {
              if (
                stderrLine &&
                stderrLine.trim()
              ) {
                console.log(
                  "Scene FFmpeg:",
                  stderrLine
                );
              }
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
              console.log(
                "Scene video completed:",
                outputPath
              );

              resolve(
                outputPath
              );
            }
          )

          .save(outputPath);
      } catch (error) {
        reject(error);
      }
    }
  );
}
*/
// ============================================================
// RENDER ONE SCENE VIDEO WITH PHOTO ANIMATION
// ============================================================

function renderSceneVideo({
  imagePath,
  audioPath,
  outputPath,
  requestedDuration = 5,
  animationIndex = 0,
}) {
  return new Promise(
    async (resolve, reject) => {
      try {
        const audioMetadata =
          await probeMedia(audioPath);

        const audioStream =
          audioMetadata.streams.find(
            (stream) =>
              stream.codec_type === "audio"
          );

        const audioDuration =
          Number(
            audioStream?.duration ||
              audioMetadata.format?.duration ||
              0
          );

        const requested =
          Number(requestedDuration) || 5;

        const duration =
          Math.max(
            0.5,
            Math.min(
              Math.max(
                requested,
                audioDuration
              ),
              MAX_VIDEO_SECONDS
            )
          );

        console.log(
          `Rendering animated scene. Duration: ${duration}s`
        );

        // ----------------------------------------------------
        // ANIMATION TYPES
        // ----------------------------------------------------
        //
        // 0 = Slow Zoom In
        // 1 = Slow Zoom Out
        // 2 = Pan Left -> Right
        // 3 = Pan Right -> Left
        // 4 = Pan Up -> Down
        // 5 = Pan Down -> Up
        // 6 = Zoom + Pan
        //
        // Every scene gets a different movement.
        // ----------------------------------------------------

        const animation =
          Number(animationIndex) % 7;

        const fps = 24;

        // Extra-large canvas gives FFmpeg room
        // to move the image smoothly.
        const baseScale =
          "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080";

        let animationFilter = "";

        if (animation === 0) {
          // --------------------------------------------
          // SLOW ZOOM IN
          // --------------------------------------------

          animationFilter =
            `zoompan=` +
            `z='min(zoom+0.0008,1.18)':` +
            `x='iw/2-(iw/zoom/2)':` +
            `y='ih/2-(ih/zoom/2)':` +
            `d='${Math.ceil(duration * fps)}':` +
            `s=1280x720:` +
            `fps=${fps}`;
        }

        else if (animation === 1) {
          // --------------------------------------------
          // SLOW ZOOM OUT
          // --------------------------------------------

          animationFilter =
            `zoompan=` +
            `z='if(eq(on,1),1.18,max(1.0,zoom-0.0008))':` +
            `x='iw/2-(iw/zoom/2)':` +
            `y='ih/2-(ih/zoom/2)':` +
            `d='${Math.ceil(duration * fps)}':` +
            `s=1280x720:` +
            `fps=${fps}`;
        }

        else if (animation === 2) {
          // --------------------------------------------
          // PAN LEFT -> RIGHT
          // --------------------------------------------

          animationFilter =
            `zoompan=` +
            `z='1.12':` +
            `x='(iw-iw/zoom)*on/${Math.max(
              1,
              Math.ceil(duration * fps) - 1
            )}':` +
            `y='ih/2-(ih/zoom/2)':` +
            `d='${Math.ceil(duration * fps)}':` +
            `s=1280x720:` +
            `fps=${fps}`;
        }

        else if (animation === 3) {
          // --------------------------------------------
          // PAN RIGHT -> LEFT
          // --------------------------------------------

          animationFilter =
            `zoompan=` +
            `z='1.12':` +
            `x='(iw-iw/zoom)*(1-on/${Math.max(
              1,
              Math.ceil(duration * fps) - 1
            )})':` +
            `y='ih/2-(ih/zoom/2)':` +
            `d='${Math.ceil(duration * fps)}':` +
            `s=1280x720:` +
            `fps=${fps}`;
        }

        else if (animation === 4) {
          // --------------------------------------------
          // PAN TOP -> BOTTOM
          // --------------------------------------------

          animationFilter =
            `zoompan=` +
            `z='1.12':` +
            `x='iw/2-(iw/zoom/2)':` +
            `y='(ih-ih/zoom)*on/${Math.max(
              1,
              Math.ceil(duration * fps) - 1
            )}':` +
            `d='${Math.ceil(duration * fps)}':` +
            `s=1280x720:` +
            `fps=${fps}`;
        }

        else if (animation === 5) {
          // --------------------------------------------
          // PAN BOTTOM -> TOP
          // --------------------------------------------

          animationFilter =
            `zoompan=` +
            `z='1.12':` +
            `x='iw/2-(iw/zoom/2)':` +
            `y='(ih-ih/zoom)*(1-on/${Math.max(
              1,
              Math.ceil(duration * fps) - 1
            )})':` +
            `d='${Math.ceil(duration * fps)}':` +
            `s=1280x720:` +
            `fps=${fps}`;
        }

        else {
          // --------------------------------------------
          // ZOOM + DIAGONAL MOVEMENT
          // --------------------------------------------

          animationFilter =
            `zoompan=` +
            `z='min(zoom+0.0007,1.15)':` +
            `x='(iw-iw/zoom)*on/${Math.max(
              1,
              Math.ceil(duration * fps) - 1
            )}':` +
            `y='(ih-ih/zoom)*on/${Math.max(
              1,
              Math.ceil(duration * fps) - 1
            )}':` +
            `d='${Math.ceil(duration * fps)}':` +
            `s=1280x720:` +
            `fps=${fps}`;
        }

        console.log(
          `Animation type: ${animation}`
        );

        const videoFilters = [
          baseScale,
          animationFilter,
          "setsar=1",
        ];

        ffmpeg()
          .input(imagePath)

          // Keep image alive while zoompan
          // creates the animation frames.
          .inputOptions([
            "-loop",
            "1",
          ])

          .input(audioPath)

          .videoFilters(
            videoFilters
          )

          .videoCodec("libx264")

          .outputOptions([
            "-preset",
            "ultrafast",

            "-crf",
            "28",

            "-r",
            String(fps),

            "-pix_fmt",
            "yuv420p",

            "-c:a",
            "aac",

            "-b:a",
            "128k",

            "-shortest",

            "-movflags",
            "+faststart",

            "-threads",
            "1",
          ])

          .duration(duration)

          .on(
            "start",
            (commandLine) => {
              console.log(
                "Animated Scene FFmpeg:",
                commandLine
              );
            }
          )

          .on(
            "progress",
            (progress) => {
              console.log(
                `Animated Scene progress: ${
                  progress.percent || 0
                }%`
              );
            }
          )

          .on(
            "stderr",
            (stderrLine) => {
              if (
                stderrLine &&
                stderrLine.trim()
              ) {
                console.log(
                  "Animated Scene FFmpeg:",
                  stderrLine
                );
              }
            }
          )

          .on(
            "error",
            (error) => {
              console.error(
                "Animated Scene FFmpeg error:",
                error
              );

              reject(error);
            }
          )

          .on(
            "end",
            () => {
              console.log(
                "Animated scene completed:",
                outputPath
              );

              resolve(outputPath);
            }
          )

          .save(outputPath);

      } catch (error) {
        reject(error);
      }
    }
  );
}
// ============================================================
// CONCAT SCENE VIDEOS
// ============================================================

function concatSceneVideos(
  sceneVideoPaths,
  outputPath
) {
  return new Promise(
    (resolve, reject) => {
      if (
        !sceneVideoPaths ||
        !sceneVideoPaths.length
      ) {
        return reject(
          new Error(
            "No scene videos to concatenate"
          )
        );
      }

      const concatFile =
        path.join(
          TEMP_DIR,
          `concat_${uuidv4()}.txt`
        );

      try {
        const content =
          sceneVideoPaths
            .map(
              (filePath) =>
                `file '${filePath.replace(/'/g, "'\\''")}'`
            )
            .join("\n");

        fs.writeFileSync(
          concatFile,
          content,
          "utf8"
        );

        console.log(
          "Concatenating scene videos..."
        );

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
            "progress",
            (progress) => {
              console.log(
                `Concat progress: ${progress.percent || 0}%`
              );
            }
          )

          .on(
            "stderr",
            (stderrLine) => {
              if (
                stderrLine &&
                stderrLine.trim()
              ) {
                console.log(
                  "Concat FFmpeg:",
                  stderrLine
                );
              }
            }
          )

          .on(
            "error",
            (error) => {
              console.error(
                "Concat error:",
                error
              );

              deleteFile(
                concatFile
              );

              reject(error);
            }
          )

          .on(
            "end",
            () => {
              console.log(
                "Final video concatenation completed"
              );

              deleteFile(
                concatFile
              );

              resolve(
                outputPath
              );
            }
          )

          .save(outputPath);
      } catch (error) {
        deleteFile(
          concatFile
        );

        reject(error);
      }
    }
  );
}

// ============================================================
// VERIFY VIDEO
// ============================================================

async function verifyVideo(
  filePath
) {
  const metadata =
    await probeMedia(
      filePath
    );

  const streams =
    metadata.streams || [];

  const hasVideo =
    streams.some(
      (stream) =>
        stream.codec_type ===
        "video"
    );

  const hasAudio =
    streams.some(
      (stream) =>
        stream.codec_type ===
        "audio"
    );

  const duration =
    Number(
      metadata.format?.duration ||
        0
    );

  return {
    hasVideo,
    hasAudio,
    duration,
    streams,
  };
}

// ============================================================
// HEALTH ROUTE
// ============================================================

app.get(
  "/",
  (req, res) => {
    res.json({
      success: true,
      message:
        "AI Video Server is running",
      serverUrl:
        getServerUrl(),

      endpoints: {
        test:
          "GET /api/test",

        image:
          "POST /api/generate-image",

        voice:
          "POST /api/generate-voice",

        sceneVideo:
          "POST /api/generate-scene-video",

        finalVideo:
          "POST /api/generate-final-video",

        videoAlias:
          "POST /api/generate-video",

        upload:
          "POST /api/upload",
      },
    });
  }
);

// ============================================================
// TEST ROUTE
// ============================================================

app.get(
  "/api/test",
  (req, res) => {
    res.json({
      success: true,
      message:
        "AI Video API is working",
      serverUrl:
        getServerUrl(),

      elevenLabs: {
        configured:
          Boolean(
            ELEVENLABS_API_KEY
          ),

        voiceConfigured:
          Boolean(
            ELEVENLABS_VOICE_ID
          ),

        model:
          ELEVENLABS_MODEL,
      },

      ffmpeg: {
        configured:
          Boolean(
            ffmpegStatic
          ),

        ffprobe:
          Boolean(
            ffprobeStatic?.path
          ),
      },

      time:
        new Date().toISOString(),
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
        imagePrompt,
        description,
      } = req.body || {};

      const finalPrompt =
        prompt ||
        imagePrompt ||
        description;

      if (
        !finalPrompt ||
        !String(finalPrompt).trim()
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Image prompt is required.",
        });
      }

      console.log(
        "Image request:",
        finalPrompt
      );

      const result =
        await generatePollinationsImage(
          String(finalPrompt)
        );

      return res.json({
        success: true,

        imageUrl:
          result.url,

        url:
          result.url,

        filename:
          result.filename,
      });
    } catch (error) {
      console.error(
        "Image generation error:",
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

// ============================================================
// GENERATE VOICE
// ============================================================

app.post(
  "/api/generate-voice",
  async (req, res) => {
    try {
      const {
        text,
        narration,
      } = req.body || {};

      const finalText =
        text ||
        narration;

      if (
        !finalText ||
        !String(finalText).trim()
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Text or narration is required.",
        });
      }

      console.log(
        "Voice request received"
      );

      const result =
        await generateElevenLabsVoice(
          String(finalText)
        );

      return res.json({
        success: true,

        audioUrl:
          result.url,

        url:
          result.url,

        filename:
          result.filename,
      });
    } catch (error) {
      console.error(
        "Voice generation error:",
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

// ============================================================
// GENERATE ONE SCENE VIDEO
// ============================================================

app.post(
  "/api/generate-scene-video",
  async (req, res) => {
    let imagePath = null;
    let audioPath = null;
    let outputPath = null;

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

      if (!audioUrl) {
        return res.status(400).json({
          success: false,
          error:
            "audioUrl is required.",
        });
      }

      const id =
        uuidv4();

      const imageFilename =
        `scene_image_${id}.png`;

      const audioFilename =
        `scene_audio_${id}.mp3`;

      const videoFilename =
        `scene_video_${id}.mp4`;

      imagePath =
        path.join(
          TEMP_DIR,
          imageFilename
        );

      audioPath =
        path.join(
          TEMP_DIR,
          audioFilename
        );

      outputPath =
        path.join(
          VIDEOS_DIR,
          videoFilename
        );

      console.log(
        "Downloading scene image..."
      );

      await downloadFile(
        imageUrl,
        imagePath
      );

      console.log(
        "Downloading scene audio..."
      );

      await downloadFile(
        audioUrl,
        audioPath
      );

      await renderSceneVideo({
        imagePath,
        audioPath,
        outputPath,
        requestedDuration:
          duration || 5,
      });

      const verification =
        await verifyVideo(
          outputPath
        );

      if (
        !verification.hasVideo
      ) {
        throw new Error(
          "Generated scene video has no video stream."
        );
      }

      if (
        !verification.hasAudio
      ) {
        throw new Error(
          "Generated scene video has no audio stream."
        );
      }

      const videoUrl =
        getPublicUrl(
          `uploads/videos/${videoFilename}`
        );

      return res.json({
        success: true,

        videoUrl,

        url: videoUrl,

        filename:
          videoFilename,

        hasAudio:
          verification.hasAudio,

        hasVideo:
          verification.hasVideo,

        duration:
          verification.duration,
      });
    } catch (error) {
      console.error(
        "Scene video error:",
        error
      );

      deleteFile(
        outputPath
      );

      return res.status(500).json({
        success: false,

        error:
          error.message ||
          "Scene video generation failed.",
      });
    } finally {
      deleteFile(
        imagePath
      );

      deleteFile(
        audioPath
      );
    }
  }
);

// ============================================================
// GENERATE FINAL VIDEO
// ============================================================

async function generateFinalVideo(
  scenes
) {
  const tempFiles = [];
  const sceneVideoPaths = [];

  try {
    if (
      !Array.isArray(scenes) ||
      scenes.length === 0
    ) {
      throw new Error(
        "No scenes provided."
      );
    }

    if (
      scenes.length > 20
    ) {
      throw new Error(
        "Maximum 20 scenes are allowed."
      );
    }

    console.log(
      `Generating final video from ${scenes.length} scenes`
    );

    // --------------------------------------------
    // PROCESS EACH SCENE
    // --------------------------------------------

    for (
      let index = 0;
      index < scenes.length;
      index++
    ) {
      const scene =
        scenes[index];

      if (!scene) {
        throw new Error(
          `Scene ${index + 1} is empty.`
        );
      }

      const imageUrl =
        scene.imageUrl;

      const audioUrl =
        scene.audioUrl;

      if (!imageUrl) {
        throw new Error(
          `Scene ${index + 1} has no imageUrl.`
        );
      }

      if (!audioUrl) {
        throw new Error(
          `Scene ${index + 1} has no audioUrl.`
        );
      }

      console.log(
        `Processing scene ${index + 1}/${scenes.length}`
      );

      const id =
        uuidv4();

      const imagePath =
        path.join(
          TEMP_DIR,
          `final_image_${id}.png`
        );

      const audioPath =
        path.join(
          TEMP_DIR,
          `final_audio_${id}.mp3`
        );

      const sceneVideoPath =
        path.join(
          TEMP_DIR,
          `final_scene_${id}.mp4`
        );

      tempFiles.push(
        imagePath,
        audioPath,
        sceneVideoPath
      );

      console.log(
        `Downloading image for scene ${index + 1}`
      );

      await downloadFile(
        imageUrl,
        imagePath
      );

      console.log(
        `Downloading audio for scene ${index + 1}`
      );

      await downloadFile(
        audioUrl,
        audioPath
      );

      await renderSceneVideo({
        imagePath,
        audioPath,
        outputPath:
          sceneVideoPath,

        requestedDuration:
          scene.duration ||
          5,
           animationIndex:
    index,
      });

      sceneVideoPaths.push(
        sceneVideoPath
      );
    }

    // --------------------------------------------
    // FINAL OUTPUT
    // --------------------------------------------

    const finalFilename =
      `video_${uuidv4()}.mp4`;

    const finalOutputPath =
      path.join(
        VIDEOS_DIR,
        finalFilename
      );

    console.log(
      "Concatenating final video..."
    );

    await concatSceneVideos(
      sceneVideoPaths,
      finalOutputPath
    );

    // --------------------------------------------
    // VERIFY
    // --------------------------------------------

    console.log(
      "Verifying final video..."
    );

    const verification =
      await verifyVideo(
        finalOutputPath
      );

    console.log(
      "Final video verification:",
      {
        hasVideo:
          verification.hasVideo,

        hasAudio:
          verification.hasAudio,

        duration:
          verification.duration,
      }
    );

    if (
      !verification.hasVideo
    ) {
      throw new Error(
        "Final video does not contain a video stream."
      );
    }

    if (
      !verification.hasAudio
    ) {
      throw new Error(
        "Final video does not contain an audio stream."
      );
    }

    const videoUrl =
      getPublicUrl(
        `uploads/videos/${finalFilename}`
      );

    console.log(
      "Final video URL:",
      videoUrl
    );

    return {
      videoUrl,

      url:
        videoUrl,

      filename:
        finalFilename,

      scenes:
        scenes.length,

      hasAudio:
        verification.hasAudio,

      hasVideo:
        verification.hasVideo,

      duration:
        verification.duration,
    };
  } finally {
    // --------------------------------------------
    // CLEAN TEMP FILES
    // --------------------------------------------

    for (
      const filePath of tempFiles
    ) {
      deleteFile(
        filePath
      );
    }
  }
}

// ============================================================
// FINAL VIDEO ROUTE
// ============================================================

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
            "No scenes provided.",
        });
      }

      const result =
        await generateFinalVideo(
          scenes
        );

      return res.json({
        success: true,

        videoUrl:
          result.videoUrl,

        url:
          result.url,

        filename:
          result.filename,

        scenes:
          result.scenes,

        hasAudio:
          result.hasAudio,

        hasVideo:
          result.hasVideo,

        duration:
          result.duration,
      });
    } catch (error) {
      console.error(
        "Final video generation error:",
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

// ============================================================
// GENERATE VIDEO ALIAS
// ============================================================

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
            "No scenes provided.",
        });
      }

      const result =
        await generateFinalVideo(
          scenes
        );

      return res.json({
        success: true,

        videoUrl:
          result.videoUrl,

        url:
          result.url,

        filename:
          result.filename,

        scenes:
          result.scenes,

        hasAudio:
          result.hasAudio,

        hasVideo:
          result.hasVideo,

        duration:
          result.duration,
      });
    } catch (error) {
      console.error(
        "Video generation error:",
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

// ============================================================
// UPLOAD FILE
// ============================================================

app.post(
  "/api/upload",
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error:
            "No file uploaded.",
        });
      }

      const file =
        req.file;

      const originalName =
        safeFilename(
          file.originalname
        );

      const extension =
        path.extname(
          originalName
        );

      const baseName =
        path.basename(
          originalName,
          extension
        );

      const filename =
        `${baseName}_${uuidv4()}${extension}`;

      let targetDirectory =
        UPLOADS_DIR;

      const mimetype =
        file.mimetype || "";

      if (
        mimetype.startsWith(
          "image/"
        )
      ) {
        targetDirectory =
          IMAGES_DIR;
      } else if (
        mimetype.startsWith(
          "audio/"
        )
      ) {
        targetDirectory =
          AUDIO_DIR;
      } else if (
        mimetype.startsWith(
          "video/"
        )
      ) {
        targetDirectory =
          VIDEOS_DIR;
      }

      const targetPath =
        path.join(
          targetDirectory,
          filename
        );

      fs.renameSync(
        file.path,
        targetPath
      );

      let relativePath =
        "uploads";

      if (
        targetDirectory ===
        IMAGES_DIR
      ) {
        relativePath =
          "uploads/images";
      } else if (
        targetDirectory ===
        AUDIO_DIR
      ) {
        relativePath =
          "uploads/audio";
      } else if (
        targetDirectory ===
        VIDEOS_DIR
      ) {
        relativePath =
          "uploads/videos";
      }

      const url =
        getPublicUrl(
          `${relativePath}/${filename}`
        );

      return res.json({
        success: true,

        url,

        fileUrl:
          url,

        filename,
      });
    } catch (error) {
      console.error(
        "Upload error:",
        error
      );

      if (
        req.file?.path
      ) {
        deleteFile(
          req.file.path
        );
      }

      return res.status(500).json({
        success: false,

        error:
          error.message ||
          "Upload failed.",
      });
    }
  }
);

// ============================================================
// DOWNLOAD VIDEO
// ============================================================

app.get(
  "/api/download-video/:filename",
  (req, res) => {
    try {
      const filename =
        safeFilename(
          req.params.filename
        );

      const filePath =
        path.join(
          VIDEOS_DIR,
          filename
        );

      if (
        !fs.existsSync(filePath)
      ) {
        return res.status(404).json({
          success: false,
          error:
            "Video not found.",
        });
      }

      return res.download(
        filePath,
        filename
      );
    } catch (error) {
      console.error(
        "Download error:",
        error
      );

      return res.status(500).json({
        success: false,

        error:
          error.message ||
          "Download failed.",
      });
    }
  }
);

// ============================================================
// 404
// ============================================================

app.use(
  (req, res) => {
    res.status(404).json({
      success: false,

      error:
        "Route not found.",

      route:
        `${req.method} ${req.originalUrl}`,
    });
  }
);

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use(
  (error, req, res, next) => {
    console.error(
      "Global error:",
      error
    );

    if (
      error.message ===
      "Not allowed by CORS"
    ) {
      return res.status(403).json({
        success: false,
        error:
          "CORS blocked this origin.",
      });
    }

    return res.status(500).json({
      success: false,

      error:
        error.message ||
        "Internal server error.",
    });
  }
);

// ============================================================
// START SERVER
// ============================================================

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
      "======================================"
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Server URL: ${getServerUrl()}`
    );

    console.log(
      `ElevenLabs API configured: ${Boolean(
        ELEVENLABS_API_KEY
      )}`
    );

    console.log(
      `ElevenLabs Voice configured: ${Boolean(
        ELEVENLABS_VOICE_ID
      )}`
    );

    console.log(
      `ElevenLabs Model: ${ELEVENLABS_MODEL}`
    );

    console.log(
      `FFmpeg configured: ${Boolean(
        ffmpegStatic
      )}`
    );

    console.log(
      `FFprobe configured: ${Boolean(
        ffprobeStatic?.path
      )}`
    );

    console.log(
      "======================================"
    );
  }
);