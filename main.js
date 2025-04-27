import { Boom } from "@hapi/boom";
import pkg from "baileys";
const {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    isJidBroadcast,
    jidNormalizedUser,
    isJidNewsletter,
    makeInMemoryStore,
    makeCacheableSignalKeyStore,
    proto
} = pkg;
import Pino from "pino";
import readline from "readline";
import axios from "axios";
import * as cheerio from "cheerio";
import { AnimeScraper } from "./AnimeScraper.js";
import NodeCache from "node-cache";
import chalk from "chalk";
import { useMySQLAuthState } from "mysql-baileys";
import { RedisStore } from "baileys-redis-store";
import redisPkg from "redis";
const { createClient, RedisClientType } = redisPkg;
import { Logger } from "./utils/logger.js";
import dotenv from "dotenv";
dotenv.config();

const AzusaLog = new Logger();

const msgRetryCounterCache = new NodeCache();
const groupCache = new NodeCache({ stdTTL: 5 * 60, useClones: false });
const userDevicesCache = new NodeCache();

const GROUP_JID = process.env.GROUP_JID;
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});
const question = text => new Promise(resolve => rl.question(text, resolve));
const logger = Pino({
    level: "silent"
});

const redisClient = createClient({
    url: process.env.REDIS_URL
});

let retryAttempts = 0;
let reconnectAttempts = 0;
const maxRetries = 5;
let store = null;

redisClient.on("error", err => {
    AzusaLog.handleError(err, "Redis Client Error");
    if (retryAttempts < maxRetries) {
        retryAttempts++;
        setTimeout(() => {
            redisClient.connect().catch(err => {
                AzusaLog.handleError(err, "Redis reconnection failed");
            });
        }, 5000);
    } else {
        AzusaLog.log({
            type: "danger",
            message: "Maximum Redis retry attempts reached. Exiting..."
        });
        process.exit(1);
    }
});

async function connectToRedis() {
    try {
        await redisClient.connect();
        AzusaLog.log({
            type: "success",
            message: "Connected to Redis successfully."
        });

        store = new RedisStore({
            redisConnection: redisClient,
            prefix: "store_",
            logger: logger,
            maxCacheSize: 5000
        });

        return true;
    } catch (error) {
        AzusaLog.handleError(error, "Error connecting to Redis");
        return false;
    }
}

async function getGenres(url) {
    try {
        const response = await axios.get(url);
        if (response.status !== 200) {
            throw new Error(
                `Request failed with status code ${response.status}`
            );
        }

        const $ = cheerio.load(response.data);
        const genres = [];

        $(".genxed a").each((i, el) => {
            const name = $(el).text().trim();
            const url = $(el).attr("href");
            genres.push({ name, url });
        });

        return genres;
    } catch (error) {
        AzusaLog.handleError(error, "Failed to fetch genres");
        return [];
    }
}

