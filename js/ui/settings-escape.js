/* v41: Escape closes the Settings / session dialog. */
document.addEventListener("keydown", function(event) {
  if (event.key !== "Escape") return;
  const settingsDialog = document.getElementById("sessionModal");
  if (settingsDialog && settingsDialog.classList.contains("show")) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof closeSession === "function") closeSession();
  }
}, true);
