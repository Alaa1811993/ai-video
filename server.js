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
    `http://localhost:${PORT}`;

const ELEVENLABS_API_KEY =
    process.env.ELEVENLABS_API_KEY;

const ELEVENLABS_VOICE_ID =
    process.env.ELEVENLABS_VOICE_ID;

const ELEVENLABS_MODEL =
    process.env.ELEVENLABS_MODEL ||
    "eleven_multilingual_v2";

ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

const ROOT_DIR = __dirname;

const UPLOADS_DIR = path.join(ROOT_DIR, "uploads");
const IMAGES_DIR = path.join(UPLOADS_DIR, "images");
const AUDIO_DIR = path.join(UPLOADS_DIR, "audio");
const VIDEOS_DIR = path.join(UPLOADS_DIR, "videos");
const TEMP_DIR = path.join(UPLOADS_DIR, "temp");

[
    UPLOADS_DIR,
    IMAGES_DIR,
    AUDIO_DIR,
    VIDEOS_DIR,
    TEMP_DIR
].forEach((dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

app.use(
    cors({
        origin: [
            "https://ai-video-studio-542c9.web.app",
            "https://ai-video-studio-542c9.firebaseapp.com",
            "http://localhost:5173",
            "http://localhost:5174"
        ],
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
        credentials: false
    })
);

app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true, limit: "100mb" }));

app.use(
    "/uploads",
    express.static(UPLOADS_DIR, {
        maxAge: "1h"
    })
);

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, TEMP_DIR);
    },

    filename: function (req, file, cb) {
        const ext =
            path.extname(file.originalname || "") ||
            ".png";

        cb(
            null,
            `${uuidv4()}${ext}`
        );
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: 100 * 1024 * 1024
    }
});

/* =========================================================
   HELPERS
========================================================= */

function absoluteUrl(file) {
    return `${SERVER_URL}/uploads/${file}`;
}

function safeUnlink(file) {
    try {
        if (file && fs.existsSync(file)) {
            fs.unlinkSync(file);
        }
    } catch (error) {
        console.log(
            "Could not delete file:",
            file,
            error.message
        );
    }
}

function getExtensionFromUrl(url) {
    try {
        const clean = url.split("?")[0];
        const ext = path.extname(clean);

        if (ext && ext.length <= 10) {
            return ext;
        }
    } catch (error) {}

    return ".png";
}

function downloadFile(url, outputPath) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith("https")
            ? https
            : http;

        const request = protocol.get(
            url,
            (response) => {
                if (
                    response.statusCode >= 300 &&
                    response.statusCode < 400 &&
                    response.headers.location
                ) {
                    response.resume();

                    downloadFile(
                        response.headers.location,
                        outputPath
                    )
                        .then(resolve)
                        .catch(reject);

                    return;
                }

                if (response.statusCode !== 200) {
                    response.resume();

                    reject(
                        new Error(
                            `Download failed: HTTP ${response.statusCode}`
                        )
                    );

                    return;
                }

                const file = fs.createWriteStream(
                    outputPath
                );

                response.pipe(file);

                file.on("finish", () => {
                    file.close(() => resolve(outputPath));
                });

                file.on("error", (error) => {
                    safeUnlink(outputPath);
                    reject(error);
                });
            }
        );

        request.on("error", reject);

        request.setTimeout(
            120000,
            () => {
                request.destroy(
                    new Error("Download timeout")
                );
            }
        );
    });
}

function getMediaDuration(file) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(
            file,
            (error, metadata) => {
                if (error) {
                    reject(error);
                    return;
                }

                const duration =
                    metadata?.format?.duration;

                if (!duration) {
                    reject(
                        new Error(
                            "Could not determine media duration"
                        )
                    );

                    return;
                }

                resolve(Number(duration));
            }
        );
    });
}

function normalizeDuration(value) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return 5;
    }

    return Math.max(
        1,
        Math.min(60, number)
    );
}

/* =========================================================
   BASIC ROUTES
========================================================= */

app.get("/", (req, res) => {
    res.json({
        success: true,
        service: "AI Video Server",
        version: "character-animation-1.0",
        status: "running"
    });
});

app.get("/api/test", (req, res) => {
    res.json({
        success: true,
        message: "AI Video API is working",
        server: SERVER_URL
    });
});

/* =========================================================
   IMAGE GENERATION
========================================================= */