async function startBot() {
    // Ensure Redis is connected before starting the bot
    if (!store) {
        const connected = await connectToRedis();
        if (!connected) {
            AzusaLog.log({
                type: "danger",
                message: "Cannot start bot without Redis connection. Exiting..."
            });
            process.exit(1);
        }
    }

    try {
        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds, removeCreds } = await useMySQLAuthState({
            session: process.env.MYSQL_SESSION,
            host: process.env.MYSQL_HOST,
            port: Number(process.env.MYSQL_PORT),
            user: process.env.MYSQL_USER,
            password: process.env.MYSQL_PASSWORD,
            database: process.env.MYSQL_DATABASE,
            tableName: process.env.MYSQL_TABLE
        });

        const sock = makeWASocket({
            version: [2, 3000, 1015901307],
            logger,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            generateHighQualityLinkPreview: true,
            markOnlineOnConnect: true,
            msgRetryCounterCache,
            userDevicesCache,
            shouldIgnoreJid: jid => isJidBroadcast(jid) || isJidNewsletter(jid),
            defaultQueryTimeoutMs: undefined,
            retryRequestDelayMs: 10,
            connectTimeoutMs: 60_000,
            transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 10 },
            keepAliveIntervalMs: 10000,
            syncFullHistory: false,
            shouldSyncHistoryMessage: msg => {
                AzusaLog.log({
                    type: "info",
                    message: `Syncing chat history... [${msg.progress || 0}%]`
                });
                return !!msg.syncType;
            },
            cachedGroupMetadata: async jid => groupCache.get(jid),
            patchMessageBeforeSending: (message, jids) => {
                const requiresPatch = !!(
                    message.buttonsMessage ||
                    message.templateMessage ||
                    message.listMessage
                );
                if (requiresPatch) {
                    message = {
                        viewOnceMessage: {
                            message: {
                                messageContextInfo: {
                                    deviceListMetadataVersion: 2,
                                    deviceListMetadata: {}
                                },
                                ...message
                            }
                        }
                    };
                }

                return message;
            },
            getMessage: async key => {
                try {
                    AzusaLog.log({
                        type: "info",
                        message: "Getting Message for Retrying?..."
                    });
                    return await store.getMessage(key);
                } catch (err) {
                    AzusaLog.handleError(
                        err,
                        "Failed to get message from store"
                    );
                    return undefined;
                }
            }
        });

        if (!sock.authState.creds.registered) {
            const phone = await question("Enter your WhatsApp number: ");
            try {
                const code = await sock.requestPairingCode(phone.trim());
                AzusaLog.log({
                    type: "info",
                    message: `Pairing Code: ${code}`
                });
            } catch (err) {
                AzusaLog.handleError(err, "Failed to get pairing code");
                process.exit(1);
            }
        }

        try {
            await store.bind(sock.ev);
        } catch (err) {
            AzusaLog.handleError(err, "Failed to bind store to socket events");
        }

        sock.ev.on("connection.update", async update => {
            const { connection, lastDisconnect } = update;

            if (connection === "close") {
                const statusCode =
                    lastDisconnect?.error?.output?.statusCode || 500;
                const reason = lastDisconnect?.error?.message || "Unknown";

                AzusaLog.log({
                    type: "danger",
                    message: `Connection closed. Status: ${statusCode}. Reason: ${reason}`
                });

                if (
                    statusCode === DisconnectReason.loggedOut ||
                    statusCode === 401
                ) {
                    AzusaLog.log({
                        type: "error",
                        message:
                            "You've been logged out. Please delete session and re-authenticate."
                    });
                    try {
                        await removeCreds();
                        AzusaLog.log({
                            type: "info",
                            message: "Credentials removed successfully."
                        });
                    } catch (err) {
                        AzusaLog.handleError(
                            err,
                            "Failed to remove credentials"
                        );
                    }
                    process.exit(1);
                    return;
                }

                reconnectAttempts++;
                const delay = Math.min(1000 * 2 ** reconnectAttempts, 30000); // max 30 seconds

                AzusaLog.log({
                    type: "warning",
                    message: `Reconnecting in ${
                        delay / 1000
                    }s (attempt ${reconnectAttempts})...`
                });

                setTimeout(() => {
                    startBot().catch(err => {
                        AzusaLog.handleError(err, "Failed to restart bot");
                    });
                }, delay);
            } else if (connection === "connecting") {
                AzusaLog.log({
                    type: "info",
                    message: "Connecting to WhatsApp..."
                });
            } else if (connection === "open") {
                reconnectAttempts = 0;

                AzusaLog.log({
                    type: "success",
                    message: "Bot successfully connected to WhatsApp."
                });

                startAnimeWatcher(sock);
            }
        });

        sock.ev.on("creds.update", async creds => {
            try {
                await saveCreds();
            } catch (err) {
                AzusaLog.handleError(err, "Failed to save credentials");
            }
        });

        sock.ev.on("groups.update", async events => {
            try {
                for (const event of events) {
                    const metadata = await sock.groupMetadata(event.id);
                    groupCache.set(event.id, metadata);
                }
            } catch (err) {
                AzusaLog.handleError(err, "Failed to update group metadata");
            }
        });

        sock.ev.on("group-participants.update", async event => {
            try {
                const metadata = await sock.groupMetadata(event.id);
                groupCache.set(event.id, metadata);
            } catch (err) {
                AzusaLog.handleError(
                    err,
                    "Failed to update group participants"
                );
            }
        });

        sock.ev.on("error", err => {
            AzusaLog.handleError(err, "WhatsApp Error");
        });

        return sock;
    } catch (err) {
        AzusaLog.handleError(err, "Failed to start bot");
        if (reconnectAttempts < maxRetries) {
            reconnectAttempts++;
            const delay = Math.min(1000 * 2 ** reconnectAttempts, 30000);

            AzusaLog.log({
                type: "warning",
                message: `Retrying in ${delay / 1000}s...`
            });

            setTimeout(() => {
                startBot().catch(err => {
                    AzusaLog.handleError(
                        err,
                        "Failed to restart bot after error"
                    );
                });
            }, delay);
        } else {
            AzusaLog.log({
                type: "danger",
                message: "Maximum bot restart attempts reached. Exiting..."
            });
            process.exit(1);
        }
    }
}

