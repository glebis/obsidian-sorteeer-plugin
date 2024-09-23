import { requestUrl } from 'obsidian';

interface UrlFetchResult {
    [key: string]: string;
}

function blank(text: string): boolean {
    return text === undefined || text === null || text === '';
}

function notBlank(text: string): boolean {
    return !blank(text);
}

async function load(window: any, url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        window.webContents.on("did-finish-load", (event: any) => resolve(event));
        window.webContents.on("did-fail-load", (event: any) => reject(event));
        window.loadURL(url);
    });
}

async function electronGetPageTitle(url: string): Promise<string> {
    const electronPkg = require("electron");
    const { remote } = electronPkg;
    const { BrowserWindow } = remote;

    try {
        const window = new BrowserWindow({
            width: 1000,
            height: 600,
            webPreferences: {
                webSecurity: false,
                nodeIntegration: true,
                images: false,
            },
            show: false,
        });
        window.webContents.setAudioMuted(true);

        await load(window, url);

        try {
            const title = window.webContents.getTitle();
            window.destroy();

            if (notBlank(title)) {
                return title;
            } else {
                return url;
            }
        } catch (ex) {
            window.destroy();
            return url;
        }
    } catch (ex) {
        console.error(ex);
        return "Site Unreachable";
    }
}

async function nonElectronGetPageTitle(url: string): Promise<string> {
    try {
        const response = await requestUrl({ url });
        const html = response.text;

        const doc = new DOMParser().parseFromString(html, "text/html");
        const title = doc.querySelector("title");

        if (title == null || blank(title?.innerText)) {
            // If site is javascript based and has a no-title attribute when unloaded, use it.
            const noTitle = title?.getAttribute("no-title");
            if (noTitle && notBlank(noTitle)) {
                return noTitle;
            }

            // Otherwise if the site has no title/requires javascript simply return the URL
            return url;
        }

        return title.innerText;
    } catch (ex) {
        console.error(ex);
        return "Site Unreachable";
    }
}

function getUrlFinalSegment(url: string): string {
    try {
        const segments = new URL(url).pathname.split('/');
        const last = segments.pop() || segments.pop(); // Handle potential trailing slash
        return last || '';
    } catch (_) {
        return "File"
    }
}

async function tryGetFileType(url: string) {
    try {
        const response = await requestUrl({ url, method: "HEAD" });

        // Ensure site returns an ok status code before scraping
        if (!response.status.toString().startsWith('2')) {
            return "Site Unreachable";
        }

        // Ensure site is an actual HTML page and not a pdf or 3 gigabyte video file.
        let contentType = response.headers["content-type"];
        if (!contentType.includes("text/html")) {
            return getUrlFinalSegment(url);
        }
        return null;
    } catch (err) {
        return null;
    }
}

export async function fetchUrlContent(url: string, fields: string[]): Promise<UrlFetchResult> {
    if (!(url.startsWith("http") || url.startsWith("https"))) {
        url = "https://" + url;
    }

    // Try to do a HEAD request to see if the site is reachable and if it's an HTML page
    // If we error out due to CORS, we'll just try to scrape the page anyway.
    let fileType = await tryGetFileType(url);
    if (fileType) {
        return { title: fileType };
    }

    let title: string;
    if (typeof require !== 'undefined') {
        title = await electronGetPageTitle(url);
    } else {
        title = await nonElectronGetPageTitle(url);
    }

    const result: UrlFetchResult = { title };

    // For other fields, we'll use the non-Electron method
    try {
        const response = await requestUrl({ url });
        const html = response.text;
        const doc = new DOMParser().parseFromString(html, 'text/html');

        fields.forEach(field => {
            if (field !== 'title') {
                switch (field) {
                    case 'description':
                        result.description = doc.querySelector('meta[name="description"]')?.getAttribute('content') || 
                                             doc.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';
                        break;
                    case 'image':
                        result.image = doc.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
                        break;
                    default:
                        result[field] = doc.querySelector(`meta[property="og:${field}"]`)?.getAttribute('content') || 
                                        doc.querySelector(`meta[name="${field}"]`)?.getAttribute('content') || '';
                }
            }
        });
    } catch (error) {
        console.error(`Error fetching additional fields: ${error}`);
    }

    return result;
}

export function extractUnlinkedUrls(content: string): string[] {
    const urlRegex = /(?<!(\[.*?\]\())(https?:\/\/[^\s\)]+)(?!\))/g;
    return Array.from(content.matchAll(urlRegex), match => match[0]);
}
