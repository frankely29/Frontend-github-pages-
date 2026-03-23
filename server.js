const express = require("express");
const compression = require("compression");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const rootDir = __dirname;
const port = process.env.PORT || 3000;
const indexHtmlPath = path.join(rootDir, "index.html");
const frontendBuildId = [Date.now().toString(36), process.pid.toString(36), crypto.randomBytes(4).toString("hex")].join("-");
const indexHtmlTemplate = fs.readFileSync(indexHtmlPath, "utf8");
const indexHtml = indexHtmlTemplate.replace(/"__TLC_FRONTEND_BUILD_ID__"/, JSON.stringify(frontendBuildId));

const noStorePaths = new Set(["/", "/index.html"]);
const htmlShellPattern = /\.html?$/i;
const staticAssetPattern = /\.(?:css|js|mjs|json|svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf)$/i;

app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    const type = String(res.getHeader("Content-Type") || "");
    if (/image\//i.test(type)) return false;
    return compression.filter(req, res);
  },
}));

app.use((req, res, next) => {
  if (noStorePaths.has(req.path) || htmlShellPattern.test(req.path)) {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");
    res.set("CDN-Cache-Control", "no-store");
    return next();
  }

  if (staticAssetPattern.test(req.path)) {
    const hasVersion = Object.prototype.hasOwnProperty.call(req.query || {}, "v");
    if (hasVersion) {
      res.set("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.set("Pragma", "no-cache");
      res.set("Expires", "0");
    }
  }
  next();
});

app.get(["/", "/index.html"], (req, res) => {
  res.type("html");
  res.send(indexHtml);
});

app.use(express.static(rootDir, {
  etag: true,
  lastModified: true,
  index: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith("index.html")) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.setHeader("Surrogate-Control", "no-store");
      res.setHeader("CDN-Cache-Control", "no-store");
    }
  },
}));

app.listen(port, () => {
  console.log(`Static frontend server listening on port ${port} with build ${frontendBuildId}`);
});