function startAnimeWatcher(sock) {
    if (!sock) {
        AzusaLog.log({
            type: "error",
            message:
                "Cannot start anime watcher without valid socket connection"
        });
        return;
    }

    const scraper = new AnimeScraper({
        url: process.env.ANIME_URL || "https://animekompi.top/",
        dataFile: process.env.ANIME_DATA_FILE || "./lastAnimeData.json",
        interval: Number(process.env.SCRAPER_INTERVAL) || 5000
    });

    scraper.on("newAnime", async ({ anime_count, data }) => {
        try {
            AzusaLog.log({
                type: "info",
                message: `[Update] ${data?.latest?.title || "New anime update"}`
            });

            if (anime_count === 1 && data?.latest) {
                const now = new Date();
                const jakartaTime = new Date(
                    now.toLocaleString("en-US", { timeZone: "Asia/Jakarta" })
                );
                const pad = n => n.toString().padStart(2, "0");
                const timeString = `${jakartaTime.getFullYear()}-${pad(
                    jakartaTime.getMonth() + 1
                )}-${pad(jakartaTime.getDate())} ${pad(
                    jakartaTime.getHours()
                )}:${pad(jakartaTime.getMinutes())}:${pad(
                    jakartaTime.getSeconds()
                )}`;

                const latest = data.latest;
                const genres = await getGenres(latest.link);
                const caption = `*${latest.title}*

*Episode:* ${latest.eps || "-"}
*Type:* ${latest.type || "-"}
*Genre:* ${genres?.map(g => g.name).join(", ") || "-"}
*Status:* ${latest.status || "-"}
*Link:* ${latest.link}

*${timeString}*`;

                try {
                    if (latest.thumbnail) {
                        await sock.sendMessage(GROUP_JID, {
                            image: { url: latest.thumbnail },
                            caption
                        });
                    } else {
                        await sock.sendMessage(GROUP_JID, { text: caption });
                    }
                    AzusaLog.log({
                        type: "success",
                        message: "Sent anime update to group successfully"
                    });
                } catch (err) {
                    AzusaLog.handleError(
                        err,
                        "Failed to send message to group"
                    );
                }
            } else if (data?.updates && Array.isArray(data.updates)) {
                let message = `*AnimeKompi Update!* (${anime_count} new anime)\n\n`;

                for (const anime of updatesToSend) {
                    message += `*${anime.title}* (${anime.eps || "-"})
Genre: ${Array.isArray(anime.genre) ? anime.genre.join(", ") : "-"}
Link: ${anime.link}\n\n`;
                }

                try {
                    await sock.sendMessage(GROUP_JID, { text: message });
                    AzusaLog.log({
                        type: "success",
                        message: "Sent multiple anime updates to group"
                    });
                } catch (err) {
                    AzusaLog.handleError(
                        err,
                        "Failed to send multiple updates"
                    );
                }
            }
        } catch (err) {
            AzusaLog.handleError(err, "Failed to process anime updates");
        }
    });

    scraper.on("update", list =>
        AzusaLog.log({
            type: "info",
            message: `Total anime entries: ${list?.data?.length || 0}`
        })
    );

    scraper.on("scrapeError", errInfo => {
        AzusaLog.handleError(
            new Error(errInfo.error),
            `Scrape Error (Code: ${errInfo.code})`
        );
    });

    scraper.on("checkError", errInfo => {
        AzusaLog.handleError(
            new Error(errInfo.message),
            "Error while checking for new anime"
        );
    });

    scraper.on("fileError", errInfo => {
        AzusaLog.handleError(
            new Error(errInfo.error),
            `File Error on ${errInfo.file}`
        );
    });

    scraper.on("criticalError", err => {
        AzusaLog.handleError(err, "Critical Scraper Error");
        // Optional: Stop the scraper or alert admin here
    });

    scraper.on("info", msg => {
        AzusaLog.log({ type: "info", message: msg });
    });

    scraper.on("warning", msg => {
        AzusaLog.log({ type: "warning", message: msg });
    });

    scraper.on("error", (err, errInfo) => {
        AzusaLog.handleError(
            err,
            `General Error: ${errInfo?.message || "Unknown error"}`
        );
    });
}

process.on("SIGINT", async () => {
    AzusaLog.log({ type: "warning", message: "SIGINT Triggered..." });
    AzusaLog.log({ type: "info", message: "Disconnecting from Redis..." });
    try {
        if (redisClient && redisClient.isOpen) {
            await redisClient.quit();
            AzusaLog.log({
                type: "success",
                message: "Successfully disconnected from Redis."
            });
        }
    } catch (err) {
        AzusaLog.handleError(err, "Error disconnecting from Redis");
    } finally {
        process.exit(0);
    }
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
    AzusaLog.handleError(reason, "Unhandled Promise Rejection");
});

// Handle uncaught exceptions
process.on("uncaughtException", err => {
    AzusaLog.handleError(err, "Uncaught Exception");
    // Give logger time to write before exiting
    setTimeout(() => {
        process.exit(1);
    }, 1000);
});

// Start the bot
startBot().catch(err => {
    AzusaLog.handleError(err, "Failed to start bot");
    process.exit(1);
});

