(function () {
  "use strict";

  const measurementId = "G-4L31LHDCTL";
  const storageKey = "jr-analytics-consent";
  const validChoices = new Set(["granted", "denied"]);
  let previousFocus = null;
  let panel = null;

  function getChoice() {
    try {
      const choice = window.localStorage.getItem(storageKey);
      return validChoices.has(choice) ? choice : null;
    } catch (error) {
      return null;
    }
  }

  function saveChoice(choice) {
    try {
      window.localStorage.setItem(storageKey, choice);
    } catch (error) {
      // The current choice still applies for this page view.
    }
  }

  function loadAnalytics() {
    if (document.getElementById("google-analytics-script")) return;

    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () {
      window.dataLayer.push(arguments);
    };
    window.gtag("consent", "default", {
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
      analytics_storage: "denied"
    });
    window.gtag("consent", "update", {
      analytics_storage: "granted"
    });
    window.gtag("js", new Date());
    window.gtag("config", measurementId);

    const script = document.createElement("script");
    script.id = "google-analytics-script";
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
    document.head.appendChild(script);
  }

  function disableAnalytics() {
    window[`ga-disable-${measurementId}`] = true;
    const cookieNames = ["_ga", `_ga_${measurementId.replace("G-", "")}`];
    cookieNames.forEach(function (name) {
      document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
      document.cookie = `${name}=; Max-Age=0; Path=/; Domain=.joserizzo.com; SameSite=Lax`;
    });
  }

  function closePanel() {
    if (!panel) return;
    panel.remove();
    panel = null;
    document.body.classList.remove("consent-open");
    if (previousFocus) previousFocus.focus();
  }

  function choose(choice) {
    saveChoice(choice);
    if (choice === "granted") {
      window[`ga-disable-${measurementId}`] = false;
      loadAnalytics();
    } else {
      disableAnalytics();
    }
    closePanel();
  }

  function keepFocusInside(event) {
    if (event.key !== "Tab" || !panel) return;
    const controls = panel.querySelectorAll("button");
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function openPanel() {
    if (panel) return;
    previousFocus = document.activeElement;
    panel = document.createElement("div");
    panel.className = "consent-backdrop";
    panel.innerHTML = `
      <section class="consent-panel" role="dialog" aria-modal="true" aria-labelledby="consent-title" aria-describedby="consent-description">
        <h2 id="consent-title">A little signal?</h2>
        <p id="consent-description">I use Google Analytics to understand how people find and use this website. Analytics only loads if you choose to allow it.</p>
        <div class="consent-actions">
          <button class="button button-primary" type="button" data-consent="granted">Accept analytics</button>
          <button class="button button-secondary" type="button" data-consent="denied">No thanks</button>
        </div>
      </section>`;
    panel.addEventListener("click", function (event) {
      const button = event.target.closest("[data-consent]");
      if (button) choose(button.dataset.consent);
    });
    panel.addEventListener("keydown", keepFocusInside);
    document.body.appendChild(panel);
    document.body.classList.add("consent-open");
    panel.querySelector("button").focus();
  }

  function addSettingsControl() {
    const footer = document.querySelector(".footer-inner");
    if (!footer || footer.querySelector(".analytics-settings")) return;
    const control = document.createElement("button");
    control.className = "analytics-settings";
    control.type = "button";
    control.textContent = "Analytics settings";
    control.addEventListener("click", openPanel);
    footer.appendChild(control);
  }

  document.addEventListener("DOMContentLoaded", function () {
    addSettingsControl();
    const choice = getChoice();
    if (choice === "granted") {
      loadAnalytics();
    } else if (choice === "denied") {
      disableAnalytics();
    } else {
      openPanel();
    }
  });
})();
