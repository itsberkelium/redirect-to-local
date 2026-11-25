const extensionAPI = globalThis.browser ?? globalThis.chrome;
const params = new URL(location.href).searchParams;
const labels = { cookies: "Cookies", localStorage: "localStorage", sessionStorage: "sessionStorage" };
const carry = (params.get("carry") || "").split(",").filter((key) => key in labels);

document.querySelector("#summary").textContent =
  `${params.get("site")} can redirect to localhost:${params.get("port")}. Carry these over?`;
const items = document.querySelector("#items");
for (const key of carry) {
  const item = document.createElement("li");
  item.textContent = labels[key];
  items.append(item);
}
document.querySelector("#temp-tab").hidden = !carry.includes("localStorage");

async function answer(value) {
  document.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  try {
    await extensionAPI.runtime.sendMessage({ type: "carry-answer", id: params.get("id"), answer: value });
  } finally {
    window.close();
  }
}
document.querySelector("#carry").addEventListener("click", () => answer("carry"));
document.querySelector("#plain").addEventListener("click", () => answer("plain"));
document.querySelector("#stay").addEventListener("click", () => answer("stay"));
