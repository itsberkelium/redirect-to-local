const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const target = process.argv[2];
if (!["chrome", "firefox"].includes(target)) throw new Error("Choose chrome or firefox.");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const files = ["shared.js", "background-core.js", "popup.html", "popup.css", "popup.js"];
if (target === "chrome") {
  delete manifest.browser_specific_settings;
  manifest.minimum_chrome_version = "109";
  manifest.permissions = ["storage", "webRequest"];
  manifest.background = { service_worker: "background-chrome.js" };
  manifest.icons = Object.fromEntries([16, 32, 48, 128].map(size => [size, `icons/redirect-${size}.png`]));
  manifest.action.default_icon = { "16": "icons/redirect-16.png", "32": "icons/redirect-32.png" };
  files.push("background-chrome.js", ...Object.values(manifest.icons));
} else {
  files.push("background.js", "icons/redirect.svg");
}
const output = path.join(root, "dist", target);
fs.mkdirSync(output, { recursive: true });
for (const file of files) {
  fs.mkdirSync(path.dirname(path.join(output, file)), { recursive: true });
  fs.copyFileSync(path.join(root, file), path.join(output, file));
}
fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
const archive = path.join(root, "dist", `redirect-to-local-${target}-${manifest.version}.zip`);
// Recreate this generated archive so removed files cannot linger in an old ZIP.
fs.rmSync(archive, { force: true });
execFileSync("zip", ["-q", archive, "manifest.json", ...files], { cwd: output });
console.log(`Built ${output}\nPackaged ${archive}`);
