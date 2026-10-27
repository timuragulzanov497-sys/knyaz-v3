// Seed-данные V3 — единственный источник правды для начальной загрузки БД.
// Прайс сверен с прайсом владельца (MEMORY.md) и кодом V3 построчно.
// Имена мастеров — заглушки «Барбер 1/2», настоящие даст владелец. Не выдумывать.
// Реквизиты ИП/ИНН — пустые, владелец заполняет в админке.
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const legal = JSON.parse(readFileSync(join(__dirname, "legal.json"), "utf8"));

export const CATEGORIES = [
  { id: "barber", name: "Цирюльник", sort: 1 },
  { id: "top", name: "Топ-цирюльник", sort: 2 },
];

export const GROUPS = [
  { id: "hair", name: "Стрижки", sort: 1 },
  { id: "beard", name: "Борода", sort: 2 },
  { id: "combo", name: "Комплексы", sort: 3 },
  { id: "extra", name: "Дополнительно", sort: 4 },
];

// durationMin — из кода V3 (в прайсе владельца длительностей нет, на сайте не показываются).
export const SERVICES = [
  { id: "haircut", name: "Стрижка мужская", groupId: "hair", durationMin: 60, includes: [], prices: { barber: 700, top: 1000 } },
  { id: "kids", name: "Стрижка детская (3–11 лет)", groupId: "hair", durationMin: 45, includes: [], prices: { barber: 600, top: 900 } },
  { id: "clipper", name: "Стрижка под машинку (одна насадка)", groupId: "hair", durationMin: 30, includes: [], prices: { barber: 400, top: 400 } },
  { id: "wash", name: "Мытьё и укладка волос", groupId: "hair", durationMin: 20, includes: [], prices: { barber: 150, top: 200 } },
  { id: "beard", name: "Коррекция бороды", groupId: "beard", durationMin: 30, includes: [], prices: { barber: 400, top: 600 } },
  { id: "beardshave", name: "Коррекция бороды с подбриванием", groupId: "beard", durationMin: 45, includes: [], prices: { barber: 600, top: 700 } },
  { id: "shave", name: "Бритьё", groupId: "beard", durationMin: 45, includes: [], prices: { barber: 900, top: 900 } },
  { id: "edge", name: "Окантовка с подбриванием", groupId: "beard", durationMin: 20, includes: [], prices: { barber: 250, top: 250 } },
  { id: "pkgFriends", name: "Друг+друг", groupId: "combo", durationMin: 120, includes: ["haircut"], prices: { barber: 1300, top: 1900 } },
  { id: "pkgFather", name: "Отец+сын (3–11 лет)", groupId: "combo", durationMin: 90, includes: ["haircut", "kids"], prices: { barber: 1200, top: 1800 } },
  { id: "pkgHB", name: "Стрижка + коррекция бороды", groupId: "combo", durationMin: 90, includes: ["haircut", "beard"], prices: { barber: 1000, top: 1400 } },
  { id: "pkgHBS", name: "Стрижка + коррекция бороды с подбриванием", groupId: "combo", durationMin: 105, includes: ["haircut", "beardshave"], prices: { barber: 1100, top: 1600 } },
  { id: "camoHair", name: "Камуфляж седины (волосы)", groupId: "extra", durationMin: 40, includes: [], prices: { barber: 500, top: 500 } },
  { id: "camoBeard", name: "Камуфляж седины (борода)", groupId: "extra", durationMin: 30, includes: [], prices: { barber: 450, top: 450 } },
  { id: "waxEars", name: "Удаление волос воском — уши", groupId: "extra", durationMin: 15, includes: [], prices: { barber: 300, top: 300 } },
  { id: "waxNose", name: "Удаление волос воском — нос", groupId: "extra", durationMin: 10, includes: [], prices: { barber: 200, top: 200 } },
  { id: "waxBrows", name: "Удаление волос воском — брови", groupId: "extra", durationMin: 15, includes: [], prices: { barber: 200, top: 200 } },
  { id: "waxNeck", name: "Удаление волос воском — шея", groupId: "extra", durationMin: 20, includes: [], prices: { barber: 500, top: 500 } },
];

const WEEK = {};
for (let wd = 0; wd < 7; wd++) WEEK[wd] = { dayOff: false, startMin: 600, endMin: 1260 };

export const MASTERS = [
  { id: "barber:b1", name: "Барбер 1", categoryId: "barber", specialization: "", avatarMediaId: null, schedule: WEEK, overrides: [] },
  { id: "barber:b2", name: "Барбер 2", categoryId: "barber", specialization: "", avatarMediaId: null, schedule: WEEK, overrides: [] },
  { id: "top:b1", name: "Барбер 1", categoryId: "top", specialization: "", avatarMediaId: null, schedule: WEEK, overrides: [] },
  { id: "top:b2", name: "Барбер 2", categoryId: "top", specialization: "", avatarMediaId: null, schedule: WEEK, overrides: [] },
];

export const SETTINGS = {
  phone: "+79171810484",
  phoneDisplay: "+7 917 181-04-84",
  address: "Астрахань, пл. Свободы, 45, 1 этаж",
  openStartMin: 600, // 10:00
  openEndMin: 1260, // 21:00
  paymentText: "Только наличные",
  wifi: true,
  dogAllowed: true,
  links: {
    gis: "https://2gis.ru/astrakhan/firm/70000001048372338",
    gisReviews: "https://2gis.ru/astrakhan/firm/70000001048372338/tab/reviews",
    max: "https://max.ru/u/f9LHodD0cOKXid8B-Ibp-upcU-R3ufx9JKcIRs72vEhxidx_X_IyJmokNGA",
    vk: "https://vk.com/cirulnya_knyaz",
    maps: "https://www.google.com/maps/search/?api=1&query=%D0%A6%D0%B8%D1%80%D1%8E%D0%BB%D1%8C%D0%BD%D1%8F+%D0%9A%D0%BD%D1%8F%D0%B7%D1%8C%2C+%D0%90%D1%81%D1%82%D1%80%D0%B0%D1%85%D0%B0%D0%BD%D1%8C%2C+%D0%BF%D0%BB%D0%BE%D1%89%D0%B0%D0%B4%D1%8C+%D0%A1%D0%B2%D0%BE%D0%B1%D0%BE%D0%B4%D1%8B+45",
  },
  requisites: { ip: "", inn: "", ogrn: "" },
  legal: {
    policyHtml: legal.policyHtml,
    consentHtml: legal.consentHtml,
    consentVersion: 1,
  },
  logoMediaId: null,
  heroMediaId: null,
  defaultSchedule: WEEK,
};
