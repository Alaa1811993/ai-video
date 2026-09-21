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
   EXPRESS
========================================================= */

const app = express();

const PORT = Number(process.env.PORT) || 5000;

const ELEVENLABS_API_KEY =
  process.env.ELEVENLABS_API_KEY || "";

/* =========================================================
   DIRECTORIES
========================================================= */

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

/* =========================================================
   FFMPEG / FFPROBE
========================================================= */

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

console.log(
  "FFmpeg:",
  resolvedFfmpegPath
);

console.log(
  "FFmpeg exists:",
  !!resolvedFfmpegPath &&
    fs.existsSync(resolvedFfmpegPath)
);

console.log(
  "FFprobe:",
  resolvedFfprobePath
);

console.log(
  "FFprobe exists:",
  !!resolvedFfprobePath &&
    fs.existsSync(resolvedFfprobePath)
);

console.log("========================================");
console.log("");

if (
  resolvedFfmpegPath &&
  fs.existsSync(resolvedFfmpegPath)
) {
  ffmpeg.setFfmpegPath(
    resolvedFfmpegPath
  );
} else {
  console.error(
    "ERROR: FFmpeg executable was not found."
  );
}

if (
  resolvedFfprobePath &&
  fs.existsSync(resolvedFfprobePath)
) {
  ffmpeg.setFfprobePath(
    resolvedFfprobePath
  );
} else {
  console.error(
    "ERROR: FFprobe executable was not found."
  );
}

/* =========================================================
   MIDDLEWARE
========================================================= */

app.use(
  cors({
    origin: true,
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
  express.static(UPLOADS_DIR)
);

/* =========================================================
   MULTER
========================================================= */

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const mimetype =
      file.mimetype || "";

    if (
      mimetype.startsWith("image/")
    ) {
      return cb(
        null,
        IMAGES_DIR
      );
    }

    if (
      mimetype.startsWith("audio/")
    ) {
      return cb(
        null,
        AUDIO_DIR
      );
    }

    return cb(
      null,
      TEMP_DIR
    );
  },

  filename: (req, file, cb) => {
    const ext =
      path.extname(
        file.originalname || ""
      ) || "";

    cb(
      null,
      `${uuidv4()}${ext}`
    );
  },
});

const upload = multer({
  storage,

  limits: {
    fileSize:
      100 * 1024 * 1024,
  },
});

/* =========================================================
   SERVER URL
========================================================= */

function getServerUrl() {
  return (
    process.env.SERVER_URL ||
    `http://localhost:${PORT}`
  );
}

/* =========================================================
   FFMPEG CHECK
========================================================= */

function ensureFfmpegAvailable() {
  if (!resolvedFfmpegPath) {
    throw new Error(
      "FFmpeg path is undefined. Make sure ffmpeg-static is installed."
    );
  }

  if (
    !fs.existsSync(
      resolvedFfmpegPath
    )
  ) {
    throw new Error(
      `FFmpeg executable not found: ${resolvedFfmpegPath}`
    );
  }

  if (
    !resolvedFfprobePath
  ) {
    throw new Error(
      "FFprobe path is undefined. Make sure ffprobe-static is installed."
    );
  }

  if (
    !fs.existsSync(
      resolvedFfprobePath
    )
  ) {
    throw new Error(
      `FFprobe executable not found: ${resolvedFfprobePath}`
    );
  }
}

/* =========================================================
   MEDIA DURATION
========================================================= */

function getMediaDuration(
  filePath
) {
  return new Promise(
    (resolve, reject) => {
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
            metadata &&
              metadata.format &&
              metadata.format.duration
          );

          if (
            !Number.isFinite(
              duration
            ) ||
            duration <= 0
          ) {
            return reject(
              new Error(
                "Could not determine media duration."
              )
            );
          }

          resolve(duration);
        }
      );
    }
  );
}

/* =========================================================
   DOWNLOAD FILE
========================================================= */