app.post(
    "/api/generate-image",
    async (req, res) => {
        try {
            const {
                prompt
            } = req.body;

            if (!prompt) {
                return res.status(400).json({
                    success: false,
                    error: "Prompt is required"
                });
            }

            const encodedPrompt =
                encodeURIComponent(prompt);

            const imageUrl =
                `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1280&height=720&model=flux&nologo=true`;

            const filename =
                `image_${uuidv4()}.png`;

            const outputPath =
                path.join(
                    IMAGES_DIR,
                    filename
                );

            console.log(
                "Generating image..."
            );

            await downloadFile(
                imageUrl,
                outputPath
            );

            console.log(
                "Image generated:",
                filename
            );

            res.json({
                success: true,
                imageUrl: absoluteUrl(
                    `images/${filename}`
                )
            });
        } catch (error) {
            console.error(
                "Image generation error:",
                error
            );

            res.status(500).json({
                success: false,
                error:
                    error.message ||
                    "Image generation failed"
            });
        }
    }
);

/* =========================================================
   ELEVENLABS VOICE
========================================================= */

app.post(
    "/api/generate-voice",
    async (req, res) => {
        try {
            const {
                text,
                voiceId,
                modelId
            } = req.body;

            if (!text) {
                return res.status(400).json({
                    success: false,
                    error: "Text is required"
                });
            }

            if (!ELEVENLABS_API_KEY) {
                return res.status(500).json({
                    success: false,
                    error:
                        "ELEVENLABS_API_KEY is not configured"
                });
            }

            const selectedVoice =
                voiceId ||
                ELEVENLABS_VOICE_ID;

            if (!selectedVoice) {
                return res.status(500).json({
                    success: false,
                    error:
                        "ElevenLabs voice ID is not configured"
                });
            }

            const selectedModel =
                modelId ||
                ELEVENLABS_MODEL;

            console.log(
                "Generating ElevenLabs voice..."
            );

            const response =
                await fetch(
                    `https://api.elevenlabs.io/v1/text-to-speech/${selectedVoice}`,
                    {
                        method: "POST",

                        headers: {
                            "xi-api-key":
                                ELEVENLABS_API_KEY,

                            "Content-Type":
                                "application/json",

                            Accept:
                                "audio/mpeg"
                        },

                        body: JSON.stringify({
                            text,

                            model_id:
                                selectedModel,

                            voice_settings: {
                                stability: 0.5,
                                similarity_boost: 0.75
                            }
                        })
                    }
                );

            if (!response.ok) {
                const errorText =
                    await response.text();

                throw new Error(
                    `ElevenLabs HTTP ${response.status}: ${errorText}`
                );
            }

            const buffer =
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
                buffer
            );

            console.log(
                "Voice generated:",
                filename
            );

            res.json({
                success: true,

                audioUrl:
                    absoluteUrl(
                        `audio/${filename}`
                    )
            });
        } catch (error) {
            console.error(
                "Voice generation error:",
                error
            );

            res.status(500).json({
                success: false,
                error:
                    error.message ||
                    "Voice generation failed"
            });
        }
    }
);

/* =========================================================
   NORMAL CINEMATIC SCENE VIDEO
========================================================= */

