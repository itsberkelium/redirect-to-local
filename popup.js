const extensionAPI = globalThis.browser ?? globalThis.chrome;
const form = document.querySelector("#settings-form");
const portInput = document.querySelector("#port");
const urlInput = document.querySelector("#url");
const status = document.querySelector("#status");
const buttons = [...document.querySelectorAll("button")];
const carryInputs = Object.fromEntries(RedirectLocal.CARRY_KEYS.map((key) => [key, document.querySelector(`#carry-${key}`)]));
const warnInput = document.querySelector("#warn");
const carryInfo = document.querySelector("#carry-info");
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

extensionAPI.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.paused) showPaused(changes.paused.newValue);
});

function showCarryInfo() {
  carryInfo.hidden = !(carryInputs.localStorage.checked || carryInputs.sessionStorage.checked);
}
Object.values(carryInputs).forEach((input) => input.addEventListener("change", showCarryInfo));

function showCarry(settings) {
  for (const key of RedirectLocal.CARRY_KEYS) carryInputs[key].checked = settings.carry?.[key] === true;
  warnInput.checked = settings.warn === true;
  showCarryInfo();
}

function message(text, error = false) {
  status.textContent = text;
  status.classList.toggle("error", error);
}

function busy(value) {
  buttons.forEach((button) => { button.disabled = value; });
}

busy(true);
extensionAPI.storage.local.get(["settings", "paused"]).then(({ settings, paused }) => {
  showPaused(paused);
  if (settings) {
    portInput.value = settings.port;
    urlInput.value = settings.url;
    showCarry(settings);
    message(`Saved: ${settings.url} → localhost:${settings.port}`);
  }
}).catch(() => message("Could not load settings. Reopen the popup to try again.", true))
  .finally(() => busy(false));

pauseButton.addEventListener("click", async () => {
  busy(true);
  try {
    const nextPaused = !paused;
    await extensionAPI.storage.local.set({ paused: nextPaused });
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
    const carry = Object.fromEntries(RedirectLocal.CARRY_KEYS.map((key) => [key, carryInputs[key].checked]));
    const settings = RedirectLocal.parseSettings({ port: portInput.value, url: urlInput.value, carry, warn: warnInput.checked });
    await extensionAPI.storage.local.set({ settings });
    portInput.value = settings.port;
    urlInput.value = settings.url;
    showCarry(settings);
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
    await extensionAPI.storage.local.remove("settings");
    form.reset();
    showCarryInfo();
    message("Settings cleared. Redirects are off.");
  } catch {
    message("Could not clear settings. Please try again.", true);
  } finally {
    busy(false);
  }
});
