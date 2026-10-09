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
const BASE_DIR = __dirname;
const UPLOAD_DIR = path.join(BASE_DIR, "uploads");
const IMAGE_DIR = path.join(UPLOAD_DIR, "images");
const AUDIO_DIR = path.join(UPLOAD_DIR, "audio");
const VIDEO_DIR = path.join(UPLOAD_DIR, "videos");
const TEMP_DIR = path.join(UPLOAD_DIR, "temp");

for (const dir of [UPLOAD_DIR, IMAGE_DIR, AUDIO_DIR, VIDEO_DIR, TEMP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

app.use(cors({ origin: true }));
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true, limit: "100mb" }));
app.use("/uploads", express.static(UPLOAD_DIR));

if (ffmpegStatic) ffmpeg.setFfmpegPath(ffmpegStatic);
if (ffprobeStatic?.path) ffmpeg.setFfprobePath(ffprobeStatic.path);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const audio = file.mimetype.startsWith("audio/") ||
      req.body?.type === "audio" ||
      req.body?.type === "sound";

    cb(null, audio ? AUDIO_DIR : IMAGE_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${uuidv4()}${path.extname(file.originalname) || ".bin"}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 },
});

function publicUrl(req, file) {
  const protocol = req.headers["x-forwarded-proto"] || req.protocol || "https";
  return `${protocol}://${req.get("host")}/uploads/${file}`;
}

function normalizeUrl(req, value) {
  if (!value) return "";
  if (/^https?:\/\//i.test(value) || value.startsWith("data:")) return value;
  if (value.startsWith("/uploads/")) {
    return `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}${value}`;
  }
  return value;
}

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    if (!url) return reject(new Error("Missing file URL."));

    if (url.startsWith("data:")) {
      try {
        const comma = url.indexOf(",");
        const data = url.slice(comma + 1);
        const buffer = url.includes(";base64,")
          ? Buffer.from(data, "base64")
          : Buffer.from(decodeURIComponent(data));

        fs.writeFileSync(destination, buffer);
        return resolve(destination);
      } catch (error) {
        return reject(error);
      }
    }

    const client = url.startsWith("https://") ? https : http;

    const request = client.get(url, { timeout: 120000 }, (response) => {
      if (
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.resume();
        return downloadFile(response.headers.location, destination)
          .then(resolve)
          .catch(reject);
      }

      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`Download failed: HTTP ${response.statusCode}`));
      }

      const output = fs.createWriteStream(destination);
      response.pipe(output);
      output.on("finish", () => output.close(() => resolve(destination)));
      output.on("error", reject);
    });

    request.on("error", reject);
    request.setTimeout(120000, () => {
      request.destroy(new Error("Download timeout."));
    });
  });
}

function imageUrl(prompt, width = 1280, height = 720) {
  return (
    "https://image.pollinations.ai/prompt/" +
    encodeURIComponent(prompt) +
    `?width=${width}&height=${height}&nologo=true&model=flux`
  );
}

async function generateImage(prompt, destination, width, height) {
  await downloadFile(imageUrl(prompt, width, height), destination);
  return destination;
}