async function renderSceneVideo({
    imagePath,
    audioPath,
    outputPath,
    duration,
    animationIndex = 0
}) {
    return new Promise(
        (resolve, reject) => {
            const width = 1280;
            const height = 720;

            const fps = 24;

            const zoomAnimations = [
                `zoompan=z='min(zoom+0.0008,1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.round(
                    duration * fps
                )}:s=${width}x${height}:fps=${fps}`,

                `zoompan=z='if(lte(zoom,1.001),1.15,max(zoom-0.0008,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.round(
                    duration * fps
                )}:s=${width}x${height}:fps=${fps}`,

                `zoompan=z='1.08':x='min(iw-iw/zoom,(iw-iw/zoom)*(on/${Math.max(
                    1,
                    duration * fps
                )}))':y='ih/2-(ih/zoom/2)':d=${Math.round(
                    duration * fps
                )}:s=${width}x${height}:fps=${fps}`,

                `zoompan=z='1.08':x='max(0,(iw-iw/zoom)*(1-on/${Math.max(
                    1,
                    duration * fps
                )}))':y='ih/2-(ih/zoom/2)':d=${Math.round(
                    duration * fps
                )}:s=${width}x${height}:fps=${fps}`,

                `zoompan=z='1.06':x='iw/2-(iw/zoom/2)':y='min(ih-ih/zoom,(ih-ih/zoom)*(on/${Math.max(
                    1,
                    duration * fps
                )}))':d=${Math.round(
                    duration * fps
                )}:s=${width}x${height}:fps=${fps}`,

                `zoompan=z='1.06':x='iw/2-(iw/zoom/2)':y='max(0,(ih-ih/zoom)*(1-on/${Math.max(
                    1,
                    duration * fps
                )}))':d=${Math.round(
                    duration * fps
                )}:s=${width}x${height}:fps=${fps}`
            ];

            const selected =
                zoomAnimations[
                    animationIndex %
                    zoomAnimations.length
                ];

            ffmpeg()
                .input(imagePath)
                .inputOptions([
                    "-loop 1"
                ])

                .input(audioPath)

                .complexFilter([
                    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},${selected},eq=saturation=1.05:contrast=1.02,format=yuv420p[v]`
                ])

                .outputOptions([
                    "-map [v]",
                    "-map 1:a:0",
                    "-c:v libx264",
                    "-preset ultrafast",
                    "-crf 27",
                    "-r 24",
                    "-c:a aac",
                    "-b:a 128k",
                    "-ar 44100",
                    "-ac 2",
                    "-shortest",
                    "-movflags +faststart",
                    "-threads 1"
                ])

                .on("start", (command) => {
                    console.log(
                        "Scene FFmpeg:",
                        command
                    );
                })

                .on("progress", (progress) => {
                    if (progress.timemark) {
                        console.log(
                            "Scene progress:",
                            progress.timemark
                        );
                    }
                })

                .on("error", (error) => {
                    console.error(
                        "Scene FFmpeg error:",
                        error
                    );

                    reject(error);
                })

                .on("end", () => {
                    console.log(
                        "Scene completed:",
                        outputPath
                    );

                    resolve(
                        outputPath
                    );
                })

                .save(outputPath);
        }
    );
}

/* =========================================================
   NORMAL SCENE VIDEO API
========================================================= */

app.post(
    "/api/generate-scene-video",
    async (req, res) => {
        try {
            const {
                imageUrl,
                audioUrl,
                duration,
                animationIndex
            } = req.body;

            if (
                !imageUrl ||
                !audioUrl
            ) {
                return res.status(400).json({
                    success: false,
                    error:
                        "imageUrl and audioUrl are required"
                });
            }

            const id = uuidv4();

            const imagePath =
                path.join(
                    TEMP_DIR,
                    `${id}_image${getExtensionFromUrl(
                        imageUrl
                    )}`
                );

            const audioPath =
                path.join(
                    TEMP_DIR,
                    `${id}_audio${getExtensionFromUrl(
                        audioUrl
                    )}`
                );

            const outputFilename =
                `scene_${id}.mp4`;

            const outputPath =
                path.join(
                    VIDEOS_DIR,
                    outputFilename
                );

            await downloadFile(
                imageUrl,
                imagePath
            );

            await downloadFile(
                audioUrl,
                audioPath
            );

            const actualDuration =
                normalizeDuration(
                    duration ||
                        (await getMediaDuration(
                            audioPath
                        ))
                );

            await renderSceneVideo({
                imagePath,
                audioPath,
                outputPath,
                duration:
                    actualDuration,

                animationIndex:
                    Number(
                        animationIndex || 0
                    )
            });

            safeUnlink(imagePath);
            safeUnlink(audioPath);

            res.json({
                success: true,

                videoUrl:
                    absoluteUrl(
                        `videos/${outputFilename}`
                    )
            });
        } catch (error) {
            console.error(
                "Scene video error:",
                error
            );

            res.status(500).json({
                success: false,
                error:
                    error.message ||
                    "Scene video generation failed"
            });
        }
    }
);

/* =========================================================
   REAL CHARACTER ANIMATION
========================================================= */

/*
    IMPORTANT:

    Every character layer should be a transparent PNG
    with the same 1280x720 canvas.

    Example:

    background.png
    body.png
    head.png
    leftArm.png
    rightArm.png
    leftLeg.png
    rightLeg.png

    The transparent pixels remain transparent.

    The filter moves each layer independently.
*/

function buildCharacterFilter(
    animation,
    duration
) {
    const fps = 24;

    const frames =
        Math.max(
            24,
            Math.round(
                duration * fps
            )
        );

    const mode =
        String(animation || "idle")
            .toLowerCase();

    let bodyX = "0";
    let bodyY = "0";

    let headX = "0";
    let headY = "0";

    let leftArmX = "0";
    let leftArmY = "0";

    let rightArmX = "0";
    let rightArmY = "0";

    let leftLegX = "0";
    let leftLegY = "0";

    let rightLegX = "0";
    let rightLegY = "0";

    /*
        All formulas use frame number `n`.

        Because the images are full 1280x720 transparent
        canvases, translation keeps each body part aligned.
    */

    if (
        mode === "breathing" ||
        mode === "idle"
    ) {
        bodyY =
            `2*sin(2*PI*n/${fps * 2})`;

        headY =
            `-2*sin(2*PI*n/${fps * 2})`;

        leftArmY =
            `1*sin(2*PI*n/${fps * 2})`;

        rightArmY =
            `1*sin(2*PI*n/${fps * 2})`;
    }

    if (mode === "walking") {
        bodyY =
            `3*sin(2*PI*n/${fps})`;

        headY =
            `-2*sin(2*PI*n/${fps})`;

        leftArmX =
            `7*sin(2*PI*n/${fps})`;

        rightArmX =
            `-7*sin(2*PI*n/${fps})`;

        leftArmY =
            `2*cos(2*PI*n/${fps})`;

        rightArmY =
            `-2*cos(2*PI*n/${fps})`;

        leftLegX =
            `8*sin(2*PI*n/${fps})`;

        rightLegX =
            `-8*sin(2*PI*n/${fps})`;

        leftLegY =
            `2*cos(2*PI*n/${fps})`;

        rightLegY =
            `-2*cos(2*PI*n/${fps})`;
    }

    if (mode === "attacking") {
        bodyX =
            `18*sin(2*PI*n/${fps * 1.2})`;

        bodyY =
            `-5*abs(sin(2*PI*n/${fps * 1.2}))`;

        headX =
            `12*sin(2*PI*n/${fps * 1.2})`;

        headY =
            `-8*abs(sin(2*PI*n/${fps * 1.2}))`;

        leftArmX =
            `-35*abs(sin(2*PI*n/${fps * 1.2}))`;

        rightArmX =
            `55*abs(sin(2*PI*n/${fps * 1.2}))`;

        leftArmY =
            `-15*abs(sin(2*PI*n/${fps * 1.2}))`;

        rightArmY =
            `-20*abs(sin(2*PI*n/${fps * 1.2}))`;

        leftLegX =
            `-10*sin(2*PI*n/${fps * 1.2})`;

        rightLegX =
            `10*sin(2*PI*n/${fps * 1.2})`;
    }

    if (mode === "jumping") {
        const jump =
            `-45*abs(sin(PI*n/${Math.max(
                1,
                frames
            )}))`;

        bodyY = jump;

        headY =
            `${jump}`;

        leftArmY =
            `${jump}-12*abs(sin(2*PI*n/${fps}))`;

        rightArmY =
            `${jump}-12*abs(sin(2*PI*n/${fps}))`;

        leftLegY =
            `${jump}+10*abs(sin(2*PI*n/${fps}))`;

        rightLegY =
            `${jump}+10*abs(sin(2*PI*n/${fps}))`;
    }

    if (mode === "talking") {
        bodyY =
            `2*sin(2*PI*n/${fps * 1.5})`;

        headY =
            `-2*sin(2*PI*n/${fps * 1.5})`;

        leftArmX =
            `4*sin(2*PI*n/${fps * 2})`;

        rightArmX =
            `-4*sin(2*PI*n/${fps * 2})`;
    }

    return {
        bodyX,
        bodyY,
        headX,
        headY,
        leftArmX,
        leftArmY,
        rightArmX,
        rightArmY,
        leftLegX,
        leftLegY,
        rightLegX,
        rightLegY
    };
}

async function renderCharacterVideo({
    backgroundPath,
    bodyPath,
    headPath,
    leftArmPath,
    rightArmPath,
    leftLegPath,
    rightLegPath,
    audioPath,
    outputPath,
    duration,
    animation
}) {
    return new Promise(
        (resolve, reject) => {
            const width = 1280;
            const height = 720;

            const motion =
                buildCharacterFilter(
                    animation,
                    duration
                );

            const command =
                ffmpeg();

            /*
                Inputs:

                0 = background
                1 = body
                2 = head
                3 = left arm
                4 = right arm
                5 = left leg
                6 = right leg
                7 = audio
            */

            [
                backgroundPath,
                bodyPath,
                headPath,
                leftArmPath,
                rightArmPath,
                leftLegPath,
                rightLegPath
            ].forEach((file) => {
                command
                    .input(file)
                    .inputOptions([
                        "-loop 1",
                        `-t ${duration}`
                    ]);
            });

            command.input(audioPath);

            const filters = [
                `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black[bg]`,

                `[1:v]format=rgba[body]`,
                `[2:v]format=rgba[head]`,
                `[3:v]format=rgba[leftarm]`,
                `[4:v]format=rgba[rightarm]`,
                `[5:v]format=rgba[leftleg]`,
                `[6:v]format=rgba[rightleg]`,

                `[bg][leftleg]overlay=x='${motion.leftLegX}':y='${motion.leftLegY}':eval=frame[layer1]`,

                `[layer1][rightleg]overlay=x='${motion.rightLegX}':y='${motion.rightLegY}':eval=frame[layer2]`,

                `[layer2][body]overlay=x='${motion.bodyX}':y='${motion.bodyY}':eval=frame[layer3]`,

                `[layer3][leftarm]overlay=x='${motion.leftArmX}':y='${motion.leftArmY}':eval=frame[layer4]`,

                `[layer4][rightarm]overlay=x='${motion.rightArmX}':y='${motion.rightArmY}':eval=frame[layer5]`,

                `[layer5][head]overlay=x='${motion.headX}':y='${motion.headY}':eval=frame[layer6]`,

                `[layer6]fps=24,format=yuv420p[v]`
            ];

            command
                .complexFilter(filters)

                .outputOptions([
                    "-map [v]",
                    "-map 7:a:0",
                    "-c:v libx264",
                    "-preset ultrafast",
                    "-crf 26",
                    "-pix_fmt yuv420p",
                    "-r 24",
                    "-c:a aac",
                    "-b:a 128k",
                    "-ar 44100",
                    "-ac 2",
                    "-shortest",
                    "-movflags +faststart",
                    "-threads 1"
                ])

                .on("start", (commandLine) => {
                    console.log(
                        "========================================"
                    );

                    console.log(
                        "CHARACTER ANIMATION STARTED"
                    );

                    console.log(
                        "Animation:",
                        animation
                    );

                    console.log(
                        "Command:",
                        commandLine
                    );

                    console.log(
                        "========================================"
                    );
                })

                .on("progress", (progress) => {
                    if (
                        progress.timemark
                    ) {
                        console.log(
                            "Character animation:",
                            progress.timemark
                        );
                    }
                })

                .on("error", (error) => {
                    console.error(
                        "Character FFmpeg error:",
                        error
                    );

                    reject(error);
                })

                .on("end", () => {
                    console.log(
                        "========================================"
                    );

                    console.log(
                        "CHARACTER ANIMATION COMPLETED"
                    );

                    console.log(
                        "========================================"
                    );

                    resolve(
                        outputPath
                    );
                })

                .save(outputPath);
        }
    );
}

/* =========================================================
   CHARACTER VIDEO API
========================================================= */

app.post(
    "/api/generate-character-video",
    async (req, res) => {
        const temporaryFiles = [];

        try {
            const {
                backgroundUrl,
                characterUrl,
                bodyUrl,
                headUrl,
                leftArmUrl,
                rightArmUrl,
                leftLegUrl,
                rightLegUrl,
                audioUrl,
                animation,
                duration
            } = req.body;

            if (!backgroundUrl) {
                return res.status(400).json({
                    success: false,
                    error:
                        "backgroundUrl is required"
                });
            }

            if (!audioUrl) {
                return res.status(400).json({
                    success: false,
                    error:
                        "audioUrl is required"
                });
            }

            /*
                For convenience, characterUrl can be used
                as the body layer.
            */

            const finalBodyUrl =
                bodyUrl ||
                characterUrl;

            if (!finalBodyUrl) {
                return res.status(400).json({
                    success: false,
                    error:
                        "bodyUrl or characterUrl is required"
                });
            }

            if (
                !headUrl ||
                !leftArmUrl ||
                !rightArmUrl ||
                !leftLegUrl ||
                !rightLegUrl
            ) {
                return res.status(400).json({
                    success: false,

                    error:
                        "headUrl, leftArmUrl, rightArmUrl, leftLegUrl and rightLegUrl are required"
                });
            }

            const id = uuidv4();

            const files = {
                background:
                    path.join(
                        TEMP_DIR,
                        `${id}_background.png`
                    ),

                body:
                    path.join(
                        TEMP_DIR,
                        `${id}_body.png`
                    ),

                head:
                    path.join(
                        TEMP_DIR,
                        `${id}_head.png`
                    ),

                leftArm:
                    path.join(
                        TEMP_DIR,
                        `${id}_left_arm.png`
                    ),

                rightArm:
                    path.join(
                        TEMP_DIR,
                        `${id}_right_arm.png`
                    ),

                leftLeg:
                    path.join(
                        TEMP_DIR,
                        `${id}_left_leg.png`
                    ),

                rightLeg:
                    path.join(
                        TEMP_DIR,
                        `${id}_right_leg.png`
                    ),

                audio:
                    path.join(
                        TEMP_DIR,
                        `${id}_audio.mp3`
                    )
            };

            temporaryFiles.push(
                ...Object.values(files)
            );

            console.log(
                "Downloading character layers..."
            );

            await downloadFile(
                backgroundUrl,
                files.background
            );

            await downloadFile(
                finalBodyUrl,
                files.body
            );

            await downloadFile(
                headUrl,
                files.head
            );

            await downloadFile(
                leftArmUrl,
                files.leftArm
            );

            await downloadFile(
                rightArmUrl,
                files.rightArm
            );

            await downloadFile(
                leftLegUrl,
                files.leftLeg
            );

            await downloadFile(
                rightLegUrl,
                files.rightLeg
            );

            await downloadFile(
                audioUrl,
                files.audio
            );

            const audioDuration =
                await getMediaDuration(
                    files.audio
                );

            const finalDuration =
                normalizeDuration(
                    duration ||
                        audioDuration
                );

            const outputFilename =
                `character_${id}.mp4`;

            const outputPath =
                path.join(
                    VIDEOS_DIR,
                    outputFilename
                );

            await renderCharacterVideo({
                backgroundPath:
                    files.background,

                bodyPath:
                    files.body,

                headPath:
                    files.head,

                leftArmPath:
                    files.leftArm,

                rightArmPath:
                    files.rightArm,

                leftLegPath:
                    files.leftLeg,

                rightLegPath:
                    files.rightLeg,

                audioPath:
                    files.audio,

                outputPath,

                duration:
                    finalDuration,

                animation:
                    animation ||
                    "walking"
            });

            temporaryFiles.forEach(
                safeUnlink
            );

            console.log(
                "Character video ready:",
                outputFilename
            );

            res.json({
                success: true,

                animation:
                    animation ||
                    "walking",

                duration:
                    finalDuration,

                videoUrl:
                    absoluteUrl(
                        `videos/${outputFilename}`
                    )
            });
        } catch (error) {
            console.error(
                "Character video error:",
                error
            );

            temporaryFiles.forEach(
                safeUnlink
            );

            res.status(500).json({
                success: false,
                error:
                    error.message ||
                    "Character animation failed"
            });
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
    return new Promise(
        async (resolve, reject) => {
            try {
                if (
                    !sceneVideos ||
                    sceneVideos.length === 0
                ) {
                    reject(
                        new Error(
                            "No scene videos supplied"
                        )
                    );

                    return;
                }

                const concatFile =
                    path.join(
                        TEMP_DIR,
                        `concat_${uuidv4()}.txt`
                    );

                let totalDuration = 0;

                for (
                    const video of sceneVideos
                ) {
                    try {
                        totalDuration +=
                            await getMediaDuration(
                                video
                            );
                    } catch (error) {}
                }

                const content =
                    sceneVideos
                        .map(
                            (video) =>
                                `file '${video.replace(
                                    /'/g,
                                    "'\\''"
                                )}'`
                        )
                        .join("\n");

                fs.writeFileSync(
                    concatFile,
                    content
                );

                console.log(
                    "Concat total duration:",
                    totalDuration
                );

                ffmpeg()
                    .input(concatFile)
                    .inputOptions([
                        "-f concat",
                        "-safe 0"
                    ])

                    .outputOptions([
                        "-c:v copy",
                        "-c:a aac",
                        "-b:a 128k",
                        "-movflags +faststart"
                    ])

                    .on("start", (command) => {
                        console.log(
                            "Concat FFmpeg:",
                            command
                        );
                    })

                    .on("progress", (progress) => {
                        /*
                            DO NOT USE progress.percent.

                            FFmpeg/fluent-ffmpeg can return
                            invalid percentages during concat.

                            Calculate only from timemark.
                        */

                        if (
                            !progress.timemark ||
                            !totalDuration
                        ) {
                            return;
                        }

                        const parts =
                            progress.timemark.split(
                                ":"
                            );

                        if (
                            parts.length !== 3
                        ) {
                            return;
                        }

                        const hours =
                            Number(parts[0]) || 0;

                        const minutes =
                            Number(parts[1]) || 0;

                        const seconds =
                            Number(parts[2]) || 0;

                        const currentSeconds =
                            hours * 3600 +
                            minutes * 60 +
                            seconds;

                        const percent =
                            Math.min(
                                100,
                                Math.max(
                                    0,
                                    (
                                        currentSeconds /
                                        totalDuration
                                    ) * 100
                                )
                            );

                        console.log(
                            `Concat progress: ${percent.toFixed(
                                1
                            )}%`
                        );
                    })

                    .on("error", (error) => {
                        safeUnlink(
                            concatFile
                        );

                        reject(error);
                    })

                    .on("end", () => {
                        safeUnlink(
                            concatFile
                        );

                        console.log(
                            "Final concat completed."
                        );

                        resolve(
                            outputPath
                        );
                    })

                    .save(outputPath);
            } catch (error) {
                reject(error);
            }
        }
    );
}

