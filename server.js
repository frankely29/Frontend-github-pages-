const express = require("express");
const compression = require("compression");
const path = require("path");

const app = express();
const rootDir = __dirname;
const port = process.env.PORT || 3000;

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

app.use(express.static(rootDir, {
  etag: true,
  lastModified: true,
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

app.get("/", (req, res) => {
  res.sendFile(path.join(rootDir, "index.html"));
});

app.listen(port, () => {
  console.log(`Static frontend server listening on port ${port}`);
});
