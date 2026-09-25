const form = document.querySelector("#settings-form");
const portInput = document.querySelector("#port");
const urlInput = document.querySelector("#url");
const status = document.querySelector("#status");
const buttons = [...document.querySelectorAll("button")];
const pauseButton = document.querySelector("#pause");
const pauseState = document.querySelector("#pause-state");
let paused = false;

function showPaused(value) {
  paused = value === true;
  pauseButton.textContent = paused ? "Resume redirects" : "Pause redirects";
  pauseState.textContent = paused
    ? "Paused. Your saved settings are kept."
    : "Redirects enabled when settings are saved.";
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.paused) showPaused(changes.paused.newValue);
});

function message(text, error = false) {
  status.textContent = text;
  status.classList.toggle("error", error);
}

function busy(value) {
  buttons.forEach((button) => { button.disabled = value; });
}

busy(true);
browser.storage.local.get(["settings", "paused"]).then(({ settings, paused }) => {
  showPaused(paused);
  if (settings) {
    portInput.value = settings.port;
    urlInput.value = settings.url;
    message(`Saved: ${settings.url} → localhost:${settings.port}`);
  }
}).catch(() => message("Could not load settings. Reopen the popup to try again.", true))
  .finally(() => busy(false));

pauseButton.addEventListener("click", async () => {
  busy(true);
  try {
    const nextPaused = !paused;
    await browser.storage.local.set({ paused: nextPaused });
    showPaused(nextPaused);
    message(nextPaused ? "Redirects paused." : "Redirects resumed.");
  } catch {
    message("Could not change pause status. Please try again.", true);
  } finally {
    busy(false);
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  busy(true);
  try {
    const settings = RedirectLocal.parseSettings({ port: portInput.value, url: urlInput.value });
    await browser.storage.local.set({ settings });
    portInput.value = settings.port;
    urlInput.value = settings.url;
    message(`Saved: ${settings.url} → localhost:${settings.port}`);
  } catch (error) {
    message(error.message || "Could not save settings.", true);
  } finally {
    busy(false);
  }
});

document.querySelector("#clear").addEventListener("click", async () => {
  busy(true);
  try {
    await browser.storage.local.remove("settings");
    form.reset();
    message("Settings cleared. Redirects are off.");
  } catch {
    message("Could not clear settings. Please try again.", true);
  } finally {
    busy(false);
  }
});