/* =========================================================
   FINAL VIDEO
========================================================= */

app.post(
    "/api/generate-final-video",
    async (req, res) => {
        const temporaryFiles = [];

        try {
            const {
                scenes
            } = req.body;

            if (
                !Array.isArray(scenes) ||
                scenes.length === 0
            ) {
                return res.status(400).json({
                    success: false,
                    error:
                        "scenes array is required"
                });
            }

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

                if (
                    !scene.imageUrl ||
                    !scene.audioUrl
                ) {
                    throw new Error(
                        `Scene ${
                            i + 1
                        } is missing imageUrl or audioUrl`
                    );
                }

                const id =
                    uuidv4();

                const imagePath =
                    path.join(
                        TEMP_DIR,
                        `${id}_image.png`
                    );

                const audioPath =
                    path.join(
                        TEMP_DIR,
                        `${id}_audio.mp3`
                    );

                const sceneOutput =
                    path.join(
                        TEMP_DIR,
                        `${id}_scene.mp4`
                    );

                temporaryFiles.push(
                    imagePath,
                    audioPath,
                    sceneOutput
                );

                console.log(
                    `Preparing scene ${
                        i + 1
                    }...`
                );

                await downloadFile(
                    scene.imageUrl,
                    imagePath
                );

                await downloadFile(
                    scene.audioUrl,
                    audioPath
                );

                const duration =
                    normalizeDuration(
                        scene.duration ||
                            (await getMediaDuration(
                                audioPath
                            ))
                    );

                await renderSceneVideo({
                    imagePath,
                    audioPath,
                    outputPath:
                        sceneOutput,
                    duration,

                    animationIndex:
                        Number(
                            scene.animationIndex ??
                                i
                        )
                });

                sceneVideos.push(
                    sceneOutput
                );
            }

            const finalFilename =
                `video_${uuidv4()}.mp4`;

            const finalPath =
                path.join(
                    VIDEOS_DIR,
                    finalFilename
                );

            await concatSceneVideos(
                sceneVideos,
                finalPath
            );

            const stats =
                fs.statSync(
                    finalPath
                );

            let videoStreams = 0;
            let audioStreams = 0;

            try {
                const metadata =
                    await new Promise(
                        (resolve, reject) => {
                            ffmpeg.ffprobe(
                                finalPath,
                                (
                                    error,
                                    data
                                ) => {
                                    if (
                                        error
                                    ) {
                                        reject(
                                            error
                                        );
                                    } else {
                                        resolve(
                                            data
                                        );
                                    }
                                }
                            );
                        }
                    );

                const streams =
                    metadata.streams ||
                    [];

                videoStreams =
                    streams.filter(
                        (s) =>
                            s.codec_type ===
                            "video"
                    ).length;

                audioStreams =
                    streams.filter(
                        (s) =>
                            s.codec_type ===
                            "audio"
                    ).length;
            } catch (error) {
                console.log(
                    "Could not inspect final streams:",
                    error.message
                );
            }

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
                "Video URL:",
                absoluteUrl(
                    `videos/${finalFilename}`
                )
            );

            console.log(
                "File size:",
                stats.size
            );

            console.log(
                "Video streams:",
                videoStreams
            );

            console.log(
                "Audio streams:",
                audioStreams
            );

            console.log(
                "========================================"
            );

            temporaryFiles.forEach(
                safeUnlink
            );

            res.json({
                success: true,

                videoUrl:
                    absoluteUrl(
                        `videos/${finalFilename}`
                    ),

                fileSize:
                    stats.size,

                videoStreams,

                audioStreams
            });
        } catch (error) {
            console.error(
                "Final video error:",
                error
            );

            temporaryFiles.forEach(
                safeUnlink
            );

            res.status(500).json({
                success: false,
                error:
                    error.message ||
                    "Final video generation failed"
            });
        }
    }
);

