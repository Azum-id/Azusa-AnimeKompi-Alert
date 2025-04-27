// AnimeScraper.js
import axios from "axios";
import * as cheerio from "cheerio";
import _ from "lodash";
import fs from "fs/promises";
import { existsSync } from "fs";
import EventEmitter from "events";

/**
 * AnimeScraper - A class for scraping anime updates from websites
 * @extends EventEmitter
 */
export class AnimeScraper extends EventEmitter {
    constructor({
        url = "https://animekompi.top/",
        dataFile = "./lastAnimeData.json",
        interval = 5000
    } = {}) {
        super();
        this.url = url;
        this.dataFile = dataFile;
        this.interval = interval;
        this.lastAnimeData = [];
        this.http = axios.create({
            timeout: 10000, // 10 seconds
            headers: {
                "User-Agent": "Mozilla/5.0 (compatible; AnimeScraper/1.0)"
            }
        });
        this._initialize();
    }

    async _initialize() {
        try {
            if (!existsSync(this.dataFile)) {
                try {
                    await fs.writeFile(this.dataFile, JSON.stringify([]));
                    this.emit(
                        "info",
                        `Created new data file at ${this.dataFile}`
                    );
                } catch (fileErr) {
                    throw new Error(
                        `Failed to create data file: ${fileErr.message}`
                    );
                }
            }

            try {
                const rawData = await fs.readFile(this.dataFile, "utf-8");
                this.lastAnimeData = JSON.parse(rawData);
            } catch (readErr) {
                if (readErr.code === "ENOENT") {
                    this._logError(
                        readErr,
                        `Data file not found: ${this.dataFile}`
                    );
                } else {
                    this._logError(
                        readErr,
                        `Failed to read data file: ${this.dataFile}`
                    );
                }
                // Continue with empty data rather than failing
                this.lastAnimeData = [];
            }

            await this.updateAnimeData();
            this._startInterval();
        } catch (err) {
            this._logError(err, "Initialization failed");
            // Emit a critical error event for proper handling by consumers
            this.emit("criticalError", err);
        }
    }

    async _startInterval() {
        // Use setInterval instead of while loop to avoid blocking
        this.timer = setInterval(async () => {
            try {
                await this.checkForNewAnime();
            } catch (err) {
                this._logError(err, "Error in interval check");
                // Implement retry mechanism with backoff
                if (!this.retryCount) this.retryCount = 0;

                if (this.retryCount < 3) {
                    this.retryCount++;
                    this.emit(
                        "info",
                        `Retry attempt ${this.retryCount} scheduled in ${
                            this.retryCount * 1000
                        }ms`
                    );

                    setTimeout(async () => {
                        try {
                            await this.checkForNewAnime();
                            this.retryCount = 0; // Reset on success
                        } catch (retryErr) {
                            this._logError(
                                retryErr,
                                `Retry attempt ${this.retryCount} failed`
                            );
                        }
                    }, this.retryCount * 1000);
                }
            }
        }, this.interval);

        this.emit("info", `Scraper started with ${this.interval}ms interval`);
    }

