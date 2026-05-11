(function () {
  "use strict";

  var SOCIAL_HOSTS = [
    "linkedin.com",
    "facebook.com",
    "instagram.com",
    "x.com",
    "twitter.com",
    "youtube.com",
    "github.com",
    "share.google",
    "google.com/maps",
    "maps.google"
  ];

  var BOOKING_HOSTS = [
    "calendar.app.google",
    "calendly.com"
  ];

  function compactText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .replace(/[^\x20-\x7E]/g, "")
      .trim()
      .slice(0, 160);
  }

  function getPagePath() {
    if (window.location.protocol === "file:") {
      var fileName = (window.location.pathname || "").split("/").pop() || "index.html";
      return "/" + fileName + window.location.search;
    }

    return window.location.pathname + window.location.search;
  }

  function getSourcePage() {
    var path = window.location.pathname || "/";
    if (path === "/" || path.endsWith("/")) return "index";
    return path.split("/").pop().replace(/\.[^.]+$/, "") || "index";
  }

  function baseParams() {
    return {
      source_page: getSourcePage(),
      page_path: getPagePath(),
      page_title: document.title || ""
    };
  }

  function cleanParams(params) {
    var cleaned = {};
    Object.keys(params || {}).forEach(function (key) {
      var value = params[key];
      if (value === undefined || value === null || value === "") return;
      if (typeof value === "string") {
        cleaned[key] = compactText(value);
      } else if (typeof value === "number" || typeof value === "boolean") {
        cleaned[key] = value;
      }
    });
    return cleaned;
  }

  function trackEvent(eventName, params) {
    if (!eventName || typeof window.gtag !== "function") return false;

    try {
      window.gtag("event", eventName, cleanParams(Object.assign(baseParams(), params || {})));
      return true;
    } catch (error) {
      return false;
    }
  }

  function safeUrl(href) {
    if (!href) return "";
    try {
      var url = new URL(href, window.location.href);
      if (url.protocol === "file:") return href;
      return url.href;
    } catch (error) {
      return href;
    }
  }

  function hostnameMatches(href, hosts) {
    var url = safeUrl(href).toLowerCase();
    return hosts.some(function (host) {
      return url.indexOf(host) !== -1;
    });
  }

  function isDownloadLink(link, href) {
    if (link.hasAttribute("download")) return true;
    return /\.(pdf|docx?|xlsx?|csv|zip)(\?|#|$)/i.test(href || "");
  }

  function inferLocation(element) {
    if (!element) return "";
    if (element.closest("nav")) return "nav";
    if (element.closest(".mobile-drawer")) return "mobile_nav";
    if (element.closest("footer")) return "footer";
    if (element.closest(".hero")) return "hero";
    if (element.closest(".stats-audit-strip")) return "presence_score";
    if (element.closest(".cta-section")) return "final_cta";
    if (element.closest("#services")) return "services";
    if (element.closest("#who")) return "who_i_help";
    if (element.closest("aside")) return "sidebar";
    return "";
  }

  function serviceInterestFromLink(link) {
    if (!link) return "";
    if (link.dataset.serviceInterest) return link.dataset.serviceInterest;
    var href = (link.getAttribute("href") || "").toLowerCase();
    var text = compactText(link.textContent).toLowerCase();
    var lookup = [
      ["workflow-audit", "workflow_audit"],
      ["quick-win", "quick_win"],
      ["systems-buildout", "systems_buildout"],
      ["lead-engine", "lead_engine"],
      ["ai-employee", "ai_employee"],
      ["site-build", "site_build"],
      ["audit", "free_presence_audit"],
      ["realestate", "real_estate"],
      ["service-businesses", "service_businesses"],
      ["healthcare", "healthcare"],
      ["professional-services", "professional_services"],
      ["ecommerce", "ecommerce"],
      ["coaches", "coaches"]
    ];
    for (var i = 0; i < lookup.length; i += 1) {
      if (href.indexOf(lookup[i][0]) !== -1 || text.indexOf(lookup[i][0].replace("-", " ")) !== -1) {
        return lookup[i][1];
      }
    }
    return "";
  }

  function formName(form) {
    if (!form) return "unknown";
    if (form.dataset.formName) return form.dataset.formName;
    if (form.id === "ctaNewsletterForm") return "five_minute_fix_newsletter";
    if (form.id === "auditForm") return "free_presence_audit";
    if (form.id === "anotherForm") return "free_presence_audit_rerun";
    if (form.classList.contains("stats-audit-form")) return "homepage_presence_audit_start";
    return form.id || form.getAttribute("name") || "unknown";
  }

  function eventParamsForLink(link) {
    return {
      link_url: safeUrl(link.getAttribute("href") || ""),
      link_text: compactText(link.textContent || link.getAttribute("aria-label") || ""),
      cta_location: link.dataset.ctaLocation || inferLocation(link),
      service_interest: serviceInterestFromLink(link)
    };
  }

  document.addEventListener("click", function (event) {
    var link = event.target.closest && event.target.closest("a[href]");
    var button = event.target.closest && event.target.closest("button[data-track-event]");

    if (button) {
      trackEvent(button.dataset.trackEvent, {
        link_text: compactText(button.textContent || button.getAttribute("aria-label") || ""),
        cta_location: button.dataset.ctaLocation || inferLocation(button),
        service_interest: button.dataset.serviceInterest || ""
      });
      return;
    }

    if (!link) return;

    var href = link.getAttribute("href") || "";
    var params = eventParamsForLink(link);

    if (href.indexOf("mailto:") === 0) {
      trackEvent("email_click", params);
      return;
    }

    if (href.indexOf("tel:") === 0) {
      trackEvent("phone_click", params);
      return;
    }

    if (hostnameMatches(href, BOOKING_HOSTS)) {
      trackEvent("booking_click", params);
      return;
    }

    if (isDownloadLink(link, href)) {
      trackEvent("lead_magnet_download", params);
      return;
    }

    if (hostnameMatches(href, SOCIAL_HOSTS)) {
      trackEvent("social_click", params);
      return;
    }

    if (link.classList.contains("btn") || link.classList.contains("service-card") || link.classList.contains("who-card") || link.classList.contains("shift-read-card") || link.closest(".cta-card")) {
      trackEvent("cta_click", params);
    }
  }, true);

  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (!form || !form.tagName || form.tagName.toLowerCase() !== "form") return;
    if (form.id === "ctaNewsletterForm") return;

    trackEvent("contact_submit_attempt", {
      form_name: formName(form),
      cta_location: inferLocation(form)
    });
  }, true);

  window.CKTracking = {
    trackEvent: trackEvent,
    formName: formName
  };
})();