/* =========================================================
   OLD GENERATE VIDEO ROUTE
========================================================= */

app.post(
    "/api/generate-video",
    async (req, res) => {
        try {
            const {
                imageUrl,
                audioUrl,
                duration
            } = req.body;

            if (
                !imageUrl ||
                !audioUrl
            ) {
                return res.status(400).json({
                    success: false,
                    error:
                        "imageUrl and audioUrl are required"
                });
            }

            const id =
                uuidv4();

            const imagePath =
                path.join(
                    TEMP_DIR,
                    `${id}_image.png`
                );

            const audioPath =
                path.join(
                    TEMP_DIR,
                    `${id}_audio.mp3`
                );

            const outputFilename =
                `video_${id}.mp4`;

            const outputPath =
                path.join(
                    VIDEOS_DIR,
                    outputFilename
                );

            await downloadFile(
                imageUrl,
                imagePath
            );

            await downloadFile(
                audioUrl,
                audioPath
            );

            const finalDuration =
                normalizeDuration(
                    duration ||
                        (await getMediaDuration(
                            audioPath
                        ))
                );

            await renderSceneVideo({
                imagePath,
                audioPath,
                outputPath,
                duration:
                    finalDuration
            });

            safeUnlink(
                imagePath
            );

            safeUnlink(
                audioPath
            );

            res.json({
                success: true,

                videoUrl:
                    absoluteUrl(
                        `videos/${outputFilename}`
                    )
            });
        } catch (error) {
            console.error(
                "Generate video error:",
                error
            );

            res.status(500).json({
                success: false,
                error:
                    error.message ||
                    "Video generation failed"
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
                    error:
                        "No file uploaded"
                });
            }

            const originalExt =
                path.extname(
                    req.file.originalname
                ) ||
                path.extname(
                    req.file.filename
                ) ||
                ".png";

            const filename =
                `${uuidv4()}${originalExt}`;

            const targetPath =
                path.join(
                    IMAGES_DIR,
                    filename
                );

            fs.renameSync(
                req.file.path,
                targetPath
            );

            res.json({
                success: true,

                url:
                    absoluteUrl(
                        `images/${filename}`
                    ),

                imageUrl:
                    absoluteUrl(
                        `images/${filename}`
                    )
            });
        } catch (error) {
            console.error(
                "Upload error:",
                error
            );

            if (
                req.file?.path
            ) {
                safeUnlink(
                    req.file.path
                );
            }

            res.status(500).json({
                success: false,
                error:
                    error.message ||
                    "Upload failed"
            });
        }
    }
);

/* =========================================================
   DOWNLOAD VIDEO
========================================================= */

app.get(
    "/api/download-video/:filename",
    (req, res) => {
        const filename =
            path.basename(
                req.params.filename
            );

        const filePath =
            path.join(
                VIDEOS_DIR,
                filename
            );

        if (
            !fs.existsSync(
                filePath
            )
        ) {
            return res.status(404).json({
                success: false,
                error:
                    "Video not found"
            });
        }

        res.download(
            filePath,
            filename
        );
    }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
    (error, req, res, next) => {
        console.error(
            "Unhandled error:",
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
                "Internal server error"
        });
    }
);

/* =========================================================
   START SERVER
========================================================= */

const server =
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
                "========================================"
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
                ffprobeStatic.path
            );

            console.log(
                "Character animation:",
                "ENABLED"
            );

            console.log(
                "========================================"
            );
        }
    );

process.on(
    "SIGTERM",
    () => {
        console.log(
            "SIGTERM received. Closing server..."
        );

        server.close(() => {
            process.exit(0);
        });
    }
);

process.on(
    "SIGINT",
    () => {
        console.log(
            "SIGINT received. Closing server..."
        );

        server.close(() => {
            process.exit(0);
        });
    }
);