function runFfmpeg(command) {
  return new Promise((resolve, reject) => {
    command
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

function voiceId(voice) {
  const ids = {
    Female: process.env.ELEVENLABS_FEMALE_VOICE_ID,
    Male: process.env.ELEVENLABS_MALE_VOICE_ID,
    "Deep Male": process.env.ELEVENLABS_DEEP_VOICE_ID,
    Storyteller: process.env.ELEVENLABS_STORYTELLER_VOICE_ID,
  };

  return ids[voice] || ids.Female;
}

function generateVoice(text, voice) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const id = voiceId(voice);

    if (!apiKey) return reject(new Error("ELEVENLABS_API_KEY is missing on Bonto."));
    if (!id) return reject(new Error("Configure the selected ElevenLabs voice ID on Bonto."));

    const body = JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.8,
        style: 0.25,
        use_speaker_boost: true,
      },
    });

    const request = https.request({
      hostname: "api.elevenlabs.io",
      path: `/v1/text-to-speech/${id}`,
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks = [];

      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return reject(
            new Error(Buffer.concat(chunks).toString() || `Voice API error ${response.statusCode}`)
          );
        }

        const filename = `voice-${uuidv4()}.mp3`;
        const destination = path.join(AUDIO_DIR, filename);
        fs.writeFileSync(destination, Buffer.concat(chunks));
        resolve(filename);
      });
    });

    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function fallbackScenes(idea, language) {
  const arabic = language === "Arabic";

  return [
    {
      description: arabic ? "المشهد الأول: البداية" : "Scene 1: Opening",
      narration: idea,
      imagePrompt: `Cinematic realistic opening scene illustrating: ${idea}. Wide 16:9 composition, detailed lighting, no text.`,
      characterPrompt: `Full body main character for this story: ${idea}`,
      animation: "talk",
      duration: 5,
      voice: "Female",
    },
    {
      description: arabic ? "المشهد الثاني: الحركة" : "Scene 2: Action",
      narration: arabic ? "تبدأ الأحداث وتتحرك الشخصية الرئيسية." : "The action begins and the main character moves.",
      imagePrompt: `Cinematic environment for the next scene of: ${idea}. Wide 16:9, realistic details, no text.`,
      characterPrompt: `Full body main character in an action pose for: ${idea}`,
      animation: "jump",
      duration: 5,
      voice: "Female",
    },
    {
      description: arabic ? "المشهد الثالث: النهاية" : "Scene 3: Ending",
      narration: arabic ? "تنتهي القصة بلقطة سينمائية قوية." : "The story ends with a strong cinematic shot.",
      imagePrompt: `Cinematic final scene for: ${idea}. Realistic lighting, wide 16:9 composition, no text.`,
      characterPrompt: `Full body main character for the final scene of: ${idea}`,
      animation: "talk",
      duration: 5,
      voice: "Female",
    },
  ];
}

/* IMAGE GENERATION */

app.post("/api/generate-image", async (req, res) => {
  try {
    const { prompt, width = 1280, height = 720 } = req.body;
    if (!prompt) return res.status(400).json({ error: "Image prompt is required." });

    const filename = `image-${uuidv4()}.jpg`;
    await generateImage(prompt, path.join(IMAGE_DIR, filename), Number(width), Number(height));

    const url = publicUrl(req, `images/${filename}`);
    res.json({ success: true, imageUrl: url, backgroundUrl: url, url });
  } catch (error) {
    console.error("Image generation:", error);
    res.status(500).json({ error: error.message });
  }
});

/* CHARACTER GENERATION
   This generates a separate character image on a green background.
   FFmpeg can move this layer independently over the scene background.
*/

