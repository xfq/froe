const copyButton = document.querySelector(".copy-button");
const copyStatus = document.querySelector(".copy-status");

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.append(textArea);
  textArea.select();
  const copied = document.execCommand("copy");
  textArea.remove();

  if (!copied) throw new Error("Copy command was unavailable");
}

copyButton?.addEventListener("click", async () => {
  const targetId = copyButton.dataset.copyTarget;
  const target = targetId ? document.getElementById(targetId) : null;

  if (!target) return;

  try {
    await copyText(target.textContent.trim());
    copyButton.textContent = "Copied";
    copyStatus.textContent = "Setup commands copied to the clipboard.";
  } catch {
    copyButton.textContent = "Copy unavailable";
    copyStatus.textContent = "Select the setup commands and copy them manually.";
  }

  window.setTimeout(() => {
    copyButton.textContent = "Copy setup";
    copyStatus.textContent = "";
  }, 2400);
});