    /**
     * Stops the scraper interval
     */
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            this.emit("info", "Scraper stopped");
        }
    }

    async fetchAnimeUpdates() {
        try {
            this.emit("scrapeStart");

            let response;
            try {
                response = await this.http.get(this.url);
            } catch (networkErr) {
                if (axios.isAxiosError(networkErr)) {
                    if (networkErr.response) {
                        // Server responded with a status code outside the 2xx range
                        throw new Error(
                            `HTTP Error: ${networkErr.response.status} - ${networkErr.response.statusText}`
                        );
                    } else if (networkErr.request) {
                        // Request was made but no response was received
                        throw new Error(
                            `Network Error: No response received - ${
                                networkErr.code || networkErr.message
                            }`
                        );
                    } else {
                        // Request configuration error
                        throw new Error(`Request Error: ${networkErr.message}`);
                    }
                }
                throw networkErr; // Re-throw other types of errors
            }

            if (!response.data) {
                throw new Error("Empty response received from server");
            }

            const $ = cheerio.load(response.data);
            const list = $(".listupd.normal");

            if (!list.length) {
                throw new Error(
                    "Element <div class='listupd normal'> not found - page structure may have changed"
                );
            }

            // Use Array.from instead of map().get() for better readability
            const articles = Array.from(list.find("article")).map(el =>
                this._parseArticle(el, $)
            );

            if (!articles.length) {
                throw new Error(
                    "No articles found on the page - content may be unavailable"
                );
            }

            this.emit("scrapeEnd", articles.length);
            return articles;
        } catch (err) {
            if (axios.isAxiosError(err)) {
                this._logError(
                    err,
                    `Failed to fetch data (Axios Error: ${
                        err.code || err.message
                    })`
                );
            } else {
                this._logError(err, "Failed to fetch data");
            }

            // Emit specific scrape error event with details
            this.emit("scrapeError", {
                timestamp: new Date().toISOString(),
                url: this.url,
                error: err.message,
                code: err.code || "UNKNOWN"
            });

            return [];
        }
    }

    _parseArticle(el, $) {
        const $el = $(el);
        // Cache jQuery lookups for better performance
        const $title = $el.find(".tt");
        const $img = $el.find("img");

        const title =
            $title
                .contents()
                .filter(function () {
                    return this.type === "text";
                })
                .text()
                .trim() || "No Title";

        const title_eps =
            $el.find("h2").text().trim() || title || "No Episode Title";
        const link = $el.find("a").attr("href") || "No Link";
        const thumbnail = $img.attr("data-lazy-src") || $img.attr("src") || "";

        const genre = Array.from($el.find(".genre > a")).map(g =>
            $(g).text().trim()
        );
        const type = $el.find(".typez").text().trim() || "Unknown";
        const eps = $el.find(".bt .epx").text().trim() || "-";
        const status = $el.find(".status.Completed").length
            ? "Completed"
            : "Ongoing";

        return { title, title_eps, link, thumbnail, genre, type, eps, status };
    }

    /**
     * Updates the stored anime data with latest fetched data
     * @returns {Promise<boolean>} Success status
     */
    async updateAnimeData() {
        try {
            const latest = await this.fetchAnimeUpdates();

            if (!Array.isArray(latest)) {
                throw new Error("Invalid data format received");
            }

            if (latest.length) {
                this.lastAnimeData = latest;
                const saveSuccess = await this._saveToFile(this.lastAnimeData);

                if (saveSuccess) {
                    this.emit("update", {
                        count: latest.length,
                        timestamp: new Date().toISOString(),
                        data: latest
                    });
                    return true;
                } else {
                    throw new Error("Failed to save data file");
                }
            } else {
                this.emit("info", "No new data available for update");
                return false;
            }
        } catch (err) {
            this._logError(err, "Update operation failed");
            return false;
        }
    }

    /**
     * Checks for new anime updates and emits events accordingly
     * @returns {Promise<object|null>} New anime data payload or null if no updates
     */
    async checkForNewAnime() {
        try {
            const latest = await this.fetchAnimeUpdates();

            if (!latest || !Array.isArray(latest) || latest.length === 0) {
                this.emit("info", "No data received or empty data set");
                return null;
            }

            // Validate required fields in the latest data
            const invalidEntries = latest.filter(
                entry => !entry.title_eps || !entry.title
            );
            if (invalidEntries.length > 0) {
                this.emit(
                    "warning",
                    `Found ${invalidEntries.length} entries with missing required fields`
                );
            }

            // Use title_eps for comparison instead of title for more accurate matching
            const newAnimes = _.differenceBy(
                latest,
                this.lastAnimeData,
                "title_eps"
            );

            if (newAnimes.length > 0) {
                // Limit the saved data to a reasonable size (e.g., 100 entries)
                this.lastAnimeData = _.unionBy(
                    newAnimes,
                    this.lastAnimeData,
                    "title_eps"
                ).slice(0, 100);

                const saveSuccess = await this._saveToFile(this.lastAnimeData);

                if (!saveSuccess) {
                    throw new Error("Failed to save updated anime data");
                }

                const payload = {
                    status: "success",
                    anime_count: newAnimes.length,
                    timestamp: new Date().toISOString(),
                    source_url: this.url,
                    data: {
                        latest: newAnimes[0],
                        updates: newAnimes
                    }
                };

                this.emit("newAnime", payload);
                return payload;
            } else {
                this.emit("noUpdate");
                return null;
            }
        } catch (err) {
            this._logError(err, "Failed to check for new anime");

            // Emit structured error information
            this.emit("checkError", {
                timestamp: new Date().toISOString(),
                message: err.message,
                source_url: this.url
            });

            return null;
        }
    }

    // Extracted common file saving logic
    async _saveToFile(data) {
        try {
            await fs.writeFile(this.dataFile, JSON.stringify(data, null, 2));
            return true;
        } catch (err) {
            const errorDetails = {
                operation: "file_write",
                file: this.dataFile,
                timestamp: new Date().toISOString(),
                error: err.message,
                code: err.code || "UNKNOWN"
            };

            this._logError(err, `Failed to save file: ${this.dataFile}`);
            this.emit("fileError", errorDetails);
            return false;
        }
    }

    /**
     * Log and emit error events with additional context
     * @param {Error} err - The error object
     * @param {string} message - Custom error message
     * @private
     */
    _logError(err, message) {
        // Create a structured error object
        const errorObj = {
            message: `${message}: ${err.message}`,
            originalError: err.message,
            code: err.code || "UNKNOWN",
            stack: err.stack,
            timestamp: new Date().toISOString()
        };

        // Emit a better structured error
        this.emit("error", new Error(errorObj.message), errorObj);
    }
}

