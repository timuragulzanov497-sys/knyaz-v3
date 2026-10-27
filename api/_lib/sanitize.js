// Серверная санитизация HTML юртекстов (политика, согласие) по allowlist.
// Админ вводит тексты в панели — без санитизации любой угон сессии админа
// превращается в постоянный XSS для всех посетителей (сырой HTML шёл
// в /api/public/config и рендерился через innerHTML).
//
// Разрешено: p, h3, ul, ol, li, a, b, strong, em, i, br.
// Атрибуты: href у <a> — только http/https/tel/mailto, #фрагмент или
//   относительный путь /...; class у <p> — только безопасные символы
//   (нужно для <p class="legal-note"> из исходных текстов).
// Всё остальное выбрасывается: обработчики событий, style, javascript:-
// ссылки — вместе с тегами. Опасные элементы (script, style, iframe, svg,
// object, embed, form, img, input и подобные) выбрасываются ВМЕСТЕ
// с содержимым. У остальных неразрешённых тегов выбрасывается только тег,
// текст внутри сохраняется.
//
// Тот же allowlist повторён в публичной странице (index.html, renderLegalHtml)
// как второй рубеж: даже уже сохранённый до санитизации HTML не выполнится.
const ALLOWED_TAGS = new Set(["p", "h3", "ul", "ol", "li", "a", "b", "strong", "em", "i", "br"]);
const VOID_TAGS = new Set(["br", "img", "hr", "input", "meta", "link", "source"]);
const DROP_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "form", "svg", "math",
  "video", "audio", "input", "textarea", "select", "link", "meta", "base",
  "title", "noscript", "template", "canvas", "img", "picture", "source",
  "track", "frame", "frameset", "applet",
]);
const SAFE_HREF = /^(https?:\/\/|tel:|mailto:|\/|#)/i;
const SAFE_CLASS = /^[A-Za-z0-9_-]+(?: [A-Za-z0-9_-]+)*$/;
const TAG_RE = /^<\/?([A-Za-z][A-Za-z0-9-]*)((?:\s+[A-Za-z_:][A-Za-z0-9_:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/;

function escapeText(t) {
  // В тексте экранируем только < и >: сырой & безвреден (неизвестные
  // сущности браузер показывает как текст), а экранирование & ломало бы
  // законные сущности (&laquo; и т.п.).
  return t.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(v) {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function getAttr(rawAttrs, name) {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` + "`" + `]+))`, "i");
  const m = re.exec(rawAttrs || "");
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? "";
}

export function sanitizeLegalHtml(input) {
  if (typeof input !== "string") return "";
  const s = input;
  let out = "";
  const open = []; // стек открытых разрешённых тегов
  let i = 0;
  const n = s.length;
  while (i < n) {
    const lt = s.indexOf("<", i);
    if (lt < 0) {
      out += escapeText(s.slice(i));
      break;
    }
    if (lt > i) out += escapeText(s.slice(i, lt));
    // HTML-комментарий — выбросить целиком.
    if (s.startsWith("<!--", lt)) {
      const end = s.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    const m = TAG_RE.exec(s.slice(lt));
    if (!m) {
      // "<" без валидного тега — показать как текст.
      out += "&lt;";
      i = lt + 1;
      continue;
    }
    const [full, rawName, rawAttrs, selfClose] = m;
    const name = rawName.toLowerCase();
    const isClose = s[lt + 1] === "/";
    i = lt + full.length;
    if (DROP_CONTENT.has(name)) {
      if (!isClose && !VOID_TAGS.has(name)) {
        // Пропустить содержимое до парного закрывающего тега
        // (вложенные одноимённые теги учитываются).
        let depth = 1;
        while (i < n && depth > 0) {
          const nx = s.indexOf("<", i);
          if (nx < 0) {
            i = n;
            break;
          }
          const cm = /^<\/?([A-Za-z][A-Za-z0-9-]*)[^>]*>/.exec(s.slice(nx));
          if (!cm) {
            i = nx + 1;
            continue;
          }
          if (cm[1].toLowerCase() === name) {
            if (s[nx + 1] === "/") depth--;
            else if (!/\/\s*>$/.test(cm[0])) depth++;
          }
          i = nx + cm[0].length;
        }
      }
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) continue; // тег выбросить, текст сохранить
    if (isClose) {
      const idx = open.lastIndexOf(name);
      if (idx >= 0) {
        while (open.length > idx) out += `</${open.pop()}>`;
      }
      continue;
    }
    let attrs = "";
    if (name === "a") {
      const href = getAttr(rawAttrs, "href");
      if (href != null) {
        const h = href.trim();
        if (SAFE_HREF.test(h) && !/[\x00-\x1f\x7f]/.test(h)) attrs += ` href="${escapeAttr(h)}"`;
      }
    } else if (name === "p") {
      const cls = getAttr(rawAttrs, "class");
      if (cls != null && SAFE_CLASS.test(cls.trim())) attrs += ` class="${escapeAttr(cls.trim())}"`;
    }
    out += `<${name}${attrs}>`;
    if (!VOID_TAGS.has(name) && !selfClose) open.push(name);
  }
  while (open.length) out += `</${open.pop()}>`;
  return out;
}
