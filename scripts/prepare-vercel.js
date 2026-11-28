"use strict";

const fs = require("fs");
const path = require("path");

const frontendPath = path.resolve(__dirname, "..", "frontend");
const publicPath = path.resolve(__dirname, "..", "public");

if (!fs.existsSync(frontendPath)) {
    throw new Error(`Frontend directory not found: ${frontendPath}`);
}

fs.mkdirSync(publicPath, { recursive: true });
fs.cpSync(frontendPath, publicPath, { recursive: true });
