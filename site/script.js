const copyButton = document.querySelector("[data-copy-target]");
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
    copyStatus.textContent = "Install commands copied to the clipboard.";
  } catch {
    copyButton.textContent = "Copy unavailable";
    copyStatus.textContent = "Select the install commands and copy them manually.";
  }

  window.setTimeout(() => {
    copyButton.textContent = "Copy install";
    copyStatus.textContent = "";
  }, 2400);
});

// Serialize the site's content tags; keep navigation and controls out of exports.
function pageMarkdown(root) {
  function render(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent.replace(/\s+/g, " ").replace(/[\\`*_{}\[\]<>#|!~+-]/g, "\\$&");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    if (node.matches('nav, button, svg, script, style, [hidden], [aria-hidden="true"], .reference-rail, .copy-status, [data-copy-ui]')) return "";

    const tag = node.localName;
    const children = () => Array.from(node.childNodes, render).reduce((text, next) => {
      if (/\n\s*$/.test(text) || /^\s*\n/.test(next)) {
        return text.trimEnd() + "\n\n" + next.trimStart();
      }
      return text + next;
    }, "");
    const block = (text) => `\n\n${text.trim()}\n\n`;
    if (tag === "pre") {
      const text = node.textContent.replace(/\n$/, "");
      const fence = "`".repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length + 1)));
      return block(`${fence}\n${text}\n${fence}`);
    }
    if (tag === "code" || tag === "kbd") {
      const text = node.textContent.replace(/\s+/g, " ");
      const fence = "`".repeat(Math.max(1, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length + 1)));
      const padding = /^`|`$/.test(text) || (/^ .* $/.test(text) && text.trim()) ? " " : "";
      return `${fence}${padding}${text}${padding}${fence}`;
    }
    if (tag === "br") return "\n";
    if (/^h[1-6]$/.test(tag)) return block(`${"#".repeat(Number(tag[1]))} ${children().trim().replace(/\s+/g, " ")}`);
    if (tag === "a") {
      const href = node.getAttribute("href");
      return href ? `[${children().trim()}](<${new URL(href, document.baseURI).href.replace(/>/g, "%3E").replace(/</g, "%3C")}>)` : children();
    }
    if (tag === "strong" || tag === "b") return `**${children().trim()}**`;
    if (tag === "em" || tag === "i") return `*${children().trim()}*`;
    if (tag === "ul" || tag === "ol") {
      let index = Number(node.getAttribute("start") || 1);
      return block(Array.from(node.children).filter((item) => item.localName === "li").map((item) => {
        const marker = tag === "ol" ? `${index++}. ` : "- ";
        const content = render(item).trim();
        return marker + content.replace(/\n/g, `\n${" ".repeat(marker.length)}`);
      }).join("\n"));
    }
    if (tag === "blockquote") return block(children().trim().replace(/^/gm, "> "));
    if (["p", "div", "section", "aside", "dl", "dt", "dd"].includes(tag)) return block(children());
    // Adjacent labels in the site's flex rows still need a textual separator.
    if (tag === "span") return ` ${children()} `;
    return children();
  }
  return render(root).trim() + "\n";
}

const pageCopyButton = document.querySelector("[data-copy-page]");
const pageCopyStatus = document.querySelector("[data-page-copy-status]");
const manualCopy = document.querySelector("[data-manual-copy]");
let pageCopyTimer;

if (pageCopyButton) {
  pageCopyButton.hidden = false;
  pageCopyButton.addEventListener("click", async () => {
    window.clearTimeout(pageCopyTimer);
    pageCopyButton.disabled = true;
    pageCopyStatus.textContent = "";
    try {
      const markdown = pageMarkdown(document.querySelector("main"));
      manualCopy.querySelector("textarea").value = markdown;
      await copyText(markdown);
      manualCopy.hidden = true;
      pageCopyButton.textContent = "Copied";
      pageCopyStatus.textContent = "Page copied as Markdown.";
      pageCopyTimer = window.setTimeout(() => {
        pageCopyButton.textContent = "Copy page";
        pageCopyStatus.textContent = "";
      }, 2400);
    } catch {
      pageCopyButton.textContent = "Copy page";
      pageCopyStatus.textContent = "Clipboard unavailable. Copy the selected Markdown below.";
      manualCopy.hidden = false;
      const textarea = manualCopy.querySelector("textarea");
      textarea.focus();
      textarea.select();
    } finally {
      pageCopyButton.disabled = false;
    }
  });
}
