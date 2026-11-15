const { ipcRenderer } = require("electron");

// Runs in the isolated world before page scripts. No policy is stored in or
// exposed to the page, and revocation cannot race an asynchronous notification.
for (const name of ["wheel", "beforeinput", "paste", "cut", "copy", "dragstart", "dragover", "drop", "touchstart", "touchmove", "contextmenu"]) {
  window.addEventListener(name, event => {
    if (!event.isTrusted) return; // Agent DOM actions are governed by the driver.
    let allowed = false;
    try { allowed = ipcRenderer.sendSync("browser:input-allowed") === true; } catch { /* Fail closed if the policy is unavailable. */ }
    if (allowed) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true, passive: false });
}
