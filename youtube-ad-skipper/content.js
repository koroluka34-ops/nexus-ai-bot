(() => {
  "use strict";

  // Runs only on YouTube pages and only while the video player is showing an ad.
  const PLAYER = ".html5-video-player";
  const SKIP_SELECTORS = [
    ".ytp-ad-skip-button",
    ".ytp-ad-skip-button-modern",
    ".ytp-skip-ad-button",
    ".ytp-ad-skip-button-container button"
  ];
  const SKIP_TEXT = /^(пропустить|пропустить рекламу|пропустити|skip|skip ad)$/i;
  let lastClickAt = 0;

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity || 1) > 0 &&
      rect.width > 0 && rect.height > 0;
  }

  function isEnabled(element) {
    return !element.disabled &&
      element.getAttribute("aria-disabled") !== "true" &&
      !element.classList.contains("ytp-disabled");
  }

  function findSkipButton(player) {
    for (const selector of SKIP_SELECTORS) {
      const candidate = player.querySelector(selector);
      if (isVisible(candidate) && isEnabled(candidate)) return candidate;
    }

    // Fallback for YouTube UI variants and localized labels.
    for (const candidate of player.querySelectorAll("button,[role='button']")) {
      const label = [
        candidate.innerText,
        candidate.getAttribute("aria-label"),
        candidate.getAttribute("title")
      ].filter(Boolean).join(" ").trim();

      if (SKIP_TEXT.test(label) && isVisible(candidate) && isEnabled(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  function trySkipAd() {
    const player = document.querySelector(PLAYER);
    if (!player) return;

    // Do not interact with the player outside an active ad.
    const adIsShowing =
      player.classList.contains("ad-showing") ||
      player.classList.contains("ytp-ad-playing");

    if (!adIsShowing) return;

    const button = findSkipButton(player);
    if (!button) return;

    const now = Date.now();
    if (now - lastClickAt < 1500) return;

    lastClickAt = now;
    button.click();
    console.info("[NEXUS] Нажата доступная кнопка пропуска рекламы YouTube.");
  }

  const observer = new MutationObserver(trySkipAd);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "disabled", "aria-disabled", "style"]
  });

  // Some YouTube ad controls change state without a DOM mutation.
  window.setInterval(trySkipAd, 500);
  trySkipAd();
})();