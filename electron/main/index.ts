import { app, BrowserWindow, shell, ipcMain } from "electron";
import { release } from "node:os";
import { join } from "node:path";
import fs from "node:fs";
import path from "node:path";
import pool from "tiny-async-pool";
import { parseSubtitle } from "./utils/translate";
import { translateFile, hashContent } from "./utils/pipeline";
import { makeKey } from "../shared/subtitleKey";

// The built directory structure
//
// ├─┬ dist-electron
// │ ├─┬ main
// │ │ └── index.js    > Electron-Main
// │ └─┬ preload
// │   └── index.js    > Preload-Scripts
// ├─┬ dist
// │ └── index.html    > Electron-Renderer
//
process.env.DIST_ELECTRON = join(__dirname, "../");
process.env.DIST = join(process.env.DIST_ELECTRON, "../dist");
process.env.PUBLIC = process.env.VITE_DEV_SERVER_URL
  ? join(process.env.DIST_ELECTRON, "../public")
  : process.env.DIST;

// Disable GPU Acceleration for Windows 7
if (release().startsWith("6.1")) app.disableHardwareAcceleration();

// Set application name for Windows 10+ notifications
if (process.platform === "win32") app.setAppUserModelId(app.getName());

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Remove electron security warnings
// This warning only shows in development mode
// Read more on https://www.electronjs.org/docs/latest/tutorial/security
// process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true'

let win: BrowserWindow | null = null;
// Here, you can also use other preload
const preload = join(__dirname, "../preload/index.js");
const url = process.env.VITE_DEV_SERVER_URL;
const indexHtml = join(process.env.DIST, "index.html");

async function createWindow() {
  win = new BrowserWindow({
    title: "Main window",
    icon: join(process.env.PUBLIC, "favicon.ico"),
    minWidth: 800,
    minHeight: 640,
    webPreferences: {
      preload,
      // Warning: Enable nodeIntegration and disable contextIsolation is not secure in production
      // Consider using contextBridge.exposeInMainWorld
      // Read more on https://www.electronjs.org/docs/latest/tutorial/context-isolation
      nodeIntegration: true,
      contextIsolation: false,
    },
    ...(process.platform === "darwin"
      ? {
          vibrancy: "fullscreen-ui",
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 10, y: 12 },
        }
      : {
          titleBarOverlay: true,
          autoHideMenuBar: true, // on Windows 11
          backgroundMaterial: "mica", // on Windows 11
        }),
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    // electron-vite-vue#298
    win.loadURL(url);
    // Open devTool if the app is not packaged
    // win.webContents.openDevTools()
  } else {
    win.loadFile(indexHtml);
  }

  // Make all links open with the browser, not with the application
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https:")) shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  win = null;
  if (process.platform !== "darwin") app.quit();
});

app.on("second-instance", () => {
  if (win) {
    // Focus on the main window if the user tried to open another
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on("activate", () => {
  const allWindows = BrowserWindow.getAllWindows();
  if (allWindows.length) {
    allWindows[0].focus();
  } else {
    createWindow();
  }
});

// New window example arg: new windows url
ipcMain.handle("open-win", (_, arg) => {
  const childWindow = new BrowserWindow({
    webPreferences: {
      preload,
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    childWindow.loadURL(`${url}#${arg}`);
  } else {
    childWindow.loadFile(indexHtml, { hash: arg });
  }
});

ipcMain.on("batch-progress", (event, data) => {
  // Optional: log or handle progress if needed
  console.log("Batch progress:", data);
});

// Cache analysis per file so renderer can fetch it on demand
const analysisCache = new Map<string, any>();

ipcMain.handle("check-analysis-cache", async (_, filePaths: string[]) => {
  const cached: string[] = [];
  for (const filePath of filePaths) {
    const cacheFile = filePath.replace(/\.[^/.]+$/, "") + ".analysis.json";
    if (!fs.existsSync(cacheFile)) continue;
    try {
      const { contentHash, analysis } = JSON.parse(
        fs.readFileSync(cacheFile, "utf8")
      );
      const fileContent = fs.readFileSync(filePath, "utf8");
      if (contentHash === hashContent(fileContent) && analysis) {
        cached.push(filePath);
      }
    } catch {}
  }
  return cached;
});

ipcMain.handle("batch-translate", async (event, { files, params }) => {
  const processFile = async (file) => {
    await translateFile(file, params, (data) => {
      if (data.analysis) analysisCache.set(data.filePath, data.analysis);
      event.sender.send("batch-progress", data);
    });
  };
  for await (const _ of pool(3, files, processFile)) {
    // Process all files in parallel with concurrency 3
  }
  return { success: true };
});

// Allow renderer to fetch cached analysis for a file (in case progress event missed)
ipcMain.handle("get-analysis", async (event, filePath: string) => {
  try {
    return analysisCache.get(filePath) || null;
  } catch {
    return null;
  }
});

ipcMain.handle("get-translated-content", async (event, filePath) => {
  const translatedPath =
    filePath.replace(/\.[^/.]+$/, "") +
    ".translated." +
    path.extname(filePath).slice(1).toLowerCase();
  if (fs.existsSync(translatedPath)) {
    return fs.readFileSync(translatedPath, "utf8");
  }
  throw new Error("Translated file not found");
});

ipcMain.handle("get-subtitle-preview", async (event, filePath) => {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const content = fs.readFileSync(filePath, "utf8");
  let parsed = parseSubtitle(content, ext);
  let subtitle;
  if (Array.isArray(parsed)) {
    subtitle = parsed.filter((line: any) => line.type === "cue");
  } else if (parsed.events) {
    subtitle = parsed.events;
  } else {
    subtitle = parsed;
  }

  const translatedPath =
    filePath.replace(/\.[^/.]+$/, "") + ".translated." + ext;

  // Prefer time-based alignment to avoid index drift; fallback to index-based if needed
  let translatedCuesArray: string[] | null = null;
  let translatedMap: Map<string, string> | null = null;

  if (fs.existsSync(translatedPath)) {
    const translatedContent = fs.readFileSync(translatedPath, "utf8");
    let translatedParsed = parseSubtitle(translatedContent, ext);
    let translatedSubtitle;
    if (Array.isArray(translatedParsed)) {
      translatedSubtitle = translatedParsed.filter(
        (line: any) => line.type === "cue"
      );
    } else if (translatedParsed.events) {
      translatedSubtitle = translatedParsed.events;
    } else {
      translatedSubtitle = translatedParsed;
    }

    translatedCuesArray = translatedSubtitle.map(
      (c: any) => c.data.translatedText || c.data.text
    );

    translatedMap = new Map<string, string>();
    translatedSubtitle.forEach((c: any) => {
      const key = makeKey(c.data.start, c.data.end);
      translatedMap!.set(key, c.data.translatedText || c.data.text);
    });
  }

  const cues = subtitle.map((cue: any, index: number) => {
    const key = makeKey(cue.data.start, cue.data.end);
    const byTime = translatedMap ? translatedMap.get(key) : undefined;
    const byIndex = translatedCuesArray
      ? translatedCuesArray[index]
      : undefined;
    return {
      text: cue.data.text,
      translatedText: byTime ?? byIndex,
      start: cue.data.start,
      end: cue.data.end,
    };
  });

  return { cues };
});
