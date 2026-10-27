/* Админ-панель «Князь» — ванильный JS, без фреймворков.
   Разделы — отдельные URL (/admin/bookings, /admin/services, ...),
   навигация — History API. Все данные — из /api/admin/*. */
(function () {
  "use strict";

  /* ---------------- helpers ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function fmtPrice(n) {
    if (n == null) return "—";
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₽";
  }
  function fmtTime(min) { return pad(Math.floor(min / 60)) + ":" + pad(min % 60); }
  function fmtHM(min) { return fmtTime(min); }
  var DOW = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
  var DOW_FULL = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
  var MON = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  function parseKey(k) {
    var p = String(k || "").split("-");
    if (p.length !== 3) return null;
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  function dateKey(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function fmtDateFull(d) {
    if (!d) return "";
    return DOW[d.getDay()] + ", " + d.getDate() + " " + MON[d.getMonth()];
  }
  function todayKey() { return dateKey(new Date()); }
  function initialsOf(name) {
    var parts = String(name || "").trim().split(/\s+/);
    return ((parts[0] || "")[0] || "") + ((parts[1] || "")[0] || "") || "К";
  }
  function avatarHtml(m, big) {
    var inner = m.avatarUrl
      ? '<img src="' + esc(m.avatarUrl) + '" alt="" />'
      : esc(initialsOf(m.name));
    return '<span class="avatar' + (big ? " big" : "") + '">' + inner + "</span>";
  }

  function toast(msg, isErr) {
    var root = $("toastRoot");
    var el = document.createElement("div");
    el.className = "toast" + (isErr ? " err" : "");
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(function () { el.remove(); }, 4000);
  }

  async function api(path, opts) {
    opts = opts || {};
    var res = await fetch(path, {
      method: opts.method || "GET",
      headers: opts.body ? { "Content-Type": "application/json" } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    var data = null;
    try { data = await res.json(); } catch (e) { /* пустой ответ */ }
    if (!res.ok) {
      var err = new Error((data && data.error) || "Ошибка сервера (" + res.status + ")");
      err.status = res.status;
      err.code = data && data.code;
      throw err;
    }
    return data;
  }

  /* ---------------- модалки ---------------- */
  /* Базовая модалка заменяет содержимое; слои (openLayer) открываются
     поверх неё, не уничтожая форму под ними (выбор аватара, подтверждение). */
  function bindModalOverlay(overlay) {
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeTopLayer();
    });
    var x = overlay.querySelector("[data-close]");
    if (x) x.addEventListener("click", closeTopLayer);
  }
  function openModal(html) {
    lastFocus = document.activeElement;
    var root = $("modalRoot");
    root.innerHTML =
      '<div class="modal-overlay" id="modalOverlay"><div class="modal-panel" role="dialog" aria-modal="true">' +
      html +
      "</div></div>";
    bindModalOverlay($("modalOverlay"));
    var first = root.querySelector("input, select, textarea, button:not([data-close])");
    if (first) first.focus();
  }
  function openLayer(html) {
    lastFocus = document.activeElement;
    var root = $("modalRoot");
    var div = document.createElement("div");
    div.className = "modal-overlay";
    div.style.zIndex = "110";
    div.innerHTML = '<div class="modal-panel" role="dialog" aria-modal="true">' + html + "</div>";
    root.appendChild(div);
    bindModalOverlay(div);
    var first = div.querySelector("input, select, textarea, button:not([data-close])");
    if (first) first.focus();
    return div;
  }
  var lastFocus = null;
  function restoreFocus() {
    if (lastFocus && document.contains(lastFocus) && typeof lastFocus.focus === "function") {
      lastFocus.focus();
    }
    lastFocus = null;
  }
  function closeTopLayer() {
    var root = $("modalRoot");
    var layers = root.querySelectorAll(".modal-overlay");
    if (layers.length > 1) {
      layers[layers.length - 1].remove();
    } else {
      root.innerHTML = "";
      restoreFocus();
    }
  }
  function closeModal() { $("modalRoot").innerHTML = ""; restoreFocus(); }
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && $("modalRoot").innerHTML) closeTopLayer();
  });

  function confirmDialog(opts) {
    return new Promise(function (resolve) {
      var layer = openLayer(
        '<div class="modal-head"><h2>' + esc(opts.title) + '</h2>' +
        '<button type="button" class="modal-x" data-close aria-label="Закрыть">&times;</button></div>' +
        '<div class="modal-body"><p style="margin:0;line-height:1.6">' + esc(opts.text) + "</p></div>" +
        '<div class="modal-foot"><button type="button" class="btn ghost" id="cfCancel">Отмена</button>' +
        '<button type="button" class="btn ' + (opts.danger ? "danger" : "brass") + '" id="cfOk">' + esc(opts.okText || "Подтвердить") + "</button></div>"
      );
      layer.querySelector("#cfCancel").addEventListener("click", function () { closeTopLayer(); resolve(false); });
      layer.querySelector("#cfOk").addEventListener("click", function () { closeTopLayer(); resolve(true); });
    });
  }

  function skeleton(n) {
    var h = "";
    for (var i = 0; i < (n || 4); i++) h += "<i></i>";
    return '<div class="skel" aria-hidden="true">' + h + "</div>";
  }
  function errorPanel(msg, retry) {
    return '<div class="err-box" role="alert"><p style="margin:0 0 10px">' + esc(msg) + '</p>' +
      '<button type="button" class="btn ghost small" data-retry>Повторить</button></div>';
  }
  function bindRetry(view, fn) {
    var b = view.querySelector("[data-retry]");
    if (b) b.addEventListener("click", fn);
  }

  /* ---------------- состояние и роутер ---------------- */
  var state = {
    authed: false,
    email: "",
    setupNeeded: false,
    cats: [],
    groups: [],
    services: [],
    masters: [],
    settings: null,
    media: [],
  };
  var ROUTES = ["bookings", "services", "masters", "media", "settings", "login", "setup"];

  function currentRoute() {
    var p = location.pathname.replace(/^\/admin\/?/, "").replace(/\/$/, "");
    return ROUTES.indexOf(p) >= 0 ? p : "bookings";
  }
  function navigate(path) {
    history.pushState(null, "", path);
    render();
  }
  document.addEventListener("click", function (e) {
    var a = e.target.closest("a[data-nav]");
    if (!a) return;
    e.preventDefault();
    navigate(a.getAttribute("href"));
  });
  window.addEventListener("popstate", render);

  function setActiveTab(route) {
    document.querySelectorAll("#adminTabs a").forEach(function (a) {
      a.classList.toggle("active", a.getAttribute("data-route") === route);
    });
  }
  function showChrome(show) {
    $("adminHead").hidden = !show;
    $("adminFoot").hidden = !show;
  }

  async function render() {
    var route = currentRoute();
    var view = $("view");
    if (route === "setup") {
      showChrome(false);
      return renderSetup(view);
    }
    // Проверка сессии.
    try {
      var me = await api("/api/auth/me");
      state.authed = true;
      state.email = me.email;
    } catch (e) {
      state.authed = false;
      if (route !== "login") {
        history.replaceState(null, "", "/admin/login");
        route = "login";
      }
    }
    if (route === "login") {
      showChrome(false);
      if (state.authed) {
        history.replaceState(null, "", "/admin/bookings");
        return renderBookings(view);
      }
      return renderLogin(view);
    }
    if (!state.authed) {
      showChrome(false);
      return renderLogin(view);
    }
    showChrome(true);
    setActiveTab(route);
    if (route === "bookings") return renderBookings(view);
    if (route === "services") return renderServices(view);
    if (route === "masters") return renderMasters(view);
    if (route === "media") return renderMedia(view);
    if (route === "settings") return renderSettings(view);
  }

  /* ---------------- вход ---------------- */
  async function renderLogin(view) {
    view.innerHTML =
      '<div class="auth-wrap"><div class="panel">' +
      '<img class="logo" src="/assets/logo.jpg" alt="Логотип цирюльни «Князь»" />' +
      "<h1>Панель владельца</h1>" +
      '<p class="sub">Только для владельца цирюльни</p>' +
      '<form id="loginForm" novalidate>' +
      '<div class="field"><label for="loginEmail">Email</label>' +
      '<input id="loginEmail" type="email" autocomplete="username" required /></div>' +
      '<div class="field"><label for="loginPass">Пароль</label>' +
      '<div class="pw-wrap"><input id="loginPass" type="password" autocomplete="current-password" required />' +
      '<button type="button" class="pw-toggle" data-pw="loginPass" aria-label="Показать пароль">Показать</button></div></div>' +
      '<p class="ferr" id="loginErr"></p>' +
      '<button type="submit" class="btn brass block" id="loginBtn">Войти</button>' +
      "</form>" +
      '<p class="hint" id="setupHint" style="text-align:center"></p>' +
      "</div></div>";
    bindPwToggles(view);
    try {
      var s = await api("/api/setup");
      state.setupNeeded = !!s.setupNeeded;
      if (s.setupNeeded) {
        $("setupHint").innerHTML = 'Первая настройка ещё не выполнена — <a href="/admin/setup" data-nav>создать владельца</a>.';
      }
    } catch (e) { /* setup-статус не критичен для входа */ }
    $("loginForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      var btn = $("loginBtn");
      var errEl = $("loginErr");
      errEl.textContent = "";
      errEl.classList.remove("show");
      btn.disabled = true;
      btn.textContent = "Входим…";
      try {
        await api("/api/auth/login", {
          method: "POST",
          body: { email: $("loginEmail").value.trim(), password: $("loginPass").value },
        });
        navigate("/admin/bookings");
      } catch (err) {
        errEl.textContent = err.message || "Неверный email или пароль.";
        errEl.classList.add("show");
        btn.disabled = false;
        btn.textContent = "Войти";
      }
    });
  }

  function bindPwToggles(root) {
    root.querySelectorAll("[data-pw]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var inp = $(btn.getAttribute("data-pw"));
        var show = inp.type === "password";
        inp.type = show ? "text" : "password";
        btn.textContent = show ? "Скрыть" : "Показать";
      });
    });
  }

  /* ---------------- первая настройка ---------------- */
  async function renderSetup(view) {
    view.innerHTML =
      '<div class="auth-wrap"><div class="panel">' +
      '<img class="logo" src="/assets/logo.jpg" alt="Логотип цирюльни «Князь»" />' +
      "<h1>Первая настройка</h1>" +
      '<p class="sub">Создание владельца панели</p>' +
      '<div id="setupBody">' + skeleton(4) + "</div>" +
      "</div></div>";
    var body = $("setupBody");
    try {
      var s = await api("/api/setup");
      if (!s.setupNeeded) {
        body.innerHTML =
          "<p>Настройка уже выполнена. Войдите в панель.</p>" +
          '<p style="margin-top:14px"><a class="btn brass block" href="/admin/login" data-nav>Перейти ко входу</a></p>';
        return;
      }
      body.innerHTML =
        '<form id="setupForm" novalidate>' +
        '<div class="field"><label for="setupToken">Одноразовый токен</label>' +
        '<input id="setupToken" type="text" autocomplete="off" placeholder="Вставьте токен полностью" required /></div>' +
        '<div class="field"><label for="setupEmail">Email владельца</label>' +
        '<input id="setupEmail" type="email" autocomplete="username" required /></div>' +
        '<div class="field"><label for="setupPass">Пароль</label>' +
        '<div class="pw-wrap"><input id="setupPass" type="password" autocomplete="new-password" required />' +
        '<button type="button" class="pw-toggle" data-pw="setupPass" aria-label="Показать пароль">Показать</button></div>' +
        '<ul class="req-list"><li>Минимум 12 символов.</li><li>Пароль знает только владелец — он нигде не сохраняется в открытом виде.</li></ul></div>' +
        '<div class="field"><label for="setupPass2">Повторите пароль</label>' +
        '<div class="pw-wrap"><input id="setupPass2" type="password" autocomplete="new-password" required />' +
        '<button type="button" class="pw-toggle" data-pw="setupPass2" aria-label="Показать пароль">Показать</button></div></div>' +
        '<p class="ferr" id="setupErr"></p>' +
        '<button type="submit" class="btn brass block" id="setupBtn">Создать владельца и войти</button>' +
        "</form>";
      bindPwToggles(body);
      $("setupForm").addEventListener("submit", async function (e) {
        e.preventDefault();
        var errEl = $("setupErr");
        errEl.textContent = "";
        errEl.classList.remove("show");
        var btn = $("setupBtn");
        btn.disabled = true;
        btn.textContent = "Создаём…";
        try {
          await api("/api/setup", {
            method: "POST",
            body: {
              token: $("setupToken").value.trim(),
              email: $("setupEmail").value.trim(),
              password: $("setupPass").value,
              passwordRepeat: $("setupPass2").value,
            },
          });
          toast("Владелец создан. Добро пожаловать в панель.");
          navigate("/admin/bookings");
        } catch (err) {
          errEl.textContent = err.message || "Не удалось выполнить настройку";
          errEl.classList.add("show");
          btn.disabled = false;
          btn.textContent = "Создать владельца и войти";
        }
      });
    } catch (e) {
      body.innerHTML = errorPanel("Не удалось проверить статус настройки. Проверьте соединение.");
      bindRetry(body, function () { renderSetup(view); });
    }
  }

  /* ---------------- записи ---------------- */
  var bookingsState = { date: "today", master: "", status: "", q: "", offset: 0, total: 0, items: [], masters: [] };

  async function renderBookings(view) {
    view.innerHTML =
      '<div class="page-head"><div><h1>Записи</h1>' +
      '<p class="sub">Записи клиентов с сайта. Новая запись подтверждается сразу, подтверждать вручную не нужно.</p></div></div>' +
      '<div class="stats" id="bkStats">' + skeleton(3) + "</div>" +
      '<div class="filters">' +
      '<div class="seg" role="group" aria-label="Период">' +
      '<button type="button" data-fdate="today">Сегодня</button>' +
      '<button type="button" data-fdate="tomorrow">Завтра</button>' +
      '<button type="button" data-fdate="all">Все</button></div>' +
      '<div class="field"><label for="bkDate">Дата</label><input id="bkDate" type="date" /></div>' +
      '<div class="field"><label for="bkMaster">Мастер</label><select id="bkMaster"><option value="">Все мастера</option></select></div>' +
      '<div class="field"><label for="bkStatus">Статус</label><select id="bkStatus">' +
      '<option value="">Все</option><option value="CONFIRMED">Подтверждена</option><option value="CANCELLED">Отменена</option></select></div>' +
      '<div class="field" style="flex:1;min-width:160px"><label for="bkQ">Поиск</label>' +
      '<input id="bkQ" type="search" placeholder="Имя или телефон" /></div>' +
      "</div>" +
      '<div id="bkList">' + skeleton(4) + "</div>" +
      '<div style="margin-top:16px"><button type="button" class="btn ghost block" id="bkMore" hidden>Показать ещё</button></div>';

    // Фильтры.
    view.querySelectorAll("[data-fdate]").forEach(function (b) {
      b.addEventListener("click", function () {
        bookingsState.date = b.getAttribute("data-fdate");
        bookingsState.offset = 0;
        $("bkDate").value = "";
        loadBookings(view);
      });
    });
    $("bkDate").addEventListener("change", function () {
      bookingsState.date = this.value || "all";
      bookingsState.offset = 0;
      loadBookings(view);
    });
    $("bkMaster").addEventListener("change", function () {
      bookingsState.master = this.value;
      bookingsState.offset = 0;
      loadBookings(view);
    });
    $("bkStatus").addEventListener("change", function () {
      bookingsState.status = this.value;
      bookingsState.offset = 0;
      loadBookings(view);
    });
    var qTimer = null;
    $("bkQ").addEventListener("input", function () {
      clearTimeout(qTimer);
      var v = this.value;
      qTimer = setTimeout(function () {
        bookingsState.q = v;
        bookingsState.offset = 0;
        loadBookings(view);
      }, 400);
    });
    $("bkMore").addEventListener("click", function () {
      bookingsState.offset = bookingsState.items.length;
      loadBookings(view, true);
    });
    loadStats(view);
    loadBookings(view);
  }

  async function loadStats(view) {
    try {
      var s = await api("/api/admin/stats");
      var el = $("bkStats");
      if (!el) return;
      el.innerHTML =
        '<div class="stat"><div class="n">' + s.today + '</div><div class="c">Сегодня</div></div>' +
        '<div class="stat"><div class="n">' + s.tomorrow + '</div><div class="c">Завтра</div></div>' +
        '<div class="stat"><div class="n">' + s.last14 + '</div><div class="c">Всего за 14 дней</div></div>';
    } catch (e) { /* сводка не блокирует список */ }
  }

  function bookingStatusBadge(b) {
    return b.status === "CANCELLED"
      ? '<span class="badge cancelled">Отменена</span>'
      : '<span class="badge ok">Подтверждена</span>';
  }
  function bookingCardHtml(b, mastersById) {
    var d = parseKey(b.dateKey);
    var m = mastersById[b.masterId];
    var masterName = b.masterName + (m ? "" : " (мастер удалён)");
    var services = (b.services || []).map(function (s) { return esc(s.name); }).join(", ");
    return (
      '<article class="card" data-num="' + b.num + '">' +
      '<div class="row1"><span class="num">Запись K-' + b.num + "</span>" + bookingStatusBadge(b) + "</div>" +
      '<div class="when">' + fmtDateFull(d) + ", " + fmtTime(b.start) + "–" + fmtTime(b.start + b.dur) + "</div>" +
      '<div class="meta">Клиент: <b>' + esc(b.clientName) + '</b> · <a href="tel:' + esc(b.clientPhone) + '">' + esc(b.clientPhone) + "</a><br>" +
      "Мастер: <b>" + esc(masterName) + "</b><br>" +
      "Услуги: " + services + "</div>" +
      '<div class="sum">' + (b.from ? "от " : "") + fmtPrice(b.price) + "</div>" +
      '<div class="details" hidden>' +
      (b.comment ? "<div>Комментарий: <b>" + esc(b.comment) + "</b></div>" : "") +
      "<div>Создана: <b>" + esc(new Date(b.createdAt).toLocaleString("ru-RU")) + "</b></div>" +
      "<div>Согласие на обработку данных получено, " + esc(new Date(b.consentAt).toLocaleString("ru-RU")) +
      " (версия " + (b.consentVersion || 1) + ")</div>" +
      (b.services || []).map(function (s) {
        return '<div class="drow"><span>' + esc(s.name) + " · " + (s.duration || 0) + ' мин</span><b>' + fmtPrice(s.price) + "</b></div>";
      }).join("") +
      (b.status === "CANCELLED" && b.cancelReason ? "<div>Причина отмены: <b>" + esc(b.cancelReason) + "</b></div>" : "") +
      "</div>" +
      '<div class="actions">' +
      '<button type="button" class="btn ghost" data-toggle-details>Подробнее</button>' +
      (b.status === "CONFIRMED"
        ? '<button type="button" class="btn ghost" data-reschedule>Перенести</button>' +
          '<button type="button" class="btn danger" data-cancel>Отменить</button>'
        : "") +
      "</div></article>"
    );
  }

  async function loadBookings(view, append) {
    var list = $("bkList");
    if (!list) return;
    if (!append) list.innerHTML = skeleton(4);
    view.querySelectorAll("[data-fdate]").forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-fdate") === bookingsState.date);
    });
    try {
      var params = new URLSearchParams({
        date: bookingsState.date,
        limit: "20",
        offset: String(bookingsState.offset),
      });
      if (bookingsState.master) params.set("master", bookingsState.master);
      if (bookingsState.status) params.set("status", bookingsState.status);
      if (bookingsState.q) params.set("q", bookingsState.q);
      var data = await api("/api/admin/bookings?" + params.toString());
      bookingsState.total = data.total;
      bookingsState.masters = data.masters || [];
      var mastersById = {};
      (data.masters || []).forEach(function (m) { mastersById[m.id] = m; });
      if (!append) bookingsState.items = [];
      bookingsState.items = bookingsState.items.concat(data.bookings);
      var sel = $("bkMaster");
      var curMaster = bookingsState.master;
      sel.innerHTML = '<option value="">Все мастера</option>' +
        (data.masters || []).map(function (m) {
          return '<option value="' + esc(m.id) + '"' + (m.id === curMaster ? " selected" : "") + ">" + esc(m.name) + "</option>";
        }).join("");
      if (!bookingsState.items.length) {
        list.innerHTML =
          '<div class="panel empty"><p>' +
          (bookingsState.date === "today" ? "На сегодня записей нет." : "Записей пока нет.") +
          '</p><a class="btn ghost" href="/" target="_blank" rel="noopener">Открыть сайт</a></div>';
      } else {
        list.innerHTML =
          '<div class="list">' + bookingsState.items.map(function (b) { return bookingCardHtml(b, mastersById); }).join("") + "</div>";
      }
      $("bkMore").hidden = bookingsState.items.length >= bookingsState.total;
      bindBookingCards(list, view);
    } catch (e) {
      list.innerHTML = errorPanel("Не удалось загрузить записи: " + e.message);
      bindRetry(list, function () { loadBookings(view); });
    }
  }

  function bindBookingCards(list, view) {
    list.querySelectorAll(".card").forEach(function (card) {
      var num = parseInt(card.getAttribute("data-num"), 10);
      card.querySelector("[data-toggle-details]").addEventListener("click", function () {
        var det = card.querySelector(".details");
        det.hidden = !det.hidden;
        this.textContent = det.hidden ? "Подробнее" : "Скрыть";
      });
      var cancelBtn = card.querySelector("[data-cancel]");
      if (cancelBtn) {
        cancelBtn.addEventListener("click", async function () {
          var ok = await confirmDialog({
            title: "Отменить запись",
            text: "Отменить запись K-" + num + "? Клиенту освободится время, запись останется в списке со статусом «Отменена».",
            okText: "Отменить запись",
            danger: true,
          });
          if (!ok) return;
          openModal(
            '<div class="modal-head"><h2>Причина отмены</h2><button type="button" class="modal-x" data-close aria-label="Закрыть">&times;</button></div>' +
            '<div class="modal-body"><div class="field"><label for="cancelReason">Причина отмены (обязательно)</label>' +
            '<input id="cancelReason" type="text" maxlength="200" placeholder="Например: клиент попросил перенести" /></div>' +
            '<p class="ferr" id="cancelErr"></p></div>' +
            '<div class="modal-foot"><button type="button" class="btn ghost" data-close>Назад</button>' +
            '<button type="button" class="btn danger" id="doCancel">Отменить запись</button></div>'
          );
          $("doCancel").addEventListener("click", async function () {
            var reason = $("cancelReason").value.trim();
            var errEl = $("cancelErr");
            if (!reason) {
              errEl.textContent = "Укажите причину отмены — она будет видна в карточке записи";
              errEl.classList.add("show");
              $("cancelReason").focus();
              return;
            }
            try {
              await api("/api/admin/bookings/" + num + "?action=cancel", {
                method: "POST",
                body: { reason: reason },
              });
              closeModal();
              toast("Запись K-" + num + " отменена");
              bookingsState.offset = 0;
              loadBookings(view);
              loadStats(view);
            } catch (err) {
              toast(err.message, true);
            }
          });
        });
      }
      var resBtn = card.querySelector("[data-reschedule]");
      if (resBtn) {
        resBtn.addEventListener("click", function () { openRescheduleModal(num, view); });
      }
    });
  }

  async function openRescheduleModal(num, view) {
    var booking = bookingsState.items.find(function (b) { return b.num === num; });
    if (!booking) return;
    var today = todayKey();
    var max = dateKey(new Date(Date.now() + 13 * 86400000));
    openModal(
      '<div class="modal-head"><h2>Перенести запись K-' + num + '</h2>' +
      '<button type="button" class="modal-x" data-close aria-label="Закрыть">&times;</button></div>' +
      '<div class="modal-body">' +
      '<div class="field"><label for="rsDate">Дата</label>' +
      '<input id="rsDate" type="date" min="' + today + '" max="' + max + '" value="' + esc(booking.dateKey) + '" /></div>' +
      '<div class="field"><label>Время</label><div class="slot-grid" id="rsSlots">' + skeleton(6) + "</div></div>" +
      '<p class="ferr" id="rsErr"></p></div>' +
      '<div class="modal-foot"><button type="button" class="btn ghost" data-close>Отмена</button>' +
      '<button type="button" class="btn brass" id="doReschedule" disabled>Перенести</button></div>'
    );
    var selectedTime = null;
    async function loadSlots() {
      var date = $("rsDate").value;
      var box = $("rsSlots");
      if (!box) return;
      box.innerHTML = skeleton(6);
      try {
        var data = await api(
          "/api/public/slots?from=" + date + "&to=" + date +
          "&master=" + encodeURIComponent(booking.masterId) + "&duration=" + booking.dur +
          "&excludeNum=" + num
        );
        var free = data.days[date] || [];
        var html = "";
        for (var t = 600; t < 1260; t += 30) {
          var isFree = free.indexOf(t) >= 0;
          html += '<button type="button" class="slot' + (selectedTime === t ? " sel" : "") + '" data-time="' + t + '"' +
            (isFree ? "" : " disabled") + ">" + fmtTime(t) + "</button>";
        }
        box.innerHTML = html;
        box.querySelectorAll("[data-time]").forEach(function (b) {
          b.addEventListener("click", function () {
            selectedTime = parseInt(b.getAttribute("data-time"), 10);
            box.querySelectorAll(".slot").forEach(function (x) { x.classList.remove("sel"); });
            b.classList.add("sel");
            $("doReschedule").disabled = false;
          });
        });
      } catch (e) {
        box.innerHTML = '<p class="hint">Не удалось загрузить время. Попробуйте ещё раз.</p>';
      }
    }
    $("rsDate").addEventListener("change", function () { selectedTime = null; $("doReschedule").disabled = true; loadSlots(); });
    loadSlots();
    $("doReschedule").addEventListener("click", async function () {
      if (selectedTime == null) return;
      var date = $("rsDate").value;
      var errEl = $("rsErr");
      errEl.textContent = "";
      errEl.classList.remove("show");
      try {
        await api("/api/admin/bookings/" + num + "?action=reschedule", {
          method: "POST",
          body: { dateKey: date, start: selectedTime },
        });
        closeModal();
        toast("Запись K-" + num + " перенесена");
        bookingsState.offset = 0;
        loadBookings(view);
        loadStats(view);
      } catch (err) {
        if (err.code === "SLOT_TAKEN") {
          errEl.textContent = "Это время уже занято. Выберите другое.";
          errEl.classList.add("show");
          loadSlots();
        } else {
          errEl.textContent = err.message;
          errEl.classList.add("show");
        }
      }
    });
  }

  /* ---------------- услуги и прайс ---------------- */
  var svcOpenGroups = {};

  async function renderServices(view) {
    view.innerHTML =
      '<div class="page-head"><div><h1>Услуги и прайс</h1>' +
      '<p class="sub">Цены меняются на сайте сразу после сохранения.</p></div>' +
      '<button type="button" class="btn brass" id="addSvcBtn">Добавить услугу</button></div>' +
      '<div id="svcList">' + skeleton(4) + "</div>";
    $("addSvcBtn").addEventListener("click", function () { openServiceModal(null, view); });
    try {
      var data = await api("/api/admin/services");
      state.groups = data.groups || [];
      state.services = data.services || [];
      state.cats = data.categories || [];
      renderServiceList(view);
    } catch (e) {
      $("svcList").innerHTML = errorPanel("Не удалось загрузить услуги: " + e.message);
      bindRetry($("svcList"), function () { renderServices(view); });
    }
  }

  function renderServiceList(view) {
    var box = $("svcList");
    var html = "";
    state.groups.forEach(function (g) {
      var items = state.services.filter(function (s) { return s.groupId === g.id; });
      var open = svcOpenGroups[g.id] !== false;
      html +=
        '<div class="group' + (open ? " open" : "") + '" data-group="' + esc(g.id) + '">' +
        '<button type="button" class="group-head" data-ghead="' + esc(g.id) + '" aria-expanded="' + open + '">' +
        '<span class="gname">' + esc(g.name) + '</span>' +
        '<span class="gcount">' + items.length + " " + (items.length === 1 ? "услуга" : "услуг") + "</span>" +
        '<svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>' +
        "</button><div class=\"group-body\">";
      if (!items.length) html += '<p class="hint" style="padding:4px 16px 14px">В этой группе пока нет услуг.</p>';
      items.forEach(function (s) {
        html +=
          '<div class="svc-row">' +
          '<div class="nm"><div class="n">' + esc(s.name) + "</div>" +
          '<div class="d">Длительность ' + (s.durationMin || 30) + " мин" + (s.active ? "" : " · скрыта с сайта") + "</div></div>" +
          state.cats.map(function (c) {
            return '<span class="pr"><span class="cap">' + esc(c.name) + "</span>" + fmtPrice(s.prices ? s.prices[c.id] : null) + "</span>";
          }).join("") +
          '<label class="switch" title="Показана на сайте"><input type="checkbox" data-visible="' + esc(s.id) + '"' + (s.active ? " checked" : "") + " /><span class=\"track\"></span></label>" +
          '<button type="button" class="icon-btn" data-edit-svc="' + esc(s.id) + '" aria-label="Изменить услугу ' + esc(s.name) + '">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg></button>' +
          "</div>";
      });
      html += "</div></div>";
    });
    box.innerHTML = html;
    box.querySelectorAll("[data-ghead]").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = b.getAttribute("data-ghead");
        svcOpenGroups[id] = svcOpenGroups[id] === false ? true : false;
        renderServiceList(view);
      });
    });
    box.querySelectorAll("[data-edit-svc]").forEach(function (b) {
      b.addEventListener("click", function () {
        var svc = state.services.find(function (s) { return s.id === b.getAttribute("data-edit-svc"); });
        openServiceModal(svc || null, view);
      });
    });
    box.querySelectorAll("[data-visible]").forEach(function (cb) {
      cb.addEventListener("change", async function () {
        var svc = state.services.find(function (s) { return s.id === cb.getAttribute("data-visible"); });
        if (!svc) return;
        try {
          await api("/api/admin/services", {
            method: "POST",
            body: {
              id: svc.id, name: svc.name, groupId: svc.groupId, durationMin: svc.durationMin,
              includes: svc.includes || [], prices: svc.prices || {}, active: cb.checked,
            },
          });
          toast(cb.checked ? "Услуга показана на сайте" : "Услуга скрыта с сайта");
          renderServices(view);
        } catch (err) {
          toast(err.message, true);
          cb.checked = !cb.checked;
        }
      });
    });
  }

  function openServiceModal(svc, view) {
    var isNew = !svc;
    svc = svc || { name: "", groupId: state.groups[0] ? state.groups[0].id : "hair", durationMin: 30, includes: [], prices: { barber: null, top: null }, active: true };
    var catInputs = state.cats.map(function (c) {
      var v = svc.prices && svc.prices[c.id] != null ? svc.prices[c.id] : "";
      return '<div class="field"><label for="svcPrice_' + esc(c.id) + '">Цена — ' + esc(c.name) + ", ₽</label>" +
        '<input id="svcPrice_' + esc(c.id) + '" type="number" min="0" step="1" inputmode="numeric" value="' + esc(v) + '" placeholder="Пусто — не оказывается" /></div>';
    }).join("");
    openModal(
      '<div class="modal-head"><h2>' + (isNew ? "Новая услуга" : "Изменить услугу") + '</h2>' +
      '<button type="button" class="modal-x" data-close aria-label="Закрыть">&times;</button></div>' +
      '<div class="modal-body"><form id="svcForm" novalidate>' +
      '<div class="field"><label for="svcName">Название</label>' +
      '<input id="svcName" type="text" maxlength="120" value="' + esc(svc.name) + '" required /></div>' +
      '<div class="field"><label for="svcGroup">Группа</label><select id="svcGroup">' +
      state.groups.map(function (g) {
        return '<option value="' + esc(g.id) + '"' + (g.id === svc.groupId ? " selected" : "") + ">" + esc(g.name) + "</option>";
      }).join("") +
      '<option value="__new">Новая группа…</option></select></div>' +
      '<div class="field" id="newGroupField" hidden><label for="svcNewGroup">Название новой группы</label>' +
      '<input id="svcNewGroup" type="text" maxlength="60" placeholder="Например: Уход" /></div>' +
      '<div class="field"><label for="svcDur">Длительность, минут</label>' +
      '<input id="svcDur" type="number" min="5" max="240" step="5" value="' + (svc.durationMin || 30) + '" />' +
      '<p class="hint">Длительность не показывается на сайте, используется для расчёта занятости.</p></div>' +
      catInputs +
      '<p class="hint">Если цена изменится, старые записи сохранят прежнюю цену. Пустая цена — услуга не оказывается в этой категории.</p>' +
      '<label class="switch"><input type="checkbox" id="svcActive" ' + (svc.active !== false ? " checked" : "") + ' /><span class="track"></span>Показана на сайте</label>' +
      '<p class="ferr" id="svcErr"></p>' +
      "</form></div>" +
      '<div class="modal-foot">' +
      (isNew ? "" : '<button type="button" class="btn danger" id="svcDelete" style="margin-right:auto">Удалить услугу</button>') +
      '<button type="button" class="btn ghost" data-close>Отмена</button>' +
      '<button type="button" class="btn brass" id="svcSave">Сохранить</button></div>'
    );
    $("svcGroup").addEventListener("change", function () {
      $("newGroupField").hidden = this.value !== "__new";
    });
    $("svcSave").addEventListener("click", async function () {
      var errEl = $("svcErr");
      errEl.textContent = "";
      errEl.classList.remove("show");
      var groupId = $("svcGroup").value;
      if (groupId === "__new") {
        var gname = $("svcNewGroup").value.trim();
        if (!gname) {
          errEl.textContent = "Укажите название новой группы";
          errEl.classList.add("show");
          return;
        }
        try {
          var g = await api("/api/admin/groups", { method: "POST", body: { name: gname } });
          groupId = g.group.id;
        } catch (err) {
          errEl.textContent = err.message;
          errEl.classList.add("show");
          return;
        }
      }
      var prices = {};
      var bad = false;
      var dur = parseInt($("svcDur").value, 10);
      if (!Number.isInteger(dur) || dur < 5 || dur > 240) {
        errEl.textContent = "Длительность — от 5 до 240 минут";
        errEl.classList.add("show");
        return;
      }
      state.cats.forEach(function (c) {
        var raw = $("svcPrice_" + c.id).value.trim();
        if (raw === "") { prices[c.id] = null; return; }
        var n = parseInt(raw, 10);
        if (!Number.isInteger(n) || n < 0) bad = true;
        prices[c.id] = n;
      });
      if (bad) {
        errEl.textContent = "Цена — целое число рублей от 0 или пустое поле";
        errEl.classList.add("show");
        return;
      }
      try {
        await api("/api/admin/services", {
          method: "POST",
          body: {
            id: isNew ? undefined : svc.id,
            name: $("svcName").value.trim(),
            groupId: groupId,
            durationMin: dur,
            includes: svc.includes || [],
            prices: prices,
            active: $("svcActive").checked,
          },
        });
        closeModal();
        toast(isNew ? "Услуга добавлена" : "Цена сохранена");
        renderServices(view);
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.add("show");
      }
    });
    var delBtn = $("svcDelete");
    if (delBtn) {
      delBtn.addEventListener("click", async function () {
        var ok = await confirmDialog({
          title: "Удалить услугу",
          text: 'Удалить услугу "' + svc.name + '"? Старые записи с ней сохранятся, на сайте она больше не показывается.',
          okText: "Удалить",
          danger: true,
        });
        if (!ok) return;
        try {
          await api("/api/admin/services?id=" + encodeURIComponent(svc.id), { method: "DELETE" });
          closeModal();
          toast("Услуга удалена");
          renderServices(view);
        } catch (err) {
          toast(err.message, true);
        }
      });
    }
  }

  /* ---------------- мастера ---------------- */
  async function renderMasters(view) {
    view.innerHTML =
      '<div class="page-head"><div><h1>Мастера</h1>' +
      '<p class="sub">Имена, виды, аватары и график. Псевдо-выборы «Любой мастер» на сайте — не мастера, здесь их нет.</p></div>' +
      '<button type="button" class="btn brass" id="addMasterBtn">Добавить мастера</button></div>' +
      '<div id="mastersBody">' + skeleton(4) + "</div>";
    $("addMasterBtn").addEventListener("click", function () { openMasterModal(null, view); });
    try {
      var data = await api("/api/admin/masters");
      state.masters = data.masters || [];
      state.cats = data.categories || [];
      state.defaultSchedule = data.defaultSchedule || {};
      renderMasterList(view);
    } catch (e) {
      $("mastersBody").innerHTML = errorPanel("Не удалось загрузить мастеров: " + e.message);
      bindRetry($("mastersBody"), function () { renderMasters(view); });
    }
  }

  function renderMasterList(view) {
    var box = $("mastersBody");
    var html = '<div class="panel"><h2>Виды мастеров</h2>' +
      '<p class="sec-note">Название вида можно поменять — цены и мастера сохранятся. Удалить вид нельзя, третий вид не добавляется.</p>';
    state.cats.forEach(function (c) {
      var count = state.masters.filter(function (m) { return m.categoryId === c.id; }).length;
      html +=
        '<div class="cat-block"><span class="nm">' + esc(c.name) + '</span>' +
        '<span class="muted small">' + count + " " + (count === 1 ? "мастер" : "мастеров") + "</span>" +
        '<button type="button" class="btn ghost small" data-rename-cat="' + esc(c.id) + '">Переименовать</button></div>';
    });
    html += "</div>";
    state.cats.forEach(function (c) {
      var items = state.masters.filter(function (m) { return m.categoryId === c.id; });
      html += '<div class="panel"><h2>' + esc(c.name) + "</h2>";
      if (!items.length) html += '<p class="hint">В этом виде пока нет мастеров.</p>';
      items.forEach(function (m) {
        var avatarUrl = m.avatarMediaId ? "/api/media/" + m.avatarMediaId : null;
        html +=
          '<div class="master-row">' + avatarHtml({ name: m.name, avatarUrl: avatarUrl }) +
          '<div class="who"><div class="n">' + esc(m.name) + "</div>" +
          '<div class="d">' + esc(c.name) + (m.specialization ? " · " + esc(m.specialization) : "") +
          (m.active ? "" : " · не принимает записи") + "</div></div>" +
          '<label class="switch" title="Принимает записи"><input type="checkbox" data-master-active="' + esc(m.id) + '"' +
          (m.active ? " checked" : "") + ' /><span class="track"></span><span class="small muted">Принимает записи</span></label>' +
          '<button type="button" class="icon-btn" data-edit-master="' + esc(m.id) + '" aria-label="Изменить мастера ' + esc(m.name) + '">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg></button>' +
          "</div>";
      });
      html += "</div>";
    });
    box.innerHTML = html;
    box.querySelectorAll("[data-rename-cat]").forEach(function (b) {
      b.addEventListener("click", function () {
        var cat = state.cats.find(function (c) { return c.id === b.getAttribute("data-rename-cat"); });
        openModal(
          '<div class="modal-head"><h2>Переименовать вид</h2><button type="button" class="modal-x" data-close aria-label="Закрыть">&times;</button></div>' +
          '<div class="modal-body"><div class="field"><label for="catName">Название вида</label>' +
          '<input id="catName" type="text" maxlength="60" value="' + esc(cat.name) + '" /></div>' +
          '<p class="ferr" id="catErr"></p></div>' +
          '<div class="modal-foot"><button type="button" class="btn ghost" data-close>Отмена</button>' +
          '<button type="button" class="btn brass" id="catSave">Сохранить</button></div>'
        );
        $("catSave").addEventListener("click", async function () {
          try {
            await api("/api/admin/categories", { method: "POST", body: { id: cat.id, name: $("catName").value.trim() } });
            closeModal();
            toast("Вид переименован");
            renderMasters(view);
          } catch (err) {
            var el = $("catErr");
            el.textContent = err.message;
            el.classList.add("show");
          }
        });
      });
    });
    box.querySelectorAll("[data-edit-master]").forEach(function (b) {
      b.addEventListener("click", function () {
        var m = state.masters.find(function (x) { return x.id === b.getAttribute("data-edit-master"); });
        openMasterModal(m || null, view);
      });
    });
    box.querySelectorAll("[data-master-active]").forEach(function (cb) {
      cb.addEventListener("change", async function () {
        var m = state.masters.find(function (x) { return x.id === cb.getAttribute("data-master-active"); });
        if (!m) return;
        try {
          await api("/api/admin/masters", {
            method: "POST",
            body: {
              id: m.id, name: m.name, categoryId: m.categoryId, specialization: m.specialization,
              avatarMediaId: m.avatarMediaId, active: cb.checked, schedule: m.schedule, overrides: m.overrides,
            },
          });
          toast(cb.checked ? "Мастер принимает записи" : "Мастер скрыт с сайта");
          renderMasters(view);
        } catch (err) {
          toast(err.message, true);
          cb.checked = !cb.checked;
        }
      });
    });
  }

  function schedRowsHtml(schedule, prefix) {
    var html = "";
    for (var wd = 1; wd <= 7; wd++) {
      var day = wd % 7; // 1=пн ... 6=сб, 0=вс
      var d = schedule[String(day)] || { dayOff: false, startMin: 600, endMin: 1260 };
      html +=
        '<div class="sched-row' + (d.dayOff ? " off" : "") + '">' +
        '<label class="switch"><input type="checkbox" data-sched-day="' + prefix + day + '"' + (d.dayOff ? "" : " checked") + ' /><span class="track"></span></label>' +
        '<span class="dow">' + DOW_FULL[day] + "</span>" +
        '<input type="time" data-sched-from="' + prefix + day + '" value="' + fmtTime(d.startMin) + '"' + (d.dayOff ? " disabled" : "") + " />" +
        "<span>—</span>" +
        '<input type="time" data-sched-to="' + prefix + day + '" value="' + fmtTime(d.endMin) + '"' + (d.dayOff ? " disabled" : "") + " />" +
        "</div>";
    }
    return html;
  }
  function readSchedule(prefix, root) {
    var out = {};
    for (var day = 0; day < 7; day++) {
      var on = root.querySelector('[data-sched-day="' + prefix + day + '"]');
      var from = root.querySelector('[data-sched-from="' + prefix + day + '"]');
      var to = root.querySelector('[data-sched-to="' + prefix + day + '"]');
      if (!on || !on.checked) {
        out[day] = { dayOff: true, startMin: 600, endMin: 1260 };
        continue;
      }
      var s = timeToMin(from.value);
      var e = timeToMin(to.value);
      out[day] = { dayOff: false, startMin: s, endMin: e };
    }
    return out;
  }
  function timeToMin(v) {
    var p = String(v || "").split(":");
    return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
  }

  function openMasterModal(master, view) {
    var isNew = !master;
    master = master || {
      name: "", categoryId: state.cats[0] ? state.cats[0].id : "barber",
      specialization: "", avatarMediaId: null, active: true,
      schedule: state.defaultSchedule || {}, overrides: [],
    };
    var avatarUrl = master.avatarMediaId ? "/api/media/" + master.avatarMediaId : null;
    openModal(
      '<div class="modal-head"><h2>' + (isNew ? "Новый мастер" : "Мастер: " + esc(master.name)) + '</h2>' +
      '<button type="button" class="modal-x" data-close aria-label="Закрыть">&times;</button></div>' +
      '<div class="modal-body"><form id="masterForm" novalidate>' +
      '<div style="display:flex;gap:16px;align-items:center;margin-bottom:16px">' +
      '<span id="avatarPreview">' + avatarHtml({ name: master.name || "М", avatarUrl: avatarUrl }, true) + "</span>" +
      '<div style="display:flex;flex-direction:column;gap:8px">' +
      '<button type="button" class="btn ghost small" id="pickAvatarBtn">Выбрать из медиатеки</button>' +
      '<button type="button" class="btn ghost small" id="uploadAvatarBtn">Загрузить фото</button>' +
      '<input type="file" id="avatarFile" accept="image/jpeg,image/png,image/webp" hidden />' +
      "</div></div>" +
      '<input type="hidden" id="masterAvatar" value="' + esc(master.avatarMediaId || "") + '" />' +
      '<div class="field"><label for="masterName">Имя</label>' +
      '<input id="masterName" type="text" maxlength="100" value="' + esc(master.name) + '" required /></div>' +
      '<div class="field"><label>Вид</label><div class="radio-row">' +
      state.cats.map(function (c) {
        return '<label class="radio-opt' + (c.id === master.categoryId ? " sel" : "") + '">' +
          '<input type="radio" name="masterCat" value="' + esc(c.id) + '"' + (c.id === master.categoryId ? " checked" : "") + " />" + esc(c.name) + "</label>";
      }).join("") + "</div></div>" +
      '<div class="field"><label for="masterSpec">Специализация (необязательно)</label>' +
      '<input id="masterSpec" type="text" maxlength="120" value="' + esc(master.specialization || "") + '" placeholder="Например: стрижки, борода" /></div>' +
      '<label class="switch" style="margin-bottom:16px"><input type="checkbox" id="masterActive" ' + (master.active !== false ? " checked" : "") + ' /><span class="track"></span>Принимает записи</label>' +
      '<h3 style="font-size:20px;margin:8px 0 4px">График</h3>' +
      '<p class="hint" style="margin:0 0 8px">Недельный шаблон. Выходной день — без времени.</p>' +
      '<div id="schedBox">' + schedRowsHtml(master.schedule || {}, "m") + "</div>" +
      '<button type="button" class="btn ghost small" id="copySalonBtn" style="margin-top:10px">Как у салона</button>' +
      '<h3 style="font-size:20px;margin:20px 0 4px">Разовые изменения</h3>' +
      '<p class="hint" style="margin:0 0 8px">Перекрывают шаблон на конкретный день.</p>' +
      '<div id="overridesBox"></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">' +
      '<input type="date" id="ovDate" style="flex:1;min-width:140px" />' +
      '<button type="button" class="btn ghost small" id="ovAdd">Добавить выходной</button></div>' +
      '<p class="ferr" id="masterErr"></p>' +
      "</form></div>" +
      '<div class="modal-foot">' +
      (isNew ? "" : '<button type="button" class="btn danger" id="masterDelete" style="margin-right:auto">Удалить мастера</button>') +
      '<button type="button" class="btn ghost" data-close>Отмена</button>' +
      '<button type="button" class="btn brass" id="masterSave">Сохранить</button></div>'
    );
    var overrides = (master.overrides || []).slice();
    function renderOverrides() {
      var box = $("overridesBox");
      if (!overrides.length) {
        box.innerHTML = '<p class="hint">Разовых изменений нет.</p>';
        return;
      }
      box.innerHTML = overrides.map(function (o, i) {
        var d = parseKey(o.date);
        return '<div class="sched-row"><span class="dow">' + fmtDateFull(d) + "</span>" +
          "<span>" + (o.dayOff ? "Выходной" : fmtTime(o.startMin) + "–" + fmtTime(o.endMin)) + "</span>" +
          '<button type="button" class="icon-btn" data-ov-del="' + i + '" aria-label="Удалить изменение" style="margin-left:auto">&times;</button></div>';
      }).join("");
      box.querySelectorAll("[data-ov-del]").forEach(function (b) {
        b.addEventListener("click", function () {
          overrides.splice(parseInt(b.getAttribute("data-ov-del"), 10), 1);
          renderOverrides();
        });
      });
    }
    renderOverrides();
    $("ovAdd").addEventListener("click", function () {
      var date = $("ovDate").value;
      if (!date) return;
      if (overrides.some(function (o) { return o.date === date; })) return;
      overrides.push({ date: date, dayOff: true, reason: "" });
      overrides.sort(function (a, b) { return a.date.localeCompare(b.date); });
      renderOverrides();
    });
    // Переключение дней в шаблоне.
    $("schedBox").querySelectorAll("[data-sched-day]").forEach(function (cb) {
      cb.addEventListener("change", function () {
        var day = cb.getAttribute("data-sched-day").slice(1);
        var row = cb.closest(".sched-row");
        row.classList.toggle("off", !cb.checked);
        row.querySelectorAll('input[type="time"]').forEach(function (t) { t.disabled = !cb.checked; });
      });
    });
    $("copySalonBtn").addEventListener("click", function () {
      var box = $("schedBox");
      box.innerHTML = schedRowsHtml(state.defaultSchedule || {}, "m");
      box.querySelectorAll("[data-sched-day]").forEach(function (cb) {
        cb.addEventListener("change", function () {
          var row = cb.closest(".sched-row");
          row.classList.toggle("off", !cb.checked);
          row.querySelectorAll('input[type="time"]').forEach(function (t) { t.disabled = !cb.checked; });
        });
      });
    });
    // Аватар: выбор из медиатеки / загрузка.
    $("pickAvatarBtn").addEventListener("click", function () {
      openMediaPicker(function (media) {
        $("masterAvatar").value = media.id;
        $("avatarPreview").innerHTML = avatarHtml({ name: $("masterName").value || "М", avatarUrl: "/api/media/" + media.id }, true);
      });
    });
    $("uploadAvatarBtn").addEventListener("click", function () { $("avatarFile").click(); });
    $("avatarFile").addEventListener("change", async function () {
      var file = this.files[0];
      if (!file) return;
      try {
        var media = await uploadMediaFile(file);
        $("masterAvatar").value = media.id;
        $("avatarPreview").innerHTML = avatarHtml({ name: $("masterName").value || "М", avatarUrl: "/api/media/" + media.id }, true);
        toast("Фото загружено");
      } catch (err) {
        toast(err.message, true);
      }
      this.value = "";
    });
    $("masterSave").addEventListener("click", async function () {
      var errEl = $("masterErr");
      errEl.textContent = "";
      errEl.classList.remove("show");
      var sched = readSchedule("m", document);
      var badDay = Object.keys(sched).find(function (wd) {
        var d = sched[wd];
        return !d.dayOff && d.startMin >= d.endMin;
      });
      if (badDay != null) {
        errEl.textContent = "Проверьте время работы: начало должно быть раньше окончания";
        errEl.classList.add("show");
        return;
      }
      var cat = (document.querySelector('input[name="masterCat"]:checked') || {}).value;
      try {
        await api("/api/admin/masters", {
          method: "POST",
          body: {
            id: isNew ? undefined : master.id,
            name: $("masterName").value.trim(),
            categoryId: cat,
            specialization: $("masterSpec").value.trim(),
            avatarMediaId: $("masterAvatar").value || null,
            active: $("masterActive").checked,
            schedule: sched,
            overrides: overrides,
          },
        });
        closeModal();
        toast(isNew ? "Мастер добавлен" : "Мастер сохранён");
        renderMasters(view);
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.add("show");
      }
    });
    var delBtn = $("masterDelete");
    if (delBtn) {
      delBtn.addEventListener("click", async function () {
        // Запрет удаления мастера с будущими подтверждёнными записями:
        // сначала их нужно перенести или отменить (см. дизайн-концепцию §5.5).
        var future = null;
        try {
          var data = await api("/api/admin/bookings?date=all&master=" + encodeURIComponent(master.id) + "&status=CONFIRMED&limit=100");
          var today = todayKey();
          future = (data.bookings || []).filter(function (b) { return b.dateKey >= today; });
        } catch (e) { future = null; }
        if (future && future.length) {
          var nearest = future.slice(0, 5).map(function (b) {
            var d = parseKey(b.dateKey);
            return "K-" + b.num + " — " + fmtDateFull(d) + ", " + fmtTime(b.start) + " (" + b.clientName + ")";
          }).join("\n");
          openModal(
            '<div class="modal-head"><h2>Мастера нельзя удалить</h2>' +
            '<button type="button" class="modal-x" data-close aria-label="Закрыть">&times;</button></div>' +
            '<div class="modal-body"><p style="margin:0 0 10px;line-height:1.6">У мастера "' + esc(master.name) + '" есть будущие записи (' + future.length + '). Сначала перенесите или отмените их на вкладке «Записи», потом удалите мастера.</p>' +
            '<p style="margin:0;line-height:1.6;white-space:pre-line">' + esc(nearest) + "</p></div>" +
            '<div class="modal-foot"><button type="button" class="btn brass" data-close>Понятно</button></div>'
          );
          return;
        }
        var ok = await confirmDialog({
          title: "Удалить мастера",
          text: 'Удалить мастера "' + master.name + '"? Он скроется с сайта, его прошлые записи останутся в списке.',
          okText: "Удалить",
          danger: true,
        });
        if (!ok) return;
        try {
          await api("/api/admin/masters?id=" + encodeURIComponent(master.id), { method: "DELETE" });
          closeModal();
          toast("Мастер удалён");
          renderMasters(view);
        } catch (err) {
          toast(err.message, true);
        }
      });
    }
  }

  /* ---------------- медиатека ---------------- */
  async function uploadMediaFile(file) {
    if (file.size > 3 * 1024 * 1024) throw new Error("Файл больше 3 МБ");
    if (["image/jpeg", "image/png", "image/webp"].indexOf(file.type) < 0) {
      throw new Error("Неподдерживаемый формат. Только JPG, PNG, WebP.");
    }
    var fd = new FormData();
    fd.append("file", file);
    var res = await fetch("/api/admin/media", { method: "POST", body: fd });
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error((data && data.error) || "Не удалось загрузить файл");
    return data.media;
  }

  function openMediaPicker(onPick) {
    var layer = openLayer(
      '<div class="modal-head"><h2>Выбрать фото</h2>' +
      '<button type="button" class="modal-x" data-close aria-label="Закрыть">&times;</button></div>' +
      '<div class="modal-body"><div id="pickerBody">' + skeleton(4) + "</div></div>" +
      '<div class="modal-foot"><button type="button" class="btn ghost" data-close>Отмена</button></div>'
    );
    loadMediaInto(layer.querySelector("#pickerBody"), true, onPick);
  }

  async function loadMediaInto(box, picker, onPick) {
    try {
      var data = await api("/api/admin/media");
      state.media = data.media || [];
      if (!state.media.length) {
        box.innerHTML = '<div class="panel empty"><p>В медиатеке пока нет изображений. Загрузите фото — оно появится здесь.</p></div>';
        return;
      }
      box.innerHTML =
        '<div class="media-grid">' +
        state.media.map(function (m) {
          return '<button type="button" class="media-item" data-media="' + esc(m.id) + '">' +
            '<img src="' + esc(m.url) + '" alt="' + esc(m.name) + '" loading="lazy" />' +
            '<div class="mi-meta">' + esc(m.name) + " · " + Math.round(m.sizeBytes / 1024) + " КБ" +
            (m.isLogo ? ' · <span class="badge tag">Логотип</span>' : "") +
            (m.isHero ? ' · <span class="badge tag">Фото главной</span>' : "") + "</div></button>";
        }).join("") + "</div>";
      box.querySelectorAll("[data-media]").forEach(function (el) {
        el.addEventListener("click", function () {
          var m = state.media.find(function (x) { return x.id === el.getAttribute("data-media"); });
          if (!m) return;
          if (picker) {
            closeTopLayer();
            onPick(m);
          } else {
            openMediaViewer(m);
          }
        });
      });
    } catch (e) {
      box.innerHTML = errorPanel("Не удалось загрузить медиатеку: " + e.message);
      bindRetry(box, function () { loadMediaInto(box, picker, onPick); });
    }
  }

  function openMediaViewer(m) {
    var usedBy = state.masters.filter(function (x) { return x.avatarMediaId === m.id; }).map(function (x) { return x.name; });
    openModal(
      '<div class="modal-head"><h2>' + esc(m.name) + '</h2>' +
      '<button type="button" class="modal-x" data-close aria-label="Закрыть">&times;</button></div>' +
      '<div class="modal-body">' +
      '<img src="' + esc(m.url) + '" alt="' + esc(m.name) + '" style="width:100%;border-radius:3px;display:block" />' +
      '<p class="hint">' + Math.round(m.sizeBytes / 1024) + " КБ · " + esc(m.contentType) + "</p>" +
      (usedBy.length ? '<p class="hint">Это фото — аватар мастера ' + esc(usedBy.join(", ")) + ". После удаления у мастера останутся инициалы.</p>" : "") +
      (m.isLogo ? '<p><span class="badge tag">Логотип сайта</span></p>' : "") +
      (m.isHero ? '<p><span class="badge tag">Фото главной</span></p>' : "") +
      "</div>" +
      '<div class="modal-foot"><button type="button" class="btn danger" id="mediaDelete">Удалить</button>' +
      '<button type="button" class="btn ghost" id="mediaSetLogo">Сделать логотипом</button>' +
      '<button type="button" class="btn ghost" id="mediaSetHero">Фото главной</button></div>'
    );
    $("mediaDelete").addEventListener("click", async function () {
      var ok = await confirmDialog({
        title: "Удалить фото",
        text: usedBy.length
          ? 'Удалить фото "' + m.name + '"? Это фото — аватар мастера ' + usedBy.join(", ") + ". После удаления у мастера останутся инициалы."
          : 'Удалить фото "' + m.name + '"?',
        okText: "Удалить",
        danger: true,
      });
      if (!ok) return;
      try {
        await api("/api/admin/media?id=" + encodeURIComponent(m.id), { method: "DELETE" });
        closeModal();
        toast("Фото удалено");
        renderMedia($("view"));
      } catch (err) {
        toast(err.message, true);
      }
    });
    $("mediaSetLogo").addEventListener("click", async function () {
      try {
        await api("/api/admin/media", { method: "POST", body: { action: "setRole", mediaId: m.id, role: "logo" } });
        closeModal();
        toast("Логотип заменён");
        renderMedia($("view"));
      } catch (err) { toast(err.message, true); }
    });
    $("mediaSetHero").addEventListener("click", async function () {
      try {
        await api("/api/admin/media", { method: "POST", body: { action: "setRole", mediaId: m.id, role: "hero" } });
        closeModal();
        toast("Фото главной заменено");
        renderMedia($("view"));
      } catch (err) { toast(err.message, true); }
    });
  }

  async function renderMedia(view) {
    view.innerHTML =
      '<div class="page-head"><div><h1>Медиатека</h1>' +
      '<p class="sub">Фото для аватаров мастеров, логотипа и главной страницы.</p></div>' +
      '<label class="btn brass" style="cursor:pointer">Загрузить изображения<input type="file" id="mediaUpload" accept="image/jpeg,image/png,image/webp" multiple hidden /></label></div>' +
      '<p class="hint" style="margin:0 0 16px">Только JPG, PNG, WebP. До 3 МБ на файл. Фото сжимается автоматически.</p>' +
      '<div id="mediaBody">' + skeleton(6) + "</div>";
    var input = $("mediaUpload");
    input.addEventListener("change", async function () {
      var files = Array.prototype.slice.call(this.files || []);
      this.value = "";
      for (var i = 0; i < files.length; i++) {
        try {
          await uploadMediaFile(files[i]);
          toast("Фото загружено: " + files[i].name);
        } catch (err) {
          toast(files[i].name + ": " + err.message, true);
        }
      }
      renderMedia(view);
    });
    loadMediaInto($("mediaBody"), false, null);
  }

  /* ---------------- настройки ---------------- */
  async function renderSettings(view) {
    view.innerHTML =
      '<div class="page-head"><div><h1>Настройки</h1>' +
      '<p class="sub">Изменения телефона, часов и адреса видны на публичной странице сразу.</p></div></div>' +
      '<div id="settingsBody">' + skeleton(5) + "</div>";
    try {
      var data = await api("/api/admin/settings");
      state.settings = data.settings;
      renderSettingsSections(view);
    } catch (e) {
      $("settingsBody").innerHTML = errorPanel("Не удалось загрузить настройки: " + e.message);
      bindRetry($("settingsBody"), function () { renderSettings(view); });
    }
  }

  function settingsSection(title, note, inner, saveId) {
    return '<section class="panel"><h2>' + esc(title) + "</h2>" +
      (note ? '<p class="sec-note">' + esc(note) + "</p>" : "") +
      inner +
      '<div class="foot-actions"><button type="button" class="btn brass" id="' + saveId + '">Сохранить</button></div></section>';
  }

  function renderSettingsSections(view) {
    var s = state.settings;
    var box = $("settingsBody");
    box.innerHTML =
      settingsSection("Контакты и адрес", "Часы салона по умолчанию для всех мастеров.",
        '<div class="field"><label for="setPhone">Телефон</label><input id="setPhone" type="tel" inputmode="tel" value="' + esc(s.phoneDisplay || s.phone) + '" /></div>' +
        '<div class="field"><label for="setAddress">Адрес</label><input id="setAddress" type="text" maxlength="200" value="' + esc(s.address) + '" /></div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap"><div class="field" style="flex:1;min-width:140px"><label for="setOpen">Открытие</label><input id="setOpen" type="time" value="' + fmtTime(s.openStartMin) + '" /></div>' +
        '<div class="field" style="flex:1;min-width:140px"><label for="setClose">Закрытие</label><input id="setClose" type="time" value="' + fmtTime(s.openEndMin) + '" /></div></div>' +
        '<p class="ferr" id="errContacts"></p>', "saveContacts") +
      settingsSection("Ссылки", "",
        '<div class="field"><label for="setGis">2ГИС</label><input id="setGis" type="url" value="' + esc(s.links.gis || "") + '" /></div>' +
        '<div class="field"><label for="setGisReviews">2ГИС — отзывы</label><input id="setGisReviews" type="url" value="' + esc(s.links.gisReviews || "") + '" /></div>' +
        '<div class="field"><label for="setMax">Max</label><input id="setMax" type="url" value="' + esc(s.links.max || "") + '" /></div>' +
        '<div class="field"><label for="setVk">VK</label><input id="setVk" type="url" value="' + esc(s.links.vk || "") + '" /></div>' +
        '<div class="field"><label for="setMaps">Маршрут (Google Maps)</label><input id="setMaps" type="url" value="' + esc(s.links.maps || "") + '" /></div>' +
        '<p class="ferr" id="errLinks"></p>', "saveLinks") +
      settingsSection("Оплата и условия", "",
        '<div class="field"><label for="setPay">Оплата</label><input id="setPay" type="text" maxlength="120" value="' + esc(s.paymentText) + '" /></div>' +
        '<label class="switch"><input type="checkbox" id="setWifi" ' + (s.wifi ? " checked" : "") + ' /><span class="track"></span>Wi-Fi для клиентов</label>' +
        '<label class="switch"><input type="checkbox" id="setDog" ' + (s.dogAllowed ? " checked" : "") + ' /><span class="track"></span>Можно с собакой</label>' +
        '<p class="ferr" id="errPayment"></p>', "savePayment") +
      settingsSection("Реквизиты", "Реквизиты подставляются в политику обработки данных. Пока поля пустые, в политике показывается, что реквизиты указывает владелец.",
        '<div class="field"><label for="setIp">ИП / организация</label><input id="setIp" type="text" maxlength="200" value="' + esc(s.requisites.ip || "") + '" placeholder="Укажите при передаче сайта" /></div>' +
        '<div class="field"><label for="setInn">ИНН</label><input id="setInn" type="text" maxlength="20" inputmode="numeric" value="' + esc(s.requisites.inn || "") + '" placeholder="Укажите при передаче сайта" /></div>' +
        '<div class="field"><label for="setOgrn">ОГРН / ОГРНИП</label><input id="setOgrn" type="text" maxlength="20" inputmode="numeric" value="' + esc(s.requisites.ogrn || "") + '" placeholder="Укажите при передаче сайта" /></div>' +
        '<p class="ferr" id="errReq"></p>', "saveReq") +
      settingsSection("График салона", "Недельный шаблон по умолчанию для всех мастеров.",
        '<div id="salonSched">' + schedRowsHtml(s.defaultSchedule || {}, "s") + "</div>" +
        '<p class="ferr" id="errSchedule"></p>', "saveSchedule") +
      settingsSection("Тексты юридических страниц", "При каждом сохранении текста версия согласия увеличивается — она фиксируется в новых записях.",
        '<div class="field"><label for="setPolicy">Политика обработки персональных данных (HTML)</label>' +
        '<textarea id="setPolicy" style="min-height:200px">' + esc(s.legal.policyHtml || "") + '</textarea></div>' +
        '<div class="field"><label for="setConsent">Согласие на обработку персональных данных (HTML)</label>' +
        '<textarea id="setConsent" style="min-height:200px">' + esc(s.legal.consentHtml || "") + '</textarea></div>' +
        '<p class="hint">Текущая версия согласия: ' + (s.legal.consentVersion || 1) + '</p>' +
        '<p><a class="btn ghost small" href="/" target="_blank" rel="noopener">Посмотреть на сайте</a></p>' +
        '<p class="ferr" id="errLegal"></p>', "saveLegal");

    $("salonSched").querySelectorAll("[data-sched-day]").forEach(function (cb) {
      cb.addEventListener("change", function () {
        var row = cb.closest(".sched-row");
        row.classList.toggle("off", !cb.checked);
        row.querySelectorAll('input[type="time"]').forEach(function (t) { t.disabled = !cb.checked; });
      });
    });

    async function saveSection(section, data, errId, okMsg) {
      var errEl = $(errId);
      errEl.textContent = "";
      errEl.classList.remove("show");
      try {
        var res = await api("/api/admin/settings", { method: "POST", body: { section: section, data: data } });
        state.settings = res.settings;
        toast(okMsg);
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.add("show");
      }
    }
    $("saveContacts").addEventListener("click", function () {
      saveSection("contacts", {
        phone: $("setPhone").value,
        phoneDisplay: $("setPhone").value,
        address: $("setAddress").value,
        openStartMin: timeToMin($("setOpen").value),
        openEndMin: timeToMin($("setClose").value),
      }, "errContacts", "Сохранено");
    });
    $("saveLinks").addEventListener("click", function () {
      saveSection("links", {
        gis: $("setGis").value.trim(),
        gisReviews: $("setGisReviews").value.trim(),
        max: $("setMax").value.trim(),
        vk: $("setVk").value.trim(),
        maps: $("setMaps").value.trim(),
      }, "errLinks", "Сохранено");
    });
    $("savePayment").addEventListener("click", function () {
      saveSection("payment", {
        paymentText: $("setPay").value,
        wifi: $("setWifi").checked,
        dogAllowed: $("setDog").checked,
      }, "errPayment", "Сохранено");
    });
    $("saveReq").addEventListener("click", function () {
      saveSection("requisites", {
        ip: $("setIp").value,
        inn: $("setInn").value,
        ogrn: $("setOgrn").value,
      }, "errReq", "Сохранено");
    });
    $("saveSchedule").addEventListener("click", function () {
      var sched = readSchedule("s", document);
      var bad = Object.keys(sched).find(function (wd) {
        var d = sched[wd];
        return !d.dayOff && d.startMin >= d.endMin;
      });
      if (bad != null) {
        var el = $("errSchedule");
        el.textContent = "Проверьте время работы: начало должно быть раньше окончания";
        el.classList.add("show");
        return;
      }
      saveSection("schedule", { defaultSchedule: sched }, "errSchedule", "Сохранено");
    });
    $("saveLegal").addEventListener("click", function () {
      saveSection("legal", {
        policyHtml: $("setPolicy").value,
        consentHtml: $("setConsent").value,
      }, "errLegal", "Сохранено");
    });
  }

  /* ---------------- выход, футер, старт ---------------- */
  $("logoutBtn").addEventListener("click", async function () {
    try { await api("/api/auth/logout", { method: "POST" }); } catch (e) { /* всё равно выходим */ }
    state.authed = false;
    navigate("/admin/login");
  });
  $("footPolicy").addEventListener("click", function () {
    window.open("/#policy", "_blank");
  });

  render();
})();