function downloadFile(
  url,
  targetPath,
  redirects = 0
) {
  return new Promise(
    (resolve, reject) => {
      if (!url) {
        return reject(
          new Error(
            "URL is empty."
          )
        );
      }

      if (
        redirects > 10
      ) {
        return reject(
          new Error(
            "Too many redirects."
          )
        );
      }

      if (
        !url.startsWith(
          "http://"
        ) &&
        !url.startsWith(
          "https://"
        )
      ) {
        if (
          fs.existsSync(url)
        ) {
          try {
            fs.copyFileSync(
              url,
              targetPath
            );

            return resolve(
              targetPath
            );
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
        url.startsWith(
          "https://"
        )
          ? https
          : http;

      let request;

      try {
        request =
          client.get(
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
                response.statusCode !==
                200
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
                  file.close(
                    () => {
                      resolve(
                        targetPath
                      );
                    }
                  );
                }
              );

              file.on(
                "error",
                (error) => {
                  try {
                    if (
                      fs.existsSync(
                        targetPath
                      )
                    ) {
                      fs.unlinkSync(
                        targetPath
                      );
                    }
                  } catch {}

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

/* =========================================================
   ELEVENLABS VOICES
========================================================= */

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

/* =========================================================
   VOICE ID
========================================================= */

function getVoiceId(
  voice
) {
  return (
    VOICE_IDS[voice] ||
    VOICE_IDS.Female
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

      if (
        !ELEVENLABS_API_KEY
      ) {
        return res.status(500).json({
          success: false,
          error:
            "ELEVENLABS_API_KEY is missing in .env",
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

      const response =
        await fetch(
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
                stability:
                  0.5,

                similarity_boost:
                  0.75,

                style:
                  0.3,

                use_speaker_boost:
                  true,
              },
            }),
          }
        );

      if (
        !response.ok
      ) {
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
              `ElevenLabs error: ${errorText}`,
          });
      }

      const audioBuffer =
        Buffer.from(
          await response.arrayBuffer()
        );

      if (
        audioBuffer.length <
        1000
      ) {
        throw new Error(
          "ElevenLabs returned empty or invalid audio."
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

      const stats =
        fs.statSync(
          outputPath
        );

      console.log(
        "Audio file size:",
        stats.size,
        "bytes"
      );

      if (
        stats.size < 1000
      ) {
        throw new Error(
          "Generated MP3 is invalid."
        );
      }

      let duration = null;

      try {
        duration =
          await getMediaDuration(
            outputPath
          );

        console.log(
          "Audio duration:",
          duration,
          "seconds"
        );
      } catch (error) {
        console.warn(
          "Could not read voice duration:",
          error.message
        );
      }

      const audioUrl =
        `${getServerUrl()}/uploads/audio/${filename}`;

      console.log(
        "Voice saved:",
        audioUrl
      );

      return res.json({
        success: true,

        audioUrl,

        url: audioUrl,

        audio:
          audioUrl,

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
            "No file provided.",
        });
      }

      const mimetype =
        req.file.mimetype || "";

      let folder =
        "temp";

      if (
        mimetype.startsWith(
          "image/"
        )
      ) {
        folder =
          "images";
      }

      if (
        mimetype.startsWith(
          "audio/"
        )
      ) {
        folder =
          "audio";
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

/* =========================================================
   GENERATE IMAGE
========================================================= */

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

      console.log("");
      console.log(
        "========================================"
      );
      console.log(
        "GENERATING AI IMAGE"
      );
      console.log(
        "========================================"
      );
      console.log(
        finalPrompt
      );

      const imageUrl =
        `https://image.pollinations.ai/prompt/${encodeURIComponent(
          finalPrompt
        )}?width=1280&height=720&model=flux&nologo=true`;

      const response =
        await fetch(
          imageUrl
        );

      if (
        !response.ok
      ) {
        throw new Error(
          `Image generation failed. HTTP ${response.status}`
        );
      }

      const buffer =
        Buffer.from(
          await response.arrayBuffer()
        );

      if (
        buffer.length <
        1000
      ) {
        throw new Error(
          "Image generation returned invalid data."
        );
      }

      const filename =
        `image_${uuidv4()}.jpg`;

      const outputPath =
        path.join(
          IMAGES_DIR,
          filename
        );

      fs.writeFileSync(
        outputPath,
        buffer
      );

      const localUrl =
        `${getServerUrl()}/uploads/images/${filename}`;

      console.log(
        "Image saved:",
        localUrl
      );

      return res.json({
        success: true,

        imageUrl:
          localUrl,

        url:
          localUrl,

        filename,
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

/* =========================================================
   RENDER ONE SCENE
========================================================= */

function renderSceneVideo(
  imagePath,
  audioPath,
  requestedDuration,
  outputPath
) {
  return new Promise(
    async (resolve, reject) => {
      try {
        ensureFfmpegAvailable();

        console.log("");
        console.log(
          "========================================"
        );
        console.log(
          "RENDERING SCENE VIDEO"
        );
        console.log(
          "========================================"
        );

        console.log(
          "Image:",
          imagePath
        );

        console.log(
          "Audio:",
          audioPath
        );

        console.log(
          "Output:",
          outputPath
        );

        if (
          !fs.existsSync(
            imagePath
          )
        ) {
          throw new Error(
            `Image file does not exist: ${imagePath}`
          );
        }

        if (!audioPath) {
          throw new Error(
            "Audio path is missing. Refusing to create silent video."
          );
        }

        if (
          !fs.existsSync(
            audioPath
          )
        ) {
          throw new Error(
            `Audio file does not exist: ${audioPath}`
          );
        }

        const audioStats =
          fs.statSync(
            audioPath
          );

        console.log(
          "Audio size:",
          audioStats.size,
          "bytes"
        );

        if (
          audioStats.size <
          1000
        ) {
          throw new Error(
            "Audio file is empty or invalid."
          );
        }

        let audioDuration;

        try {
          audioDuration =
            await getMediaDuration(
              audioPath
            );

          console.log(
            "Audio duration:",
            audioDuration,
            "seconds"
          );
        } catch (error) {
          console.error(
            "FFprobe audio error:",
            error.message
          );

          throw new Error(
            `Cannot read MP3 duration: ${error.message}`
          );
        }

        const requested =
          Number(
            requestedDuration
          ) || 5;

        const duration =
          Math.max(
            requested,
            audioDuration + 0.5
          );

        console.log(
          "Requested duration:",
          requested
        );

        console.log(
          "Final duration:",
          duration
        );

        const command =
          ffmpeg();

        command
          .input(imagePath)
          .inputOptions([
            "-loop",
            "1",
          ]);

        command.input(
          audioPath
        );

        command.videoFilters([
          "scale=1280:720:force_original_aspect_ratio=increase",
          "crop=1280:720",

          `zoompan=z='min(zoom+0.0008,1.08)':d=${Math.ceil(
            duration * 30
          )}:s=1280x720:fps=30`,

          "setsar=1",

          "format=yuv420p",
        ]);

        command.outputOptions([
          "-map",
          "0:v:0",

          "-map",
          "1:a:0",

          "-c:v",
          "libx264",

          "-preset",
          "medium",

          "-crf",
          "20",

          "-r",
          "30",

          "-pix_fmt",
          "yuv420p",

          "-c:a",
          "aac",

          "-b:a",
          "192k",

          "-ar",
          "44100",

          "-ac",
          "2",

          "-t",
          String(duration),

          "-movflags",
          "+faststart",
        ]);

        command
          .on(
            "start",
            (commandLine) => {
              console.log("");
              console.log(
                "FFmpeg scene command:"
              );
              console.log(
                commandLine
              );
              console.log("");
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
                  `Scene progress: ${progress.percent.toFixed(
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
                "FFmpeg:",
                line
              );
            }
          )

          .on(
            "end",
            async () => {
              try {
                console.log(
                  "Scene FFmpeg finished."
                );

                if (
                  !fs.existsSync(
                    outputPath
                  )
                ) {
                  return reject(
                    new Error(
                      "FFmpeg completed but scene output does not exist."
                    )
                  );
                }

                const outputStats =
                  fs.statSync(
                    outputPath
                  );

                console.log(
                  "Scene output size:",
                  outputStats.size,
                  "bytes"
                );

                if (
                  outputStats.size <
                  1000
                ) {
                  return reject(
                    new Error(
                      "Scene output file is empty."
                    )
                  );
                }

                try {
                  const metadata =
                    await new Promise(
                      (
                        resolveMetadata,
                        rejectMetadata
                      ) => {
                        ffmpeg.ffprobe(
                          outputPath,
                          (
                            error,
                            data
                          ) => {
                            if (
                              error
                            ) {
                              rejectMetadata(
                                error
                              );
                            } else {
                              resolveMetadata(
                                data
                              );
                            }
                          }
                        );
                      }
                    );

                  const audioStreams =
                    (
                      metadata.streams ||
                      []
                    ).filter(
                      (stream) =>
                        stream.codec_type ===
                        "audio"
                    );

                  console.log(
                    "Scene audio streams:",
                    audioStreams.length
                  );

                  if (
                    audioStreams.length ===
                    0
                  ) {
                    return reject(
                      new Error(
                        "Scene video was created WITHOUT an audio stream."
                      )
                    );
                  }

                  console.log(
                    "Scene audio verified successfully."
                  );
                } catch (verifyError) {
                  return reject(
                    new Error(
                      `Scene audio verification failed: ${verifyError.message}`
                    )
                  );
                }

                resolve(
                  outputPath
                );
              } catch (error) {
                reject(error);
              }
            }
          )

          .on(
            "error",
            (error) => {
              console.error("");
              console.error(
                "========== SCENE FFMPEG ERROR =========="
              );
              console.error(
                error
              );
              console.error(
                error.message
              );
              console.error(
                "========================================"
              );

              reject(error);
            }
          )

          .save(
            outputPath
          );
      } catch (error) {
        console.error(
          "renderSceneVideo error:",
          error
        );

        reject(error);
      }
    }
  );
}

/* =========================================================
   GENERATE SINGLE SCENE VIDEO
========================================================= */

app.post(
  "/api/generate-scene-video",
  async (req, res) => {
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
          "audioUrl is required. Generate the voice first.",
      });
    }

    const jobId =
      uuidv4();

    const jobDir =
      path.join(
        TEMP_DIR,
        jobId
      );

    fs.mkdirSync(
      jobDir,
      {
        recursive: true,
      }
    );

    try {
      ensureFfmpegAvailable();

      const imagePath =
        path.join(
          jobDir,
          "image.jpg"
        );

      const audioPath =
        path.join(
          jobDir,
          "audio.mp3"
        );

      const outputPath =
        path.join(
          VIDEOS_DIR,
          `scene_${jobId}.mp4`
        );

      await downloadFile(
        imageUrl,
        imagePath
      );

      await downloadFile(
        audioUrl,
        audioPath
      );

      if (
        !fs.existsSync(
          audioPath
        )
      ) {
        throw new Error(
          "Audio was not downloaded."
        );
      }

      await renderSceneVideo(
        imagePath,
        audioPath,
        duration || 5,
        outputPath
      );

      const videoUrl =
        `${getServerUrl()}/uploads/videos/${path.basename(
          outputPath
        )}`;

      return res.json({
        success: true,

        videoUrl,

        url:
          videoUrl,
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
    } finally {
      setTimeout(
        () => {
          try {
            fs.rmSync(
              jobDir,
              {
                recursive: true,
                force: true,
              }
            );
          } catch {}
        },
        5000
      );
    }
  }
);

/* =========================================================
   GENERATE FINAL VIDEO
========================================================= */

app.post(
  "/api/generate-final-video",
  async (req, res) => {
    const {
      scenes,
    } = req.body || {};

    if (
      !Array.isArray(
        scenes
      ) ||
      scenes.length === 0
    ) {
      return res.status(400).json({
        success: false,

        error:
          "No scenes provided.",
      });
    }

    const jobId =
      uuidv4();

    const jobDir =
      path.join(
        TEMP_DIR,
        jobId
      );

    fs.mkdirSync(
      jobDir,
      {
        recursive: true,
      }
    );

    try {
      ensureFfmpegAvailable();

      console.log("");
      console.log(
        "========================================"
      );
      console.log(
        "GENERATING FINAL VIDEO"
      );
      console.log(
        "========================================"
      );
      console.log(
        "Scenes:",
        scenes.length
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
          `========== SCENE ${
            i + 1
          } / ${
            scenes.length
          } ==========`
        );

        if (
          !scene ||
          !scene.imageUrl
        ) {
          throw new Error(
            `Scene ${
              i + 1
            } has no imageUrl.`
          );
        }

        if (
          !scene.audioUrl
        ) {
          throw new Error(
            `Scene ${
              i + 1
            } has no audioUrl. Generate the voice first.`
          );
        }

        const imagePath =
          path.join(
            jobDir,
            `image_${i}.jpg`
          );

        const audioPath =
          path.join(
            jobDir,
            `audio_${i}.mp3`
          );

        const sceneVideo =
          path.join(
            jobDir,
            `scene_${i}.mp4`
          );

        console.log(
          "Downloading image..."
        );

        await downloadFile(
          scene.imageUrl,
          imagePath
        );

        if (
          !fs.existsSync(
            imagePath
          )
        ) {
          throw new Error(
            `Scene ${
              i + 1
            } image download failed.`
          );
        }

        console.log(
          "Downloading audio..."
        );

        console.log(
          "Audio URL:",
          scene.audioUrl
        );

        await downloadFile(
          scene.audioUrl,
          audioPath
        );

        if (
          !fs.existsSync(
            audioPath
          )
        ) {
          throw new Error(
            `Scene ${
              i + 1
            } audio download failed.`
          );
        }

        const audioStats =
          fs.statSync(
            audioPath
          );

        console.log(
          "Downloaded audio size:",
          audioStats.size,
          "bytes"
        );

        if (
          audioStats.size <
          1000
        ) {
          throw new Error(
            `Scene ${
              i + 1
            } audio file is invalid.`
          );
        }

        const audioDuration =
          await getMediaDuration(
            audioPath
          );

        console.log(
          "Scene audio duration:",
          audioDuration,
          "seconds"
        );

        await renderSceneVideo(
          imagePath,
          audioPath,
          Number(
            scene.duration
          ) || 5,
          sceneVideo
        );

        if (
          !fs.existsSync(
            sceneVideo
          )
        ) {
          throw new Error(
            `Scene ${
              i + 1
            } video was not created.`
          );
        }

        sceneVideos.push(
          sceneVideo
        );

        console.log(
          `Scene ${
            i + 1
          } completed successfully.`
        );
      }

      const concatFile =
        path.join(
          jobDir,
          "concat.txt"
        );

      const concatContent =
        sceneVideos
          .map(
            (file) => {
              const safePath =
                path
                  .resolve(file)
                  .replace(
                    /\\/g,
                    "/"
                  )
                  .replace(
                    /'/g,
                    "'\\''"
                  );

              return `file '${safePath}'`;
            }
          )
          .join("\n");

      fs.writeFileSync(
        concatFile,
        concatContent,
        "utf8"
      );

      console.log("");
      console.log(
        "Concat file:"
      );
      console.log(
        concatContent
      );

      const finalFilename =
        `video_${jobId}.mp4`;

      const finalPath =
        path.join(
          VIDEOS_DIR,
          finalFilename
        );

      console.log("");
      console.log(
        "========================================"
      );
      console.log(
        "COMBINING SCENE VIDEOS"
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
              "-f",
              "concat",

              "-safe",
              "0",
            ])

            .outputOptions([
              "-map",
              "0:v:0",

              "-map",
              "0:a:0",

              "-c:v",
              "libx264",

              "-preset",
              "medium",

              "-crf",
              "20",

              "-pix_fmt",
              "yuv420p",

              "-r",
              "30",

              "-c:a",
              "aac",

              "-b:a",
              "192k",

              "-ar",
              "44100",

              "-ac",
              "2",

              "-movflags",
              "+faststart",
            ])

            .on(
              "start",
              (
                commandLine
              ) => {
                console.log("");
                console.log(
                  "========== FINAL FFMPEG COMMAND =========="
                );
                console.log(
                  commandLine
                );
                console.log(
                  "=========================================="
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
                    `Final video: ${progress.percent.toFixed(
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
                  "Final FFmpeg:",
                  line
                );
              }
            )

            .on(
              "end",
              () => {
                console.log(
                  "Final FFmpeg completed."
                );

                resolve();
              }
            )

            .on(
              "error",
              (error) => {
                console.error(
                  "FINAL FFMPEG ERROR:",
                  error
                );

                reject(error);
              }
            )

            .save(
              finalPath
            );
        }
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

      const finalStats =
        fs.statSync(
          finalPath
        );

      console.log(
        "Final video size:",
        finalStats.size,
        "bytes"
      );

      if (
        finalStats.size <
        1000
      ) {
        throw new Error(
          "Final video file is empty."
        );
      }

      const finalMetadata =
        await new Promise(
          (
            resolve,
            reject
          ) => {
            ffmpeg.ffprobe(
              finalPath,
              (
                error,
                metadata
              ) => {
                if (error) {
                  reject(error);
                } else {
                  resolve(
                    metadata
                  );
                }
              }
            );
          }
        );

      const finalAudioStreams =
        (
          finalMetadata.streams ||
          []
        ).filter(
          (stream) =>
            stream.codec_type ===
            "audio"
        );

      const finalVideoStreams =
        (
          finalMetadata.streams ||
          []
        ).filter(
          (stream) =>
            stream.codec_type ===
            "video"
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
        finalAudioStreams.length ===
        0
      ) {
        throw new Error(
          "FINAL VIDEO HAS NO AUDIO STREAM."
        );
      }

      if (
        finalVideoStreams.length ===
        0
      ) {
        throw new Error(
          "FINAL VIDEO HAS NO VIDEO STREAM."
        );
      }

      const videoUrl =
        `${getServerUrl()}/uploads/videos/${finalFilename}`;

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
        "Video:",
        videoUrl
      );
      console.log(
        "Audio streams:",
        finalAudioStreams.length
      );
      console.log(
        "Video streams:",
        finalVideoStreams.length
      );
      console.log(
        "========================================"
      );

      return res.json({
        success: true,

        videoUrl,

        url:
          videoUrl,

        filename:
          finalFilename,

        scenes:
          scenes.length,

        hasAudio:
          finalAudioStreams.length >
          0,

        hasVideo:
          finalVideoStreams.length >
          0,
      });
    } catch (error) {
      console.error("");
      console.error(
        "========================================"
      );
      console.error(
        "FINAL VIDEO GENERATION FAILED"
      );
      console.error(
        "========================================"
      );
      console.error(
        error.message
      );
      console.error(
        error.stack
      );
      console.error(
        "========================================"
      );

      return res.status(500).json({
        success: false,

        error:
          error.message ||
          "Final video generation failed.",

        ffmpegPath:
          resolvedFfmpegPath,

        ffprobePath:
          resolvedFfprobePath,
      });
    } finally {
      setTimeout(
        () => {
          try {
            if (
              fs.existsSync(
                jobDir
              )
            ) {
              fs.rmSync(
                jobDir,
                {
                  recursive: true,
                  force: true,
                }
              );
            }
          } catch (error) {
            console.warn(
              "Temp cleanup error:",
              error.message
            );
          }
        },
        5000
      );
    }
  }
);

/* =========================================================
   GENERATE VIDEO ALIAS
========================================================= */

app.post(
  "/api/generate-video",
  async (req, res) => {
    try {
      const {
        scenes,
      } = req.body || {};

      /*
       MULTIPLE SCENES
      */

      if (
        Array.isArray(scenes)
      ) {
        req.url =
          "/api/generate-final-video";

        return app.handle(
          req,
          res
        );
      }

      /*
       SINGLE SCENE
      */

      req.url =
        "/api/generate-scene-video";

      return app.handle(
        req,
        res
      );
    } catch (error) {
      console.error(
        "Generate video alias error:",
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

/* =========================================================
   TEST FFMPEG
========================================================= */

app.get(
  "/api/test-ffmpeg",
  async (req, res) => {
    const filename =
      `ffmpeg_test_${uuidv4()}.mp4`;

    const outputPath =
      path.join(
        VIDEOS_DIR,
        filename
      );

    try {
      ensureFfmpegAvailable();

      await new Promise(
        (
          resolve,
          reject
        ) => {
          ffmpeg()
            .input(
              "color=c=black:s=1280x720:r=30"
            )

            .inputFormat(
              "lavfi"
            )

            .input(
              "anullsrc=channel_layout=stereo:sample_rate=44100"
            )

            .inputFormat(
              "lavfi"
            )

            .outputOptions([
              "-map",
              "0:v:0",

              "-map",
              "1:a:0",

              "-c:v",
              "libx264",

              "-c:a",
              "aac",

              "-t",
              "2",

              "-pix_fmt",
              "yuv420p",

              "-shortest",
            ])

            .on(
              "start",
              (commandLine) => {
                console.log(
                  "FFmpeg test:",
                  commandLine
                );
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

      return res.json({
        success: true,

        videoUrl:
          `${getServerUrl()}/uploads/videos/${filename}`,
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

/* =========================================================
   SERVER TEST
========================================================= */

app.get(
  "/api/test",
  (req, res) => {
    res.json({
      success: true,

      server:
        "AI Video Studio Server",

      port:
        PORT,

      elevenlabs:
        ELEVENLABS_API_KEY
          ? "Configured"
          : "NOT CONFIGURED",

      ffmpeg:
        resolvedFfmpegPath &&
        fs.existsSync(
          resolvedFfmpegPath
        )
          ? "Configured"
          : "NOT CONFIGURED",

      ffprobe:
        resolvedFfprobePath &&
        fs.existsSync(
          resolvedFfprobePath
        )
          ? "Configured"
          : "NOT CONFIGURED",

      directories: {
        images:
          IMAGES_DIR,

        audio:
          AUDIO_DIR,

        videos:
          VIDEOS_DIR,

        temp:
          TEMP_DIR,
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

      route:
        `${req.method} ${req.originalUrl}`,
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
      "Server error:",
      error
    );

    if (
      res.headersSent
    ) {
      return next(error);
    }

    res.status(500).json({
      success: false,

      error:
        error.message ||
        "Internal server error.",
    });
  }
);

/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
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
      `Server: http://localhost:${PORT}`
    );

    console.log(
      `Images: http://localhost:${PORT}/uploads/images`
    );

    console.log(
      `Audio: http://localhost:${PORT}/uploads/audio`
    );

    console.log(
      `Videos: http://localhost:${PORT}/uploads/videos`
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
      resolvedFfmpegPath &&
        fs.existsSync(
          resolvedFfmpegPath
        )
        ? "Configured ✓"
        : "NOT CONFIGURED ✗"
    );

    console.log(
      "FFprobe:",
      resolvedFfprobePath &&
        fs.existsSync(
          resolvedFfprobePath
        )
        ? "Configured ✓"
        : "NOT CONFIGURED ✗"
    );

    console.log(
      "========================================"
    );
    console.log("");
  }
);