app.post("/api/generate-character", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Character prompt is required." });

    const filename = `character-${uuidv4()}.jpg`;
    const description =
      `${prompt}. Full body, entire character visible, centered, isolated, ` +
      "solid bright green background, #00ff00, no shadows on background, no text.";

    await generateImage(description, path.join(IMAGE_DIR, filename), 1024, 1024);

    const url = publicUrl(req, `images/${filename}`);
    res.json({ success: true, characterUrl: url, imageUrl: url, url });
  } catch (error) {
    console.error("Character generation:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/generate-background", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Background prompt is required." });

    const filename = `background-${uuidv4()}.jpg`;
    await generateImage(
      `${prompt}. Empty cinematic environment, no people, no characters, no text, wide 16:9.`,
      path.join(IMAGE_DIR, filename),
      1280,
      720
    );

    const url = publicUrl(req, `images/${filename}`);
    res.json({ success: true, backgroundUrl: url, imageUrl: url, url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* SCRIPT GENERATION */

app.post("/api/generate-script", (req, res) => {
  try {
    const { idea, language = "Arabic" } = req.body;
    if (!idea) return res.status(400).json({ error: "Idea is required." });

    res.json({ success: true, scenes: fallbackScenes(idea, language) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* UPLOAD IMAGE, CHARACTER, AUDIO OR SOUND EFFECT */

app.post(
  "/api/upload",
  upload.fields([
    { name: "file", maxCount: 1 },
    { name: "image", maxCount: 1 },
  ]),
  (req, res) => {
    try {
      const file = req.files?.file?.[0] || req.files?.image?.[0];
      if (!file) return res.status(400).json({ error: "No file uploaded." });

      const isAudio = file.mimetype.startsWith("audio/");
      const url = publicUrl(req, `${isAudio ? "audio" : "images"}/${file.filename}`);

      res.json({
        success: true,
        url,
        fileUrl: url,
        imageUrl: isAudio ? "" : url,
        characterUrl: isAudio ? "" : url,
        audioUrl: isAudio ? url : "",
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

/* VOICE GENERATION */

app.post("/api/generate-voice", async (req, res) => {
  try {
    const { text, narration, voice = "Female" } = req.body;
    const spokenText = text || narration;
    if (!spokenText) return res.status(400).json({ error: "Narration text is required." });

    const filename = await generateVoice(spokenText, voice);
    const url = publicUrl(req, `audio/${filename}`);

    res.json({ success: true, audioUrl: url, url });
  } catch (error) {
    console.error("Voice generation:", error);
    res.status(500).json({ error: error.message });
  }
});

/* SCENE VIDEO RENDERING */

async function renderScene(req, scene, index) {
  const duration = Math.max(1, Math.min(120, Number(scene.duration) || 5));
  const id = uuidv4();
  const bgPath = path.join(TEMP_DIR, `${id}-background.jpg`);
  const charPath = path.join(TEMP_DIR, `${id}-character.jpg`);
  const voicePath = path.join(TEMP_DIR, `${id}-voice.mp3`);
  const sfxPath = path.join(TEMP_DIR, `${id}-sfx.mp3`);
  const outputPath = path.join(VIDEO_DIR, `scene-${id}.mp4`);

  const backgroundUrl = normalizeUrl(req, scene.backgroundUrl || scene.imageUrl);
  const characterUrl = normalizeUrl(req, scene.characterUrl);
  const audioUrl = normalizeUrl(req, scene.audioUrl);
  const soundEffectUrl = normalizeUrl(req, scene.soundEffectUrl);

  if (!backgroundUrl) throw new Error(`Scene ${index + 1} needs a background image.`);

  await downloadFile(backgroundUrl, bgPath);

  const hasCharacter = Boolean(characterUrl);
  const hasVoice = Boolean(audioUrl);
  const hasSfx = Boolean(soundEffectUrl);

  if (hasCharacter) await downloadFile(characterUrl, charPath);
  if (hasVoice) await downloadFile(audioUrl, voicePath);
  if (hasSfx) await downloadFile(soundEffectUrl, sfxPath);

  const command = ffmpeg().input(bgPath).inputOptions(["-loop 1"]);

  let nextInput = 1;
  let characterInput = -1;
  let voiceInput = -1;
  let sfxInput = -1;

  if (hasCharacter) {
    characterInput = nextInput++;
    command.input(charPath).inputOptions(["-loop 1"]);
  }

  if (hasVoice) voiceInput = nextInput++, command.input(voicePath);
  if (hasSfx) sfxInput = nextInput++, command.input(sfxPath);

  const filters = [];

  const animation = String(scene.animation || "idle").toLowerCase();
  let x = "(W-w)/2";
  let y = "H-h-20";

  if (["walk", "walking", "talk_walk", "talking-walking", "run", "running"].includes(animation)) {
    x = `min(W-w-20,max(20,20+t*100))`;
    y = `H-h-20+abs(sin(t*7))*8`;
  } else if (["jump", "jumping"].includes(animation)) {
    x = "(W-w)/2+sin(t*3)*90";
    y = `H-h-20-abs(sin(t*3))*150`;
  } else if (["dance", "dancing"].includes(animation)) {
    x = "(W-w)/2+sin(t*5)*100";
    y = `H-h-20+sin(t*10)*25`;
  } else if (["attack", "attacking"].includes(animation)) {
    x = "(W-w)/2+sin(t*9)*120";
    y = `H-h-20-abs(sin(t*9))*20`;
  } else if (["talk", "talking", "breathing", "idle"].includes(animation)) {
    x = "(W-w)/2+sin(t*1.8)*8";
    y = `H-h-20+sin(t*3)*5`;
  }

  let lastVideo = "0:v";

  if (hasCharacter) {
    filters.push(
      `[${characterInput}:v]scale=420:-1,chromakey=0x00ff00:0.25:0.08,format=rgba[character]`
    );
    filters.push(
      `[0:v][character]overlay=x='${x}':y='${y}':shortest=1:eval=frame,` +
      `scale=1280:720,fps=30,format=yuv420p[vout]`
    );
    lastVideo = "vout";
  } else {
    filters.push(
      `[0:v]scale=1280:720,zoompan=z='min(zoom+0.0008,1.08)':d=${duration * 30}:s=1280x720:fps=30,format=yuv420p[vout]`
    );
    lastVideo = "vout";
  }

  let audioOutput = null;

  if (hasVoice && hasSfx) {
    filters.push(`[${voiceInput}:a]aresample=44100,volume=1.0[voice]`);
    filters.push(`[${sfxInput}:a]aresample=44100,volume=0.35[sfx]`);
    filters.push("[voice][sfx]amix=inputs=2:duration=longest:dropout_transition=2[aout]");
    audioOutput = "aout";
  } else if (hasVoice) {
    filters.push(`[${voiceInput}:a]aresample=44100,volume=1.0[aout]`);
    audioOutput = "aout";
  } else if (hasSfx) {
    filters.push(`[${sfxInput}:a]aresample=44100,volume=0.8[aout]`);
    audioOutput = "aout";
  }

  command.complexFilter(filters);

  command.outputOptions([
    "-map", `[${lastVideo}]`,
    ...(audioOutput ? ["-map", `[${audioOutput}]`] : ["-an"]),
    "-t", String(duration),
    "-r", "30",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    ...(audioOutput ? ["-c:a", "aac", "-b:a", "128k"] : []),
  ]);

  await runFfmpeg(command.output(outputPath));

  for (const file of [bgPath, charPath, voicePath, sfxPath]) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (_) {}
  }

  return outputPath;
}

app.post("/api/generate-scene-video", async (req, res) => {
  try {
    const scene = req.body.scene || req.body;
    const index = Number(req.body.index) || 0;
    const outputPath = await renderScene(req, scene, index);
    const url = publicUrl(req, `videos/${path.basename(outputPath)}`);

    res.json({ success: true, videoUrl: url, url });
  } catch (error) {
    console.error("Scene rendering:", error);
    res.status(500).json({ error: error.message });
  }
});

/* FINAL VIDEO: render every scene and concatenate them */

app.post("/api/generate-final-video", async (req, res) => {
  const renderedScenes = [];
  const listPath = path.join(TEMP_DIR, `concat-${uuidv4()}.txt`);
  const outputPath = path.join(VIDEO_DIR, `final-${uuidv4()}.mp4`);

  try {
    const scenes = req.body.scenes;
    if (!Array.isArray(scenes) || !scenes.length) {
      return res.status(400).json({ error: "At least one scene is required." });
    }

    for (let i = 0; i < scenes.length; i++) {
      const rendered = await renderScene(req, scenes[i], i);
      renderedScenes.push(rendered);
    }

    const list = renderedScenes
      .map((file) => `file '${file.replace(/'/g, "'\\''")}'`)
      .join("\n");

    fs.writeFileSync(listPath, list);

    await runFfmpeg(
      ffmpeg()
        .input(listPath)
        .inputOptions(["-f", "concat", "-safe", "0"])
        .outputOptions([
          "-c", "copy",
          "-movflags", "+faststart",
        ])
        .output(outputPath)
    );

    const url = publicUrl(req, `videos/${path.basename(outputPath)}`);
    res.json({ success: true, videoUrl: url, url });
  } catch (error) {
    console.error("Final video rendering:", error);
    res.status(500).json({ error: error.message });
  } finally {
    try {
      if (fs.existsSync(listPath)) fs.unlinkSync(listPath);
    } catch (_) {}
  }
});

app.post("/api/generate-video", (req, res, next) => {
  req.url = "/api/generate-final-video";
  next();
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "running",
    ffmpeg: Boolean(ffmpegStatic),
    voiceConfigured: Boolean(process.env.ELEVENLABS_API_KEY),
  });
});

app.get("/api/test", (req, res) => {
  res.json({ success: true, message: "AI Video Server is running." });
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: error.message || "Internal server error." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`AI Video Server running on port ${PORT}`);
});

