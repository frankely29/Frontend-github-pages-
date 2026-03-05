const express = require("express");
const path = require("path");

const app = express();
const rootDir = __dirname;
const port = process.env.PORT || 3000;

const noCachePaths = new Set(["/app.js", "/index.html", "/style.css"]);

app.use((req, res, next) => {
  if (noCachePaths.has(req.path)) {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
  }
  next();
});

app.use(express.static(rootDir));

app.get("/", (req, res) => {
  res.sendFile(path.join(rootDir, "index.html"));
});

app.listen(port, () => {
  console.log(`Static frontend server listening on port ${port}`);
});
